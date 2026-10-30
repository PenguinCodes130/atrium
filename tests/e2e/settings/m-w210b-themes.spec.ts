// Wave 2.10b, builder S: the operator's theme friction items F10, F11 and F12 (operator-tryout-spec.md
// section 4, acceptance criteria 17 to 19), through the real theme editor and the real app viewer.
//   F10 fonts: at least 30 built-in families across sans, serif, mono, display and rounded; every picker
//       row is drawn in its own family; no request leaves for a font host; a family's file loads only
//       when shown or used. The sweep's ten theme pickers each show a small drawn sample.
//   F11 motion: Play runs the chosen Entrance on the preview's sample widgets (recorded); a viewer of an
//       app with Rise sees its widgets rise on open; with reduced motion nothing moves and Play says so.
//   F12 materials: nav chrome and surfaces share one control (Solid, Gradient, Frosted glass); Frosted
//       glass blurs the wallpaper behind the nav; Gradient works for both; blur and opacity only for glass.
// Themes (V4): Control Room, Dusk, Solid and the frosted custom theme (FAKE image wallpaper, glass 0.3,
// blur 1 px, soft shadow, 1 px border). Test-only values; none are real credentials.
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { OWNER, ORIGIN, context, ev, stateFor } from "./helpers";
import { THEMES, api, frostedTheme, makeApp, openEditor, openGroup, publish, radio, saveTheme, tag, themeFrom } from "./w210a-fixtures";

test.setTimeout(300_000);

const KINDS = ["sans", "serif", "mono", "display", "rounded"] as const;

/** Every font request the page makes, and every request that leaves this instance. */
function watchRequests(page: Page) {
  const fonts: string[] = [];
  const foreign: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) foreign.push(u);
    if (r.resourceType() === "font" || /\.(woff2?|ttf|otf)(\?|$)/.test(u)) fonts.push(u.replace(ORIGIN, ""));
  });
  return { fonts, foreign };
}

// ---- F10 ----

test("F10: at least 30 fonts in five kinds, each picker row drawn in its own family, no font host", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `w210b fonts ${tag()}`);
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  const net = watchRequests(page);
  await openEditor(page, id);
  await openGroup(page, "type");
  await page.locator('[data-select="type.display"]').click();
  const menu = page.locator('[data-select-menu="type.display"]');
  await expect(menu).toBeVisible();
  const rows = menu.locator("[data-option]");
  // Scroll through the list so every row is drawn (each row's family is fetched when it is shown).
  const n = await rows.count();
  for (let i = 0; i < n; i += 6) await rows.nth(i).scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const report = await rows.evaluateAll((els) =>
    els.map((el) => {
      const name = el.getAttribute("data-option") ?? "";
      const text = (el.querySelector("[data-font-name]") ?? el) as HTMLElement;
      const family = getComputedStyle(text).fontFamily;
      const first = family.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
      const faces = [...document.fonts].filter((f) => f.family.replace(/^["']|["']$/g, "") === first);
      return { name, kind: el.getAttribute("data-font-kind"), family, first, loaded: faces.some((f) => f.status === "loaded") };
    }),
  );
  await menu.screenshot({ path: ev("screens", "f10-font-picker.png") });
  const shellFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  const problems: string[] = [];
  if (report.length < 30) problems.push(`${report.length} fonts, fewer than 30`);
  for (const k of KINDS) if (!report.some((r) => r.kind === k)) problems.push(`no ${k} font`);
  for (const r of report) {
    // Inter Tight is the shell's own family, so only that row may share the shell's font.
    if (r.family === shellFamily && r.name !== "Inter Tight") problems.push(`${r.name}: drawn in the shell font`);
    if (r.first !== r.name) problems.push(`${r.name}: drawn in ${r.first}`);
    if (!r.loaded) problems.push(`${r.name}: its own family ${r.first} is not loaded`);
  }
  if (new Set(report.map((r) => r.first)).size !== report.length) problems.push("two rows share a family");
  const fontHosts = net.foreign.filter((u) => /fonts\.(googleapis|gstatic)|typekit|fontshare|bunny/.test(u));
  if (fontHosts.length) problems.push(`requests to a font host: ${fontHosts.join(", ")}`);
  writeFileSync(ev("f10-fonts.json"), JSON.stringify({ report, shellFamily, fonts: net.fonts, foreign: net.foreign, problems }, null, 2));
  expect(problems).toEqual([]);
  await ctx.close();
  await a.dispose();
});

test("F10: a family loads only where it is used: the viewer of a Lora app fetches Lora and not the rest", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `w210b lora ${tag()}`, (t) => { t.tokens.type.display = "Lora"; t.tokens.type.body = "Lora"; });
  const app = await makeApp(a, id);
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  const net = watchRequests(page);
  await page.goto(`/a/${app.slug}`);
  await expect(page.locator("[data-atrium-canvas] [data-node]").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const body = await page.locator("[data-atrium-canvas]").first().evaluate((el) => getComputedStyle(el).fontFamily);
  await page.screenshot({ path: ev("screens", "f10-viewer-lora.png") });
  writeFileSync(ev("f10-viewer-lora.json"), JSON.stringify({ body, fonts: net.fonts, foreign: net.foreign }, null, 2));
  expect(body.split(",")[0]).toContain("Lora");
  expect(net.fonts.some((f) => /\/fonts\/lora-/.test(f)), "Lora is fetched from this instance").toBe(true);
  expect(net.fonts.filter((f) => f.startsWith("/fonts/") && !/\/fonts\/lora-/.test(f)), "no other self-hosted family is fetched").toEqual([]);
  expect(net.foreign).toEqual([]);
  await ctx.close();
  await a.dispose();
});

