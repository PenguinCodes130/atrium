"use client";
// Appearance (settings spec 3.1): shell mode, Reduce motion, Reduce transparency. Changes only this
// person's Atrium shell and how they see motion and glass; never another user, never an app's theme.
import { useState } from "react";
import { Switch, toast, usePreferences, type ThemePreference } from "@/features/shell";
import { api, errorText } from "./client-api";
import { ChoiceGroup } from "./controls";

const MODES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AppearancePanel() {
  const [prefs, setPrefs] = usePreferences();
  const [error, setError] = useState<string | null>(null);
  async function change(patch: { shellMode?: ThemePreference; reduceMotion?: boolean; reduceTransparency?: boolean }) {
    setPrefs({
      ...(patch.shellMode ? { theme: patch.shellMode } : {}),
      ...(patch.reduceMotion !== undefined ? { reducedMotion: patch.reduceMotion } : {}),
      ...(patch.reduceTransparency !== undefined ? { reduceTransparency: patch.reduceTransparency } : {}),
    });
    try {
      await api("/api/settings/preferences", { method: "PUT", body: patch });
      setError(null);
    } catch (x) {
      setError(errorText(x));
      toast({ kind: "error", title: "Your appearance was not saved", description: errorText(x) });
    }
  }
  return (
    <div className="flex max-w-[560px] flex-col gap-6" data-appearance-panel>
      <div className="flex flex-col gap-2">
        <ChoiceGroup<ThemePreference>
          label="Shell mode"
          name="shellMode"
          value={prefs.theme}
          onChange={(v) => change({ shellMode: v })}
          options={MODES.map((m) => ({ value: m.value, label: m.label, data: { "shell-mode": m.value } }))}
        />
        <p className="type-caption text-fg-2">Only the Atrium shell follows this. Apps keep their own themes.</p>
      </div>
      {/* Settings r2 (gauntlet w2-r1 item 14): switch rows on 12px spacing, each above a hairline. */}
      <div className="flex flex-col divide-y divide-line border-y border-line" data-switch-rows>
        <div className="py-3"><Switch id="settings-motion" label="Reduce motion" description="Movement becomes short fades." checked={prefs.reducedMotion} onCheckedChange={(v) => change({ reduceMotion: v })} /></div>
        <div className="py-3"><Switch id="settings-transparency" label="Reduce transparency" description="Glass becomes solid." checked={prefs.reduceTransparency} onCheckedChange={(v) => change({ reduceTransparency: v })} /></div>
      </div>
      {error && <p role="alert" className="type-body text-bad">{error}</p>}
    </div>
  );
}
