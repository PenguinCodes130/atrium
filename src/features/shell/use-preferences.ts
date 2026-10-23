"use client";
// Reduced-motion and reduce-transparency hooks: the system setting OR the in-app switch.
import { useCallback, useSyncExternalStore } from "react";
import {
  applyPreferences,
  DEFAULT_PREFERENCES,
  effectiveReducedMotion,
  effectiveReduceTransparency,
  readPreferencesFromDocument,
  type Preferences,
} from "./preferences";

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    if (typeof window === "undefined") return () => {};
    const mq = window.matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
}
function mediaMatches(query: string) {
  return () => (typeof window === "undefined" ? false : window.matchMedia(query).matches);
}

const subscribePrefs = (cb: () => void) => {
  window.addEventListener("atrium:preferences", cb);
  return () => window.removeEventListener("atrium:preferences", cb);
};
let cachedKey = "";
let cachedPrefs: Preferences = DEFAULT_PREFERENCES;
const getPrefs = () => {
  const p = readPreferencesFromDocument();
  const key = `${p.theme}|${p.reducedMotion}|${p.reduceTransparency}`;
  if (key !== cachedKey) {
    cachedKey = key;
    cachedPrefs = p;
  }
  return cachedPrefs;
};

/** The in-app preferences plus a setter (writes cookies, updates <html>). */
export function usePreferences(): [Preferences, (next: Partial<Preferences>) => void] {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs, () => DEFAULT_PREFERENCES);
  const set = useCallback((next: Partial<Preferences>) => applyPreferences({ ...getPrefs(), ...next }), []);
  return [prefs, set];
}

const RM = "(prefers-reduced-motion: reduce)";
const RT = "(prefers-reduced-transparency: reduce)";
const subRM = subscribeMedia(RM);
const subRT = subscribeMedia(RT);
const getRM = mediaMatches(RM);
const getRT = mediaMatches(RT);

/** True when motion should use the reduced fallback (system setting or in-app switch). */
export function useReducedMotion(): boolean {
  const system = useSyncExternalStore(subRM, getRM, () => false);
  const [prefs] = usePreferences();
  return effectiveReducedMotion(system, prefs.reducedMotion);
}

/** True when glass renders as the opaque fallback. */
export function useReduceTransparency(): boolean {
  const system = useSyncExternalStore(subRT, getRT, () => false);
  const [prefs] = usePreferences();
  const supportsBlur = typeof CSS !== "undefined" ? CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)") : true;
  return effectiveReduceTransparency(system, prefs.reduceTransparency, supportsBlur);
}

/** Non-hook check for imperative code (event handlers, rAF loops). */
export function prefersReducedMotionNow(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(RM).matches || document.documentElement.getAttribute("data-motion") === "reduce";
}
