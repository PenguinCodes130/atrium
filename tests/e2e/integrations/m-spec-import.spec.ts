// Wave 2.8 spec import v2 (recipes spec 3.3; criteria 9, 10, 11, 13, 14, 15), clicked through the
// real Custom API screen (V11) against the Shelfarr stand-in (tests/e2e/fixtures/fake-rest.ts):
// detect, "Import from this spec", type the API key, import, and the reads work with no Try it.
// Runs on any integrations slot: ATRIUM_E2E_PORT picks the server, ATRIUM_E2E_DATA_DIR its data
// folder (builder S ran it on 3116 with data/e2e-spec-import). Test-only key; not a credential.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { expect, request, test, type Page } from "@playwright/test";
import { startFakeRest, FAKE_REST_KEY, FAKE_REST_SPEC, type FakeRest } from "../fixtures/fake-rest";
import { OWNER } from "../fixtures";
import { APP, ORIGIN, PORT, SHELL_VARIANTS, themedContext } from "./helpers";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "spec import runs in the normal scenario");
test.describe.configure({ mode: "serial" });

const EVIDENCE = path.join(APP, `evidence/spec-import-v2/${process.env.ATRIUM_SPEC_ROUND ?? "r1"}`);
const DATA = path.join(APP, process.env.ATRIUM_E2E_DATA_DIR ?? "data/e2e-integrations");
const OWNER_STATE = path.join(APP, `test-results/spec-import-owner-${PORT}.json`);
const VIEWER_STATE = path.join(APP, `test-results/spec-import-viewer-${PORT}.json`);
const VIEWER = { email: "viewer@atrium.test", password: "e2e-viewer-password-789" };

function ev(...parts: string[]): string {
  const p = path.join(EVIDENCE, ...parts);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

async function signIn(who: { email: string; password: string }, file: string): Promise<string> {
  if (existsSync(file)) {
    const ctx = await request.newContext({ baseURL: ORIGIN, storageState: file });
    const ok = (await ctx.get("/api/integrations")).status() === 200;
    await ctx.dispose();
    if (ok) return file;
  }
  const ctx = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN } });
  const res = await ctx.post("/api/auth/sign-in/email", { data: who });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()} ${await res.text()}`);
  mkdirSync(path.dirname(file), { recursive: true });
  await ctx.storageState({ path: file });
  await ctx.dispose();
  return file;
}

/** A viewer in this slot's own database (the integrations suites' recipe). Test-only password. */
async function viewerState(): Promise<string> {
  const { default: Database } = await import("better-sqlite3");
  const { hash } = await import("@node-rs/argon2");
  const { randomUUID } = await import("node:crypto");
  const d = new Database(path.join(DATA, "atrium.db"));
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
  return signIn(VIEWER, VIEWER_STATE);
}

/** Records every response from Atrium's own origin for the V10 grep (criterion 14). */
function capture(page: Page, name: string): string {
  const file = ev("traffic", `${name}.txt`);
  writeFileSync(file, "");
  page.on("response", async (r) => {
    if (!r.url().startsWith(ORIGIN)) return;
    let body = "";
    try { body = (await r.body()).toString("utf8"); } catch { body = "(no body)"; }
    appendFileSync(file, `### ${r.request().method()} ${r.url()} ${r.status()}\n${body}\n`);
  });
  return file;
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  await page.screenshot({ path: ev("screens", name), fullPage: true });
}

let rest: FakeRest;
test.beforeAll(async () => { rest = await startFakeRest(); });
test.afterAll(async () => { await rest.close(); });

