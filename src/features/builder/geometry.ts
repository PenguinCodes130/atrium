// Grid math and keyboard editing for the builder (architecture v3 4.4 GridSlot: 12 columns on desktop by
// default, 6 or 24 by the grid's `columns` (A7.4), 4 on mobile, rows of 8px; x and w in eighths of a
// column with snapping off; design v4 section 6 "Keyboard"). Pure: no DOM.
import type { AppDocument, ComponentNode, DraftOp, GridSlot } from "@/core/contracts";
import { clone, findNode, newId, nodeLabel } from "@/features/apps/doc";

export type Device = "desktop" | "mobile";
export const COLUMNS: Record<Device, number> = { desktop: 12, mobile: 4 };
export const ROW_PX = 8;

/** A grid's geometry; `cellPad` is the gap under each cell (its bottom padding), outside the component. */
export type GridBox = { left: number; top: number; width: number; colGap: number; rowGap: number; rowPx: number; cols: number; cellPad?: number };

/**
 * The cell under a point, for a slot of size w by h, clamped inside the grid's columns. `step` is the
 * column step: 1 with snapping on (whole columns), FINE (an eighth of a column) with it off (A7.4).
 */
export function cellAt(box: GridBox, x: number, y: number, w: number, h: number, step = 1): GridSlot {
  const colW = (box.width - (box.cols - 1) * box.colGap) / box.cols;
  const stepX = colW + box.colGap;
  const stepY = box.rowPx + box.rowGap;
  const col = Math.floor((x - box.left) / stepX / step) * step;
  const row = Math.floor((y - box.top) / stepY);
  const ww = Math.max(step, Math.min(w, box.cols));
  return { x: Math.max(0, Math.min(box.cols - ww, col)), y: Math.max(0, row), w: ww, h: Math.max(1, h) };
}

/** The pixel rectangle of a slot inside a grid box (for the drop ghost and the cell overlay). */
export function slotRect(box: GridBox, s: GridSlot): { left: number; top: number; width: number; height: number } {
  const colW = (box.width - (box.cols - 1) * box.colGap) / box.cols;
  return {
    left: s.x * (colW + box.colGap),
    top: s.y * (box.rowPx + box.rowGap),
    width: s.w * colW + (s.w - 1) * box.colGap,
    height: s.h * box.rowPx + (s.h - 1) * box.rowGap,
  };
}

/** Which sides a resize handle moves: n and s change the rows, w and e the columns. */
export type Edges = { n?: boolean; s?: boolean; e?: boolean; w?: boolean };

/**
 * A slot resized from a handle (operator bug 2): `dx` and `dy` are the pointer's travel in pixels, snapped
 * to whole columns and rows of the grid box. The opposite side stays put; the slot keeps at least one
 * column and one row and stays inside the grid's columns.
 */
export function resizeSlot(start: GridSlot, edges: Edges, dx: number, dy: number, box: GridBox, step = 1): GridSlot {
  const colW = (box.width - (box.cols - 1) * box.colGap) / box.cols;
  const dc = Math.round(dx / (colW + box.colGap) / step) * step;
  const dr = Math.round(dy / (box.rowPx + box.rowGap));
  let { x, y, w, h } = start;
  if (edges.e) w = Math.max(step, Math.min(box.cols - x, start.w + dc));
  if (edges.w) {
    const right = start.x + start.w;
    x = Math.max(0, Math.min(right - step, start.x + dc));
    w = right - x;
  }
  if (edges.s) h = Math.max(1, start.h + dr);
  if (edges.n) {
    const bottom = start.y + start.h;
    y = Math.max(0, Math.min(bottom - 1, start.y + dr));
    h = bottom - y;
  }
  return { x: toEighth(x), y, w: toEighth(w), h };
}

/** The slot a node has on this device (the mobile layout falls back to the desktop slot, clamped). */
export function slotOn(node: ComponentNode, device: Device, desktopCols = 12): GridSlot | undefined {
  if (device === "mobile") {
    const m = node.responsive?.mobile?.slot;
    if (m) return m;
    if (!node.slot) return undefined;
    return { x: 0, y: node.slot.y, w: Math.min(4, Math.max(1, Math.round((node.slot.w / desktopCols) * 4))), h: node.slot.h };
  }
  return node.slot;
}

