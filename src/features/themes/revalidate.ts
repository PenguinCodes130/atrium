// Theme revalidation (settings spec 3.5, the carried app-shell gauntlet r3 customisation M2).
//
// Every time theme CSS is produced for a canvas, and every time theme values are sent to an HTML block,
// the theme goes through revalidateTheme() first, whatever its source: a saved theme, a copy held by a
// version or draft, an imported app file, a shared theme file, an older format file, an agent draft or
// a value written straight into storage. A value that fails is replaced by Control Room's value for
// that field (numbers outside a range are clamped), never passed through. Free text (names, authors)
// never reaches CSS at all; font family names reach it only when they are one of the ten built-in
// families or a family the theme declares with an uploaded woff2 file.
//
// Pure module: no DOM, no Node APIs, safe on the server and in the browser.
import type { Theme, ThemeTokens } from "@/core/contracts";
import { controlRoom, isThemeColor, isThemeGradient, isUploadPath, THEME_FONTS } from "@/features/shell";
import { controlRadiusOf } from "@/features/shell/theme";

export const BUILT_IN_THEME_IDS = ["control-room", "dusk", "solid", "daylight"] as const;
export type BuiltInId = (typeof BUILT_IN_THEME_IDS)[number];
export const DEFAULT_THEME_ID: BuiltInId = "control-room";

const CR = controlRoom.tokens;
const CR_DARK: ThemeTokens = { ...controlRoom.tokens, ...controlRoom.dark } as ThemeTokens;

export const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const WEIGHT_RE = /^[1-9]00(?: [1-9]00)?$/;
export const MAX_THEME_CSS = 64 * 1024;
export const MAX_THEME_FONTS = 8;

type Ctx = { replaced: number; fields: string[] };

