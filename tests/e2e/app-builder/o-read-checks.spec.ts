// app-builder e2e: Wave 2.8 recipes, the builder side (stages/02-subsystem-spec/output/recipes-spec.md 3.1
// last bullet, 3.2 bullets 3 and 4; criteria 4 and 5), clicked through the real picker, inspector, canvas,
// integration page and publish review (V11) against the stand-in Prometheus. A recipe file with a read
// this server lacks (404) is imported and turned on through the API as setup (builder R's suite clicks
// that part). Evidence: evidence/app-builder/<ATRIUM_E2E_EVIDENCE_ROUND>/read-checks/.
import { expect, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { api, contextFor, ev, OWNER, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.skip(({ isMobile }) => isMobile, "desktop project");

type Node = { id: string; type: string; props: Record<string, unknown>; children?: Node[] };
type Draft = { rev: number; doc: { dataSources: { name: string; endpointId: string; integrationId: string }[]; pages: { id: string; root: Node }[] } };

const RUN = Date.now().toString(36).slice(-4);
const RECIPE_ID = `e2e/checks-${RUN}`;
const NAME = `Lab checks ${RUN}`;
const rid = (read: string) => `r:${RECIPE_ID}:${read}`;
const shot = (name: string) => ev("read-checks", `${name}.png`);
let prom: FakePrometheus | undefined;
let prom2: FakePrometheus | undefined;
let promId = "";
let prom2Id = "";

const recipeFile = () => ({
  atriumRecipe: "1", id: RECIPE_ID, name: NAME, version: "1.0.0", author: "A friend", description: "Reads to check.", source: "file",
  appliesTo: { package: "prometheus" },
  reads: [
    { id: "memory", label: `Lab memory ${RUN}`, group: "Lab checks", request: { kind: "promql", expr: "sum(node_memory_MemTotal_bytes)" }, shape: "stat", format: "bytes" },
    { id: "missing", label: `Lab missing ${RUN}`, group: "Lab checks", request: { kind: "http", path: "/api/v1/not-here" }, fields: [{ path: "$.data", label: "Data", role: "value" }], shape: "stat" },
  ],
});

async function untilChecked(integrationId: string): Promise<void> {
  const c = await api(OWNER);
  const t0 = Date.now();
  for (;;) {
    const j = await (await c.get(`/api/recipes/check?integrationId=${encodeURIComponent(integrationId)}`)).json() as { running: boolean; done: number; total: number };
    if ((!j.running && j.done > 0) || Date.now() - t0 > 30_000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // The listing carries the stored result once the check has written it.
  for (;;) {
    const b = await (await c.get("/api/integrations/bindable")).json() as { integrations: { integrationId: string; endpoints: { id: string; check?: { status: string } }[] }[] };
    const eps = b.integrations.find((i) => i.integrationId === integrationId)?.endpoints ?? [];
    if (eps.find((e) => e.id === rid("missing"))?.check || Date.now() - t0 > 30_000) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}
async function newApp(slug: string): Promise<string> {
  const r = await (await api(OWNER)).post("/api/apps", { data: { name: `Checks ${slug}`, slug } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app.id as string;
}
async function draft(id: string): Promise<Draft> {
  return (await (await api(OWNER)).get(`/api/apps/${id}/draft`)).json();
}
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 6000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const picker = (page: Page) => page.locator("[data-data-picker]");
const canvasNode = (page: Page, id: string) => page.locator(`[data-canvas-root] [data-node="${id}"]`);
/** Inserts a stat from Insert (the picker opens at once) and returns its id. */
async function insertStat(page: Page): Promise<string> {
  await page.locator('[data-left-tab="insert"]').click().catch(() => {});
  const before = new Set(await page.locator("[data-canvas-root] [data-node]").evaluateAll((els) => els.map((e) => e.getAttribute("data-node"))));
  await page.locator('[data-insert-item="stat"]').click();
  await expect(picker(page)).toBeVisible();
  await expect.poll(async () => (await page.locator("[data-canvas-root] [data-type='stat']").evaluateAll((els) => els.map((e) => e.getAttribute("data-node")))).some((x) => !before.has(x))).toBe(true);
  const after = await page.locator("[data-canvas-root] [data-type='stat']").evaluateAll((els) => els.map((e) => e.getAttribute("data-node")));
  return after.find((x) => !before.has(x))!;
}
async function showAll(page: Page) {
  await page.locator("[data-pick-show-all] [role=switch], [data-pick-show-all] input, [data-pick-show-all] button").first().click();
}
async function openGroup(page: Page, title: string) {
  const g = page.locator(`section[data-inspector-group="${title}"]`).first();
  await expect(g).toBeVisible();
  if ((await g.getAttribute("data-open")) === null) await g.locator("h3 button").click();
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  prom = await startFakePrometheus();
  prom2 = await startFakePrometheus();
  const c = await api(OWNER);
  for (const [p, set] of [[prom, (id: string) => { promId = id; }], [prom2, (id: string) => { prom2Id = id; }]] as const) {
    const r = await c.post("/api/integrations", { data: { packageId: "prometheus", name: p === prom ? `Checks Prometheus ${RUN}` : `Second Prometheus ${RUN}`, config: { baseUrl: p.url, authMode: "none" }, secrets: {}, untested: true } });
    if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
    set((await r.json()).id as string);
  }
  const im = await c.post("/api/recipes/import", { data: { text: JSON.stringify(recipeFile()), integrationId: promId } });
  if (im.status() !== 201) throw new Error(`import: ${im.status()} ${await im.text()}`);
  const on = await c.post("/api/recipes/status", { data: { id: RECIPE_ID, status: "active" } });
  if (!on.ok()) throw new Error(`turn on: ${on.status()} ${await on.text()}`);
  await untilChecked(promId);
  await untilChecked(prom2Id);
});
test.afterAll(async () => { await prom?.close(); await prom2?.close(); });

test("the picker tags recipe reads with where they came from, and lists a read that failed its check with its reason under Show all reads (spec 3.1, criterion 4)", async ({ browser }) => {
  const slug = `rc-tags-${RUN}`;
  await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await insertStat(page);
  await page.locator(`[data-pick-integration="${promId}"]`).click();
  const memory = page.locator(`[data-pick-endpoint="${rid("memory")}"]`);
  await expect(memory).toBeVisible();
  await expect(memory.locator("[data-pick-endpoint-from]")).toHaveText(`${NAME}, from a file`);
  await expect(memory.locator("[data-pick-endpoint-description]")).toHaveCount(0); // the tag is shown once, not twice
  // A built-in recipe read carries its tag too.
  await expect(page.locator('[data-pick-endpoint="machine-cpu"] [data-pick-endpoint-from]')).toHaveText("Node exporter, built in");
  // The read this server lacks is hidden; Show all reads says why it is hidden and lists it with its reason.
  await expect(page.locator(`[data-pick-endpoint="${rid("missing")}"]`)).toHaveCount(0);
  await expect(page.locator("[data-pick-show-all]")).toContainText("did not work on this server");
  await showAll(page);
  const missing = page.locator(`[data-pick-endpoint="${rid("missing")}"]`);
  await expect(missing).toHaveAttribute("data-available", "no");
  await expect(missing.locator('[data-pick-endpoint-check="failed"]')).toContainText("Did not work on this server");
  await expect(missing.locator('[data-pick-endpoint-check="failed"]')).toContainText("404");
  await expect(missing.locator("[data-pick-endpoint-from]")).toHaveText(`${NAME}, from a file`);
  await missing.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot("picker-failed-read-light") });
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await ctx.close();
});

test("a widget bound to a failing read is marked on the canvas (edit only), in its Shows line and in the publish review with Show the component (criterion 5)", async ({ browser }) => {
  const slug = `rc-bound-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  // A healthy stat first: no warning on it.
  const good = await insertStat(page);
  await page.locator(`[data-pick-integration="${promId}"]`).click();
  await page.locator(`[data-pick-endpoint="${rid("memory")}"]`).click();
  await page.locator("[data-pick-use]").click();
  await expect(canvasNode(page, good).locator('[data-slot="value"]')).toHaveText("16", { timeout: 8000 });
  await page.locator("[data-pick-done]").click();
  // Then a stat bound to the read that failed its check. The picker offers no "Use this data" for a read
  // that answers an error, so this widget arrives already bound (as from an app file or an earlier
  // session): set up through the draft API, then reload the builder.
  const bad = "c_rcbadstata";
  const d0 = await untilDraft(id, (d) => d.doc.dataSources.length === 1);
  const add = await (await api(OWNER)).post(`/api/apps/${id}/ops`, { data: { rev: d0.rev, ops: [
    { op: "source.set", source: { name: "lab_missing", label: "Lab missing", integrationId: promId, endpointId: rid("missing"), refreshSec: 60 } },
    { op: "node.add", parentId: d0.doc.pages[0]!.root.id, node: { id: bad, type: "stat", props: { data: { $bind: "{{ lab_missing }}" } }, slot: { x: 4, y: 0, w: 3, h: 16 } } },
  ] } });
  expect(add.ok(), await add.text()).toBe(true);
  await page.reload();
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  // Canvas: the mark is on the failing widget only.
  await expect(canvasNode(page, bad).locator("[data-read-warning]")).toBeVisible({ timeout: 8000 });
  await expect(canvasNode(page, bad).locator("[data-read-warning]")).toContainText("Read stopped working");
  await expect(canvasNode(page, good).locator("[data-read-warning]")).toHaveCount(0);
  // Inspector: the Shows line says the read stopped working and why.
  await canvasNode(page, bad).click();
  await openGroup(page, "data");
  await expect(page.locator("[data-data-read-failed]")).toContainText("This read stopped working on");
  await expect(page.locator("[data-data-read-failed]")).toContainText("404");
  await page.screenshot({ path: shot("builder-failed-read-dark") });
  await canvasNode(page, good).click();
  await expect(page.locator("[data-data-summary]")).toBeVisible();
  await expect(page.locator("[data-data-read-failed]")).toHaveCount(0);
  // Publish review: the warning names the component, and Show the component selects it.
  await page.waitForTimeout(800);
  await page.locator("[data-publish]").first().click();
  await expect(page.locator("[data-review]")).toBeVisible();
  const warning = page.locator('[data-review-problem="warning"]').filter({ hasText: "which stopped working on its server" });
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText("404");
  await expect(warning).toContainText("Show the component");
  await page.screenshot({ path: shot("review-failed-read-dark") });
  await warning.locator(`[data-review-problem-select="${bad}"]`).click();
  await expect(page.locator("[data-review]")).toHaveCount(0);
  await expect(page.locator(`[data-selected-outline="${bad}"]`)).toBeVisible();
  // Viewers never see the mark: publish and open the app.
  await page.locator("[data-publish]").first().click();
  await page.locator("[data-publish-confirm]").click();
  await expect(page.locator("[data-publish-glow]")).toBeAttached();
  await page.goto(`/a/${slug}`);
  await expect(page.locator(`[data-node="${good}"] [data-slot="value"]`)).toHaveText("16", { timeout: 8000 });
  await expect(page.locator("[data-read-warning]")).toHaveCount(0);
  await ctx.close();
});

test("a read that worked and starts failing after a check marks its widget in the builder and the publish review (criterion 5)", async ({ browser }) => {
  const slug = `rc-turn-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[2], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  const stat = await insertStat(page);
  await page.locator(`[data-pick-integration="${prom2Id}"]`).click();
  await page.locator(`[data-pick-endpoint="${rid("memory")}"]`).click();
  await page.locator("[data-pick-use]").click();
  await expect(canvasNode(page, stat).locator('[data-slot="value"]')).toHaveText("16", { timeout: 8000 });
  await page.locator("[data-pick-done]").click();
  await untilDraft(id, (d) => d.doc.dataSources.length === 1);
  await expect(canvasNode(page, stat).locator("[data-read-warning]")).toHaveCount(0);
  // The second Prometheus goes away; its live check runs again from the integration page (as the daily check would).
  await prom2!.close();
  prom2 = undefined;
  await page.goto(`/integrations/${prom2Id}`);
  await page.locator("[data-recipe-check]").click();
  await expect(page.locator("[data-check-progress]")).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const b = await (await (await api(OWNER)).get("/api/integrations/bindable")).json() as { integrations: { integrationId: string; endpoints: { id: string; check?: { status: string } }[] }[] };
    return b.integrations.find((i) => i.integrationId === prom2Id)?.endpoints.find((e) => e.id === rid("memory"))?.check?.status;
  }, { timeout: 30_000 }).toBe("failed");
  await page.goto(`/build/${slug}`);
  await expect(canvasNode(page, stat).locator("[data-read-warning]")).toBeVisible({ timeout: 8000 });
  await canvasNode(page, stat).click();
  await openGroup(page, "data");
  await expect(page.locator("[data-data-read-failed]")).toContainText("This read stopped working on Second Prometheus");
  await page.screenshot({ path: shot("builder-started-failing-solid") });
  await page.locator("[data-publish]").first().click();
  await expect(page.locator("[data-review]")).toBeVisible();
  const warning = page.locator('[data-review-problem="warning"]').filter({ hasText: "which stopped working on its server" });
  await expect(warning).toHaveCount(1);
  await expect(warning.locator(`[data-review-problem-select="${stat}"]`)).toContainText("Show the component");
  await ctx.close();
});
