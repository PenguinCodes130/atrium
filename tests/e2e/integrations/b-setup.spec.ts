// Setup screens and the connection test: live Prometheus, timeouts, wrong credentials, TLS,
// write-only secrets, Docker transport. Start the slot first with tests/e2e/integrations/serve.sh.
import { readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "../fixtures";
import { captureTraffic, ev, themedContext, type Theme, shot } from "./helpers";
import { blackhole, FAKE, fakeDocker, fakeNpm, selfSigned } from "./fakes";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project"));

// The live Prometheus, e.g. ATRIUM_TEST_PROM_URL=http://<host>:9090 (the real address stays outside git).
const LIVE_PROM = process.env.ATRIUM_TEST_PROM_URL;
const livePromPage = () => `/integrations/new/prometheus?baseUrl=${encodeURIComponent(LIVE_PROM!)}`;

test("a correct Prometheus test shows the green tick, latency and version within 10 seconds, and the glow plays once, never on reload (criteria 11, 13, V6)", async ({ browser }) => {
  test.skip(!LIVE_PROM, "needs ATRIUM_TEST_PROM_URL");
  const videoDir = ev("video/raw-glow");
  const ctx = await themedContext(browser, "daylight", { video: videoDir });
  const page = await ctx.newPage();
  captureTraffic(page, "setup-prometheus");
  await page.goto(livePromPage());
  await expect(page.locator('[data-config="baseUrl"]')).toHaveValue(LIVE_PROM!);
  await page.waitForTimeout(500);
  const start = Date.now();
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - start).toBeLessThan(10_000);
  await expect(page.locator("[data-status-check]")).toBeVisible();
  await expect(page.locator("[data-test-success] [data-health=ok]")).toContainText(/\d+ ms/);
  await expect(page.locator("[data-test-success]")).toContainText(/v3\.\d+/);
  await expect(page.locator("[data-glow=played]")).toHaveCount(1);
  // Design v4: inside a window the success glow flashes the title bar instead of a separate layer.
  await expect(page.locator("[data-titlebar-glow]")).toHaveCount(1);
  await expect(page.locator("[data-glow-layer]")).toHaveCount(0);
  await page.waitForTimeout(1200);
  await shot(page, "screens/setup-test-passed-daylight.png");
  await page.locator("[data-save-button]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.locator("[data-glow=idle]")).toHaveCount(1);
  await expect(page.locator("[data-glow-layer]")).toHaveCount(0);
  await expect(page.locator("[data-health=ok]").first()).toBeVisible();
  await ctx.close();
  const raw = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
  if (raw) {
    renameSync(path.join(videoDir, raw), ev("video/connection-glow.webm"));
    try { execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", ev("video/connection-glow.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", ev("video/connection-glow.mp4")]); } catch { /* the webm stays as evidence */ }
  }
});

test("with reduced motion the tick appears with no glow and no draw-in (criterion 13, V8)", async ({ browser }) => {
  test.skip(!LIVE_PROM, "needs ATRIUM_TEST_PROM_URL");
  const ctx = await themedContext(browser, "daylight", { reducedMotion: true });
  const page = await ctx.newPage();
  await page.goto(livePromPage());
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-glow-layer]")).toHaveCount(0);
  await expect(page.locator("[data-glow=ring]")).toHaveCount(1);
  // The check path is shown at full opacity at once, with no scale wipe.
  const opacity = await page.locator("[data-status-check] path").evaluate((el) => getComputedStyle(el).opacity);
  expect(opacity).toBe("1");
  await shot(page, "screens/reduced-motion-test-passed.png");
  await ctx.close();
});

test("a host that never answers ends with the Timed out heading at 10 seconds plus or minus 1 (criterion 12)", async ({ browser }) => {
  const hole = await blackhole();
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto(`/integrations/new/prometheus?baseUrl=${encodeURIComponent(hole.url)}`);
  const start = Date.now();
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-button]")).toBeDisabled();
  await expect(page.locator("[data-test-button] [data-spinner]")).toBeVisible();
  await expect(page.locator("[data-error-heading]")).toHaveText("Timed out", { timeout: 15_000 });
  const took = Date.now() - start;
  expect(took).toBeGreaterThanOrEqual(9_000);
  expect(took).toBeLessThanOrEqual(11_000);
  test.info().annotations.push({ type: "timeout-ms", description: String(took) });
  await ctx.close();
  await hole.close();
});

test("a wrong NPM token shows Wrong credentials naming the token field, within 10 seconds (criterion 14, V4 setup with error)", async ({ browser }) => {
  const npm = await fakeNpm();
  for (const theme of ["daylight", "dusk", "solid"] as Theme[]) {
    const ctx = await themedContext(browser, theme);
    const page = await ctx.newPage();
    captureTraffic(page, `setup-npm-wrong-${theme}`);
    await page.goto(`/integrations/new/npm?baseUrl=${encodeURIComponent(npm.url)}`);
    await page.locator('[data-secret="token"]').fill(FAKE.npmWrong);
    const start = Date.now();
    await page.locator("[data-test-button]").click();
    await expect(page.locator("[data-error-heading]")).toHaveText("Wrong credentials", { timeout: 10_000 });
    expect(Date.now() - start).toBeLessThan(10_000);
    await expect(page.locator("[data-error-code=auth]")).toContainText('The service refused the "API token" field (HTTP 401).');
    await expect(page.locator('[data-secret="token"]')).toHaveValue(FAKE.npmWrong); // nothing typed is lost
    await shot(page, `screens/setup-error-${theme}.png`);
    await ctx.close();
  }
  await npm.close();
});

