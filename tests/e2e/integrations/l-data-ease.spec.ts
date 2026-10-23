// Wave 2.7 data ease, integrations side (spec criteria 3, 13, 14, 15, 16, 21, 22, 23; Amendment 8 A8.1
// to A8.4), clicked through the real integration screen (V11) against the stand-in Prometheus
// (tests/e2e/fixtures/fake-prometheus.ts: 9 machines, RP5-3 has no host label, no cAdvisor or Proxmox
// exporter) and a small stand-in Home Assistant. Normal scenario only.
import { createServer } from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { expect, request, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { APP, captureTraffic, DATA_DIR, memberState, ORIGIN, ownerState, shot, SHELL_VARIANTS, themedContext } from "./helpers";
import { FAKE } from "./fakes";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "data ease runs in the normal scenario");
test.describe.configure({ mode: "serial" });

const VIEWER = { email: "viewer@atrium.test", password: "e2e-viewer-password-789" };
const VIEWER_STATE = path.join(APP, "test-results/integrations-viewer-state.json");

/** A viewer account in this slot's own database (same recipe as memberState). Test-only password. */
async function viewerState(): Promise<string> {
  const { default: Database } = await import("better-sqlite3");
  const { hash } = await import("@node-rs/argon2");
  const { randomUUID } = await import("node:crypto");
  const d = new Database(path.join(DATA_DIR, "atrium.db"));
  try {
    if (!d.prepare("SELECT id FROM user WHERE email = ?").get(VIEWER.email)) {
      const id = randomUUID();
      const now = Date.now();
      d.prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, "viewer", VIEWER.email, 1, "viewer", 0, now, now);
      const h = await hash(VIEWER.password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
      d.prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, h, now, now);
      d.prepare("INSERT OR IGNORE INTO allowlist (id, pattern, role, created_at) VALUES (?,?,?,?)").run(randomUUID(), VIEWER.email, "viewer", now);
    }
  } finally {
    d.close();
  }
  if (existsSync(VIEWER_STATE)) {
    const ctx = await request.newContext({ baseURL: ORIGIN, storageState: VIEWER_STATE });
    const ok = (await ctx.get("/api/integrations")).status() === 200;
    await ctx.dispose();
    if (ok) return VIEWER_STATE;
  }
  const ctx = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN } });
  const res = await ctx.post("/api/auth/sign-in/email", { data: VIEWER });
  if (!res.ok()) throw new Error(`viewer sign-in failed: ${res.status()} ${await res.text()}`);
  await ctx.storageState({ path: VIEWER_STATE });
  await ctx.dispose();
  return VIEWER_STATE;
}