/** The op that sets a node's slot on a device: desktop moves the node; mobile edits only its phone layout. */
export function slotOp(doc: AppDocument, nodeId: string, slot: GridSlot, device: Device): DraftOp | null {
  const at = findNode(doc, nodeId);
  if (!at || !at.parent) return null;
  if (device === "mobile") return { op: "node.update", nodeId, patch: { responsive: { mobile: { slot } } } };
  return { op: "node.move", nodeId, parentId: at.parent.id, index: at.index, slot };
}

/** A copy of a subtree with fresh ids (duplicate, insert from the catalogue). */
export function freshCopy(node: ComponentNode): ComponentNode {
  const c = clone(node);
  const walk = (n: ComponentNode) => {
    n.id = newId("c");
    for (const k of n.children ?? []) walk(k);
  };
  walk(c);
  return c;
}

export type KeyAction =
  | { kind: "ops"; ops: DraftOp[]; announce: string; select?: string }
  | { kind: "select"; nodeId: string; announce: string }
  | { kind: "undo" }
  | { kind: "redo" }
  | null;

export type KeyInput = { key: string; shift: boolean; alt: boolean; mod: boolean };

function describe(node: ComponentNode, s: GridSlot | undefined): string {
  return s ? `${nodeLabel(node)}: column ${s.x + 1}, row ${s.y + 1}, ${s.w} wide, ${s.h} tall` : nodeLabel(node);
}
export { describe as describeSlot };

/** What a key does to the selected node (design v4 section 6). Returns null when the key is not a shortcut. */
export function keyAction(doc: AppDocument, selectedId: string | null, k: KeyInput, device: Device, opts: { step?: number } = {}): KeyAction {
  const lower = k.key.toLowerCase();
  if (k.mod && lower === "z") return k.shift ? { kind: "redo" } : { kind: "undo" };
  if (k.mod && lower === "y") return { kind: "redo" };
  if (!selectedId) return null;
  const at = findNode(doc, selectedId);
  if (!at) return null;
  const node = at.node;
  const cols = columnsOn(at.parent, device);
  const step = opts.step ?? 1;
  if (k.key === "Escape") return at.parent ? { kind: "select", nodeId: at.parent.id, announce: `Selected ${nodeLabel(at.parent)}` } : null;
  if (k.key === "Enter") {
    const first = node.children?.[0];
    return first ? { kind: "select", nodeId: first.id, announce: `Selected ${nodeLabel(first)}` } : null;
  }
  if (k.mod && lower === "d") {
    // The copy goes beside the original in the nearest free spot (spec 3.2), never under another widget.
    const dup = duplicateOps(doc, node.id);
    if (!dup) return null;
    return { kind: "ops", ops: dup.ops, announce: `Duplicated ${nodeLabel(node)} beside it`, select: dup.copyId };
  }
  if (k.key === "Delete" || k.key === "Backspace") {
    if (!at.parent) return null;
    return { kind: "ops", ops: [{ op: "node.remove", nodeId: node.id }], announce: `Removed ${nodeLabel(node)}`, select: at.parent.id };
  }
  if (k.alt && (k.key === "ArrowUp" || k.key === "ArrowDown")) {
    if (!at.parent) return null;
    const siblings = at.parent.children ?? [];
    const to = at.index + (k.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= siblings.length) return null;
    return { kind: "ops", ops: [{ op: "node.move", nodeId: node.id, parentId: at.parent.id, index: to }], announce: `${nodeLabel(node)} moved to position ${to + 1} of ${siblings.length}` };
  }
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = arrows[k.key];
  if (!d || !at.parent) return null;
  const cur = slotOn(node, device, gridColumns(at.parent));
  if (!cur) return null;
  // Arrows move by one snap step (a column) or, with snapping off, one fine step (an eighth of a column).
  const dx = d[0] * step;
  let next: GridSlot;
  if (k.shift) next = { ...cur, w: toEighth(Math.max(step, Math.min(cols - cur.x, cur.w + dx))), h: Math.max(1, cur.h + d[1]) };
  else next = { ...cur, x: toEighth(Math.max(0, Math.min(cols - cur.w, cur.x + dx))), y: Math.max(0, cur.y + d[1]) };
  if (next.x === cur.x && next.y === cur.y && next.w === cur.w && next.h === cur.h) return null;
  const op = slotOp(doc, node.id, next, device);
  return op ? { kind: "ops", ops: [op], announce: describe(node, next) } : null;
}

