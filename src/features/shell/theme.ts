// User-dashboard themes (design v4 section 2, FROZEN; architecture v3 `ThemeRef { inline: Theme }`).
// Owned by app-shell; settings (Wave 2) builds the theme editor and per-app resolution on top.
//
// - `Theme` and `ThemeTokens` are the frozen contract types (src/core/contracts), re-exported here.
// - `controlRoom`, `dusk`, `solid` and `daylight` are the four built-in themes, value for value from
//   the design v4 table.
// - `themeToCssVars()` turns a theme into the namespaced `--theme-*` custom properties for every v4
//   token; `themeCanvasCss()` writes them as the canvas's own rule (plus a dark set under the viewer's
//   dark preference for `mode: "auto"`), and `themeFontFaces()` declares a theme's uploaded fonts.
//   styles/canvas-theme.css maps the properties onto the canvas, its surfaces and the shell roles.
// - `ThemeSchema` / `parseTheme()` validate and clamp an imported theme.json (`atriumTheme: "2"`), and
//   v3 files (`atriumTheme: "1"`) import by mapping `surface.tint` to `color.surface` and filling the
//   new fields from Control Room (design v4 section 2, "Sharing"). Contrast under 4.5:1 for
//   surfaceText, surfaceMuted, canvasText and accentText is reported as warnings, never blocking.
//
// Pure module: no DOM, no Node APIs, safe on the server and in the browser.
import { z } from "zod";
import type { Theme, ThemeTokens } from "@/core/contracts";

export type { Theme, ThemeTokens };

/** The ten built-in theme families (design v4 section 2), all self-hosted. */
export type ThemeFontFamily =
  | "Inter Tight"
  | "Inter"
  | "Geist"
  | "Geist Mono"
  | "IBM Plex Sans"
  | "IBM Plex Mono"
  | "Fraunces"
  | "Space Grotesk"
  | "JetBrains Mono"
  | "Atkinson Hyperlegible";
/** @deprecated v3 name. */
export type ThemeFontUi = ThemeFontFamily;

/** The canvas tone a theme renders in. `auto` follows the viewer's dark preference. */
export type CanvasTone = "light" | "dark";

/** Font stacks per built-in family. next/font sets the variables on <html> (src/app/layout.tsx). */
export const THEME_FONT_STACKS: Record<ThemeFontFamily, string> = {
  "Inter Tight": "var(--font-inter-tight), ui-sans-serif, system-ui, sans-serif",
  Inter: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
  Geist: "var(--font-geist), ui-sans-serif, system-ui, sans-serif",
  "Geist Mono": "var(--font-geist-mono), ui-monospace, monospace",
  "IBM Plex Sans": "var(--font-plex-sans), ui-sans-serif, system-ui, sans-serif",
  "IBM Plex Mono": "var(--font-plex-mono), ui-monospace, monospace",
  Fraunces: "var(--font-fraunces), ui-serif, Georgia, serif",
  "Space Grotesk": "var(--font-space-grotesk), ui-sans-serif, system-ui, sans-serif",
  "JetBrains Mono": "var(--font-jetbrains-mono), ui-monospace, monospace",
  "Atkinson Hyperlegible": "var(--font-atkinson), ui-sans-serif, system-ui, sans-serif",
};
export const THEME_FONTS = Object.keys(THEME_FONT_STACKS) as ThemeFontFamily[];
const MONO_FAMILIES = new Set<string>(["Geist Mono", "IBM Plex Mono", "JetBrains Mono"]);

// ---- Built-in themes (design v4 section 2 table) ----

const CR_LIGHT: ThemeTokens = {
  wallpaper: { kind: "color", value: "#F3EFE4", blurPx: 0, dim: 0, grain: 0.08 },
  color: {
    surface: "#FBF9F3", surfaceText: "#15130F", surfaceMuted: "#3B372F", canvasText: "#15130F",
    accent: "#E9B949", accentText: "#15130F",
    ok: "#2F7A4D", warn: "#B5770C", bad: "#B23B25", info: "#2D5A85",
    line: "#15130F29",
  },
  surface: { material: "solid", opacity: 1, blurPx: 0, border: { widthPx: 1, color: "#15130F" }, shadow: "hard", shadowOffsetPx: 6, titleBars: true },
  type: { display: "Inter Tight", body: "Inter Tight", mono: "Geist Mono", scale: 1, numbers: "tabular", headingTracking: -0.04, headingWeight: 600 },
  shape: { radiusPx: 0, controlRadiusPx: 0 },
  space: { gapPx: 24, padPx: 20, density: "comfortable" },
  motion: { enter: "sweep", lightDrift: true },
  chrome: { background: "#F3EFE4", text: "#15130F", activeFill: "#15130F", activeText: "#F3EFE4", style: "boxed-tabs" },
};

