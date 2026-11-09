"use client";
// Wave 2.10c N1 (architecture A11.2, A11.3): the no-scroll policy's two browser pieces.
//
// ScrollChrome: a scrolling kind (table, list, repeat; sizing "scroll") keeps its root a native scroll
// container (keyboard, wheel, touch and assistive technology unchanged) with the browser scrollbar hidden
// (components.css), and gets
//   - Focus to scroll (`focusScroll`, default "click"): until the widget is engaged by a click, a tap or
//     keyboard focus, its root does not take the wheel or touch (overflow hidden), so they scroll the page;
//     Esc or a click outside releases it; the engaged widget shows a 1px accent ring. "hover" engages while
//     the pointer is over it; "off" always scrolls. Arrow, Page, Home, End and Space keys scroll it while it
//     has focus in every mode.
//   - an Atrium-drawn thumb from --theme-scrollbar-thumb and --theme-scrollbar-width, hidden at rest, shown
//     on hover, focus-within and for 800 ms after scrolling, which can be dragged like a native one.
// CutBadge: in edit mode, a box that is not a scrolling kind and is too small for its content shows
// "Content is cut · Fit" (A11.2: more than 0.5 px). Fit asks the builder through FIT_EVENT.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type FocusScroll = "click" | "hover" | "off";
export const FOCUS_SCROLL_DEFAULT: FocusScroll = "click";
/** How long the thumb stays after the last scroll (A11.3). */
export const THUMB_LINGER_MS = 800;
/** A11.2: content past the box by more than this is cut. */
export const CUT_THRESHOLD_PX = 0.5;
/** The badge's Fit: the builder listens for this window event (detail { nodeId }) and fits that node. */
export const FIT_EVENT = "atrium:fit-node";

export function focusScrollOf(v: unknown): FocusScroll {
  return v === "hover" || v === "off" ? v : FOCUS_SCROLL_DEFAULT;
}

/** The thumb's place and length inside a track of `client` px (pure, unit-tested). Null when nothing scrolls. */
export function thumbGeometry(scrollTop: number, scrollHeight: number, clientHeight: number, minPx = 24): { top: number; height: number } | null {
  if (!(clientHeight > 0) || scrollHeight - clientHeight <= 1) return null;
  const height = Math.min(clientHeight, Math.max(minPx, (clientHeight * clientHeight) / scrollHeight));
  const room = clientHeight - height;
  const max = scrollHeight - clientHeight;
  const top = max > 0 ? (Math.min(max, Math.max(0, scrollTop)) / max) * room : 0;
  return { top, height };
}

/** The scroll a key asks for, in px (null for keys that do not scroll). Pure, unit-tested. */
export function keyScroll(key: string, shift: boolean, clientHeight: number, scrollHeight: number): { by?: number; to?: number } | null {
  const page = Math.max(40, clientHeight * 0.9);
  switch (key) {
    case "ArrowDown": return { by: 40 };
    case "ArrowUp": return { by: -40 };
    case "PageDown": return { by: page };
    case "PageUp": return { by: -page };
    case " ": return { by: shift ? -page : page };
    case "Home": return { to: 0 };
    case "End": return { to: scrollHeight };
    default: return null;
  }
}

const TYPING = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

