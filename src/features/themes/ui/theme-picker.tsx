"use client";
// ThemePicker (wave-2-lead-prep, settings provides): choose an app's or a page's theme.
//   <ThemePicker value={doc.theme} onChange={(ref) => ...} />
// `undefined` means "no theme of its own" (a page then uses the app theme). An inline copy (an imported
// app file, or a restored version) shows as its own option until another theme is picked.
import { useEffect, useId, useState } from "react";
import type { ThemeRef } from "@/core/contracts";

export type ThemeOption = { id: string; name: string; mode: "light" | "dark" | "auto"; builtIn: boolean; swatch: { wallpaper: string; surface: string; accent: string; text: string } };

export type ThemePickerProps = {
  value: ThemeRef | undefined;
  onChange(ref: ThemeRef | undefined): void;
  /** Label for the "no theme of its own" choice; pass null to hide it (the app theme always has one). Default "Use the app theme". */
  inheritLabel?: string | null;
  label?: string;
  disabled?: boolean;
};

let cache: Promise<ThemeOption[]> | null = null;
function loadThemes(): Promise<ThemeOption[]> {
  cache ??= fetch("/api/settings/themes?picker=1", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : { options: [] }))
    .then((j: { options?: ThemeOption[] }) => j.options ?? [])
    .catch(() => {
      cache = null;
      return [];
    });
  return cache;
}

/** For tests and after a theme is saved: make the next picker fetch the list again. */
export function refreshThemePicker(): void {
  cache = null;
}

export function ThemePicker({ value, onChange, inheritLabel = "Use the app theme", label = "Theme", disabled }: ThemePickerProps) {
  const id = useId();
  const [options, setOptions] = useState<ThemeOption[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadThemes().then((o) => live && setOptions(o));
    return () => {
      live = false;
    };
  }, []);
  const current = !value ? "" : "themeId" in value ? `id:${value.themeId}` : "inline";
  const known = options?.find((o) => current === `id:${o.id}`);
  const missing = value && "themeId" in value && options && !known;
  const shown = known ?? options?.find((o) => o.id === "control-room");

  return (
    <div className="flex flex-col gap-2" data-theme-picker>
      <label htmlFor={id} className="type-label text-fg-2">
        {label}
      </label>
      <div className="flex items-center gap-2">
        {shown ? (
          <span aria-hidden className="relative inline-block size-9 flex-none border border-line-strong" style={{ background: shown.swatch.wallpaper }} data-theme-swatch>
            <span className="absolute inset-x-1.5 top-1.5 bottom-3 border border-[color:var(--line-strong)]" style={{ background: shown.swatch.surface }} />
            <span className="absolute right-1.5 bottom-1 left-1.5 h-1" style={{ background: shown.swatch.accent }} />
          </span>
        ) : null}
        <select
          id={id}
          disabled={disabled || options === null}
          value={current}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") onChange(undefined);
            else if (v.startsWith("id:")) onChange({ themeId: v.slice(3) });
          }}
          className="h-9 min-w-0 flex-1 cursor-pointer border border-line-strong bg-bg-hi px-2 type-body text-fg touch:h-11"
          data-theme-select
        >
          {inheritLabel !== null ? <option value="">{inheritLabel}</option> : null}
          {value && "inline" in value ? <option value="inline">{`Copy of ${value.inline.name || "a theme"}`}</option> : null}
          {missing ? <option value={current}>Theme missing, showing Control Room</option> : null}
          {options === null ? <option value={current}>Loading themes</option> : null}
          {options && options.some((o) => o.builtIn) ? (
            <optgroup label="Built in">
              {options.filter((o) => o.builtIn).map((o) => (
                <option key={o.id} value={`id:${o.id}`}>{o.name}</option>
              ))}
            </optgroup>
          ) : null}
          {options && options.some((o) => !o.builtIn) ? (
            <optgroup label="Your themes">
              {options.filter((o) => !o.builtIn).map((o) => (
                <option key={o.id} value={`id:${o.id}`}>{o.name}</option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>
    </div>
  );
}
