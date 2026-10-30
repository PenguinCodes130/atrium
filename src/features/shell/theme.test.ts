// Design v4 section 2 themes (round 4, Fix 7): the four built-ins value for value, every v4 token as a
// --theme-* property, auto mode, fonts, the v4 schema and the v3 import.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_THEMES,
  THEME_FONTS,
  THEME_FONT_KINDS,
  selfHostedFontSlug,
  THEME_FONT_STACKS,
  contrastReport,
  controlRoom,
  daylight,
  dusk,
  fontStack,
  isThemeGradient,
  isUploadPath,
  parseTheme,
  resolveTokens,
  solid,
  themeCanvasCss,
  themeFontFaces,
  themeFromV3,
  themeToCssVars,
  toTheme,
  tokensToCssVars,
  type Theme,
  type ThemeTokens,
} from "./theme";

const APP_DIR = path.resolve(__dirname, "../../..");

/** Every v4 token has a property (gauntlet r2 customisation M2's list, plus the remaining fields). */
const V4_VARS = [
  "--theme-wallpaper", "--theme-wallpaper-blur", "--theme-wallpaper-dim", "--theme-wallpaper-grain", "--theme-wallpaper-position",
  "--theme-surface", "--theme-surface-text", "--theme-surface-muted", "--theme-canvas-text",
  "--theme-accent", "--theme-accent-text", "--theme-accent-ink",
  "--theme-ok", "--theme-warn", "--theme-bad", "--theme-info", "--theme-line",
  "--theme-surface-opacity", "--theme-surface-fill", "--theme-surface-blur", "--theme-surface-image", // F12
  "--theme-border-width", "--theme-border-color", "--theme-shadow-kind", "--theme-shadow-offset", "--theme-shadow", "--theme-title-bars",
  "--theme-font-display", "--theme-font-body", "--theme-font-mono", "--theme-type-scale", "--theme-numbers", "--theme-heading-tracking", "--theme-heading-weight",
  "--theme-radius", "--theme-control-radius",
  "--theme-gap", "--theme-pad", "--theme-pad-phone", "--theme-density",
  "--theme-density-k", "--theme-control-h", "--theme-titlebar-h", // Wave 2.10 B4 (A11.5)
  // Wave 2.10a r2 item 4: density sizes for nav items, service tiles and group headings (densitySizes)
  "--theme-nav-item-h", "--theme-nav-bar-h", "--theme-nav-pad-y", "--theme-nav-pad-x", "--theme-nav-gap", "--theme-tile-pad-y", "--theme-tile-pad-x", "--theme-tile-gap", "--theme-tile-icon", "--theme-group-head-h",
  "--theme-motion-enter",
  "--theme-chrome-bg", "--theme-chrome-text", "--theme-chrome-active-fill", "--theme-chrome-active-text", "--theme-chrome-style",
  "--theme-chrome-material", "--theme-chrome-fill", "--theme-chrome-blur", "--theme-chrome-image", // Wave 2.10b F12 (A11.5)
  "--theme-glow", "--theme-room-shaft", "--theme-room-shaft-dim",
];