/** A Home Assistant stand-in with a temperature sensor and an unavailable entity. Test-only token. */
async function fakeHaSensors(): Promise<{ url: string; close: () => Promise<void> }> {
  const states = [
    { entity_id: "sensor.office_temperature", state: "21.5", attributes: { friendly_name: "Office temperature", unit_of_measurement: "°C", device_class: "temperature" }, last_changed: "2026-10-20T10:00:00Z" },
    { entity_id: "sensor.grid_power", state: "412", attributes: { friendly_name: "Grid power", unit_of_measurement: "W", device_class: "power" }, last_changed: "2026-10-20T10:00:00Z" },
    { entity_id: "light.porch", state: "unavailable", attributes: { friendly_name: "Porch light" }, last_changed: "2026-10-20T09:00:00Z" },
  ];
  const s = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${FAKE.ha}`) return send(401, { message: "401: Unauthorized" });
    if (u.pathname === "/api/config") return send(200, { version: "2026.10.1" });
    if (u.pathname === "/api/states") return send(200, states);
    const one = /^\/api\/states\/(.+)$/.exec(u.pathname);
    if (one) { const e = states.find((x) => x.entity_id === one[1]); return e ? send(200, e) : send(404, { message: "Entity not found." }); }
    send(404, { message: "not found" });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

let prom: FakePrometheus;
let ha: Awaited<ReturnType<typeof fakeHaSensors>>;
let promId = "";
let haId = "";

test.beforeAll(async () => {
  prom = await startFakePrometheus();
  ha = await fakeHaSensors();
});
test.afterAll(async () => {
  await prom?.close();
  await ha?.close();
});

async function machineSelect(page: Page, endpoint: string) {
  const sel = page.locator(`[data-endpoint="${endpoint}"] select[data-param="machine"]`);
  await expect(sel).toHaveAttribute("data-choices-state", "ready", { timeout: 10_000 });
  return sel;
}

test("connect Prometheus on the setup screen, then reads come in groups, absent exporters are hidden until Show all reads (criteria 15, A8.1)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "connect once, on desktop");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "data-ease-connect");
  await page.goto(`/integrations/new/prometheus?baseUrl=${encodeURIComponent(prom.url)}`);
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-save-button]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/);
  promId = page.url().split("/").pop()!;
  for (const g of ["Machines", "All machines", "Alerts", "Pick a metric"]) await expect(page.locator(`[data-endpoint-group="${g}"]`)).toBeVisible();
  await expect(page.locator('[data-endpoint-group="Advanced"] summary')).toContainText("Advanced");
  await expect(page.locator('[data-endpoint="query"]')).toBeHidden();
  const hidden = page.locator("[data-hidden-reads]");
  await expect(hidden).toContainText("hidden because this service has no data for them");
  await expect(hidden).toContainText("cAdvisor (container metrics)");
  await expect(page.locator('[data-endpoint-group="Containers"]')).toHaveCount(0);
  await expect(page.locator('[data-endpoint-group="Proxmox"]')).toHaveCount(0);
  await page.locator("[data-show-all-reads]").click();
  await expect(page.locator('[data-endpoint-group="Containers"]')).toBeVisible();
  await expect(page.locator('[data-endpoint-group="Proxmox"]')).toBeVisible();
  await page.locator("[data-show-all-reads]").click();
  await expect(page.locator('[data-endpoint-group="Containers"]')).toHaveCount(0);
  await ctx.close();
});

test("the machine list shows friendly names (RP5-3, never host.docker.internal), Every machine first, and a pick shows a formatted value (criteria 3, 13, A8.2)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop" || !promId, "needs the connected Prometheus");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "data-ease-machines");
  await page.goto(`/integrations/${promId}`);
  const sel = await machineSelect(page, "machine-cpu");
  const options = await sel.locator("option").allTextContents();
  expect(options[1]).toBe("Every machine");
  const names = options.slice(2, 11).map((o) => o.split(" · ")[0]);
  expect(names).toEqual(["ACE", "firefly", "minipc-ubuntu", "Pelican", "pve1", "pve2", "pve3", "RP5-2", "RP5-3"]);
  expect(options.some((o) => o.startsWith("host.docker.internal"))).toBe(false);
  expect(options.at(-1)).toBe("Type it in...");
  await sel.selectOption({ label: options.find((o) => o.startsWith("ACE"))! });
  await expect(sel).toHaveValue("10.77.99.8:9100");
  const win = page.locator('[data-endpoint="machine-cpu"]');
  await win.locator("[data-preview-button]").click();
  await expect(win.locator("[data-stat-value]")).toHaveText("7.8 %");
  await win.locator("[data-preview-button]").scrollIntoViewIfNeeded();
  await shot(page, "screens/data-ease-machine-cpu-daylight.png");
  // Every machine answers rows.
  await sel.selectOption("*");
  await win.locator("[data-preview-button]").click();
  await expect(win.locator("table")).toBeVisible();
  await expect(win.locator('[data-cell="name"]').first()).toHaveText("ACE");
  await expect(win).toContainText("9 rows");
  // "Type it in" keeps the text box.
  await sel.selectOption({ label: "Type it in..." });
  await expect(page.locator('[data-endpoint="machine-cpu"] [data-choice-typed="machine"] input')).toBeVisible();
  await ctx.close();
});

test("Machines overview and the every-machine chart show formats and friendly line names (criteria 2, 13, 14)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop" || !promId, "needs the connected Prometheus");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto(`/integrations/${promId}`);
  const overview = page.locator('[data-endpoint="machines-overview"]');
  await overview.locator("[data-preview-button]").click();
  await expect(overview.locator('[data-cell="name"]').first()).toHaveText("ACE");
  await expect(overview.locator('[data-cell="cpu"]').first()).toHaveText("7.8 %");
  await expect(overview.locator('[data-cell="netIn"]').first()).toHaveText("3 MB/s");
  await expect(overview.locator('[data-cell="uptime"]').first()).toHaveText("3 d 4 h");
  await expect(overview).toContainText("9 rows");
  const chart = page.locator('[data-endpoint="machines-history"]');
  await chart.locator("[data-preview-button]").click();
  await expect(chart.locator("[data-series-name]").first()).toHaveText("ACE");
  await expect(chart.locator("[data-series-name]")).toHaveText(["ACE", "firefly", "minipc-ubuntu", "Pelican", "pve1"]);
  await expect(chart.locator("[data-series-latest]").first()).toContainText("%");
  await overview.scrollIntoViewIfNeeded();
  await shot(page, "screens/data-ease-overview-daylight.png");
  await ctx.close();
});

test("a disk list follows the machine picked (live choices that depend on another setting)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop" || !promId, "needs the connected Prometheus");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto(`/integrations/${promId}`);
  const win = page.locator('[data-endpoint="machine-disk"]');
  await expect(win.locator('[data-choice-error="mount"]')).toHaveText("Pick machine first.");
  const sel = await machineSelect(page, "machine-disk");
  await sel.selectOption("10.77.99.4:9100");
  const mount = win.locator('select[data-param="mount"]');
  await expect(mount).toHaveAttribute("data-choices-state", "ready");
  expect(await mount.locator("option").allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/^\/ · /), expect.stringMatching(/^\/data · /)]));
  await mount.selectOption("/data");
  await win.locator("[data-preview-button]").click();
  await expect(win.locator("[data-stat-value]")).toHaveText("12.5 %");
  await ctx.close();
});

test("Home Assistant A sensor lists live sensors and shows the number with its unit; unavailable entities are rows (criterion 16)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "data-ease-ha");
  const r = await page.request.post("/api/integrations", { data: { packageId: "home-assistant", name: "Sensor house", config: { baseUrl: ha.url }, secrets: { token: FAKE.ha }, untested: true }, headers: { origin: ORIGIN } });
  expect(r.status()).toBeLessThan(300);
  haId = ((await r.json()) as { id: string }).id;
  await page.goto(`/integrations/${haId}`);
  await expect(page.locator('[data-endpoint-group="Sensors"]')).toBeVisible();
  const win = page.locator('[data-endpoint="sensor"]');
  const sel = win.locator('select[data-param="entityId"]');
  await expect(sel).toHaveAttribute("data-choices-state", "ready", { timeout: 10_000 });
  const options = await sel.locator("option").allTextContents();
  expect(options).toEqual(["Pick a sensor", "Every sensor", "Grid power · 412 W · sensor.grid_power", "Office temperature · 21.5 °C · sensor.office_temperature", "Type it in..."]);
  await sel.selectOption("sensor.office_temperature");
  await win.locator("[data-preview-button]").click();
  await expect(win.locator("[data-stat-value]")).toHaveText("21.5 °C");
  await sel.selectOption("sensor.grid_power");
  await win.locator("[data-preview-button]").click();
  await expect(win.locator("[data-stat-value]")).toHaveText("412");
  await expect(win).toContainText("W");
  const un = page.locator('[data-endpoint="unavailable"]');
  await un.locator("[data-preview-button]").click();
  await expect(un.locator('[data-cell="name"]').first()).toHaveText("Porch light");
  await shot(page, "screens/data-ease-ha-sensor-daylight.png");
  await ctx.close();
});

test("choices are refused with not found to viewers, signed-out callers, and members while not shared; no config or secret in any answer (criteria 21, 23)", async ({ playwright }, info) => {
  test.skip(info.project.name !== "desktop" || !promId || !haId, "needs both integrations");
  const q = (id: string, ep: string, param: string) => `/api/data/choices?${new URLSearchParams({ integrationId: id, endpointId: ep, param }).toString()}`;
  const owner = await playwright.request.newContext({ baseURL: ORIGIN, storageState: await ownerState() });
  const ok = await owner.get(q(promId, "machine-cpu", "machine"));
  expect(ok.status()).toBe(200);
  const text = await ok.text();
  expect(JSON.parse(text)).toMatchObject({ every: true, total: 9 });
  expect(text).not.toContain(prom.url);
  const haText = await (await owner.get(q(haId, "sensor", "entityId"))).text();
  expect(haText).not.toContain(FAKE.ha);
  expect(haText).not.toContain(ha.url);
  const listing = await (await owner.get("/api/integrations/bindable")).text();
  expect(listing).not.toContain(FAKE.ha);
  expect(JSON.parse(listing).integrations.find((i: { integrationId: string }) => i.integrationId === promId).endpoints.find((e: { id: string }) => e.id === "containers")).toMatchObject({ available: false, group: "Containers" });
  for (const [who, state] of [["viewer", await viewerState()], ["member", await memberState()]] as const) {
    const c = await playwright.request.newContext({ baseURL: ORIGIN, storageState: state });
    const r = await c.get(q(promId, "machine-cpu", "machine"));
    expect(r.status(), who).toBe(404);
    await c.dispose();
  }
  const anon = await playwright.request.newContext({ baseURL: ORIGIN });
  expect([401, 404]).toContain((await anon.get(q(promId, "machine-cpu", "machine"))).status());
  await anon.dispose();
  await owner.dispose();
});

test("the grouped integration page in three themes and at 390 px: 44 px controls, no sideways scroll (V4, V5, criterion 22)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop" || !promId, "needs the connected Prometheus");
  for (const v of SHELL_VARIANTS) {
    const ctx = await themedContext(browser, v.theme);
    const page = await ctx.newPage();
    await page.goto(`/integrations/${promId}`);
    await machineSelect(page, "machine-cpu");
    await page.locator('[data-endpoint-group="Machines"]').scrollIntoViewIfNeeded();
    await shot(page, `screens/data-ease-groups-${v.name}.png`);
    await ctx.close();
  }
  const ctx = await themedContext(browser, "daylight", { mobile: true });
  const page = await ctx.newPage();
  await page.goto(`/integrations/${promId}`);
  const sel = await machineSelect(page, "machine-cpu");
  const box = await sel.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const showAll = page.locator("[data-show-all-reads]");
  expect((await showAll.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator('[data-endpoint-group="Machines"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(APP, `evidence/integrations/${process.env.ATRIUM_INT_ROUND ?? "r6"}/screens/data-ease-mobile-390.png`) });
  await ctx.close();
});
