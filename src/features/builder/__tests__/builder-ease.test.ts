// Wave 2.6 builder ease (canvas): grid columns, fine slots, alignment guides, hidden layers, page width
// and padding (architecture Amendment 7, A7.3 to A7.6).
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, GridSlot } from "@/core/contracts";
import { blankDocument, findNode, newId } from "@/features/apps/doc";
import { applyOpsToDoc, isSlot } from "@/features/apps/ops";
import { alignGuides, cellAt, columnsChangeOps, FINE, keyAction, resizeSlot, slotRect, toEighth, type KeyInput } from "../geometry";
import { cellStyle, closeHiddenRows, gridColumnsOf, stretchRows } from "@/features/components/render/layout";
import { hiddenOnDevice } from "@/features/components/render/resolve";

const box = { left: 100, top: 50, width: 1100, colGap: 16, rowGap: 0, rowPx: 8, cols: 12 };
const colStep = (1100 - 11 * 16) / 12 + 16;
const k = (key: string, over: Partial<KeyInput> = {}): KeyInput => ({ key, shift: false, alt: false, mod: false, ...over });

function docWith(slots: GridSlot[], columns?: 6 | 12 | 24): { d: AppDocument; ids: string[]; gridId: string } {
  const d = blankDocument("T");
  const root = d.pages[0]!.root;
  if (columns) root.props = { ...root.props, columns };
  const kids: ComponentNode[] = slots.map((slot) => ({ id: newId("c"), type: "stat", props: {}, slot }));
  root.children = kids;
  return { d, ids: kids.map((k) => k.id), gridId: root.id };
}

/** The placement every whole-number slot had before Wave 2.6 (layout.tsx cellStyle as of 2026-10-19). */
function oldCellStyle(slot: GridSlot, mobile: boolean) {
  const cols = mobile ? 4 : 12;
  const w = Math.max(1, Math.min(cols, Math.round(slot.w)));
  const x = Math.max(0, Math.min(cols - w, Math.round(slot.x)));
  const h = Math.max(1, Math.round(slot.h));
  return { gridColumn: `${x + 1} / span ${w}`, gridRow: `${Math.max(0, Math.round(slot.y)) + 1} / span ${h}` };
}

describe("criterion 22: whole-number slots place exactly as before", () => {
  it("every whole slot on 12 and 4 columns gives the same grid placement", () => {
    for (let x = 0; x < 12; x++) for (let w = 1; w <= 12; w++) for (const y of [0, 7, 40]) for (const h of [1, 16, 35]) {
      expect(cellStyle({ x, y, w, h }, false)).toEqual(oldCellStyle({ x, y, w, h }, false));
      expect(cellStyle({ x, y, w, h }, false, undefined, 12)).toEqual(oldCellStyle({ x, y, w, h }, false));
    }
    for (let x = 0; x < 4; x++) for (let w = 1; w <= 4; w++) expect(cellStyle({ x, y: 3, w, h: 9 }, true)).toEqual(oldCellStyle({ x, y: 3, w, h: 9 }, true));
    expect(cellStyle(undefined, true, 12)).toEqual({ gridColumn: "1 / -1", gridRow: "auto / span 12" });
  });
  it("a grid without a columns prop has 12 columns on desktop and 4 on phones", () => {
    expect(gridColumnsOf({}, false)).toBe(12);
    expect(gridColumnsOf({ columns: 24 }, false)).toBe(24);
    expect(gridColumnsOf({ columns: 6 }, false)).toBe(6);
    expect(gridColumnsOf({ columns: 7 }, false)).toBe(12);
    expect(gridColumnsOf({ columns: 24 }, true)).toBe(4);
  });
  it("stretchRows gives the same rows for whole slots", () => {
    const r = stretchRows([{ id: "a", slot: { x: 0, y: 0, w: 6, h: 10 } }, { id: "b", slot: { x: 6, y: 0, w: 6, h: 20 } }, { id: "c", slot: { x: 0, y: 30, w: 12, h: 5 } }], 12);
    expect(r.a).toEqual({ x: 0, y: 0, w: 6, h: 20 });
    expect(r.b).toEqual({ x: 6, y: 0, w: 6, h: 20 });
    expect(r.c).toEqual({ x: 0, y: 30, w: 12, h: 5 });
  });
});