describe("built-in themes match the design v4 table, row by row", () => {
  it("Control Room: light with a dark set; paper #F3EFE4, grain 0.08; solid #FBF9F3, 1px ink border, hard 6px, title bars; #E9B949; Inter Tight / Geist Mono, 600, -0.04em", () => {
    const t = controlRoom.tokens;
    expect(controlRoom.mode).toBe("light");
    expect(controlRoom.dark).toBeDefined();
    expect(t.wallpaper).toMatchObject({ kind: "color", value: "#F3EFE4", grain: 0.08 });
    expect(t.surface).toEqual({ material: "solid", opacity: 1, blurPx: 0, border: { widthPx: 1, color: "#15130F" }, shadow: "hard", shadowOffsetPx: 6, titleBars: true });
    expect(t.color.surface).toBe("#FBF9F3");
    expect(t.color.accent).toBe("#E9B949");
    expect(t.type).toMatchObject({ display: "Inter Tight", body: "Inter Tight", mono: "Geist Mono", headingWeight: 600, headingTracking: -0.04 });
    expect(t.shape.radiusPx).toBe(0);
    expect(t.motion).toEqual({ enter: "sweep", lightDrift: true });
    // the dark set: ink ground, gold accent (shadows turn gold in the dark tone)
    expect(resolveTokens({ ...controlRoom, mode: "auto" }, "dark").wallpaper.value).toBe("#15130F");
    expect(tokensToCssVars(resolveTokens({ ...controlRoom, mode: "auto" }, "dark"), "dark")["--theme-shadow"]).toBe("6px 6px 0 0 color-mix(in oklab, #E9B949 90%, transparent)");
  });

  it("Dusk: dark; gradient oklch(0.30 0.05 40) to oklch(0.18 0.03 280); glass oklch(0.22 0.01 60) at 0.72, blur 28, soft shadow, radius 16; oklch(0.78 0.13 60); Inter / Geist Mono", () => {
    const t = dusk.tokens;
    expect(dusk.mode).toBe("dark");
    expect(t.wallpaper).toMatchObject({ kind: "gradient", value: "linear-gradient(to bottom, oklch(0.30 0.05 40), oklch(0.18 0.03 280))" });
    expect(t.surface).toMatchObject({ material: "glass", opacity: 0.72, blurPx: 28, shadow: "soft" });
    expect(t.color.surface).toBe("oklch(0.22 0.01 60)");
    expect(t.shape.radiusPx).toBe(16);
    expect(t.color.accent).toBe("oklch(0.78 0.13 60)");
    expect([t.type.display, t.type.body, t.type.mono]).toEqual(["Inter", "Inter", "Geist Mono"]);
    expect(t.motion.lightDrift).toBe(false);
  });

  it("Solid: light; colour #F2F1EE; solid white, 1px border, no shadow, radius 8; #2F6FB0; Atkinson Hyperlegible; no transparency or motion", () => {
    const t = solid.tokens;
    expect(solid.mode).toBe("light");
    expect(t.wallpaper).toMatchObject({ kind: "color", value: "#F2F1EE" });
    expect(t.surface).toMatchObject({ material: "solid", opacity: 1, shadow: "none", border: { widthPx: 1 } });
    expect(t.color.surface).toBe("#FFFFFF");
    expect(t.shape.radiusPx).toBe(8);
    expect(t.color.accent).toBe("#2F6FB0");
    expect([t.type.display, t.type.body]).toEqual(["Atkinson Hyperlegible", "Atkinson Hyperlegible"]);
    expect(t.motion).toEqual({ enter: "none", lightDrift: false });
  });

  it("Daylight: light; gradient oklch(0.97 0.02 85) to oklch(0.93 0.03 230); glass white at 0.74, blur 24, soft shadow, radius 20; #E9B949; Inter", () => {
    const t = daylight.tokens;
    expect(daylight.mode).toBe("light");
    expect(t.wallpaper).toMatchObject({ kind: "gradient", value: "linear-gradient(to bottom, oklch(0.97 0.02 85), oklch(0.93 0.03 230))" });
    expect(t.surface).toMatchObject({ material: "glass", opacity: 0.74, blurPx: 24, shadow: "soft" });
    expect(t.color.surface).toBe("oklch(1 0 0)");
    expect(t.shape.radiusPx).toBe(20);
    expect(t.color.accent).toBe("#E9B949");
    expect(t.type.body).toBe("Inter");
    expect(t.motion.lightDrift).toBe(true);
  });

  it("every built-in passes the 4.5:1 checks for surfaceText, surfaceMuted, canvasText and accentText (Control Room also in its dark set)", () => {
    for (const [id, t] of Object.entries(BUILT_IN_THEMES)) expect(contrastReport(t).warnings, id).toEqual([]);
    expect(contrastReport({ ...controlRoom, mode: "auto" }).warnings).toEqual([]);
  });

  it("all are valid v4 theme files", () => {
    for (const t of Object.values(BUILT_IN_THEMES)) expect(parseTheme(JSON.parse(JSON.stringify(t))).ok, t.id).toBe(true);
  });
});