/** Control Room: paper, ink and one gold accent, square windows with hard shadows. Default for new apps. */
export const controlRoom: Theme = {
  atriumTheme: "2", id: "control-room", name: "Control Room", author: "Atrium", version: "1",
  mode: "light",
  tokens: CR_LIGHT,
  // The dark set (used when an app sets mode "auto" and the viewer is dark): ink ground, gold shadows.
  dark: {
    wallpaper: { kind: "color", value: "#15130F", blurPx: 0, dim: 0, grain: 0.08 },
    color: {
      surface: "#1D1A15", surfaceText: "#F3EFE4", surfaceMuted: "#CFC8B8", canvasText: "#F3EFE4",
      accent: "#E9B949", accentText: "#15130F",
      ok: "#5DBB82", warn: "#E0A23A", bad: "#F07A62", info: "#7FA8CF",
      line: "#F3EFE429",
    },
    surface: { ...CR_LIGHT.surface, border: { widthPx: 1, color: "#F3EFE473" } },
    chrome: { background: "#15130F", text: "#F3EFE4", activeFill: "#F3EFE4", activeText: "#15130F", style: "boxed-tabs" },
  },
};

/** Dusk: warm dark glass, from v3. */
export const dusk: Theme = {
  atriumTheme: "2", id: "dusk", name: "Dusk", author: "Atrium", version: "1",
  mode: "dark",
  tokens: {
    wallpaper: { kind: "gradient", value: "linear-gradient(to bottom, oklch(0.30 0.05 40), oklch(0.18 0.03 280))", colors: ["oklch(0.30 0.05 40)", "oklch(0.18 0.03 280)"], blurPx: 0, dim: 0, grain: 0 },
    color: {
      surface: "oklch(0.22 0.01 60)", surfaceText: "oklch(0.96 0.006 80)", surfaceMuted: "oklch(0.82 0.01 75)", canvasText: "oklch(0.96 0.006 80)",
      accent: "oklch(0.78 0.13 60)", accentText: "oklch(0.24 0.04 70)",
      ok: "#5DBB82", warn: "#E0A23A", bad: "#F07A62", info: "#7FA8CF",
      line: "oklch(1 0 0 / 0.12)",
    },
    surface: { material: "glass", opacity: 0.72, blurPx: 28, border: { widthPx: 1, color: "oklch(1 0 0 / 0.08)" }, shadow: "soft", shadowOffsetPx: 0, titleBars: false },
    type: { display: "Inter", body: "Inter", mono: "Geist Mono", scale: 1, numbers: "tabular", headingTracking: -0.02, headingWeight: 600 },
    shape: { radiusPx: 16, controlRadiusPx: 10 },
    space: { gapPx: 16, padPx: 24, density: "comfortable" },
    motion: { enter: "fade", lightDrift: false },
    chrome: { background: "oklch(0.22 0.01 60)", text: "oklch(0.96 0.006 80)", activeFill: "oklch(0.78 0.13 60)", activeText: "oklch(0.24 0.04 70)", style: "pills" },
  },
};

/** Solid: no transparency or motion; the fast, readable, low-power theme for wall screens. */
export const solid: Theme = {
  atriumTheme: "2", id: "solid", name: "Solid", author: "Atrium", version: "1",
  mode: "light",
  tokens: {
    wallpaper: { kind: "color", value: "#F2F1EE", blurPx: 0, dim: 0, grain: 0 },
    color: {
      surface: "#FFFFFF", surfaceText: "#1A1A1A", surfaceMuted: "#4A4A4A", canvasText: "#1A1A1A",
      accent: "#2F6FB0", accentText: "#FFFFFF",
      ok: "#2F7A4D", warn: "#B5770C", bad: "#B23B25", info: "#2F6FB0",
      line: "#0000001F",
    },
    surface: { material: "solid", opacity: 1, blurPx: 0, border: { widthPx: 1, color: "#0000002E" }, shadow: "none", shadowOffsetPx: 0, titleBars: false },
    type: { display: "Atkinson Hyperlegible", body: "Atkinson Hyperlegible", mono: "JetBrains Mono", scale: 1, numbers: "tabular", headingTracking: -0.01, headingWeight: 700 },
    shape: { radiusPx: 8, controlRadiusPx: 8 },
    space: { gapPx: 16, padPx: 20, density: "comfortable" },
    motion: { enter: "none", lightDrift: false },
    chrome: { background: "#FFFFFF", text: "#1A1A1A", activeFill: "#2F6FB0", activeText: "#FFFFFF", style: "underline" },
  },
};

