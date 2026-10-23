// Round 6 (Fix List r3, integrations-gauntlet-r3.md): the Lock sheet, step-up and test path with the
// credential.locked audit row read from the database (item 1); usability's "Save and test" repro
// refreshing the detail page without a reload (item 2); the Picks bar whenever the layout is one
// column (item 3); gallery descriptions in full (item 4); the app's own move-address sheet (item 5);
// V4 screens in light, dark and light-solid and V5 at 390x844. Local fakes only. The seeded tokens
// below are test-only values, none real; V10 greps for them.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { captureTraffic, DATA_DIR, ev, expireStepUps, ORIGIN, pickCredential, SHELL_VARIANTS, shot, stepUpIfAsked, themedContext } from "./helpers";
import { FAKE, fakeHa, fakeHomeApi, fakeRecorder, type FakeHa, type HomeApi } from "./fakes";

const PROD_TOKEN = "SECPROBE-owner-prod-token-r6";
const SPARE_TOKEN = "SECPROBE-owner-spare-token-r6";
const LOG = ev("security/ui-lock-r6.jsonl");
const log = (step: string, data: unknown) => appendFileSync(LOG, `${JSON.stringify({ step, data })}\n`);
const H = { origin: ORIGIN };

type Prom = { url: string; withToken: () => number; close: () => Promise<void> };
/** A fake Prometheus that answers only with the bearer token; counts the requests that carried it. */
async function fakeProm(): Promise<Prom> {
  let withToken = 0;
  const s: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${PROD_TOKEN}`) return send(401, { status: "error", error: "unauthorized" });
    withToken++;
    const now = Math.floor(Date.now() / 1000);
    if (u.pathname === "/api/v1/status/buildinfo") return send(200, { status: "success", data: { version: "3.14.0" } });
    if (u.pathname === "/api/v1/targets") return send(200, { status: "success", data: { activeTargets: [{ labels: { job: "node", instance: "10.0.0.8:9100" }, health: "up" }] } });
    if (u.pathname === "/api/v1/query") return send(200, { status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [now, "15"] }] } });
    if (u.pathname === "/api/v1/query_range") return send(200, { status: "success", data: { resultType: "matrix", result: [{ metric: { __name__: "up", job: "node" }, values: Array.from({ length: 20 }, (_, k) => [now - (20 - k) * 60, "1"]) }] } });
    send(404, { status: "error", error: "not found" });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, withToken: () => withToken, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

/** An address nothing listens on (the usability critic's mistyped server). */
async function deadAddress(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

function audits(event: string, targetId: string): Record<string, unknown>[] {
  const d = new Database(`${DATA_DIR}/atrium.db`, { readonly: true });
  try {
    return (d.prepare("select detail from audit_log where event = ? and target_id = ? order by at").all(event, targetId) as { detail: string }[]).map((r) => JSON.parse(r.detail));
  } finally { d.close(); }
}

type Cred = { id: string; name: string; lockedOrigins: string[] };
async function credentials(page: Page): Promise<Cred[]> {
  return ((await (await page.request.get("/api/integrations/credentials")).json()) as { credentials: Cred[] }).credentials;
}
/** Find or create a token credential with no server (re-runs on the same data reuse it). */
async function tokenCredential(ctx: BrowserContext, name: string, token: string): Promise<string> {
  const list = ((await (await ctx.request.get("/api/integrations/credentials")).json()) as { credentials: Cred[] }).credentials;
  const found = list.find((c) => c.name === name);
  if (found) return found.id;
  const r = await ctx.request.post("/api/integrations/credentials", { data: { name, kind: "token", values: { token } }, headers: H });
  expect(r.status()).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

async function openPromForm(page: Page, url: string, credName: string) {
  await page.goto(`/integrations/new/prometheus?baseUrl=${encodeURIComponent(url)}`);
  await page.locator('[data-config="authMode"]').selectOption("bearer");
  const field = page.locator('[data-secret-field="token"]');
  await field.getByText("Use a saved credential").click();
  await pickCredential(field.locator('[data-credential-pick="token"]'), credName);
  return field;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function sized(browser: Browser, width: number, height: number, touch: boolean): Promise<BrowserContext> {
  const ctx = await themedContext(browser, "daylight");
  const state = await ctx.storageState();
  await ctx.close();
  const c = await browser.newContext({ storageState: state, baseURL: ORIGIN, viewport: { width, height }, ...(touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), colorScheme: "light" });
  await c.addCookies([{ name: "atrium_theme", value: "light", url: ORIGIN }, { name: "atrium_swept", value: "1", url: ORIGIN }]);
  return c;
}

test.describe("normal scenario", () => {
  test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project; phone sizes are set per test"));
  let prom: Prom;
  let A: FakeHa;
  let B: FakeHa;
  let api: HomeApi;
  let dead = "";
  let promCred = "";
  let moveCred = "";
  let detailId = "";

  test.beforeAll(async ({ browser }) => {
    writeFileSync(LOG, "");
    prom = await fakeProm(); A = await fakeHa(); B = await fakeHa(); api = await fakeHomeApi(); dead = await deadAddress();
    const ctx = await themedContext(browser, "daylight");
    promCred = await tokenCredential(ctx, "R6 Prom token", PROD_TOKEN);
    moveCred = await tokenCredential(ctx, "R6 move token", PROD_TOKEN);
    await tokenCredential(ctx, "R6 spare token", SPARE_TOKEN);
    await ctx.close();
  });
  test.afterAll(async () => { await prom.close(); await A.close(); await B.close(); await api.close(); });

  test("item 1: Test connection with an unlocked credential asks to lock it, then for a step-up; only then is the token sent, and credential.locked is audited", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "r6-ui-lock-test");
    page.on("dialog", (d) => { throw new Error(`native dialog: ${d.message()}`); });
    await expireStepUps();
    const field = await openPromForm(page, prom.url, "R6 Prom token");
    await expect(field.locator("[data-credential-lock]")).toHaveText(new RegExp(`^Locks to ${prom.url} when you save`));
    const before = prom.withToken();
    await page.locator("[data-test-button]").click();
    const sheet = page.locator('[data-sheet="credential-origin-confirm"]');
    await expect(sheet).toContainText(`Lock R6 Prom token to ${prom.url}?`);
    await expect(sheet.locator("[data-origin-confirm]")).toHaveText("Lock and continue");
    await shot(page, "screens/r6-lock-sheet-test-light.png");
    expect(prom.withToken(), "nothing sent while the Lock sheet is open").toBe(before);
    await sheet.locator("[data-origin-confirm]").click();
    const stepUp = page.locator('[data-sheet="step-up"]');
    await expect(stepUp).toBeVisible();
    expect(prom.withToken(), "nothing sent before the step-up").toBe(before);
    await shot(page, "screens/r6-lock-step-up-light.png");
    expect(await stepUpIfAsked(page)).toBe(true);
    await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
    expect(prom.withToken()).toBeGreaterThan(before);
    const c = (await credentials(page)).find((x) => x.id === promCred)!;
    expect(c.lockedOrigins).toEqual([prom.url]);
    const rows = audits("credential.locked", promCred);
    log("credential.locked rows after the UI test", rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credential: "R6 Prom token", origin: prom.url, via: "test", firstUse: true });
    await shot(page, "screens/r6-lock-test-passed-light.png");
    await ctx.close();
  });

  test("item 1: cancelling the Lock sheet sends nothing and locks nothing", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    const field = await openPromForm(page, prom.url, "R6 spare token");
    await expect(field.locator("[data-credential-lock]")).toHaveAttribute("data-credential-lock", "first-use");
    const before = prom.withToken();
    await page.locator("[data-test-button]").click();
    await page.locator("[data-origin-cancel]").click();
    await expect(page.locator("[data-info-note]")).toContainText("Not ");
    expect(prom.withToken()).toBe(before);
    expect((await credentials(page)).find((x) => x.name === "R6 spare token")!.lockedOrigins).toEqual([]);
    await ctx.close();
  });

  test("item 2: usability's repro. After Save and test with Also allow, the lock line, the button and the previews show the saved state with no reload", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "r6-save-and-test-refresh");
    page.on("dialog", (d) => { throw new Error(`native dialog: ${d.message()}`); });
    // 1. A credential with no server. 2. Prometheus at a dead address with it, Save without testing.
    await openPromForm(page, dead, "R6 move token");
    await page.locator('input[maxlength="120"]').first().fill("R6 Prom moved");
    await page.locator("[data-save-untested]").click();
    await expect(page.locator('[data-sheet="credential-origin-confirm"]')).toContainText(`Lock R6 move token to ${dead}?`);
    await page.locator("[data-origin-confirm]").click();
    await stepUpIfAsked(page);
    await expect(page).toHaveURL(/\/integrations\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    detailId = page.url().split("/").at(-1)!;
    const targets = page.locator('[data-endpoint="targets"]');
    await expect(targets.locator("[data-read-error]")).toBeVisible({ timeout: 10_000 });
    // 3. Correct the address, Save and test, Also allow.
    const url = page.locator('[data-setup-form] [data-config="baseUrl"]');
    await url.fill(prom.url);
    await url.blur();
    const lock = page.locator('[data-secret-field="token"] [data-credential-lock]');
    await expect(lock).toContainText("Saving here asks you to allow");
    await expect(page.locator("[data-save-button]")).toContainText("Save and test");
    await page.evaluate(() => { (window as unknown as { __r6NoReload: number }).__r6NoReload = 1; });
    await page.locator("[data-save-button]").click();
    await expect(page.locator('[data-sheet="credential-origin-confirm"]')).toContainText(`Also allow R6 move token on ${prom.url}?`);
    await page.locator("[data-origin-confirm]").click();
    await stepUpIfAsked(page);
    await expect(page.getByRole("region", { name: "Notifications" }).getByText("Connection works")).toBeVisible({ timeout: 15_000 });
    // The saved state, with no reload.
    await expect(lock).toHaveAttribute("data-credential-lock", "here", { timeout: 10_000 });
    await expect(lock).toContainText(`${dead}, ${prom.url}`);
    await expect(page.locator("[data-save-button]")).toHaveText(/^\s*Save\s*$/);
    await expect(page.locator("[data-save-test-why]")).toHaveCount(0);
    await expect(page.locator("[data-test-button]")).toBeVisible();
    await expect(targets).toContainText("node: 10.0.0.8", { timeout: 10_000 }); // Wave 2.7: friendly target name
    await expect(targets.locator("[data-read-error]")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __r6NoReload?: number }).__r6NoReload)).toBe(1);
    await shot(page, "screens/r6-detail-after-save-and-test-light.png");
    const c = (await credentials(page)).find((x) => x.id === moveCred)!;
    expect(c.lockedOrigins).toEqual([dead, prom.url]);
    const rows = audits("credential.locked", moveCred);
    log("credential.locked rows for the moved integration", rows);
    expect(rows.map((r) => r.origin)).toEqual([dead, prom.url]);
    await ctx.close();
  });

  test("item 5: moving a typed-token integration warns under the field at once, and asks in the app's own sheet", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "r6-move-address");
    page.on("dialog", (d) => { throw new Error(`native dialog: ${d.message()}`); });
    const R = await fakeRecorder(); // the new address records every header it is sent
    const ha = (await (await ctx.request.post("/api/integrations", { data: { packageId: "home-assistant", name: "R6 typed HA", config: { baseUrl: A.url }, secrets: { token: FAKE.ha }, untested: true }, headers: H })).json()) as { id: string };
    await page.goto(`/integrations/${ha.id}`);
    await expect(page.locator('[data-secret-moving="token"]')).toHaveCount(0);
    const url = page.locator('[data-setup-form] [data-config="baseUrl"]');
    await url.fill(R.url);
    await expect(page.locator('[data-secret-moving="token"]')).toHaveText(/^Moving to a new address clears this .*; you can paste it again\.$/);
    await page.locator("[data-save-button]").click();
    const sheet = page.locator('[data-sheet="pinned-move-confirm"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("[data-pinned-question]")).toContainText(`New address: ${R.url}`);
    await shot(page, "screens/r6-move-address-sheet-light.png");
    await sheet.locator("[data-pinned-cancel]").click();
    await expect(page.locator("[data-info-note]")).toContainText("Not saved. The address and the saved credentials are unchanged.");
    expect(((await (await page.request.get(`/api/integrations/${ha.id}`)).json()) as { config: { baseUrl: string } }).config.baseUrl).toBe(A.url);
    await page.locator("[data-save-button]").click();
    await sheet.locator("[data-pinned-confirm]").click();
    await expect(page.getByRole("region", { name: "Notifications" }).getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
    const after = (await (await page.request.get(`/api/integrations/${ha.id}`)).json()) as { config: { baseUrl: string }; secrets: { key: string; set: boolean }[] };
    expect(after.config.baseUrl).toBe(R.url);
    expect(after.secrets.find((s) => s.key === "token")?.set).toBe(false);
    // The typed token never reached the new address.
    expect(JSON.stringify(R.seen)).not.toContain(FAKE.ha);
    log("move-address: requests seen by the new address", R.seen.map((x) => ({ method: x.method, url: x.url, authorization: x.headers.authorization ? "present" : "absent" })));
    await R.close();
    await ctx.close();
  });

  test("item 3: the Picks bar shows whenever the layout is one column (390, 844x390, 900) and not at 1280", async ({ browser }) => {
    for (const s of [{ w: 390, h: 844, touch: true, bar: true }, { w: 844, h: 390, touch: true, bar: true }, { w: 900, h: 800, touch: false, bar: true }, { w: 1280, h: 800, touch: false, bar: false }]) {
      const ctx = await sized(browser, s.w, s.h, s.touch);
      const page = await ctx.newPage();
      await page.goto("/integrations/new/by-example");
      await page.locator("[data-try-input]").fill(`${api.url}/api/open`);
      await page.locator("[data-try-button]").click();
      await page.locator('[data-tree-leaf="$.load"]').click();
      await page.locator('[data-role-picker] [data-role="value"]').click();
      const bar = page.locator("[data-picks-bar]");
      if (s.bar) {
        await expect(bar, `${s.w}x${s.h}`).toBeVisible();
        await expect(bar).toContainText(/Picks \(\d+\)/);
        const b = (await bar.boundingBox())!;
        expect(b.y + b.height, `${s.w}x${s.h} bar on screen`).toBeLessThanOrEqual(s.h + 0.5);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(s.w + 0.5);
        await noOverflow(page);
        await page.screenshot({ path: ev(`screens/r6-picks-bar-${s.w}x${s.h}.png`) });
        await bar.locator("[data-picks-review]").click();
        await expect(page.locator("#data-source")).toBeInViewport({ ratio: 0.05 });
      } else {
        await expect(bar).toBeHidden();
        await page.screenshot({ path: ev(`screens/r6-picks-bar-hidden-${s.w}x${s.h}.png`) });
      }
      await ctx.close();
    }
  });

  test("item 4: gallery descriptions show in full with no ellipsis at 1440 and 1280", async ({ browser }) => {
    for (const w of [1440, 1280]) {
      const ctx = await sized(browser, w, 900, false);
      const page = await ctx.newPage();
      await page.goto("/integrations/new");
      const d = page.locator("[data-tile-description]");
      await expect(d).toHaveCount(9);
      const m = await d.evaluateAll((els) => els.map((e) => { const cs = getComputedStyle(e); return { text: e.textContent ?? "", sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, overflow: cs.textOverflow, clamp: cs.webkitLineClamp, ws: cs.whiteSpace }; }));
      writeFileSync(ev(`logs/r6-gallery-descriptions-${w}.json`), JSON.stringify(m, null, 2));
      for (const x of m) {
        expect(x.overflow, x.text).not.toBe("ellipsis");
        expect(["none", ""]).toContain(x.clamp);
        expect(x.ws, x.text).not.toBe("nowrap");
        expect(x.sw, x.text).toBeLessThanOrEqual(x.cw);
        expect(x.sh, x.text).toBeLessThanOrEqual(x.ch + 1);
      }
      await shot(page, `screens/r6-gallery-${w}.png`);
      await ctx.close();
    }
  });

  test("V4: gallery, detail, setup with the picker, the Lock sheet and credentials in light, dark and light-solid", async ({ browser }) => {
    expect(detailId).not.toBe("");
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      captureTraffic(page, `r6-v4-${v.name}`);
      await page.goto("/integrations/new");
      await expect(page.locator("[data-gallery-card]")).toHaveCount(9);
      await shot(page, `screens/r6-gallery-${v.name}.png`);
      await page.goto(`/integrations/${detailId}`);
      await expect(page.locator('[data-endpoint="targets"]')).toContainText("node: 10.0.0.8", { timeout: 10_000 });
      await shot(page, `screens/r6-detail-${v.name}.png`);
      const field = await openPromForm(page, prom.url, "R6 spare token");
      await expect(field.locator("[data-credential-lock]")).toBeVisible();
      await shot(page, `screens/r6-setup-picker-${v.name}.png`);
      await page.locator("[data-test-button]").click();
      await expect(page.locator('[data-sheet="credential-origin-confirm"]')).toContainText("Lock R6 spare token to");
      await page.waitForTimeout(400);
      await page.screenshot({ path: ev(`screens/r6-lock-sheet-${v.name}.png`) });
      await page.locator("[data-origin-cancel]").click();
      await page.goto("/integrations/credentials");
      await expect(page.locator('[data-credential-name-label="R6 spare token"]')).toBeVisible();
      await shot(page, `screens/r6-credentials-${v.name}.png`);
      await ctx.close();
    }
  });

  test("V5: credentials, the setup picker, the Lock sheet and the detail at 390x844 with no horizontal scroll", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight", { mobile: true });
    const page = await ctx.newPage();
    await page.goto("/integrations/credentials");
    await expect(page.locator('[data-credential-name-label="R6 spare token"]')).toBeVisible();
    await noOverflow(page);
    await shot(page, "screens/r6-mobile-credentials-390x844.png");
    await openPromForm(page, prom.url, "R6 spare token");
    await noOverflow(page);
    await shot(page, "screens/r6-mobile-setup-picker-390x844.png");
    await page.locator("[data-test-button]").click();
    const sheet = page.locator('[data-sheet="credential-origin-confirm"]');
    await expect(sheet).toBeVisible();
    // Measured once the bottom sheet has finished sliding in.
    await expect.poll(async () => { const b = (await sheet.locator("[data-origin-confirm]").boundingBox())!; return b.y + b.height; }, { timeout: 5_000 }).toBeLessThanOrEqual(844);
    const confirm = (await sheet.locator("[data-origin-confirm]").boundingBox())!;
    expect(confirm.height).toBeGreaterThanOrEqual(44);
    await page.waitForTimeout(400);
    await page.screenshot({ path: ev("screens/r6-mobile-lock-sheet-390x844.png") });
    await sheet.locator("[data-origin-cancel]").click();
    await page.goto(`/integrations/${detailId}`);
    await expect(page.locator('[data-endpoint="targets"]')).toContainText("node: 10.0.0.8", { timeout: 10_000 });
    await noOverflow(page);
    await shot(page, "screens/r6-mobile-detail-390x844.png");
    await ctx.close();
  });
});
