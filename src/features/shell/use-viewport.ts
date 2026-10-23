"use client";
// Shell breakpoints (design v2 "Shell Frame and Navigation"): phone under 640, rail 640 to 1099, sidebar 1100+.
import { useSyncExternalStore } from "react";

export type ShellLayout = "phone" | "rail" | "sidebar";

export const BREAKPOINTS = { rail: 640, sidebar: 1100 } as const;

export function layoutForWidth(width: number): ShellLayout {
  if (width < BREAKPOINTS.rail) return "phone";
  if (width < BREAKPOINTS.sidebar) return "rail";
  return "sidebar";
}

function subscribe(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

export function useShellLayout(): ShellLayout {
  return useSyncExternalStore(
    subscribe,
    () => layoutForWidth(window.innerWidth),
    () => "sidebar",
  );
}

export function useIsPhone(): boolean {
  return useShellLayout() === "phone";
}

const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};

/** navigator.onLine, live. Widgets use it to show their stale state while offline. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}
