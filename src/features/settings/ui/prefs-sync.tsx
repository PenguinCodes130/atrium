"use client";
// Keeps this browser's shell preference cookies in step with the person's stored preferences (A4.4:
// shell mode, reduce motion and reduce transparency are per user). Renders nothing.
import { useEffect } from "react";
import { usePreferences } from "@/features/shell";
import type { UserPrefs } from "../store";

export function PrefsSync({ prefs }: { prefs: UserPrefs }) {
  const [current, set] = usePreferences();
  useEffect(() => {
    if (current.theme !== prefs.shellMode || current.reducedMotion !== prefs.reduceMotion || current.reduceTransparency !== prefs.reduceTransparency) {
      set({ theme: prefs.shellMode, reducedMotion: prefs.reduceMotion, reduceTransparency: prefs.reduceTransparency });
    }
    // Only on first render: later changes come from the Appearance controls.
  }, []);
  return null;
}
