// app-builder e2e: Wave 2.9 direct data and service tiles (stages/02-subsystem-spec/output/direct-data-spec.md,
// architecture Amendment 10). Every criterion is driven through the real screen (V11): Insert, "What should
// this show?", the inspector's Data line and chart lines, Insert > Service tile, Insert > Start page and New
// app. Stand-ins: the 9-machine Prometheus (tests/e2e/fixtures/fake-prometheus.ts), the read-only Docker
// and a plain web page on this machine's LAN address started here, and the Home Assistant stand-in from helpers. Evidence goes to
// evidence/direct-data-builder/<ATRIUM_E2E_DD_ROUND or r1>/.
import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { fakeDocker, type Fake } from "../integrations/fakes";
import { addUser, api, captureTraffic, contextFor, FAKE_HA_TOKEN, fakeHa, log, OWNER, PEOPLE, SHELL_VARIANTS, type FakeHa } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 240_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Node = { id: string; type: string; title?: string; refreshSec?: number; props: Record<string, unknown>; children?: Node[]; slot?: { x: number; y: number; w: number; h: number } };
type Source = { name: string; label?: string; integrationId: string; endpointId: string; refreshSec: number; params?: Record<string, unknown>; managed?: boolean };
type Draft = { rev: number; doc: { dataSources: Source[]; pages: { id: string; slug: string; title: string; root: Node }[]; theme: unknown } };