export function ScrollChrome({ mode, label }: { mode: FocusScroll; label?: string }) {
  const thumbRef = useRef<HTMLSpanElement>(null);
  const [geo, setGeo] = useState<{ top: number; height: number; offset: number } | null>(null);
  const [scrolling, setScrolling] = useState(false);
  // Round 2 (item 13): rows hidden below or above, for the edge fade and the rest cue.
  const [hidden, setHidden] = useState(0);
  // Item 13: the root element changes when rows arrive (a Repeat first draws "Nothing to show"), so the
  // chrome follows the box's current root, not the one it saw first (its thumb never showed).
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const box = thumbRef.current?.parentElement;
    if (!box) return;
    const pick = () => setRootEl(box.querySelector<HTMLElement>(':scope > [data-slot="root"]'));
    pick();
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(pick);
    mo.observe(box, { childList: true });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const thumb = thumbRef.current;
    const box = thumb?.parentElement;
    const root = rootEl;
    if (!thumb || !box || !root || root.parentElement !== box) return;
    let engaged = mode === "off";
    let linger: ReturnType<typeof setTimeout> | undefined;
    // The box that scrolls: the root itself, or the part inside it that holds the rows (a table's body).
    let port: HTMLElement = root;
    box.setAttribute("data-focus-scroll", mode);
    const setEngaged = (on: boolean) => {
      engaged = mode === "off" ? true : on;
      if (engaged && mode !== "off") box.setAttribute("data-scroll-engaged", "");
      else box.removeAttribute("data-scroll-engaged");
    };
    setEngaged(engaged);
    const onScroll = () => {
      measure();
      setScrolling(true);
      if (linger) clearTimeout(linger);
      linger = setTimeout(() => setScrolling(false), THUMB_LINGER_MS);
    };
    const choosePort = () => {
      const over = (el: HTMLElement) => el.scrollHeight - el.clientHeight > 1 && !/^(visible|clip)$/.test(getComputedStyle(el).overflowY);
      let next: HTMLElement = root;
      if (!over(root)) {
        const inner = Array.from(root.querySelectorAll<HTMLElement>("*")).find((el) => el.closest("[data-node]") === box && over(el));
        if (inner) next = inner;
      }
      if (next === port && port.hasAttribute("data-scroll-port")) return;
      port.removeEventListener("scroll", onScroll);
      port.removeAttribute("data-scroll-port");
      port.removeAttribute("data-more-below");
      port.removeAttribute("data-more-above");
      port.removeAttribute("data-table-port");
      port = next;
      port.setAttribute("data-scroll-port", "");
      if (port.querySelector(":scope > table > thead, :scope > thead")) port.setAttribute("data-table-port", "");
      port.addEventListener("scroll", onScroll, { passive: true });
    };
    const watched = new WeakSet<HTMLElement>();
    const sideways = (w: HTMLElement) => w.toggleAttribute("data-more-right", w.scrollWidth - w.clientWidth > 1 && w.scrollLeft < w.scrollWidth - w.clientWidth - 1);
    const measure = () => {
      choosePort();
      const g = thumbGeometry(port.scrollTop, port.scrollHeight, port.clientHeight);
      if (g && port.tabIndex < 0) {
        // A scroll area the keyboard can reach, named for screen readers (A11.3).
        port.tabIndex = 0;
        if (!port.getAttribute("aria-label") && !port.getAttribute("aria-labelledby") && label) port.setAttribute("aria-label", label);
      }
      const offset = port.getBoundingClientRect().top - box.getBoundingClientRect().top + (parseFloat(getComputedStyle(port).borderTopWidth) || 0);
      setGeo(g ? { ...g, offset } : null);
      // The edge fade where rows continue, kept clear of a table's pinned header (its height as a variable).
      const max = port.scrollHeight - port.clientHeight;
      const below = max > 1 && port.scrollTop < max - 1;
      const above = max > 1 && port.scrollTop > 1;
      port.toggleAttribute("data-more-below", below);
      port.toggleAttribute("data-more-above", above);
      innerFade(port, below || above);
      const head = port.hasAttribute("data-table-port") ? port.querySelector<HTMLElement>("thead") : null;
      if (head) port.style.setProperty("--atr-head-h", `${Math.round(head.getBoundingClientRect().height)}px`);
      setHidden(below || above ? Math.max(1, Math.round(max)) : 0);
      // A table wider than its box (a phone): the side that continues fades (item 20).
      for (const w of Array.from(root.querySelectorAll<HTMLElement>(".atr-table-wrap"))) {
        sideways(w);
        if (!watched.has(w)) {
          watched.add(w);
          w.addEventListener("scroll", () => sideways(w), { passive: true });
        }
      }
    };
    const onDocDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && box.contains(t)) {
        if (mode === "click") setEngaged(true);
      } else setEngaged(false);
    };
    const onFocusIn = () => { if (mode !== "off") setEngaged(true); };
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (!to || !box.contains(to)) setEngaged(mode === "hover" && box.matches(":hover"));
    };
    const onEnter = () => { if (mode === "hover") setEngaged(true); measure(); };
    const onLeave = () => { if (mode === "hover" && !box.contains(document.activeElement)) setEngaged(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (engaged && mode !== "off") { setEngaged(false); e.stopPropagation(); }
        return;
      }
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as Element | null;
      if (t && t !== port && t !== root && t.closest(TYPING)) return;
      // Engaged, the native scroll container handles keys itself; released, it is overflow hidden, so the
      // keys are applied here (A11.3: keys scroll it while focused in every mode).
      if (engaged) return;
      const s = keyScroll(e.key, e.shiftKey, port.clientHeight, port.scrollHeight);
      if (!s || port.scrollHeight - port.clientHeight <= 1) return;
      e.preventDefault();
      if (s.to !== undefined) port.scrollTop = s.to;
      else port.scrollTop += s.by!;
    };
    document.addEventListener("pointerdown", onDocDown, true);
    box.addEventListener("focusin", onFocusIn);
    box.addEventListener("focusout", onFocusOut);
    box.addEventListener("pointerenter", onEnter);
    box.addEventListener("pointerleave", onLeave);
    root.addEventListener("keydown", onKey);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    ro?.observe(root);
    for (const k of Array.from(root.children)) ro?.observe(k);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      for (const k of Array.from(root.children)) ro?.observe(k);
      measure();
    });
    mo?.observe(root, { childList: true, subtree: true });
    measure();
    return () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      port.removeEventListener("scroll", onScroll);
      port.removeAttribute("data-scroll-port");
      box.removeEventListener("focusin", onFocusIn);
      box.removeEventListener("focusout", onFocusOut);
      box.removeEventListener("pointerenter", onEnter);
      box.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("keydown", onKey);
      ro?.disconnect();
      mo?.disconnect();
      if (linger) clearTimeout(linger);
      box.removeAttribute("data-scroll-engaged");
      box.removeAttribute("data-focus-scroll");
    };
  }, [mode, label, rootEl]);

  // Dragging the drawn thumb scrolls like a native one.
  const onThumbDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    const box = thumbRef.current?.parentElement;
    const root = box?.querySelector<HTMLElement>("[data-scroll-port]") ?? box?.querySelector<HTMLElement>(':scope > [data-slot="root"]');
    if (!root || !geo) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const start = root.scrollTop;
    const room = root.clientHeight - geo.height;
    const max = root.scrollHeight - root.clientHeight;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => { root.scrollTop = start + (room > 0 ? ((ev.clientY - startY) / room) * max : 0); };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <>
    <span
      ref={thumbRef}
      aria-hidden
      className="atr-scroll-thumb"
      data-scroll-thumb
      data-overflow={geo ? "" : undefined}
      data-scrolling={scrolling ? "" : undefined}
      style={geo ? { top: geo.offset + geo.top, height: geo.height } : undefined}
      onPointerDown={onThumbDown}
    />
    {/* At rest, a widget with hidden rows says how to reach them (item 13); gone once it is engaged. */}
    <span aria-hidden className="atr-scroll-cue" data-scroll-cue data-mode={mode} hidden={!hidden || mode === "off"}>
      {mode === "hover" ? "Point to scroll" : "Click to scroll"}
    </span>
    </>
  );
}

