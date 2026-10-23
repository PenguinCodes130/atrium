// Opening light sweep logic (design v4 section 4), React-free for unit tests.
import { cubicBezierTimeFor, durations, staggerDelay } from "./motion";

/** Session cookie (no Max-Age, so it ends with the browser session) set when the sweep has played. */
export const SWEEP_COOKIE = "atrium_swept";

/** Band height and travel, in viewport heights: a 36vh band whose centre starts 20vh above the top and ends 20vh below the bottom. */
export const BAND_HEIGHT_VH = 36;
export const BAND_START_VH = -20;
export const BAND_END_VH = 120;

export type SweepStorage = { played(): boolean; markPlayed(): void };

/** Play only on the first launcher or app paint of a browser session, and never under reduced motion. */
export function shouldPlaySweep(storage: SweepStorage, reducedMotion: boolean): boolean {
  if (reducedMotion) return false;
  return !storage.played();
}

/** Decide and record in one step, so a second dashboard load in the same session does not replay. */
export function claimSweep(storage: SweepStorage, reducedMotion: boolean): boolean {
  const play = shouldPlaySweep(storage, reducedMotion);
  storage.markPlayed();
  return play;
}

/** ms after the sweep starts at which the band's centre reaches `yPx` (viewport coordinates). */
export function bandPassMs(yPx: number, viewportPx: number): number {
  const startPx = (BAND_START_VH / 100) * viewportPx;
  const endPx = (BAND_END_VH / 100) * viewportPx;
  const frac = Math.min(1, Math.max(0, (yPx - startPx) / (endPx - startPx)));
  return cubicBezierTimeFor(durations.sweep.ease, frac) * durations.sweep.ms;
}

/**
 * Settle start for each widget, in sweep order (top to bottom, then left to right): the first
 * item starts as the band passes its top edge; the rest follow 30ms apart, and every item past
 * the 12th starts together with the 12th.
 */
export function settleSchedule(count: number, firstTopPx: number, viewportPx: number): number[] {
  const first = bandPassMs(firstTopPx, viewportPx);
  return Array.from({ length: count }, (_, i) => Math.round(first + staggerDelay(i)));
}

/** Sort widget rectangles into sweep order. */
export function sweepOrder<T extends { top: number; left: number }>(rects: T[]): T[] {
  return [...rects].sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left));
}

/** Cookie-backed storage for the browser. */
export const cookieSweepStorage: SweepStorage = {
  played: () => typeof document !== "undefined" && document.cookie.split("; ").some((c) => c === `${SWEEP_COOKIE}=1`),
  markPlayed: () => {
    if (typeof document !== "undefined") document.cookie = `${SWEEP_COOKIE}=1; Path=/; SameSite=Lax`;
  },
};
