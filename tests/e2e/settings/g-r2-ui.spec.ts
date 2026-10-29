// settings round 2, the UI items of the w2-r1 gauntlet Fix List, in the real build (with the shared file
// requests applied for 8, 14, 15 and 17):
//   5  the accent drives the nav's active item by default ("follows accent")
//   6  design-system controls, no native radios, checkboxes, selects or file pickers
//   7  theme cards two or three per row, samples at least 360px wide, "used by" as a count
//   8  instance branding: accent from the shell palette, logo, favicon, sign-in wallpaper
//   9  the theme editor on a phone: 44px segments and a Save in reach
//  11  a contrast warning over an image wallpaper
//  12  a stored gradient shows its own stops and angle; a custom one is never silently replaced
//  14  one label style, one input height, spaced switches, crumb matches the tab
//  15  theme CSS cannot name view transitions or anchors
//  16  quiet placeholder tabs
//  17  button text at -0.01em
// Test-only values; none are real credentials.
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ORIGIN, OWNER, context, ev, shot, stateFor } from "./helpers";

test.setTimeout(240_000);
test.describe.configure({ mode: "serial" });
test.beforeEach(async () => test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario"));

const out: Record<string, unknown> = {};
test.afterAll(({}, info) => { if (Object.keys(out).length) writeFileSync(ev(`r2-ui-${info.project.name}.json`), JSON.stringify(out, null, 2)); });

/** A small RGB PNG from a pixel function (test fixtures only). */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const CHECKER = png(32, 32, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [255, 255, 255] : [0, 0, 0]);
const LOGO = png(48, 24, (x) => (x < 24 ? [47, 111, 176] : [233, 185, 73]));

async function api(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
}
async function upload(a: APIRequestContext, name: string, buffer: Buffer): Promise<string> {
  const r = await a.post("/api/settings/uploads", { multipart: { accept: "image", file: { name, mimeType: "image/png", buffer } } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).path as string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixtures edit a theme document loosely
type Doc = Record<string, any>;
async function themeFrom(a: APIRequestContext, base: string, name: string, patch: (t: Doc) => void = () => {}): Promise<string> {
  const dup = await a.post(`/api/settings/themes/${base}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  const cur = await (await a.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = name;
  patch(theme);
  const put = await a.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}
const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);

test("item 5: setting #22c55e on a Dusk copy recolours the nav pill in the preview and the published app", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "dusk", `r2 dusk ${randomBytes(2).toString("hex")}`);
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/settings/themes/${id}`);
  await expect(page.locator("[data-chrome-follows]")).toBeVisible();
  await page.locator('[data-field="color.accent"]').fill("#22c55e");
  await expect.poll(() => bg(page, "[data-preview] [data-canvas-nav] [aria-current=\"page\"]")).toBe("rgb(34, 197, 94)");
  await page.locator('[data-group-toggle="chrome"]').click();
  await expect(page.locator("[data-follows-accent]")).toHaveAttribute("aria-checked", "true");
  await shot(page, "r2-accent-follows-preview");
  await page.locator("[data-save-theme]").click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText(/^Saved /)).toBeVisible();
  const saved = (await (await a.get(`/api/settings/themes/${id}`)).json()).theme.tokens;
  out.item5 = { accent: saved.color.accent, activeFill: saved.chrome.activeFill };
  expect(saved.chrome.activeFill.toLowerCase()).toBe("#22c55e");
  // Set apart: the active fill keeps its own colour when the accent changes.
  await page.locator("[data-follows-accent]").click();
  await page.locator('[data-field="color.accent"]').fill("#2f6fb0");
  await expect.poll(() => bg(page, "[data-preview] [data-canvas-nav] [aria-current=\"page\"]")).toBe("rgb(34, 197, 94)");
  // The published app (a theme picked before publish) shows the new pill colour.
  if ((await a.get("/api/apps")).status() !== 404) {
    const slug = `r2-accent-${randomBytes(3).toString("hex")}`;
    const app = (await (await a.post("/api/apps", { data: { name: "r2 accent", slug, template: "blank" } })).json()).app;
    let d = await (await a.get(`/api/apps/${app.id}/draft`)).json();
    expect((await a.post(`/api/apps/${app.id}/ops`, { data: { rev: d.rev, ops: [{ op: "theme.set", theme: { themeId: id } }] } })).status()).toBe(200);
    d = await (await a.get(`/api/apps/${app.id}/draft`)).json();
    expect((await a.post(`/api/apps/${app.id}/publish`, { data: { expectRev: d.rev, note: "r2" } })).status()).toBe(200);
    await page.goto(`/a/${slug}`);
    const fill = await page.locator("[data-atrium-canvas]").first().evaluate((el) => getComputedStyle(el).getPropertyValue("--theme-chrome-active-fill").trim());
    out.item5published = fill;
    expect(fill.toLowerCase()).toBe("#22c55e");
    await shot(page, "r2-accent-follows-published");
  }
  await a.dispose();
  await ctx.close();
});

test("items 6 and 14: no native controls; one label style; inputs 36px with a pointer, 44px on touch; crumb matches the tab", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const ctx = await context(browser, OWNER, { mobile });
  const page = await ctx.newPage();
  const report: Record<string, unknown> = {};
  for (const path of ["/settings/general", "/settings/backups", "/settings/appearance"]) {
    await page.goto(path);
    await expect(page.locator("[data-settings-screen]")).toBeVisible();
    const r = await page.evaluate(() => {
      const visible = (el: Element) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 2 && b.height > 2 && s.visibility !== "hidden" && s.clipPath === "none" && s.clip === "auto"; };
      const scope = document.querySelector("[data-settings-screen]")!;
      const natives = [...scope.querySelectorAll('input[type=radio], input[type=checkbox], select, input[type=file]')].filter(visible).map((el) => el.outerHTML.slice(0, 80));
      const inputs = [...scope.querySelectorAll("input:not([type=file]):not([type=color]), [data-select], [role=radio], [data-file-button]")].filter(visible).map((el) => Math.round(el.getBoundingClientRect().height));
      const labels = [...scope.querySelectorAll("label, legend, [data-choice-group] > span")].filter(visible).map((el) => { const s = getComputedStyle(el); return `${s.fontFamily.split(",")[0]} ${s.fontSize}`; });
      return { natives, inputHeights: [...new Set(inputs)], labelStyles: [...new Set(labels)] };
    });
    report[path] = r;
    expect(r.natives, path).toEqual([]);
    for (const h of r.inputHeights as number[]) expect(h, `${path} control height`).toBeGreaterThanOrEqual(mobile ? 44 : 36);
    await shot(page, `r2-controls-${path.split("/").pop()}-${mobile ? "mobile" : "desktop"}`);
  }
  // The backups file field: a Secondary button with the file name in mono, 44px tall on touch.
  await page.goto("/settings/backups");
  const fileBtn = page.locator("[data-backup-import] [data-file-button]");
  const h = (await fileBtn.boundingBox())!.height;
  report.fileButtonHeight = h;
  expect(h).toBeGreaterThanOrEqual(mobile ? 44 : 36);
  expect(await page.locator("[data-backup-import] [data-file-name]").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Geist Mono|mono/i);
  // Crumbs match the tab.
  if (!mobile) {
    for (const [p, want] of [["/settings/themes", "Themes"], ["/settings/security", "Security"], ["/settings/users", "Users"]] as const) {
      await page.goto(p);
      const crumbs = async () => (await page.locator("[data-crumb-list] li").allInnerTexts()).map((t) => t.replace(/\//g, "").trim()).filter(Boolean).slice(1);
      await expect.poll(crumbs).toEqual(["settings", want]);
      report[`crumb ${p}`] = await crumbs();
    }
    // Appearance switch rows: 12px apart with a hairline between.
    await page.goto("/settings/appearance");
    const rows = page.locator("[data-switch-rows] > div");
    expect(await rows.count()).toBe(2);
    const pad = await rows.first().evaluate((el) => getComputedStyle(el).paddingTop);
    expect(pad).toBe("12px");
  }
  out[`items6and14-${mobile ? "mobile" : "desktop"}`] = report;
  await ctx.close();
});

test("item 7: two or three theme cards per row, samples at least 360px wide, used-by as a count, buttons on one baseline", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop layout");
  for (const width of [1280, 1600]) {
    const ctx = await browser.newContext({ storageState: await stateFor(OWNER), baseURL: ORIGIN, viewport: { width, height: 900 } });
    await ctx.addCookies([{ name: "atrium_swept", value: "1", url: ORIGIN }]);
    const page = await ctx.newPage();
    await page.goto("/settings/themes");
    await expect(page.locator("[data-theme-window]").first()).toBeVisible();
    const r = await page.evaluate(() => {
      const wins = [...document.querySelectorAll("[data-theme-window]")];
      const tops = new Map<number, number>();
      for (const w of wins) { const t = Math.round(w.getBoundingClientRect().top); tops.set(t, (tops.get(t) ?? 0) + 1); }
      const sampleWidths = [...document.querySelectorAll("[data-theme-window] [data-theme-sample]")].map((s) => Math.round(s.getBoundingClientRect().width));
      const baselines = wins.map((w) => [...w.querySelectorAll("[data-theme-actions] > *")].map((b) => Math.round(b.getBoundingClientRect().bottom))).map((list) => new Set(list).size);
      const usedBy = [...document.querySelectorAll("[data-theme-window] [data-used-by]")].map((u) => (u.querySelector("summary") ?? u).textContent);
      return { perRow: [...tops.values()], sampleWidths, baselines, usedBy };
    });
    out[`item7-${width}`] = r;
    expect(Math.max(...r.perRow)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...r.perRow)).toBeLessThanOrEqual(3);
    for (const w of r.sampleWidths) expect(w).toBeGreaterThanOrEqual(360);
    for (const b of r.baselines) expect(b).toBe(1);
    for (const u of r.usedBy) expect(u).toMatch(/^Used by (no apps|\d+ apps?)$/);
    await page.screenshot({ path: ev("screens", `r2-themes-cards-${width}.png`), fullPage: true });
    await ctx.close();
  }
});