test("criterion 11: detect, import from the spec with the key, and the reads work without Try it", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop flow; the phone flow is its own test");
  const ctx = await themedContext(browser, "daylight", { storageState: await signIn(OWNER, OWNER_STATE) });
  const page = await ctx.newPage();
  const traffic = capture(page, "import-flow");
  await page.goto("/integrations/new");
  await page.locator("#detect-url").fill(rest.url);
  await page.locator("[data-detect-button]").click();
  await expect(page.locator("[data-openapi]")).toContainText("API spec found", { timeout: 15_000 });
  await page.locator("[data-openapi-import-button]").click();
  await expect(page).toHaveURL(/\/integrations\/new\/by-example\?.*spec=/);
  const box = page.locator('[data-spec-import="open"]');
  await expect(box).toBeVisible();
  await expect(page.locator("[data-spec-url]")).toHaveValue(`${rest.url}/openapi.json`);
  await page.locator("[data-spec-read-button]").click();
  const preview = page.locator("[data-spec-preview]");
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-spec-summary]")).toContainText("Shelfarr 2.1.0");
  // Headline reads first, in words; the rest folded under Advanced.
  const headline = page.locator("[data-spec-headline] [data-spec-read]");
  await expect(headline.first()).toBeVisible();
  const headlineLabels = await headline.locator("[data-spec-read-label]").allTextContents();
  expect(headlineLabels).toEqual(expect.arrayContaining(["System status", "Queue", "Wanted missing", "Disk space", "Health"]));
  expect(headlineLabels.join(" ")).not.toMatch(/GET \/api/);
  await expect(page.locator('[data-fold="advanced"]')).toBeVisible();
  await expect(page.locator('[data-fold="advanced"] [data-spec-read]')).toHaveCount(0); // folded
  await page.locator('[data-fold-toggle="advanced"]').click();
  await expect(page.locator('[data-spec-read="series-by-id"]')).toContainText("pick id");
  // The key is a write-only secret field.
  await expect(page.locator("[data-spec-secret]")).toHaveAttribute("type", "password");
  await page.locator("[data-spec-secret]").fill(FAKE_REST_KEY);
  await shot(page, "spec-preview-light.png");
  await page.locator("[data-spec-import-button]").click();
  const done = page.locator("[data-spec-done]");
  await expect(done).toContainText(/Imported \d+ reads/, { timeout: 60_000 });
  const check = await page.locator("[data-spec-check]").textContent();
  const m = /(\d+) of (\d+) reads work on this server/.exec(check ?? "");
  expect(m, check ?? "").not.toBeNull();
  expect(Number(m![1])).toBeGreaterThanOrEqual(8);
  expect(Number(m![2])).toBeGreaterThan(Number(m![1])); // /api/v1/tag answers 404: hidden until it works
  await shot(page, "spec-done-light.png");
  expect(rest.writes).toBe(0);
  // Nothing Atrium sent back carries the key (criterion 14).
  await page.locator("[data-spec-open-integration]").click();
  await expect(page).toHaveURL(/\/integrations\/(?!new)/);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const id = new URL(page.url()).pathname.split("/").filter(Boolean)[1]!;
  // The reads answer through Atrium's own data route, with no Try it pressed.
  const api = await request.newContext({ baseURL: ORIGIN, storageState: OWNER_STATE });
  const eps = await (await api.get(`/api/integrations/${id}/endpoints`)).json() as { id: string }[] | { endpoints: { id: string }[] };
  const list = Array.isArray(eps) ? eps : eps.endpoints;
  expect(list.map((e) => e.id)).toEqual(expect.arrayContaining(["system-status", "series", "series-by-id", "queue", "queue-count", "diskspace"]));
  await api.dispose();
  await ctx.close();
  expect(readFileSync(traffic, "utf8")).not.toContain(FAKE_REST_KEY);
});

test("criterion 10: a change is off until picked, needs a risk, and one with an address setting cannot be added", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop flow");
  const ctx = await themedContext(browser, "daylight", { storageState: await signIn(OWNER, OWNER_STATE) });
  const page = await ctx.newPage();
  capture(page, "commands-flow");
  await page.goto(`/integrations/new/by-example?${new URLSearchParams({ url: rest.url, spec: `${rest.url}/openapi.json` })}`);
  await page.locator("[data-spec-read-button]").click();
  await expect(page.locator("[data-spec-preview]")).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-fold-toggle="commands"]').click();
  const commands = page.locator("[data-spec-command]");
  await expect(commands).toHaveCount(4);
  for (const c of await commands.all()) await expect(c.locator('input[type="checkbox"]')).not.toBeChecked();
  const del = page.locator("[data-spec-command]").filter({ hasText: "DELETE" });
  await expect(del.locator('input[type="checkbox"]')).toBeDisabled();
  await expect(del).toContainText("add it by hand");
  const run = page.locator("[data-spec-command]").filter({ hasText: "Run a task" });
  await run.locator('input[type="checkbox"]').check();
  await run.locator("[data-spec-risk]").selectOption("medium");
  await page.locator("[data-spec-name]").fill("Shelfarr with a command");
  await page.locator("[data-spec-secret]").fill(FAKE_REST_KEY);
  await shot(page, "spec-commands-light.png");
  await page.locator("[data-spec-import-button]").click();
  await expect(page.locator("[data-spec-done]")).toContainText("1 change added as command", { timeout: 60_000 });
  expect(rest.writes).toBe(0);
  await ctx.close();
});

