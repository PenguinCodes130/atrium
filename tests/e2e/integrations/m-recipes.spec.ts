// Wave 2.8 recipes (recipes spec 3.1, 3.2, 3.4; criteria 1 to 4, 6, 7, 13 to 15), clicked through the
// real integration page (V11) against the stand-in Prometheus (tests/e2e/fixtures/fake-prometheus.ts):
// import a recipe file, see it as a draft with its live check, turn it on, see its reads on the page
// and in the builder's picker (the failing read hidden, shown with its reason under Show all reads),
// import the same file again (keep both), export, import a Grafana dashboard JSON (Node Exporter Full)
// and pick a machine from its dropdown. Normal scenario only. Screens: evidence/recipes/r1/screens.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, request, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { existsSync } from "node:fs";
import { APP, captureTraffic, DATA_DIR, memberState, ORIGIN, ownerState, SHELL_VARIANTS, themedContext } from "./helpers";

const VIEWER = { email: "viewer@atrium.test", password: "e2e-viewer-password-789" };
const VIEWER_STATE = path.join(APP, "test-results/integrations-viewer-state.json");
/** A viewer account in this slot's own database (same recipe as l-data-ease). Test-only password. */
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

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "recipes run in the normal scenario");
test.describe.configure({ mode: "serial", timeout: 120_000 });

const EVID = path.join(APP, "evidence/recipes/r1");
const shotPath = (name: string) => { const p = path.join(EVID, name); mkdirSync(path.dirname(p), { recursive: true }); return p; };
async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  await page.screenshot({ path: shotPath(name), fullPage: true });
}

const RUN = Date.now().toString(36).slice(-4);
const RECIPE_ID = `e2e/lab-${RUN}`;
const rid = (read: string) => `r:${RECIPE_ID}:${read}`;
const GRAFANA = path.join(APP, "src/features/recipes/__fixtures__/grafana-1860.json");
const scratch = path.join(APP, "test-results/recipes");

/** A recipe file a friend might send: a machine list, two Prometheus reads and a read this server lacks (404). */
function recipeFile(version = "1.0.0") {
  return {
    atriumRecipe: "1", id: RECIPE_ID, name: `Lab extras ${RUN}`, version, author: "A friend", description: "A few extra reads for the lab.", source: "file",
    appliesTo: { package: "prometheus" },
    reads: [
      { id: "machines-list", label: "Machine list", request: { kind: "label-values", metric: "node_uname_info", label: "instance", display: "nodename" }, shape: "table", advanced: true },
      { id: "load", label: "Lab load (5 min)", group: "Lab extras", params: { type: "object", properties: { node: { type: "string", title: "Machine", "x-atrium-choices": { endpointId: "machines-list", value: "value", label: "label" } } }, required: ["node"] }, request: { kind: "promql", expr: "node_load5{instance={{ params.node }}}" }, shape: "stat", format: "number" },
      { id: "memory", label: "Lab memory, all machines", group: "Lab extras", request: { kind: "promql", expr: "sum(node_memory_MemTotal_bytes)" }, shape: "stat", format: "bytes" },
      { id: "missing", label: "Lab read this server lacks", group: "Lab extras", request: { kind: "http", path: "/api/v1/not-here" }, fields: [{ path: "$.data", label: "Data", role: "value" }], shape: "stat" },
    ],
  };
}
function writeFile(name: string, body: unknown): string {
  mkdirSync(scratch, { recursive: true });
  const p = path.join(scratch, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return p;
}

let prom: FakePrometheus;
let promId = "";

test.beforeAll(async ({}, info) => {
  prom = await startFakePrometheus();
  if (info.project.name !== "desktop") return;
  const ctx = await request.newContext({ baseURL: ORIGIN, storageState: await ownerState(), extraHTTPHeaders: { origin: ORIGIN } });
  const r = await ctx.post("/api/integrations", { data: { packageId: "prometheus", name: `Recipes Prometheus ${RUN}`, config: { baseUrl: prom.url }, secrets: {}, untested: true } });
  expect(r.status()).toBeLessThan(300);
  promId = ((await r.json()) as { id: string }).id;
  await ctx.dispose();
});
test.afterAll(async () => { await prom?.close(); });

const recipe = (page: Page, id: string) => page.locator(`[data-recipe="${id}"]`);

async function waitChecked(page: Page) {
  await expect(page.locator("[data-check-progress]")).toHaveCount(0, { timeout: 30_000 });
}

test("the Recipes section lists the built-in recipes with their source and how many reads work (criterion 1)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "recipes-builtin");
  await page.goto(`/integrations/${promId}`);
  const section = page.locator("[data-recipes]");
  await expect(section.locator("h2")).toHaveText("Recipes");
  for (const id of ["prometheus/node-exporter", "prometheus/cadvisor", "prometheus/proxmox"]) await expect(recipe(page, id)).toHaveAttribute("data-recipe-source", "builtin");
  await expect(recipe(page, "prometheus/node-exporter").locator("[data-tag]").first()).toHaveText("Built in");
  await expect(recipe(page, "prometheus/node-exporter").locator('[role="switch"]')).toHaveAttribute("aria-checked", "true");
  // Wave 2.7 reads keep their ids and words on the page.
  await expect(page.locator('[data-endpoint="machine-cpu"]')).toContainText("CPU in use");
  await expect(page.locator('[data-endpoint="machine-cpu"] [data-endpoint-from]')).toHaveText("Node exporter, built in");
  // Check again runs the live check with progress, then "N of M reads work".
  await page.locator("[data-recipe-check]").click();
  await waitChecked(page);
  await expect(recipe(page, "prometheus/node-exporter").locator("[data-recipe-works]")).toHaveText(/^\d+ of 20 reads work on this server$/);
  await ctx.close();
});

