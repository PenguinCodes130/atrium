// Wave 2.7 placing and arranging (media layout spec 3.2, criteria 13 to 16): insert beside, the next free
// spot, duplicate beside, Sixth and "Same as neighbour", align, distribute, same size, group moves, group
// duplicates and the "covered" check. Pure geometry over real draft ops.
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, DraftOp, GridSlot } from "@/core/contracts";
import { blankDocument, findNode, newId } from "@/features/apps/doc";
import { applyOpsToDoc } from "@/features/apps/ops";
import { alignOps, coveredIds, distributeOps, duplicateOps, freeSpot, groupDuplicateOps, groupMoveOps, keyAction, neighbourWidth, overlaps, sameSizeOps, widthPresets } from "../geometry";

const stat = (slot: GridSlot, name?: string): ComponentNode => ({ id: newId("c"), type: "stat", props: {}, slot, ...(name ? { name } : {}) });
function docWith(...kids: ComponentNode[]): AppDocument {
  const d = blankDocument("T");
  d.pages[0]!.root.children = kids;
  return d;
}
const root = (d: AppDocument) => d.pages[0]!.root;
function run(d: AppDocument, ops: DraftOp[]): AppDocument {
  const r = applyOpsToDoc(d, ops);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.doc;
}
const slotOf = (d: AppDocument, id: string) => findNode(d, id)!.node.slot!;
const noOverlaps = (d: AppDocument) => {
  const s = (root(d).children ?? []).map((k) => k.slot!);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) expect(overlaps(s[i]!, s[j]!), `${JSON.stringify(s[i])} and ${JSON.stringify(s[j])}`).toBe(false);
};