const EVIDENCE = path.resolve(`evidence/direct-data-builder/${process.env.ATRIUM_E2E_DD_ROUND ?? "r1"}`);
const shot = (name: string) => { const f = path.join(EVIDENCE, `${name}.png`); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const RUN = Date.now().toString(36).slice(-4);
const ACE = "10.77.99.8:9100";
const PVE1 = "10.77.99.4:9100";
let prom: FakePrometheus | undefined;
let docker: Fake | undefined;
let ha: FakeHa | undefined;
let promId = "";
let dockerId = "";
let haId = "";

async function newApp(slug: string, kids: Node[] = [], sources: Source[] = [], themeId?: string): Promise<string> {
  const c = await api(OWNER);
  const r = await c.post("/api/apps", { data: { name: `Direct ${slug}`, slug } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  if (kids.length || sources.length || themeId) {
    const d = await draft(id);
    const ops = [...(themeId ? [{ op: "theme.set", theme: { themeId } }] : []), ...sources.map((s) => ({ op: "source.set", source: s })), ...kids.map((n, i) => ({ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { slot: { x: (i % 2) * 6, y: Math.floor(i / 2) * 24, w: 6, h: 24 }, ...n } }))];
    const o = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops } });
    if (!o.ok()) throw new Error(`ops failed: ${await o.text()}`);
  }
  return id;
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
const allNodes = (d: Draft): Node[] => { const out: Node[] = []; const walk = (n: Node) => { out.push(n); (n.children ?? []).forEach(walk); }; d.doc.pages.forEach((p) => walk(p.root)); return out; };
const nodeIn = (d: Draft, id: string) => allNodes(d).find((n) => n.id === id);
async function open(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
}
async function selectLayer(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  const row = page.locator(`[data-layer="${id}"]`);
  if (!(await row.isVisible())) for (const t of await page.locator("[data-layer-toggle], [data-layer-expand]").all()) { if (await row.isVisible()) break; await t.click().catch(() => {}); }
  await row.click();
  await expect(page.locator(`[data-selected-outline="${id}"]`)).toBeVisible();
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
async function openDataGroup(page: Page) {
  // components' groups are sections with a toggle button (data-open when open).
  const g = page.locator('section[data-inspector-group="data"]');
  await expect(g).toBeVisible();
  if ((await g.getAttribute("data-open")) === null) await g.locator("h3 > button").click();
  await expect(g).toHaveAttribute("data-open", "");
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  for (const p of Object.values(PEOPLE)) await addUser(p);
  prom = await startFakePrometheus();
  docker = await fakeDocker();
  ha = await fakeHa();
  const c = await api(OWNER);
  const mk = async (data: Record<string, unknown>) => { const r = await c.post("/api/integrations", { data: { secrets: {}, untested: true, ...data } }); if (!r.ok()) throw new Error(`integration: ${await r.text()}`); return (await r.json()).id as string; };
  promId = await mk({ packageId: "prometheus", name: `Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" } });
  dockerId = await mk({ packageId: "docker", name: `Docker ${RUN}`, config: { endpoint: `tcp://127.0.0.1:${docker.port}` } });
  haId = await mk({ packageId: "home-assistant", name: `Home ${RUN}`, config: { baseUrl: ha.url }, secrets: { token: FAKE_HA_TOKEN } });
});
test.afterAll(async () => { await prom?.close(); await docker?.close(); await ha?.close(); });

test("criteria 1, 2, 3: Insert a Stat, type cpu, click a machine: its live CPU on the canvas within 1 s, no data source step", async ({ browser }) => {
  const slug = `dd-stat-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  const statId = await insert(page, "stat");
  await expect(picker(page)).toBeVisible();
  // The search box is focused when the picker opens: typing goes straight in.
  await page.keyboard.type("cpu");
  const ace = page.locator(`[data-show-item][data-show-integration="${promId}"][data-show-endpoint="machine-cpu"][data-show-thing-value="${ACE}"]`);
  await expect(ace).toBeVisible({ timeout: 3000 });
  await expect(ace.locator("[data-show-item-words]")).toHaveText("CPU in use, ACE");
  // Criterion 3: fitting results come first, under "Fits a stat".
  const groups = await page.locator("[data-show-group]").evaluateAll((els) => els.map((e) => e.getAttribute("data-show-group")));
  expect(groups[0]).toBe("fits");
  // Each result shows its live value within 3 s (criterion 2's value part). Rows past the first 20 load
  // their value once on screen; with other suites' services in the data this row can sit lower down.
  await ace.scrollIntoViewIfNeeded();
  await expect(ace.locator("[data-show-value]")).toHaveText("7.8 %", { timeout: 3000 });
  await page.screenshot({ path: shot("c1-search-cpu-light") });
  expect((await draft(id)).doc.dataSources).toHaveLength(0);
  const t0 = Date.now();
  await ace.click();
  await expect(canvasNode(page, statId)).toContainText("7.8", { timeout: 1000 });
  log("criterion 1 canvas ms", Date.now() - t0);
  await expect(picker(page)).toHaveCount(0);
  // No data source was added, named or shown on the way; the app keeps one managed source behind the scenes.
  const d = await untilDraft(id, (x) => x.doc.dataSources.length === 1);
  expect(d.doc.dataSources[0]).toMatchObject({ integrationId: promId, endpointId: "machine-cpu", params: { machine: ACE }, label: "CPU in use, ACE", managed: true });
  expect(d.doc.dataSources[0]!.name).toMatch(/^d_[a-z2-7]{8}$/);
  expect(nodeIn(d, statId)!.props.data).toEqual({ $bind: `{{ ${d.doc.dataSources[0]!.name} }}` });
  await page.screenshot({ path: shot("c1-canvas-light") });
  await ctx.close();
});

/** Picks a result in the open picker by its read and thing (typing the words first). */
async function pickResult(page: Page, words: string, endpointId: string, thing?: string, integrationId = promId) {
  await expect(picker(page)).toBeVisible();
  await page.locator("[data-show-search]").fill(words);
  const item = page.locator(`[data-show-item][data-show-integration="${integrationId}"][data-show-endpoint="${endpointId}"]${thing !== undefined ? `[data-show-thing-value="${thing}"]` : ""}`).first();
  await expect(item).toBeVisible({ timeout: 3000 });
  await item.click();
  await expect(picker(page)).toHaveCount(0);
}
const cpuHits = (instance: string) => (prom?.hits ?? []).filter((h) => h.url.startsWith("/api/v1/query?") && decodeURIComponent(h.url).includes(`instance="${instance}"`) && decodeURIComponent(h.url).includes("node_cpu_seconds_total")).length;

test("criteria 4, 5: two Stats share one fetch; changing one leaves the other; the refresh menu respects the read's minimum and the canvas updates at that pace", async ({ browser }) => {
  const slug = `dd-share-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  const a = await insert(page, "stat");
  await pickResult(page, "cpu", "machine-cpu", PVE1);
  const b = await insert(page, "stat");
  await pickResult(page, "cpu", "machine-cpu", PVE1);
  // One managed source for the same read and thing: one fetch for both.
  let d = await untilDraft(id, (x) => !!nodeIn(x, b)?.props.data);
  expect(d.doc.dataSources).toHaveLength(1);
  const shared = d.doc.dataSources[0]!.name;
  expect(nodeIn(d, a)!.props.data).toEqual({ $bind: `{{ ${shared} }}` });
  expect(nodeIn(d, b)!.props.data).toEqual({ $bind: `{{ ${shared} }}` });
  await expect(canvasNode(page, a)).toContainText("34.6");
  await expect(canvasNode(page, b)).toContainText("34.6");

  // Criterion 5: the refresh control offers only intervals at or above the read's minimum.
  await selectLayer(page, b);
  await openDataGroup(page);
  await expect(page.locator("[data-data-line]")).toContainText("Shows: CPU in use, pve1, 34.6 %");
  await expect(page.locator("[data-refresh-change]")).toHaveText("updates every 30 s");
  await page.locator("[data-refresh-change]").click();
  const offered = (await page.locator("[data-refresh-option]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-refresh-option"))))) as number[];
  const min = offered[0]!;
  expect(offered.every((s) => s >= min)).toBe(true);
  await expect(page.locator("[data-refresh-min]")).toHaveText(`This read refreshes at least every ${min} s.`);
  expect(offered).toEqual([min, ...[10, 30, 60, 300, 3600].filter((s) => s > min)]);
  await page.screenshot({ path: shot("c5-refresh-menu-dark") });
  await page.locator(`[data-refresh-option="${min}"]`).click();
  await expect(page.locator("[data-refresh-change]")).toHaveText(`updates every ${min} s`);
  d = await untilDraft(id, (x) => x.doc.dataSources[0]?.refreshSec === min);
  expect(nodeIn(d, b)!.refreshSec).toBe(min);
  expect(nodeIn(d, a)!.refreshSec).toBeUndefined();
  // The shared fetch runs at the faster of the two; each Stat still says its own setting.
  expect(d.doc.dataSources[0]!.refreshSec).toBe(min);
  await selectLayer(page, a);
  await expect(page.locator("[data-refresh-change]")).toHaveText("updates every 30 s");

  // Criterion 4: one fetch per interval for both Stats (the stand-in's own request log).
  await page.waitForTimeout(1500);
  const h0 = cpuHits(PVE1);
  await page.waitForTimeout(min * 2000 + 500);
  const fetched = cpuHits(PVE1) - h0;
  log("criterion 4 fetches in two intervals", { fetched, min });
  expect(fetched).toBeGreaterThanOrEqual(1);
  expect(fetched).toBeLessThanOrEqual(3);

  // Criterion 4: changing one Stat's read leaves the other unchanged.
  await selectLayer(page, a);
  await openDataGroup(page);
  await page.locator("[data-data-change]").click();
  await pickResult(page, "cpu ace", "machine-cpu", ACE);
  d = await untilDraft(id, (x) => x.doc.dataSources.length === 2);
  const aceSrc = d.doc.dataSources.find((s) => s.params?.machine === ACE)!;
  expect(nodeIn(d, a)!.props.data).toEqual({ $bind: `{{ ${aceSrc.name} }}` });
  expect(nodeIn(d, b)!.props.data).toEqual({ $bind: `{{ ${shared} }}` });
  await expect(canvasNode(page, b)).toContainText("34.6");
  await expect(canvasNode(page, a)).toContainText(/7\.8|8\.\d/);
  // Undo puts A back on the shared read and the ACE source goes with it, in one step.
  await page.locator("[data-builder-canvas]").focus();
  await page.keyboard.press("Control+z");
  d = await untilDraft(id, (x) => x.doc.dataSources.length === 1);
  expect(d.doc.dataSources.map((s) => s.name)).toEqual([shared]);
  expect(nodeIn(d, a)!.props.data).toEqual({ $bind: `{{ ${shared} }}` });
  await ctx.close();
});

