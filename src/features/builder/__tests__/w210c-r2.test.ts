// Wave 2.10c round 2, builder A (gauntlet r1 Fix List items 1, 5, 6c and 19): the builder's own op engine
// lets a roulette hold its slots, an undo of a slot delete puts it back in place, a full roulette refuses in
// words, a row named __proto__ can never reach a prototype, and step names use a widget's own title.
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, DraftOp } from "@/core/contracts";
import { blankDocument, findNode, newId } from "@/features/apps/doc";
import { applyOpsToDoc } from "@/features/apps/ops";
import { copyEditOps, copyChanged, overrideFor, resetCopyOps, safeKey } from "../copy-overrides";
import { DraftClient, type SendResult } from "../draft-client";
import { historyLabel, stepName } from "../history-label";
import { rouletteRefusal, ROULETTE_SLOTS } from "../roulette-drop";

const text = (t: string): ComponentNode => ({ id: newId("c"), type: "text", props: { text: t } });
function rouletteDoc(mode: "slots" | "repeat" = "slots", kids: ComponentNode[] = []) {
  const d = blankDocument("T");
  const r: ComponentNode = { id: newId("c"), type: "roulette", props: { mode, advance: { scroll: true, arrows: true, dots: true } }, slot: { x: 0, y: 0, w: 3, h: 28 }, children: kids };
  d.pages[0]!.root.children = [r];
  return { d, r };
}
function client(doc: AppDocument) {
  const state = { doc, rev: 1 };
  const dropped: string[] = [];
  const c = new DraftClient(doc, 1, {
    send: async (rev: number, ops: DraftOp[]): Promise<SendResult> => {
      const r = applyOpsToDoc(state.doc, ops);
      if (!r.ok) return { ok: false, kind: "invalid", problems: r.problems };
      state.doc = r.doc; state.rev = rev + 1;
      return { ok: true, rev: state.rev };
    },
    fetchDraft: async () => ({ rev: state.rev, doc: state.doc }),
    setTimeout: () => 0,
    clearTimeout: () => {},
  }, { onDropped: (m) => dropped.push(m) });
  return { c, state, dropped };
}

describe("item 1: a roulette holds its slots in the builder's op engine", () => {
  it("adds and moves widgets into a roulette locally (no checks passed, as the builder applies)", () => {
    const { d, r } = rouletteDoc();
    const a = text("A");
    const added = applyOpsToDoc(d, [{ op: "node.add", parentId: r.id, node: a }]);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const b: ComponentNode = { ...text("B"), slot: { x: 4, y: 0, w: 3, h: 8 } };
    const withB = applyOpsToDoc(added.doc, [{ op: "node.add", parentId: added.doc.pages[0]!.root.id, node: b }]);
    if (!withB.ok) throw new Error("add b");
    const moved = applyOpsToDoc(withB.doc, [{ op: "node.move", nodeId: b.id, parentId: r.id }]);
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(findNode(moved.doc, r.id)!.node.children!.map((c) => c.id)).toEqual([a.id, b.id]);
  });
  it("refuses a 51st slot and a second template, in words", () => {
    const many = Array.from({ length: ROULETTE_SLOTS }, (_, i) => text(String(i)));
    expect(rouletteRefusal(rouletteDoc("slots", many.slice(0, 49)).r)).toBeNull();
    expect(rouletteRefusal(rouletteDoc("slots", many).r)).toMatch(/at most 50 slots/);
    expect(rouletteRefusal(rouletteDoc("repeat").r)).toBeNull();
    const one = rouletteDoc("repeat", [text("T")]).r;
    expect(rouletteRefusal(one)).toMatch(/already has it/);
    // The template itself moving inside its own roulette is not a second one.
    expect(rouletteRefusal(one, one.children![0]!.id)).toBeNull();
  });
});