// ---- Gauntlet w2-r2 item 16: no dead bands from drops and deletions ----

/** The first free row under a grid's children on a device (0 for an empty grid), leaving one node out. */
export function bottomRow(grid: ComponentNode, device: Device, exceptId?: string): number {
  return (grid.children ?? []).filter((k) => k.id !== exceptId).reduce((m, k) => {
    const s = slotOn(k, device);
    return s ? Math.max(m, s.y + s.h) : m;
  }, 0);
}

/**
 * A drop at or below the content's last row snaps to the next free row at the left column, so a loose
 * drop never leaves an empty band above it. Holding Alt (a deliberate placement) keeps the cell.
 */
export function snapDrop(slot: GridSlot, grid: ComponentNode, device: Device, opts: { exceptId?: string; deliberate?: boolean } = {}): GridSlot {
  if (opts.deliberate) return slot;
  const bottom = bottomRow(grid, device, opts.exceptId);
  return slot.y >= bottom ? { ...slot, x: 0, y: bottom } : slot;
}

/**
 * The ops that close the band a removed node leaves in its grid: rows it covered that nothing else
 * covers, when they end where the next component starts, are taken out by moving every component below
 * them up. Desktop slots move with `node.move`; explicit phone slots with `node.update`.
 */
export function closeGapOps(doc: AppDocument, removedId: string): DraftOp[] {
  const at = findNode(doc, removedId);
  if (!at?.parent || at.parent.type !== "grid") return [];
  const grid = at.parent;
  const out: DraftOp[] = [];
  for (const device of ["desktop", "mobile"] as const) {
    if (device === "mobile" && !at.node.responsive?.mobile?.slot) continue;
    const gone = slotOn(at.node, device);
    if (!gone) continue;
    const rest = (grid.children ?? []).filter((k) => k.id !== removedId && (device === "desktop" || k.responsive?.mobile?.slot));
    const covered = (row: number) => rest.some((k) => { const s = slotOn(k, device); return !!s && s.y <= row && row < s.y + s.h; });
    // The uncovered rows inside the removed slot, as one block at its bottom edge.
    let a = gone.y + gone.h;
    while (a > gone.y && !covered(a - 1)) a--;
    const b = gone.y + gone.h;
    const band = b - a;
    if (band <= 0) continue;
    const below = rest.filter((k) => (slotOn(k, device)?.y ?? -1) >= b);
    if (!below.length) continue;
    for (const k of below) {
      const s = slotOn(k, device)!;
      const moved = { ...s, y: s.y - band };
      if (device === "desktop") out.push({ op: "node.move", nodeId: k.id, parentId: grid.id, index: (grid.children ?? []).filter((c) => c.id !== removedId).findIndex((c) => c.id === k.id), slot: moved });
      else out.push({ op: "node.update", nodeId: k.id, patch: { responsive: { mobile: { slot: moved } } } });
    }
  }
  return out;
}

/** A batch with every grid gap its removals leave closed (not when the batch puts something back there). */
export function withGapsClosed(doc: AppDocument, ops: DraftOp[]): DraftOp[] {
  const removes = ops.filter((o): o is Extract<DraftOp, { op: "node.remove" }> => o.op === "node.remove");
  if (!removes.length) return ops;
  const refills = new Set(ops.flatMap((o) => (o.op === "node.add" || o.op === "node.move" ? [o.parentId] : [])));
  const extra: DraftOp[] = [];
  for (const r of removes) {
    const parent = findNode(doc, r.nodeId)?.parent;
    if (!parent || refills.has(parent.id)) continue;
    extra.push(...closeGapOps(doc, r.nodeId));
  }
  return extra.length ? [...ops, ...extra] : ops;
}

// ---- Fit to content (operator, 2026-10-19): apps laid out before exact boxes ----

/**
 * The ops that grow components in one grid by whole rows so their content fits, top to bottom: each grown
 * component pushes every sibling that starts at or below its old bottom edge down by the same rows, so
 * nothing overlaps and rows stay aligned. `grow` maps node ids to the rows each needs. One batch, so one
 * undo puts everything back.
 */