test("import a recipe file: a draft, checked on this server, off until turned on (criteria 2, 4)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "recipes-import");
  await page.goto(`/integrations/${promId}`);
  await page.locator("[data-recipe-file]").setInputFiles(writeFile(`lab-${RUN}.atrium-recipe.json`, recipeFile()));
  const row = recipe(page, RECIPE_ID);
  await expect(row).toHaveAttribute("data-recipe-status", "draft");
  await expect(row.locator("[data-tag]")).toHaveText(["From a file", "Draft"]);
  await waitChecked(page);
  await expect(row.locator("[data-recipe-works]")).toHaveText("3 of 4 reads work on this server");
  await expect(row.locator('[role="switch"]')).toHaveAttribute("aria-checked", "false");
  // A draft's reads are not on the page yet.
  await expect(page.locator(`[data-endpoint="${rid("memory")}"]`)).toHaveCount(0);
  await row.locator("[data-recipe-reads] summary").click();
  await expect(row.locator(`[data-recipe-read="${rid("missing")}"]`)).toHaveAttribute("data-check", "failed");
  await expect(row.locator(`[data-recipe-read="${rid("missing")}"]`)).toContainText("HTTP 404");
  await shot(page, "screens/recipes-draft-daylight.png");
  // Turn it on through the switch: its reads join the page; the failing one is hidden with its reason.
  await row.locator('[role="switch"]').click();
  await expect(row).toHaveAttribute("data-recipe-status", "active");
  // Imported recipe groups start folded; open the recipe's group.
  await page.locator('[data-endpoint-group-toggle="Lab extras"]').click({ timeout: 15_000 });
  await expect(page.locator(`[data-endpoint="${rid("memory")}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-endpoint="${rid("memory")}"] [data-endpoint-from]`)).toHaveText(`Lab extras ${RUN}, from a file`);
  await expect(page.locator(`[data-endpoint="${rid("missing")}"]`)).toHaveCount(0);
  await expect(page.locator("[data-hidden-reads]")).toContainText("did not work on");
  await page.locator("[data-show-all-reads]").click();
  if ((await page.locator('[data-endpoint-group="Lab extras"]').getAttribute("data-folded")) === "yes") await page.locator('[data-endpoint-group-toggle="Lab extras"]').click();
  const missing = page.locator(`[data-endpoint="${rid("missing")}"]`);
  await expect(missing.locator('[data-endpoint-check="failed"]')).toContainText("HTTP 404");
  await page.locator("[data-show-all-reads]").click();
  if ((await page.locator('[data-endpoint-group="Lab extras"]').getAttribute("data-folded")) === "yes") await page.locator('[data-endpoint-group-toggle="Lab extras"]').click();
  // The which-machine dropdown of a recipe read lists the machines by friendly name.
  const load = page.locator(`[data-endpoint="${rid("load")}"]`);
  const sel = load.locator('select[data-param="node"]');
  await expect(sel).toHaveAttribute("data-choices-state", "ready", { timeout: 10_000 });
  await sel.selectOption({ label: (await sel.locator("option").allTextContents()).find((o) => o.startsWith("ACE"))! });
  await load.locator("[data-preview-button]").click();
  await expect(load.locator("[data-stat-value]")).toHaveText("0.4"); // 0.41, shown with one decimal
  const mem = page.locator(`[data-endpoint="${rid("memory")}"]`);
  await mem.locator("[data-preview-button]").click();
  await expect(mem.locator("[data-stat-value]")).toContainText("GB");
  await ctx.close();
});