test("mobile setup screen at 390x844 (V5)", async ({ browser }) => {
  const npm = await fakeNpm();
  const ctx = await themedContext(browser, "daylight", { mobile: true });
  const page = await ctx.newPage();
  await page.goto(`/integrations/new/npm?baseUrl=${encodeURIComponent(npm.url)}`);
  await expect(page.locator("[data-setup-form=npm]")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, "screens/mobile-setup-390x844.png");
  await ctx.close();
  await npm.close();
});

test("a self-signed certificate with verify TLS on shows Certificate problem (criterion 15)", async ({ browser }) => {
  const tls = await selfSigned();
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto(`/integrations/new/proxmox?baseUrl=${encodeURIComponent(tls.url)}`);
  await expect(page.locator('[data-config="verifyTls"]')).toBeChecked();
  await page.locator('[data-secret="token"]').fill(FAKE.proxmox);
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-error-heading]")).toHaveText("Certificate problem", { timeout: 10_000 });
  await expect(page.locator("[data-error-code=tls]")).toContainText("Verify TLS");
  await ctx.close();
  await tls.close();
});

test("every secret field shows a non-empty hint under its label (criterion 17)", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  for (const id of ["npm", "pfsense", "proxmox", "uptime-kuma"]) {
    await page.goto(`/integrations/new/${id}`);
    const secrets = page.locator("[data-secret]");
    const n = await secrets.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const hintId = await secrets.nth(i).getAttribute("aria-describedby");
      const hint = (await page.locator(`[id="${hintId}"]`).textContent())?.trim() ?? "";
      expect(hint.length, `${id} secret ${i}`).toBeGreaterThan(20);
    }
  }
  await ctx.close();
});

test("Save without testing gives Untested; a saved secret shows Saved with a date and never its value; blank keeps it (criteria 16, 18)", async ({ browser }) => {
  const npm = await fakeNpm();
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "secrets-saved");
  await page.goto(`/integrations/new/npm?baseUrl=${encodeURIComponent(npm.url)}`);
  await page.locator('[data-secret="token"]').fill(FAKE.npmGood);
  // Round 6 (premium r3 low): no disabled Save before a test; only Test connection and Save without testing.
  await expect(page.locator("[data-save-button]")).toHaveCount(0);
  await page.locator("[data-save-untested]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/);
  await expect(page.locator("[data-untested]").first()).toHaveText("Untested");
  await page.reload();
  const saved = page.locator('[data-secret-saved="token"]');
  await expect(saved).toHaveText(/^Saved [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  await expect(page.locator('[data-secret="token"]')).toHaveValue("");
  expect(await page.content()).not.toContain(FAKE.npmGood);
  const first = await saved.textContent();
  const id = page.url().split("/").pop()!;
  const before = (await (await page.request.get(`/api/integrations/${id}`)).json()) as { secrets: { updatedAt: string }[] };
  await page.locator("[data-save-button]").click();
  await expect(page.locator("[data-toast]").first()).toBeVisible();
  await page.reload();
  const after = (await (await page.request.get(`/api/integrations/${id}`)).json()) as { secrets: { updatedAt: string; set: boolean }[] };
  expect(after.secrets[0]).toMatchObject({ set: true, updatedAt: before.secrets[0]!.updatedAt });
  await expect(page.locator('[data-secret-saved="token"]')).toHaveText(first!);
  // The saved token works: test passes against the fake NPM that only accepts it.
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
  await ctx.close();
  await npm.close();
});

test("Docker over a TCP endpoint lists containers with name, image, state and status; the raw socket is refused (criteria 20, 21)", async ({ browser }) => {
  const docker = await fakeDocker();
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto("/integrations/new/docker?endpoint=unix%3A%2F%2F%2Fvar%2Frun%2Fdocker.sock");
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-error-heading]")).toHaveText("Not permitted", { timeout: 10_000 });
  await expect(page.locator("[data-error-code=permission]")).toContainText("The raw Docker socket gives root access to this host. Use a read-only socket proxy, or set the allow-socket switch on the server");
  await page.goto(`/integrations/new/docker?endpoint=${encodeURIComponent(`tcp://127.0.0.1:${docker.port}`)}`);
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toContainText("v29.7.2", { timeout: 10_000 });
  await page.locator("[data-save-button]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/);
  const card = page.locator('[data-endpoint="containers"]');
  await expect(card.locator("table")).toBeVisible({ timeout: 10_000 });
  await expect(card.locator("thead")).toHaveText(/Name\s*Image\s*State\s*Status/);
  await expect(card.locator("tbody tr").first()).toContainText("backup");
  await expect(page.locator('[data-endpoint="running"] [data-stat-value]')).toHaveText("2");
  expect(docker.hits.every((h) => h.method === "GET")).toBe(true);
  await shot(page, "screens/docker-detail-daylight.png");
  await ctx.close();
  await docker.close();
});
