// Wave 2.10c round 2, builder S (gauntlet w210c-r1 Fix 15): the theme's scrollbar tokens survive saving,
// revalidation, theme files and the canvas CSS, and the Custom CSS check names what it removes.
import { describe, expect, it } from "vitest";
import { controlRoom, parseTheme, themeToCssVars } from "@/features/shell/theme";
import { revalidateTheme } from "@/features/themes/revalidate";
import { strictThemeIssues } from "@/features/themes/fields";
import { themeCssReport } from "@/features/themes/css-report";

const t = controlRoom.tokens;
const withTokens = (tokens: object, extra: object = {}) => ({ ...controlRoom, id: "w210c-r2-e2e", tokens: { ...t, ...tokens }, ...extra });

describe("Fix 15: the scrollbar tokens", () => {
  it("a valid scrollbar is kept on save and revalidation, and reaches the canvas CSS", () => {
    const th = withTokens({ scrollbar: { thumb: "#d0342c", widthPx: 8 } });
    expect(strictThemeIssues(th)).toEqual([]);
    const { theme, replaced } = revalidateTheme(th);
    expect(replaced).toBe(0);
    expect(theme.tokens.scrollbar).toEqual({ thumb: "#d0342c", widthPx: 8 });
    expect(themeToCssVars(theme).base).toMatchObject({ "--theme-scrollbar-thumb": "#d0342c", "--theme-scrollbar-width": "8px" });
  });

  it("absent stays absent (the default thumb), so older themes do not change", () => {
    const { theme, replaced } = revalidateTheme(withTokens({}));
    expect(replaced).toBe(0);
    expect(theme.tokens.scrollbar).toBeUndefined();
    expect(themeToCssVars(theme).base["--theme-scrollbar-width"]).toBeUndefined();
  });

  it("a bad colour or width is refused on save with the rule in words, and replaced on revalidation", () => {
    const bad = withTokens({ scrollbar: { thumb: "url(javascript:x)", widthPx: 12 } });
    expect(strictThemeIssues(bad)).toEqual([
      { path: "tokens.scrollbar.thumb", message: "Scrollbar colour must be an oklch() or #hex colour." },
      { path: "tokens.scrollbar.widthPx", message: "Scrollbar width must be 4, 6 or 8 px." },
    ]);
    const { theme } = revalidateTheme(bad);
    expect(theme.tokens.scrollbar).toEqual({ thumb: "#8a8a8a59", widthPx: 8 });
    expect(revalidateTheme(withTokens({ scrollbar: "wide" })).theme.tokens.scrollbar).toBeUndefined();
  });

  it("a dark set may hold its own scrollbar", () => {
    const th = withTokens({ scrollbar: { thumb: "#202020", widthPx: 4 } }, { mode: "auto", dark: { scrollbar: { thumb: "#f0f0f0", widthPx: 6 } } });
    const { theme } = revalidateTheme(th);
    expect(theme.dark?.scrollbar).toEqual({ thumb: "#f0f0f0", widthPx: 6 });
    expect(themeToCssVars(theme).dark).toMatchObject({ "--theme-scrollbar-thumb": "#f0f0f0", "--theme-scrollbar-width": "6px" });
  });

  it("a theme file keeps the scrollbar (parseTheme)", () => {
    const r = parseTheme({ ...withTokens({ scrollbar: { thumb: "oklch(0.6 0.1 30 / 0.5)", widthPx: 6 } }), author: "FAKE", version: "1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.theme.tokens.scrollbar).toEqual({ thumb: "oklch(0.6 0.1 30 / 0.5)", widthPx: 6 });
  });
});

describe("Fix 15: the theme's Custom CSS check names what it removes", () => {
  it("a token rule under :root is named once, with its reason, and the :scope hint", () => {
    const r = themeCssReport(":root{--theme-scrollbar-width:14px}");
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0]!.text).toBe(":root");
    expect(r.removed[0]!.reason).toMatch(/outside the canvas/);
    expect(r.tokenHint).toBe(true);
  });

  it("names a refused declaration and leaves allowed rules out of the list", () => {
    const r = themeCssReport(".ok{color:red} .bad{color:expression(1)} .x{position:fixed}");
    expect(r.removed.map((x) => x.text)).toEqual(["color:expression(1)", "position:fixed"]);
    expect(r.tokenHint).toBe(false);
  });

  it("nothing to say for clean CSS, a :scope token, or an empty box", () => {
    expect(themeCssReport(":scope{--theme-scrollbar-width:8px} .atr-scroll-thumb{background:red}")).toEqual({ removed: [], tokenHint: false });
    expect(themeCssReport("   ")).toEqual({ removed: [], tokenHint: false });
  });
});