describe("themeToCssVars", () => {
  it("emits a non-empty --theme-* property for every v4 token, for all four themes", () => {
    for (const t of Object.values(BUILT_IN_THEMES)) {
      const { base, dark } = themeToCssVars(t);
      expect(Object.keys(base).sort()).toEqual([...V4_VARS].sort());
      for (const [k, v] of Object.entries(base)) expect(v, `${t.id} ${k}`).not.toBe("");
      expect(dark).toBeNull();
    }
  });

  it("writes the expected values", () => {
    const cr = themeToCssVars(controlRoom).base;
    expect(cr["--theme-shadow"]).toBe("6px 6px 0 0 #15130F");
    expect(cr["--theme-border-width"]).toBe("1px");
    expect(cr["--theme-title-bars"]).toBe("1");
    expect(cr["--theme-wallpaper-grain"]).toBe("0.08");
    expect(cr["--theme-font-display"]).toBe(THEME_FONT_STACKS["Inter Tight"]);
    expect(cr["--theme-font-mono"]).toBe(THEME_FONT_STACKS["Geist Mono"]);
    expect(cr["--theme-heading-tracking"]).toBe("-0.04em");
    expect(cr["--theme-accent-ink"]).toMatch(/^oklch\(0\.52 /); // gold darkened to text strength on paper
    const d = themeToCssVars(dusk).base;
    expect(d["--theme-surface-fill"]).toBe("color-mix(in oklab, oklch(0.22 0.01 60) 72%, transparent)");
    expect(d["--theme-surface-blur"]).toBe("28px");
    expect(d["--theme-radius"]).toBe("16px");
    expect(d["--theme-shadow-kind"]).toBe("soft");
    const s = themeToCssVars(solid).base;
    expect(s["--theme-font-body"]).toBe(THEME_FONT_STACKS["Atkinson Hyperlegible"]);
    expect(s["--theme-font-mono"]).toBe(THEME_FONT_STACKS["JetBrains Mono"]);
    expect(s["--theme-shadow"]).toBe("none");
    expect(s["--theme-surface-fill"]).toBe("#FFFFFF");
    expect(s["--theme-motion-enter"]).toBe("none");
    expect(s["--theme-chrome-style"]).toBe("underline");
  });

  it("emits a dark set only for mode auto", () => {
    const auto: Theme = { ...controlRoom, mode: "auto" };
    const { base, dark } = themeToCssVars(auto);
    expect(base["--theme-surface"]).toBe("#FBF9F3");
    expect(dark?.["--theme-surface"]).toBe("#1D1A15");
    expect(dark?.["--theme-canvas-text"]).toBe("#F3EFE4");
  });

  // Wave 2.10 B4: padding 99 clamps to 40, then compact density takes it to two thirds (26 px).
  it("is deterministic and clamps out-of-range numbers", () => {
    expect(themeToCssVars(daylight)).toEqual(themeToCssVars(structuredClone(daylight)));
    const t = daylight.tokens;
    const v = tokensToCssVars({ ...t, shape: { radiusPx: 400, controlRadiusPx: -3 }, space: { gapPx: -5, padPx: 99, density: "compact" }, wallpaper: { ...t.wallpaper, dim: 3, blurPx: 7 as 8, grain: 4 }, surface: { ...t.surface, opacity: 0.01, blurPx: 900 }, type: { ...t.type, scale: 9, headingTracking: -1 } }, "light");
    expect([v["--theme-radius"], v["--theme-control-radius"], v["--theme-gap"], v["--theme-pad"], v["--theme-wallpaper-dim"], v["--theme-wallpaper-blur"], v["--theme-wallpaper-grain"], v["--theme-surface-opacity"], v["--theme-surface-blur"], v["--theme-type-scale"], v["--theme-heading-tracking"]]).toEqual(["32px", "0px", "4px", "26px", "0.6", "0px", "0.3", "0.3", "48px", "1.3", "-0.06em"]);
  });

  it("never emits an unsafe wallpaper, colour or font, even from unvalidated tokens", () => {
    const t = daylight.tokens;
    const wall = (kind: ThemeTokens["wallpaper"]["kind"], value: string, colors?: [string, string]) => tokensToCssVars({ ...t, wallpaper: { ...t.wallpaper, kind, value, colors } }, "light")["--theme-wallpaper"];
    expect(wall("image", "https://evil.example/a.png")).toBe("none");
    expect(wall("image", "/uploads/../secrets")).toBe("none");
    expect(wall("image", "/uploads/wall/sunset.webp")).toBe('url("/uploads/wall/sunset.webp")');
    expect(wall("gradient", "linear-gradient(red, url(https://x))")).toBe("none");
    expect(wall("color", "red; background: url(x)")).toBe("none");
    expect(wall("sky", "", ["#A9C8E4", "#F6D98B"])).toBe("linear-gradient(100deg, #A9C8E4 0%, #A9C8E4 30%, #F6D98B 100%)");
    expect(wall("sky", "", ["#A9C8E4", "red;}" ])).toBe("none");
    const v = tokensToCssVars({ ...t, color: { ...t.color, accent: "red;} body{display:none" }, type: { ...t.type, display: 'x"; } body { display:none' } }, "light");
    expect(v["--theme-accent"]).toBe("#E9B949");
    expect(v["--theme-font-display"]).toBe(THEME_FONT_STACKS["Inter Tight"]);
  });
});

describe("fonts", () => {
  // Wave 2.10b F10 (A11.5): the ten design v4 families stay on next/font; 27 more are self-hosted files.
  it("keeps the ten design v4 families on next/font variables", () => {
    const ten = ["Atkinson Hyperlegible", "Fraunces", "Geist", "Geist Mono", "IBM Plex Mono", "IBM Plex Sans", "Inter", "Inter Tight", "JetBrains Mono", "Space Grotesk"] as const;
    for (const f of ten) expect(THEME_FONT_STACKS[f]).toMatch(/^var\(--font-[a-z-]+\), /);
  });
  it("F10: at least 30 built-in families across sans, serif, mono, display and rounded, each with its own stack", () => {
    expect(THEME_FONTS.length).toBeGreaterThanOrEqual(30);
    const kinds = new Set(THEME_FONTS.map((f) => THEME_FONT_KINDS[f]));
    expect([...kinds].sort()).toEqual(["display", "mono", "rounded", "sans", "serif"]);
    for (const k of kinds) expect(THEME_FONTS.filter((f) => THEME_FONT_KINDS[f] === k).length).toBeGreaterThanOrEqual(4);
    expect(new Set(Object.values(THEME_FONT_STACKS)).size).toBe(THEME_FONTS.length);
    for (const f of THEME_FONTS) if (selfHostedFontSlug(f)) expect(THEME_FONT_STACKS[f]).toBe(`"${f}", ${THEME_FONT_STACKS[f].split(", ").slice(1).join(", ")}`);
  });
  it("F10: every self-hosted family has an @font-face rule pointing at a file in public/fonts, and nothing else does", () => {
    const css = readFileSync(path.join(APP_DIR, "src/features/themes/fonts/theme-fonts.css"), "utf8");
    const declared = new Set([...css.matchAll(/font-family: "([^"]+)"/g)].map((m) => m[1]));
    const self = THEME_FONTS.filter((f) => selfHostedFontSlug(f));
    expect([...declared].sort()).toEqual([...self].sort());
    for (const m of css.matchAll(/url\("([^"]+)"\)/g)) {
      expect(m[1]).toMatch(/^\/fonts\/[a-z0-9-]+\.woff2$/);
      expect(existsSync(path.join(APP_DIR, "public", m[1]!)), m[1]).toBe(true);
    }
    expect(css).not.toMatch(/https?:/);
  });
  it("F10: a mono field picked from a mono family is kept", () => {
    const v = tokensToCssVars({ ...controlRoom.tokens, type: { ...controlRoom.tokens.type, mono: "Fira Code", display: "Lora" } }, "light");
    expect(v["--theme-font-mono"]).toBe(THEME_FONT_STACKS["Fira Code"]);
    expect(v["--theme-font-display"]).toBe(`"Lora", ui-serif, Georgia, serif`);
  });

  it("names an uploaded family only when the theme declares it", () => {
    expect(fontStack("Recursive", ["Recursive"], "display")).toBe(`"Recursive", ${THEME_FONT_STACKS["Inter Tight"]}`);
    expect(fontStack("Recursive", [], "display")).toBe(THEME_FONT_STACKS["Inter Tight"]);
    expect(fontStack("Recursive", ["Recursive"], "mono")).toBe(`"Recursive", ${THEME_FONT_STACKS["Geist Mono"]}`);
  });

  it("writes @font-face only for valid /uploads/*.woff2 files", () => {
    const css = themeFontFaces({
      fonts: [
        { family: "Recursive", file: "/uploads/fonts/recursive.woff2", weight: "300 900", style: "normal" },
        { family: "Evil", file: "https://evil.example/x.woff2", weight: "400", style: "normal" },
        { family: "Ttf", file: "/uploads/fonts/x.ttf", weight: "400", style: "normal" },
        { family: 'Bad"}', file: "/uploads/fonts/y.woff2", weight: "400", style: "normal" },
      ],
    });
    expect(css).toBe('@font-face{font-family:"Recursive";src:url("/uploads/fonts/recursive.woff2") format("woff2");font-weight:300 900;font-style:normal;font-display:swap}');
  });
});

describe("themeCanvasCss", () => {
  it("writes the canvas's own rule in the atrium-theme layer, plus a dark set for auto", () => {
    const css = themeCanvasCss({ ...controlRoom, mode: "auto" }, "k1");
    expect(css.startsWith('@layer atrium-theme{[data-atrium-canvas][data-canvas-key="k1"]{--theme-wallpaper:#F3EFE4;')).toBe(true);
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) [data-atrium-canvas][data-canvas-key="k1"]{--theme-wallpaper:#15130F;');
    expect(css).toContain(':root[data-theme="dark"] [data-atrium-canvas][data-canvas-key="k1"]{');
    expect(css).not.toContain("<");
    expect(themeCanvasCss(controlRoom, 'x"]{}*{')).toBe("");
  });
});

describe("theme files", () => {
  const meta = { id: "dusk-copy", name: "Dusk copy", author: "Tristan", version: "1.0.0" };

  it("round-trip all four themes through JSON to identical CSS variables", () => {
    for (const t of Object.values(BUILT_IN_THEMES)) {
      const parsed = parseTheme(JSON.parse(JSON.stringify(toTheme(meta, t.tokens, { mode: t.mode, dark: t.dark }))));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.warnings).toEqual([]);
      expect(themeToCssVars(parsed.theme)).toEqual(themeToCssVars({ ...t, ...meta }));
    }
  });

  it("reject bad colours, foreign images and fonts, junk ids and oversize CSS", () => {
    const base = toTheme(meta, dusk.tokens, { mode: "dark" });
    expect(parseTheme({ ...base, tokens: { ...base.tokens, color: { ...base.tokens.color, accent: "red;}" } } }).ok).toBe(false);
    expect(parseTheme({ ...base, tokens: { ...base.tokens, wallpaper: { kind: "image", value: "https://evil.example/x.png", blurPx: 0, dim: 0, grain: 0 } } }).ok).toBe(false);
    expect(parseTheme({ ...base, fonts: [{ family: "X", file: "https://evil.example/x.woff2", weight: "400", style: "normal" }] }).ok).toBe(false);
    expect(parseTheme({ ...base, id: "../etc" }).ok).toBe(false);
    expect(parseTheme({ ...base, atriumTheme: "3" }).ok).toBe(false);
    expect(parseTheme(null).ok).toBe(false);
    expect(parseTheme({ ...base, customCss: "x".repeat(70 * 1024) }).ok).toBe(false);
  });

  it("clamp ranges instead of rejecting them", () => {
    const b = toTheme(meta, dusk.tokens, { mode: "dark" });
    const r = parseTheme({ ...b, tokens: { ...b.tokens, shape: { radiusPx: 99, controlRadiusPx: 5000 }, space: { gapPx: 1, padPx: 100, density: "compact" }, surface: { ...b.tokens.surface, opacity: 0.1, shadowOffsetPx: 40 }, wallpaper: { ...b.tokens.wallpaper, dim: 0.9, blurPx: 14, grain: 2 }, type: { ...b.tokens.type, scale: 3, headingWeight: 650 } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.theme.tokens;
    expect([t.shape.radiusPx, t.shape.controlRadiusPx, t.space.gapPx, t.space.padPx, t.surface.opacity, t.surface.shadowOffsetPx, t.wallpaper.dim, t.wallpaper.blurPx, t.wallpaper.grain, t.type.scale]).toEqual([32, 999, 4, 40, 0.3, 12, 0.6, 16, 0.3, 1.3]);
    expect([600, 700]).toContain(t.type.headingWeight);
  });

  it("warn, but still accept, text under 4.5:1", () => {
    const t = daylight.tokens;
    const r = parseTheme(toTheme(meta, { ...t, color: { ...t.color, surfaceText: "oklch(0.8 0 0)", surfaceMuted: "oklch(0.85 0 0)" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.map((w) => w.field)).toEqual(["color.surfaceText", "color.surfaceMuted"]);
  });

  it("import v3 files: surface.tint becomes color.surface and the new fields come from Control Room", () => {
    const v3 = {
      atriumTheme: "1", id: "old-dusk", name: "Old dusk", author: "Tristan", version: "1",
      tokens: {
        wallpaper: { kind: "gradient", value: "linear-gradient(to bottom, oklch(0.30 0.05 40), oklch(0.18 0.03 280))", blurPx: 0, dim: 0 },
        surface: { material: "glass", tint: "oklch(0.22 0.01 60)", opacity: 0.58, blurPx: 28, border: true },
        text: { primary: "oklch(0.96 0.006 80)", muted: "oklch(0.82 0.01 75)" },
        accent: "oklch(0.78 0.13 60)",
        font: { ui: "Fraunces", numbers: "tabular" },
        radiusPx: 20, gapPx: 16, density: "comfortable", shadow: 1, lightDrift: true,
      },
      customCss: ".x{color:red}",
    };
    const r = parseTheme(v3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importedFrom).toBe("1");
    const t = r.theme;
    expect(t.atriumTheme).toBe("2");
    expect(t.mode).toBe("dark");
    expect(t.tokens.color.surface).toBe("oklch(0.22 0.01 60)");
    expect(t.tokens.color.surfaceText).toBe("oklch(0.96 0.006 80)");
    expect(t.tokens.type.display).toBe("Fraunces");
    expect(t.tokens.type.mono).toBe("Geist Mono");
    expect(t.tokens.surface.shadow).toBe("soft");
    expect(t.tokens.chrome).toEqual(resolveTokens({ ...controlRoom, mode: "auto" }, "dark").chrome);
    expect(t.customCss).toBe(".x{color:red}");
    expect(themeFromV3).toBeTypeOf("function");
  });
});

describe("validators", () => {
  it("gradients and upload paths", () => {
    expect(isThemeGradient(daylight.tokens.wallpaper.value)).toBe(true);
    expect(isThemeGradient("linear-gradient(var(--bg), red)")).toBe(false);
    expect(isUploadPath("/uploads/a.png")).toBe(true);
    expect(isUploadPath("/uploads/../a.png")).toBe(false);
  });
});

// Wave 2.10b F12 (A11.5, design Note 2): one material control for surfaces and the nav chrome.
describe("F12 materials", () => {
  const t = controlRoom.tokens;
  it("Solid nav chrome: the background colour, no blur, no image (absent material reads as solid)", () => {
    const v = tokensToCssVars(t, "light");
    expect([v["--theme-chrome-material"], v["--theme-chrome-fill"], v["--theme-chrome-blur"], v["--theme-chrome-image"]]).toEqual(["solid", "#F3EFE4", "0px", "none"]);
  });
  it("Frosted glass nav chrome: the background at its opacity, blurred", () => {
    const v = tokensToCssVars({ ...t, chrome: { ...t.chrome, material: "glass", opacity: 0.4, blurPx: 16 } }, "light");
    expect(v["--theme-chrome-fill"]).toBe("color-mix(in oklab, #F3EFE4 40%, transparent)");
    expect(v["--theme-chrome-blur"]).toBe("16px");
    const clamped = tokensToCssVars({ ...t, chrome: { ...t.chrome, material: "glass", opacity: 0.1, blurPx: 99 } }, "light");
    expect([clamped["--theme-chrome-fill"], clamped["--theme-chrome-blur"]]).toEqual(["color-mix(in oklab, #F3EFE4 30%, transparent)", "48px"]);
  });
  it("Gradient for the nav and for surfaces: two colours at 135deg; a bad pair falls back to the flat colour", () => {
    const v = tokensToCssVars({ ...t, chrome: { ...t.chrome, material: "gradient", gradient: ["#FFFFFF", "#A9C8E4"] }, surface: { ...t.surface, material: "gradient", gradient: ["#FFFFFF", "#E8E2D2"] } }, "light");
    expect(v["--theme-chrome-image"]).toBe("linear-gradient(135deg, #FFFFFF, #A9C8E4)");
    expect(v["--theme-surface-image"]).toBe("linear-gradient(135deg, #FFFFFF, #E8E2D2)");
    expect(v["--theme-surface-blur"]).toBe("0px");
    const bad = tokensToCssVars({ ...t, surface: { ...t.surface, material: "gradient", gradient: ["red;}", "#fff"] as [string, string] } }, "light");
    expect(bad["--theme-surface-image"]).toBe("linear-gradient(135deg, #FBF9F3, #FBF9F3)");
  });
  it("the schema takes gradient surfaces and the nav's material fields", () => {
    const theme = { ...controlRoom, tokens: { ...t, surface: { ...t.surface, material: "gradient", gradient: ["#FFFFFF", "#E8E2D2"] }, chrome: { ...t.chrome, material: "glass", opacity: 0.5, blurPx: 20 } } };
    const r = parseTheme(theme);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
