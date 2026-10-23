// Custom API by example: curl with a bearer token, the response tree, picks, proposals and saving.
import Database from "better-sqlite3";
import path from "node:path";
import { test, expect } from "../fixtures";
import { captureTraffic, DATA_DIR, themedContext, type Theme, shot } from "./helpers";
import { FAKE, fakeHomeApi, type HomeApi } from "./fakes";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project"));

let api: HomeApi;
test.beforeAll(async () => { api = await fakeHomeApi(); });
test.afterAll(async () => { await api.close(); });

const cacheRows = () => {
  const db = new Database(path.join(DATA_DIR, "atrium.db"), { readonly: true, fileMustExist: true });
  try { return (db.prepare("SELECT count(*) AS n FROM endpoint_cache").get() as { n: number }).n; } finally { db.close(); }
};

async function tryCurl(page: import("@playwright/test").Page) {
  await page.goto("/integrations/new/by-example");
  await page.locator("[data-try-input]").fill(`curl -s '${api.url}/api/stats' \\\n  -H 'Authorization: Bearer ${FAKE.curlBearer}' -H 'Accept: application/json'`);
  await page.locator("[data-try-button]").click();
  await expect(page.locator("[data-response-tree]")).toBeVisible({ timeout: 10_000 });
}

test("a pasted curl command with a bearer token gives a request with no visible token and a new secret field; no Try it response contains it (criterion 23)", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "try-it-curl");
  const responses: string[] = [];
  page.on("response", async (r) => { if (r.url().includes("/api/integrations/try")) responses.push((await r.body()).toString()); });
  await tryCurl(page);
  await expect(page.locator("[data-try-input]")).toHaveValue(`${api.url}/api/stats`);
  await expect(page.locator("[data-secret-fields]")).toContainText("Bearer token: kept on the server");
  expect(await page.content()).not.toContain(FAKE.curlBearer);
  expect(responses.length).toBeGreaterThan(0);
  for (const r of responses) expect(r).not.toContain(FAKE.curlBearer);
  // The service echoed the header; the tree shows it scrubbed.
  await expect(page.locator('[data-tree-leaf="$.seenAuth"] [data-leaf-value]')).toHaveText('"[secret]"');
  // A re-run from the plain URL still authenticates with the held token.
  await page.locator("[data-try-button]").click();
  await expect(page.locator('[data-tree-leaf="$.load"]')).toBeVisible();
  for (const r of responses) expect(r).not.toContain(FAKE.curlBearer);
  await ctx.close();
});

test("clicking a number then value proposes a stat shape and a stat widget; strings over 2 KB are cut short and Try it adds no cache entry (criteria 24, 26)", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  const before = cacheRows();
  await tryCurl(page);
  expect(cacheRows()).toBe(before);
  await expect(page.locator('[data-tree-leaf="$.notes"]')).toContainText("(cut short)");
  const shown = (await page.locator('[data-tree-leaf="$.notes"] [data-leaf-value]').textContent()) ?? "";
  expect(shown.length).toBeLessThan(2100);
  await page.locator('[data-tree-leaf="$.load"]').click();
  await page.locator('[data-role-picker] [data-role="value"]').click();
  await expect(page.locator("[data-proposed]")).toHaveText("Shown as: Big number (one value)");
  await page.locator("[data-advanced-toggle]").click();
  await expect(page.locator("[data-shape-select]")).toHaveValue("stat");
  await expect(page.locator("[data-widget-select]")).toHaveValue("stat");
  await expect(page.locator("[data-preview] [data-stat-value]")).toHaveText("0.42");
  await ctx.close();
});

test("a time field and a number inside an array propose a series shape and a chart widget (criterion 25, V4 by-example tree)", async ({ browser }) => {
  for (const theme of ["daylight", "dusk", "solid"] as Theme[]) {
    const ctx = await themedContext(browser, theme);
    const page = await ctx.newPage();
    await tryCurl(page);
    await page.locator('[data-tree-leaf="$.history[0].t"]').click();
    await page.locator('[data-role-picker] [data-role="time"]').click();
    await page.locator('[data-tree-leaf="$.history[0].v"]').click();
    await page.locator('[data-role-picker] [data-role="value"]').click();
    await expect(page.locator("[data-proposed]")).toHaveText("Shown as: Line chart (values over time)");
    await expect(page.locator('[data-picks] [data-pick-path="$.history[0].t"]')).toHaveText("history > item 1 > t");
    await expect(page.locator("[data-preview] [data-series-chart]")).toBeVisible();
    await expect(page.locator("[data-preview] [data-series-latest]")).toHaveText("0.42");
    await shot(page, `screens/by-example-tree-${theme}.png`);
    await ctx.close();
  }
});

test("a refresh below 10 seconds cannot be saved; 10 or more saves a custom endpoint (criterion 27)", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "by-example-save");
  await tryCurl(page);
  await page.locator('[data-tree-leaf="$.load"]').click();
  await page.locator('[data-role-picker] [data-role="value"]').click();
  await page.locator("#ep-name").fill("Box load");
  await page.locator("[data-refresh]").fill("5");
  await expect(page.getByText("Refresh must be at least 10 seconds.").first()).toBeVisible();
  await expect(page.locator("[data-save-endpoint]")).toBeDisabled();
  await page.locator("[data-refresh]").fill("10");
  await expect(page.locator("[data-save-endpoint]")).toBeEnabled();
  await page.locator("[data-save-endpoint]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.locator('[data-endpoint="box-load"] [data-stat-value]')).toHaveText("0.42", { timeout: 10_000 });
  expect(await page.content()).not.toContain(FAKE.curlBearer);
  // The API refuses a 9 second refresh too, whatever the browser sends.
  const id = page.url().split("/").pop()!;
  const r = await page.request.post(`/api/integrations/${id}/endpoints`, { data: { id: "fast", label: "Fast", method: "GET", path: "/api/stats", auth: "token", fields: [{ path: "$.load", label: "L", role: "value" }], shape: "stat", refreshSec: 9 }, headers: { origin: new URL(page.url()).origin } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error.message).toContain("at least 10 seconds");
  await ctx.close();
});

test("Try it refuses metadata and link-local addresses, including by redirect, with the friendly heading (criterion 38)", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto("/integrations/new/by-example");
  for (const u of ["http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "http://[fd00:ec2::254]/"]) {
    await page.locator("[data-try-input]").fill(u);
    await page.locator("[data-try-button]").click();
    await expect(page.locator("[data-error-heading]")).toHaveText("Not permitted");
    await expect(page.locator("[data-error-code=permission]")).toContainText("This integration is not allowed to reach that address");
  }
  await ctx.close();
});