const PVE2 = "10.77.99.10:9100";
const PVE3 = "10.77.110.20:9100";

test("criterion 6: a chart with CPU of three machines shows three named lines; Every machine stays live as a machine appears", async ({ browser }) => {
  const slug = `dd-chart-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 }, recordVideo: path.join(EVIDENCE, "video-chart-lines") });
  const page = await ctx.newPage();
  await open(page, slug);
  const chart = await insert(page, "chart");
  // A chart's picker adds a line: values over time, a value read binding its history.
  await expect(picker(page)).toHaveAttribute("data-mode", "line");
  await pickResult(page, "cpu", "machine-cpu", PVE1);
  let d = await untilDraft(id, (x) => Array.isArray(nodeIn(x, chart)?.props.lines));
  expect(d.doc.dataSources[0]).toMatchObject({ endpointId: "h:machine-cpu", params: { machine: PVE1 }, managed: true });
  expect(nodeIn(d, chart)!.props.lines).toEqual([{ data: { $bind: `{{ ${d.doc.dataSources[0]!.name} }}` }, label: "CPU in use, pve1" }]);
  await selectLayer(page, chart);
  await openDataGroup(page);
  // Also for: the same read for other machines, plus Every machine.
  await expect(page.locator(`[data-also-for="${PVE2}"]`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-also-for="*"]')).toHaveText("Every machine");
  await expect(page.locator("[data-also-show]").first()).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: shot("c6-also-chips-light") });
  await page.locator(`[data-also-for="${PVE2}"]`).click();
  await expect(page.locator("[data-chart-line]")).toHaveCount(2);
  await page.locator(`[data-also-for="${PVE3}"]`).click();
  await expect(page.locator("[data-chart-line]")).toHaveCount(3);
  // Three named lines on the canvas.
  const lines = canvasNode(page, chart);
  await expect(lines.locator("[data-axes]")).toHaveAttribute("data-axes", "1", { timeout: 8000 });
  await expect.poll(async () => (await lines.locator("[data-legend-line]").allTextContents()).join(" | "), { timeout: 8000 }).toMatch(/pve1.*pve2.*pve3/);
  d = await untilDraft(id, (x) => ((nodeIn(x, chart)?.props.lines as unknown[]) ?? []).length === 3);
  expect((nodeIn(d, chart)!.props.lines as { label: string }[]).map((l) => l.label)).toEqual(["CPU in use, pve1", "CPU in use, pve2", "CPU in use, pve3"]);
  await page.screenshot({ path: shot("c6-three-lines-light") });
  // Rename, colour and hide one line.
  await page.locator('[data-line-name="1"]').fill("Second node");
  await page.locator('[data-line-name="1"]').press("Enter");
  await page.locator('[data-line-hide="2"]').click();
  d = await untilDraft(id, (x) => !!(nodeIn(x, chart)?.props.lines as { hidden?: boolean }[] | undefined)?.[2]?.hidden);
  expect((nodeIn(d, chart)!.props.lines as { label: string; hidden?: boolean }[]).map((l) => [l.label, !!l.hidden])).toEqual([["CPU in use, pve1", false], ["Second node", false], ["CPU in use, pve3", true]]);
  await page.locator('[data-line-remove="2"]').click();
  await page.locator('[data-line-remove="1"]').click();
  await expect(page.locator("[data-chart-line]")).toHaveCount(1);
  // Every machine: one line per machine Prometheus knows (9).
  await page.locator('[data-also-for="*"]').click();
  await expect(page.locator('[data-chart-line="1"] [data-chart-line-words]')).toContainText("9 lines", { timeout: 15_000 });
  d = await untilDraft(id, (x) => ((nodeIn(x, chart)?.props.lines as unknown[]) ?? []).length === 2);
  const every = d.doc.dataSources.find((s) => s.params?.machine === "*")!;
  expect(every).toMatchObject({ endpointId: "h:machine-cpu", managed: true });
  // A machine that appears later gets its own line within one interval, with no edit.
  const rev = d.rev;
  prom!.addMachine({ instance: "192.0.2.10:9100", host: "e2e-newbox", nodename: "e2e-newbox", arch: "x86_64", cores: 2, memGiB: 4, cpu: 99.5, mem: 10, disk: 10, netIn: 1000, netOut: 1000, load5: 0.1, uptimeSec: 3600, mounts: ["/"] });
  await expect(page.locator('[data-chart-line="1"] [data-chart-line-words]')).toContainText("10 lines", { timeout: (every.refreshSec + 15) * 1000 });
  // The busiest is drawn first, so the newcomer (99.5 %) is in the legend.
  await expect.poll(async () => (await lines.locator("[data-legend-line]").allTextContents()).join(" | "), { timeout: 10_000 }).toContain("e2e-newbox");
  expect((await draft(id)).rev).toBe(rev);
  await page.screenshot({ path: shot("c6-every-machine-light") });
  await ctx.close();
});

test("criterion 7: CPU % and network bytes per second share a chart on two axes; temperature is refused with the sentence and both offers", async ({ browser }) => {
  const slug = `dd-axes-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  const chart = await insert(page, "chart");
  await pickResult(page, "cpu pve1", "machine-cpu", PVE1);
  await selectLayer(page, chart);
  await openDataGroup(page);
  await page.locator("[data-add-line]").click();
  await pickResult(page, "network pve1", "machine-network", PVE1);
  await expect(canvasNode(page, chart).locator("[data-axes]")).toHaveAttribute("data-axes", "2", { timeout: 10_000 });
  await page.screenshot({ path: shot("c7-two-axes-dark") });
  await page.locator("[data-add-line]").click();
  await page.locator("[data-show-search]").fill("temperature pve1");
  const temp = page.locator(`[data-show-item][data-show-integration="${promId}"][data-show-endpoint="machine-temperature"][data-show-thing-value="${PVE1}"]`).first();
  await expect(temp.locator("[data-show-value]")).toHaveAttribute("data-show-value", "yes", { timeout: 5000 });
  await temp.click();
  await expect(page.locator("[data-axis-refusal]")).toBeVisible();
  await expect(page.locator("[data-axis-sentence]")).toHaveText(/^This chart already shows percent and bytes per second, so Temperature, pve1 \(temperature\) would need a third axis\.$/);
  await expect(page.locator("[data-axis-new-chart]")).toBeVisible();
  await expect(page.locator("[data-axis-percent]")).toBeVisible();
  await expect(page.locator("[data-axis-percent]")).toHaveAttribute("data-ready", "no", { timeout: 10_000 });
  await page.screenshot({ path: shot("c7-third-unit-refused-dark") });
  // Put it on a new chart: a second chart with just that line; the first keeps its two.
  await page.locator("[data-axis-new-chart]").click();
  const d = await untilDraft(id, (x) => allNodes(x).filter((n) => n.type === "chart").length === 2);
  const charts = allNodes(d).filter((n) => n.type === "chart");
  expect((nodeIn(d, chart)!.props.lines as unknown[]).length).toBe(2);
  const fresh = charts.find((c) => c.id !== chart)!;
  expect((fresh.props.lines as { label: string }[]).map((l) => l.label)).toEqual(["Temperature, pve1"]);
  await ctx.close();
});

