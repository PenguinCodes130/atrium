// Wave 2.10a, builder S: the operator's theme try-out bugs B3 to B6 (operator-tryout-spec.md section 3,
// acceptance criteria 3 to 6), through the real theme editor and the real app viewer.
//   B3 control radius: 0 to 24 plus Pill, every step changes the preview button's corner radius.
//   B4 density: Compact tightens card padding, grid gap and control height, in the preview and the viewer.
//   B5 nav styles: Bar, Boxed tabs, Pills and Underline each look distinct, in the preview and the viewer.
//   B6 auto dark: the preview draws the real dark set on demand; "Make a dark set" fills one that passes.
// Themes (V4): Control Room, Dusk, Solid and a frosted custom theme (FAKE image wallpaper, glass at 0.3,
// blur 1 px, soft shadow, 1 px border). Test-only values; none are real credentials.
import { writeFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";
import { OWNER, context, ev } from "./helpers";
import { THEMES, api, frostedTheme, makeApp, openEditor, openGroup, publish, radio, saveTheme, tag, themeFrom } from "./w210a-fixtures";

test.setTimeout(300_000);

/** The look of a nav: what Note 2 defines for each item style, measured. */
async function navLook(nav: Locator) {
  return nav.evaluate((n) => {
    const items = [...n.querySelectorAll<HTMLElement>("a[data-app-nav-item]")];
    const nr = n.getBoundingClientRect();
    const ns = getComputedStyle(n);
    const contentTop = nr.top + parseFloat(ns.borderTopWidth) + parseFloat(ns.paddingTop);
    const contentBottom = nr.bottom - parseFloat(ns.borderBottomWidth) - parseFloat(ns.paddingBottom);
    const opaque = (c: string) => c !== "rgba(0, 0, 0, 0)" && c !== "transparent";
    return {
      tags: items.map((i) => i.tagName),
      hrefs: items.map((i) => i.getAttribute("href")),
      navBottom: Math.round(nr.bottom),
      contentHeight: Math.round(contentBottom - contentTop),
      items: items.map((i) => {
        const s = getComputedStyle(i);
        const r = i.getBoundingClientRect();
        return {
          active: i.getAttribute("aria-current") === "page",
          filled: opaque(s.backgroundColor),
          bg: s.backgroundColor,
          color: s.color,
          border: parseFloat(s.borderTopWidth),
          radiusTop: parseFloat(s.borderTopLeftRadius),
          radiusBottom: parseFloat(s.borderBottomLeftRadius),
          padLeft: parseFloat(s.paddingLeft),
          height: Math.round(r.height),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          underline: s.boxShadow.includes("2px") || parseFloat(s.borderBottomWidth) === 2,
        };
      }),
    };
  });
}
type Look = Awaited<ReturnType<typeof navLook>>;

/** Note 2's definition of each style; returns the first rule a nav breaks, or null. */
function breaksNote2(style: string, l: Look): string | null {
  const act = l.items.find((i) => i.active);
  const rest = l.items.filter((i) => !i.active);
  if (l.items.length < 3 || !act) return `nav has ${l.items.length} real links and ${act ? 1 : 0} active`;
  if (l.tags.some((t) => t !== "A")) return "nav items are not links";
  if (style === "bar") {
    if (!act.filled) return "bar: the active item has no fill";
    if (Math.abs(act.height - l.contentHeight) > 1) return `bar: the active fill is ${act.height}px, not the nav's full ${l.contentHeight}px height`;
    if (l.items.some((i) => i.padLeft !== 12)) return "bar: items do not have 12px side padding";
    if (l.items.some((i) => i.border > 0 || i.radiusTop > 0)) return "bar: items are not flat";
  } else if (style === "boxed-tabs") {
    if (l.items.some((i) => i.border < 1)) return "boxed tabs: an item has no 1px border";
    if (l.items.some((i) => i.radiusTop < 6)) return `boxed tabs: top radius ${Math.min(...l.items.map((i) => i.radiusTop))}px, under 6px`;
    if (!act.filled) return "boxed tabs: the active item is not filled";
    if (Math.abs(act.bottom - l.navBottom) > 1) return `boxed tabs: the active tab ends ${l.navBottom - act.bottom}px above the content edge`;
  } else if (style === "pills") {
    if (l.items.some((i) => i.radiusTop < i.height / 2 - 0.5)) return "pills: an item is not fully rounded";
    if (!act.filled) return "pills: the active item is not filled";
    if (rest.some((i) => i.filled)) return "pills: an inactive item has a fill";
  } else if (style === "underline") {
    if (l.items.some((i) => i.filled)) return "underline: an item has a fill";
    if (!act.underline) return "underline: the active item has no 2px underline";
    if (rest.some((i) => i.underline)) return "underline: an inactive item is underlined";
    if (rest.some((i) => i.color === act.color)) return "underline: inactive items are not muted";
  }
  return null;
}

const STYLES = ["bar", "boxed-tabs", "pills", "underline"] as const;
const STYLE_LABEL: Record<string, string> = { bar: "Bar", "boxed-tabs": "Boxed tabs", pills: "Pills", underline: "Underline" };

// ---- B3 ----

test("B3: control radius runs 0 to 20 (Comfortable, design Note 3) then Pill, and every step changes the preview button", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `w210 radius ${tag()}`);
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await openEditor(page, id);
  await openGroup(page, "shape");
  const thumb = page.locator('[data-slider="shape.controlRadiusPx"] [role="slider"]');
  const out: Record<string, unknown> = { max: await thumb.getAttribute("aria-valuemax") };
  // The slider has no value above 20 other than Pill (r2: design Note 3 stops for Comfortable).
  expect(Number(out.max), "slider top stop").toBeLessThanOrEqual(22);
  const button = page.locator("[data-preview] [data-sample-button]").first();
  await expect(button).toBeVisible({ timeout: 5000 });
  const h = await button.evaluate((el) => el.getBoundingClientRect().height);
  out.buttonHeight = h;
  expect(h, "the preview button is full size").toBeGreaterThanOrEqual(32);
  await expect(page.locator("[data-preview] [data-sample-toggle]").first()).toBeVisible();
  await expect(page.locator("[data-preview] [data-sample-select]").first()).toBeVisible();
  await expect(page.locator("[data-preview] [data-canvas-nav] a[data-app-nav-item]").first()).toBeVisible();
  await thumb.focus();
  await page.keyboard.press("Home");
  const steps: { text: string; radius: string }[] = [];
  for (let i = 0; i <= 11; i++) {
    if (i > 0) await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
    steps.push({ text: await page.locator('[data-range="shape.controlRadiusPx"] input[data-field]').inputValue(), radius: await button.evaluate((el) => getComputedStyle(el).borderTopLeftRadius) });
  }
  out.steps = steps;
  writeFileSync(ev("b3-radius-steps.json"), JSON.stringify(out, null, 2));
  expect(steps.map((s) => s.text)).toEqual(["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "Pill"]);
  expect(new Set(steps.map((s) => s.radius)).size, "every step gives the button its own corner radius").toBe(12);
  await page.locator("[data-preview]").screenshot({ path: ev("screens", "b3-radius-pill-preview.png") });
  // A stored value above the last stop reads as Pill.
  await saveTheme(a, id, (t) => { t.tokens.shape.controlRadiusPx = 40; });
  await openEditor(page, id);
  await openGroup(page, "shape");
  await expect(page.locator('[data-range="shape.controlRadiusPx"] input[data-field]')).toHaveValue("Pill");
  expect(await page.locator("[data-preview] [data-sample-button]").first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("999px");
  await ctx.close();
  await a.dispose();
});

// ---- B4 ----

async function densityNumbers(scope: Locator, card: string, grid: string, button: string) {
  return scope.evaluate((root, sel) => {
    const q = (s: string) => root.querySelector<HTMLElement>(s);
    const c = q(sel.card), g = q(sel.grid), b = q(sel.button);
    return {
      pad: c ? parseFloat(getComputedStyle(c).paddingLeft) : NaN,
      gap: g ? parseFloat(getComputedStyle(g).columnGap) : NaN,
      button: b ? b.getBoundingClientRect().height : NaN,
    };
  }, { card, grid, button });
}

test("B4: Compact tightens card padding, grid gap and button height, in the preview and the viewer", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const out: Record<string, unknown> = {};
  const id = await themeFrom(a, "control-room", `w210 density ${tag()}`);
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await openEditor(page, id);
  await openGroup(page, "shape");
  const preview = page.locator("[data-preview] [data-theme-sample]").first();
  const sel = ["[data-sample-card], .canvas-surface", "[data-sample-grid], .canvas-grid", "[data-sample-button]"] as const;
  const comfy = await densityNumbers(preview, ...sel);
  await page.locator("[data-preview]").screenshot({ path: ev("screens", "b4-preview-comfortable.png") });
  await radio(page, "space.density", "compact").click();
  await page.waitForTimeout(150);
  const compact = await densityNumbers(preview, ...sel);
  await page.locator("[data-preview]").screenshot({ path: ev("screens", "b4-preview-compact.png") });
  out.preview = { comfy, compact };
  writeFileSync(ev("b4-density.json"), JSON.stringify(out, null, 2));
  expect(compact.pad / comfy.pad, "preview card padding").toBeLessThanOrEqual(0.7);
  expect(compact.gap / comfy.gap, "preview grid gap").toBeLessThanOrEqual(0.7);
  expect(compact.button, "preview button height").toBeLessThanOrEqual(36);
  // The viewer: a published app on this theme, comfortable then compact.
  const app = await makeApp(a, id);
  const vsel = [".atr-card", ".atr-grid", ".atr-button"] as const;
  await page.goto(`/a/${app.slug}`);
  await expect(page.locator(".atr-button").first()).toBeVisible();
  const vComfy = await densityNumbers(page.locator("[data-atrium-canvas]").first(), ...vsel);
  await page.screenshot({ path: ev("screens", "b4-viewer-comfortable.png") });
  await saveTheme(a, id, (t) => { t.tokens.space.density = "compact"; });
  await publish(a, app.id);
  await page.goto(`/a/${app.slug}`);
  await expect(page.locator(".atr-button").first()).toBeVisible();
  const vCompact = await densityNumbers(page.locator("[data-atrium-canvas]").first(), ...vsel);
  await page.screenshot({ path: ev("screens", "b4-viewer-compact.png") });
  out.viewer = { comfy: vComfy, compact: vCompact };
  writeFileSync(ev("b4-density.json"), JSON.stringify(out, null, 2));
  expect(vCompact.pad / vComfy.pad, "viewer card padding").toBeLessThanOrEqual(0.7);
  expect(vCompact.gap / vComfy.gap, "viewer grid gap").toBeLessThanOrEqual(0.7);
  expect(vCompact.button, "viewer button height").toBeLessThanOrEqual(36);
  // Touch targets stay at least 44 px on a touch screen.
  const phone = await context(browser, OWNER, { mobile: true });
  const pp = await phone.newPage();
  await pp.goto(`/a/${app.slug}`);
  await expect(pp.locator(".atr-button").first()).toBeVisible();
  out.touchButton = await pp.locator(".atr-button").first().evaluate((el) => el.getBoundingClientRect().height);
  await pp.screenshot({ path: ev("screens", "b4-viewer-compact-390.png") });
  writeFileSync(ev("b4-density.json"), JSON.stringify(out, null, 2));
  expect(out.touchButton as number).toBeGreaterThanOrEqual(44);
  await phone.close();
  await ctx.close();
  await a.dispose();
});

// ---- B5 ----

test("B5: the four nav styles each look as Note 2 defines, in the preview and the viewer, in four themes", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(600_000);
  const a = await api();
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const th of THEMES) {
    const id = await th.make(a);
    // Preview: pick each style in the editor.
    await openEditor(page, id);
    await openGroup(page, "chrome");
    const shots: string[] = [];
    for (const s of STYLES) {
      await radio(page, "chrome.style", STYLE_LABEL[s]!, s).click({ timeout: 5000 });
      await page.waitForTimeout(120);
      const nav = page.locator("[data-preview] [data-canvas-nav]").first();
      const look = await navLook(nav);
      out[`${th.label}/preview/${s}`] = look;
      const why = breaksNote2(s, look);
      if (why) problems.push(`${th.label} preview ${why}`);
      const buf = await nav.screenshot({ path: ev("screens", `b5-preview-${th.label}-${s}.png`) });
      shots.push(buf.toString("base64"));
    }
    if (new Set(shots).size !== 4) problems.push(`${th.label} preview: ${new Set(shots).size} distinct nav screenshots of 4`);
    // Viewer: a published app with three pages on this theme, one publish per style.
    const app = await makeApp(a, id);
    const vshots: string[] = [];
    for (const s of STYLES) {
      await saveTheme(a, id, (t) => { t.tokens.chrome.style = s; });
      await publish(a, app.id);
      await page.goto(`/a/${app.slug}`);
      const nav = page.locator("[data-canvas-nav]").first();
      await expect(nav).toBeVisible();
      const look = await navLook(nav);
      out[`${th.label}/viewer/${s}`] = look;
      const why = breaksNote2(s, look);
      if (why) problems.push(`${th.label} viewer ${why}`);
      const buf = await nav.screenshot({ path: ev("screens", `b5-viewer-${th.label}-${s}.png`) });
      vshots.push(buf.toString("base64"));
    }
    if (new Set(vshots).size !== 4) problems.push(`${th.label} viewer: ${new Set(vshots).size} distinct nav screenshots of 4`);
  }
  out.problems = problems;
  writeFileSync(ev("b5-nav-styles.json"), JSON.stringify(out, null, 2));
  expect(problems).toEqual([]);
  await ctx.close();
  await a.dispose();
});