describe("item 5: undo of a roulette slot delete", () => {
  it("puts the slot back in its place, from the toast's entry and the bar, with no skip sentence", async () => {
    const kids = [text("one"), text("two"), text("three")];
    const { d, r } = rouletteDoc("slots", kids);
    const { c, dropped } = client(d);
    expect(c.edit([{ op: "node.remove", nodeId: kids[1]!.id }])).toBeNull();
    expect(c.undoLabel).toBe("Delete Text");
    expect(c.undoEntry(c.lastEntryId)).toBe(true);
    expect(findNode(c.doc, r.id)!.node.children!.map((k) => k.id)).toEqual(kids.map((k) => k.id));
    expect(c.redo()).toBe("Delete Text");
    expect(findNode(c.doc, kids[1]!.id)).toBeNull();
    expect(c.undo()).toBe("Delete Text");
    expect(findNode(c.doc, r.id)!.node.children!.map((k) => k.id)).toEqual(kids.map((k) => k.id));
    await c.flush();
    expect(dropped).toEqual([]);
  });
});

describe("item 6c: a row named __proto__, constructor or prototype never reaches a prototype", () => {
  function repeatDoc() {
    const d = blankDocument("T");
    const stat: ComponentNode = { id: newId("c"), type: "stat", props: { label: "x" } };
    const rep: ComponentNode = { id: newId("c"), type: "repeat", props: { items: [] }, slot: { x: 0, y: 0, w: 6, h: 20 }, children: [stat] };
    d.pages[0]!.root.children = [rep];
    return { d, rep, stat };
  }
  it("writes no override for those keys and leaves Object.prototype alone", () => {
    const { d, rep, stat } = repeatDoc();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(safeKey(key)).toBe(false);
      const r = copyEditOps(d, rep.id, key, stat.id, { props: { label: "changed" } });
      expect(r.ops).toEqual([]);
      expect(({} as Record<string, unknown>)[stat.id]).toBeUndefined();
      expect(overrideFor(d, rep.id, key, stat.id)).toBeUndefined();
      expect(copyChanged(d, rep.id, key)).toBe(false);
      expect(resetCopyOps(d, rep.id, key)).toEqual([]);
    }
  });
  it("ignores a stored override map that carries such keys, and still writes safe rows", () => {
    const { d, rep, stat } = repeatDoc();
    const raw = JSON.parse(`{"__proto__": {"${stat.id}": {"props": {"label": "bad"}}}, "ACE": {"${stat.id}": {"props": {"label": "ok"}}}}`);
    rep.props.copyOverrides = raw;
    expect(overrideFor(d, rep.id, "ACE", stat.id)?.props?.label).toBe("ok");
    expect(overrideFor(d, rep.id, "__proto__", stat.id)).toBeUndefined();
    const r = copyEditOps(d, rep.id, "firefly", stat.id, { props: { label: "ff" } });
    expect(r.ops).toHaveLength(1);
    const patch = JSON.stringify((r.ops[0] as Extract<DraftOp, { op: "node.update" }>).patch);
    expect(patch).toContain("firefly");
    expect(patch).not.toContain("__proto__");
    expect(({} as Record<string, unknown>)[stat.id]).toBeUndefined();
  });
});

describe("item 19: step names", () => {
  it("use the widget's own title or name, and quote page names", () => {
    const d = blankDocument("T");
    const titled: ComponentNode = { id: newId("c"), type: "chart", title: "Network in, every machine", props: {}, slot: { x: 0, y: 0, w: 3, h: 8 } };
    const plain: ComponentNode = { id: newId("c"), type: "stat", props: { label: "Load" }, slot: { x: 3, y: 0, w: 3, h: 8 } };
    d.pages[0]!.root.children = [titled, plain];
    expect(stepName(titled)).toBe('Chart "Network in, every machine"');
    expect(stepName(plain)).toBe("Stat");
    expect(historyLabel(d, [{ op: "node.remove", nodeId: titled.id }])).toBe('Delete Chart "Network in, every machine"');
    expect(historyLabel(d, [{ op: "node.remove", nodeId: plain.id }])).toBe("Delete Stat");
    const page = d.pages[0]!;
    expect(historyLabel(d, [{ op: "page.update", pageId: page.id, patch: { title: "Second" } }])).toBe(`Rename page "${page.title}" to "Second"`);
  });
});
