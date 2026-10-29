// "Make a dark set" (Wave 2.10 B6, architecture A11.5): a full dark token set filled from a theme's light
// set, for the person to adjust. Surfaces and the wallpaper go dark, text goes light, the accent stays
// the same, and the result is nudged until it passes the editor's contrast check (4.5:1 for the four
// text pairs, measured the way tokenContrast measures them, glass over its backdrops).
//
// Pure module: no DOM, safe in the browser and on the server.
import type { ThemeTokens } from "@/core/contracts";
import { colorToRgba, isThemeColor, toOklch, tokenContrast } from "@/features/shell/theme";

const r3 = (n: number) => +n.toFixed(3);

/** A colour at a new OKLCH lightness, chroma scaled, hue and alpha kept. Unknown colours pass through. */
function atL(color: string, l: number, chroma = 1): string {
  const o = toOklch(color);
  if (!o) return color;
  const c = r3(Math.min(0.37, o.c * chroma));
  const a = o.a < 1 ? ` / ${r3(o.a)}` : "";
  return `oklch(${r3(Math.min(1, Math.max(0, l)))} ${c} ${r3(o.h)}${a})`;
}
const lOf = (color: string) => toOklch(color)?.l ?? 0.5;
const withAlpha = (color: string, a: number) => {
  const o = toOklch(color);
  return o ? `oklch(${r3(o.l)} ${r3(o.c)} ${r3(o.h)} / ${r3(a)})` : color;
};
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** A light wallpaper colour's dark counterpart: L 0.97 goes to about 0.16; dark colours stay. */
const darkGround = (c: string) => (lOf(c) < 0.4 ? c : atL(c, Math.min(0.3, 0.14 + (1 - lOf(c)) * 0.6), 0.7));

function darkWallpaper(w: ThemeTokens["wallpaper"]): ThemeTokens["wallpaper"] {
  switch (w.kind) {
    case "color":
      return { ...w, value: isThemeColor(w.value) ? darkGround(w.value) : w.value };
    case "gradient": {
      const value = w.value.replace(/oklch\([^)]*\)|#[0-9a-f]{3,8}\b/gi, (m) => darkGround(m));
      return { ...w, value, ...(w.colors ? { colors: w.colors.map(darkGround) as [string, string] } : {}) };
    }
    case "sky":
      return { ...w, ...(w.colors ? { colors: w.colors.map(darkGround) as [string, string] } : {}) };
    case "image":
      // An image cannot be recoloured: it is dimmed instead.
      return { ...w, dim: Math.max(w.dim, 0.45) };
    default:
      return { ...w };
  }
}

/** The first fill of a dark set, before the contrast pass. */
function firstFill(light: ThemeTokens): ThemeTokens {
  const c = light.color;
  const surface = atL(c.surface, 0.22, 0.5);
  const surfaceText = atL(c.surfaceText, 0.95, 0.3);
  const lift = (x: string) => (lOf(x) >= 0.74 ? x : atL(x, 0.76, 1));
  const color: ThemeTokens["color"] = {
    surface,
    surfaceText,
    surfaceMuted: atL(c.surfaceMuted, 0.82, 0.3),
    canvasText: atL(c.canvasText, 0.95, 0.3),
    accent: c.accent,
    accentText: c.accentText,
    ok: lift(c.ok),
    warn: lift(c.warn),
    bad: lift(c.bad),
    info: lift(c.info),
    line: withAlpha(surfaceText, Math.max(0.12, Math.min(0.3, toOklch(c.line)?.a ?? 0.16))),
  };
  const wallpaper = darkWallpaper(light.wallpaper);
  const b = light.surface.border;
  const border = { ...b, color: lOf(b.color) < 0.5 ? withAlpha(surfaceText, 0.3) : b.color };
  const ch = light.chrome;
  const chromeBg = same(ch.background, light.wallpaper.value) && wallpaper.kind === "color" ? wallpaper.value : same(ch.background, c.surface) ? surface : atL(ch.background, 0.2, 0.5);
  const activeFill = same(ch.activeFill, c.accent) ? c.accent : lOf(ch.activeFill) < 0.5 ? surfaceText : ch.activeFill;
  const activeText = same(ch.activeText, c.accentText) ? c.accentText : lOf(activeFill) > 0.6 ? atL(ch.activeText, 0.18, 0.5) : atL(ch.activeText, 0.96, 0.3);
  return {
    ...light,
    wallpaper,
    color,
    surface: { ...light.surface, border },
    chrome: { ...ch, background: chromeBg, text: surfaceText, activeFill, activeText },
    type: { ...light.type },
    shape: { ...light.shape },
    space: { ...light.space },
    motion: { ...light.motion },
  };
}

/**
 * A full dark set (every token group) from a light set, passing the contrast check. Each step of the
 * contrast pass changes only what the failing pair needs: darker surface, lighter text, more wallpaper
 * dim, then (glass only) a more opaque surface; text on the accent becomes near black or near white.
 */