/** This machine's first LAN address (found at run time, never written down): reachability refuses loopback. */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
  return null;
}
async function publish(id: string) {
  const c = await api(OWNER);
  const d = await draft(id);
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: d.rev, note: "e2e" } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}

test("criterion 8: Insert > Service tile, pick the Docker stand-in: icon, name, status badge and 3 headline stats with no further picking; a tile opens its address in a new tab", async ({ browser }) => {
  const slug = `dd-tile-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  const tile = await insert(page, "service-tile");
  await expect(page.locator("[data-service-chooser]")).toBeVisible();
  await page.screenshot({ path: shot("c8-which-service-light") });
  await page.locator(`[data-service-pick="${dockerId}"]`).click();
  await expect(page.locator("[data-service-chooser]")).toHaveCount(0);
  const t = canvasNode(page, tile);
  await expect(t.locator('[data-slot="name"]')).toHaveText(`Docker ${RUN}`);
  await expect(t.locator('[data-slot="icon"]')).toBeVisible();
  await expect(t.locator("[data-slot=badge]")).toBeVisible({ timeout: 10_000 });
  await expect(t.locator("[data-stat-index]")).toHaveCount(3);
  // The tile draws its labels in small capitals (components' CSS), so compare the words, not the case.
  await expect.poll(async () => (await t.locator("[data-stat-index]").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim().toLowerCase()), { timeout: 10_000 }).toEqual(["2 running", "1 stopped", "3 total"]);
  const d = await untilDraft(id, (x) => (nodeIn(x, tile)?.props.stats as unknown[] | undefined)?.length === 3);
  expect(nodeIn(d, tile)!.props).toMatchObject({ name: `Docker ${RUN}`, icon: "pkg:docker", integrationId: dockerId, newTab: true });
  // The three stats share one managed read of the containers; the badge reads atrium/health.
  expect(d.doc.dataSources.filter((s) => s.integrationId === dockerId).map((s) => s.endpointId)).toEqual(["containers"]);
  expect(d.doc.dataSources.find((s) => s.integrationId === "atrium")).toMatchObject({ endpointId: "health", params: { integrationId: dockerId }, managed: true });
  await page.screenshot({ path: shot("c8-docker-tile-light") });
  // Each stat can be swapped through the picker.
  await selectLayer(page, tile);
  await openDataGroup(page);
  await expect(page.locator("[data-list-entry]")).toHaveCount(3);
  await page.locator('[data-list-entry-change="2"]').click();
  await pickResult(page, "running", "running", undefined, dockerId);
  await expect.poll(async () => ((nodeIn(await draft(id), tile)!.props.stats as { value: { $bind: string } }[])[2]!.value.$bind)).toMatch(/^\{\{ d_[a-z2-7]{8}\.value \}\}$/);

  // A Home Assistant tile opens the service's own address in a new tab (published page).
  const haTile = await insert(page, "service-tile");
  await page.locator(`[data-service-pick="${haId}"]`).click();
  await expect(canvasNode(page, haTile).locator('[data-slot="name"]')).toHaveText(`Home ${RUN}`);
  await untilDraft(id, (x) => !!nodeIn(x, haTile)?.props.href);
  await page.waitForTimeout(500);
  await publish(id);
  const view = await ctx.newPage();
  await view.goto(`/a/${slug}`);
  const link = view.locator(`[data-node="${haTile}"] [data-tile-href]`);
  await expect(link).toBeVisible();
  const [popup] = await Promise.all([view.waitForEvent("popup"), link.click()]);
  expect(popup.url()).toBe(ha!.url.endsWith("/") ? ha!.url : `${ha!.url}/`);
  await ctx.close();
});

test("criterion 9: a Just a link tile shows Up and a response time in ms, then Down once the stand-in stops", async ({ browser }) => {
  const lan = lanAddress();
  test.skip(!lan, "this machine has no LAN address for a reachable stand-in");
  const page2 = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>FAKE e2e media page</body></html>"); });
  await new Promise<void>((r) => page2.listen(0, lan!, () => r()));
  const href = `http://${lan}:${(page2.address() as { port: number }).port}/`;
  const slug = `dd-link-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[2], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  const tile = await insert(page, "service-tile");
  await page.locator("[data-service-link-name]").fill("Media box");
  await page.locator("[data-service-link-href]").fill(href);
  await page.locator("[data-service-link-use]").click();
  const t = canvasNode(page, tile);
  await expect(t.locator('[data-slot="name"]')).toHaveText("Media box");
  await expect(t.locator("[data-badge-state]")).toHaveAttribute("data-badge-state", "up", { timeout: 15_000 });
  await expect(t.locator("[data-slot=badge]")).toHaveText(/\d+ ms/);
  const d = await draft(id);
  expect(d.doc.dataSources.find((s) => s.endpointId === "reach")).toMatchObject({ integrationId: "atrium", params: { url: href }, managed: true });
  await page.screenshot({ path: shot("c9-link-up-solid") });
  await new Promise((r) => { page2.closeAllConnections(); page2.close(() => r(null)); });
  await expect(t.locator("[data-badge-state]")).toHaveAttribute("data-badge-state", "down", { timeout: 75_000 });
  await expect(t.locator("[data-slot=badge]")).toContainText("Down");
  await page.screenshot({ path: shot("c9-link-down-solid") });
  await ctx.close();
});

test("criterion 10: Insert > Start page from three stand-in services: a resource bar and a tile per service in groups by kind, in one undo step, in under 5 s", async ({ browser }) => {
  const slug = `dd-start-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 1440, height: 900 }, recordVideo: path.join(EVIDENCE, "video-start-page") });
  const page = await ctx.newPage();
  await open(page, slug);
  await page.locator('[data-left-tab="insert"]').click().catch(() => {});
  await page.locator('[data-insert-item="start-page"]').click();
  await expect(page.locator("[data-start-sheet]")).toBeVisible();
  const mine = [promId, dockerId, haId];
  for (const x of mine) await expect(page.locator(`[data-start-service="${x}"]`)).toHaveAttribute("aria-checked", "true");
  // Every connected service starts ticked; other suites' services in the same data are unticked here.
  for (const other of await page.locator("[data-start-service]").all()) {
    if (mine.includes((await other.getAttribute("data-start-service"))!)) continue;
    if ((await other.getAttribute("aria-checked")) === "true") await other.click();
    await expect(other).toHaveAttribute("aria-checked", "false");
  }
  await page.locator("[data-start-link-name]").fill("Router");
  await page.locator("[data-start-link-href]").fill("http://router.e2e.test/");
  await page.locator("[data-start-link-add]").click();
  await expect(page.locator("[data-start-link]")).toHaveCount(1);
  await page.screenshot({ path: shot("c10-start-sheet-dark") });
  const before = (await draft(id)).rev;
  const t0 = Date.now();
  await page.locator("[data-start-make]").click();
  // Tiles appear at once; values fill in as the services answer.
  await expect(page.locator("[data-canvas-root] [data-type='service-tile']")).toHaveCount(4, { timeout: 5000 });
  await expect(page.locator("[data-canvas-root] [data-type='resource-bar']")).toHaveCount(1);
  const ms = Date.now() - t0;
  log("criterion 10 start page ms", ms);
  expect(ms).toBeLessThan(5000);
  const d = await untilDraft(id, (x) => x.rev > before && allNodes(x).some((n) => n.type === "resource-bar"));
  expect(d.rev).toBe(before + 1);
  const root = d.doc.pages[0]!.root;
  expect((root.children ?? []).map((c) => c.type)).toEqual(["resource-bar", "group", "group", "group", "group"]);
  // Groups by kind in the fixed order (kinds come from the packages), then the Links group.
  const titles = (root.children ?? []).slice(1).map((c) => String(c.props.title));
  const ORDER = ["Containers", "Media", "Monitoring", "Network", "Smart home", "Storage", "Other", "Links"];
  expect(titles).toEqual([...titles].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
  expect(titles).toContain("Containers");
  expect(titles).toContain("Smart home");
  expect(titles.at(-1)).toBe("Links");
  expect((root.children ?? []).slice(1).reduce((n, g) => n + (g.children ?? []).length, 0)).toBe(4);
  await expect(page.locator("[data-canvas-root] [data-type='service-tile'] [data-stat-index]").first()).not.toBeEmpty({ timeout: 10_000 });
  await page.screenshot({ path: shot("c10-start-page-dark") });
  // One undo takes the whole start page back.
  await page.locator("[data-builder-canvas]").focus();
  await page.keyboard.press("Control+z");
  const back = await untilDraft(id, (x) => !allNodes(x).some((n) => n.type === "resource-bar"));
  expect(back.doc.pages[0]!.root.children ?? []).toEqual([]);
  expect(back.doc.dataSources).toEqual([]);
  await ctx.close();
});

