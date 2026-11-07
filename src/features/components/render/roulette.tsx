"use client";
// Wave 2.10c N3 (architecture A11.4): the roulette, a container that shows one child at a time and turns
// like a revolver cylinder.
//   - Slots mode: each child is one slot (2 to 50). Repeat mode: one template drawn for each row of `items`
//     with $item and $index, like a Repeat (copyOverrides apply per row); past 50 rows it refuses and the
//     inspector offers a list or a table instead.
//   - Advance: the wheel after the roulette is engaged (a click, a tap or keyboard focus; Esc or a click
//     outside releases it, as A11.3's Focus to scroll), the arrow buttons and keys, the dots, and an
//     optional timer (timerSec 3 to 3600, off when absent) that pauses on hover and focus.
//   - Motion: a 3D cylinder turn on the `settle` spring preset, transform and opacity only; reduced motion is
//     a 200 ms crossfade.
//   - Round 2 (gauntlet w210c-r1 items 1, 3, 10, 11, 20): one cylinder geometry for both modes (the stage is
//     measured whenever it appears, so a repeat that loads its rows later turns on a real radius), 36 deg
//     apart with neighbours at 60% and 0.92 scale (design Note 2), the front face never see-through; a theme
//     with no motion (its entrance None, like Solid) crossfades as reduced motion does; an engaged roulette
//     turns on a swipe; the wheel turns one slot per notch with no dead time; dots that do not fit on one line
//     become "3 of 9"; every roulette is a drop zone the builder can find (roulette-rules.ts).
//   - Render budget: only the visible slot and its two neighbours are mounted (and so read data); the rest
//     are not, and show the page's last value at once when they come round.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import type { ComponentNode, RenderContext } from "@/core/contracts";
import { transitionFor, useReducedMotion } from "@/features/shell";
import { text as textOf } from "../bindings";
import { useNodeEnv } from "./context";
import { nodeSources, repeatItems, valueKey } from "./resolve";
import { columnFormats, ITEM_FORMATS } from "./format";
import { applyCopyOverride, copyOverridesOf, hasCopyChange, rowKeys } from "./copy-overrides";
import { rouletteDropRule, ROULETTE_SHOW_EVENT } from "../roulette-rules";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };

export const ROULETTE_MAX = 50;
export const ROULETTE_MIN_TIMER = 3;
export const ROULETTE_MAX_TIMER = 3600;
/** The angle between two slots on the drawn cylinder, in degrees (a fixed step, so any count turns alike). */
export const ROULETTE_STEP_DEG = 36;
/** Design Note 2: the faces beside the front one, at rest. */
export const ROULETTE_NEIGHBOUR_OPACITY = 0.6;
export const ROULETTE_NEIGHBOUR_SCALE = 0.92;
/**
 * A face's look from how far it is turned from the front, in degrees (pure, unit-tested): within half a step
 * it is the front face, fully opaque at full size, so whatever face covers the middle of the stage is never
 * see-through mid-turn; from there to one step it eases to the neighbours' 60% and 0.92 (Note 2).
 */
export function faceLook(offDeg: number, step = ROULETTE_STEP_DEG): { opacity: number; scale: number } {
  const d = Math.abs(offDeg);
  const t = Math.min(1, Math.max(0, (d - step / 2) / (step / 2)));
  return { opacity: 1 - t * (1 - ROULETTE_NEIGHBOUR_OPACITY), scale: 1 - t * (1 - ROULETTE_NEIGHBOUR_SCALE) };
}

/** One face's content, its opacity and scale following the drum's turn frame by frame (no re-render). */
function FaceIn({ rot, k, children }: { rot: MotionValue<number>; k: number; children: React.ReactNode }) {
  const opacity = useTransform(rot, (r) => faceLook(r - k * ROULETTE_STEP_DEG).opacity);
  const scale = useTransform(rot, (r) => faceLook(r - k * ROULETTE_STEP_DEG).scale);
  return <motion.div className="atr-roulette-face-in" data-face-in style={{ opacity, scale }}>{children}</motion.div>;
}
/** A11.4: reduced motion crossfades in 200 ms. */
export const ROULETTE_FADE_MS = 200;
/** A wheel event this large is one mouse notch, one slot; smaller (trackpad) travel adds up to this per slot. */
export const WHEEL_NOTCH_PX = 50;
export const WHEEL_SLOT_PX = 80;
/** A touch swipe along the roulette this long turns it one slot. */
export const SWIPE_PX = 30;
/** About when the settle spring has landed a turn, so the far neighbour can mount off screen. */
const SETTLE_MS = 650;
/** More dots than this, or more than fit on one line, show "3 of 40" instead. */
const MAX_DOTS = 12;
const DOT_PX = 20;
const ARROW_PX = 28;
export const ROULETTE_EMPTY = "Drop widgets here, or repeat one for each row";
export const ROULETTE_DROP_HERE = "Drop to put it here";

