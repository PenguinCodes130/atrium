// Data states, packages with problems, declarative packages and the credentials link.
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../fixtures";
import { captureTraffic, DATA_DIR, EVIDENCE, ev, ORIGIN, ownerState, themedContext, type Theme, shot } from "./helpers";
import { FAKE, fakeHomeApi, fakeNpm, type Fake, type HomeApi } from "./fakes";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project"));

let api: HomeApi;
let npm: Fake;
test.beforeAll(async () => { api = await fakeHomeApi(); npm = await fakeNpm(); });
test.afterAll(async () => { await api.close(); await npm.close(); });

const db = () => new Database(path.join(DATA_DIR, "atrium.db"), { fileMustExist: true });
const OPEN_EP = { id: "load", label: "Box load", method: "GET", path: "/api/open", fields: [{ path: "$.load", label: "Load", role: "value" }], shape: "stat", refreshSec: 10 };

async function createCustom(page: import("@playwright/test").Page, name: string, endpoints = [OPEN_EP]): Promise<string> {
  const r = await page.request.post("/api/integrations", { data: { packageId: "custom-api", name, config: { baseUrl: api.url }, untested: true, endpoints }, headers: { origin: ORIGIN } });
  expect(r.status(), await r.text()).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

test("failed shows the warning icon with message and hint on hover and keyboard focus; stale shows the amber dot (criterion 37, V4)", async ({ browser }) => {
  test.setTimeout(120_000);
  const seed = await (await themedContext(browser, "daylight")).newPage();
  const failedId = await createCustom(seed, "Flaky box");
  const staleId = await createCustom(seed, "Quiet box");
  // A cached value an hour old for the stale integration, written before the server first reads it.
  const key = createHash("sha256").update(JSON.stringify([staleId, "load", "null"])).digest("hex");
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const good = { ok: true, data: { kind: "stat", value: 0.66, label: "Load" }, sourceTimestamp: hourAgo, fetchedAt: hourAgo };
  const d = db();
  d.prepare("INSERT INTO endpoint_cache (key, integration_id, endpoint_id, params, last_good, last_attempt, fetched_at, source_timestamp, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(key, staleId, "load", "null", JSON.stringify(good), JSON.stringify(good), Date.parse(hourAgo), hourAgo, Date.now());
  d.close();
  await seed.context().close();

  for (const theme of ["daylight", "dusk", "solid"] as Theme[]) {
    const ctx = await themedContext(browser, theme);
    const page = await ctx.newPage();
    api.setDown(false);
    await page.goto(`/integrations/${failedId}`);
    await expect(page.locator('[data-endpoint="load"] [data-stat-value]')).toHaveText("0.7", { timeout: 10_000 });
    api.setDown(true);
    await page.waitForTimeout(10_500); // past the 10 s minimum so the next preview fetches again
    await page.locator('[data-endpoint="load"] [data-preview-button]').click();
    const card = page.locator('[data-endpoint="load"]');
    await expect(card).toHaveAttribute("data-endpoint-state", "failed", { timeout: 10_000 });
    await expect(card.locator("[data-stat-value]")).toHaveText("0.7"); // last good data stays
    const tip = card.locator("[data-failed-tooltip]");
    await expect(tip).toBeHidden();
    const badge = card.locator('[data-state-badge="failed"] button');
    await expect(async () => { await page.mouse.move(0, 0); await badge.hover(); await expect(tip).toBeVisible({ timeout: 1_000 }); }).toPass({ timeout: 10_000 });
    await expect(tip).toContainText("The service answered with an error (HTTP 503).");
    // Round 2 (item 9): the hint quotes the service's own reason.
    await expect(tip).toContainText('The service said: "maintenance"');
    await shot(page, `screens/widget-failed-${theme}.png`);
    await page.mouse.move(0, 0);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await expect(tip).toBeHidden();
    await badge.focus();
    await expect(tip).toBeVisible();
    api.setDown(false);

    await page.goto(`/integrations/${staleId}?cached=1`);
    const s = page.locator('[data-endpoint="load"]');
    await expect(s).toHaveAttribute("data-endpoint-state", "stale", { timeout: 10_000 });
    await expect(s.locator("[data-stale-dot]")).toBeVisible();
    await expect(s.locator("[data-stat-value]")).toHaveText("0.66");
    await shot(page, `screens/widget-stale-${theme}.png`);
    await ctx.close();
  }
});

test("a rejected package is listed under Packages with problems with id, source, reason and time; all eight official packages still show (criteria 4, 5, V4)", async ({ browser }) => {
  const d = db();
  d.prepare("INSERT OR REPLACE INTO declarative_package (id, manifest, endpoints, status, created_by, created_by_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("local/broken-e2e", JSON.stringify({ atriumApi: "2", kind: "declarative", id: "local/broken-e2e", name: "Broken", version: "1.0.0", author: "e2e", description: "d", icon: "i", permissions: [], config: {}, secrets: [], endpoints: [] }), "[]", "active", "user", "e2e", Date.now(), Date.now());
  d.close();
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  // Importing a valid package reloads the registry, which now meets the broken row.
  const file = { atriumPackage: "1", manifest: { atriumApi: "1", kind: "declarative", id: "local/reload-e2e", name: "Reload", version: "1.0.0", author: "e2e", description: "d", icon: "icon.svg", permissions: [{ kind: "network", hosts: "configured" }], config: { type: "object", properties: { baseUrl: { type: "string", format: "uri" } } }, secrets: [], endpoints: [{ id: "load", label: "Load", description: "d", shape: "stat", defaultRefreshSec: 10, minRefreshSec: 10 }] }, endpoints: [OPEN_EP] };
  for (let i = 0; i < 3; i++) expect((await page.request.post("/api/integrations/packages", { data: file, headers: { origin: ORIGIN } })).status()).toBe(201);
  for (const theme of ["daylight", "dusk", "solid"] as Theme[]) {
    const c = await themedContext(browser, theme);
    const p = await c.newPage();
    await p.goto("/integrations");
    const row = p.locator('[data-problem="local/broken-e2e"]');
    await expect(row).toContainText("local/broken-e2e");
    await expect(row).toContainText("declarative");
    await expect(row).toContainText('atriumApi must be "1"');
    await expect(row).toContainText(/\d{4}/);
    await shot(p, `screens/packages-with-problems-${theme}.png`);
    await c.close();
  }
  await page.goto("/integrations/new");
  await expect(page.locator("[data-gallery-card]")).toHaveCount(9);
  const log = readFileSync(path.join(EVIDENCE, "logs/server-normal.log"), "utf8");
  expect(log.split('Package \\"local/broken-e2e\\" could not be loaded').length - 1).toBe(1);
  await ctx.close();
});

test("a declarative package can be created, tested, exported, deleted and re-imported, and works again after import (criterion 41)", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  const customId = await createCustom(page, "Box for packaging", [OPEN_EP]);
  await page.goto(`/integrations/${customId}`);
  await page.locator("#pkg-name").fill("Home Box E2E");
  // Round 8: wait for each server call before navigating or asserting (the old version raced).
  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/integrations/${customId}/package` && r.request().method() === "POST");
  await page.locator("[data-save-package]").click();
  expect((await saved).ok()).toBe(true);
  await page.goto("/integrations");
  await expect(page.locator('[data-declarative="local/home-box-e2e"]')).toBeVisible();
  const dl = page.waitForEvent("download");
  await page.locator('[data-declarative="local/home-box-e2e"]').getByText("Export").click();
  const file = ev("packages/home-box-e2e.atrium-package.json");
  await (await dl).saveAs(file);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ atriumPackage: "1", manifest: { kind: "declarative", id: "local/home-box-e2e" } });
  // Use it: setup, test, save, data flows.
  await page.goto("/integrations/new/local/home-box-e2e");
  await page.locator('[data-config="baseUrl"]').fill(api.url);
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-save-button]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/);
  const usedBy = page.url();
  await expect(page.locator('[data-endpoint="load"] [data-stat-value]')).toHaveText("0.7", { timeout: 10_000 });
  // Delete the package: the integration loses it.
  await page.goto("/integrations");
  const deleted = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/integrations/packages/") && r.request().method() === "DELETE");
  await page.locator('[data-declarative="local/home-box-e2e"]').getByRole("button", { name: "Delete" }).click();
  expect((await deleted).ok()).toBe(true);
  await expect(page.locator('[data-declarative="local/home-box-e2e"]')).toHaveCount(0);
  await page.goto(usedBy);
  await expect(page.getByText('The package "local/home-box-e2e" is not installed.')).toBeVisible();
  // Re-import the exported file: the same integration works again.
  await page.goto("/integrations");
  // The flake (wave 1 close): setInputFiles could land before the list hydrated, so no change handler
  // ran and nothing was imported. Set the file until the import call is seen and answers 201 (import
  // is idempotent, so a slow first answer followed by a second set is harmless).
  await expect(async () => {
    const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/integrations/packages" && r.request().method() === "POST", { timeout: 4_000 });
    await page.locator("[data-import-input]").setInputFiles(file);
    expect((await posted).status()).toBe(201);
  }).toPass({ timeout: 30_000 });
  await expect(page.locator('[data-declarative="local/home-box-e2e"]')).toBeVisible({ timeout: 10_000 });
  await page.goto(usedBy);
  await page.locator('[data-endpoint="load"] [data-preview-button]').click();
  await expect(page.locator('[data-endpoint="load"] [data-stat-value]')).toHaveText("0.7", { timeout: 10_000 });
  await ctx.close();
});

test("the credentials link opens the draft's secret fields only for a signed-in user, fails after 24 hours and after the secrets are saved (criterion 29)", async ({ browser }) => {
  const id = randomUUID();
  const token = randomBytes(24).toString("base64url");
  const old = randomBytes(24).toString("base64url");
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");
  const d = db();
  const now = Date.now();
  d.prepare("INSERT INTO integration (id, package_id, name, config, secret_fields, status, last_health, created_by, created_by_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "npm", "Agent-made NPM", JSON.stringify({ baseUrl: npm.url, verifyTls: true }), "[]", "draft", null, "agent", "owner", now, now);
  const link = d.prepare("INSERT INTO credential_link (id, integration_id, created_by_id, created_at, expires_at, used_at) VALUES (?,?,?,?,?,?)");
  link.run(hash(token), id, "owner", now, now + 24 * 3600_000, null);
  link.run(hash(old), id, "owner", now - 25 * 3600_000, now - 3600_000, null);
  d.close();
  const url = `/integrations/${id}/credentials?draft=${token}`;

  const anon = await browser.newContext({ baseURL: ORIGIN });
  const a = await anon.newPage();
  await a.goto(url);
  await expect(a).toHaveURL(/\/sign-in/);
  await anon.close();

  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "credentials-page");
  await page.goto(`/integrations/${id}/credentials?draft=${old}`);
  await expect(page.locator("[data-link-expired] [role=alert]")).toHaveText("This link has expired. Ask your agent for a new one");
  await page.goto(url);
  await expect(page.locator("[data-credentials-page] [data-secret]")).toHaveCount(1);
  await expect(page.locator("[data-credentials-page] [data-config]")).toHaveCount(0);
  await expect(page.locator("[data-publish]")).toBeDisabled();
  await page.locator('[data-secret="token"]').fill(FAKE.npmGood);
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
  await shot(page, "screens/credentials-page-daylight.png");
  await page.locator("[data-publish]").click();
  await page.waitForURL(new RegExp(`/integrations/${id}$`));
  await expect(page.locator("[data-status-badge]")).toHaveCount(0);
  await page.goto(url);
  await expect(page.locator("[data-link-expired] [role=alert]")).toHaveText("This link has expired. Ask your agent for a new one");
  expect(await page.content()).not.toContain(FAKE.npmGood);
  await ctx.close();
});

test("owner session file exists for traffic capture", async () => { expect(await ownerState()).toContain("integrations-owner-state"); });
