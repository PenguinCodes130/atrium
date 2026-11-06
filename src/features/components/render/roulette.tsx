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
//   - Render budget: only the visible slot and its two neighbours are mounted (and so read data); the rest
//     are not, and show the page's last value at once when they come round.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion } from "motion/react";
import type { ComponentNode, RenderContext } from "@/core/contracts";
import { transitionFor, useReducedMotion } from "@/features/shell";
import { text as textOf } from "../bindings";
import { useNodeEnv } from "./context";
import { nodeSources, repeatItems, valueKey } from "./resolve";
import { columnFormats, ITEM_FORMATS } from "./format";
import { applyCopyOverride, copyOverridesOf, hasCopyChange, rowKeys } from "./copy-overrides";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };

export const ROULETTE_MAX = 50;
export const ROULETTE_MIN_TIMER = 3;
export const ROULETTE_MAX_TIMER = 3600;
/** The angle between two slots on the drawn cylinder, in degrees (a fixed step, so any count turns alike). */
export const ROULETTE_STEP_DEG = 40;
/** A11.4: reduced motion crossfades in 200 ms. */
export const ROULETTE_FADE_MS = 200;
/** Wheel travel (px) that turns one slot, and the pause after a turn before the wheel can turn again. */
const WHEEL_STEP_PX = 40;
const WHEEL_REST_MS = 320;
/** About when the settle spring has landed a turn, so the far neighbour can mount off screen. */
const SETTLE_MS = 650;
/** More dots than this show "3 of 40" instead. */
const MAX_DOTS = 12;
export const ROULETTE_EMPTY = "Drop widgets here, or repeat one for each row";

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
  const reduced = useReducedMotion();
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
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [engaged, setEngaged] = useState(false);
  const [paused, setPaused] = useState(false);
  const [height, setHeight] = useState(0);
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let on = false;
    let acc = 0;
    let restUntil = 0;
    const set = (v: boolean) => { on = v; setEngaged(v); };
    const onDocDown = (e: PointerEvent) => set(!!e.target && root.contains(e.target as Node));
    const onFocusIn = () => set(true);
    const onFocusOut = (e: FocusEvent) => { if (!e.relatedTarget || !root.contains(e.relatedTarget as Node)) set(false); };
    const onWheel = (e: WheelEvent) => {
      if (!on || !adv.scroll || n < 2) return; // the page scrolls
      e.preventDefault();
      const now = performance.now();
      if (now < restUntil) return;
      acc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * root.clientHeight : e.deltaY;
      if (Math.abs(acc) >= WHEEL_STEP_PX) {
        goRef.current(acc > 0 ? 1 : -1);
        acc = 0;
        restUntil = now + WHEEL_REST_MS;
      }
    };
    document.addEventListener("pointerdown", onDocDown, true);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("wheel", onWheel);
    };
  }, [adv.scroll, n]);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setHeight(e!.contentRect.height));
    ro.observe(el);
    setHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);
  // The timer: off by default; never in the builder, never while hovered or focused, or the page is hidden.
  useEffect(() => {
    if (!timer || edit || paused || n < 2) return;
    const h = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      goRef.current(1);
    }, timer * 1000);
    return () => clearInterval(h);
  }, [timer, edit, paused, n]);

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
  const empty = mode === "repeat" ? !template : n === 0;
  if (empty) return <div data-slot="root" className="atr-roulette atr-muted" data-roulette-empty data-mode={mode}>{edit ? ROULETTE_EMPTY : null}</div>;
  if (tooMany) {
    return (
      <div data-slot="root" className="atr-roulette atr-roulette-refused" data-roulette-refused={rows.length} data-mode={mode} role="note">
        <p className="m-0">{`This list has more than ${ROULETTE_MAX} rows, and a roulette turns through at most ${ROULETTE_MAX}.`}</p>
        <p className="m-0 atr-muted">{edit ? "Show them as a list or a table instead: choose one in the inspector." : "Showing them as a list or a table would show them all."}</p>
      </div>
    );
  }
  if (mode === "repeat" && n === 0) return <p data-slot="root" className="atr-roulette atr-muted" data-mode={mode}>{textOf(resolved.empty) || "Nothing to show"}</p>;

  // The turn itself mounts nothing: the slot it turns to is already a mounted neighbour. The new far
  // neighbour mounts (and the old one leaves) once the turn has settled, off screen (V7, 60 fps).
  const faces = (() => {
    const set = mountedFaces(settled, n, dir);
    if (!set.some((f) => f.k === pos)) set.push({ k: pos, slot: cur });
    return set.length > 3 ? mountedFaces(pos, n, dir) : set.sort((a, b) => a.k - b.k);
  })();
  const radius = drumRadius(height);
  const spring = transitionFor("settle", false);
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
      ref={rootRef}
      data-slot="root"
      className="atr-roulette"
      data-mode={mode}
      data-count={n}
      data-current={cur}
      data-engaged={engaged ? "" : undefined}
      data-motion={reduced ? "fade" : "turn"}
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
              <motion.div key={f.k} className="atr-roulette-face" data-face={f.k} initial={false} animate={{ opacity: f.slot === cur ? 1 : 0 }} transition={{ duration: ROULETTE_FADE_MS / 1000, ease: "linear" }} {...faceAttrs(f.slot)}>
                {draw(f.slot)}
              </motion.div>
            ))}
          </div>
        ) : (
          <motion.div className="atr-roulette-drum" data-roulette-drum initial={false} animate={{ rotateX: pos * ROULETTE_STEP_DEG }} transition={spring} style={{ z: -radius, transformStyle: "preserve-3d" }}>
            {faces.map((f) => (
              // The faces turning away dim (opacity only), so the drum reads as a cylinder and a neighbour's
              // edge never competes with the slot in view.
              <motion.div key={f.k} className="atr-roulette-face" data-face={f.k} initial={false} animate={{ opacity: f.k === pos ? 1 : 0.2 }} transition={spring} style={{ transform: `rotateX(${-f.k * ROULETTE_STEP_DEG}deg) translateZ(${radius}px)` }} {...faceAttrs(f.slot)}>
                {draw(f.slot)}
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>
      <p className="sr-only" aria-live="polite" data-roulette-live>{`${cur + 1} of ${n}`}</p>
      {n > 1 && (adv.arrows || adv.dots) ? (
        <div className="atr-roulette-controls" data-slot="dots">
          {adv.arrows ? <button type="button" className="atr-roulette-arrow" aria-label="Previous" data-roulette-prev {...act(() => go(-1))}><span aria-hidden>‹</span></button> : null}
          {adv.dots ? (
            n <= MAX_DOTS ? (
              <span className="atr-roulette-dots" role="group" aria-label="Slots">
                {Array.from({ length: n }, (_, i) => (
                  <button key={i} type="button" className="atr-roulette-dot" aria-label={`Show ${i + 1} of ${n}`} aria-current={i === cur ? "true" : undefined} data-roulette-dot={i} {...act(() => goTo(i))} />
                ))}
              </span>
            ) : (
              <span className="atr-roulette-count" data-roulette-count>{`${cur + 1} of ${n}`}</span>
            )
          ) : null}
          {adv.arrows ? <button type="button" className="atr-roulette-arrow" aria-label="Next" data-roulette-next {...act(() => go(1))}><span aria-hidden>›</span></button> : null}
        </div>
      ) : null}
    </div>
  );
}
