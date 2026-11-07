// Wave 2.10c N2 (architecture A11.1): the builder's one command log. Labels in words, typing coalesced into
// one step until blur or 1 s idle, the 100 step cap, history kept across publish, and an undo whose target
// someone else removed refused with a sentence and skipped.
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, DraftOp } from "@/core/contracts";
import { blankDocument, findNode, findPage, newId } from "@/features/apps/doc";
import { applyOpsToDoc } from "@/features/apps/ops";
import { COALESCE_IDLE_MS, DEBOUNCE_MS, DraftClient, HISTORY_CAP, skippedMessage, type SendResult } from "../draft-client";
import { fieldKey, historyLabel, kindWord } from "../history-label";

function harness(doc: AppDocument) {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const state = { doc, rev: 1 };
  const events = { dropped: [] as string[] };
  const client = new DraftClient(doc, 1, {
    send: async (rev: number, ops: DraftOp[]): Promise<SendResult> => {
      if (rev !== state.rev) return { ok: false, kind: "conflict", rev: state.rev };
      const r = applyOpsToDoc(state.doc, ops);
      if (!r.ok) return { ok: false, kind: "invalid", problems: r.problems };
      state.doc = r.doc;
      state.rev++;
      return { ok: true, rev: state.rev };
    },
    fetchDraft: async () => ({ rev: state.rev, doc: state.doc }),
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
    now: () => now,
  }, { onDropped: (m) => events.dropped.push(m) });
  return {
    client, state, events,
    tick(ms: number) { now += ms; },
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
    agent(ops: DraftOp[]) { const r = applyOpsToDoc(state.doc, ops); if (!r.ok) throw new Error("agent op failed"); state.doc = r.doc; state.rev++; },
  };
}

const stat = (label: string): ComponentNode => ({ id: newId("c"), type: "stat", props: { label }, slot: { x: 0, y: 0, w: 3, h: 16 } });
function doc2() {
  const a = stat("A");
  const d = blankDocument("T");
  d.pages[0]!.root.children = [a];
  return { a, d, root: d.pages[0]!.root.id };
}

describe("history labels (A11.1)", () => {
  it("names each builder edit kind in words", () => {
    const { a, d, root } = doc2();
    expect(kindWord({ id: "x", type: "service-tile", props: {} })).toBe("Service tile");
    expect(historyLabel(d, [{ op: "node.add", parentId: root, node: stat("B") }])).toBe("Insert Stat");
    expect(historyLabel(d, [{ op: "node.remove", nodeId: a.id }])).toBe("Delete Stat");
    expect(historyLabel(d, [{ op: "node.move", nodeId: a.id, parentId: root, slot: { x: 3, y: 0, w: 3, h: 16 } }])).toBe("Move Stat");
    expect(historyLabel(d, [{ op: "node.update", nodeId: a.id, patch: { slot: { x: 4, y: 0, w: 3, h: 16 } } }])).toBe("Move Stat");
    expect(historyLabel(d, [{ op: "node.move", nodeId: a.id, parentId: root, slot: { x: 0, y: 0, w: 5, h: 20 } }])).toBe("Resize Stat");
    expect(historyLabel(d, [{ op: "node.update", nodeId: a.id, patch: { slot: { x: 0, y: 0, w: 6, h: 16 } } }])).toBe("Resize Stat");
    expect(historyLabel(d, [{ op: "node.update", nodeId: a.id, patch: { props: { label: "B" } } }])).toBe("Change Stat");
    expect(historyLabel(d, [{ op: "node.update", nodeId: a.id, patch: { props: { label: "A", value: { $bind: "{{ cpu }}" } } } }])).toBe("Change Stat data");
    expect(historyLabel(d, [{ op: "node.update", nodeId: a.id, patch: { style: { root: { color: "red" } } } as never }])).toBe("Change Stat style");
    const p = { id: newId("p"), slug: "two", title: "Two", inNav: true, root: { id: newId("c"), type: "grid" as const, props: {}, children: [] } };
    expect(historyLabel(d, [{ op: "page.add", page: p }])).toBe('Add page "Two"');
    const d2 = applyOpsToDoc(d, [{ op: "page.add", page: p }]);
    if (!d2.ok) throw new Error("page add");
    expect(historyLabel(d2.doc, [{ op: "page.remove", pageId: p.id }])).toBe('Remove page "Two"');
    expect(historyLabel(d2.doc, [{ op: "page.move", pageId: p.id, index: 0 }])).toBe("Reorder pages");
    expect(historyLabel(d2.doc, [{ op: "app.update", patch: { homePage: p.id } }])).toBe("Set start page");
    expect(historyLabel(d, [{ op: "node.remove", nodeId: a.id }, { op: "source.remove", name: "cpu" }])).toBe("Delete Stat");
  });

  it("a field key names the node and the changed props, so typing in one field coalesces", () => {
    const { a, d } = doc2();
    const k1 = fieldKey(d, [{ op: "node.update", nodeId: a.id, patch: { props: { label: "Ab" } } }]);
    const k2 = fieldKey(d, [{ op: "node.update", nodeId: a.id, patch: { props: { label: "A", unit: "%" } } }]);
    expect(k1).toBe(`node:${a.id}:props.label`);
    expect(k2).toBe(`node:${a.id}:props.unit`);
    expect(fieldKey(d, [{ op: "node.remove", nodeId: a.id }])).toBeNull();
  });
});