function bad<T>(ctx: Ctx, path: string, fb: T): T {
  ctx.replaced++;
  ctx.fields.push(path);
  return fb;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function color(ctx: Ctx, path: string, v: unknown, fb: string): string {
  return typeof v === "string" && v.length <= 80 && isThemeColor(v) ? v.trim() : bad(ctx, path, fb);
}

function num(ctx: Ctx, path: string, v: unknown, min: number, max: number, fb: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return bad(ctx, path, fb);
  if (v < min) return bad(ctx, path, min);
  if (v > max) return bad(ctx, path, max);
  return v;
}

function nearest<T extends number>(ctx: Ctx, path: string, v: unknown, allowed: readonly T[], fb: T): T {
  if (typeof v !== "number" || !Number.isFinite(v)) return bad(ctx, path, fb);
  if ((allowed as readonly number[]).includes(v)) return v as T;
  const near = allowed.reduce((best, a) => (Math.abs(a - v) < Math.abs(best - v) ? a : best), allowed[0]!);
  return bad(ctx, path, near);
}

function oneOf<T extends string>(ctx: Ctx, path: string, v: unknown, allowed: readonly T[], fb: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : bad(ctx, path, fb);
}

function bool(ctx: Ctx, path: string, v: unknown, fb: boolean): boolean {
  return typeof v === "boolean" ? v : bad(ctx, path, fb);
}

function family(ctx: Ctx, path: string, v: unknown, uploaded: readonly string[], fb: string): string {
  if (typeof v === "string" && ((THEME_FONTS as readonly string[]).includes(v) || (FAMILY_RE.test(v) && uploaded.includes(v)))) return v;
  return bad(ctx, path, fb);
}

function wallpaper(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens["wallpaper"]): ThemeTokens["wallpaper"] {
  const w = obj(raw);
  if (!w) {
    bad(ctx, p, null);
    return { ...fb };
  }
  let kind = oneOf(ctx, `${p}.kind`, w.kind, ["none", "color", "gradient", "image", "sky"] as const, fb.kind);
  let value = typeof w.value === "string" && w.value.length <= 600 ? w.value.trim() : "";
  let colors: [string, string] | undefined;
  if (Array.isArray(w.colors) && w.colors.length === 2 && w.colors.every((c) => typeof c === "string" && c.length <= 80 && isThemeColor(c))) {
    colors = [(w.colors[0] as string).trim(), (w.colors[1] as string).trim()];
  } else if (w.colors !== undefined) {
    bad(ctx, `${p}.colors`, null);
  }
  const valueOk =
    kind === "none" ||
    (kind === "color" && isThemeColor(value)) ||
    (kind === "gradient" && isThemeGradient(value)) ||
    (kind === "image" && isUploadPath(value)) ||
    (kind === "sky" && colors !== undefined);
  if (!valueOk) {
    bad(ctx, `${p}.value`, null);
    kind = fb.kind;
    value = fb.value;
    colors = fb.colors;
  }
  if (kind === "none") value = typeof value === "string" ? "" : "";
  const out: ThemeTokens["wallpaper"] = {
    kind,
    value: kind === "sky" ? (isThemeColor(value) ? value : "") : value,
    blurPx: nearest(ctx, `${p}.blurPx`, w.blurPx, [0, 8, 16, 32] as const, fb.blurPx),
    dim: num(ctx, `${p}.dim`, w.dim, 0, 0.6, fb.dim),
    grain: w.grain === undefined ? 0 : num(ctx, `${p}.grain`, w.grain, 0, 0.3, fb.grain),
  };
  if (colors) out.colors = colors;
  if (w.position !== undefined) out.position = oneOf(ctx, `${p}.position`, w.position, ["center", "top", "bottom"] as const, "center");
  return out;
}

const COLOR_KEYS = ["surface", "surfaceText", "surfaceMuted", "canvasText", "accent", "accentText", "ok", "warn", "bad", "info", "line"] as const;

function colorGroup(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens["color"]): ThemeTokens["color"] {
  const c = obj(raw) ?? {};
  if (!obj(raw)) bad(ctx, p, null);
  const out = {} as ThemeTokens["color"];
  for (const k of COLOR_KEYS) out[k] = obj(raw) ? color(ctx, `${p}.${k}`, c[k], fb[k]) : fb[k];
  return out;
}

function surfaceGroup(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens["surface"]): ThemeTokens["surface"] {
  const s = obj(raw);
  if (!s) return bad(ctx, p, { ...fb, border: { ...fb.border } });
  const b = obj(s.border);
  if (!b) bad(ctx, `${p}.border`, null);
  return {
    material: oneOf(ctx, `${p}.material`, s.material, ["solid", "glass"] as const, fb.material),
    opacity: num(ctx, `${p}.opacity`, s.opacity, 0.3, 1, fb.opacity),
    blurPx: num(ctx, `${p}.blurPx`, s.blurPx, 0, 48, fb.blurPx),
    border: b
      ? { widthPx: nearest(ctx, `${p}.border.widthPx`, b.widthPx, [0, 1, 2] as const, fb.border.widthPx), color: color(ctx, `${p}.border.color`, b.color, fb.border.color) }
      : { ...fb.border },
    shadow: oneOf(ctx, `${p}.shadow`, s.shadow, ["none", "soft", "hard"] as const, fb.shadow),
    shadowOffsetPx: num(ctx, `${p}.shadowOffsetPx`, s.shadowOffsetPx, 0, 12, fb.shadowOffsetPx),
    titleBars: bool(ctx, `${p}.titleBars`, s.titleBars, fb.titleBars),
  };
}

function typeGroup(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens["type"], uploaded: readonly string[]): ThemeTokens["type"] {
  const t = obj(raw);
  if (!t) return bad(ctx, p, { ...fb });
  return {
    display: family(ctx, `${p}.display`, t.display, uploaded, fb.display),
    body: family(ctx, `${p}.body`, t.body, uploaded, fb.body),
    mono: family(ctx, `${p}.mono`, t.mono, uploaded, fb.mono),
    scale: num(ctx, `${p}.scale`, t.scale, 0.85, 1.3, fb.scale),
    numbers: oneOf(ctx, `${p}.numbers`, t.numbers, ["tabular", "proportional"] as const, fb.numbers),
    headingTracking: num(ctx, `${p}.headingTracking`, t.headingTracking, -0.06, 0.02, fb.headingTracking),
    headingWeight: nearest(ctx, `${p}.headingWeight`, t.headingWeight, [400, 500, 600, 700, 800] as const, fb.headingWeight),
  };
}

function shapeGroup(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens["shape"]): ThemeTokens["shape"] {
  const s = obj(raw);
  if (!s) return bad(ctx, p, { ...fb });
  // A11.5 (Wave 2.10 B3): 0 to 24 px or 999 for Pill. A stored 25 to 998 reads as Pill; that is a
  // change of meaning, not an invalid value, so it is not counted as replaced.
  return { radiusPx: num(ctx, `${p}.radiusPx`, s.radiusPx, 0, 32, fb.radiusPx), controlRadiusPx: controlRadiusOf(num(ctx, `${p}.controlRadiusPx`, s.controlRadiusPx, 0, 999, fb.controlRadiusPx)) };
}

function spaceGroup(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens["space"]): ThemeTokens["space"] {
  const s = obj(raw);
  if (!s) return bad(ctx, p, { ...fb });
  return {
    gapPx: num(ctx, `${p}.gapPx`, s.gapPx, 4, 40, fb.gapPx),
    padPx: num(ctx, `${p}.padPx`, s.padPx, 8, 40, fb.padPx),
    density: oneOf(ctx, `${p}.density`, s.density, ["comfortable", "compact"] as const, fb.density),
  };
}

function motionGroup(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens["motion"]): ThemeTokens["motion"] {
  const m = obj(raw);
  if (!m) return bad(ctx, p, { ...fb });
  return { enter: oneOf(ctx, `${p}.enter`, m.enter, ["none", "fade", "rise", "sweep"] as const, fb.enter), lightDrift: bool(ctx, `${p}.lightDrift`, m.lightDrift, fb.lightDrift) };
}

function chromeGroup(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens["chrome"]): ThemeTokens["chrome"] {
  const c = obj(raw);
  if (!c) return bad(ctx, p, { ...fb });
  return {
    background: color(ctx, `${p}.background`, c.background, fb.background),
    text: color(ctx, `${p}.text`, c.text, fb.text),
    activeFill: color(ctx, `${p}.activeFill`, c.activeFill, fb.activeFill),
    activeText: color(ctx, `${p}.activeText`, c.activeText, fb.activeText),
    style: oneOf(ctx, `${p}.style`, c.style, ["bar", "boxed-tabs", "pills", "underline"] as const, fb.style),
  };
}

function tokens(ctx: Ctx, p: string, raw: unknown, fb: ThemeTokens, uploaded: readonly string[]): ThemeTokens {
  const t = obj(raw) ?? {};
  if (!obj(raw)) bad(ctx, p, null);
  return {
    wallpaper: wallpaper(ctx, `${p}.wallpaper`, t.wallpaper, fb.wallpaper),
    color: colorGroup(ctx, `${p}.color`, t.color, fb.color),
    surface: surfaceGroup(ctx, `${p}.surface`, t.surface, fb.surface),
    type: typeGroup(ctx, `${p}.type`, t.type, fb.type, uploaded),
    shape: shapeGroup(ctx, `${p}.shape`, t.shape, fb.shape),
    space: spaceGroup(ctx, `${p}.space`, t.space, fb.space),
    motion: motionGroup(ctx, `${p}.motion`, t.motion, fb.motion),
    chrome: chromeGroup(ctx, `${p}.chrome`, t.chrome, fb.chrome),
  };
}

/** Partial dark set: only the groups present are kept, each validated against Control Room's dark set. */
function darkSet(ctx: Ctx, raw: unknown, uploaded: readonly string[]): Partial<ThemeTokens> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const d = obj(raw);
  if (!d) return bad(ctx, "dark", undefined);
  const out: Partial<ThemeTokens> = {};
  if (d.wallpaper !== undefined) out.wallpaper = wallpaper(ctx, "dark.wallpaper", d.wallpaper, CR_DARK.wallpaper);
  if (d.color !== undefined) out.color = colorGroup(ctx, "dark.color", d.color, CR_DARK.color);
  if (d.surface !== undefined) out.surface = surfaceGroup(ctx, "dark.surface", d.surface, CR_DARK.surface);
  if (d.type !== undefined) out.type = typeGroup(ctx, "dark.type", d.type, CR_DARK.type, uploaded);
  if (d.shape !== undefined) out.shape = shapeGroup(ctx, "dark.shape", d.shape, CR_DARK.shape);
  if (d.space !== undefined) out.space = spaceGroup(ctx, "dark.space", d.space, CR_DARK.space);
  if (d.motion !== undefined) out.motion = motionGroup(ctx, "dark.motion", d.motion, CR_DARK.motion);
  if (d.chrome !== undefined) out.chrome = chromeGroup(ctx, "dark.chrome", d.chrome, CR_DARK.chrome);
  return out;
}