export function fitOps(doc: AppDocument, gridId: string, grow: Record<string, number>, device: Device): DraftOp[] {
  const grid = findNode(doc, gridId)?.node;
  if (!grid || grid.type !== "grid") return [];
  const kids = (grid.children ?? []).flatMap((k) => { const s = slotOn(k, device); return s ? [{ id: k.id, start: s, cur: { ...s } }] : []; });
  const order = kids.filter((k) => (grow[k.id] ?? 0) > 0).sort((a, b) => a.start.y - b.start.y || a.start.x - b.start.x);
  for (const k of order) {
    const g = Math.ceil(grow[k.id]!);
    const bottom = k.cur.y + k.cur.h;
    k.cur.h += g;
    for (const o of kids) if (o !== k && o.cur.y >= bottom) o.cur.y += g;
  }
  return kids.flatMap((k) => (k.cur.y !== k.start.y || k.cur.h !== k.start.h ? [slotOp(doc, k.id, k.cur, device)!].filter(Boolean) : []));
}

// ---- Grid columns (A7.4): 6, 12 or 24 desktop columns, slots in eighths of a column ----

/** The fine step: slots' x and w are multiples of an eighth of a column (A7.4). */
export const FINE = 0.125;

/** A number rounded to the nearest eighth (floating error from rescaling never reaches a stored slot). */
export function toEighth(n: number): number {
  return Math.round(n / FINE) * FINE;
}

/** A grid's desktop column count (6, 12 or 24; anything else reads as the default 12). */
export function gridColumns(grid: ComponentNode | null | undefined): 6 | 12 | 24 {
  const c = grid?.props?.columns;
  return c === 6 || c === 24 ? c : 12;
}

/** The column count of a grid on a device: phones are always 4 (A7.4). */
export function columnsOn(grid: ComponentNode | null | undefined, device: Device): number {
  return device === "mobile" ? COLUMNS.mobile : gridColumns(grid);
}

/**
 * The ops that change a grid's column count without moving anything (A7.4): one node.update setting the
 * `columns` prop, then one node.move per direct child with a desktop slot, its x and w rescaled by
 * new/old and rounded to an eighth of a column. Rows and phone slots are untouched. Empty when nothing
 * changes. One batch, so one undo puts it back.
 */
export function columnsChangeOps(doc: AppDocument, gridId: string, columns: 6 | 12 | 24): DraftOp[] {
  const at = findNode(doc, gridId);
  const grid = at?.node;
  if (!grid || grid.type !== "grid") return [];
  const old = gridColumns(grid);
  if (old === columns && grid.props?.columns === columns) return [];
  const ops: DraftOp[] = [{ op: "node.update", nodeId: grid.id, patch: { props: { columns } } }];
  if (old === columns) return ops;
  const f = columns / old;
  (grid.children ?? []).forEach((k, index) => {
    if (!k.slot) return;
    const w = Math.max(FINE, Math.min(columns, toEighth(k.slot.w * f)));
    const x = Math.max(0, Math.min(columns - w, toEighth(k.slot.x * f)));
    ops.push({ op: "node.move", nodeId: k.id, parentId: grid.id, index, slot: { x, y: k.slot.y, w, h: k.slot.h } });
  });
  return ops;
}

// ---- Alignment guides (spec 3.5, snapping off) ----

/** A slot-shaped box in grid units: x and w in columns, y and h in rows. */
export type UnitBox = { x: number; y: number; w: number; h: number };
/** One guide line: a vertical line at column `at` (axis x) or a horizontal one at row `at` (axis y). */
export type Guide = { axis: "x" | "y"; at: number; kind: "start" | "centre" | "end"; page?: boolean };

/**
 * Pulls a moving box into line with the other boxes' edges and centres, and the grid's centre, when it is
 * within `pull` grid units (6px converted by the caller) on each axis. Returns the adjusted box (x in
 * eighths of a column, y in whole rows) and the guides it lines up on. Pure.
 */
