// How much content a component's box hides (Wave 2.10 B2 and B1; architecture A11.2). Fit and the builder's
// auto-grow both measure here, the way the CSS draws it: fractional layout boxes, not the rounded
// scrollHeight alone, so sub-pixel overflow (which still shows a scrollbar) rounds up to a whole row.
// Browser only (reads layout); the arithmetic is in `overflowPx` so it is unit-tested.

/** Grid rows are 8 px (GRID.rowPx). */
export const ROW_PX = 8;
/** Overflow at or below this is layout noise, not content (A11.2's badge threshold is 0.5 px; Fit is stricter). */
export const NOISE_PX = 0.02;

export type Extent = {
  /** The root part's box, in screen px. */
  top: number;
  height: number;
  /** The lowest content edge found inside it, in screen px (null when it has no laid-out content). */
  contentBottom: number | null;
  /** The root's bottom padding and border, in layout px. */
  padBottom: number;
  /** The root's own scrollHeight minus clientHeight (whole px, from the browser). */
  scrollOver: number;
  /** What clipping boxes inside it hide (layout px): scroll areas, clipped bodies, nested ones added in. */
  innerHidden: number;
  /** The root's scrollTop (layout px). */
  scrollTop: number;
};

/** Overflow in layout px from a measured extent; `zoom` is the canvas scale (screen px per layout px). */
export function overflowPx(e: Extent, zoom = 1): number {
  const z = zoom > 0 ? zoom : 1;
  const byBoxes = e.contentBottom === null ? 0 : (e.contentBottom - e.top) / z + e.scrollTop + e.padBottom - e.height / z;
  return Math.max(0, e.scrollOver, byBoxes) + Math.max(0, e.innerHidden);
}

/** Whole 8 px rows that hold `px` more content (0 when it fits); any real overflow rounds up. */
export function rowsFor(px: number): number {
  return px > NOISE_PX ? Math.ceil((px - NOISE_PX) / ROW_PX) : 0;
}

const CLIPS = new Set(["auto", "scroll", "hidden", "clip"]);

type Walk = { bottom: number | null; hidden: number };

/**
 * The lowest drawn edge inside `el` (screen px) and what boxes inside it that clip (a scrolling table body,
 * a group body, an overflow-hidden wrapper) hide (layout px). A clipping box counts as its own box plus
 * the content it hides, measured the same way inside it; anything else is walked into.
 */
function walk(el: Element, zoom: number): Walk {
  let bottom: number | null = null;
  let hidden = 0;
  for (const k of Array.from(el.children)) {
    const kc = getComputedStyle(k);
    if (kc.display === "none" || kc.position === "fixed") continue;
    const b = k.getBoundingClientRect();
    // display: contents and empty wrappers have no box of their own; their children still count.
    if (b.width > 0 || b.height > 0) bottom = bottom === null ? b.bottom : Math.max(bottom, b.bottom);
    // A component with its own slot in a nested grid (a stat inside a card, a card inside a repeat's copy)
    // counts as its box only: what it hides is its own to grow, and growing the box around it never shows
    // it, so counting it here grew the outer box on every pass (gauntlet w210a r3 H1, a repeat that grew
    // on each open).
    if (k.matches("[data-node]") && k.parentElement?.parentElement?.matches(".atr-grid[data-fixed-rows]")) continue;
    if (CLIPS.has(kc.overflowY)) {
      // Out-of-flow boxes (a screen-reader-only label clipped to 1 px, a badge) hide nothing a taller box
      // would show; neither do SVG viewports.
      if (kc.position !== "absolute" && k instanceof HTMLElement) hidden += hiddenIn(k, zoom);
      continue;
    }
    const w = walk(k, zoom);
    if (w.bottom !== null) bottom = bottom === null ? w.bottom : Math.max(bottom, w.bottom);
    hidden += w.hidden;
  }
  return { bottom, hidden };
}