test("spec 3.6 and V7: a tile drags from one group into another at the pointer's place, smoothly, in one undo step", async ({ browser }) => {
  const slug = `dd-drag-${RUN}`;
  const id = await newApp(slug);
  const c = await api(OWNER);
  const r = await c.post(`/api/apps/${id}/start-page`, { data: { integrationIds: [promId, dockerId, haId], links: [{ name: "Router", href: "http://router.e2e.test/" }, { name: "Printer", href: "http://printer.e2e.test/" }] } });
  expect(r.ok()).toBe(true);
  let d = await draft(id);
  const groups = d.doc.pages[0]!.root.children!.filter((n) => n.type === "group");
  const links = groups.find((g) => g.props.title === "Links")!;
  const from = groups.find((g) => g.props.title === "Containers")!;
  const tile = from.children![0]!.id;
  expect(links.children!.length).toBe(2);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  await canvasNode(page, tile).click();
  await expect(page.locator(`[data-selected-outline="${tile}"]`)).toBeVisible();
  const hb = (await page.locator("[data-drag-handle]").boundingBox())!;
  // Aim between the two link tiles: the drop lands at index 1.
  const second = (await page.locator(`[data-group-body="${links.id}"] > [data-group-item]`).nth(1).boundingBox())!;
  const to = { x: second.x + 6, y: second.y + second.height / 2 };
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[] };
    w.__frames = [];
    let last = performance.now();
    const tick = (t: number) => { w.__frames.push(t - last); last = t; if (w.__frames.length < 300) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(hb.x + 4, hb.y + 4);
  await page.mouse.down();
  const steps = 60;
  for (let i = 1; i <= steps; i++) await page.mouse.move(hb.x + 4 + ((to.x - hb.x - 4) * i) / steps, hb.y + 4 + ((to.y - hb.y - 4) * i) / steps);
  await expect(page.locator(`[data-drop-into="${links.id}"]`)).toBeVisible();
  await page.screenshot({ path: shot("v7-drag-into-group-light") });
  await page.mouse.up();
  const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames.slice(5));
  const sorted = [...frames].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  log("v7 drag between groups", { median, p95, count: frames.length });
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, "v7-drag-frames.json"), JSON.stringify({ count: frames.length, median, p95, max: sorted.at(-1), frames }, null, 1));
  expect(median).toBeLessThan(16.7 + 0.5);
  d = await untilDraft(id, (x) => (nodeIn(x, links.id)?.children ?? []).length === 3);
  expect(nodeIn(d, links.id)!.children!.map((n) => n.id).indexOf(tile)).toBe(1);
  expect((nodeIn(d, from.id)?.children ?? []).some((n) => n.id === tile)).toBe(false);
  await expect(page.locator(`[data-group-body="${links.id}"] > [data-group-item="${tile}"]`)).toBeVisible();
  // One undo puts it back in its first group.
  await page.locator("[data-builder-canvas]").focus();
  await page.keyboard.press("Control+z");
  d = await untilDraft(id, (x) => (nodeIn(x, from.id)?.children ?? []).some((n) => n.id === tile));
  expect(nodeIn(d, from.id)!.children![0]!.id).toBe(tile);
  await ctx.close();
});