// ---- B6 ----

const surfaceBg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
function rgbOf(hex: string) {
  const h = hex.replace("#", "");
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

test("B6: the preview draws the real dark set whatever the editor's appearance; Make a dark set fills one that passes", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const out: Record<string, unknown> = {};
  // An auto theme with Control Room's dark set (surface #1D1A15), edited in a LIGHT and in a DARK editor.
  const auto = await themeFrom(a, "control-room", `w210 auto ${tag()}`, (t) => { t.mode = "auto"; });
  for (const appearance of ["light", "dark"] as const) {
    const ctx = await context(browser, OWNER, { variant: appearance });
    const page = await ctx.newPage();
    await openEditor(page, auto);
    const modes = page.locator('[data-preview] [data-field="preview.scheme"]');
    await modes.getByRole("radio", { name: "Dark", exact: true }).click({ timeout: 5000 });
    const sample = page.locator("[data-preview] [data-theme-sample]");
    await expect(sample).toHaveCount(1);
    out[`${appearance}-editor/dark`] = await surfaceBg(sample.locator(".canvas-surface").first());
    expect(out[`${appearance}-editor/dark`]).toBe(rgbOf("#1D1A15"));
    await page.locator("[data-preview]").screenshot({ path: ev("screens", `b6-${appearance}-editor-preview-dark.png`) });
    await modes.getByRole("radio", { name: "Light", exact: true }).click();
    out[`${appearance}-editor/light`] = await surfaceBg(sample.locator(".canvas-surface").first());
    expect(out[`${appearance}-editor/light`]).toBe(rgbOf("#FBF9F3"));
    await modes.getByRole("radio", { name: "Side by side", exact: true }).click();
    await expect(sample).toHaveCount(2);
    out[`${appearance}-editor/both`] = [await surfaceBg(sample.nth(0).locator(".canvas-surface").first()), await surfaceBg(sample.nth(1).locator(".canvas-surface").first())];
    expect(out[`${appearance}-editor/both`]).toEqual([rgbOf("#FBF9F3"), rgbOf("#1D1A15")]);
    await page.locator("[data-preview]").screenshot({ path: ev("screens", `b6-${appearance}-editor-preview-both.png`) });
    await ctx.close();
  }
  // A theme with no dark set: the preview says so and offers Make a dark set.
  const solid = await themeFrom(a, "solid", `w210 no dark ${tag()}`);
  const frosted = await frostedTheme(a, `w210 frosted dark ${tag()}`);
  for (const [label, id] of [["solid", solid], ["frosted", frosted]] as const) {
    const ctx = await context(browser, OWNER);
    const page = await ctx.newPage();
    await openEditor(page, id);
    await expect(page.locator("[data-preview]").getByText("Dark viewers see the light theme")).toBeVisible({ timeout: 5000 });
    await page.locator("[data-preview]").getByRole("button", { name: "Make a dark set" }).click();
    await expect(page.locator("[data-preview]").getByText("Dark viewers see the light theme")).toHaveCount(0);
    // The dark set passes the contrast check: the editor lists no warning for it (a light set's own
    // warnings, such as the frosted fixture's dark text over glass on a black backdrop, stay as they were).
    await expect(page.locator("[data-contrast-warning]", { hasText: "(dark)" })).toHaveCount(0);
    out[`${label}/light-warnings`] = await page.locator("[data-contrast-warning]").allInnerTexts();
    const modes = page.locator('[data-preview] [data-field="preview.scheme"]');
    await modes.getByRole("radio", { name: "Dark", exact: true }).click();
    const darkBg = await surfaceBg(page.locator("[data-preview] [data-theme-sample] .canvas-surface").first());
    out[`${label}/made-dark-surface`] = darkBg;
    await page.locator("[data-preview]").screenshot({ path: ev("screens", `b6-${label}-made-dark.png`) });
    await page.locator("[data-save-theme]").click();
    await expect(page.getByRole("region", { name: "Notifications" }).getByText(/^Saved /)).toBeVisible();
    const saved = (await (await a.get(`/api/settings/themes/${id}`)).json()).theme;
    out[`${label}/saved`] = { mode: saved.mode, darkGroups: Object.keys(saved.dark ?? {}).sort(), surface: saved.dark?.color?.surface, accent: [saved.tokens.color.accent, saved.dark?.color?.accent] };
    expect(saved.mode).toBe("auto");
    expect(Object.keys(saved.dark ?? {}).sort()).toEqual(["chrome", "color", "motion", "shape", "space", "surface", "type", "wallpaper"]);
    expect(saved.dark.color.accent).toBe(saved.tokens.color.accent);
    await ctx.close();
  }
  // The viewer of an auto app in a dark browser gets the dark set, including the nav style and material.
  const darkNav = await themeFrom(a, "control-room", `w210 dark nav ${tag()}`, (t) => { t.mode = "auto"; t.dark = { ...t.dark, chrome: { ...t.dark.chrome, style: "underline" }, surface: { ...t.dark.surface, material: "glass", opacity: 0.6, blurPx: 12 } }; });
  const app = await makeApp(a, darkNav);
  const dctx = await context(browser, OWNER, { variant: "dark" });
  const dp = await dctx.newPage();
  await dp.goto(`/a/${app.slug}`);
  const canvas = dp.locator("[data-atrium-canvas]").first();
  await expect(canvas).toHaveAttribute("data-canvas-chrome", "underline");
  await expect(canvas).toHaveAttribute("data-canvas-material", "glass");
  out.viewerDark = { chrome: await canvas.getAttribute("data-canvas-chrome"), material: await canvas.getAttribute("data-canvas-material"), surface: await surfaceBg(dp.locator(".atr-card").first()) };
  await dp.screenshot({ path: ev("screens", "b6-viewer-dark-auto.png") });
  await dctx.close();
  const lctx = await context(browser, OWNER);
  const lp = await lctx.newPage();
  await lp.goto(`/a/${app.slug}`);
  await expect(lp.locator("[data-atrium-canvas]").first()).toHaveAttribute("data-canvas-chrome", "boxed-tabs");
  await lp.screenshot({ path: ev("screens", "b6-viewer-light-auto.png") });
  await lctx.close();
  writeFileSync(ev("b6-dark.json"), JSON.stringify(out, null, 2));
  await a.dispose();
});