describe("fine slots (A7.4)", () => {
  it("a fine slot spans the whole columns it touches and is inset inside them", () => {
    const s = cellStyle({ x: 1.5, y: 0, w: 2, h: 4 }, false, undefined, 12);
    expect(s.gridColumn).toBe("2 / span 3");
    expect(s.justifySelf).toBe("start");
    expect(String(s.marginLeft)).toContain("* 0.16666666666666666");
    expect(String(s.width)).toContain("* 0.6666666666666666");
  });
  it("the inset matches the builder's pixel geometry (slotRect) for every eighth", () => {
    // In px: a cell spanning columns a..b is (b-a)*step - gap wide; the CSS is margin = (100% + gap) * (x-a)/n.
    const gap = 16;
    for (const [x, w] of [[0.125, 1], [3.375, 2.5], [10.875, 1.125], [0, 0.5]] as const) {
      const a = Math.floor(x);
      const n = Math.max(1, Math.min(12, Math.ceil(x + w)) - a);
      const area = n * colStep - gap;
      const margin = (area + gap) * ((x - a) / n);
      const width = (area + gap) * (w / n) - gap;
      const r = slotRect(box, { x, y: 0, w, h: 1 });
      expect(a * colStep + margin).toBeCloseTo(r.left, 6);
      expect(width).toBeCloseTo(r.width, 6);
    }
  });
  it("cellAt and resizeSlot step in eighths with snapping off, whole columns with it on", () => {
    const px = 100 + 3.4 * colStep;
    expect(cellAt(box, px, 60, 3, 16).x).toBe(3);
    expect(cellAt(box, px, 60, 3, 16, FINE).x).toBe(3.375);
    const s0 = { x: 2, y: 4, w: 3, h: 16 };
    expect(resizeSlot(s0, { e: true }, colStep * 0.26, 0, box).w).toBe(3);
    expect(resizeSlot(s0, { e: true }, colStep * 0.26, 0, box, FINE).w).toBe(3.25);
    expect(resizeSlot(s0, { w: true }, -colStep * 0.6, 0, box, FINE)).toEqual({ x: 1.375, y: 4, w: 3.625, h: 16 });
  });
  it("criterion 20: with snap off a left edge can sit on any 48th of the width", () => {
    for (let i = 0; i < 48; i++) {
      const x = i / 4;
      const px = 100 + x * colStep + 0.5;
      expect(cellAt(box, px, 60, 1, 8, FINE).x).toBe(Math.min(x, 11));
    }
  });
  it("ops accept eighths for x and w, whole rows for y and h", () => {
    expect(isSlot({ x: 1.125, y: 2, w: 0.5, h: 3 })).toBe(true);
    expect(isSlot({ x: 1.1, y: 2, w: 1, h: 3 })).toBe(false);
    expect(isSlot({ x: 1, y: 2.5, w: 1, h: 3 })).toBe(false);
    expect(isSlot({ x: 1, y: 2, w: 0, h: 3 })).toBe(false);
    const { d, ids, gridId } = docWith([{ x: 0, y: 0, w: 3, h: 4 }]);
    expect(applyOpsToDoc(d, [{ op: "node.move", nodeId: ids[0]!, parentId: gridId, slot: { x: 0.375, y: 1, w: 2.75, h: 4 } }]).ok).toBe(true);
    const bad = applyOpsToDoc(d, [{ op: "node.move", nodeId: ids[0]!, parentId: gridId, slot: { x: 0.3, y: 1, w: 2, h: 4 } }]);
    expect(bad.ok).toBe(false);
    expect(applyOpsToDoc(d, [{ op: "node.update", nodeId: ids[0]!, patch: { slot: { x: 0.3, y: 0, w: 1, h: 1 } } }]).ok).toBe(false);
  });
  it("arrow keys move by a column with snap on and an eighth with it off", () => {
    const { d, ids } = docWith([{ x: 2, y: 4, w: 3, h: 16 }]);
    const on = keyAction(d, ids[0]!, k("ArrowRight"), "desktop");
    const off = keyAction(d, ids[0]!, k("ArrowRight"), "desktop", { step: FINE });
    const grow = keyAction(d, ids[0]!, k("ArrowRight", { shift: true }), "desktop", { step: FINE });
    expect(on?.kind === "ops" && on.ops[0]!.op === "node.move" && on.ops[0]!.slot).toEqual({ x: 3, y: 4, w: 3, h: 16 });
    expect(off?.kind === "ops" && off.ops[0]!.op === "node.move" && off.ops[0]!.slot).toEqual({ x: 2.125, y: 4, w: 3, h: 16 });
    expect(grow?.kind === "ops" && grow.ops[0]!.op === "node.move" && grow.ops[0]!.slot).toEqual({ x: 2, y: 4, w: 3.125, h: 16 });
  });
  it("arrows respect a 24-column grid's edge", () => {
    const { d, ids } = docWith([{ x: 20, y: 0, w: 4, h: 4 }], 24);
    expect(keyAction(d, ids[0]!, k("ArrowRight"), "desktop")).toBeNull();
    const left = keyAction(d, ids[0]!, k("ArrowLeft"), "desktop");
    expect(left?.kind === "ops" && left.ops[0]!.op === "node.move" && left.ops[0]!.slot?.x).toBe(19);
  });
});

