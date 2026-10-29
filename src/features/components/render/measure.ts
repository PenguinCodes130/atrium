import { hugSlot } from "../insert";

// Round 2 (Wave 2.10a gauntlet r1 items 2, 14 and 15): which table columns a Columns list names, how much
// a table hides sideways, and the square slot for a new icon. matchColumns is isomorphic; the others read
// the layout and run in the browser only.

type Column = { key: string; label: string };

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The columns a Columns list names, in its order: each name matches a column's key exactly, then its key
 * or its header in any case and spacing ("disk (/)" is "Disk (/)"). A column is used once. Names that
 * match nothing come back in `unknown`, as typed.
 */
export function matchColumns<C extends Column>(columns: C[], names: string[]): { columns: C[]; unknown: string[] } {
  const out: C[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const n = norm(name);
    const c = columns.find((x) => x.key === name) ?? columns.find((x) => norm(x.key) === n) ?? columns.find((x) => norm(x.label ?? "") === n);
    if (!c) unknown.push(name);
    else if (!out.includes(c)) out.push(c);
  }
  return { columns: out, unknown };
}

export type TableOverflow = {
  /** Width the table hides sideways, in layout px (0 when every column shows). */
  hiddenPx: number;
  /** Columns cut or hidden at the right edge (scrolled to the start). */
  hiddenColumns: number;
  /** The width the table needs to show every column, in layout px (its scroll width). */
  neededPx: number;
  /** The width it has now, in layout px. */
  shownPx: number;
};

/** How much a table wrap (`.atr-table-wrap`) hides sideways. Browser only. */
export function tableOverflowOf(wrap: Element): TableOverflow {
  const el = wrap as HTMLElement;
  const shownPx = el.clientWidth;
  const neededPx = el.scrollWidth;
  const hiddenPx = Math.max(0, neededPx - shownPx);
  let hiddenColumns = 0;
  if (hiddenPx > 0) {
    const r = el.getBoundingClientRect();
    const zoom = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
    // The visible right edge, and each header's right edge as if scrolled to the start.
    const edge = r.left + (el.clientLeft + shownPx) * zoom + 0.5;
    for (const th of Array.from(el.querySelectorAll("thead th"))) if (th.getBoundingClientRect().right + el.scrollLeft * zoom > edge) hiddenColumns++;
  }
  return { hiddenPx, hiddenColumns, neededPx, shownPx };
}

/** Writes tableOverflowOf onto the wrap as data-overflow-x and data-hidden-columns (TableView). */
export function reportTableOverflow(wrap: HTMLElement): void {
  const o = tableOverflowOf(wrap);
  wrap.setAttribute("data-overflow-x", String(Math.round(o.hiddenPx)));
  wrap.setAttribute("data-hidden-columns", String(o.hiddenColumns));
}

/**
 * For the builder's Fit (item 14): a node's table overflow, or null when the node holds no table. Reads
 * the layout now, so it is right straight after a resize.
 */
export function measureTableOverflow(node: Element | null | undefined): TableOverflow | null {
  const wrap = node?.querySelector(".atr-table-wrap");
  return wrap ? tableOverflowOf(wrap) : null;
}

/**
 * Item 2 (square on insert): the slot that makes a new icon's box square on this grid, measured now. The
 * builder calls it on insert with the grid the icon goes into (`.atr-grid`); hugSlot does the sums.
 * Browser only.
 */
export function iconSlotIn(grid: Element, px = 48): { w: number; h: number } {
  const cs = getComputedStyle(grid);
  const colPx = parseFloat(cs.gridTemplateColumns.split(" ")[0] ?? "") || 0;
  const gapPx = parseFloat(cs.columnGap) || 0;
  const cell = grid.querySelector(":scope > .atr-cell");
  let padBottomPx = cell ? parseFloat(getComputedStyle(cell).paddingBottom) || 0 : NaN;
  if (!Number.isFinite(padBottomPx)) {
    const gap = parseFloat(cs.getPropertyValue("--theme-gap")) || 16;
    const hard = grid.closest('[data-canvas-shadow="hard"]') ? parseFloat(cs.getPropertyValue("--theme-shadow-offset")) || 0 : 0;
    padBottomPx = gap + hard;
  }
  if (colPx <= 0) return { w: 1.375, h: 10 };
  return hugSlot(px, { colPx, gapPx, padBottomPx });
}