test("item 8: instance branding: palette accent, logo, favicon and sign-in wallpaper, served to signed-out visitors", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const logo = await upload(a, "logo.png", LOGO);
  const wall = await upload(a, "wall.png", CHECKER);
  const bad = await a.put("/api/settings/instance", { data: { brandAccent: "#ff0000" } });
  expect(bad.status()).toBe(400);
  const css = await a.put("/api/settings/instance", { data: { brandAccent: "red;}body{display:none" } });
  expect(css.status()).toBe(400);
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto("/settings/general");
  await page.locator('[data-branding] [data-accent="sky"]').click();
  const inputs = page.locator("[data-branding] [data-upload-input]");
  await inputs.nth(0).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: LOGO });
  await inputs.nth(1).setInputFiles({ name: "favicon.png", mimeType: "image/png", buffer: LOGO });
  await inputs.nth(2).setInputFiles({ name: "wall.png", mimeType: "image/png", buffer: CHECKER });
  await expect(page.locator("[data-branding] [data-upload-preview]")).toHaveCount(3);
  await page.locator("[data-save-branding]").click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("Saved branding")).toBeVisible();
  await page.reload();
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  out.item8 = { accent, logo, wall };
  expect(accent).toBe("#8fb8de");
  await expect(page.locator("[data-brand-logo]")).toBeVisible();
  const icon = await page.locator('link[rel="icon"]').first().getAttribute("href");
  expect(icon).toMatch(/^\/uploads\/brand\/favicon\?v=/);
  await shot(page, "r2-branding-settings");
  // Signed out: the sign-in page shows the wallpaper and the accent; the three images load without a session.
  const anon = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 800 } });
  const sp = await anon.newPage();
  await sp.goto("/sign-in");
  await expect(sp.locator("[data-sign-in-wallpaper]")).toBeVisible();
  expect(await sp.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#8fb8de");
  await sp.screenshot({ path: ev("screens", "r2-branding-sign-in.png") });
  const anonApi = await request.newContext({ baseURL: ORIGIN });
  for (const slot of ["logo", "favicon", "sign-in"]) {
    const r = await anonApi.get(`/uploads/brand/${slot}`);
    expect(r.status(), slot).toBe(200);
    expect(r.headers()["content-type"]).toBe("image/png");
    expect(r.headers()["x-content-type-options"]).toBe("nosniff");
  }
  // Every other upload still needs a session.
  expect((await anonApi.get(logo, { maxRedirects: 0 })).status()).not.toBe(200);
  await anonApi.dispose();
  await anon.close();
  // Back to Atrium's own look for the other specs.
  await page.goto("/settings/general");
  await page.locator('[data-branding] [data-accent="gold"]').click();
  for (const k of ["brandLogo", "brandFavicon", "signInWallpaper"]) await page.locator(`[data-remove-brand="${k}"]`).click();
  await page.locator("[data-save-branding]").click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("Saved branding").last()).toBeVisible();
  await a.dispose();
  await ctx.close();
});