describe("columnsChangeOps (A7.4)", () => {
  it("rescales x and w so nothing moves, in one batch", () => {
    const { d, ids, gridId } = docWith([{ x: 0, y: 0, w: 3, h: 16 }, { x: 3, y: 0, w: 9, h: 16 }, { x: 1.5, y: 20, w: 2.25, h: 8 }]);
    const ops = columnsChangeOps(d, gridId, 24);
    expect(ops[0]).toEqual({ op: "node.update", nodeId: gridId, patch: { props: { columns: 24 } } });
    const r = applyOpsToDoc(d, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kids = r.doc.pages[0]!.root.children!;
    expect(r.doc.pages[0]!.root.props.columns).toBe(24);
    expect(kids.map((c) => c.slot)).toEqual([{ x: 0, y: 0, w: 6, h: 16 }, { x: 6, y: 0, w: 18, h: 16 }, { x: 3, y: 20, w: 4.5, h: 8 }]);
    expect(kids.map((c) => c.id)).toEqual(ids);
    // The same fraction of the width before and after.
    for (const [i, c] of kids.entries()) {
      const before = d.pages[0]!.root.children![i]!.slot!;
      expect(c.slot!.x / 24).toBeCloseTo(before.x / 12, 9);
      expect(c.slot!.w / 24).toBeCloseTo(before.w / 12, 9);
    }
  });
  it("12 to 6 halves, rounding to eighths, and keeps phone slots", () => {
    const { d, gridId } = docWith([{ x: 1, y: 0, w: 3, h: 4 }, { x: 5, y: 0, w: 7, h: 4 }]);
    d.pages[0]!.root.children![0]!.responsive = { mobile: { slot: { x: 0, y: 0, w: 4, h: 4 } } };
    const r = applyOpsToDoc(d, columnsChangeOps(d, gridId, 6));
    expect(r.ok && r.doc.pages[0]!.root.children!.map((c) => c.slot)).toEqual([{ x: 0.5, y: 0, w: 1.5, h: 4 }, { x: 2.5, y: 0, w: 3.5, h: 4 }]);
    expect(r.ok && r.doc.pages[0]!.root.children![0]!.responsive?.mobile?.slot).toEqual({ x: 0, y: 0, w: 4, h: 4 });
  });
  it("nothing to do when the count is already set; a non-grid gets no ops", () => {
    const { d, gridId, ids } = docWith([{ x: 0, y: 0, w: 3, h: 4 }], 24);
    expect(columnsChangeOps(d, gridId, 24)).toEqual([]);
    expect(columnsChangeOps(d, ids[0]!, 12)).toEqual([]);
    expect(columnsChangeOps(d, "c_missingaaaa", 12)).toEqual([]);
  });
  it("there and back again returns the original slots", () => {
    const { d, gridId } = docWith([{ x: 0, y: 0, w: 3, h: 4 }, { x: 4.125, y: 9, w: 1.875, h: 4 }]);
    const a = applyOpsToDoc(d, columnsChangeOps(d, gridId, 24));
    if (!a.ok) throw new Error("apply failed");
    const b = applyOpsToDoc(a.doc, columnsChangeOps(a.doc, gridId, 12));
    expect(b.ok && b.doc.pages[0]!.root.children!.map((c) => c.slot)).toEqual(d.pages[0]!.root.children!.map((c) => c.slot));
    expect(toEighth(0.1)).toBe(0.125);
  });
});

describe("alignment guides (spec 3.5)", () => {
  const other = { x: 4, y: 10, w: 3, h: 16 };
  it("pulls a left edge onto another widget's left edge within the pull distance", () => {
    const r = alignGuides({ x: 4.125, y: 40, w: 2, h: 8 }, [other], 12, { x: 0.2, y: 0.5 });
    expect(r.box.x).toBe(4);
    expect(r.guides.some((g) => g.axis === "x" && g.at === 4)).toBe(true);
  });
  it("lines up on the page centre", () => {
    const r = alignGuides({ x: 4.875, y: 40, w: 2, h: 8 }, [], 12, { x: 0.2, y: 0.5 });
    expect(r.box.x).toBe(5);
    expect(r.guides).toEqual([{ axis: "x", at: 6, kind: "centre", page: true }]);
  });
  it("lines up tops, and does nothing beyond the pull distance", () => {
    const r = alignGuides({ x: 9, y: 10, w: 2, h: 8 }, [other], 12, { x: 0.2, y: 0.5 });
    expect(r.guides.some((g) => g.axis === "y" && g.at === 10)).toBe(true);
    const far = alignGuides({ x: 8.5, y: 30, w: 1, h: 8 }, [other], 12, { x: 0.2, y: 0.5 });
    expect(far.box).toEqual({ x: 8.5, y: 30, w: 1, h: 8 });
    expect(far.guides).toEqual([]);
  });
});

describe("hidden layers (A7.3)", () => {
  it("desktop hidden and phone hidden are separate", () => {
    const n: ComponentNode = { id: "c_aaaaaaaaaa", type: "text", props: {}, hidden: true };
    expect(hiddenOnDevice(n, "desktop")).toBe(true);
    expect(hiddenOnDevice(n, "mobile")).toBe(false);
    const m: ComponentNode = { id: "c_aaaaaaaaab", type: "text", props: {}, responsive: { mobile: { hidden: true } } };
    expect(hiddenOnDevice(m, "desktop")).toBe(false);
    expect(hiddenOnDevice(m, "mobile")).toBe(true);
  });
  it("criterion 15: rows only a hidden layer covered close up; shared rows stay", () => {
    const visible = [{ id: "a", slot: { x: 0, y: 0, w: 12, h: 10 } }, { id: "c", slot: { x: 0, y: 30, w: 12, h: 5 } }, { id: "d", slot: { x: 6, y: 12, w: 6, h: 4 } }];
    const out = closeHiddenRows(visible, [{ x: 0, y: 10, w: 6, h: 20 }]);
    // Rows 10..29 were the hidden layer's; rows 12..15 are also d's. 16 rows go: c moves up from 30 to 14.
    expect(out.find((s) => s.id === "c")!.slot!.y).toBe(14);
    expect(out.find((s) => s.id === "d")!.slot!.y).toBe(10);
    expect(out.find((s) => s.id === "a")!.slot!.y).toBe(0);
    expect(closeHiddenRows(visible, [])).toBe(visible);
  });
  it("hidden is a draft change with an undo", () => {
    const { d, ids } = docWith([{ x: 0, y: 0, w: 3, h: 4 }]);
    const r = applyOpsToDoc(d, [{ op: "node.update", nodeId: ids[0]!, patch: { hidden: true } }]);
    expect(r.ok && findNode(r.doc, ids[0]!)!.node.hidden).toBe(true);
    expect(applyOpsToDoc(d, [{ op: "node.update", nodeId: ids[0]!, patch: { hidden: "yes" as never } }]).ok).toBe(false);
  });
});

describe("page width and padding (A7.5)", () => {
  it("accepts the listed widths and padding, refuses others, and clears with null", () => {
    const d = blankDocument("T");
    const pid = d.pages[0]!.id;
    const ok = applyOpsToDoc(d, [{ op: "page.update", pageId: pid, patch: { maxWidth: 1440, padding: "none" } }]);
    expect(ok.ok && ok.doc.pages[0]!.maxWidth).toBe(1440);
    expect(ok.ok && ok.doc.pages[0]!.padding).toBe("none");
    expect(applyOpsToDoc(d, [{ op: "page.update", pageId: pid, patch: { padding: 32 } }]).ok).toBe(true);
    expect(applyOpsToDoc(d, [{ op: "page.update", pageId: pid, patch: { maxWidth: 1000 as never } }]).ok).toBe(false);
    expect(applyOpsToDoc(d, [{ op: "page.update", pageId: pid, patch: { padding: 65 } }]).ok).toBe(false);
    expect(applyOpsToDoc(d, [{ op: "page.update", pageId: pid, patch: { padding: 2.5 } }]).ok).toBe(false);
    if (!ok.ok) return;
    const cleared = applyOpsToDoc(ok.doc, [{ op: "page.update", pageId: pid, patch: { maxWidth: null, padding: null } as never }]);
    expect(cleared.ok && "maxWidth" in cleared.doc.pages[0]!).toBe(false);
    expect(cleared.ok && "padding" in cleared.doc.pages[0]!).toBe(false);
  });
});