/**
 * Slots a wheel event turns, carrying trackpad travel over in `acc` (pure, unit-tested): a mouse notch
 * (|delta| at least WHEEL_NOTCH_PX) is one slot each, so five quick notches turn five; smaller deltas add up
 * to one slot per WHEEL_SLOT_PX.
 */
export function wheelSlots(deltaPx: number, acc: number): { slots: number; acc: number } {
  if (!deltaPx) return { slots: 0, acc };
  if (Math.abs(deltaPx) >= WHEEL_NOTCH_PX) return { slots: Math.sign(deltaPx), acc: 0 };
  const next = (Math.sign(acc) === Math.sign(deltaPx) ? acc : 0) + deltaPx;
  const slots = Math.trunc(next / WHEEL_SLOT_PX);
  return { slots: slots || 0, acc: next - slots * WHEEL_SLOT_PX };
}

/** Whether `n` dots fit on one line in `widthPx` beside the arrows (pure, unit-tested). */
export function dotsFit(n: number, widthPx: number, arrows: boolean, dotPx = DOT_PX): boolean {
  if (n > MAX_DOTS) return false;
  if (!(widthPx > 0)) return true;
  const room = widthPx - (arrows ? 2 * ARROW_PX + 12 : 0) - 8;
  return n * (dotPx + 2) <= room;
}

/** The turn a touch swipe asks for: one slot along its longer axis (up or left is the next one), or 0. */
export function swipeSlots(dx: number, dy: number, minPx = SWIPE_PX): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < minPx) return 0;
  return ay >= ax ? (dy < 0 ? 1 : -1) : dx < 0 ? 1 : -1;
}

export type Advance = { scroll: boolean; arrows: boolean; dots: boolean };
export function advanceOf(v: unknown): Advance {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { scroll: o.scroll !== false, arrows: o.arrows !== false, dots: o.dots !== false };
}
/** The timer in seconds, or null when off (absent, or outside 3 to 3600). */
export function timerOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= ROULETTE_MIN_TIMER && v <= ROULETTE_MAX_TIMER ? v : null;
}
export const mod = (k: number, n: number) => ((k % n) + n) % n;

/**
 * The slots to mount around position `pos` (unbounded; the slot is pos mod n): the visible one and its two
 * neighbours, each slot once (with two slots the one neighbour sits on the side last turned towards).
 */
export function mountedFaces(pos: number, n: number, dir: 1 | -1 = 1): { k: number; slot: number }[] {
  if (n <= 0) return [];
  const order = [pos, pos + dir, pos - dir];
  const seen = new Set<number>();
  const out: { k: number; slot: number }[] = [];
  for (const k of order) {
    const slot = mod(k, n);
    if (seen.has(slot)) continue;
    seen.add(slot);
    out.push({ k, slot });
  }
  return out.sort((a, b) => a.k - b.k);
}

/** The cylinder's radius that puts faces of height `h` edge to edge at `stepDeg` apart. */
export function drumRadius(h: number, stepDeg = ROULETTE_STEP_DEG): number {
  return h > 0 ? h / 2 / Math.tan(((stepDeg / 2) * Math.PI) / 180) : 0;
}