export function alignGuides(moving: UnitBox, others: UnitBox[], cols: number, pull: { x: number; y: number }): { box: UnitBox; guides: Guide[] } {
  const xs = (b: UnitBox) => [b.x, b.x + b.w / 2, b.x + b.w] as const;
  const ys = (b: UnitBox) => [b.y, b.y + b.h / 2, b.y + b.h] as const;
  const kinds = ["start", "centre", "end"] as const;
  const targetsX: { at: number; page?: boolean }[] = [{ at: cols / 2, page: true }, ...others.flatMap((o) => xs(o).map((at) => ({ at })))];
  const targetsY = others.flatMap((o) => ys(o).map((at) => ({ at })));
  const best = (mine: readonly number[], targets: { at: number; page?: boolean }[], limit: number) => {
    let pick: { d: number; at: number; kind: (typeof kinds)[number]; page?: boolean } | null = null;
    mine.forEach((m, i) => {
      for (const t of targets) {
        const d = t.at - m;
        if (Math.abs(d) <= limit && (!pick || Math.abs(d) < Math.abs(pick.d))) pick = { d, at: t.at, kind: kinds[i]!, ...(t.page ? { page: true } : {}) };
      }
    });
    return pick as { d: number; at: number; kind: (typeof kinds)[number]; page?: boolean } | null;
  };
  const bx = best(xs(moving), targetsX, pull.x);
  const by = best(ys(moving), targetsY, pull.y);
  const box = { ...moving };
  if (bx) box.x = Math.max(0, Math.min(cols - box.w, toEighth(moving.x + bx.d)));
  if (by) box.y = Math.max(0, Math.round(moving.y + by.d));
  const guides: Guide[] = [];
  // A guide shows only when the box really lines up after rounding to the fine grid.
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;
  for (const [i, v] of xs(box).entries()) for (const t of targetsX) if (near(v, t.at, FINE / 2) && !guides.some((g) => g.axis === "x" && near(g.at, t.at, 1e-6))) guides.push({ axis: "x", at: t.at, kind: kinds[i]!, ...(t.page ? { page: true } : {}) });
  for (const [i, v] of ys(box).entries()) for (const t of targetsY) if (near(v, t.at, 0.5) && !guides.some((g) => g.axis === "y" && near(g.at, t.at, 1e-6))) guides.push({ axis: "y", at: t.at, kind: kinds[i]! });
  return { box, guides };
}

// ---- Wave 2.7 placing and arranging (media layout spec 3.2, Amendment 8 A8.8) ----

const EPS = 1e-9;
/** Whether two slots share any area (touching edges do not count). */
export function overlaps(a: UnitBox, b: UnitBox): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/** The slots of a grid's children on a device, leaving some out. */
function childSlots(grid: ComponentNode, device: Device, except: ReadonlySet<string> = new Set()): { id: string; slot: GridSlot }[] {
  const cols = gridColumns(grid);
  return (grid.children ?? []).filter((k) => !except.has(k.id)).flatMap((k) => {
    const s = slotOn(k, device, cols);
    return s ? [{ id: k.id, slot: s }] : [];
  });
}

/**
 * The next free spot for a box of `size` in a grid (spec 3.2 Insert beside and Duplicate). With an anchor
 * (the selected widget): on the anchor's row, first to its right, then to its left; then below it, nearest
 * rows first. Without one: the first free spot reading from the top left, so a new widget fills a gap
 * beside others before it goes under everything. Never overlaps another child; falls back to the left
 * column under everything.
 */
export function freeSpot(grid: ComponentNode, device: Device, size: { w: number; h: number }, anchor: GridSlot | null = null, except: ReadonlySet<string> = new Set()): GridSlot {
  const cols = columnsOn(grid, device);
  const w = Math.min(cols, Math.max(FINE, toEighth(size.w)));
  const h = Math.max(1, Math.round(size.h));
  const others = childSlots(grid, device, except).map((c) => c.slot);
  const free = (x: number, y: number) => x >= -EPS && x + w <= cols + EPS && y >= 0 && !others.some((o) => overlaps({ x, y, w, h }, o));
  const xs = [...new Set([0, ...Array.from({ length: Math.floor(cols) + 1 }, (_, i) => i), ...others.map((o) => toEighth(o.x + o.w)), ...(anchor ? [toEighth(anchor.x + anchor.w), anchor.x] : [])])]
    .filter((x) => x + w <= cols + EPS)
    .sort((a, b) => a - b);
  const bottom = others.reduce((m, o) => Math.max(m, o.y + o.h), 0);
  if (anchor) {
    const right = xs.filter((x) => x >= anchor.x + anchor.w - EPS);
    const left = xs.filter((x) => x < anchor.x + anchor.w - EPS).sort((a, b) => b - a);
    for (const x of [...right, ...left]) if (free(x, anchor.y)) return { x, y: anchor.y, w, h };
    const ys = [...new Set([anchor.y + anchor.h, ...others.map((o) => o.y + o.h).filter((y) => y > anchor.y)])].sort((a, b) => a - b);
    for (const y of ys) {
      const byNear = [...xs].sort((a, b) => Math.abs(a - anchor.x) - Math.abs(b - anchor.x) || a - b);
      for (const x of byNear) if (free(x, y)) return { x, y, w, h };
    }
    return { x: 0, y: Math.max(bottom, anchor.y + anchor.h), w, h };
  }
  const ys = [...new Set([0, ...others.map((o) => o.y + o.h)])].sort((a, b) => a - b);
  for (const y of ys) for (const x of xs) if (free(x, y)) return { x, y, w, h };
  return { x: 0, y: bottom, w, h };
}

