// Wave 2.10a builder S units (V1): B3 radius range, B4 density factor, B6 dark resolver and dark set fill.
import { describe, expect, it } from "vitest";
import type { Theme, ThemeTokens } from "@/core/contracts";
import { controlRoom, dusk, solid, daylight } from "@/features/shell";
import { controlRadiusOf, parseTheme, resolveTokens, themeForScheme, tokenContrast, tokensToCssVars, isThemeColor, isThemeGradient, contrastReport } from "@/features/shell/theme";
import { revalidateTheme } from "@/features/themes/revalidate";
import { makeDarkSet } from "@/features/themes/dark-set";

const frosted: ThemeTokens = {
  ...controlRoom.tokens,
  wallpaper: { kind: "image", value: "/uploads/fake-wallpaper-e2e.png", blurPx: 0, dim: 0.2, grain: 0 },
  surface: { ...controlRoom.tokens.surface, material: "glass", opacity: 0.3, blurPx: 1, shadow: "soft", shadowOffsetPx: 0, border: { widthPx: 1, color: "#FFFFFF66" }, titleBars: false },
};

describe("B3 control radius (design Note 3: stops a control can show)", () => {
  it("Comfortable runs 0 to 20, Compact 0 to 16; anything above reads as Pill (999)", () => {
    expect([0, 2, 10, 20, 21, 24, 40, 998, 999, 5000, -3, NaN].map((n) => controlRadiusOf(n))).toEqual([0, 2, 10, 20, 999, 999, 999, 999, 999, 999, 0, 0]);
    expect([0, 16, 17, 18, 20, 999].map((n) => controlRadiusOf(n, "compact"))).toEqual([0, 16, 999, 999, 999, 999]);
    const v = (n: number, density: "comfortable" | "compact" = "comfortable") => tokensToCssVars({ ...controlRoom.tokens, shape: { radiusPx: 0, controlRadiusPx: n }, space: { ...controlRoom.tokens.space, density } }, "light")["--theme-control-radius"];
    expect([v(12), v(20), v(22), v(999)]).toEqual(["12px", "20px", "999px", "999px"]);
    expect([v(16, "compact"), v(18, "compact")]).toEqual(["16px", "999px"]);
  });
  it("a stored 30 revalidates to Pill without counting as invalid, and imports as Pill", () => {
    const raw = structuredClone(controlRoom);
    raw.tokens.shape.controlRadiusPx = 30;
    const r = revalidateTheme(raw);
    expect(r.theme.tokens.shape.controlRadiusPx).toBe(999);
    expect(r.fields).not.toContain("tokens.shape.controlRadiusPx");
    const p = parseTheme(raw);
    expect(p.ok && p.theme.tokens.shape.controlRadiusPx).toBe(999);
  });
});

describe("r2 item 4: density sizes for title bars, nav items and tiles", () => {
  it("every size is two thirds at Compact, with the pointer nav item at least 28 px", () => {
    const comfy = tokensToCssVars(controlRoom.tokens, "light");
    const compact = tokensToCssVars({ ...controlRoom.tokens, space: { ...controlRoom.tokens.space, density: "compact" } }, "light");
    const keys = ["--theme-titlebar-h", "--theme-nav-item-h", "--theme-nav-bar-h", "--theme-nav-pad-y", "--theme-nav-pad-x", "--theme-nav-gap", "--theme-tile-pad-y", "--theme-tile-pad-x", "--theme-tile-gap", "--theme-tile-icon", "--theme-group-head-h"];
    expect(keys.map((k) => comfy[k])).toEqual(["28px", "36px", "44px", "12px", "16px", "8px", "12px", "14px", "10px", "36px", "28px"]);
    expect(keys.map((k) => compact[k])).toEqual(["19px", "28px", "29px", "8px", "11px", "5px", "8px", "9px", "7px", "24px", "19px"]);
  });
});

describe("B4 density", () => {
  it("compact multiplies pad, gap and title bar by 0.67 and sets pointer controls to 32 px", () => {
    const comfy = tokensToCssVars(controlRoom.tokens, "light");
    const compact = tokensToCssVars({ ...controlRoom.tokens, space: { ...controlRoom.tokens.space, density: "compact" } }, "light");
    expect([comfy["--theme-pad"], comfy["--theme-gap"], comfy["--theme-control-h"], comfy["--theme-titlebar-h"], comfy["--theme-density-k"]]).toEqual(["20px", "24px", "40px", "28px", "1"]);
    expect([compact["--theme-pad"], compact["--theme-gap"], compact["--theme-control-h"], compact["--theme-titlebar-h"], compact["--theme-density-k"]]).toEqual(["13px", "16px", "32px", "19px", "0.67"]);
    expect(parseFloat(compact["--theme-pad-phone"]!) / parseFloat(comfy["--theme-pad-phone"]!)).toBeLessThanOrEqual(0.7);
  });
  it("every pad and gap a theme can hold shrinks to at most 70%, with the gap at least 4 px", () => {
    for (let pad = 8; pad <= 40; pad++) for (const gap of [4, 6, 8, 16, 40]) {
      const t = { ...controlRoom.tokens, space: { gapPx: gap, padPx: pad, density: "comfortable" as const } };
      const a = tokensToCssVars(t, "light"), b = tokensToCssVars({ ...t, space: { ...t.space, density: "compact" } }, "light");
      expect(parseFloat(b["--theme-pad"]!) / parseFloat(a["--theme-pad"]!)).toBeLessThanOrEqual(0.7);
      const g = parseFloat(b["--theme-gap"]!);
      expect(g).toBeGreaterThanOrEqual(4);
      if (gap >= 7) expect(g / parseFloat(a["--theme-gap"]!)).toBeLessThanOrEqual(0.7);
    }
  });
});