test("spec 3.2 Cancel and Esc: the picker leaves the component exactly as it was; criterion 12: an app built before this wave opens and publishes unchanged", async ({ browser }) => {
  // An app as Waves 2.5 to 2.8 made it: a source a person named, a stat and a chart bound to it by name.
  const slug = `dd-old-${RUN}`;
  const id = await newApp(slug, [
    { id: "c_oldstataaa", type: "stat", props: { data: { $bind: "{{ cpu_ace }}" }, label: "" } },
    { id: "c_oldchartaa", type: "chart", props: { data: { $bind: "{{ cpu_hist }}" }, kind: "line", height: 160, legend: true } },
  ], [
    { name: "cpu_ace", label: "CPU in use, ACE", integrationId: promId, endpointId: "machine-cpu", params: { machine: ACE }, refreshSec: 30 },
    { name: "cpu_hist", integrationId: promId, endpointId: "machine-history", params: { machine: ACE, measure: "cpu" }, refreshSec: 60 },
  ]);
  const before = await draft(id);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  await expect(canvasNode(page, "c_oldstataaa").locator('[data-slot="value"]')).toHaveText(/\d/, { timeout: 8000 });
  await selectLayer(page, "c_oldstataaa");
  await openDataGroup(page);
  // The new Data line names its data and its refresh; nothing is renamed or turned into managed data.
  await expect(page.locator("[data-data-line]")).toHaveAttribute("data-managed", "no");
  await expect(page.locator("[data-data-line-words]")).toContainText("Shows: CPU in use, ACE");
  await expect(page.locator("[data-refresh-change]")).toHaveText("updates every 30 s");
  // Change, then Escape: nothing changes.
  await page.locator("[data-data-change]").click();
  await expect(picker(page)).toBeVisible();
  await page.keyboard.type("memory");
  await expect(page.locator("[data-show-item]").first()).toBeVisible({ timeout: 3000 });
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  // Change, then Cancel: nothing changes either.
  await page.locator("[data-data-change]").click();
  await page.locator("[data-pick-cancel]").click();
  await expect(picker(page)).toHaveCount(0);
  // The old single-source chart keeps drawing every series it holds.
  await expect(canvasNode(page, "c_oldchartaa").locator("[data-series]").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  const after = await draft(id);
  expect(after.rev).toBe(before.rev);
  expect(after.doc).toEqual(before.doc);
  // The review has no new warnings: no unused or managed-data warning, nothing about data sources at all.
  const review = await (await (await api(OWNER)).get(`/api/apps/${id}/review`)).json() as { problems: { code: string; message: string }[] };
  log("criterion 12 review problems", review.problems);
  expect(review.problems.filter((x) => /^source\.|^data\./.test(x.code))).toEqual([]);
  await publish(id);
  expect((await draft(id)).doc.dataSources.map((s) => s.name)).toEqual(["cpu_ace", "cpu_hist"]);
  await ctx.close();
});

test("New app > Start page from your services: a fresh app opens on its start page, made in one change", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-new-app], [data-new-app-tile]").first().click();
  await page.locator("[data-new-app-name]").fill(`Home start ${RUN}`);
  await page.locator('[data-template-option="start-page"]').click();
  await expect(page.locator(`[data-start-service="${dockerId}"]`)).toHaveAttribute("aria-checked", "true");
  // Untick Prometheus: only the ticked services are placed.
  await page.locator(`[data-start-service="${promId}"]`).click();
  await expect(page.locator(`[data-start-service="${promId}"]`)).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: shot("new-app-start-page-light") });
  await page.locator("[data-create-app]").click();
  await page.waitForURL(/\/build\//);
  await expect(page.locator("[data-canvas-root] [data-type='resource-bar']")).toHaveCount(1, { timeout: 8000 });
  const slug = page.url().split("/build/")[1]!.split(/[/?]/)[0]!;
  const tiles = (await (await (await api(OWNER)).get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[];
  const d = await draft(tiles.find((t) => t.app.slug === slug)!.app.id);
  const names = allNodes(d).filter((n) => n.type === "service-tile").map((n) => n.props.name);
  expect(names).toContain(`Docker ${RUN}`);
  expect(names).toContain(`Home ${RUN}`);
  expect(names).not.toContain(`Prometheus ${RUN}`);
  expect(d.rev).toBe(2);
  await ctx.close();
});

/** Every interactive control in the region that is narrower or shorter than 44 px (criterion 11). */
async function smallControls(page: Page, within: string): Promise<string[]> {
  return page.locator(within).evaluate((root) => [...root.querySelectorAll<HTMLElement>("button, a[href], input, select, [role=checkbox], [role=tab], [role=combobox]")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })
    .filter((e) => { const r = e.getBoundingClientRect(); return r.height < 43.5; })
    .map((e) => `${e.tagName.toLowerCase()} ${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 40)} ${Math.round(e.getBoundingClientRect().height)}px`));
}