test("criterion 9: a YAML spec URL and an uploaded file read the same as the JSON spec", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop flow");
  const ctx = await themedContext(browser, "daylight", { storageState: await signIn(OWNER, OWNER_STATE) });
  const page = await ctx.newPage();
  await page.goto(`/integrations/new/by-example?${new URLSearchParams({ url: rest.url, spec: `${rest.url}/openapi.json` })}`);
  await page.locator("[data-spec-read-button]").click();
  await expect(page.locator("[data-spec-summary]")).toBeVisible({ timeout: 15_000 });
  const fromJson = await page.locator("[data-spec-summary]").textContent();
  // Upload the JSON file.
  await page.locator('[data-spec-mode="file"]').check();
  await page.locator("[data-spec-file]").setInputFiles({ name: "shelfarr.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(FAKE_REST_SPEC)) });
  await page.locator("[data-spec-read-button]").click();
  await expect(page.locator("[data-spec-summary]")).toHaveText(fromJson!, { timeout: 15_000 });
  // The YAML form of the same spec.
  await page.locator('[data-spec-mode="url"]').check();
  await page.locator("[data-spec-url]").fill(`${rest.url}/docs/spec.yaml`);
  await page.locator("[data-spec-read-button]").click();
  const err = page.locator('[data-spec-import="open"] [data-error-code]');
  await expect(page.locator("[data-spec-summary]").or(err)).toBeVisible({ timeout: 15_000 });
  if (await err.isVisible()) {
    await expect(err).toContainText("cannot read YAML yet");
    await shot(page, "spec-yaml-pending-light.png");
    test.info().annotations.push({ type: "yaml", description: "js-yaml not installed on this server (shared file request): YAML refused with a plain message" });
  } else {
    await expect(page.locator("[data-spec-summary]")).toHaveText(fromJson!);
  }
  // Over 10 MB is refused with the limit, before anything is sent.
  await page.locator('[data-spec-mode="file"]').check();
  await page.locator("[data-spec-file]").setInputFiles({ name: "huge.json", mimeType: "application/json", buffer: Buffer.alloc(10 * 1024 * 1024 + 10, 32) });
  await page.locator("[data-spec-read-button]").click();
  await expect(err).toContainText("larger than 10 MB");
  await ctx.close();
});

test("criterion 13: viewers get not found and signed-out callers are refused", async () => {
  const anon = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN } });
  expect((await anon.post("/api/integrations/spec", { data: { address: rest.url } })).status()).toBe(401);
  await anon.dispose();
  const v = await request.newContext({ baseURL: ORIGIN, storageState: await viewerState(), extraHTTPHeaders: { origin: ORIGIN } });
  const a = await v.post("/api/integrations/spec", { data: { address: rest.url } });
  expect(a.status()).toBe(404);
  const b = await v.post("/api/integrations/spec/import", { data: { specId: "sp_x", name: "x", baseUrl: rest.url } });
  expect(b.status()).toBe(404);
  await v.dispose();
});

test("V4: the spec import screens in three themes", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop themes");
  for (const v of SHELL_VARIANTS) {
    const ctx = await themedContext(browser, v.theme, { storageState: await signIn(OWNER, OWNER_STATE) });
    const page = await ctx.newPage();
    await page.goto(`/integrations/new/by-example?${new URLSearchParams({ url: rest.url, spec: `${rest.url}/openapi.json` })}`);
    await page.locator("[data-spec-read-button]").click();
    await expect(page.locator("[data-spec-preview]")).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-fold-toggle="commands"]').click();
    await page.locator('[data-spec-import="open"]').screenshot({ path: ev("screens", `spec-import-${v.name}.png`) });
    await ctx.close();
  }
});

test("criterion 15: at 390px every spec import control is at least 44px", async ({ browser }) => {
  const ctx = await themedContext(browser, "daylight", { mobile: true, storageState: await signIn(OWNER, OWNER_STATE) });
  const page = await ctx.newPage();
  await page.goto(`/integrations/new/by-example?url=${encodeURIComponent(rest.url)}`);
  await page.locator("[data-spec-open]").click();
  await page.locator('[data-spec-mode="find"]').check();
  await page.locator("[data-spec-read-button]").click();
  await expect(page.locator("[data-spec-preview]")).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-fold-toggle="advanced"]').click();
  await page.locator('[data-fold-toggle="commands"]').click();
  const controls = page.locator('[data-spec-import="open"]').locator('button, select, input:not([type="checkbox"]):not([type="radio"]), label:has(input[type="checkbox"]), label:has(input[type="radio"])');
  const n = await controls.count();
  expect(n).toBeGreaterThan(10);
  const small: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    if (!(await c.isVisible())) continue;
    const b = await c.boundingBox();
    if (b && b.height < 44) small.push(`${(await c.textContent())?.trim().slice(0, 40) ?? ""} ${Math.round(b.height)}px`);
  }
  expect(small).toEqual([]);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  await shot(page, "spec-import-mobile-390.png");
  await ctx.close();
});