describe("DraftClient history (A11.1)", () => {
  it("typing in one field is one step until 1 s idle; blur seals it", async () => {
    const { a, d } = doc2();
    const h = harness(d);
    const type = (v: string) => h.client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: v } } }], { coalesce: `node:${a.id}:props.label` });
    for (const v of ["L", "Lo", "Loa", "Load"]) { type(v); h.tick(200); }
    expect(h.client.depth).toBe(1);
    expect(h.client.undoLabel).toBe("Change Stat");
    h.tick(COALESCE_IDLE_MS);
    type("Load!");
    expect(h.client.depth).toBe(2);
    h.client.seal();
    type("Load!!");
    expect(h.client.depth).toBe(3);
    h.client.undo(); h.client.undo();
    expect(findNode(h.client.doc, a.id)!.node.props.label).toBe("Load");
    h.client.undo();
    expect(findNode(h.client.doc, a.id)!.node.props.label).toBe("A");
    await h.advance(DEBOUNCE_MS);
    expect(findNode(h.state.doc, a.id)!.node.props.label).toBe("A");
  });

  it("two separate edits to the same field without the coalesce key stay two steps", () => {
    const { a, d } = doc2();
    const h = harness(d);
    h.client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "X" } } }]);
    h.client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "Y" } } }]);
    expect(h.client.depth).toBe(2);
  });

  it("keeps at most 100 steps; the oldest drops", () => {
    const { a, d } = doc2();
    const h = harness(d);
    for (let i = 0; i < HISTORY_CAP + 20; i++) h.client.edit([{ op: "node.update", nodeId: a.id, patch: { slot: { x: i % 9, y: i, w: 3, h: 16 } } }]);
    expect(h.client.depth).toBe(HISTORY_CAP);
    let n = 0;
    while (h.client.canUndo) { h.client.undo(); n++; }
    expect(n).toBe(HISTORY_CAP);
    expect(findNode(h.client.doc, a.id)!.node.slot!.y).toBe(19);
  });

  it("undo and redo return their words; the labels follow the stacks", () => {
    const { a, d, root } = doc2();
    const h = harness(d);
    expect(h.client.undoLabel).toBeNull();
    h.client.edit([{ op: "node.move", nodeId: a.id, parentId: root, slot: { x: 3, y: 0, w: 3, h: 16 } }]);
    expect(h.client.undoLabel).toBe("Move Stat");
    expect(h.client.undo()).toBe("Move Stat");
    expect(h.client.undoLabel).toBeNull();
    expect(h.client.redoLabel).toBe("Move Stat");
    expect(h.client.redo()).toBe("Move Stat");
    expect(h.client.redoLabel).toBeNull();
  });

  it("a publish keeps the history; a restore clears it", async () => {
    const { a, d } = doc2();
    const h = harness(d);
    h.client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "P" } } }]);
    await h.advance(DEBOUNCE_MS);
    h.client.reset(h.state.doc, h.state.rev, { keepHistory: true });
    expect(h.client.canUndo).toBe(true);
    h.client.undo();
    await h.advance(DEBOUNCE_MS);
    expect(findNode(h.state.doc, a.id)!.node.props.label).toBe("A");
    h.client.reset(h.state.doc, h.state.rev);
    expect(h.client.canUndo || h.client.canRedo).toBe(false);
  });

  it("the delete toast's Undo takes back only its own step", () => {
    const { a, d } = doc2();
    const h = harness(d);
    h.client.edit([{ op: "node.remove", nodeId: a.id }]);
    const id = h.client.lastEntryId;
    const b = stat("B");
    h.client.edit([{ op: "node.add", parentId: d.pages[0]!.root.id, node: b }]);
    expect(h.client.undoEntry(id)).toBe(false);
    expect(findNode(h.client.doc, b.id)).toBeTruthy();
    h.client.undo();
    expect(h.client.undoEntry(id)).toBe(true);
    expect(findNode(h.client.doc, a.id)).toBeTruthy();
  });

  it("undo of a step whose target another editor removed is refused with a sentence and skipped", async () => {
    const { a, d, root } = doc2();
    const b = stat("B");
    const h = harness(d);
    h.client.edit([{ op: "node.add", parentId: root, node: b }]);
    h.client.edit([{ op: "node.move", nodeId: a.id, parentId: root, slot: { x: 6, y: 0, w: 3, h: 16 } }]);
    await h.advance(DEBOUNCE_MS);
    h.agent([{ op: "node.remove", nodeId: a.id }]);
    h.client.undo();
    await h.advance(DEBOUNCE_MS);
    expect(h.events.dropped).toEqual([skippedMessage("undo", "Move Stat")]);
    expect(h.client.redoLabel).toBeNull();
    expect(h.client.undoLabel).toBe("Insert Stat");
    // The next undo goes on with the step before.
    h.client.undo();
    await h.advance(DEBOUNCE_MS);
    expect(findNode(h.state.doc, b.id)).toBeNull();
    // Locally known gone: refused at once, with the same sentence.
    const h2 = harness(d);
    h2.client.edit([{ op: "node.update", nodeId: a.id, patch: { props: { label: "Z" } } }]);
    h2.client.edit([{ op: "node.remove", nodeId: a.id }], { history: "none" });
    expect(h2.client.undo()).toBeNull();
    expect(h2.events.dropped).toEqual([skippedMessage("undo", "Change Stat")]);
    expect(findPage(h2.client.doc, d.pages[0]!.id)).toBeTruthy();
  });
});