const SWEEP = ["mode", "wallpaper.kind", "surface.material", "surface.border.widthPx", "surface.shadow", "type.numbers", "type.headingWeight", "space.density", "motion.enter", "chrome.style"] as const;
const GROUP_OF: Record<string, string | null> = { mode: null, "wallpaper.kind": null, "surface.material": "surfaces", "surface.border.widthPx": "surfaces", "surface.shadow": "surfaces", "type.numbers": "type", "type.headingWeight": "type", "space.density": "shape", "motion.enter": "motion", "chrome.style": "chrome" };

test("F10 sweep: the ten theme pickers each show a drawn sample on every choice", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const a = await api();
  const id = await themeFrom(a, "control-room", `w210b sweep ${tag()}`);
  const ctx = await context(browser, OWNER, { mobile });
  const page = await ctx.newPage();
  await openEditor(page, id);
  const problems: string[] = [];
  const out: Record<string, unknown> = {};
  for (const field of SWEEP) {
    const g = GROUP_OF[field];
    if (g) await openGroup(page, g);
    const group = page.locator(`[data-field="${field}"][data-choice-group]`);
    await group.scrollIntoViewIfNeeded();
    const choices = group.locator('[role="radio"]');
    const n = await choices.count();
    if (!n) { problems.push(`${field}: no choices`); continue; }
    const samples = await choices.evaluateAll((els) => els.map((el) => {
      const s = el.querySelector<HTMLElement>("[data-choice-sample]");
      const r = s?.getBoundingClientRect();
      return { name: el.getAttribute("aria-label") ?? el.textContent ?? "", sample: !!s, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
    }));
    out[field] = samples;
    for (const s of samples) if (!s.sample || s.w < 12 || s.h < 8) problems.push(`${field} "${s.name}": no drawn sample`);
    await group.screenshot({ path: ev("screens", `f10-sweep-${field.replace(/\./g, "-")}${mobile ? "-390" : ""}.png`) });
  }
  writeFileSync(ev(`f10-sweep${mobile ? "-390" : ""}.json`), JSON.stringify({ out, problems }, null, 2));
  if (mobile) {
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (sw > 0) problems.push(`sideways scroll ${sw}px at 390`);
  }
  expect(problems).toEqual([]);
  await ctx.close();
  await a.dispose();
});

// ---- F11 ----