describe("B6 dark resolver", () => {
  it("applies every group of the dark set, field by field", () => {
    const theme: Theme = { ...controlRoom, mode: "auto", dark: { ...controlRoom.dark, chrome: { ...controlRoom.dark!.chrome!, style: "underline" }, motion: { enter: "fade", lightDrift: false }, space: { gapPx: 8, padPx: 10, density: "compact" }, surface: { material: "glass" } as ThemeTokens["surface"] } };
    const d = resolveTokens(theme, "dark");
    expect([d.chrome.style, d.motion.enter, d.space.density, d.surface.material]).toEqual(["underline", "fade", "compact", "glass"]);
    // A partial group keeps the light fields it does not name.
    expect(d.surface.shadow).toBe(controlRoom.tokens.surface.shadow);
    expect(resolveTokens(theme, "light")).toBe(theme.tokens);
    expect(resolveTokens({ ...theme, mode: "light" }, "dark")).toBe(theme.tokens);
  });
  it("themeForScheme turns an auto theme into its light or dark set as a fixed tone", () => {
    const auto: Theme = { ...controlRoom, mode: "auto" };
    const dark = themeForScheme(auto, "dark");
    expect(dark.mode).toBe("dark");
    expect(dark.dark).toBeUndefined();
    expect(dark.tokens.color.surface).toBe("#1D1A15");
    expect(themeForScheme(auto, "light").tokens.color.surface).toBe("#FBF9F3");
    expect(themeForScheme(dusk, "light")).toBe(dusk);
  });
});

describe("B6 Make a dark set", () => {
  const cases: [string, ThemeTokens][] = [["control-room", controlRoom.tokens], ["dusk", dusk.tokens], ["solid", solid.tokens], ["daylight", daylight.tokens], ["frosted", frosted]];
  for (const [name, light] of cases) {
    it(`${name}: a full set that passes the contrast check, same accent, darker surface`, () => {
      const d = makeDarkSet(light);
      expect(Object.keys(d).sort()).toEqual(["chrome", "color", "motion", "shape", "space", "surface", "type", "wallpaper"]);
      expect(tokenContrast(d, "dark").warnings).toEqual([]);
      expect(d.color.accent).toBe(light.color.accent);
      for (const v of Object.values(d.color)) expect(isThemeColor(v), v).toBe(true);
      for (const v of [d.chrome.background, d.chrome.text, d.chrome.activeFill, d.chrome.activeText, d.surface.border.color]) expect(isThemeColor(v), v).toBe(true);
      if (d.wallpaper.kind === "gradient") expect(isThemeGradient(d.wallpaper.value)).toBe(true);
      // Saved as an auto theme, it revalidates unchanged and reports no contrast warning.
      const theme: Theme = { ...controlRoom, id: "x", tokens: light, mode: "auto", dark: d };
      const r = revalidateTheme(theme);
      expect(r.fields.filter((f) => f.startsWith("dark"))).toEqual([]);
      expect(contrastReport(theme).warnings.filter((w) => w.scheme === "dark")).toEqual([]);
      const ld = (s: string) => tokensToCssVars(d, "dark")[s];
      expect(ld("--theme-surface")).not.toBe(tokensToCssVars(light, "light")["--theme-surface"]);
    });
  }
  it("an image wallpaper is dimmed, not recoloured", () => {
    const d = makeDarkSet(frosted);
    expect(d.wallpaper.value).toBe(frosted.wallpaper.value);
    expect(d.wallpaper.dim).toBeGreaterThanOrEqual(0.45);
  });
});

describe("r2 low L7: a made dark set is written in hex", () => {
  it("every colour except the shared accent is #RRGGBB or #RRGGBBAA, and it still passes", () => {
    for (const light of [controlRoom.tokens, dusk.tokens, solid.tokens, frosted]) {
      const d = makeDarkSet(light);
      expect(tokenContrast(d, "dark").warnings).toEqual([]);
      const keep = new Set([light.color.accent, light.color.accentText]);
      const colours = [...Object.values(d.color), d.surface.border.color, d.chrome.background, d.chrome.text, d.chrome.activeFill, d.chrome.activeText];
      for (const c of colours) if (!keep.has(c)) expect(c).toMatch(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);
      expect(d.color.accent).toBe(light.color.accent);
    }
  });
});