export function RouletteView({ node, resolved, ctx }: P) {
  const env = useNodeEnv();
  const reducedPref = useReducedMotion();
  // A theme with no motion (its entrance None, as Solid) swaps slots with the crossfade too.
  const [stillTheme, setStillTheme] = useState(false);
  const reduced = reducedPref || stillTheme;
  const edit = ctx.mode === "edit";
  const mode = resolved.mode === "repeat" ? "repeat" : "slots";
  const adv = advanceOf(resolved.advance);
  const timer = timerOf(resolved.timerSec);
  const guest = env.scope.$guest;

  // What turns: the children, or one template per row.
  const template = node.children?.[0];
  const guestCount = guest ? Number(guest[valueKey(node.id, "$count", env.path)] ?? 0) : 0;
  const rows = useMemo(() => (mode !== "repeat" ? [] : guest ? Array.from({ length: Math.min(ROULETTE_MAX + 1, Math.max(0, guestCount)) }, () => undefined) : repeatItems(resolved.items, ROULETTE_MAX + 1)), [mode, guest, guestCount, resolved.items]);
  const guestKeyList = guest ? guest[valueKey(node.id, "$keys", env.path)] : undefined;
  const keys = useMemo(() => (Array.isArray(guestKeyList) && guestKeyList.length === rows.length ? (guestKeyList as string[]) : rowKeys(rows)), [guestKeyList, rows]);
  const overrides = copyOverridesOf(node);
  const src = nodeSources(node, env.scope)[0];
  const formats = src ? columnFormats(env.scope.$data?.[src]) : {};
  const n = mode === "repeat" ? (template ? rows.length : 0) : Math.min(ROULETTE_MAX, node.children?.length ?? 0);
  const tooMany = mode === "repeat" && rows.length > ROULETTE_MAX;

  const start = typeof resolved.startAt === "number" && Number.isFinite(resolved.startAt) ? Math.max(0, Math.floor(resolved.startAt)) : 0;
  const [pos, setPos] = useState(start);
  const [dir, setDir] = useState<1 | -1>(1);
  const cur = n ? mod(pos, n) : 0;
  const [settled, setSettled] = useState(start);
  useEffect(() => {
    if (settled === pos) return;
    const h = setTimeout(() => setSettled(pos), SETTLE_MS);
    return () => clearTimeout(h);
  }, [pos, settled]);
  const go = (by: number) => {
    if (n < 2 || !by) return;
    setDir(by > 0 ? 1 : -1);
    setPos((p) => p + by);
  };
  const goTo = (slot: number) => {
    if (n < 2) return;
    const by = slot - cur;
    if (!by) return;
    setDir(by > 0 ? 1 : -1);
    setPos((p) => p + by);
  };

  // Focus to scroll (A11.3), the timer's pause on hover and focus, and the wheel.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The root element changes between the empty, refused and turning states; listeners follow it.
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [paused, setPaused] = useState(false);
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  // Touch screens draw 44 px dots (components.css), so fewer fit on one line (read after mount: no hydration gap).
  const [touchDots, setTouchDots] = useState(false);
  const goRef = useRef(go);
  goRef.current = go;
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  // Faces mounted after the first render fade in (a far dot jump crossfades too, item 20).
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    const root = rootEl;
    if (!root) return;
    let on = false;
    let acc = 0;
    let touch: { id: number; x: number; y: number } | null = null;
    const set = (v: boolean) => { on = v; setEngaged(v); };
    const onDocDown = (e: PointerEvent) => set(!!e.target && root.contains(e.target as Node));
    const onFocusIn = () => set(true);
    const onFocusOut = (e: FocusEvent) => { if (!e.relatedTarget || !root.contains(e.relatedTarget as Node)) set(false); };
    const onWheel = (e: WheelEvent) => {
      if (!on || !adv.scroll || n < 2) return; // the page scrolls
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * root.clientHeight : e.deltaY;
      const w = wheelSlots(d, acc);
      acc = w.acc;
      if (w.slots) goRef.current(w.slots);
    };
    // Touch (item 11): once a tap has engaged it, a swipe along it turns it (touch-action is none while
    // engaged, components.css, so the page does not scroll under the finger); before that the page scrolls.
    const onTouchDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !on || n < 2) return;
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const onTouchUp = (e: PointerEvent) => {
      if (!touch || e.pointerId !== touch.id) return;
      const by = swipeSlots(e.clientX - touch.x, e.clientY - touch.y);
      touch = null;
      if (by) goRef.current(by);
    };
    const onTouchCancel = () => { touch = null; };
    document.addEventListener("pointerdown", onDocDown, true);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("pointerdown", onTouchDown);
    root.addEventListener("pointerup", onTouchUp);
    root.addEventListener("pointercancel", onTouchCancel);
    return () => {
      root.removeEventListener("pointerdown", onTouchDown);
      root.removeEventListener("pointerup", onTouchUp);
      root.removeEventListener("pointercancel", onTouchCancel);
      document.removeEventListener("pointerdown", onDocDown, true);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("wheel", onWheel);
    };
  }, [adv.scroll, n, rootEl]);
  // Item 3: the stage is measured whenever it appears (a callback ref), not only on the first render: a
  // repeat-mode roulette first draws "Nothing to show" until its rows arrive, and its radius stayed 0.
  const stageObs = useRef<ResizeObserver | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    stageObs.current?.disconnect();
    stageObs.current = null;
    if (!el) return;
    setHeight(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setHeight(e!.contentRect.height));
    ro.observe(el);
    stageObs.current = ro;
  }, []);
  const widthObs = useRef<ResizeObserver | null>(null);
  const measureRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
    widthObs.current?.disconnect();
    widthObs.current = null;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const canvas = el.closest("[data-canvas-enter]");
    setStillTheme(canvas?.getAttribute("data-canvas-enter") === "none");
    setTouchDots(typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    widthObs.current = ro;
  }, []);
  useEffect(() => () => { stageObs.current?.disconnect(); widthObs.current?.disconnect(); }, []);
  // The builder turns a roulette to a slot it selected (Layers), so the slot's box is drawn (item 1).
  useEffect(() => {
    const on = (e: Event) => {
      // Builder A sends { nodeId, index }; { slot } is taken too.
      const d = (e as CustomEvent<{ nodeId?: string; index?: number; slot?: number }>).detail;
      const at = typeof d?.index === "number" ? d.index : d?.slot;
      if (d?.nodeId === node.id && typeof at === "number") goToRef.current(at);
    };
    window.addEventListener(ROULETTE_SHOW_EVENT, on);
    return () => window.removeEventListener(ROULETTE_SHOW_EVENT, on);
  }, [node.id]);
  // The timer: off by default; never in the builder, never while hovered or focused, or the page is hidden.
  useEffect(() => {
    if (!timer || edit || paused || n < 2) return;
    const h = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      goRef.current(1);
    }, timer * 1000);
    return () => clearInterval(h);
  }, [timer, edit, paused, n]);

  // The drum's angle as one motion value: the drum turns on it and each face reads its own look from it.
  const rot = useMotionValue(pos * ROULETTE_STEP_DEG);
  useEffect(() => {
    const a = animate(rot, pos * ROULETTE_STEP_DEG, transitionFor("settle", false));
    return () => a.stop();
  }, [pos, rot]);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && (e.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "Escape") {
      if (engaged) { setEngaged(false); e.stopPropagation(); }
      return;
    }
    if (n < 2) return;
    if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") go(1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    else if (e.key === "Home") goTo(0);
    else if (e.key === "End") goTo(n - 1);
    else return;
    e.preventDefault();
  };
  // In the builder a capturing click selects and stops there, so the controls act on pointer up there.
  const act = (fn: () => void) => (edit ? { onPointerUp: (e: React.PointerEvent) => { if (e.button === 0) fn(); }, onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } } } : { onClick: fn });

  const label = textOf(node.title) || node.name || "Roulette";
  // Item 1: every roulette is a drop zone the builder can find, saying whether it takes one more widget.
  const rule = rouletteDropRule(node);
  const drop = { "data-drop-zone": "roulette", "data-drop-node": node.id, "data-drop-accepts": rule.accepts ? "true" : "false", ...(rule.accepts ? {} : { "data-drop-refusal": rule.reason }) };
  const empty = mode === "repeat" ? !template : n === 0;
  if (empty) {
    return (
      <div ref={measureRoot} data-slot="root" className="atr-roulette atr-muted" data-roulette-empty data-mode={mode} {...drop}>
        {edit ? (
          <div className="atr-roulette-drop" data-roulette-drop>
            <span data-drop-words="rest">{ROULETTE_EMPTY}</span>
            <span data-drop-words="over">{rule.accepts ? ROULETTE_DROP_HERE : rule.reason}</span>
          </div>
        ) : null}
      </div>
    );
  }
  if (tooMany) {
    return (
      <div ref={measureRoot} data-slot="root" className="atr-roulette atr-roulette-refused" data-roulette-refused={rows.length} data-mode={mode} role="note" {...drop}>
        <p className="m-0">{`This list has more than ${ROULETTE_MAX} rows, and a roulette turns through at most ${ROULETTE_MAX}.`}</p>
        <p className="m-0 atr-muted">{edit ? "Show them as a list or a table instead: choose one in the inspector." : "Showing them as a list or a table would show them all."}</p>
      </div>
    );
  }
  if (mode === "repeat" && n === 0) return <div ref={measureRoot} data-slot="root" className="atr-roulette atr-muted" data-mode={mode} {...drop}><p className="m-0">{textOf(resolved.empty) || "Nothing to show"}</p></div>;

  // The turn itself mounts nothing: the slot it turns to is already a mounted neighbour. The new far
  // neighbour mounts (and the old one leaves) once the turn has settled, off screen (V7, 60 fps).
  const faces = (() => {
    const set = mountedFaces(settled, n, dir);
    if (!set.some((f) => f.k === pos)) set.push({ k: pos, slot: cur });
    return set.length > 3 ? mountedFaces(pos, n, dir) : set.sort((a, b) => a.k - b.k);
  })();
  const radius = drumRadius(height);
  const draw = (slot: number) => {
    if (mode === "slots") return env.renderChild(node.children![slot]!, { key: node.children![slot]!.id });
    const key = keys[slot]!;
    const row = overrides[key];
    const changed = hasCopyChange(template!, row);
    return env.renderChild(changed ? applyCopyOverride(template!, key, row) : template!, { key: template!.id, scope: guest ? {} : { $item: rows[slot], $index: slot, [ITEM_FORMATS]: formats }, path: env.path ? `${env.path}.${slot}` : String(slot) });
  };
  const faceAttrs = (slot: number) => ({
    "data-slot-index": slot,
    ...(mode === "repeat" ? { "data-row-key": keys[slot], "data-copy-changed": hasCopyChange(template!, overrides[keys[slot]!]) ? "" : undefined } : {}),
    role: "group" as const,
    "aria-roledescription": "slot",
    "aria-label": `${slot + 1} of ${n}`,
    "aria-hidden": slot !== cur ? true : undefined,
    inert: slot !== cur ? true : undefined,
  });

  return (
    <div
      ref={measureRoot}
      data-slot="root"
      className="atr-roulette"
      data-mode={mode}
      data-count={n}
      data-current={cur}
      data-engaged={engaged ? "" : undefined}
      data-motion={reduced ? "fade" : "turn"}
      {...drop}
      role="group"
      aria-roledescription="roulette"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(!!rootRef.current?.contains(document.activeElement))}
      onFocus={() => setPaused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(!!rootRef.current?.matches(":hover")); }}
    >
      <div ref={stageRef} className="atr-roulette-stage" data-slot="slot">
        {reduced ? (
          <div className="atr-roulette-drum" data-roulette-drum>
            {faces.map((f) => (
              // Motion animates the opacity itself (the page's reduced-motion CSS turns CSS transitions off).
              <motion.div key={f.k} className="atr-roulette-face" data-face={f.k} initial={ready ? { opacity: 0 } : false} animate={{ opacity: f.slot === cur ? 1 : 0 }} transition={{ duration: ROULETTE_FADE_MS / 1000, ease: "linear" }} {...faceAttrs(f.slot)}>
                {draw(f.slot)}
              </motion.div>
            ))}
          </div>
        ) : (
          <motion.div className="atr-roulette-drum" data-roulette-drum style={{ rotateX: rot, z: -radius, transformStyle: "preserve-3d" }}>
            {faces.map((f) => (
              // Each face sits on the drum (its own fixed rotateX then translateZ, the same radius in both
              // modes); its content's opacity and scale follow how far it is turned from the front (faceLook),
              // so at rest the neighbours sit outside the stage at 60% and 0.92, and mid-turn the face over
              // the middle is never see-through.
              <div key={f.k} className="atr-roulette-face" data-face={f.k} style={{ transform: `rotateX(${-f.k * ROULETTE_STEP_DEG}deg) translateZ(${radius}px)` }} {...faceAttrs(f.slot)}>
                <FaceIn rot={rot} k={f.k}>{draw(f.slot)}</FaceIn>
              </div>
            ))}
          </motion.div>
        )}
      </div>
      <p className="sr-only" aria-live="polite" data-roulette-live>{`${cur + 1} of ${n}`}</p>
      {n > 1 && (adv.arrows || adv.dots) ? (
        <div className="atr-roulette-controls" data-slot="dots">
          {adv.arrows ? <button type="button" className="atr-roulette-arrow" aria-label="Previous" data-slot="arrows" data-roulette-prev {...act(() => go(-1))}><span aria-hidden>‹</span></button> : null}
          {adv.dots ? (
            dotsFit(n, width, adv.arrows, touchDots ? 44 : DOT_PX) ? (
              <span className="atr-roulette-dots" role="group" aria-label="Slots">
                {Array.from({ length: n }, (_, i) => (
                  <button key={i} type="button" className="atr-roulette-dot" aria-label={`Show ${i + 1} of ${n}`} aria-current={i === cur ? "true" : undefined} data-roulette-dot={i} {...act(() => goTo(i))} />
                ))}
              </span>
            ) : (
              <span className="atr-roulette-count" data-roulette-count>{`${cur + 1} of ${n}`}</span>
            )
          ) : null}
          {adv.arrows ? <button type="button" className="atr-roulette-arrow" aria-label="Next" data-slot="arrows" data-roulette-next {...act(() => go(1))}><span aria-hidden>›</span></button> : null}
        </div>
      ) : null}
    </div>
  );
}