/** Records, on every frame from the first paint, how far each top-level widget is moved and faded. */
async function recordEntrance(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __enter: { maxY: number; minOpacity: number; frames: number; seen: number } };
    w.__enter = { maxY: 0, minOpacity: 1, frames: 0, seen: 0 };
    const t0 = performance.now();
    const tick = () => {
      const root = document.querySelector("main [data-node]");
      if (root) {
        const tops = [...root.querySelectorAll<HTMLElement>("[data-node]")].filter((n) => n.parentElement?.closest("[data-node]") === root);
        w.__enter.seen = Math.max(w.__enter.seen, tops.length);
        // The widget as drawn: its own box and the grid cell around it (either may carry the entrance).
        for (const n of tops) {
          let y = 0, op = 1;
          for (const el of [n, n.parentElement!]) {
            const s = getComputedStyle(el);
            const m = new DOMMatrixReadOnly(s.transform === "none" ? undefined : s.transform);
            y += Math.abs(m.m42);
            op *= Number(s.opacity);
          }
          w.__enter.maxY = Math.max(w.__enter.maxY, y);
          w.__enter.minOpacity = Math.min(w.__enter.minOpacity, op);
        }
        w.__enter.frames++;
      }
      if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test("F11: a viewer of an app with Rise sees its widgets rise on open; with reduced motion nothing moves", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `w210b rise ${tag()}`, (t) => { t.tokens.motion.enter = "rise"; });
  const app = await makeApp(a, id);
  const out: Record<string, unknown> = {};
  for (const reduced of [false, true]) {
    const ctx = await context(browser, OWNER, { reducedMotion: reduced });
    const page = await ctx.newPage();
    await recordEntrance(page);
    await page.goto(`/a/${app.slug}`);
    await expect(page.locator("main [data-node]").first()).toBeVisible();
    await page.waitForTimeout(2700);
    const r = await page.evaluate(() => (window as unknown as { __enter: unknown }).__enter);
    out[reduced ? "reduced" : "motion"] = r;
    await page.screenshot({ path: ev("screens", `f11-viewer-rise${reduced ? "-reduced" : ""}.png`) });
    await ctx.close();
  }
  writeFileSync(ev("f11-viewer-rise.json"), JSON.stringify(out, null, 2));
  const m = out.motion as { maxY: number; minOpacity: number; seen: number };
  const rm = out.reduced as { maxY: number; minOpacity: number; seen: number };
  expect(m.seen, "top-level widgets found").toBeGreaterThanOrEqual(3);
  expect(m.maxY, "widgets move up on open").toBeGreaterThan(2);
  expect(m.minOpacity, "widgets fade in on open").toBeLessThan(0.6);
  expect(rm.maxY, "reduced motion: no movement").toBe(0);
  expect(rm.minOpacity, "reduced motion: no fade").toBe(1);
  await a.dispose();
});

test("F11: Play in the editor runs the chosen Entrance on the sample widgets (recorded); reduced motion says so", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "dusk", `w210b play ${tag()}`);
  const out: Record<string, unknown> = {};
  for (const reduced of [false, true]) {
    const rec = await browser.newContext({
      storageState: await stateFor(OWNER),
      baseURL: ORIGIN,
      viewport: { width: 1280, height: 800 },
      reducedMotion: reduced ? "reduce" : "no-preference",
      recordVideo: { dir: ev("videos", reduced ? "f11-play-reduced" : "f11-play"), size: { width: 1280, height: 800 } },
    });
    await rec.addCookies([{ name: "atrium_theme", value: "light", url: ORIGIN }, { name: "atrium_swept", value: "1", url: ORIGIN }]);
    const page = await rec.newPage();
    await openEditor(page, id);
    await openGroup(page, "motion");
    await radio(page, "motion.enter", "Rise", "rise").click();
    const play = page.locator("[data-play-entrance]");
    await expect(play).toBeVisible();
    await page.locator("[data-preview]").scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const w = window as unknown as { __play: { maxY: number; minOpacity: number; frames: number } };
      w.__play = { maxY: 0, minOpacity: 1, frames: 0 };
      const t0 = performance.now();
      const tick = () => {
        for (const n of document.querySelectorAll<HTMLElement>("[data-preview] [data-sample-card]")) {
          const s = getComputedStyle(n);
          const m = new DOMMatrixReadOnly(s.transform === "none" ? undefined : s.transform);
          w.__play.maxY = Math.max(w.__play.maxY, Math.abs(m.m42));
          w.__play.minOpacity = Math.min(w.__play.minOpacity, Number(s.opacity));
        }
        w.__play.frames++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await play.click();
    await page.waitForTimeout(2100);
    const r = await page.evaluate(() => (window as unknown as { __play: unknown }).__play);
    const note = await page.locator("[data-entrance-reduced-note]").count();
    out[reduced ? "reduced" : "motion"] = { ...(r as object), note };
    await page.locator("[data-preview]").screenshot({ path: ev("screens", `f11-play${reduced ? "-reduced" : ""}.png`) });
    if (reduced) await expect(page.locator("[data-entrance-reduced-note]")).toContainText(/reduced motion/i);
    await rec.close();
  }
  writeFileSync(ev("f11-play.json"), JSON.stringify(out, null, 2));
  const m = out.motion as { maxY: number; minOpacity: number };
  const rm = out.reduced as { maxY: number; minOpacity: number; note: number };
  expect(m.maxY, "Play moves the sample widgets").toBeGreaterThan(2);
  expect(m.minOpacity, "Play fades the sample widgets in").toBeLessThan(0.6);
  expect(rm.maxY, "reduced motion: Play moves nothing").toBe(0);
  expect(rm.note, "reduced motion: Play says so").toBe(1);
  await a.dispose();
});

