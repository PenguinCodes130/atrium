// Builder geometry and keyboard shortcuts (criteria 8, 11, 12).
import { describe, expect, it } from "vitest";
import type { ComponentNode } from "@/core/contracts";
import { blankDocument, findNode, newId } from "@/features/apps/doc";
import { applyOpsToDoc } from "@/features/apps/ops";
import { cellAt, fitOps, keyAction, resizeSlot, slotRect, type KeyInput } from "../geometry";

const box = { left: 100, top: 50, width: 1100, colGap: 16, rowGap: 0, rowPx: 8, cols: 12 };
const k = (key: string, over: Partial<KeyInput> = {}): KeyInput => ({ key, shift: false, alt: false, mod: false, ...over });

function doc() {
  const d = blankDocument("T");
  const a: ComponentNode = { id: newId("c"), type: "stat", props: {}, slot: { x: 2, y: 4, w: 3, h: 16 } };
  const b: ComponentNode = { id: newId("c"), type: "stat", props: {}, slot: { x: 6, y: 4, w: 3, h: 16 } };
  d.pages[0]!.root.children = [a, b];
  return { d, a, b };
}

describe("grid cells", () => {
  it("finds the cell under the pointer and back", () => {
    const s = cellAt(box, 100 + 3 * ((1100 - 11 * 16) / 12 + 16) + 5, 50 + 10 * 8 + 3, 3, 16);
    expect(s).toEqual({ x: 3, y: 10, w: 3, h: 16 });
    const r = slotRect(box, s);
    expect(Math.round(r.left)).toBe(Math.round(3 * ((1100 - 176) / 12 + 16)));
    expect(cellAt(box, 5000, 60, 3, 16).x).toBe(9); // clamped inside 12 columns
  });
});

describe("resize handles (operator bug 2)", () => {
  const step = (1100 - 11 * 16) / 12 + 16;
  const s0 = { x: 2, y: 4, w: 3, h: 16 };
  it("the east edge and south edge snap to whole columns and rows", () => {
    expect(resizeSlot(s0, { e: true }, step * 2 + 3, 0, box)).toEqual({ x: 2, y: 4, w: 5, h: 16 });
    expect(resizeSlot(s0, { s: true }, 0, 8 * 4 + 2, box)).toEqual({ x: 2, y: 4, w: 3, h: 20 });
    expect(resizeSlot(s0, { e: true, s: true }, -step, -8 * 6, box)).toEqual({ x: 2, y: 4, w: 2, h: 10 });
  });
  it("the west and north edges keep the opposite side fixed", () => {
    expect(resizeSlot(s0, { w: true }, -step, 0, box)).toEqual({ x: 1, y: 4, w: 4, h: 16 });
    expect(resizeSlot(s0, { n: true }, 0, 8 * 2, box)).toEqual({ x: 2, y: 6, w: 3, h: 14 });
  });
  it("never goes under one cell or outside the columns", () => {
    expect(resizeSlot(s0, { e: true }, step * 40, 0, box).w).toBe(10);
    expect(resizeSlot(s0, { e: true, s: true }, -step * 40, -8 * 400, box)).toEqual({ x: 2, y: 4, w: 1, h: 1 });
    expect(resizeSlot(s0, { w: true, n: true }, -step * 40, -8 * 400, box)).toEqual({ x: 0, y: 0, w: 5, h: 20 });
    expect(resizeSlot(s0, { w: true, n: true }, step * 40, 8 * 400, box)).toEqual({ x: 4, y: 19, w: 1, h: 1 });
  });
});