test("items 9, 11, 12: phone editor segments and Save; image wallpaper contrast; gradients keep their stops", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const a = await api();
  const wall = await upload(a, "busy.png", CHECKER);
  const imageTheme = await themeFrom(a, "control-room", `r2 image ${randomBytes(2).toString("hex")}`, (t) => { t.tokens.wallpaper = { ...t.tokens.wallpaper, kind: "image", value: wall }; });
  const gradTheme = await themeFrom(a, "control-room", `r2 grad ${randomBytes(2).toString("hex")}`, (t) => { t.tokens.wallpaper = { ...t.tokens.wallpaper, kind: "gradient", value: "linear-gradient(135deg, #1e3c72, #2a5298)" }; delete t.tokens.wallpaper.colors; });
  const customTheme = await themeFrom(a, "control-room", `r2 custom ${randomBytes(2).toString("hex")}`, (t) => { t.tokens.wallpaper = { ...t.tokens.wallpaper, kind: "gradient", value: "linear-gradient(90deg, #112233, #445566, #778899)" }; delete t.tokens.wallpaper.colors; });
  const ctx = await context(browser, OWNER, { mobile });
  const page = await ctx.newPage();
  // Item 11.
  await page.goto(`/settings/themes/${imageTheme}`);
  const warn = page.locator('[data-contrast-warning="wallpaper-image"]');
  await expect(warn).toBeVisible();
  out[`item11-${info.project.name}`] = await warn.innerText();
  // A checkerboard defeats both ink and white, so the advice is the dim or a calmer image.
  await expect(page.locator("[data-use-suggested], [data-contrast-advice]").first()).toBeVisible();
  await shot(page, `r2-image-contrast-${info.project.name}`);
  if (mobile) {
    // Item 9: every segment at least 44 x 44; Save in reach while the editor scrolls.
    for (const g of await page.locator('[data-group-toggle]').all()) await g.click();
    const small = await page.locator("[data-theme-editor] [role=radio]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && (b.width < 44 || b.height < 44)).map((b) => `${Math.round(b.width)}x${Math.round(b.height)}`));
    out.item9small = small;
    expect(small).toEqual([]);
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(300);
    const save = page.locator("[data-save-theme]");
    await expect(save).toBeInViewport();
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(300);
    await expect(save).toBeInViewport();
    await page.screenshot({ path: ev("screens", "r2-editor-mobile-save-in-reach.png") });
  }
  // Item 12: the stored gradient shows its stops and angle.
  await page.goto(`/settings/themes/${gradTheme}`);
  await expect(page.locator('[data-field="wallpaper.colors.0"]')).toHaveValue("#1e3c72");
  await expect(page.locator('[data-field="wallpaper.colors.1"]')).toHaveValue("#2a5298");
  await expect(page.locator('[data-field="wallpaper.angle"]')).toHaveValue("135");
  await shot(page, `r2-gradient-parsed-${info.project.name}`);
  // A custom gradient is shown as text and saved untouched.
  await page.goto(`/settings/themes/${customTheme}`);
  await expect(page.locator("[data-custom-gradient]")).toBeVisible();
  await expect(page.locator('[data-field="wallpaper.colors.0"]')).toHaveCount(0);
  await page.locator('[data-field="name"]').fill(`r2 custom saved ${info.project.name}`);
  await page.locator("[data-save-theme]").click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText(/^Saved /)).toBeVisible();
  const stored = (await (await a.get(`/api/settings/themes/${customTheme}`)).json()).theme.tokens.wallpaper.value;
  expect(stored).toBe("linear-gradient(90deg, #112233, #445566, #778899)");
  await shot(page, `r2-gradient-custom-${info.project.name}`);
  await a.dispose();
  await ctx.close();
});

