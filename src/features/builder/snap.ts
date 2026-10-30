// One snapping model (Wave 2.10b F7; architecture A11.7, design v4 Note 2 "Alignment guides"). With Snap
// on, a drag or resize is pulled within 6 screen px to the other widgets' edges and centres in the same
// grid, the page centre, matching gaps (equal spacing) and the grid's column lines, guides first. Results
// are A7.4 slots: x and w in eighths of a column, y and h in whole rows. Pure: no DOM. The caller converts
// 6 px into grid units and draws what comes back (red guide lines, spacing marks, a distance readout).
import { FINE, toEighth, type Guide, type UnitBox } from "./geometry";

/** Pull distance in screen px (spec F7). */
export const SNAP_PULL_PX = 6;

/** One equal-spacing mark: a gap of `size` units on `axis`, from `from` to `to`, drawn across at `cross`. */
export type SpacingMark = { axis: "x" | "y"; from: number; to: number; cross: number; size: number };

export type SnapResult = {
  box: UnitBox;
  /** Lines the box now sits on: widget edges and centres, or the page centre (columns draw no line). */
  guides: Guide[];
  /** Two or more marks when the box's gap to a neighbour equals a gap already between two others. */
  spacing: SpacingMark[];
  /** Which axes were pulled, and by what. */
  pulled: { x: "guide" | "spacing" | "column" | null; y: "guide" | "spacing" | null };
};

type Pick = { d: number; kind: "guide" | "spacing" | "column" };
const EPS = 1e-6;
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > EPS;

/** The gaps between neighbours on one axis, among boxes that overlap `band` on the other axis. */
function gapsOn(axis: "x" | "y", others: UnitBox[], band: UnitBox): { a: UnitBox; b: UnitBox; size: number }[] {
  const along = (o: UnitBox) => (axis === "x" ? [o.x, o.x + o.w] : [o.y, o.y + o.h]) as [number, number];
  const across = (o: UnitBox) => (axis === "x" ? [o.y, o.y + o.h] : [o.x, o.x + o.w]) as [number, number];
  const [c0, c1] = across(band);
  const row = others.filter((o) => { const [o0, o1] = across(o); return overlap(o0, o1, c0, c1); }).sort((p, q) => along(p)[0] - along(q)[0]);
  const out: { a: UnitBox; b: UnitBox; size: number }[] = [];
  for (let i = 0; i + 1 < row.length; i++) {
    const g = along(row[i + 1]!)[0] - along(row[i]!)[1];
    if (g > EPS) out.push({ a: row[i]!, b: row[i + 1]!, size: g });
  }
  return out;
}

/** Positions on one axis where the moving box would repeat an existing gap beside a neighbour. */
function spacingTargets(axis: "x" | "y", moving: UnitBox, others: UnitBox[]): number[] {
  const gaps = gapsOn(axis, others, moving);
  if (!gaps.length) return [];
  const size = axis === "x" ? moving.w : moving.h;
  const across = (o: UnitBox) => (axis === "x" ? [o.y, o.y + o.h] : [o.x, o.x + o.w]) as [number, number];
  const [c0, c1] = across(moving);
  const near = others.filter((o) => { const [o0, o1] = across(o); return overlap(o0, o1, c0, c1); });
  const out: number[] = [];
  for (const g of gaps) for (const o of near) {
    const start = axis === "x" ? o.x : o.y;
    const end = axis === "x" ? o.x + o.w : o.y + o.h;
    out.push(end + g.size, start - g.size - size);
  }
  return out;
}

/** The smallest pull on one axis: guide targets first (ties go to guides), then spacing, then columns. */
function bestPull(mine: readonly number[], guides: number[], spacing: number[], startAt: number, columns: number[], limit: number): Pick | null {
  let pick: Pick | null = null;
  const consider = (d: number, kind: Pick["kind"]) => { if (Math.abs(d) <= limit + EPS && (!pick || Math.abs(d) < Math.abs(pick.d) - EPS)) pick = { d, kind }; };
  for (const m of mine) for (const t of guides) consider(t - m, "guide");
  for (const t of spacing) consider(t - startAt, "spacing");
  if (pick) return pick;
  for (const m of [mine[0]!, mine[2]!]) for (const t of columns) consider(t - m, "column");
  return pick;
}

/**
 * Snaps a box given in raw (unrounded) grid units. `pull` is 6 px in grid units per axis; `cols` is the
 * grid's column count. Columns pull only on x (rows are already 8 px). Off-grid values are rounded at the
 * end: x to an eighth of a column, y to a whole row, both kept inside the grid.
 */
