"use client";
// Appearance controls: light or dark override, in-app reduced motion, reduce transparency.
// The values live in browser cookies (preferences.ts) until settings takes over; settings can mount
// this component as is, or drive applyPreferences() from its own store.
import { usePreferences } from "./use-preferences";
import type { ThemePreference } from "./preferences";
import { Switch } from "./switch";

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AppearanceControls({ idPrefix = "appearance" }: { idPrefix?: string }) {
  const [prefs, setPrefs] = usePreferences();
  return (
    <div className="flex flex-col gap-3" data-appearance>
      <fieldset>
        <legend className="mb-2 type-label text-fg-2">Appearance</legend>
        <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-1">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={prefs.theme === t.value}
              onClick={() => setPrefs({ theme: t.value })}
              className={`h-8 cursor-pointer border type-label touch:h-11 ${prefs.theme === t.value ? "border-line-strong bg-fg text-bg" : "border-line-strong bg-bg-hi text-fg hover:bg-bg-sunk"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="-mx-2 flex flex-col">
        <Switch id={`${idPrefix}-motion`} label="Reduce motion" checked={prefs.reducedMotion} onCheckedChange={(v) => setPrefs({ reducedMotion: v })} />
        <Switch id={`${idPrefix}-transparency`} label="Reduce transparency" checked={prefs.reduceTransparency} onCheckedChange={(v) => setPrefs({ reduceTransparency: v })} />
      </div>
    </div>
  );
}