/** Whether a box draws a frame of its own (a border, a shadow or a fill): fading the box itself would dissolve it. */
function framed(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  const bw = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const fill = cs.backgroundColor && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor);
  return bw > 0 || (cs.boxShadow && cs.boxShadow !== "none") || !!fill || cs.backgroundImage !== "none";
}

/**
 * Round 3 item 8: a framed scroll box (a list's card) keeps its border, corners and shadow; the edge fade goes on
 * what scrolls inside it instead. Each child gets where the visible window starts and ends in its own px
 * (`--atr-fade-t`, `--atr-fade-b`), so its mask fades exactly at the box's inner edges (components.css).
 */
function innerFade(port: HTMLElement, on: boolean) {
  const inner = on && !port.hasAttribute("data-table-port") && framed(port);
  port.toggleAttribute("data-fade-inner", inner);
  if (!inner) return;
  const pr = port.getBoundingClientRect();
  const cs = getComputedStyle(port);
  const z = port.offsetHeight > 0 ? pr.height / port.offsetHeight || 1 : 1;
  const viewTop = pr.top + (parseFloat(cs.borderTopWidth) || 0) * z;
  const viewBottom = viewTop + port.clientHeight * z;
  for (const k of Array.from(port.children) as HTMLElement[]) {
    const kr = k.getBoundingClientRect();
    k.style.setProperty("--atr-fade-t", `${Math.round((viewTop - kr.top) / z)}px`);
    k.style.setProperty("--atr-fade-b", `${Math.round((viewBottom - kr.top) / z)}px`);
  }
}