/** What a clipping box hides (layout px): the larger of the browser's scroll overflow and its boxes. */
function hiddenIn(el: HTMLElement, zoom: number): number {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const w = walk(el, zoom);
  const inner = (r.bottom - (parseFloat(cs.borderBottomWidth) || 0) * zoom);
  const byBoxes = w.bottom === null ? 0 : (w.bottom - inner) / zoom + el.scrollTop + (parseFloat(cs.paddingBottom) || 0);
  const over = Math.max(0, el.scrollHeight - el.clientHeight, byBoxes);
  // Sub-pixel layout noise inside a box is not content; a whole hidden row is.
  return (over > NOISE_PX ? over : 0) + w.hidden;
}

/** Measures a node box (`[data-node]`): its root part and everything laid out inside it. */
export function measureExtent(node: Element): Extent | null {
  const root = (node.querySelector(':scope > [data-slot="root"]') as HTMLElement | null) ?? (node as HTMLElement);
  if (!root || typeof root.getBoundingClientRect !== "function") return null;
  const zoom = zoomOf(node);
  const r = root.getBoundingClientRect();
  const cs = getComputedStyle(root);
  const w = walk(root, zoom);
  return {
    top: r.top,
    height: r.height,
    contentBottom: w.bottom,
    padBottom: (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0),
    scrollOver: root.scrollHeight - root.clientHeight,
    innerHidden: w.hidden,
    scrollTop: root.scrollTop,
  };
}

/** The canvas scale of a node (Preview width): its drawn width over its layout width. */
export function zoomOf(node: Element): number {
  const h = node as HTMLElement;
  const w = h.offsetWidth;
  const drawn = h.getBoundingClientRect().width;
  return w > 0 && drawn > 0 ? drawn / w : 1;
}

/** Rows of 8 px a node needs to show all its content (0 when it fits). */
export function overflowRowsOf(node: Element | null | undefined): number {
  if (!node) return 0;
  const e = measureExtent(node);
  return e ? rowsFor(overflowPx(e, zoomOf(node))) : 0;
}

/**
 * Round 2 item 14: what a node hides at the side (layout px), the most any box in it that clips or scrolls
 * sideways hides (a table's columns behind a horizontal scroll), 0 when everything shows. Out-of-flow boxes
 * (screen-reader labels, badges) and one-pixel rounding are not content.
 */
export function overflowXOf(node: Element | null | undefined): number {
  if (!node) return 0;
  let worst = 0;
  for (const e of [node, ...Array.from(node.querySelectorAll("*"))] as HTMLElement[]) {
    if (!(e instanceof HTMLElement)) continue;
    const cs = getComputedStyle(e);
    if (!CLIPS.has(cs.overflowX) || cs.position === "absolute" || cs.position === "fixed" || cs.display === "none") continue;
    worst = Math.max(worst, e.scrollWidth - e.clientWidth);
  }
  return worst > 1 ? worst : 0;
}

/** Round 2 item 14: what the builder's Fit did: rows grown, widened to the row, and px hidden at the side. */
export type FitResult = { rows: number; widened: boolean; hiddenX: number; /** Columns hide, but neighbours fill the row. */ blocked?: boolean };

/** The words after a Fit: never "fits" while columns are hidden at the side. */
export function fitWords(r: FitResult, hiddenAfter: number): string {
  const side = hiddenAfter > 0 ? ` Some columns still do not fit (${Math.round(hiddenAfter)} px are cut off at the side): show fewer under Columns, or make the page wider.` : "";
  if (r.widened) return `Widened to the whole row so its columns show. Undo with Ctrl+Z.${side}`;
  if (hiddenAfter > 0) {
    const lead = r.rows ? `Grown by ${r.rows * ROW_PX} px. ` : "";
    return `${lead}Its columns do not fit its width (${Math.round(hiddenAfter)} px are cut off at the side). ${r.blocked ? "Move what sits beside it, or show fewer columns under Columns." : "Show fewer columns under Columns, or make the page wider."}`;
  }
  return r.rows ? `Grown by ${r.rows * ROW_PX} px or more, to hold all its content. Anything below moved down. Undo with Ctrl+Z.` : "It already shows all its content.";
}