export function smartSnap(moving: UnitBox, others: UnitBox[], cols: number, pull: { x: number; y: number }, opts: { columns?: boolean } = {}): SnapResult {
  const xs = (b: UnitBox) => [b.x, b.x + b.w / 2, b.x + b.w] as const;
  const ys = (b: UnitBox) => [b.y, b.y + b.h / 2, b.y + b.h] as const;
  const gx = [cols / 2, ...others.flatMap((o) => xs(o))];
  const gy = others.flatMap((o) => ys(o));
  const colLines = opts.columns === false ? [] : Array.from({ length: cols + 1 }, (_, i) => i);
  const px = bestPull(xs(moving), gx, spacingTargets("x", moving, others), moving.x, colLines, pull.x);
  const py = bestPull(ys(moving), gy, spacingTargets("y", moving, others), moving.y, [], pull.y);
  const box = { ...moving };
  box.x = Math.max(0, Math.min(cols - box.w, toEighth(Math.round((moving.x + (px?.d ?? 0)) / FINE) * FINE)));
  box.y = Math.max(0, Math.round(moving.y + (py?.d ?? 0)));
  return { box, guides: guidesFor(box, others, cols), spacing: spacingFor(box, others), pulled: { x: px?.kind ?? null, y: py && py.kind !== "column" ? py.kind : null } };
}

/** The guide lines a placed box sits on (widget edges and centres, the page centre). */
export function guidesFor(box: UnitBox, others: UnitBox[], cols: number): Guide[] {
  const kinds = ["start", "centre", "end"] as const;
  const xs = [box.x, box.x + box.w / 2, box.x + box.w];
  const ys = [box.y, box.y + box.h / 2, box.y + box.h];
  const tx: { at: number; page?: boolean }[] = [{ at: cols / 2, page: true }, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w].map((at) => ({ at })))];
  const ty = others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h].map((at) => ({ at })));
  const out: Guide[] = [];
  xs.forEach((v, i) => { for (const t of tx) if (Math.abs(v - t.at) <= FINE / 2 - EPS && !out.some((g) => g.axis === "x" && Math.abs(g.at - t.at) < EPS)) out.push({ axis: "x", at: t.at, kind: kinds[i]!, ...(t.page ? { page: true } : {}) }); });
  ys.forEach((v, i) => { for (const t of ty) if (Math.abs(v - t.at) < 0.5 && !out.some((g) => g.axis === "y" && Math.abs(g.at - t.at) < EPS)) out.push({ axis: "y", at: t.at, kind: kinds[i]! }); });
  return out;
}

/** Spacing marks: the box's gap to a neighbour on its row (or column) and every equal gap beside it. */
export function spacingFor(box: UnitBox, others: UnitBox[]): SpacingMark[] {
  const out: SpacingMark[] = [];
  for (const axis of ["x", "y"] as const) {
    const all = gapsOn(axis, [...others, box], box);
    const mine = all.filter((g) => g.a === box || g.b === box);
    for (const m of mine) {
      const same = all.filter((g) => g !== m && Math.abs(g.size - m.size) < EPS);
      if (!same.length) continue;
      for (const g of [m, ...same]) {
        if (out.some((o) => o.axis === axis && Math.abs(o.from - (axis === "x" ? g.a.x + g.a.w : g.a.y + g.a.h)) < EPS)) continue;
        const from = axis === "x" ? g.a.x + g.a.w : g.a.y + g.a.h;
        const lo = axis === "x" ? Math.max(g.a.y, g.b.y) : Math.max(g.a.x, g.b.x);
        const hi = axis === "x" ? Math.min(g.a.y + g.a.h, g.b.y + g.b.h) : Math.min(g.a.x + g.a.w, g.b.x + g.b.w);
        out.push({ axis, from, to: from + g.size, cross: (lo + hi) / 2, size: g.size });
      }
    }
  }
  return out;
}

/** Pixel rectangles a readout and marks use: the ones `slotRect` gives, as plain boxes. */
export type PxRect = { left: number; top: number; width: number; height: number };

/**
 * The gap in px from a box to its nearest neighbour (spec F7 readout). Neighbours that share a row band
 * (or column band) give a straight gap; with none, the nearest corner gap on the larger axis. Null when
 * the grid has nothing else. `pad` is the cell's bottom padding, outside the drawn component.
 */
export function nearestGapPx(me: PxRect, others: PxRect[], pad = 0): { px: number; axis: "x" | "y" } | null {
  let best: { px: number; axis: "x" | "y" } | null = null;
  const bottom = (r: PxRect) => r.top + r.height - pad;
  for (const o of others) {
    const vOverlap = overlap(me.top, bottom(me), o.top, bottom(o));
    const hOverlap = overlap(me.left, me.left + me.width, o.left, o.left + o.width);
    const dx = Math.max(o.left - (me.left + me.width), me.left - (o.left + o.width));
    const dy = Math.max(o.top - bottom(me), me.top - bottom(o));
    if (vOverlap && hOverlap) return { px: 0, axis: "x" };
    const cand = vOverlap ? { px: Math.max(0, dx), axis: "x" as const } : hOverlap ? { px: Math.max(0, dy), axis: "y" as const } : dx > dy ? { px: dx, axis: "x" as const } : { px: dy, axis: "y" as const };
    if (!best || cand.px < best.px) best = cand;
  }
  return best ? { px: Math.round(best.px), axis: best.axis } : null;
}