function fonts(ctx: Ctx, raw: unknown): NonNullable<Theme["fonts"]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return bad(ctx, "fonts", undefined);
  const out: NonNullable<Theme["fonts"]> = [];
  raw.forEach((f, i) => {
    const o = obj(f);
    const ok =
      o &&
      typeof o.family === "string" && FAMILY_RE.test(o.family) && !(THEME_FONTS as readonly string[]).includes(o.family) &&
      typeof o.file === "string" && isUploadPath(o.file) && /\.woff2$/i.test(o.file) &&
      typeof o.weight === "string" && WEIGHT_RE.test(o.weight) &&
      (o.style === "normal" || o.style === "italic");
    if (!ok || out.length >= MAX_THEME_FONTS) {
      bad(ctx, `fonts.${i}`, null);
      return;
    }
    out.push({ family: o.family as string, file: o.file as string, weight: o.weight as string, style: o.style as "normal" | "italic" });
  });
  return out;
}

/** Free text: shown as text only (React escapes it). Control characters go; length is capped. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return s.length ? s : null;
}

export type Revalidated = { theme: Theme; replaced: number; fields: string[] };

/**
 * Parse any stored or received theme and check every value again against the design v4 ranges and
 * choices. Never throws: what fails is replaced (Control Room's value) or clamped, and counted.
 */