/** Daylight: the v3 default, kept for people who like soft glass. */
export const daylight: Theme = {
  atriumTheme: "2", id: "daylight", name: "Daylight", author: "Atrium", version: "1",
  mode: "light",
  tokens: {
    wallpaper: { kind: "gradient", value: "linear-gradient(to bottom, oklch(0.97 0.02 85), oklch(0.93 0.03 230))", colors: ["oklch(0.97 0.02 85)", "oklch(0.93 0.03 230)"], blurPx: 0, dim: 0, grain: 0 },
    color: {
      surface: "oklch(1 0 0)", surfaceText: "oklch(0.21 0.01 70)", surfaceMuted: "oklch(0.36 0.012 70)", canvasText: "oklch(0.21 0.01 70)",
      accent: "#E9B949", accentText: "#15130F",
      ok: "#2F7A4D", warn: "#B5770C", bad: "#B23B25", info: "#2D5A85",
      line: "oklch(0.21 0.01 70 / 0.1)",
    },
    surface: { material: "glass", opacity: 0.74, blurPx: 24, border: { widthPx: 1, color: "oklch(1 0 0 / 0.55)" }, shadow: "soft", shadowOffsetPx: 0, titleBars: false },
    type: { display: "Inter", body: "Inter", mono: "Geist Mono", scale: 1, numbers: "tabular", headingTracking: -0.02, headingWeight: 600 },
    shape: { radiusPx: 20, controlRadiusPx: 12 },
    space: { gapPx: 16, padPx: 24, density: "comfortable" },
    motion: { enter: "rise", lightDrift: true },
    chrome: { background: "oklch(1 0 0 / 0.6)", text: "oklch(0.21 0.01 70)", activeFill: "oklch(0.21 0.01 70)", activeText: "oklch(1 0 0)", style: "pills" },
  },
};

export const BUILT_IN_THEMES = { controlRoom, dusk, solid, daylight } as const;
export type BuiltInThemeId = keyof typeof BUILT_IN_THEMES;

/** The tokens a theme renders with for a viewer scheme (`dark` overrides apply only in auto mode). */
export function resolveTokens(theme: Theme, scheme: CanvasTone): ThemeTokens {
  if (theme.mode !== "auto" || scheme === "light" || !theme.dark) return theme.tokens;
  return { ...theme.tokens, ...theme.dark };
}

/** The tone a theme renders in: its mode, or the light set for auto (the dark set follows the viewer). */
export function themeTone(theme: Theme): CanvasTone | "auto" {
  return theme.mode;
}

// ---- Colour maths (OKLCH and hex to sRGB, WCAG contrast, gamma-space compositing as browsers do) ----

export type Oklch = { l: number; c: number; h: number; a: number };
type Rgba = { r: number; g: number; b: number; a: number };

const OKLCH_RE = /^oklch\(\s*([0-9]*\.?[0-9]+)(%?)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)(?:deg)?\s*(?:\/\s*([0-9]*\.?[0-9]+)(%?)\s*)?\)$/i;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A theme colour: `oklch(L C H [/ A])` or `#rgb[a]` / `#rrggbb[aa]`. Nothing else is accepted. */
export function isThemeColor(s: string): boolean {
  return OKLCH_RE.test(s.trim()) || HEX_RE.test(s.trim());
}

export function parseOklch(s: string): Oklch | null {
  const m = OKLCH_RE.exec(s.trim());
  if (!m) return null;
  const l = m[2] === "%" ? parseFloat(m[1]!) / 100 : parseFloat(m[1]!);
  const a = m[5] === undefined ? 1 : m[6] === "%" ? parseFloat(m[5]) / 100 : parseFloat(m[5]);
  return { l: Math.min(1, Math.max(0, l)), c: parseFloat(m[3]!), h: parseFloat(m[4]!), a: Math.min(1, Math.max(0, a)) };
}