test("import the same file again offers replace or keep both; export gives sorted JSON with the same reads (criterion 2)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto(`/integrations/${promId}`);
  await page.locator("[data-recipe-file]").setInputFiles(writeFile(`lab-${RUN}-v2.atrium-recipe.json`, recipeFile("1.1.0")));
  const sheet = page.locator("[data-recipe-conflict]");
  await expect(sheet).toContainText("version 1.0.0 is already here. The file holds version 1.1.0");
  await page.locator("[data-conflict-keep-both]").click();
  await expect(recipe(page, `${RECIPE_ID}-2`)).toHaveAttribute("data-recipe-status", "draft");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-recipe-export="${RECIPE_ID}"]`).click()]);
  expect(download.suggestedFilename()).toBe(`${RECIPE_ID.replace("/", "-")}.atrium-recipe.json`);
  const text = readFileSync(await download.path(), "utf8");
  expect(text.startsWith('{\n  "appliesTo": {\n    "package": "prometheus"\n  },\n  "atriumRecipe": "1"')).toBe(true);
  const exported = JSON.parse(text) as ReturnType<typeof recipeFile>;
  expect(exported.reads.map((r) => r.id)).toEqual(recipeFile().reads.map((r) => r.id));
  expect(text).not.toContain(prom.url);
  await recipe(page, `${RECIPE_ID}-2`).locator(`[data-recipe-delete]`).click();
  await expect(recipe(page, `${RECIPE_ID}-2`)).toHaveCount(0);
  await ctx.close();
});

test("a recipe file with a bad field is refused naming the field, and nothing is added (criterion 3)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto(`/integrations/${promId}`);
  await expect(recipe(page, RECIPE_ID)).toBeVisible();
  const count = await page.locator("[data-recipe]").count();
  const bad = recipeFile();
  (bad.reads[2] as Record<string, unknown>).shape = "pie";
  bad.id = `e2e/bad-${RUN}`;
  await page.locator("[data-recipe-file]").setInputFiles(writeFile(`bad-${RUN}.atrium-recipe.json`, bad));
  await expect(page.locator("[data-recipes] [role=alert], [data-recipes] [data-error-callout]").first()).toContainText("reads[2].shape");
  await expect(page.locator("[data-recipe]")).toHaveCount(count);
  await shot(page, "screens/recipes-bad-file-daylight.png");
  await ctx.close();
});

test("import a Grafana dashboard JSON (Node Exporter Full): a draft from Grafana with working reads and a which-machine dropdown (criteria 6, 7)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "recipes-grafana");
  await page.goto(`/integrations/${promId}`);
  await page.locator("[data-recipe-import-grafana]").click();
  await expect(page.locator("[data-grafana-sheet]")).toBeVisible();
  await shot(page, "screens/recipes-grafana-sheet-daylight.png");
  await page.locator("[data-grafana-file]").setInputFiles(GRAFANA);
  // On a kept data folder the dashboard may be here already: replace it.
  await page.locator("[data-conflict-replace]").click({ timeout: 3000 }).catch(() => undefined);
  const row = recipe(page, "grafana/1860");
  await expect(row).toHaveAttribute("data-recipe-source", "grafana", { timeout: 15_000 });
  await expect(row.locator("[data-tag]").first()).toHaveText("From Grafana");
  await expect(page.locator("[data-check-progress]")).toContainText(/Checked \d+ of \d+/, { timeout: 10_000 }).catch(() => undefined);
  await waitChecked(page);
  const works = await row.locator("[data-recipe-works]").textContent();
  const n = Number(/^(\d+) of 274 reads work/.exec(works ?? "")?.[1] ?? 0);
  expect(n).toBeGreaterThan(20);
  await row.locator('[role="switch"]').click();
  await expect(row).toHaveAttribute("data-recipe-status", "active");
  await page.locator('[data-endpoint-group-toggle="Quick CPU / Mem / Disk"]').click({ timeout: 15_000 });
  const cpu = page.locator('[data-endpoint="r:grafana/1860:cpu-busy"]');
  await expect(cpu).toBeVisible({ timeout: 15_000 });
  await expect(cpu.locator("[data-endpoint-from]")).toHaveText("Node Exporter Full, from Grafana");
  const sel = cpu.locator('select[data-param="node"]');
  await expect(sel).toHaveAttribute("data-choices-state", "ready", { timeout: 10_000 });
  const options = await sel.locator("option").allTextContents();
  expect(options.some((o) => o.startsWith("RP5-3"))).toBe(true);
  expect(options.some((o) => o.startsWith("host.docker.internal"))).toBe(false);
  await sel.selectOption({ label: options.find((o) => o.startsWith("ACE"))! });
  await cpu.locator("[data-preview-button]").click();
  // A long page: every which-machine list loads (cached on the server), so a preview may queue behind them.
  await expect(cpu.locator("[data-stat-value]")).toHaveText("7.8 %", { timeout: 20_000 }); // percent format from the panel's unit
  const ram = page.locator('[data-endpoint="r:grafana/1860:ram-total"]');
  const ramSel = ram.locator('select[data-param="node"]');
  await expect(ramSel).toHaveAttribute("data-choices-state", "ready", { timeout: 10_000 });
  await ramSel.selectOption({ label: options.find((o) => o.startsWith("ACE"))! });
  await ram.locator("[data-preview-button]").click();
  await expect(ram.locator("[data-stat-value]")).toHaveText(/GB$/, { timeout: 20_000 }); // bytes format
  await cpu.scrollIntoViewIfNeeded();
  await shot(page, "screens/recipes-grafana-read-daylight.png");
  await ctx.close();
});

test("recipe reads appear in the builder's picker like any read, the failing one hidden (V11)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  const api = await request.newContext({ baseURL: ORIGIN, storageState: await ownerState(), extraHTTPHeaders: { origin: ORIGIN } });
  const slug = `recipes-${RUN}`;
  const app = await api.post("/api/apps", { data: { name: `Recipes ${RUN}`, slug } });
  expect(app.ok()).toBe(true);
  const appId = ((await app.json()) as { app: { id: string } }).app.id;
  const draft = (await (await api.get(`/api/apps/${appId}/draft`)).json()) as { rev: number; doc: { pages: { root: { id: string } }[] } };
  const ops = await api.post(`/api/apps/${appId}/ops`, { data: { rev: draft.rev, ops: [{ op: "node.add", parentId: draft.doc.pages[0]!.root.id, node: { id: "c_recipetext", type: "text", props: { text: "Memory" }, slot: { x: 0, y: 0, w: 6, h: 24 } } }] } });
  expect(ops.ok()).toBe(true);
  await api.dispose();
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_recipetext"]').click();
  await page.locator('[data-pick-button="text"]').first().click();
  // Wave 2.9: Bind opens "What should this show?" first; the Wave 2.8 picker is "Set it up by hand".
  const byHand = page.locator("[data-pick-by-hand]");
  if (await byHand.waitFor({ timeout: 5_000 }).then(() => true).catch(() => false)) await byHand.click();
  await expect(page.locator("[data-data-picker]")).toBeVisible();
  await page.locator(`[data-pick-integration="${promId}"]`).click();
  await expect(page.locator(`[data-pick-endpoint="${rid("memory")}"]`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-pick-endpoint="r:grafana/1860:cpu-busy"]')).toBeVisible();
  await expect(page.locator(`[data-pick-endpoint="${rid("missing")}"]`)).toHaveCount(0);
  await expect(page.locator('[data-pick-endpoint="machine-cpu"]')).toBeVisible();
  await page.screenshot({ path: shotPath("screens/recipes-picker-daylight.png") });
  await page.locator(`[data-pick-endpoint="${rid("memory")}"]`).click();
  await expect(page.locator("[data-pick-sample]")).toBeVisible({ timeout: 5000 });
  await ctx.close();
});

test("three themes and 390 px: the Recipes section is usable with 44 px controls (V4, V5, criterion 15)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  for (const v of SHELL_VARIANTS) {
    const ctx = await themedContext(browser, v.theme);
    const page = await ctx.newPage();
    await page.goto(`/integrations/${promId}`);
    await expect(recipe(page, "grafana/1860")).toBeVisible();
    await page.locator("[data-recipes]").scrollIntoViewIfNeeded();
    await page.locator("[data-recipes]").screenshot({ path: shotPath(`screens/recipes-section-${v.name}.png`) });
    await ctx.close();
  }
  const ctx = await themedContext(browser, "daylight", { mobile: true });
  const page = await ctx.newPage();
  await page.goto(`/integrations/${promId}`);
  const section = page.locator("[data-recipes]");
  await expect(recipe(page, "grafana/1860")).toBeVisible();
  for (const sel of ["[data-recipe-import-file]", "[data-recipe-import-grafana]", "[data-recipe-check]", "[data-recipe-import-link]", `[data-recipe-export="grafana/1860"]`, `[data-recipe="grafana/1860"] [role="switch"]`, `[data-recipe="grafana/1860"] [data-recipe-reads] summary`]) {
    const box = await section.locator(sel).first().boundingBox();
    expect(box, sel).not.toBeNull();
    expect(box!.height, sel).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: shotPath("screens/recipes-mobile-390.png") });
  await page.locator("[data-recipe-import-grafana]").click();
  const go = page.locator("[data-grafana-download]");
  expect((await go.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: shotPath("screens/recipes-grafana-sheet-mobile-390.png") });
  await ctx.close();
});

test("viewers never see Recipes; their recipe and check calls get not found; members can turn recipes on (criterion 13)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  // Share the integration so a member may use it.
  const owner = await request.newContext({ baseURL: ORIGIN, storageState: await ownerState(), extraHTTPHeaders: { origin: ORIGIN } });
  expect((await owner.patch(`/api/integrations/${promId}`, { data: { shared: true } })).status()).toBeLessThan(300);
  await owner.dispose();
  const member = await request.newContext({ baseURL: ORIGIN, storageState: await memberState(), extraHTTPHeaders: { origin: ORIGIN } });
  expect((await member.post("/api/recipes/status", { data: { id: `${RECIPE_ID}`, status: "draft" } })).status()).toBe(200);
  expect((await member.post("/api/recipes/status", { data: { id: `${RECIPE_ID}`, status: "active" } })).status()).toBe(200);
  expect((await member.get(`/api/recipes?integrationId=${promId}`)).status()).toBe(200);
  await member.dispose();
  const anon = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN } });
  for (const [m, p, d] of [["get", `/api/recipes?integrationId=${promId}`], ["post", "/api/recipes/import", { text: "{}" }], ["post", "/api/recipes/grafana", { integrationId: promId, dashboardId: "1860" }], ["post", "/api/recipes/status", { id: RECIPE_ID, status: "draft" }], ["get", `/api/recipes/export?id=${RECIPE_ID}`], ["get", `/api/recipes/check?integrationId=${promId}`]] as const) {
    const r = m === "get" ? await anon.get(p) : await anon.post(p, { data: d });
    // Signed out: the app's front door answers 401 before the route (as for every API); the route itself says 404.
    expect([p, [401, 404].includes(r.status())]).toEqual([p, true]);
  }
  await anon.dispose();
  const vstate = await viewerState();
  const viewer = await request.newContext({ baseURL: ORIGIN, storageState: vstate, extraHTTPHeaders: { origin: ORIGIN } });
  expect((await viewer.get(`/api/recipes?integrationId=${promId}`)).status()).toBe(404);
  expect((await viewer.get(`/api/recipes/check?integrationId=${promId}`)).status()).toBe(404);
  expect((await viewer.post("/api/recipes/status", { data: { id: RECIPE_ID, status: "draft" } })).status()).toBe(404);
  await viewer.dispose();
  const ctx = await themedContext(browser, "daylight", { storageState: vstate });
  const page = await ctx.newPage();
  const res = await page.goto(`/integrations/${promId}`);
  if (res && res.status() === 200) {
    await expect(page.locator("[data-integration-detail]")).toBeVisible();
    await expect(page.locator("[data-recipes]")).toHaveCount(0);
  }
  await ctx.close();
});