/** Width presets of a parent grid's columns, Sixth first (spec 3.2). Widths in eighths of a column. */
export function widthPresets(cols: number): { label: string; w: number }[] {
  return [
    { label: "Sixth", f: 1 / 6 },
    { label: "Quarter", f: 1 / 4 },
    { label: "Third", f: 1 / 3 },
    { label: "Half", f: 1 / 2 },
    { label: "Two thirds", f: 2 / 3 },
    { label: "Full", f: 1 },
  ].map((p) => ({ label: p.label, w: Math.max(FINE, toEighth(cols * p.f)) }));
}

/**
 * "Same as neighbour" (spec 3.2): the width of the nearest other child on the same rows, the left one
 * first; else of the nearest one above. Null when the widget has no neighbour or is not in a grid.
 */
export function neighbourWidth(doc: AppDocument, nodeId: string, device: Device): number | null {
  const at = findNode(doc, nodeId);
  if (!at?.parent || at.parent.type !== "grid") return null;
  const me = slotOn(at.node, device, gridColumns(at.parent));
  if (!me) return null;
  const others = childSlots(at.parent, device, new Set([nodeId])).map((c) => c.slot);
  const sameRow = others.filter((o) => o.y < me.y + me.h && me.y < o.y + o.h);
  const dist = (o: GridSlot) => (o.x + o.w <= me.x + EPS ? me.x - (o.x + o.w) : o.x >= me.x + me.w - EPS ? o.x - (me.x + me.w) + 0.001 : 0);
  const row = [...sameRow].sort((a, b) => dist(a) - dist(b))[0];
  if (row) return row.w;
  const above = others.filter((o) => o.y + o.h <= me.y).sort((a, b) => me.y - (a.y + a.h) - (me.y - (b.y + b.h)) || Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
  return above ? above.w : null;
}

/** Duplicate (spec 3.2): the copy goes in the nearest free spot beside the original, same row first. */
export function duplicateOps(doc: AppDocument, nodeId: string): { ops: DraftOp[]; copyId: string } | null {
  const at = findNode(doc, nodeId);
  if (!at?.parent) return null;
  const copy = freshCopy(at.node);
  if (at.parent.type === "grid") {
    const desk = slotOn(at.node, "desktop", gridColumns(at.parent));
    if (desk) copy.slot = freeSpot(at.parent, "desktop", desk, desk);
    const phone = at.node.responsive?.mobile?.slot;
    if (phone && copy.responsive?.mobile) copy.responsive = { ...copy.responsive, mobile: { ...copy.responsive.mobile, slot: freeSpot(at.parent, "mobile", phone, phone) } };
  }
  return { ops: [{ op: "node.add", parentId: at.parent.id, index: at.index + 1, node: copy }], copyId: copy.id };
}

export type AlignHow = "left" | "centre" | "right" | "top" | "middle" | "bottom";

/** The selected children of one grid with their slots (others, and nodes elsewhere, are left out). */
function selectedIn(doc: AppDocument, ids: readonly string[], device: Device): { grid: ComponentNode; items: { id: string; slot: GridSlot }[] } | null {
  const first = ids.map((id) => findNode(doc, id)).find((a) => a?.parent?.type === "grid");
  const grid = first?.parent;
  if (!grid) return null;
  const want = new Set(ids);
  const items = childSlots(grid, device).filter((c) => want.has(c.id));
  // Keep the selection's own order (the first one picked is the anchor for Same width and Same height).
  items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return { grid, items };
}

function movesFor(doc: AppDocument, next: { id: string; slot: GridSlot; before: GridSlot }[], device: Device): DraftOp[] {
  return next.flatMap((n) => (n.slot.x === n.before.x && n.slot.y === n.before.y && n.slot.w === n.before.w && n.slot.h === n.before.h ? [] : [slotOp(doc, n.id, n.slot, device)!].filter(Boolean)));
}

/** Align the selected widgets' edges or centres (spec 3.2), as one batch. */
export function alignOps(doc: AppDocument, ids: readonly string[], how: AlignHow, device: Device): DraftOp[] {
  const sel = selectedIn(doc, ids, device);
  if (!sel || sel.items.length < 2) return [];
  const cols = columnsOn(sel.grid, device);
  const s = sel.items.map((i) => i.slot);
  const minX = Math.min(...s.map((v) => v.x));
  const maxR = Math.max(...s.map((v) => v.x + v.w));
  const minY = Math.min(...s.map((v) => v.y));
  const maxB = Math.max(...s.map((v) => v.y + v.h));
  return movesFor(doc, sel.items.map(({ id, slot }) => {
    const n = { ...slot };
    if (how === "left") n.x = minX;
    if (how === "right") n.x = toEighth(maxR - slot.w);
    if (how === "centre") n.x = toEighth((minX + maxR) / 2 - slot.w / 2);
    if (how === "top") n.y = minY;
    if (how === "bottom") n.y = maxB - slot.h;
    if (how === "middle") n.y = Math.round((minY + maxB) / 2 - slot.h / 2);
    n.x = Math.max(0, Math.min(cols - n.w, n.x));
    n.y = Math.max(0, n.y);
    return { id, slot: n, before: slot };
  }), device);
}

/**
 * Distribute across or down (spec 3.2): the outermost two stay, the rest move so the gaps between
 * neighbours are equal (x in eighths of a column, y in whole rows).
 */
export function distributeOps(doc: AppDocument, ids: readonly string[], axis: "across" | "down", device: Device): DraftOp[] {
  const sel = selectedIn(doc, ids, device);
  if (!sel || sel.items.length < 3) return [];
  const x = axis === "across";
  const sorted = [...sel.items].sort((a, b) => (x ? a.slot.x - b.slot.x || a.slot.y - b.slot.y : a.slot.y - b.slot.y || a.slot.x - b.slot.x));
  const start = x ? sorted[0]!.slot.x : sorted[0]!.slot.y;
  const last = sorted[sorted.length - 1]!.slot;
  const end = x ? last.x + last.w : last.y + last.h;
  const total = sorted.reduce((m, i) => m + (x ? i.slot.w : i.slot.h), 0);
  const gap = (end - start - total) / (sorted.length - 1);
  let at = start;
  return movesFor(doc, sorted.map(({ id, slot }, i) => {
    const n = { ...slot };
    const pos = i === sorted.length - 1 ? (x ? last.x : last.y) : at;
    if (x) n.x = toEighth(pos);
    else n.y = Math.round(pos);
    at = pos + (x ? slot.w : slot.h) + gap;
    return { id, slot: n, before: slot };
  }), device);
}

/** Same width or same height as the first widget picked (spec 3.2). */
export function sameSizeOps(doc: AppDocument, ids: readonly string[], dim: "width" | "height", device: Device): DraftOp[] {
  const sel = selectedIn(doc, ids, device);
  if (!sel || sel.items.length < 2) return [];
  const cols = columnsOn(sel.grid, device);
  const a = sel.items[0]!.slot;
  return movesFor(doc, sel.items.map(({ id, slot }) => {
    const n = dim === "width" ? { ...slot, w: a.w, x: Math.max(0, Math.min(slot.x, cols - a.w)) } : { ...slot, h: a.h };
    return { id, slot: n, before: slot };
  }), device);
}

/** Moves every selected widget by the same columns and rows, kept inside the grid as a group (spec 3.2). */
export function groupMoveOps(doc: AppDocument, ids: readonly string[], dx: number, dy: number, device: Device): DraftOp[] {
  const sel = selectedIn(doc, ids, device);
  if (!sel || !sel.items.length) return [];
  const cols = columnsOn(sel.grid, device);
  const s = sel.items.map((i) => i.slot);
  const minX = Math.min(...s.map((v) => v.x));
  const maxR = Math.max(...s.map((v) => v.x + v.w));
  const minY = Math.min(...s.map((v) => v.y));
  const ddx = toEighth(Math.max(-minX, Math.min(cols - maxR, dx)));
  const ddy = Math.max(-minY, Math.round(dy));
  if (!ddx && !ddy) return [];
  return movesFor(doc, sel.items.map(({ id, slot }) => ({ id, slot: { ...slot, x: toEighth(slot.x + ddx), y: slot.y + ddy }, before: slot })), device);
}

/**
 * Duplicate several (spec 3.2): copies keep their arrangement and land beside the group (to its right
 * when there is room) or below it, in the first place where none of them covers another widget.
 */
export function groupDuplicateOps(doc: AppDocument, ids: readonly string[]): { ops: DraftOp[]; copyIds: string[] } {
  const sel = selectedIn(doc, ids, "desktop");
  if (!sel || !sel.items.length) return { ops: [], copyIds: [] };
  const cols = columnsOn(sel.grid, "desktop");
  const s = sel.items.map((i) => i.slot);
  const minX = Math.min(...s.map((v) => v.x));
  const maxR = Math.max(...s.map((v) => v.x + v.w));
  const minY = Math.min(...s.map((v) => v.y));
  const maxB = Math.max(...s.map((v) => v.y + v.h));
  const others = childSlots(sel.grid, "desktop").map((c) => c.slot);
  const fits = (dx: number, dy: number) => s.every((v) => v.x + dx >= -EPS && v.x + v.w + dx <= cols + EPS && !others.some((o) => overlaps({ ...v, x: v.x + dx, y: v.y + dy }, o)));
  let off: [number, number] | null = maxR + (maxR - minX) <= cols + EPS && fits(maxR - minX, 0) ? [maxR - minX, 0] : null;
  if (!off) {
    const ys = [...new Set([maxB, ...others.map((o) => o.y + o.h).filter((y) => y >= maxB)])].sort((a, b) => a - b);
    for (const y of ys) if (fits(0, y - minY)) { off = [0, y - minY]; break; }
  }
  const [dx, dy] = off ?? [0, others.reduce((m, o) => Math.max(m, o.y + o.h), 0) - minY];
  const ops: DraftOp[] = [];
  const copyIds: string[] = [];
  for (const item of sel.items) {
    const at = findNode(doc, item.id)!;
    const copy = freshCopy(at.node);
    copy.slot = { ...item.slot, x: toEighth(item.slot.x + dx), y: item.slot.y + dy };
    if (copy.responsive?.mobile?.slot) copy.responsive = { ...copy.responsive, mobile: { ...copy.responsive.mobile, slot: { ...copy.responsive.mobile.slot, y: copy.responsive.mobile.slot.y + (maxB - minY) } } };
    ops.push({ op: "node.add", parentId: sel.grid.id, node: copy });
    copyIds.push(copy.id);
  }
  return { ops, copyIds };
}

/**
 * Children of a grid drawn fully under a later sibling (spec 3.2 "covered"): later children paint on top,
 * so a box entirely inside a later one's box cannot be seen or clicked. Hidden widgets cover nothing.
 */
export function coveredIds(grid: ComponentNode, device: Device): Set<string> {
  const out = new Set<string>();
  const kids = grid.children ?? [];
  const cols = gridColumns(grid);
  const hidden = (k: ComponentNode) => (device === "mobile" ? k.responsive?.mobile?.hidden === true : k.hidden === true);
  kids.forEach((k, i) => {
    const a = slotOn(k, device, cols);
    if (!a) return;
    for (let j = i + 1; j < kids.length; j++) {
      const o = kids[j]!;
      const b = slotOn(o, device, cols);
      if (!b || hidden(o)) continue;
      if (b.x <= a.x + EPS && b.y <= a.y && b.x + b.w >= a.x + a.w - EPS && b.y + b.h >= a.y + a.h) {
        out.add(k.id);
        return;
      }
    }
  });
  return out;
}

/** Every covered widget on a page, in every grid. */
export function coveredOnPage(root: ComponentNode, device: Device): Set<string> {
  const out = new Set<string>();
  const walk = (n: ComponentNode) => {
    if (n.type === "grid") for (const id of coveredIds(n, device)) out.add(id);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}
