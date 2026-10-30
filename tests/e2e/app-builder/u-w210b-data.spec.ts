// Wave 2.10b builder D (app-builder, data): F2 judging data before committing (a live preview in the target
// widget, and Empty, Zero, Error and Stale markers), F4 for the builder's own inspector settings, F5 Off
// (architecture A11.8) and the F10 sweep's samples for data fields (stages/02-subsystem-spec/output/
// operator-tryout-spec.md section 4, criteria 10, 12, 13, 17). Every test drives the real screen the way the
// operator does (V11): Insert, "What should this show?", the inspector, the Refresh menu, the viewer.
// Stand-ins: the 9-machine fake Prometheus (tests/e2e/fixtures) and a small "lab" Prometheus started here
// that answers a zero, an empty table, a read that breaks on demand and a series whose newest point is
// 10 minutes old. Never a real service. Evidence: evidence/app-builder-data/w210b-r1/<stage>/.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { api, contextFor, OWNER, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; refreshSec?: number; showTitle?: boolean; title?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Source = { name: string; integrationId: string; endpointId: string; refreshSec: number; params?: Record<string, unknown>; managed?: boolean };
type Draft = { rev: number; doc: { dataSources: Source[]; pages: { id: string; slug: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210B_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder-data/w210b-r1", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const note = (name: string, data: unknown) => writeFileSync(out(`${name}.json`), JSON.stringify(data, null, 2));
const RUN = Date.now().toString(36).slice(-4);
const LIGHT = SHELL_VARIANTS[0]!;
const ACE = "10.77.99.8:9100";
const PVE1 = "10.77.99.4:9100";
const PVE2 = "10.77.99.10:9100";
const owner = () => api(OWNER);

// ---- the lab stand-in: a Prometheus that answers four reads with a known condition each (FAKE) ----
type Lab = { url: string; hits: string[]; setBroken(b: boolean): void; close(): Promise<void> };
async function startLab(): Promise<Lab> {
  const hits: string[] = [];
  let broken = false;
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const s = createServer((req: IncomingMessage, res) => {
    const u = new URL(req.url ?? "/", "http://lab");
    hits.push(decodeURIComponent(req.url ?? ""));
    const q = u.searchParams.get("query") ?? "";
    const now = Date.now() / 1000;
    if (u.pathname === "/-/healthy") { res.writeHead(200); return res.end("Prometheus Server is Healthy.\n"); }
    if (u.pathname === "/api/v1/status/buildinfo") return json(res, 200, { status: "success", data: { version: "3.14.0", revision: "fake-lab" } });
    if (u.pathname === "/api/v1/label/__name__/values") return json(res, 200, { status: "success", data: ["e2e_zero", "e2e_empty", "e2e_flaky", "e2e_old", "up"] });
    if (/^\/api\/v1\/label\//.test(u.pathname)) return json(res, 200, { status: "success", data: [] });
    if (u.pathname === "/api/v1/targets") return json(res, 200, { status: "success", data: { activeTargets: [], droppedTargets: [] } });
    if (u.pathname === "/api/v1/metadata") return json(res, 200, { status: "success", data: {} });
    if (u.pathname === "/api/v1/series") return json(res, 200, { status: "success", data: [] });
    if (u.pathname === "/api/v1/alerts") return json(res, 200, { status: "success", data: { alerts: [] } });
    if (u.pathname === "/api/v1/rules") return json(res, 200, { status: "success", data: { groups: [] } });
    if (q.includes("e2e_flaky") && broken) return json(res, 503, { status: "error", errorType: "unavailable", error: "FAKE lab: the query engine is down" });
    if (u.pathname === "/api/v1/query") {
      const t = Number(u.searchParams.get("time")) || now;
      const v = q.includes("e2e_zero") ? "0" : q.includes("e2e_flaky") ? "5" : q.includes("e2e_old") ? "12" : null;
      const result = v === null ? [] : [{ metric: { job: "lab" }, value: [t, v] }];
      return json(res, 200, { status: "success", data: { resultType: "vector", result } });
    }
    if (u.pathname === "/api/v1/query_range") {
      const step = Math.max(Number(u.searchParams.get("step")) || 60, 1);
      const end = Number(u.searchParams.get("end")) || now;
      // e2e_old: the newest point is 10 minutes old (the exporter stopped then).
      const last = q.includes("e2e_old") ? now - 600 : end;
      const start = Math.min(Number(u.searchParams.get("start")) || end - 3600, last - step * 10);
      const values: [number, string][] = [];
      for (let x = start; x <= last; x += step) values.push([x, (10 + Math.sin(x / 300)).toFixed(3)]);
      const result = q.includes("e2e_empty") ? [] : [{ metric: { job: "lab" }, values }];
      return json(res, 200, { status: "success", data: { resultType: "matrix", result } });
    }
    json(res, 404, { status: "error", errorType: "not_found", error: "not found" });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, hits, setBroken: (b) => { broken = b; }, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

const RECIPE_ID = `e2e/lab-${RUN}`;
const LAB = `Lab ${RUN}`;
// A typed search lists at most 50 rows; earlier specs leave Prometheus services behind, so name this run's.
const CPU = `cpu ${RUN}`;
const recipeFile = () => ({
  atriumRecipe: "1", id: RECIPE_ID, name: `Lab reads ${RUN}`, version: "1.0.0", author: "e2e", description: "Reads with a known condition each (FAKE).", source: "file",
  appliesTo: { package: "prometheus" },
  reads: [
    { id: "zero", label: `${LAB} zero`, group: "Lab", request: { kind: "promql", expr: "sum(e2e_zero)" }, shape: "stat" },
    { id: "empty", label: `${LAB} empty`, group: "Lab", request: { kind: "promql", expr: "e2e_empty" }, shape: "table" },
    { id: "flaky", label: `${LAB} flaky`, group: "Lab", request: { kind: "promql", expr: "sum(e2e_flaky)" }, shape: "stat" },
    { id: "old", label: `${LAB} old`, group: "Lab", request: { kind: "promql", expr: "sum(e2e_old)", range: { hours: 1, stepSec: 60 } }, shape: "series" },
  ],
});

let prom: FakePrometheus | undefined;
let lab: Lab | undefined;
let promId = "";
let labId = "";
test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  prom = await startFakePrometheus();
  lab = await startLab();
  const c = await owner();
  const mk = async (data: Record<string, unknown>) => { const r = await c.post("/api/integrations", { data: { secrets: {}, untested: true, ...data } }); if (!r.ok()) throw new Error(`integration: ${await r.text()}`); return (await r.json()).id as string; };
  promId = await mk({ packageId: "prometheus", name: `Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" } });
  labId = await mk({ packageId: "prometheus", name: `Lab Prometheus ${RUN}`, config: { baseUrl: lab.url, authMode: "none" } });
  const im = await c.post("/api/recipes/import", { data: { text: JSON.stringify(recipeFile()), integrationId: labId } });
  if (im.status() !== 201) throw new Error(`import: ${im.status()} ${await im.text()}`);
  const on = await c.post("/api/recipes/status", { data: { id: RECIPE_ID, status: "active" } });
  if (!on.ok()) throw new Error(`turn on: ${on.status()} ${await on.text()}`);
  // The live check runs once; wait for it so its result is stored before the picker lists the reads.
  const t0 = Date.now();
  for (;;) {
    const j = await (await c.get(`/api/recipes/check?integrationId=${encodeURIComponent(labId)}`)).json() as { running: boolean; done: number };
    if ((!j.running && j.done > 0) || Date.now() - t0 > 30_000) break;
    await new Promise((r) => setTimeout(r, 250));
  }
});
test.afterAll(async () => { await prom?.close(); await lab?.close(); });

async function draft(id: string): Promise<Draft> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const walk = (x: Node, f: (n: Node) => void) => { f(x); for (const k of x.children ?? []) walk(k, f); };
const nodeIn = (d: Draft, id: string): Node | undefined => { let f: Node | undefined; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.id === id) f = x; }); return f; };
async function newApp(slug: string, themeId?: string): Promise<string> {
  const r = await (await owner()).post("/api/apps", { data: { name: `Data ${slug}`, slug, template: "blank", ...(themeId ? { theme: { themeId } } : {}) } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app.id as string;
}
async function publish(id: string) {
  const c = await owner();
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note: "data e2e" } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
const picker = (page: Page) => page.locator("[data-show-picker]");
const canvasNode = (page: Page, id: string) => page.locator(`[data-canvas-root] [data-node="${id}"]`);
async function insert(page: Page, type: string): Promise<string> {
  await page.locator('[data-left-tab="insert"]').click().catch(() => {});
  const before = new Set(await page.locator("[data-canvas-root] [data-node]").evaluateAll((els) => els.map((e) => e.getAttribute("data-node"))));
  await page.locator(`[data-insert-item="${type}"]`).click();
  await expect.poll(async () => (await page.locator(`[data-canvas-root] [data-type='${type}']`).evaluateAll((els) => els.map((e) => e.getAttribute("data-node")))).find((x) => !before.has(x))).toBeTruthy();
  const after = await page.locator(`[data-canvas-root] [data-type='${type}']`).evaluateAll((els) => els.map((e) => e.getAttribute("data-node")));
  return after.find((x) => !before.has(x))!;
}
const item = (page: Page, integrationId: string, endpointId: string, thing?: string) =>
  page.locator(`[data-show-item][data-show-integration="${integrationId}"][data-show-endpoint="${endpointId}"]${thing !== undefined ? `[data-show-thing-value="${thing}"]` : ""}`).first();
const labRead = (page: Page, read: string) => page.locator(`[data-show-item][data-show-integration="${labId}"][data-show-endpoint$=":${read}"]`).first();
const cpuHits = (instance: string) => (prom?.hits ?? []).filter((h) => h.url.startsWith("/api/v1/query?") && decodeURIComponent(h.url).includes(`instance="${instance}"`) && decodeURIComponent(h.url).includes("node_cpu_seconds_total")).length;

/** The V4 frosted custom theme through the real API: FAKE image wallpaper, glass 0.3, blur 1 px, soft shadow, 1 px border. */
function fakeWallpaper(): Buffer {
  const w = 640, h = 400;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) { const i = o + 1 + x * 3; raw[i] = Math.round(60 + 140 * (x / w)); raw[i + 1] = Math.round(80 + 90 * (y / h)); raw[i + 2] = Math.round(210 - 110 * (x / w) * (y / h)); }
  }
  const t = Array.from({ length: 256 }, (_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
async function frostedTheme(c: APIRequestContext): Promise<string> {
  const up = await c.post("/api/settings/uploads", { multipart: { file: { name: "fake-wallpaper.png", mimeType: "image/png", buffer: fakeWallpaper() }, accept: "image" } });
  expect(up.ok(), await up.text()).toBe(true);
  const src = (await up.json()).path as string;
  const dup = await c.post("/api/settings/themes/control-room/duplicate");
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  const cur = await (await c.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = `Frosted data e2e ${RUN}`;
  theme.tokens.wallpaper = { ...theme.tokens.wallpaper, kind: "image", value: src, blurPx: 0, dim: 0, grain: 0 };
  theme.tokens.surface = { ...theme.tokens.surface, material: "glass", opacity: 0.3, blurPx: 1, shadow: "soft", shadowOffsetPx: 0, border: { ...theme.tokens.surface.border, widthPx: 1 } };
  const put = await c.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}

// ---------------------------------------------------------------------------------------------------
// F2: judging data before committing
// ---------------------------------------------------------------------------------------------------

test("F2 criterion 10: hovering or focusing a candidate draws the target widget beside the list with its live value; the canvas is unchanged until Use", async ({ browser }) => {
  const slug = `d-prev-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const stat = await insert(page, "stat");
  await expect(picker(page)).toBeVisible();
  await page.keyboard.type(CPU);
  const ace = item(page, promId, "machine-cpu", ACE);
  const pve1 = item(page, promId, "machine-cpu", PVE1);
  await expect(ace).toBeVisible({ timeout: 5000 });
  await expect(ace.locator("[data-show-value]")).toHaveAttribute("data-show-value", "yes", { timeout: 5000 });
  const canvasBefore = await canvasNode(page, stat).innerText();
  const revBefore = (await draft(id)).rev;

  await ace.hover();
  const pv = page.locator("[data-show-preview]");
  await expect(pv).toBeVisible();
  await expect(pv).toHaveAttribute("data-show-preview-for", (await ace.getAttribute("data-show-item"))!);
  // The target widget itself (a stat), drawn with the read's real current value.
  const widget = pv.locator("[data-show-preview-widget] [data-type='stat']");
  await expect(widget).toBeVisible();
  await expect(widget).toContainText("7.8");
  // Beside the list at desktop width: the preview's left edge is right of the list's right edge.
  const listBox = (await page.locator("[data-show-list]").boundingBox())!;
  const pvBox = (await pv.boundingBox())!;
  expect(pvBox.x, "the preview sits beside the list").toBeGreaterThanOrEqual(listBox.x + listBox.width - 1);
  await page.screenshot({ path: out("f2-hover-ace.png") });

  // Keyboard focus moves the preview too.
  await pve1.focus();
  await expect(pv).toHaveAttribute("data-show-preview-for", (await pve1.getAttribute("data-show-item"))!);
  await expect(widget).toContainText("34.6");

  // Nothing on the canvas or in the draft changed while previewing.
  expect(await canvasNode(page, stat).innerText()).toBe(canvasBefore);
  expect((await draft(id)).rev, "previewing writes nothing").toBe(revBefore);

  // Use commits the previewed read.
  await pv.locator("[data-show-use]").click();
  await expect(picker(page)).toHaveCount(0);
  await expect(canvasNode(page, stat)).toContainText("34.6");
  const d = await untilDraft(id, (x) => !!nodeIn(x, stat)?.props.data);
  expect(nodeIn(d, stat)!.props.data).toEqual({ $bind: `{{ ${d.doc.dataSources[0]!.name} }}` });
  expect(d.doc.dataSources[0]!.params).toMatchObject({});
  note("f2-preview", { canvasBefore, revBefore, revAfter: d.rev });
  await ctx.close();
});

test("F2 criterion 10: a zero, an empty read, an error with its reason and a 10 minute old value each carry a marker in words and shape", async ({ browser }) => {
  const slug = `d-mark-${RUN}`;
  const id = await newApp(slug);
  lab!.setBroken(true);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const stat = await insert(page, "stat");
  await expect(picker(page)).toBeVisible();
  await page.keyboard.type(LAB);
  const want: Record<string, RegExp> = { zero: /^Zero/, empty: /^Empty/, flaky: /^Error: .*FAKE lab: the query engine is down/, old: /^Stale · 10 min old/ };
  const kinds: Record<string, string> = { zero: "zero", empty: "empty", flaky: "error", old: "stale" };
  const seen: Record<string, string> = {};
  for (const [read, words] of Object.entries(want)) {
    const row = labRead(page, read);
    await expect(row, `the ${read} read is listed`).toBeVisible({ timeout: 8000 });
    const mark = row.locator("[data-show-marker]");
    // The picker checks the first 20 rows and the rows in view; after the whole suite other specs' Lab reads
    // come first, so scroll to the row the way the operator would.
    await row.scrollIntoViewIfNeeded();
    await expect(mark).toHaveAttribute("data-show-marker", kinds[read]!, { timeout: 8000 });
    await expect(mark).toHaveText(words);
    await expect(mark.locator("svg[data-show-marker-shape]")).toHaveCount(1);
    seen[read] = (await mark.innerText()).trim();
    await row.hover();
    const pv = page.locator("[data-show-preview]");
    await expect(pv).toHaveAttribute("data-show-preview-for", (await row.getAttribute("data-show-item"))!);
    await expect(pv.locator("[data-show-marker]")).toHaveAttribute("data-show-marker", kinds[read]!);
    await page.screenshot({ path: out(`f2-marker-${kinds[read]}.png`) });
  }
  // The four shapes differ (a marker is told apart by its shape, not its colour alone).
  const shapes = await page.locator("[data-show-list] [data-show-marker] svg[data-show-marker-shape]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-show-marker-shape")))]);
  expect(shapes.sort()).toEqual(["empty", "error", "stale", "zero"]);
  // A healthy read carries no marker.
  await page.locator("[data-show-search]").fill(CPU);
  await expect(item(page, promId, "machine-cpu", ACE).locator("[data-show-value]")).toHaveAttribute("data-show-value", "yes", { timeout: 5000 });
  await expect(item(page, promId, "machine-cpu", ACE).locator("[data-show-marker]")).toHaveCount(0);
  expect(nodeIn(await draft(id), stat)?.props.data, "nothing was bound").toBeUndefined();
  note("f2-markers", seen);
  lab!.setBroken(false);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
// F5 Off (A11.8)
// ---------------------------------------------------------------------------------------------------

test("F5 criterion 13: Refresh Off says the value loads with the page; the viewer reads it once per page load and never again until reload", async ({ browser }) => {
  const slug = `d-off-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const stat = await insert(page, "stat");
  await page.keyboard.type(CPU);
  const pve2 = item(page, promId, "machine-cpu", PVE2);
  await expect(pve2).toBeVisible({ timeout: 5000 });
  await pve2.click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator("[data-data-top] [data-refresh-change]")).toBeVisible();
  await page.locator("[data-data-top] [data-refresh-change]").click();
  const off = page.locator('[data-refresh-option="0"]');
  await expect(off).toBeVisible();
  await expect(off).toBeEnabled();
  await expect(off).toContainText("Off");
  await page.screenshot({ path: out("f5-refresh-menu-off.png") });
  await off.click();
  await expect(page.locator("[data-data-top] [data-refresh-change]")).toHaveText("Off");
  await expect(page.locator("[data-data-top] [data-refresh-off]")).toHaveText("Loads with the page, and again only when the page is reloaded.");
  const d = await untilDraft(id, (x) => nodeIn(x, stat)?.refreshSec === 0);
  expect(nodeIn(d, stat)!.refreshSec, "ops accept 0").toBe(0);
  expect(d.doc.dataSources[0]!.refreshSec, "a source every binder of which is Off is read once per page open").toBe(0);
  await page.screenshot({ path: out("f5-off-line.png") });
  await publish(id);
  await ctx.close();

  // Let any value the builder read age past the read's minimum, so the page open reads afresh.
  const builderHits: number[] = [];
  for (let i = 0; i < 32; i++) { await new Promise((r) => setTimeout(r, 1000)); builderHits.push(cpuHits(PVE2)); }
  const viewer = await (await contextFor(browser, OWNER, { variant: LIGHT })).newPage();
  const h0 = cpuHits(PVE2);
  await viewer.goto(`/a/${slug}`);
  await expect(viewer.locator(`[data-node="${stat}"]`)).toContainText("18.2", { timeout: 10_000 });
  const timeline: number[] = [];
  for (let i = 0; i < 40; i++) { await viewer.waitForTimeout(1000); timeline.push(cpuHits(PVE2) - h0); }
  const firstLoad = cpuHits(PVE2) - h0;
  await viewer.screenshot({ path: out("f5-viewer-off.png") });
  // A reload is a new page open: one more read.
  await new Promise((r) => setTimeout(r, 12_000));
  const h1 = cpuHits(PVE2);
  await viewer.reload();
  await expect(viewer.locator(`[data-node="${stat}"]`)).toContainText("18.2", { timeout: 10_000 });
  await viewer.waitForTimeout(15_000);
  const secondLoad = cpuHits(PVE2) - h1;
  note("f5-off-reads", { firstLoad, secondLoad, watchedSec: [40, 15], timeline, beforeOpen: builderHits });
  expect(firstLoad, "one read on page open, none in the next 40 s").toBe(1);
  expect(secondLoad, "a reload reads once more").toBe(1);
  await viewer.context().close();
});

// ---------------------------------------------------------------------------------------------------
// F4: the builder's inspector settings
// ---------------------------------------------------------------------------------------------------

test("F4 criterion 12: the builder's folds are titled with what they hold, every builder setting has a hint or a reason, the Data line is not repeated, and each setting changes the canvas or says why", async ({ browser }) => {
  const slug = `d-insp-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const stat = await insert(page, "stat");
  await page.keyboard.type(CPU);
  await item(page, promId, "machine-cpu", ACE).click();
  await expect(picker(page)).toHaveCount(0);
  const insp = page.locator(`[data-inspector="${stat}"]`);
  await expect(insp.locator("[data-data-top] [data-data-line]")).toBeVisible();
  await expect(canvasNode(page, stat)).toContainText("7.8");

  // The Data group does not repeat the Data line as a "Shows all of ..." sentence.
  const dataGroup = insp.locator('[data-inspector-group="data"]');
  if ((await dataGroup.getAttribute("data-open")) === null) await dataGroup.locator("h3 > button").first().click();
  await expect(insp.locator("[data-data-sentence-text]").filter({ hasText: /^Shows all of/ }).filter({ visible: true })).toHaveCount(0);
  for (const t of await insp.locator("[data-data-sentence-text]").filter({ visible: true }).allInnerTexts()) expect(t).not.toMatch(/^Shows all of/);
  await expect(dataGroup).toBeVisible();

  // Open Layout: its fold says what it holds.
  const layout = insp.locator('[data-inspector-group="layout"]');
  await layout.locator("summary").click();
  await expect(insp.getByText("More settings", { exact: true })).toHaveCount(0);
  await expect(layout.locator("[data-more-settings-toggle] [data-fold-title]")).toHaveText("More: left, top, width, height");
  await layout.locator("[data-more-settings-toggle]").click();
  const titleGroup = insp.locator('[data-inspector-group="title"]');
  await titleGroup.locator("summary").click();

  // Every builder setting has a plain label and a one-line hint, or a reason in its place.
  const settings = insp.locator("[data-builder-setting]");
  const keys = await settings.evaluateAll((els) => els.map((e) => e.getAttribute("data-builder-setting")));
  for (const k of ["refresh", "fit", "width-preset", "left", "top", "width", "height", "title", "show-title"]) expect(keys, `setting ${k}`).toContain(k);
  for (const k of keys) {
    const s = insp.locator(`[data-builder-setting="${k}"]`).first();
    await expect(s.locator("[data-field-label]").first(), `${k} has a label`).toBeVisible();
    await expect(s.locator("[data-field-hint], [data-field-reason]").first(), `${k} has a hint or a reason`).toBeVisible();
  }
  await page.screenshot({ path: out("f4-inspector-layout-title.png") });

  // Scripted pass: each change shows on the canvas, or the setting says why it cannot show now.
  const changed: Record<string, string> = {};
  const shotOf = async () => (await page.locator("[data-canvas-root]").screenshot()).toString("base64");
  const field = (k: string) => insp.locator(`[data-layout-field="${k}"]`);
  const setField = async (k: string, v: string) => { await field(k).fill(v); await field(k).press("Enter"); };
  for (const [k, v] of [["x", "2"], ["y", "40"], ["w", "5"], ["h", "200"]] as const) {
    const before = await shotOf();
    await setField(k, v);
    await expect.poll(shotOf, { message: `changing ${k} changes the canvas` }).not.toBe(before);
    changed[k] = "canvas";
  }
  {
    const before = await shotOf();
    await insp.locator('[data-layout-preset="Full"]').click();
    await expect.poll(shotOf).not.toBe(before);
    changed["width-preset"] = "canvas";
  }
  {
    const before = await shotOf();
    await insp.locator("[data-layout-fit]").click();
    // Fit changes the box, or says in words why nothing changed ("It already shows all its content").
    await expect.poll(async () => (await shotOf()) !== before || (await insp.locator("[data-layout-fit-note]").isVisible())).toBe(true);
    changed.fit = (await shotOf()) !== before ? "canvas" : `note: ${await insp.locator("[data-layout-fit-note]").innerText()}`;
  }
  {
    const before = await shotOf();
    await insp.locator("[data-node-title]").fill("Lab CPU");
    await insp.locator("[data-node-title]").press("Enter");
    await expect.poll(shotOf).not.toBe(before);
    changed.title = "canvas";
  }
  {
    const before = await shotOf();
    await insp.locator('[data-node-show-title] [role="checkbox"], [data-node-show-title] button, [data-node-show-title]').first().click();
    await expect.poll(shotOf).not.toBe(before);
    changed["show-title"] = "canvas";
    // With the title bar off, Title says why it does not show, in place of its hint.
    await expect(insp.locator('[data-builder-setting="title"] [data-field-reason]')).toHaveText("Needs Show title bar on");
    changed.title += ", reason with the bar off";
  }
  // Refresh changes when the value is read, not how the canvas looks: its hint says so.
  await expect(insp.locator('[data-builder-setting="refresh"] [data-field-hint]')).toHaveText("How often the value is read again. The canvas shows each new value as it arrives.");
  changed.refresh = "hint";
  note("f4-scripted-pass", changed);

  // The by-hand picker's fold is titled with what it holds too.
  await insp.locator("[data-data-top] [data-data-change]").click();
  await expect(picker(page)).toBeVisible();
  await page.locator("[data-pick-by-hand]").click();
  // A managed source opens by hand on the service list; the fold shows once a read is chosen.
  await page.locator(`[data-pick-integration="${promId}"]`).click();
  await page.locator('[data-pick-endpoint="machine-cpu"]').click();
  await expect(page.locator("[data-pick-more-settings-toggle]")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("[data-pick-more-settings-toggle]")).not.toContainText("More settings");
  await expect(page.locator("[data-pick-more-settings-toggle]")).toContainText(/^More: /);
  await page.screenshot({ path: out("f4-by-hand-fold.png") });
  void id;
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
// F10: samples for data fields
// ---------------------------------------------------------------------------------------------------

test("F10 criterion 17 (data fields): By measure and Show it as choices each show a small drawn sample", async ({ browser }) => {
  const slug = `d-samp-${RUN}`;
  await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  await insert(page, "stat");
  await expect(picker(page)).toBeVisible();
  await page.locator('[data-show-browse="measure"]').click();
  const measures = page.locator("[data-show-measure]");
  await expect(measures.first()).toBeVisible();
  const n = await measures.count();
  expect(n).toBeGreaterThanOrEqual(8);
  for (let i = 0; i < n; i++) await expect(measures.nth(i).locator("svg[data-sample]")).toHaveCount(1);
  await page.screenshot({ path: out("f10-measures.png") });
  // A read that does not fit a stat offers other widgets, each drawn as a small sample.
  await page.locator("[data-show-search]").fill(LAB);
  const old = labRead(page, "old");
  await expect(old).toBeVisible({ timeout: 8000 });
  await old.click();
  const choices = page.locator("[data-show-switch-to]");
  await expect(choices.first()).toBeVisible();
  for (let i = 0; i < (await choices.count()); i++) await expect(choices.nth(i).locator("svg[data-sample]")).toHaveCount(1);
  await page.screenshot({ path: out("f10-switch-offer.png") });
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
// V4, V5, V8: the preview in the four test themes, at 390x844, with reduced motion
// ---------------------------------------------------------------------------------------------------

test("V4 V5 V8: the preview draws in Control Room, Dusk, Solid and the frosted theme, at 390x844 and with reduced motion", async ({ browser }) => {
  test.setTimeout(600_000);
  const c = await owner();
  const frosted = await frostedTheme(c);
  const shots: string[] = [];
  for (const theme of ["control-room", "dusk", "solid", frosted]) {
    const name = theme === frosted ? "frosted" : theme;
    const slug = `d-th-${name.slice(0, 6)}-${RUN}`;
    await newApp(slug, theme);
    const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await openBuilder(page, slug);
    await insert(page, "stat");
    await page.keyboard.type(CPU);
    const ace = item(page, promId, "machine-cpu", ACE);
    await expect(ace).toBeVisible({ timeout: 8000 });
    await ace.scrollIntoViewIfNeeded();
    await expect(ace.locator("[data-show-value]")).toHaveAttribute("data-show-value", "yes", { timeout: 8000 });
    await ace.hover();
    await expect(page.locator("[data-show-preview-widget] [data-type='stat']")).toContainText("7.8");
    // The preview uses the app's own theme.
    await expect(page.locator("[data-show-preview-widget] [data-atrium-canvas]")).toBeVisible();
    const f = out(`v4-preview-${name}.png`);
    await page.screenshot({ path: f });
    shots.push(f);
    await ctx.close();
  }
  // V5: a phone. The phone builder has no Insert, so the stat is added and bound at desktop width, then
  // changed on the phone the way the operator would: tap it, Edit, Change on the data line. The preview
  // stacks above the list; hovering is replaced by focus.
  {
    const slug = `d-ph-${RUN}`;
    await newApp(slug);
    const desk = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
    const dp = await desk.newPage();
    await openBuilder(dp, slug);
    const stat = await insert(dp, "stat");
    await dp.keyboard.type(CPU);
    const deskAce = item(dp, promId, "machine-cpu", ACE);
    await expect(deskAce).toBeVisible({ timeout: 8000 });
    await deskAce.click();
    await expect(picker(dp)).toHaveCount(0);
    await expect(canvasNode(dp, stat)).toContainText("7.8");
    await desk.close();

    const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 390, height: 844 }, mobile: true });
    const page = await ctx.newPage();
    await openBuilder(page, slug);
    await canvasNode(page, stat).tap();
    await page.locator('[data-narrow-tab="edit"]').tap();
    await page.locator("[data-data-top] [data-data-change]").tap();
    await expect(picker(page)).toBeVisible();
    await page.locator("[data-show-search]").fill(CPU);
    const pve1 = item(page, promId, "machine-cpu", PVE1);
    await expect(pve1).toBeVisible({ timeout: 8000 });
    await pve1.scrollIntoViewIfNeeded();
    await expect(pve1.locator("[data-show-value]")).toHaveAttribute("data-show-value", "yes", { timeout: 8000 });
    await pve1.focus();
    await expect(page.locator("[data-show-preview-widget] [data-type='stat']")).toContainText("34.6");
    const box = (await page.locator("[data-show-preview]").boundingBox())!;
    expect(box.width, "the preview fits a phone").toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: out("v5-preview-390.png") });
    shots.push(out("v5-preview-390.png"));
    await ctx.close();
  }
  // V8: reduced motion. The preview has no motion of its own; it draws at once.
  {
    const slug = `d-rm-${RUN}`;
    await newApp(slug);
    const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await openBuilder(page, slug);
    await insert(page, "stat");
    await page.keyboard.type(CPU);
    const ace = item(page, promId, "machine-cpu", ACE);
    await expect(ace).toBeVisible({ timeout: 8000 });
    await ace.scrollIntoViewIfNeeded();
    await expect(ace.locator("[data-show-value]")).toHaveAttribute("data-show-value", "yes", { timeout: 8000 });
    await ace.hover();
    await expect(page.locator("[data-show-preview-widget] [data-type='stat']")).toContainText("7.8");
    await page.screenshot({ path: out("v8-preview-reduced.png") });
    shots.push(out("v8-preview-reduced.png"));
    await ctx.close();
  }
  note("v-shots", shots);
});