/** The lowest edge of laid-out content inside `root` (screen px), not counting out-of-flow marks or nested grid boxes. */
function contentBottom(root: Element): number | null {
  let bottom: number | null = null;
  const walk = (el: Element) => {
    for (const k of Array.from(el.children)) {
      const cs = getComputedStyle(k);
      if (cs.display === "none" || cs.position === "absolute" || cs.position === "fixed") continue;
      const r = k.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) bottom = bottom === null ? r.bottom : Math.max(bottom, r.bottom);
      // Round 3 item 13: a drawing is one leaf. Its shapes' boxes include strokes the svg clips itself (a
      // gauge's dial circles reach past their svg), so walking into it would call a whole gauge cut.
      if (k.tagName.toLowerCase() === "svg") continue;
      // A nested component in a fixed-row grid owns its own box (its own badge says when it is cut).
      if (k.matches("[data-node]") && k.parentElement?.parentElement?.matches(".atr-grid[data-fixed-rows]")) continue;
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") continue;
      walk(k);
    }
  };
  walk(root);
  return bottom;
}

/**
 * Round 3 item 1: what a roulette needs, in layout px: the slot in front at its own natural size (a child scaled
 * down to fit its slot is measured unscaled: offsetHeight ignores transforms), plus the turn controls, the gap
 * between them and the root's padding and border; the same sum as the builder's `rouletteNeedPx`. The turned
 * faces never count (they reach past the box in 3D by design). Null when there is no slot in front.
 */
export function rouletteNeedLayoutPx(node: Element): number | null {
  const root = node.querySelector(':scope > [data-slot="root"]') as HTMLElement | null;
  const front = root?.querySelector('[data-roulette-drum] > [data-face]:not([aria-hidden="true"]) [data-node]') as HTMLElement | null;
  if (!root || !front) return null;
  const slot = front.offsetHeight + contentCutPx(front);
  const controls = root.querySelector(":scope > .atr-roulette-controls") as HTMLElement | null;
  const cs = getComputedStyle(root);
  const gap = parseFloat(cs.rowGap) || 0;
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  return slot + (controls ? controls.offsetHeight + gap : 0) + pad;
}

/** How many layout px of content a node box hides below its root (0 when everything shows). Browser only. */
export function contentCutPx(node: Element | null | undefined): number {
  if (!node) return 0;
  if (node.matches('[data-type="roulette"]')) {
    const need = rouletteNeedLayoutPx(node);
    return need === null ? 0 : Math.max(0, need - (node as HTMLElement).offsetHeight);
  }
  const root = node.querySelector(':scope > [data-slot="root"]') ?? node;
  const r = root.getBoundingClientRect();
  const h = node as HTMLElement;
  const zoom = h.offsetWidth > 0 ? r.width / Math.max(1, (root as HTMLElement).offsetWidth || h.offsetWidth) || 1 : 1;
  const cs = getComputedStyle(root);
  let b = contentBottom(root);
  // Text straight inside the root (a text block's lines) has no element box: a range over it does.
  if (typeof document !== "undefined" && typeof document.createRange === "function") {
    const range = document.createRange();
    for (const t of Array.from(root.childNodes)) {
      if (t.nodeType !== 3 || !t.textContent?.trim()) continue;
      range.selectNodeContents(t);
      const tb = range.getBoundingClientRect().bottom;
      if (tb) b = b === null ? tb : Math.max(b, tb);
    }
  }
  const inner = r.bottom - ((parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0)) * zoom;
  const byBoxes = b === null ? 0 : (b - inner) / (zoom || 1);
  return Math.max(0, byBoxes);
}

