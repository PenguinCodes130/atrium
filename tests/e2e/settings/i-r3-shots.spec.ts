// settings round 3: before and after screenshots of the visual Fix List items (w2-r2 items 2, 3, 4, 5,
// 6, 7, 8, 9 and the auth note), light and dark. Runs only with ATRIUM_R3_SHOTS=before|after; the
// "before" run uses the round 2 build (selectors here work on both markups). Evidence goes to
// evidence/settings/r3/before-after/<before|after>/. Test-only values; none are real credentials.
import { randomBytes } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ORIGIN, OWNER, context, ev, stateFor } from "./helpers";

const WHEN = process.env.ATRIUM_R3_SHOTS ?? "";
test.setTimeout(300_000);
test.describe.configure({ mode: "serial" });
test.beforeEach(async () => test.skip(!/^(before|after)$/.test(WHEN) || process.env.ATRIUM_E2E_SCENARIO === "locked", "only for the r3 before/after captures"));

const file = (name: string) => ev("before-after", WHEN, `${name}.png`);

async function api(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
}
async function dusk(a: APIRequestContext, name: string): Promise<string> {
  const dup = await a.post("/api/settings/themes/dusk/duplicate");
  const id = (await dup.json()).id as string;
  const cur = await (await a.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = name;
  theme.tokens.wallpaper = { ...theme.tokens.wallpaper, kind: "gradient", value: "linear-gradient(180deg, #1e3c72, #2a5298)" };
  expect((await a.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev } })).status()).toBe(200);
  return id;
}
async function open(page: Page, g: string) {
  const t = page.locator(`[data-group-toggle="${g}"]`);
  if (await t.count()) {
    if ((await page.locator(`[data-group="${g}"]`).getAttribute("data-open")) !== "true") await t.click();
  } else if ((await page.locator(`[data-group="${g}"]`).getAttribute("open")) === null) await page.locator(`[data-group="${g}"] summary`).click();
}
async function clip(page: Page, sel: string, pad = 12) {
  const b = (await page.locator(sel).first().boundingBox())!;
  const vw = page.viewportSize()!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, width: Math.min(vw.width - x, b.width + pad * 2), height: Math.min(vw.height - y, b.height + pad * 2) };
}

test("before/after captures", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const a = await api();
  const id = await dusk(a, `shots ${WHEN} ${info.project.name} ${randomBytes(2).toString("hex")}`);
  const hasApps = (await a.get("/api/apps")).status() !== 404;
  let slug: string | null = null;
  if (hasApps) {
    slug = `shots-${WHEN}-${info.project.name}-${randomBytes(2).toString("hex")}`;
    const app = (await (await a.post("/api/apps", { data: { name: `Shots ${WHEN}`, slug, template: "blank" } })).json()).app;
    const d = await (await a.get(`/api/apps/${app.id}/draft`)).json();
    await a.post(`/api/apps/${app.id}/publish`, { data: { expectRev: d.rev, note: "shots" } });
  }
  for (const variant of ["light", "dark"] as const) {
    const tag = `${info.project.name}-${variant}`;
    const ctx = await context(browser, OWNER, { mobile, variant });
    const page = await ctx.newPage();
    // Items 2, 3, 7, 8: the editor with Surfaces open (sliders, swatches, fold, button words).
    await page.goto(`/settings/themes/${id}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.locator("[data-basics]").screenshot({ path: file(`editor-basics-${tag}`) });
    await open(page, "surfaces");
    await page.waitForTimeout(600);
    await page.locator('[data-group="surfaces"]').screenshot({ path: file(`editor-surfaces-${tag}`) });
    await page.locator("[data-editor-actions]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: file(`editor-actions-${tag}`), clip: await clip(page, "[data-editor-actions]") });
    if (mobile) {
      // Item 6: every group open, scrolled to 0.3 and 0.6 of the page.
      for (const g of ["colours", "type", "shape", "motion", "chrome", "dark", "advanced"]) await open(page, g);
      await page.waitForTimeout(600);
      const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      for (const f of [0.3, 0.6]) {
        await page.evaluate((y) => window.scrollTo(0, y), Math.round(max * f));
        await page.waitForTimeout(200);
        await page.screenshot({ path: file(`editor-phone-scroll-${f}-${variant}`) });
      }
    }
    // Item 4: theme cards (the action row).
    await page.goto("/settings/themes");
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.locator(`[data-theme-window="${id}"]`).scrollIntoViewIfNeeded();
    await page.locator(`[data-theme-window="${id}"]`).screenshot({ path: file(`themes-card-${tag}`) });
    // Item 9: General.
    await page.goto("/settings/general");
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.screenshot({ path: file(`general-${tag}`), fullPage: true });
    // Auth note: /settings/users, first screen.
    await page.goto("/settings/users");
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.screenshot({ path: file(`users-${tag}`) });
    // Items 5 and 8: launcher and viewer with the sage accent.
    if (hasApps) {
      await a.put("/api/settings/instance", { data: { brandAccent: "sage" } });
      await page.goto("/");
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.screenshot({ path: file(`launcher-sage-${tag}`) });
      await page.goto(`/a/${slug}`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.screenshot({ path: file(`viewer-sage-${tag}`) });
      await a.put("/api/settings/instance", { data: { brandAccent: null } });
    }
    await ctx.close();
  }
  await a.dispose();
});