export function revalidateTheme(raw: unknown, opts: { id?: string } = {}): Revalidated {
  const ctx: Ctx = { replaced: 0, fields: [] };
  const t = obj(raw) ?? {};
  if (!obj(raw)) bad(ctx, "theme", null);
  const fontList = fonts(ctx, t.fonts);
  const uploaded = (fontList ?? []).map((f) => f.family);
  const idIn = opts.id ?? t.id;
  const id = typeof idIn === "string" && THEME_ID_RE.test(idIn) ? idIn : bad(ctx, "id", DEFAULT_THEME_ID);
  const name = cleanText(t.name, 80) ?? bad(ctx, "name", "Untitled theme");
  const author = typeof t.author === "string" ? (cleanText(t.author, 80) ?? "") : bad(ctx, "author", "");
  const version = typeof t.version === "string" && VERSION_RE.test(t.version) ? t.version : bad(ctx, "version", "1");
  const mode = oneOf(ctx, "mode", t.mode, ["light", "dark", "auto"] as const, "light");
  const base = tokens(ctx, "tokens", t.tokens, mode === "dark" ? CR_DARK : CR, uploaded);
  const dark = darkSet(ctx, t.dark, uploaded);
  let customCss: string | undefined;
  if (t.customCss !== undefined && t.customCss !== null) {
    if (typeof t.customCss === "string" && t.customCss.length <= MAX_THEME_CSS) customCss = t.customCss;
    else bad(ctx, "customCss", null);
  }
  if (t.atriumTheme !== "2" && t.atriumTheme !== undefined) bad(ctx, "atriumTheme", null);
  const theme: Theme = { atriumTheme: "2", id, name, author, version, mode, tokens: base };
  if (dark && Object.keys(dark).length) theme.dark = dark;
  if (fontList && fontList.length) theme.fonts = fontList;
  if (customCss) theme.customCss = customCss;
  return { theme, replaced: ctx.replaced, fields: ctx.fields };
}

export function isBuiltInId(id: string): id is BuiltInId {
  return (BUILT_IN_THEME_IDS as readonly string[]).includes(id);
}