describe("fit to content (operator, 2026-10-19)", () => {
  function wall() {
    const d = blankDocument("T");
    const at = (id: string, x: number, y: number, w: number, h: number): ComponentNode => ({ id, type: "stat", props: {}, slot: { x, y, w, h } });
    d.pages[0]!.root.children = [at("c_aaaaaaaaaa", 0, 0, 6, 10), at("c_bbbbbbbbbb", 6, 0, 6, 10), at("c_cccccccccc", 0, 10, 12, 8), at("c_dddddddddd", 0, 18, 4, 4)];
    return d;
  }
  const slots = (d: ReturnType<typeof wall>) => Object.fromEntries(d.pages[0]!.root.children!.map((k) => [k.id, k.slot]));
  it("grows a component and pushes everything below it down by the same rows", () => {
    const d = wall();
    const ops = fitOps(d, d.pages[0]!.root.id, { c_aaaaaaaaaa: 3 }, "desktop");
    const after = applyOpsToDoc(d, ops);
    expect(after.ok).toBe(true);
    const s = slots(after.ok ? after.doc : d);
    expect(s.c_aaaaaaaaaa).toEqual({ x: 0, y: 0, w: 6, h: 13 });
    expect(s.c_bbbbbbbbbb).toEqual({ x: 6, y: 0, w: 6, h: 10 }); // same row, not below: stays
    expect(s.c_cccccccccc).toEqual({ x: 0, y: 13, w: 12, h: 8 });
    expect(s.c_dddddddddd).toEqual({ x: 0, y: 21, w: 4, h: 4 });
  });
  it("grows several top to bottom without overlaps, and returns nothing when everything fits", () => {
    const d = wall();
    const ops = fitOps(d, d.pages[0]!.root.id, { c_bbbbbbbbbb: 2, c_cccccccccc: 5 }, "desktop");
    const after = applyOpsToDoc(d, ops);
    const s = slots(after.ok ? after.doc : d);
    expect(s.c_bbbbbbbbbb).toEqual({ x: 6, y: 0, w: 6, h: 12 });
    expect(s.c_cccccccccc).toEqual({ x: 0, y: 12, w: 12, h: 13 });
    expect(s.c_dddddddddd).toEqual({ x: 0, y: 25, w: 4, h: 4 });
    expect(fitOps(d, d.pages[0]!.root.id, {}, "desktop")).toEqual([]);
  });
  it("on the phone layout only phone slots change", () => {
    const d = wall();
    const ops = fitOps(d, d.pages[0]!.root.id, { c_aaaaaaaaaa: 2 }, "mobile");
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.op === "node.update" && "responsive" in o.patch)).toBe(true);
  });
});

describe("keyboard", () => {
  it("arrows move one cell, Shift resizes, and the announcement names position and size", () => {
    const { d, a } = doc();
    const act = keyAction(d, a.id, k("ArrowRight"), "desktop");
    expect(act).toMatchObject({ kind: "ops", announce: "stat: column 4, row 5, 3 wide, 16 tall" });
    const r = applyOpsToDoc(d, (act as unknown as { ops: never[] }).ops);
    expect(r.ok && findNode(r.doc, a.id)!.node.slot).toEqual({ x: 3, y: 4, w: 3, h: 16 });
    const grow = keyAction(d, a.id, k("ArrowDown", { shift: true }), "desktop");
    expect(grow).toMatchObject({ announce: "stat: column 3, row 5, 3 wide, 17 tall" });
  });
  it("mobile arrows edit only the phone layout", () => {
    const { d, a } = doc();
    const act = keyAction(d, a.id, k("ArrowDown"), "mobile") as unknown as { ops: never[] };
    const r = applyOpsToDoc(d, act.ops);
    expect(r.ok && findNode(r.doc, a.id)!.node.slot).toEqual(a.slot);
    expect(r.ok && findNode(r.doc, a.id)!.node.responsive?.mobile?.slot).toEqual({ x: 0, y: 5, w: 1, h: 16 });
  });
  it("Alt+arrows reorder, Enter and Esc select, Ctrl+D duplicates, Delete removes, Ctrl+Z undoes", () => {
    const { d, a, b } = doc();
    expect(keyAction(d, b.id, k("ArrowUp", { alt: true }), "desktop")).toMatchObject({ kind: "ops", announce: "stat moved to position 1 of 2" });
    expect(keyAction(d, a.id, k("Escape"), "desktop")).toMatchObject({ kind: "select", nodeId: d.pages[0]!.root.id });
    expect(keyAction(d, d.pages[0]!.root.id, k("Enter"), "desktop")).toMatchObject({ kind: "select", nodeId: a.id });
    const dup = keyAction(d, a.id, k("d", { mod: true }), "desktop") as { ops: { op: string; node: ComponentNode }[] };
    expect(dup.ops[0]!.op).toBe("node.add");
    expect(dup.ops[0]!.node.id).not.toBe(a.id);
    expect(keyAction(d, a.id, k("Delete"), "desktop")).toMatchObject({ ops: [{ op: "node.remove", nodeId: a.id }] });
    expect(keyAction(d, a.id, k("z", { mod: true }), "desktop")).toEqual({ kind: "undo" });
    expect(keyAction(d, a.id, k("z", { mod: true, shift: true }), "desktop")).toEqual({ kind: "redo" });
  });
});