export function makeDarkSet(light: ThemeTokens): ThemeTokens {
  // Wave 2.10a r2 (low L7): the made set is written in hex, like the built-in light sets, so the
  // editor shows "#1D1A15" rather than a cut-off oklch string. The contrast pass runs again on the hex
  // values (rounding to 8 bits can move a ratio by a hair).
  let t = firstFill(light);
  for (let round = 0; round < 3; round++) {
    t = contrastPass(t);
    const hex = asHex(t, [light.color.accent, light.color.accentText]);
    const settled = !tokenContrast(hex, "dark").warnings.length;
    t = hex;
    if (settled) break;
  }
  if (same(light.chrome.background, light.color.surface)) t.chrome = { ...t.chrome, background: t.color.surface };
  if (!same(light.chrome.activeFill, light.color.accent) && lOf(light.chrome.activeFill) < 0.5) t.chrome = { ...t.chrome, activeFill: t.color.surfaceText };
  t.chrome = { ...t.chrome, text: t.color.surfaceText };
  return t;
}

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0").toUpperCase();
/** A theme colour as #RRGGBB, or #RRGGBBAA when it has alpha. Hex input is kept as written. */
export function hexColour(color: string): string {
  if (/^#[0-9a-f]{3,8}$/i.test(color.trim())) return color.trim();
  const c = colorToRgba(color);
  if (!c) return color;
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${c.a < 1 ? byte(c.a) : ""}`;
}
/**
 * Every colour of a token set in hex: colours, border, nav chrome and the wallpaper's own colours. The
 * light set's accent and its text stay exactly as written (the dark set shares the accent).
 */
function asHex(t: ThemeTokens, keep: string[]): ThemeTokens {
  const hexColourKeep = (v: string) => (keep.some((k) => same(k, v)) ? v : hexColour(v));
  const color = Object.fromEntries(Object.entries(t.color).map(([k, v]) => [k, hexColourKeep(v)])) as ThemeTokens["color"];
  const w = t.wallpaper;
  const wallpaper: ThemeTokens["wallpaper"] = {
    ...w,
    ...(w.kind === "color" && isThemeColor(w.value) ? { value: hexColour(w.value) } : {}),
    ...(w.kind === "gradient" ? { value: w.value.replace(/oklch\([^)]*\)/gi, (m) => hexColour(m)) } : {}),
    ...(w.colors ? { colors: w.colors.map(hexColour) as [string, string] } : {}),
  };
  const ch = t.chrome;
  return {
    ...t,
    color,
    wallpaper,
    surface: { ...t.surface, border: { ...t.surface.border, color: hexColour(t.surface.border.color) } },
    chrome: { ...ch, background: hexColour(ch.background), text: hexColour(ch.text), activeFill: hexColourKeep(ch.activeFill), activeText: hexColourKeep(ch.activeText) },
  };
}

function contrastPass(t: ThemeTokens): ThemeTokens {
  t = structuredClone(t);
  for (let i = 0; i < 40; i++) {
    const r = tokenContrast(t, "dark");
    if (!r.warnings.length) break;
    for (const w of r.warnings) {
      if (w.field === "color.accentText") {
        const black = "oklch(0.18 0 0)", white = "oklch(0.98 0 0)";
        const try1 = tokenContrast({ ...t, color: { ...t.color, accentText: black } }, "dark").accentText;
        const try2 = tokenContrast({ ...t, color: { ...t.color, accentText: white } }, "dark").accentText;
        t.color.accentText = try1 >= try2 ? black : white;
      } else if (w.field === "color.canvasText") {
        if (lOf(t.color.canvasText) < 0.99) t.color.canvasText = atL(t.color.canvasText, lOf(t.color.canvasText) + 0.02, 0.5);
        else if (t.wallpaper.dim < 0.6) t.wallpaper = { ...t.wallpaper, dim: r3(Math.min(0.6, t.wallpaper.dim + 0.05)) };
        else if (t.wallpaper.kind === "color") t.wallpaper = { ...t.wallpaper, value: atL(t.wallpaper.value, lOf(t.wallpaper.value) - 0.03) };
      } else {
        const key = w.field === "color.surfaceText" ? "surfaceText" : "surfaceMuted";
        if (lOf(t.color.surface) > 0.12) t.color.surface = atL(t.color.surface, lOf(t.color.surface) - 0.02);
        else if (lOf(t.color[key]) < 0.97) t.color[key] = atL(t.color[key], lOf(t.color[key]) + 0.02, 0.5);
        else if (t.wallpaper.dim < 0.6) t.wallpaper = { ...t.wallpaper, dim: r3(Math.min(0.6, t.wallpaper.dim + 0.05)) };
        else if (t.surface.material === "glass" && t.surface.opacity < 1) t.surface = { ...t.surface, opacity: r3(Math.min(1, t.surface.opacity + 0.05)) };
      }
    }
  }
  return t;
}