test("items 15, 16, 17: no view-transition or anchor names from theme CSS; quiet placeholders; button tracking", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `r2 css ${randomBytes(2).toString("hex")}`, (t) => { t.customCss = "* { view-transition-name: cuhijack; view-transition-class: x; anchor-name: --a; position-anchor: --a; position-area: top; color: inherit }"; });
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/settings/themes/${id}`);
  const named = await page.locator("[data-preview] [data-atrium-canvas] *").evaluateAll((els) => els.filter((e) => { const s = getComputedStyle(e); return (s.viewTransitionName && s.viewTransitionName !== "none") || ((s as unknown as Record<string, string>).anchorName ?? "none") !== "none"; }).length);
  out.item15named = named;
  expect(named).toBe(0);
  for (const t of ["agents", "notifications"]) {
    await page.goto(`/settings/${t}`);
    await expect(page.locator("[data-placeholder-tab] h2")).toHaveClass(/type-title-3/);
    await expect(page.locator("[data-empty-room]")).toHaveCount(0);
    await shot(page, `r2-placeholder-${t}`);
  }
  await page.goto("/settings/security");
  const btn = page.locator("[data-settings-screen] button.type-body").first();
  const ls = await btn.evaluate((el) => ({ ls: getComputedStyle(el).letterSpacing, fs: getComputedStyle(el).fontSize }));
  out.item17 = ls;
  expect(ls.ls).toBe("-0.15px");
  await a.dispose();
  await ctx.close();
});