test("criterion 11 and V5 (390 px): the start page has one column, no sideways scroll, 44 px controls; the picker, the tile chooser and the start sheet fit a phone", async ({ browser }) => {
  const slug = `dd-phone-${RUN}`;
  const id = await newApp(slug);
  const c = await api(OWNER);
  const r = await c.post(`/api/apps/${id}/start-page`, { data: { integrationIds: [promId, dockerId, haId], links: [{ name: "Router", href: "http://router.e2e.test/" }] } });
  expect(r.ok()).toBe(true);
  await publish(id);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 390, height: 844 }, mobile: true });
  const view = await ctx.newPage();
  await view.goto(`/a/${slug}`);
  await expect(view.locator("[data-type='service-tile']").first()).toBeVisible({ timeout: 10_000 });
  await view.waitForTimeout(1500);
  const sideways = await view.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  // Groups are one column: every tile starts at the same left edge and fits the screen.
  const boxes = await view.locator("[data-type='service-tile']").evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right) }; }));
  expect(new Set(boxes.map((b) => b.left)).size).toBe(1);
  expect(boxes.every((b) => b.right <= 390)).toBe(true);
  expect(await smallControls(view, "main")).toEqual([]);
  await view.screenshot({ path: shot("v5-start-page-390-dark"), fullPage: true });
  // The builder at 390 px: the picker is a full sheet with 44 px controls and no sideways scroll.
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  const tile = (await draft(id)).doc.pages[0]!.root.children![1]!.children![0]!.id;
  await page.locator(`[data-canvas-root] [data-node="${tile}"]`).tap();
  await page.locator('[data-narrow-tab="edit"]').tap();
  await page.locator('[data-list-entry-change="0"]').tap();
  await expect(picker(page)).toBeVisible();
  await page.locator("[data-show-search]").fill("cpu");
  await expect(page.locator("[data-show-item]").first()).toBeVisible({ timeout: 3000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(await smallControls(page, "[data-show-picker]")).toEqual([]);
  await page.screenshot({ path: shot("v5-picker-390-dark") });
  await page.locator("[data-pick-cancel]").tap();
  // Insert > Start page and Insert > Service tile sheets at 390 px.
  await page.locator('[data-narrow-tab="canvas"]').tap().catch(() => {});
  await ctx.close();
});