// ---- F12 ----

async function materialChoices(page: Page, field: string) {
  return page.locator(`[data-field="${field}"][data-choice-group] [role="radio"]`).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? (e.textContent ?? "").trim()));
}

test("F12: nav chrome and surfaces share one material control; blur and opacity show only for glass", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const a = await api();
  const id = await themeFrom(a, "control-room", `w210b material ${tag()}`);
  const ctx = await context(browser, OWNER, { mobile });
  const page = await ctx.newPage();
  await openEditor(page, id);
  const out: Record<string, unknown> = {};
  for (const [g, prefix] of [["surfaces", "surface"], ["chrome", "chrome"]] as const) {
    await openGroup(page, g);
    out[`${prefix}.choices`] = await materialChoices(page, `${prefix}.material`);
    expect(out[`${prefix}.choices`]).toEqual(["Solid", "Gradient", "Frosted glass"]);
    await radio(page, `${prefix}.material`, "Solid", "solid").click();
    await expect(page.locator(`[data-field="${prefix}.blurPx"]`)).toHaveCount(0);
    await expect(page.locator(`[data-field="${prefix}.opacity"]`)).toHaveCount(0);
    await radio(page, `${prefix}.material`, "Frosted glass", "glass").click();
    await expect(page.locator(`[data-field="${prefix}.blurPx"]`)).toBeVisible();
    await expect(page.locator(`[data-field="${prefix}.opacity"]`)).toBeVisible();
    await page.locator(`[data-group="${g}"]`).screenshot({ path: ev("screens", `f12-${prefix}-glass${mobile ? "-390" : ""}.png`) });
    await radio(page, `${prefix}.material`, "Gradient", "gradient").click();
    await expect(page.locator(`[data-field="${prefix}.blurPx"]`)).toHaveCount(0);
    await expect(page.locator(`[data-field="${prefix}.gradient.0"]`)).toBeVisible();
    await page.locator(`[data-group="${g}"]`).screenshot({ path: ev("screens", `f12-${prefix}-gradient${mobile ? "-390" : ""}.png`) });
  }
  // Gradient now draws in the preview for both the nav and the cards.
  const bg = await page.evaluate(() => ({
    nav: getComputedStyle(document.querySelector("[data-preview] [data-canvas-nav]")!).backgroundImage,
    card: getComputedStyle(document.querySelector("[data-preview] [data-sample-card]")!).backgroundImage,
  }));
  out.previewGradient = bg;
  writeFileSync(ev(`f12-control${mobile ? "-390" : ""}.json`), JSON.stringify(out, null, 2));
  expect(bg.nav).toContain("linear-gradient");
  expect(bg.card).toContain("linear-gradient");
  await ctx.close();
  await a.dispose();
});

