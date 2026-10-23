// A theme's small swatch for pickers and lists: wallpaper, surface, accent and text, as CSS values
// built only from checked theme colours and gradients (never free text).
import type { Theme } from "@/core/contracts";
import { isThemeColor, isThemeGradient } from "@/features/shell";

export type Swatch = { wallpaper: string; surface: string; accent: string; text: string };

export function themeSwatch(t: Theme): Swatch {
  const w = t.tokens.wallpaper;
  const c = t.tokens.color;
  const wallpaper =
    w.kind === "color" && isThemeColor(w.value) ? w.value
    : w.kind === "gradient" && isThemeGradient(w.value) ? w.value
    : w.kind === "sky" && w.colors ? `linear-gradient(100deg, ${w.colors[0]}, ${w.colors[1]})`
    : c.surface;
  return { wallpaper, surface: c.surface, accent: c.accent, text: c.surfaceText };
}