// ---- V4, V5, V8 screens of the editor ----

test("V4 V5 V8: the theme editor preview in four themes, at 390 px and with reduced motion", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  for (const th of THEMES) {
    const id = await th.make(a);
    const ctx = await context(browser, OWNER);
    const page = await ctx.newPage();
    await openEditor(page, id);
    await page.locator("[data-preview]").screenshot({ path: ev("screens", `v4-editor-preview-${th.label}.png`) });
    await ctx.close();
    if (th.label === "frosted" || th.label === "dusk") {
      const phone = await context(browser, OWNER, { mobile: true });
      const pp = await phone.newPage();
      await openEditor(pp, id);
      await pp.screenshot({ path: ev("screens", `v5-editor-390-${th.label}.png`), fullPage: true });
      const sw = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sw, "no sideways scroll at 390 px").toBeLessThanOrEqual(0);
      await phone.close();
    }
  }
  const id = await themeFrom(a, "control-room", `w210 rm ${tag()}`, (t) => { t.mode = "auto"; });
  const rm = await context(browser, OWNER, { reducedMotion: true });
  const page = await rm.newPage();
  await openEditor(page, id);
  await page.locator('[data-preview] [data-field="preview.scheme"]').getByRole("radio", { name: "Side by side", exact: true }).click();
  await page.locator("[data-preview]").screenshot({ path: ev("screens", "v8-editor-preview-reduced-motion.png") });
  await rm.close();
  await a.dispose();
});