describe("insert beside and the next free spot (criterion 13)", () => {
  it("with a stat selected, five inserts give six stats across one row at the same size", () => {
    const first = stat({ x: 0, y: 0, w: 2, h: 24 });
    let d = docWith(first);
    let sel = first;
    for (let i = 0; i < 5; i++) {
      const anchor = slotOf(d, sel.id);
      const n = stat(freeSpot(root(d), "desktop", { w: anchor.w, h: anchor.h }, anchor));
      d = run(d, [{ op: "node.add", parentId: root(d).id, node: n }]);
      sel = n;
    }
    const slots = root(d).children!.map((k) => k.slot!);
    expect(slots.map((s) => s.y)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(slots.map((s) => s.x)).toEqual([0, 2, 4, 6, 8, 10]);
    noOverlaps(d);
  });
  it("a full row sends the next one below the selected widget, near its column", () => {
    const a = stat({ x: 0, y: 0, w: 6, h: 24 });
    const b = stat({ x: 6, y: 0, w: 6, h: 24 });
    const d = docWith(a, b);
    expect(freeSpot(root(d), "desktop", { w: 6, h: 24 }, b.slot!)).toEqual({ x: 6, y: 24, w: 6, h: 24 });
  });
  it("on the row it tries the right first, then the left", () => {
    const a = stat({ x: 0, y: 0, w: 3, h: 24 });
    const b = stat({ x: 6, y: 0, w: 6, h: 24 });
    const d = docWith(a, b);
    expect(freeSpot(root(d), "desktop", { w: 3, h: 24 }, b.slot!)).toEqual({ x: 3, y: 0, w: 3, h: 24 });
  });
  it("with nothing selected it fills the first free spot from the top left, not column 1 under everything", () => {
    const a = stat({ x: 0, y: 0, w: 3, h: 24 });
    const d = docWith(a);
    expect(freeSpot(root(d), "desktop", { w: 3, h: 24 })).toEqual({ x: 3, y: 0, w: 3, h: 24 });
    const full = docWith(stat({ x: 0, y: 0, w: 12, h: 10 }));
    expect(freeSpot(root(full), "desktop", { w: 3, h: 16 })).toEqual({ x: 0, y: 10, w: 3, h: 16 });
    expect(freeSpot(root(docWith()), "desktop", { w: 3, h: 16 })).toEqual({ x: 0, y: 0, w: 3, h: 16 });
  });
  it("fits a gap of exactly the right width with fine (eighth) positions", () => {
    const d = docWith(stat({ x: 0, y: 0, w: 2.5, h: 8 }), stat({ x: 5, y: 0, w: 7, h: 8 }));
    expect(freeSpot(root(d), "desktop", { w: 2.5, h: 8 })).toEqual({ x: 2.5, y: 0, w: 2.5, h: 8 });
  });
});

describe("duplicate beside (criterion 14)", () => {
  it("puts the copy beside the original on its row, never over another widget", () => {
    const a = stat({ x: 0, y: 0, w: 4, h: 20 });
    const chart: ComponentNode = { id: newId("c"), type: "chart", props: {}, slot: { x: 0, y: 20, w: 12, h: 35 } };
    const d = docWith(a, chart);
    const dup = duplicateOps(d, a.id)!;
    const d2 = run(d, dup.ops);
    expect(slotOf(d2, dup.copyId)).toEqual({ x: 4, y: 0, w: 4, h: 20 });
    noOverlaps(d2);
    // Ctrl+D does the same and selects the copy.
    const act = keyAction(d, a.id, { key: "d", mod: true, shift: false, alt: false }, "desktop");
    expect(act?.kind).toBe("ops");
    const d3 = run(d, (act as { ops: DraftOp[] }).ops);
    expect(slotOf(d3, (act as { select: string }).select)).toEqual({ x: 4, y: 0, w: 4, h: 20 });
  });
  it("with no room on the row it goes below, beside nothing it would cover", () => {
    const a = stat({ x: 0, y: 0, w: 12, h: 10 });
    const b = stat({ x: 0, y: 10, w: 6, h: 10 });
    const d = docWith(a, b);
    const dup = duplicateOps(d, a.id)!;
    const d2 = run(d, dup.ops);
    expect(slotOf(d2, dup.copyId)).toEqual({ x: 0, y: 20, w: 12, h: 10 });
    noOverlaps(d2);
  });
});

describe("width presets", () => {
  it("Sixth comes first and is two of twelve columns, four of twenty-four, one of six", () => {
    expect(widthPresets(12).map((p) => [p.label, p.w])).toEqual([["Sixth", 2], ["Quarter", 3], ["Third", 4], ["Half", 6], ["Two thirds", 8], ["Full", 12]]);
    expect(widthPresets(24)[0]).toEqual({ label: "Sixth", w: 4 });
    expect(widthPresets(6)[0]).toEqual({ label: "Sixth", w: 1 });
  });
  it("Same as neighbour takes the nearest widget on the same rows, the left one first, else the one above", () => {
    const a = stat({ x: 0, y: 0, w: 2, h: 10 });
    const b = stat({ x: 2, y: 0, w: 5, h: 10 });
    const c = stat({ x: 9, y: 0, w: 3, h: 10 });
    const below = stat({ x: 0, y: 12, w: 7, h: 10 });
    const d = docWith(a, b, c, below);
    expect(neighbourWidth(d, b.id, "desktop")).toBe(2);
    expect(neighbourWidth(d, c.id, "desktop")).toBe(5);
    expect(neighbourWidth(d, below.id, "desktop")).toBe(2);
    expect(neighbourWidth(docWith(a), a.id, "desktop")).toBeNull();
  });
});

describe("multi-select arranging (criteria 15 and 16)", () => {
  const three = () => {
    const a = stat({ x: 0, y: 2, w: 2, h: 10 });
    const b = stat({ x: 3, y: 6, w: 2, h: 14 });
    const c = stat({ x: 9, y: 0, w: 3, h: 8 });
    return { a, b, c, d: docWith(a, b, c), ids: [a.id, b.id, c.id] };
  };
  it("Align top gives the same top; bottom, middle, left, right and centres line up the right edge", () => {
    const { d, ids } = three();
    const t = run(d, alignOps(d, ids, "top", "desktop"));
    expect(ids.map((id) => slotOf(t, id).y)).toEqual([0, 0, 0]);
    const b = run(d, alignOps(d, ids, "bottom", "desktop"));
    expect(ids.map((id) => slotOf(b, id).y + slotOf(b, id).h)).toEqual([20, 20, 20]);
    const m = run(d, alignOps(d, ids, "middle", "desktop"));
    expect(ids.map((id) => slotOf(m, id).y)).toEqual([5, 3, 6]);
    const l = run(d, alignOps(d, ids, "left", "desktop"));
    expect(ids.map((id) => slotOf(l, id).x)).toEqual([0, 0, 0]);
    const r = run(d, alignOps(d, ids, "right", "desktop"));
    expect(ids.map((id) => slotOf(r, id).x + slotOf(r, id).w)).toEqual([12, 12, 12]);
    const c = run(d, alignOps(d, ids, "centre", "desktop"));
    expect(ids.map((id) => slotOf(c, id).x + slotOf(c, id).w / 2)).toEqual([6, 6, 6]);
  });
  it("Distribute across gives equal gaps and keeps the outer two; down does the same in rows", () => {
    const a = stat({ x: 0, y: 0, w: 2, h: 8 });
    const b = stat({ x: 2, y: 0, w: 2, h: 8 });
    const c = stat({ x: 10, y: 0, w: 2, h: 8 });
    const d = docWith(a, b, c);
    const x = run(d, distributeOps(d, [a.id, b.id, c.id], "across", "desktop"));
    expect([a, b, c].map((n) => slotOf(x, n.id).x)).toEqual([0, 5, 10]);
    const gaps = [slotOf(x, b.id).x - (slotOf(x, a.id).x + 2), slotOf(x, c.id).x - (slotOf(x, b.id).x + 2)];
    expect(gaps[0]).toBe(gaps[1]);
    const p = stat({ x: 0, y: 0, w: 2, h: 8 });
    const q = stat({ x: 3, y: 9, w: 2, h: 8 });
    const r = stat({ x: 6, y: 40, w: 2, h: 8 });
    const d2 = docWith(p, q, r);
    const y = run(d2, distributeOps(d2, [p.id, q.id, r.id], "down", "desktop"));
    expect([p, q, r].map((n) => slotOf(y, n.id).y)).toEqual([0, 20, 40]);
    expect(distributeOps(d2, [p.id, q.id], "down", "desktop")).toEqual([]);
  });
  it("Same width and Same height copy the first one picked, kept inside the grid", () => {
    const { d, a, b, c } = three();
    const w = run(d, sameSizeOps(d, [c.id, a.id, b.id], "width", "desktop"));
    expect([a, b, c].map((n) => slotOf(w, n.id).w)).toEqual([3, 3, 3]);
    const h = run(d, sameSizeOps(d, [b.id, a.id, c.id], "height", "desktop"));
    expect([a, b, c].map((n) => slotOf(h, n.id).h)).toEqual([14, 14, 14]);
  });
  it("a group move moves every selected widget by the same amount, clamped as a group", () => {
    const { d, a, b, c, ids } = three();
    const m = run(d, groupMoveOps(d, ids, -1, 5, "desktop"));
    expect([a, b, c].map((n) => [slotOf(m, n.id).x, slotOf(m, n.id).y])).toEqual([[0, 7], [3, 11], [9, 5]]);
    // c's right edge is at 12 already: moving right is clamped to nothing across, rows still move.
    const r = run(d, groupMoveOps(d, ids, 4, 1, "desktop"));
    expect([a, b, c].map((n) => slotOf(r, n.id).x)).toEqual([0, 3, 9]);
    // c is at row 0 already: moving up is clamped to nothing at all.
    expect(groupMoveOps(d, ids, 0, -9, "desktop")).toEqual([]);
  });
  it("a group duplicate keeps the arrangement and lands where it covers nothing", () => {
    const a = stat({ x: 0, y: 0, w: 2, h: 8 });
    const b = stat({ x: 2, y: 0, w: 2, h: 8 });
    const d = docWith(a, b);
    const r = groupDuplicateOps(d, [a.id, b.id]);
    const d2 = run(d, r.ops);
    expect(r.copyIds.map((id) => slotOf(d2, id))).toEqual([{ x: 4, y: 0, w: 2, h: 8 }, { x: 6, y: 0, w: 2, h: 8 }]);
    noOverlaps(d2);
    const wide = docWith(stat({ x: 0, y: 0, w: 8, h: 8 }), stat({ x: 0, y: 8, w: 12, h: 4 }));
    const ids = root(wide).children!.slice(0, 1).map((k) => k.id);
    const r2 = groupDuplicateOps(wide, ids);
    const w2 = run(wide, r2.ops);
    expect(slotOf(w2, r2.copyIds[0]!)).toEqual({ x: 0, y: 12, w: 8, h: 8 });
    noOverlaps(w2);
  });
});

describe("covered widgets", () => {
  it("tags a widget entirely under a later sibling, not one partly under or under a hidden one", () => {
    const under = stat({ x: 1, y: 1, w: 2, h: 4 });
    const partly = stat({ x: 5, y: 0, w: 4, h: 4 });
    const over = stat({ x: 0, y: 0, w: 4, h: 8 });
    const right = stat({ x: 7, y: 0, w: 4, h: 4 });
    const d = docWith(under, partly, over, right);
    expect([...coveredIds(root(d), "desktop")]).toEqual([under.id]);
    const hiddenOver = { ...over, hidden: true };
    const d2 = docWith(under, hiddenOver);
    expect(coveredIds(root(d2), "desktop").size).toBe(0);
    // Painting order matters: the later one is on top, so the earlier big one is not covered.
    const d3 = docWith(over, under);
    expect(coveredIds(root(d3), "desktop").size).toBe(0);
  });
});