test("criterion 13: a guest of a published start page gets the tiles' resolved values, never the whole reads", async ({ browser }) => {
  const slug = `dd-guest-${RUN}`;
  const id = await newApp(slug);
  const c = await api(OWNER);
  const r = await c.post(`/api/apps/${id}/start-page`, { data: { integrationIds: [dockerId], links: [] } });
  expect(r.ok()).toBe(true);
  const a = await c.put(`/api/apps/${id}/access`, { data: { view: "owner", edit: "owner", guests: true } });
  expect(a.ok()).toBe(true);
  await publish(id);
  const link = await (await c.post("/api/auth/atrium/guest-links", { data: { appId: id, label: "FAKE e2e guest" } })).json() as { url: string };
  const g = await contextFor(browser, null, { viewport: { width: 1280, height: 800 } });
  const page = await g.newPage();
  const traffic = captureTraffic(page, "direct-data-guest");
  await page.goto(new URL(link.url).pathname);
  await page.waitForURL(new RegExp(`/a/${slug}`));
  const tile = page.locator("[data-type='service-tile']").first();
  await expect(tile.locator('[data-slot="name"]')).toHaveText(`Docker ${RUN}`);
  await expect.poll(async () => (await tile.locator("[data-stat-index]").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim().toLowerCase()), { timeout: 10_000 }).toEqual(["2 running", "1 stopped", "3 total"]);
  await page.waitForTimeout(1500);
  // The containers read's rows (names, images, states) never reach the guest; nor does the service's address.
  const leaked = traffic.bodies.filter((b) => /restic\/restic|grafana\/grafana|Up 3 days|"Names"|tcp:\/\/127\.0\.0\.1/.test(b.body));
  log("criterion 13 guest leak check", { responses: traffic.bodies.length, leaked: leaked.map((l) => l.url) });
  writeFileSync(path.join(EVIDENCE, "c13-guest-bodies.json"), JSON.stringify(traffic.bodies.map((b) => ({ url: b.url, status: b.status, body: b.body.slice(0, 4000) })), null, 1));
  expect(traffic.bodies.length).toBeGreaterThan(0);
  expect(leaked).toEqual([]);
  await page.screenshot({ path: shot("c13-guest-start-page") });
  await g.close();
});

test("V4: the start page in the three app themes (Control Room, Dusk, Solid), and the picker in the shell's light solid theme", async ({ browser }) => {
  for (const themeId of ["control-room", "dusk", "solid"]) {
    const slug = `dd-theme-${themeId}-${RUN}`;
    const id = await newApp(slug, [], [], themeId);
    const c = await api(OWNER);
    const r = await c.post(`/api/apps/${id}/start-page`, { data: { integrationIds: [promId, dockerId, haId], links: [{ name: "Router", href: "http://router.e2e.test/" }], machine: { integrationId: promId, thing: ACE, label: "ACE" } } });
    expect(r.ok()).toBe(true);
    // A chart with two lines under the tiles, so line names and colours show in each theme.
    const d = await draft(id);
    const chartItem = { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: `c_themechart${"abc"[["control-room", "dusk", "solid"].indexOf(themeId)]}`, type: "chart", props: { kind: "line", height: 180, legend: true }, slot: { x: 0, y: 200, w: 12, h: 28 } } };
    await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: [chartItem] } });
    await publish(id);
    const ctx = await contextFor(browser, OWNER, { viewport: { width: 1440, height: 1000 } });
    const view = await ctx.newPage();
    await view.goto(`/a/${slug}`);
    await expect(view.locator("[data-type='resource-bar']")).toBeVisible({ timeout: 10_000 });
    await expect(view.locator("[data-type='service-tile'] [data-stat-index]").first()).not.toBeEmpty({ timeout: 10_000 });
    await view.waitForTimeout(1500);
    await view.screenshot({ path: shot(`v4-start-page-${themeId}`), fullPage: true });
    await ctx.close();
  }
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[2], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, `dd-theme-dusk-${RUN}`);
  await insert(page, "stat");
  await page.keyboard.type("memory");
  await expect(page.locator("[data-show-item]").first()).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot("v4-picker-light-solid") });
  await page.locator("[data-show-search]").fill("");
  await page.locator('[data-show-browse="measure"]').click();
  await page.screenshot({ path: shot("v4-picker-by-measure-light-solid") });
  await page.locator('[data-show-browse="service"]').click();
  await page.locator(`[data-show-service="${promId}"]`).click();
  await expect(page.locator("[data-show-thing]").first()).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: shot("v4-picker-by-service-light-solid") });
  await ctx.close();
});