test("F12: Frosted glass nav blurs the wallpaper behind it in the viewer; Gradient works for nav and surfaces", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await frostedTheme(a, `w210b frosted nav ${tag()}`);
  await saveTheme(a, id, (t) => { t.tokens.chrome = { ...t.tokens.chrome, material: "glass", opacity: 0.4, blurPx: 16 }; });
  const app = await makeApp(a, id);
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/a/${app.slug}`);
  const nav = page.locator("[data-canvas-nav]").first();
  await expect(nav).toBeVisible();
  const glass = await nav.evaluate((n) => { const s = getComputedStyle(n); return { backdrop: s.backdropFilter || (s as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter, bg: s.backgroundColor }; });
  await nav.screenshot({ path: ev("screens", "f12-viewer-nav-glass.png") });
  await page.screenshot({ path: ev("screens", "f12-viewer-frosted-glass-nav.png") });
  await saveTheme(a, id, (t) => {
    t.tokens.chrome = { ...t.tokens.chrome, material: "gradient", gradient: ["#F3EFE4", "#A9C8E4"] };
    t.tokens.surface = { ...t.tokens.surface, material: "gradient", gradient: ["#FFFFFF", "#E8E2D2"] };
  });
  await publish(a, app.id);
  await page.goto(`/a/${app.slug}`);
  await expect(nav).toBeVisible();
  const grad = await page.evaluate(() => ({
    nav: getComputedStyle(document.querySelector("[data-canvas-nav]")!).backgroundImage,
    surface: getComputedStyle(document.querySelector("[data-atrium-canvas] .canvas-surface")!).backgroundImage,
  }));
  await page.screenshot({ path: ev("screens", "f12-viewer-gradient.png") });
  writeFileSync(ev("f12-viewer.json"), JSON.stringify({ glass, grad }, null, 2));
  expect(glass.backdrop).toContain("blur(16px)");
  const alpha = /rgba?\([^)]*,\s*([0-9.]+)\)$/.exec(glass.bg)?.[1] ?? (glass.bg.includes("/") ? glass.bg.split("/")[1]!.replace(")", "").trim() : "1");
  expect(Number(alpha), `nav fill is see-through (${glass.bg})`).toBeLessThan(0.9);
  expect(grad.nav).toContain("linear-gradient");
  expect(grad.surface).toContain("linear-gradient");
  await ctx.close();
  await a.dispose();
});

// ---- V4 V5 V8 ----

test("V4 V5 V8: the new pickers, materials and Play in four themes, at 390 px and with reduced motion", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  for (const th of THEMES) {
    const id = await th.make(a);
    const ctx = await context(browser, OWNER);
    const page = await ctx.newPage();
    await openEditor(page, id);
    await openGroup(page, "surfaces");
    await page.locator('[data-group="surfaces"]').screenshot({ path: ev("screens", `v4-surfaces-${th.label}.png`) });
    await openGroup(page, "chrome");
    await page.locator('[data-group="chrome"]').screenshot({ path: ev("screens", `v4-chrome-${th.label}.png`) });
    await page.locator("[data-preview]").screenshot({ path: ev("screens", `v4-preview-${th.label}.png`) });
    await ctx.close();
    const phone = await context(browser, OWNER, { mobile: true });
    const pp = await phone.newPage();
    await openEditor(pp, id);
    await openGroup(pp, "motion");
    await pp.locator('[data-group="motion"]').screenshot({ path: ev("screens", `v5-motion-390-${th.label}.png`) });
    const sw = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sw, "no sideways scroll at 390 px").toBeLessThanOrEqual(0);
    await phone.close();
  }
  const rm = await context(browser, OWNER, { reducedMotion: true });
  const page = await rm.newPage();
  const id = await themeFrom(a, "control-room", `w210b rm ${tag()}`);
  await openEditor(page, id);
  await openGroup(page, "motion");
  await page.locator("[data-play-entrance]").click();
  await page.locator('[data-group="motion"]').screenshot({ path: ev("screens", "v8-play-reduced-motion.png") });
  await expect(page.locator("[data-entrance-reduced-note]")).toBeVisible();
  await rm.close();
  await a.dispose();
});