/** Where the badge sits, in the cell's px: just under the box, clear of its resize handles (item 12). */
export const BADGE_GAP_PX = 12;
export const BADGE_INSET_PX = 14;
/** Below this box width the badge says "Cut · Fit", so it stays whole beside a small box. */
export const BADGE_SHORT_BELOW_PX = 100;

/**
 * Gauntlet w210c-r1 item 12: the badge is drawn in the grid cell, just under the box (portalled there, so
 * the node's clip never cuts it and it never covers the widget's own controls, like a roulette's arrows),
 * left-aligned clear of the corner handles, always whole and clickable; in a narrow box it reads "Cut · Fit".
 */
export function CutBadge({ nodeId }: { nodeId: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(0);
  const [place, setPlace] = useState<{ cell: HTMLElement; top: number; left: number; short: boolean } | null>(null);
  useEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return;
    // Only a box with a drawn size can be too small: one directly in a fixed-row grid cell.
    const cell = box.parentElement;
    if (!cell?.parentElement?.matches(".atr-grid[data-fixed-rows]")) return;
    const root = box.querySelector(':scope > [data-slot="root"]');
    let raf = 0;
    const check = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setCut(contentCutPx(box));
        const b = box as HTMLElement;
        const top = b.offsetTop + b.offsetHeight + BADGE_GAP_PX;
        const left = b.offsetLeft + BADGE_INSET_PX;
        const short = b.offsetWidth < BADGE_SHORT_BELOW_PX;
        setPlace((p) => (p && p.cell === cell && p.top === top && p.left === left && p.short === short ? p : { cell, top, left, short }));
      });
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    ro?.observe(box);
    if (root) {
      ro?.observe(root);
      for (const k of Array.from(root.children)) ro?.observe(k);
    }
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(check);
    // The whole box: its root is replaced when data arrives (an empty state, then the widget).
    mo?.observe(box, { childList: true, subtree: true, characterData: true });
    check();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);
  const fit = () => {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FIT_EVENT, { detail: { nodeId } }));
  };
  // A roulette scales its slot down rather than cutting it (item 3): its badge says so.
  const shrunk = !!ref.current?.parentElement?.matches('[data-type="roulette"]');
  const on = cut > CUT_THRESHOLD_PX;
  const badge = (
    <span
      className="atr-cut-badge"
      data-cut-badge={nodeId}
      // Round 3 item 1: the badge sits in the grid cell, outside its node's box, so the canvas would take a press
      // on it for the grid (a marquee, then selecting the grid). The canvas leaves its own controls alone.
      data-canvas-control
      data-content-cut={on ? Math.ceil(cut) : undefined}
      data-short={place?.short ? "" : undefined}
      role={on ? "note" : undefined}
      hidden={!on || !place}
      style={place ? { top: place.top, left: place.left } : undefined}
    >
      <span>{place?.short ? (shrunk ? "Shrunk" : "Cut") : shrunk ? "Shrunk to fit" : "Content is cut"}</span>
      <span aria-hidden> · </span>
      <button
        type="button"
        className="atr-cut-fit"
        data-cut-fit
        aria-label={place?.short ? (shrunk ? "Shrunk to fit. Fit" : "Content is cut. Fit") : undefined}
        title={shrunk ? "Make the box tall enough to show its slot at full size" : "Make the box tall enough to show all its content"}
        // One path for a click, a tap, Enter and Space (round 3 item 1: pointer down never reached the Fit).
        onClick={(e) => { e.stopPropagation(); fit(); }}
      >
        Fit
      </button>
    </span>
  );
  // The anchor stays in the node box (so the badge knows its box); the badge itself goes to the cell.
  return (
    <>
      <span ref={ref} hidden data-cut-anchor />
      {place ? createPortal(badge, place.cell) : null}
    </>
  );
}
