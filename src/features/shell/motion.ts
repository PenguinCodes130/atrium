// Atrium motion presets (design v4 section 3, FROZEN). The only spring and duration values any
// subsystem may use. Import { springs, durations } and pass them to Motion `transition` props,
// or use transitionFor() so the reduced-motion fallback comes for free. The Control Room feel is
// mechanical and quick: things snap into place like switches and paper, with weight but no wobble.
import type { Transition } from "motion/react";

export type SpringName = "settle" | "glide" | "lift" | "press" | "sheet" | "pop";

export const springs = {
  /** Lands, no visible bounce. Components and windows settling after the sweep, a new component. */
  settle: { type: "spring", stiffness: 300, damping: 32, mass: 1 },
  /** Quick, no overshoot. Drag and drop reflow, snapping into a grid slot, reordering layers. */
  glide: { type: "spring", stiffness: 560, damping: 46, mass: 1 },
  /** A short firm rise. Picking up a component (shadow to lifted, translate -4px), hovering a tile. */
  lift: { type: "spring", stiffness: 420, damping: 34, mass: 1 },
  /** A click you can feel. Buttons and tiles moving into the pressed shadow. */
  press: { type: "spring", stiffness: 900, damping: 50, mass: 0.6 },
  /** Firm slide. Sheets, the publish review, the inspector folding open, mobile bottom sheets. */
  sheet: { type: "spring", stiffness: 420, damping: 40, mass: 1 },
  /** Snappy. Switches, checkmarks, menus (scale 0.97 to 1 with opacity). */
  pop: { type: "spring", stiffness: 700, damping: 40, mass: 0.8 },
} as const satisfies Record<SpringName, Transition & { type: "spring"; stiffness: number; damping: number; mass: number }>;

export type CubicBezier = readonly [number, number, number, number];

export const durations = {
  /** Content swap, tooltips, toast exit, offline strip exit. */
  fade: { ms: 160, ease: [0.2, 0, 0, 1] as CubicBezier, css: "cubic-bezier(0.2, 0, 0, 1)" },
  /** Opening light sweep, once per session. */
  sweep: { ms: 1200, ease: [0.22, 1, 0.36, 1] as CubicBezier, css: "cubic-bezier(0.22, 1, 0.36, 1)" },
  /** Connection success and publish success: the title bar flash. */
  glow: { ms: 900, ease: [0.16, 1, 0.3, 1] as CubicBezier, css: "cubic-bezier(0.16, 1, 0.3, 1)" },
  /** Mono readouts that type in: 28ms per character, at most 1200ms, linear. First appearance only. */
  type: { msPerChar: 28, maxMs: 1200, css: "linear" },
  /** Number changes (count up), chart updates. */
  tick: { ms: 240, ease: [0.2, 0, 0, 1] as CubicBezier, css: "cubic-bezier(0.2, 0, 0, 1)" },
  /** @deprecated v3 name of `tick` (same 240ms value), kept for screens built on v3. */
  data: { ms: 240, ease: [0.2, 0, 0, 1] as CubicBezier, css: "cubic-bezier(0.2, 0, 0, 1)" },
  /** Per-item delay for the first 12 items; later items start with the 12th. */
  stagger: { ms: 30, maxItems: 12 },
  /** The sky band's grain gradient drift (shell only). */
  sky: { ms: 40_000, css: "linear" },
  /** The lit doorway's slow glow on the sign-in screen and empty rooms. */
  door: { ms: 4800, css: "ease-in-out" },
} as const;

/** Reduced-motion crossfade where something appears or disappears. */
export const REDUCED_CROSSFADE_MS = 120;
/**
 * The connection and publish glow's shape (design v4 Note 1): the title bar's gold layer reaches full
 * opacity (full --accent with --accent-fg text) within 120ms, holds near peak to about 450ms and eases
 * back by 900ms (`glow`). Only the layer's opacity animates.
 */