function encode(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function oklchToRgba({ l: L, c: C, h, a }: Oklch): Rgba {
  const hr = (h * Math.PI) / 180;
  const A = C * Math.cos(hr);
  const B = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return {
    r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a,
  };
}

function hexToRgba(hex: string): Rgba {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((ch) => ch + ch).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

export function colorToRgba(s: string): Rgba | null {
  const t = s.trim();
  if (HEX_RE.test(t)) return hexToRgba(t);
  const o = parseOklch(t);
  return o ? oklchToRgba(o) : null;
}

/** OKLCH lightness of a theme colour (hex is converted), or null if it is not a theme colour. */
export function lightnessOf(s: string): number | null {
  const o = parseOklch(s);
  if (o) return o.l;
  const c = colorToRgba(s);
  if (!c) return null;
  const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [dec(c.r), dec(c.g), dec(c.b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sh = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * sh;
}

/** Any theme colour as OKLCH (hex is converted). */
export function toOklch(s: string): Oklch | null {
  const o = parseOklch(s);
  if (o) return o;
  const c = colorToRgba(s);
  if (!c) return null;
  const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [dec(c.r), dec(c.g), dec(c.b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sh = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * sh;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * sh;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * sh;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h, a: c.a };
}

function over(top: Rgba, bottom: Rgba): Rgba {
  // gamma-encoded sRGB "over", which is what browsers do (design v4 section 6)
  const a = top.a + bottom.a * (1 - top.a);
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / (a || 1);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function luminance(c: Rgba): number {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };


const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
/** Image wallpapers may only come from the instance's own uploads route (architecture section 13). */
export function isUploadPath(p: string): boolean {
  return UPLOAD_PATH_RE.test(p) && !p.includes("..");
}

// Gradients: the CSS gradient functions with colours, numbers, angles and keywords only (no url, no strings).
const GRADIENT_RE = /^(?:repeating-)?(?:linear|radial|conic)-gradient\([a-z0-9\s.,%()/#+-]*\)$/i;
export function isThemeGradient(s: string): boolean {
  const v = s.trim();
  return v.length <= 600 && GRADIENT_RE.test(v) && !/url\(|image|expression|var\(|env\(|attr\(/i.test(v) && balanced(v);
}
function balanced(s: string): boolean {
  let d = 0;
  for (const ch of s) {
    if (ch === "(") d++;
    else if (ch === ")" && --d < 0) return false;
  }
  return d === 0;
}


// ---- Contrast (design v4 section 2: the editor shows it and `validate` reports contrast.low) ----

/** Colours named in a wallpaper (theme colour syntax only). */
function wallpaperColors(w: ThemeTokens["wallpaper"]): Rgba[] {
  const found = w.kind === "color" ? [w.value] : w.kind === "gradient" ? (w.value.match(/oklch\([^)]*\)|#[0-9a-f]{3,8}\b/gi) ?? []) : w.kind === "sky" ? (w.colors ?? []) : [];
  return found.map((s) => colorToRgba(s)).filter((c): c is Rgba => c !== null).map((c) => ({ ...c, a: 1 }));
}

/** Backdrops a surface can sit on: the wallpaper's colours with the dim applied, else pure white and black. */
function backdropsFor(t: ThemeTokens): Rgba[] {
  const known = wallpaperColors(t.wallpaper);
  const base = known.length ? known : [WHITE, BLACK];
  return base.map((c) => (t.wallpaper.dim > 0 ? over({ ...BLACK, a: t.wallpaper.dim }, c) : c));
}

export type ContrastField = "color.surfaceText" | "color.surfaceMuted" | "color.canvasText" | "color.accentText";
export type ContrastWarning = { field: ContrastField; ratio: number; min: 4.5; scheme: CanvasTone };
export type ContrastReport = { surfaceText: number; surfaceMuted: number; canvasText: number; accentText: number; warnings: ContrastWarning[] };

/** Worst-case contrast of a token set's four text pairs (glass measured over its backdrops, gamma space). */
export function tokenContrast(t: ThemeTokens, scheme: CanvasTone = "light"): ContrastReport {
  const c = t.color;
  const surface = colorToRgba(c.surface);
  const accent = colorToRgba(c.accent);
  const fills = surface ? backdropsFor(t).map((b) => over({ ...surface, a: t.surface.material === "glass" ? clamp(t.surface.opacity, 0.3, 1) : 1 }, b)) : [];
  const worst = (fg: string, grounds: Rgba[]) => {
    const f = colorToRgba(fg);
    if (!f || !grounds.length) return 0;
    return +Math.min(...grounds.map((g) => contrastRatio(over(f, g), g))).toFixed(2);
  };
  const r = {
    surfaceText: worst(c.surfaceText, fills),
    surfaceMuted: worst(c.surfaceMuted, fills),
    canvasText: worst(c.canvasText, t.wallpaper.kind === "image" ? [WHITE, BLACK].map((b) => (t.wallpaper.dim > 0 ? over({ ...BLACK, a: t.wallpaper.dim }, b) : b)) : backdropsFor(t)),
    accentText: worst(c.accentText, accent ? [{ ...accent, a: 1 }] : []),
  };
  const warnings: ContrastWarning[] = [];
  for (const [k, v] of Object.entries(r) as [keyof typeof r, number][]) if (v < 4.5) warnings.push({ field: `color.${k}` as ContrastField, ratio: v, min: 4.5, scheme });
  return { ...r, warnings };
}

/** Contrast for a theme: its tokens, plus the dark set when it follows the viewer (mode auto). */
export function contrastReport(theme: Theme): ContrastReport {
  const base = tokenContrast(theme.tokens, theme.mode === "dark" ? "dark" : "light");
  if (theme.mode !== "auto" || !theme.dark) return base;
  const dark = tokenContrast(resolveTokens(theme, "dark"), "dark");
  return { ...base, warnings: [...base.warnings, ...dark.warnings] };
}

// ---- Tokens to CSS custom properties ----

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const mixAlpha = (color: string, alpha: number) => `color-mix(in oklab, ${color} ${pct(alpha)}, transparent)`;
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/;

/** A font family as a CSS stack: a built-in family's self-hosted stack, or an uploaded family by name. */
export function fontStack(family: string, uploaded: readonly string[], role: "display" | "body" | "mono"): string {
  if (family in THEME_FONT_STACKS) return THEME_FONT_STACKS[family as ThemeFontFamily];
  const fallback = role === "mono" ? THEME_FONT_STACKS["Geist Mono"] : THEME_FONT_STACKS["Inter Tight"];
  if (FAMILY_RE.test(family) && uploaded.includes(family)) return `"${family}", ${fallback}`;
  return fallback;
}

function wallpaperCss(w: ThemeTokens["wallpaper"]): string {
  switch (w.kind) {
    case "color":
      return isThemeColor(w.value) ? w.value.trim() : "none";
    case "gradient":
      return isThemeGradient(w.value) ? w.value.trim() : "none";
    case "image":
      return isUploadPath(w.value) ? `url("${w.value}")` : "none";
    case "sky": {
      const [a, b] = (w.colors ?? []).map((c) => c.trim());
      return a && b && isThemeColor(a) && isThemeColor(b) ? `linear-gradient(100deg, ${a} 0%, ${a} 30%, ${b} 100%)` : "none";
    }
    default:
      return "none";
  }
}

const col = (v: string, fallback: string) => (isThemeColor(v) ? v.trim() : fallback);

// Soft theme shadows, literal so they do not follow the shell's v4 elevation tokens.
const SOFT_SHADOW = "0 12px 32px oklch(0.2 0.02 70 / 0.12), 0 2px 6px oklch(0.2 0.02 70 / 0.06)";

/**
 * The namespaced custom properties for one token set, for every v4 token. Pure and deterministic.
 * Every value is built from validated pieces (theme colours, gradients, upload paths, clamped
 * numbers, known families), so a hostile theme cannot inject CSS here.
 */
export function tokensToCssVars(t: ThemeTokens, tone: CanvasTone, uploadedFamilies: readonly string[] = []): Record<string, string> {
  const fb: ThemeTokens = tone === "dark" ? { ...CR_LIGHT, ...controlRoom.dark } : CR_LIGHT;
  const c = t.color;
  const surface = col(c.surface, fb.color.surface);
  const surfaceText = col(c.surfaceText, fb.color.surfaceText);
  const glass = t.surface.material === "glass";
  const opacity = glass ? clamp(t.surface.opacity, 0.3, 1) : 1;
  const borderW = ([0, 1, 2] as const).includes(t.surface.border.widthPx) ? t.surface.border.widthPx : 1;
  const offset = clamp(Math.round(t.surface.shadowOffsetPx), 0, 12);
  const accent = col(c.accent, fb.color.accent);
  // Hard shadows are ink (the surface text) on a light canvas and the accent, lit from behind, on a dark one.
  const hardColor = tone === "dark" ? mixAlpha(accent, 0.9) : surfaceText;
  const shadow = t.surface.shadow === "hard" && offset > 0 ? `${offset}px ${offset}px 0 0 ${hardColor}` : t.surface.shadow === "soft" ? SOFT_SHADOW : "none";
  const ty = t.type;
  const pad = clamp(Math.round(t.space.padPx), 8, 40);
  return {
    "--theme-wallpaper": wallpaperCss(t.wallpaper),
    "--theme-wallpaper-blur": `${[0, 8, 16, 32].includes(t.wallpaper.blurPx) ? t.wallpaper.blurPx : 0}px`,
    "--theme-wallpaper-dim": String(clamp(t.wallpaper.dim, 0, 0.6)),
    "--theme-wallpaper-grain": String(clamp(t.wallpaper.grain, 0, 0.3)),
    "--theme-wallpaper-position": t.wallpaper.position ?? "center",
    "--theme-surface": surface,
    "--theme-surface-text": surfaceText,
    "--theme-surface-muted": col(c.surfaceMuted, surfaceText),
    "--theme-canvas-text": col(c.canvasText, surfaceText),
    "--theme-accent": accent,
    "--theme-accent-text": col(c.accentText, fb.color.accentText),
    "--theme-accent-ink": accentInk(accent, tone, surfaceText),
    "--theme-ok": col(c.ok, fb.color.ok),
    "--theme-warn": col(c.warn, fb.color.warn),
    "--theme-bad": col(c.bad, fb.color.bad),
    "--theme-info": col(c.info, fb.color.info),
    "--theme-line": col(c.line, mixAlpha(surfaceText, 0.12)),
    "--theme-surface-opacity": String(opacity),
    "--theme-surface-fill": glass ? mixAlpha(surface, opacity) : surface,
    "--theme-surface-blur": glass ? `${clamp(Math.round(t.surface.blurPx), 0, 48)}px` : "0px",
    "--theme-border-width": `${borderW}px`,
    "--theme-border-color": col(t.surface.border.color, mixAlpha(surfaceText, 0.18)),
    "--theme-shadow-kind": t.surface.shadow === "hard" || t.surface.shadow === "soft" ? t.surface.shadow : "none",
    "--theme-shadow-offset": `${offset}px`,
    "--theme-shadow": shadow,
    "--theme-title-bars": t.surface.titleBars ? "1" : "0",
    "--theme-font-display": fontStack(ty.display, uploadedFamilies, "display"),
    "--theme-font-body": fontStack(ty.body, uploadedFamilies, "body"),
    "--theme-font-mono": fontStack(MONO_FAMILIES.has(ty.mono) || !(ty.mono in THEME_FONT_STACKS) ? ty.mono : "Geist Mono", uploadedFamilies, "mono"),
    "--theme-type-scale": String(+clamp(ty.scale, 0.85, 1.3).toFixed(3)),
    "--theme-numbers": ty.numbers === "proportional" ? "proportional-nums" : "tabular-nums",
    "--theme-heading-tracking": `${+clamp(ty.headingTracking, -0.06, 0.02).toFixed(3)}em`,
    "--theme-heading-weight": String(([400, 500, 600, 700, 800] as const).includes(ty.headingWeight) ? ty.headingWeight : 600),
    "--theme-radius": `${clamp(Math.round(t.shape.radiusPx), 0, 32)}px`,
    "--theme-control-radius": `${clamp(Math.round(t.shape.controlRadiusPx), 0, 999)}px`,
    "--theme-gap": `${clamp(Math.round(t.space.gapPx), 4, 40)}px`,
    "--theme-pad": `${pad}px`,
    "--theme-pad-phone": `${Math.max(8, Math.round(pad * 0.8))}px`,
    "--theme-density": t.space.density === "compact" ? "compact" : "comfortable",
    "--theme-motion-enter": ["none", "fade", "rise", "sweep"].includes(t.motion.enter) ? t.motion.enter : "none",
    "--theme-chrome-bg": col(t.chrome.background, fb.chrome.background),
    "--theme-chrome-text": col(t.chrome.text, fb.chrome.text),
    "--theme-chrome-active-fill": col(t.chrome.activeFill, fb.chrome.activeFill),
    "--theme-chrome-active-text": col(t.chrome.activeText, fb.chrome.activeText),
    "--theme-chrome-style": ["bar", "boxed-tabs", "pills", "underline"].includes(t.chrome.style) ? t.chrome.style : "boxed-tabs",
    "--theme-glow": mixAlpha(accent, 0.35),
    "--theme-room-shaft": mixAlpha(accent, 0.12),
    "--theme-room-shaft-dim": mixAlpha(accent, 0.05),
  };
}

/** Accent as text, links and focus ring on this canvas: darkened on light canvases, lightened on dark. */
function accentInk(accent: string, tone: CanvasTone, fallback: string): string {
  const o = toOklch(accent);
  if (!o) return fallback;
  if (tone === "light" && o.l <= 0.52) return accent;
  if (tone === "dark" && o.l >= 0.8) return accent;
  const l = tone === "light" ? 0.52 : 0.84;
  return `oklch(${l} ${+o.c.toFixed(3)} ${+o.h.toFixed(1)})`;
}

/** The custom properties for a theme: the base set, and the dark set when it follows the viewer. */
export function themeToCssVars(theme: Theme): { base: Record<string, string>; dark: Record<string, string> | null } {
  const uploaded = (theme.fonts ?? []).map((f) => f.family);
  const baseTone: CanvasTone = theme.mode === "dark" ? "dark" : "light";
  const base = tokensToCssVars(theme.tokens, baseTone, uploaded);
  const dark = theme.mode === "auto" ? tokensToCssVars(resolveTokens(theme, "dark"), "dark", uploaded) : null;
  return { base, dark };
}

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const decls = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");

/**
 * The canvas's own theme rule, in the atrium-theme layer, so custom CSS (atrium-custom) can still set
 * `--theme-*`. For `mode: "auto"` the dark set applies under the viewer's dark preference (the system
 * setting unless Atrium's appearance is forced light, or Atrium forced dark).
 */
export function themeCanvasCss(theme: Theme, key: string): string {
  if (!KEY_RE.test(key)) return "";
  const sel = `[data-atrium-canvas][data-canvas-key="${key}"]`;
  const { base, dark } = themeToCssVars(theme);
  let css = `@layer atrium-theme{${sel}{${decls(base)}}`;
  if (dark) {
    css += `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) ${sel}{${decls(dark)}}}`;
    css += `:root[data-theme="dark"] ${sel}{${decls(dark)}}`;
  }
  css += "}";
  const out = `${themeFontFaces(theme)}${css}`;
  // Last line of defence for the <style> element: nothing that could end it or open markup.
  return /</.test(out) ? "" : out;
}

/**
 * `@font-face` rules for a theme's uploaded fonts (woff2 files on this instance's /uploads/ only).
 * Custom CSS may not declare fonts (the scoper drops @font-face), so the host writes them here.
 */
export function themeFontFaces(theme: Pick<Theme, "fonts">): string {
  const out: string[] = [];
  for (const f of theme.fonts ?? []) {
    if (!FAMILY_RE.test(f.family) || f.family in THEME_FONT_STACKS) continue;
    if (!isUploadPath(f.file) || !/\.woff2$/i.test(f.file)) continue;
    const weight = /^[1-9]00(?: [1-9]00)?$/.test(f.weight) ? f.weight : "400";
    const style = f.style === "italic" ? "italic" : "normal";
    out.push(`@font-face{font-family:"${f.family}";src:url("${f.file}") format("woff2");font-weight:${weight};font-style:${style};font-display:swap}`);
  }
  return out.join("");
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// ---- Validation (theme files are shared: treat them as untrusted) ----

const color = z.string().max(80).refine(isThemeColor, "Use an oklch() or #hex colour");
const clamped = (min: number, max: number) => z.number().finite().transform((n) => clamp(n, min, max));
const nearest = <T extends number>(allowed: readonly T[]) => z.number().finite().transform((n) => allowed.reduce((best, a) => (Math.abs(a - n) < Math.abs(best - n) ? a : best), allowed[0]!));
const family = z.string().trim().regex(FAMILY_RE, "A font family name");

const WallpaperSchema = z
  .object({
    kind: z.enum(["none", "color", "gradient", "image", "sky"]),
    value: z.string().max(600),
    colors: z.tuple([color, color]).optional(),
    blurPx: nearest([0, 8, 16, 32] as const),
    dim: clamped(0, 0.6),
    grain: clamped(0, 0.3).default(0),
    position: z.enum(["center", "top", "bottom"]).optional(),
  })
  .superRefine((w, ctx) => {
    const ok =
      w.kind === "none" ||
      (w.kind === "color" && isThemeColor(w.value)) ||
      (w.kind === "gradient" && isThemeGradient(w.value)) ||
      (w.kind === "image" && isUploadPath(w.value)) ||
      (w.kind === "sky" && Array.isArray(w.colors));
    if (!ok) ctx.addIssue({ code: "custom", path: ["value"], message: w.kind === "image" ? "Image wallpapers must be an /uploads/ path on this instance" : w.kind === "sky" ? "A sky wallpaper needs two colours" : `Not a valid ${w.kind} wallpaper` });
  });

const ColorSchema = z.object({
  surface: color, surfaceText: color, surfaceMuted: color, canvasText: color,
  accent: color, accentText: color,
  ok: color, warn: color, bad: color, info: color,
  line: color,
});
const SurfaceSchema = z.object({
  material: z.enum(["solid", "glass"]),
  opacity: clamped(0.3, 1),
  blurPx: clamped(0, 48),
  border: z.object({ widthPx: nearest([0, 1, 2] as const), color }),
  shadow: z.enum(["none", "soft", "hard"]),
  shadowOffsetPx: clamped(0, 12),
  titleBars: z.boolean(),
});
const TypeSchema = z.object({
  display: family, body: family, mono: family,
  scale: clamped(0.85, 1.3),
  numbers: z.enum(["tabular", "proportional"]),
  headingTracking: clamped(-0.06, 0.02),
  headingWeight: nearest([400, 500, 600, 700, 800] as const),
});
const ShapeSchema = z.object({ radiusPx: clamped(0, 32), controlRadiusPx: clamped(0, 999) });
const SpaceSchema = z.object({ gapPx: clamped(4, 40), padPx: clamped(8, 40), density: z.enum(["comfortable", "compact"]) });
const MotionSchema = z.object({ enter: z.enum(["none", "fade", "rise", "sweep"]), lightDrift: z.boolean() });
const ChromeSchema = z.object({ background: color, text: color, activeFill: color, activeText: color, style: z.enum(["bar", "boxed-tabs", "pills", "underline"]) });

export const ThemeTokensSchema = z.object({
  wallpaper: WallpaperSchema,
  color: ColorSchema,
  surface: SurfaceSchema,
  type: TypeSchema,
  shape: ShapeSchema,
  space: SpaceSchema,
  motion: MotionSchema,
  chrome: ChromeSchema,
});

export const MAX_CUSTOM_CSS_BYTES = 64 * 1024;
const MAX_FONT_BYTES_NOTE = "woff2 only, at most 2 MB each (checked by uploads)";

const ThemeFontSchema = z.object({
  family,
  file: z.string().refine((p) => isUploadPath(p) && /\.woff2$/i.test(p), `Fonts must be /uploads/*.woff2 (${MAX_FONT_BYTES_NOTE})`),
  weight: z.string().regex(/^[1-9]00(?: [1-9]00)?$/, "A weight such as 400, or a range such as 100 900"),
  style: z.enum(["normal", "italic"]),
});

export const ThemeSchema = z.object({
  atriumTheme: z.literal("2"),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Lowercase letters, digits and hyphens"),
  name: z.string().trim().min(1).max(80),
  author: z.string().trim().max(80),
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
  mode: z.enum(["light", "dark", "auto"]),
  tokens: ThemeTokensSchema,
  dark: z
    .object({ wallpaper: WallpaperSchema, color: ColorSchema, surface: SurfaceSchema, type: TypeSchema, shape: ShapeSchema, space: SpaceSchema, motion: MotionSchema, chrome: ChromeSchema })
    .partial()
    .optional(),
  fonts: z.array(ThemeFontSchema).max(8).optional(),
  customCss: z.string().max(MAX_CUSTOM_CSS_BYTES).optional(),
});

// ---- v3 import (design v4 section 2: map surface.tint to color.surface, fill the rest from Control Room) ----

const V3_FONTS = ["Inter", "Inter Tight", "Geist", "IBM Plex Sans", "Fraunces", "Space Grotesk"] as const;
export const ThemePackageV3Schema = z.object({
  atriumTheme: z.literal("1"),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(80),
  author: z.string().trim().max(80),
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
  tokens: z.object({
    wallpaper: z.object({ kind: z.enum(["none", "color", "gradient", "image"]), value: z.string().max(600), blurPx: nearest([0, 8, 16, 32] as const), dim: clamped(0, 0.6), position: z.enum(["center", "top", "bottom"]).optional() }),
    surface: z.object({ material: z.enum(["glass", "solid"]), tint: color, opacity: clamped(0.3, 1), blurPx: clamped(0, 48), border: z.boolean() }),
    text: z.object({ primary: color, muted: color }),
    accent: color,
    font: z.object({ ui: z.enum(V3_FONTS), numbers: z.enum(["tabular", "proportional"]) }),
    radiusPx: clamped(0, 32),
    gapPx: clamped(4, 32),
    density: z.enum(["comfortable", "compact"]),
    shadow: nearest([0, 1, 2, 3] as const),
    lightDrift: z.boolean(),
    hardShadowPx: clamped(0, 12).optional(),
  }),
  assets: z.array(z.string()).max(32).optional(),
  customCss: z.string().max(MAX_CUSTOM_CSS_BYTES).optional(),
});
/** @deprecated v3 theme package schema; v3 files import through parseTheme(). */
export const ThemePackageSchema = ThemePackageV3Schema;
export type ThemePackageV3 = z.infer<typeof ThemePackageV3Schema>;
/** @deprecated v3 name of the theme file type. */
export type ThemePackage = Theme;

/** Map a v3 theme package onto the v4 Theme (design v4 section 2, "Sharing"). */
export function themeFromV3(pkg: ThemePackageV3): Theme {
  const t = pkg.tokens;
  const darkText = (lightnessOf(t.text.primary) ?? 0) > 0.6;
  const base: ThemeTokens = darkText ? { ...CR_LIGHT, ...controlRoom.dark } : CR_LIGHT;
  const wallpaper: ThemeTokens["wallpaper"] = { ...t.wallpaper, grain: 0 };
  return {
    atriumTheme: "2",
    id: pkg.id, name: pkg.name, author: pkg.author, version: pkg.version,
    mode: darkText ? "dark" : "light",
    tokens: {
      ...base,
      wallpaper,
      color: { ...base.color, surface: t.surface.tint, surfaceText: t.text.primary, surfaceMuted: t.text.muted, canvasText: t.text.primary, accent: t.accent },
      surface: {
        ...base.surface,
        material: t.surface.material,
        opacity: t.surface.opacity,
        blurPx: t.surface.blurPx,
        border: { widthPx: t.surface.border ? 1 : 0, color: base.surface.border.color },
        shadow: (t.hardShadowPx ?? 0) > 0 ? "hard" : t.shadow > 0 ? "soft" : "none",
        shadowOffsetPx: t.hardShadowPx ?? 0,
        titleBars: false,
      },
      type: { ...base.type, display: t.font.ui, body: t.font.ui, numbers: t.font.numbers },
      shape: { radiusPx: t.radiusPx, controlRadiusPx: Math.min(t.radiusPx, 12) },
      space: { ...base.space, gapPx: t.gapPx, density: t.density },
      motion: { ...base.motion, lightDrift: t.lightDrift },
    },
    ...(pkg.customCss ? { customCss: pkg.customCss } : {}),
  };
}

export type ParsedTheme =
  | { ok: true; theme: Theme; warnings: ContrastWarning[]; importedFrom: "2" | "1" }
  | { ok: false; error: string; issues: { path: string; message: string }[] };

function issuesOf(e: z.ZodError) {
  const issues = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return { ok: false as const, error: issues[0] ? `${issues[0].path || "theme"}: ${issues[0].message}` : "Invalid theme", issues };
}

/**
 * Validate an imported theme.json. v4 files (`atriumTheme: "2"`) are validated and clamped; v3 files
 * (`"1"`) are validated with the v3 schema and mapped. Contrast under 4.5:1 comes back as warnings.
 * Custom CSS is NOT scoped here: it stays raw and is scoped on the server with scopeCustomCss().
 */
export function parseTheme(input: unknown): ParsedTheme {
  const version = (input as { atriumTheme?: unknown } | null)?.atriumTheme;
  if (version === "1") {
    const r = ThemePackageV3Schema.safeParse(input);
    if (!r.success) return issuesOf(r.error);
    const theme = themeFromV3(r.data);
    return { ok: true, theme, warnings: contrastReport(theme).warnings, importedFrom: "1" };
  }
  const r = ThemeSchema.safeParse(input);
  if (!r.success) return issuesOf(r.error);
  const theme = r.data as Theme;
  return { ok: true, theme, warnings: contrastReport(theme).warnings, importedFrom: "2" };
}
/** @deprecated v3 name of parseTheme(). */
export const parseThemePackage = parseTheme;

/** Build a theme around tokens (the editor's export). */
export function toTheme(meta: { id: string; name: string; author: string; version: string }, tokens: ThemeTokens, extra: Partial<Pick<Theme, "mode" | "dark" | "fonts" | "customCss">> = {}): Theme {
  return { atriumTheme: "2", ...meta, mode: extra.mode ?? "light", tokens, ...(extra.dark ? { dark: extra.dark } : {}), ...(extra.fonts ? { fonts: extra.fonts } : {}), ...(extra.customCss ? { customCss: extra.customCss } : {}) };
}
/** @deprecated v3 name of toTheme(). */
export const toThemePackage = toTheme;
