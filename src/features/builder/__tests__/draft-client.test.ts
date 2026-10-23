// The builder's draft client (criteria 9, 10, 11): batching, refusals, rebase on conflict, undo and redo.
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, DraftOp } from "@/core/contracts";
import { blankDocument, findNode, newId, stableJson } from "@/features/apps/doc";
import { applyOpsToDoc } from "@/features/apps/ops";
import { DEBOUNCE_MS, DROPPED_MESSAGE, DraftClient, type SendResult } from "../draft-client";

function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
    async advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

/** A fake server holding the shared draft and applying batches the way applyDraftOps does. */
function server(doc: AppDocument) {
  const state = { doc, rev: 1, batches: [] as DraftOp[][] };
  return {
    state,
    send: async (rev: number, ops: DraftOp[]): Promise<SendResult> => {
      if (rev !== state.rev) return { ok: false, kind: "conflict", rev: state.rev };
      const r = applyOpsToDoc(state.doc, ops, { node: (n) => (n.props.label === "bad" ? [{ severity: "error", code: "props.invalid", where: { field: "label" }, message: "That label is not allowed." }] : []) });
      if (!r.ok) return { ok: false, kind: "invalid", problems: r.problems };
      state.doc = r.doc;
      state.rev++;
      state.batches.push(ops);
      return { ok: true, rev: state.rev };
    },
    fetchDraft: async () => ({ rev: state.rev, doc: state.doc }),
    agent(ops: DraftOp[]) {
      const r = applyOpsToDoc(state.doc, ops);
      if (!r.ok) throw new Error("agent op failed");
      state.doc = r.doc;
      state.rev++;
    },
  };
}

const stat = (label: string): ComponentNode => ({ id: newId("c"), type: "stat", props: { label }, slot: { x: 0, y: 0, w: 3, h: 16 } });

function setup() {
  const a = stat("A");
  const b = stat("B");
  const d = blankDocument("T");
  d.pages[0]!.root.children = [a, b];
  const srv = server(d);
  const c = clock();
  const events = { refused: [] as string[], dropped: [] as string[] };
  const client = new DraftClient(d, 1, { send: srv.send, fetchDraft: srv.fetchDraft, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout }, {
    onRefused: (p) => events.refused.push(p.map((x) => x.message).join("; ")),
    onDropped: (m) => events.dropped.push(m),
  });
  return { a, b, d, srv, c, client, events };
}

describe("DraftClient", () => {
  it("two edits 100ms apart go as one batch, after the debounce", async () => {
    const { a, srv, c, client } = setup();
    client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "A1" } } }]);
    await c.advance(100);
    client.edit([{ op: "node.update", nodeId: a.id, patch: { name: "cpu" } }]);
    await c.advance(DEBOUNCE_MS - 1);
    expect(srv.state.batches.length).toBe(0);
    await c.advance(1);
    expect(srv.state.batches.length).toBe(1);
    expect(srv.state.batches[0]!.length).toBe(2);
    expect(client.rev).toBe(2);
  });

  it("a refused edit reverts the canvas, reports the reason, and leaves the rev", async () => {
    const { a, srv, c, client, events } = setup();
    client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "bad" } } }]);
    expect(findNode(client.doc, a.id)!.node.props.label).toBe("bad");
    await c.advance(DEBOUNCE_MS);
    expect(findNode(client.doc, a.id)!.node.props.label).toBe("A");
    expect(events.refused).toEqual(["That label is not allowed."]);
    expect(srv.state.rev).toBe(1);
    expect(client.canUndo).toBe(false);
  });

  it("replays pending edits on a newer draft; an edit on a node the agent removed is dropped with the message", async () => {
    const { a, b, srv, c, client, events } = setup();
    client.edit([{ op: "node.update", nodeId: b.id, patch: { props: { label: "B2" } } }]);
    srv.agent([{ op: "node.remove", nodeId: a.id }]);
    await c.advance(DEBOUNCE_MS);
    expect(findNode(srv.state.doc, b.id)!.node.props.label).toBe("B2");
    expect(events.dropped).toEqual([]);
    // Second race: the person edits a node while an agent removes that same node.
    const t = setup();
    t.client.edit([{ op: "node.update", nodeId: t.a.id, patch: { props: { label: "A2" } } }]);
    t.srv.agent([{ op: "node.remove", nodeId: t.a.id }]);
    await t.c.advance(DEBOUNCE_MS);
    expect(t.events.dropped).toEqual([DROPPED_MESSAGE]);
    expect(findNode(t.client.doc, t.a.id)).toBeNull();
    expect(t.client.rev).toBe(t.srv.state.rev);
    expect(client.rev).toBe(srv.state.rev);
  });

  it("undo returns a moved node to its slot and redo moves it back", async () => {
    const { a, d, srv, c, client } = setup();
    const before = stableJson(d);
    client.edit([{ op: "node.move", nodeId: a.id, parentId: d.pages[0]!.root.id, index: 0, slot: { x: 6, y: 4, w: 3, h: 16 } }]);
    await c.advance(DEBOUNCE_MS);
    client.undo();
    await c.advance(DEBOUNCE_MS);
    expect(stableJson(srv.state.doc)).toBe(before);
    client.redo();
    await c.advance(DEBOUNCE_MS);
    expect(findNode(srv.state.doc, a.id)!.node.slot).toEqual({ x: 6, y: 4, w: 3, h: 16 });
  });
});

describe("DraftClient.whenSaved (gauntlet w2-r1 item 15)", () => {
  it("resolves null once the change is saved, and with the problems when the server refuses it", async () => {
    const { a, srv, client } = setup();
    client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "A2" } } }]);
    expect(await client.whenSaved()).toBeNull();
    expect(srv.state.batches).toHaveLength(1);
    client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "bad" } } }]);
    const refused = await client.whenSaved();
    expect(refused?.map((p) => p.message)).toEqual(["That label is not allowed."]);
    expect(await client.whenSaved()).toBeNull(); // nothing queued: resolves at once
  });
});