export const GLOW_PEAK_MS = 120;
export const GLOW_HOLD_MS = 450;
/** Rise: the `fade` curve. Ease back: a standard ease-in-out, so the gold stays readable as it leaves. */
export const GLOW_RISE_EASE: CubicBezier = [0.2, 0, 0, 1];
export const GLOW_FALL_EASE: CubicBezier = [0.4, 0, 0.2, 1];
export const glowKeyframes = {
  opacity: [0, 1, 1, 0],
  times: [0, GLOW_PEAK_MS / durations.glow.ms, GLOW_HOLD_MS / durations.glow.ms, 1],
  ease: [GLOW_RISE_EASE, "linear", GLOW_FALL_EASE] as [CubicBezier, "linear", CubicBezier],
};
/** The glow layer's opacity at `t` ms (the same curve, for tests and evidence). */
export function glowOpacityAt(t: number): number {
  if (t <= 0 || t >= durations.glow.ms) return 0;
  if (t <= GLOW_PEAK_MS) return cubicBezierAt(GLOW_RISE_EASE, t / GLOW_PEAK_MS);
  if (t <= GLOW_HOLD_MS) return 1;
  return 1 - cubicBezierAt(GLOW_FALL_EASE, (t - GLOW_HOLD_MS) / (durations.glow.ms - GLOW_HOLD_MS));
}

/** Reduced-motion glow: a static accent ring shown for this long. */
export const REDUCED_GLOW_RING_MS = 1500;
/** Longest allowed user-triggered animation (except sweep and glow). */
export const MAX_INTERACTION_MS = 400;

/** Duration of a type-in readout for a text of `chars` characters (28ms each, at most 1200ms). */
export function typeInMs(chars: number, reduced = false): number {
  if (reduced || chars <= 0) return 0;
  return Math.min(durations.type.maxMs, chars * durations.type.msPerChar);
}

/** Motion `transition` for a timed duration preset. */
export function timed(name: "fade" | "sweep" | "glow" | "tick" | "data"): Transition {
  const d = durations[name];
  return { duration: d.ms / 1000, ease: [...d.ease] };
}

/**
 * The transition to use for a spring preset. Under reduced motion, positions change instantly
 * and opacity crossfades over 120ms (design v4 section 3, reduced-motion table). For `press`, the
 * caller swaps the shadow with no translate (see Button).
 */
export function transitionFor(name: SpringName, reduced: boolean): Transition {
  if (!reduced) return springs[name];
  return { default: { duration: 0 }, opacity: { duration: REDUCED_CROSSFADE_MS / 1000, ease: "linear" } };
}

/**
 * Start delay in ms for item `index` (0-based) in a staggered entrance: 30ms apart for the first
 * 12 items, then every later item starts together with the 12th. Reduced motion: all together.
 */
export function staggerDelay(index: number, reduced = false): number {
  if (reduced || index <= 0) return 0;
  return Math.min(index, durations.stagger.maxItems - 1) * durations.stagger.ms;
}

/** Approximate settling time of a spring preset in ms (time until within `tolerance` of rest, default 0.5%). */
export function springSettleMs(name: SpringName, tolerance = 0.005): number {
  const { stiffness: k, damping: c, mass: m } = springs[name];
  // Simulate x'' = (-k x - c v) / m from x = 1, v = 0.
  let x = 1;
  let v = 0;
  const dt = 1 / 1000;
  for (let t = 0; t < 5; t += dt) {
    const a = (-k * x - c * v) / m;
    v += a * dt;
    x += v * dt;
    if (Math.abs(x) < tolerance && Math.abs(v) < tolerance * 10) return Math.round(t * 1000);
  }
  return 5000;
}

/** Evaluate a CSS cubic-bezier easing at progress t (0..1). */
export function cubicBezierAt(ease: CubicBezier, t: number): number {
  const [x1, y1, x2, y2] = ease;
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/** Inverse: the progress (0..1) at which the eased value first reaches y. */
export function cubicBezierTimeFor(ease: CubicBezier, y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (cubicBezierAt(ease, mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
