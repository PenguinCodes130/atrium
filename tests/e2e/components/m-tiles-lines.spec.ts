// Wave 2.9 components (direct data spec 3.4 to 3.6; architecture Amendment 10, A10.2 chart lines and A10.7
// service tile, group, resource bar, bookmarks), through the real builder screen (V11): Insert, the
// inspector's own editors, the canvas; then the published viewer, a guest, 390px (V5), three app themes
// (V4) and reduced motion (V8). Chart lines read a stand-in Prometheus (tests/e2e/fixtures). Served by
// tests/e2e/components/serve.sh (port 3114). Evidence: evidence/direct-data-components/<round>/.
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gallery, signIn } from "./helpers";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";

test.describe.configure({ timeout: 240_000 });
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
const EV = path.resolve(here, `../../../evidence/direct-data-components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}`);
const file = (name: string) => {
  const p = path.join(EV, name);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
};
const shot = (name: string) => file(`${name}.png`);
const writeEv = (name: string, data: unknown) => writeFileSync(file(name), JSON.stringify(data, null, 2));

type Node = { id: string; type: string; props: Record<string, unknown>; slot?: { x: number; y: number; w: number; h: number }; children?: Node[]; name?: string };
type Draft = { rev: number; doc: { dataSources: { name: string }[]; pages: { id: string; slug: string; root: Node }[] } };

let prom: FakePrometheus | undefined;
let promId = "";

async function draft(req: APIRequestContext, id: string): Promise<Draft> {
  return (await req.get(`/api/apps/${id}/draft`)).json();
}
async function ops(req: APIRequestContext, id: string, list: unknown[]) {
  const d = await draft(req, id);
  const r = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function newApp(req: APIRequestContext, slug: string, kids: Node[] = [], extra: unknown[] = []): Promise<{ id: string; rootId: string }> {
  const r = await req.post("/api/apps", { data: { name: `Tiles ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await draft(req, id);
  const rootId = d.doc.pages[0]!.root.id;
  const list = [...extra, ...kids.map((n) => ({ op: "node.add", parentId: rootId, node: n }))];
  if (list.length) await ops(req, id, list);
  return { id, rootId };
}
async function publish(req: APIRequestContext, appId: string) {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note: "tiles" }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function untilDraft(req: APIRequestContext, id: string, ok: (d: Draft) => boolean, ms = 6000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(req, id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)];
const find = (d: Draft, id: string) => all(d.doc.pages[0]!.root).find((n) => n.id === id);
const ofType = (d: Draft, t: string) => all(d.doc.pages[0]!.root).filter((n) => n.type === t);
async function open(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
}
async function select(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${id}"]`).click();
  await expect(page.locator(`[data-inspector][data-node-id="${id}"]`)).toBeVisible();
}
const insp = (page: Page) => page.locator("[data-inspector]");
const canvas = (page: Page, id: string) => page.locator(`[data-canvas-root] [data-node="${id}"]`);
/** Inserts through the Insert tab; a data picker that opens at insert time (builder B) is closed with Escape. */
async function insert(page: Page, req: APIRequestContext, appId: string, type: string): Promise<string> {
  const before = new Set(all((await draft(req, appId)).doc.pages[0]!.root).map((n) => n.id));
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator(`[data-insert-item="${type}"]`).first().click();
  await closeSheets(page);
  const d = await untilDraft(req, appId, (x) => all(x.doc.pages[0]!.root).some((n) => !before.has(n.id) && n.type === type));
  const node = all(d.doc.pages[0]!.root).find((n) => !before.has(n.id) && n.type === type)!;
  expect(node, `${type} was inserted`).toBeTruthy();
  return node.id;
}
/** Closes a builder sheet (the data picker, the service chooser) that opened on its own, with Escape. */
async function closeSheets(page: Page) {
  const sheet = page.locator('[role="dialog"]');
  if (await sheet.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
}
/** Opens a "by hand" fold of the inspector when the builder shows its own data summary above it. */
async function byHand(page: Page, list: "lines" | "stats" | "items") {
  const t = page.locator(`[data-inspector] [data-more-settings-toggle="${list}-by-hand"]`);
  if ((await t.count()) && (await t.getAttribute("aria-expanded")) !== "true") await t.click();
}
async function fill(page: Page, sel: string, value: string) {
  const el = page.locator(sel).first();
  await el.click();
  await el.fill(value);
}
/** The phone checks: no sideways scroll and every visible control of these components at least 44 px. */
async function phoneChecks(page: Page, sel: string) {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const sizes = await page.locator(sel).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => ({ what: (e as HTMLElement).className || e.tagName, h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })));
  return { scroll, sizes };
}

test.beforeAll(async () => {
  prom = await startFakePrometheus();
});
test.afterAll(async () => {
  await prom?.close();
});
test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project; the phone width is set per test");
  await signIn(context, page.request);
  if (!promId) {
    const r = await page.request.post("/api/integrations", { data: { packageId: "prometheus", name: `Prometheus e2e ${RUN}`, config: { baseUrl: prom!.url, authMode: "none" }, secrets: {}, untested: true }, headers: H });
    expect(r.ok(), await r.text()).toBe(true);
    promId = (await r.json()).id as string;
  }
});

// The stand-in site for the reachability check listens on this machine's network address (loopback is refused by design).
const LAN = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
const PVE1 = "10.77.99.4:9100", PVE2 = "10.77.99.10:9100";
const rangeSource = (name: string, query: string, unit: string) => ({ op: "source.set", source: { name, integrationId: promId, endpointId: "range", params: { query, rangeSec: 3600, stepSec: 60, unit }, refreshSec: 60 } });
const statSource = (name: string, query: string, unit: string) => ({ op: "source.set", source: { name, integrationId: promId, endpointId: "query", params: { query, unit }, refreshSec: 30 } });

test("Insert each new component and edit it in the inspector: service tile, group, resource bar, bookmarks (A10.7)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const slug = `tiles-ins-${RUN}`;
  const app = await newApp(page.request, slug);
  await open(page, slug);

  // Service tile: name, description, address, icon, two numbers (one typed in, one live).
  const tile = await insert(page, page.request, app.id, "service-tile");
  await select(page, tile);
  await fill(page, '[data-inspector] [data-field="name"] input', "Portainer");
  await fill(page, '[data-inspector] [data-field="description"] textarea', "Docker management");
  await fill(page, '[data-inspector] [data-field="href"] input', "https://portainer.example.test");
  await insp(page).locator('[data-icon-select="icon"]').selectOption("docker");
  await byHand(page, "stats");
  await insp(page).locator("[data-add-stat]").click();
  await insp(page).locator("[data-add-stat]").click();
  await fill(page, '[data-list-text="stats.0.label"]', "Running");
  await fill(page, '[data-list-literal="stats.0.value"]', "42");
  await fill(page, '[data-list-text="stats.1.label"]', "Total");
  await fill(page, '[data-list-literal="stats.1.value"]', "45");
  await insp(page).locator('[data-list-format="stats.1.value"], [data-list-format="stats.1.format"]').first().selectOption("number");
  let d = await untilDraft(page.request, app.id, (x) => (find(x, tile)?.props.stats as unknown[] | undefined)?.length === 2 && find(x, tile)?.props.icon === "docker" && (find(x, tile)?.props.stats as { value?: unknown }[])[1]?.value === 45);
  expect(find(d, tile)!.props).toMatchObject({ name: "Portainer", description: "Docker management", href: "https://portainer.example.test", icon: "docker", stats: [{ label: "Running", value: 42 }, { label: "Total", value: 45, format: "number" }] });
  const t = canvas(page, tile);
  await expect(t.locator('[data-slot="name"]')).toHaveText("Portainer");
  await expect(t.locator('[data-icon="docker"]')).toBeVisible();
  await expect(t.locator('[data-stat-index="0"] [data-stat-value]')).toHaveText("42");
  await expect(t.locator('[data-stat-index="1"] dt')).toHaveText("Total");
  // A live number: "Live data" turns it into a template, typed here as a literal expression.
  await insp(page).locator('[data-bind-button="stats.0.value"]').click();
  const tmpl = insp(page).locator('[data-list-value="stats.0.value"] textarea').first();
  await tmpl.click();
  await tmpl.fill("{{ 40 + 2 }}");
  d = await untilDraft(page.request, app.id, (x) => JSON.stringify(find(x, tile)?.props.stats).includes("40 + 2"));
  expect((find(d, tile)!.props.stats as { value: unknown }[])[0]!.value).toEqual({ $bind: "{{ 40 + 2 }}" });
  await expect(t.locator('[data-stat-index="0"] [data-stat-value]')).toHaveText("42");
  // Remove a number.
  await insp(page).locator('[data-stat-row="1"] [data-list-remove]').click();
  await untilDraft(page.request, app.id, (x) => (find(x, tile)?.props.stats as unknown[]).length === 1);
  await expect(t.locator("[data-stat-index]")).toHaveCount(1);
  await page.screenshot({ path: shot("insert-service-tile") });

  // Group: title, columns, fold.
  const group = await insert(page, page.request, app.id, "group");
  await select(page, group);
  await fill(page, '[data-inspector] [data-field="title"] input', "Media");
  await fill(page, '[data-inspector] [data-field="columns"] input', "2");
  await insp(page).getByText("Can fold away", { exact: true }).click();
  d = await untilDraft(page.request, app.id, (x) => find(x, group)?.props.columns === 2 && find(x, group)?.props.collapsible === true && find(x, group)?.props.title === "Media");
  expect(find(d, group)!.props).toMatchObject({ title: "Media", columns: 2, collapsible: true });
  await expect(canvas(page, group).locator('[data-slot="title"]')).toHaveText("Media");
  await expect(canvas(page, group).locator("[data-group-empty]")).toHaveText("Drag tiles here");
  await expect(canvas(page, group).locator("[data-group-fold]")).toBeVisible();
  // Children flow in order, two columns (moving a tile in by dragging is the builder's, so it is added here directly).
  await ops(page.request, app.id, [0, 1, 2].map((i) => ({ op: "node.add", parentId: group, node: { id: `c_grpkid${"abc"[i]}aaa`, type: "service-tile", props: { icon: "film", name: `Tile ${i + 1}`, newTab: true, stats: [] } } })));
  await page.reload();
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
  const cols = await canvas(page, group).locator("[data-group-body]").evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
  expect(cols).toBe(2);
  const tops = await canvas(page, group).locator("[data-group-item]").evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-group-item"), x: Math.round(e.getBoundingClientRect().left), y: Math.round(e.getBoundingClientRect().top) })));
  expect(tops.map((x) => x.id)).toEqual(["c_grpkidaaaa", "c_grpkidbaaa", "c_grpkidcaaa"]);
  expect(tops[0]!.y).toBe(tops[1]!.y);
  expect(tops[2]!.y).toBeGreaterThan(tops[0]!.y);

  // Resource bar: a reading with a bar, clock and search.
  const bar = await insert(page, page.request, app.id, "resource-bar");
  await select(page, bar);
  await expect(canvas(page, bar).locator("[data-bar-sample]")).toBeVisible();
  await byHand(page, "items");
  await insp(page).locator("[data-add-reading]").click();
  await fill(page, '[data-list-text="items.0.label"]', "Disk");
  await insp(page).locator('[data-icon-select="items.0.icon"]').selectOption("disk");
  await fill(page, '[data-list-literal="items.0.value"]', "61");
  await fill(page, '[data-list-literal="items.0.percent"]', "61");
  await insp(page).locator('[data-list-format="items.0.format"]').selectOption("percent");
  d = await untilDraft(page.request, app.id, (x) => (find(x, bar)?.props.items as { percent?: unknown }[] | undefined)?.[0]?.percent === 61 && (find(x, bar)?.props.items as { format?: unknown }[])[0]?.format === "percent");
  expect((find(d, bar)!.props.items as unknown[])[0]).toMatchObject({ icon: "disk", label: "Disk", value: 61, percent: 61, format: "percent" });
  await expect(canvas(page, bar).locator('[data-bar-index="0"] [data-bar-value]')).toHaveText("61%");
  await expect(canvas(page, bar).locator('[data-bar-index="0"] [role="meter"]')).toHaveAttribute("aria-valuenow", "61");
  await expect(canvas(page, bar).locator("[data-bar-clock]")).toBeVisible();
  await expect(canvas(page, bar).locator("[data-bar-search-input]")).toBeVisible();
  await insp(page).getByText("Show a search box", { exact: true }).click();
  await untilDraft(page.request, app.id, (x) => find(x, bar)?.props.search === false);
  await expect(canvas(page, bar).locator("[data-bar-search-input]")).toHaveCount(0);

  // Bookmarks: a row with the domain; an unsafe address is refused in words.
  const bm = await insert(page, page.request, app.id, "bookmarks");
  await select(page, bm);
  await insp(page).locator("[data-add-bookmark]").click();
  await fill(page, '[data-list-text="items.0.name"]', "YouTube");
  await fill(page, '[data-list-text="items.0.href"]', "https://www.youtube.com/feed");
  await insp(page).locator("[data-add-bookmark]").click();
  await fill(page, '[data-list-text="items.1.name"]', "Bad link");
  await fill(page, '[data-list-text="items.1.href"]', "javascript:alert(1)");
  await expect(insp(page).locator('[data-bookmark-refused="1"]')).toBeVisible();
  d = await untilDraft(page.request, app.id, (x) => (find(x, bm)?.props.items as unknown[] | undefined)?.length === 2 && JSON.stringify(find(x, bm)?.props.items).includes("javascript"));
  await page.screenshot({ path: shot("insert-bookmarks") });
  await expect(canvas(page, bm).locator('[data-bookmark="0"] [data-slot="domain"]')).toHaveText("youtube.com");
  await expect(canvas(page, bm).locator('[data-bookmark="0"] .atr-letters')).toHaveText("YO");
  await expect(canvas(page, bm).locator('[data-bookmark="1"] [data-inert-link]')).toBeVisible();
  await page.screenshot({ path: shot("insert-all-four") });
  writeEv("insert-draft.json", find(d, tile));
});

test("A chart with three lines on two axes through Add a line; a fourth unit is refused; colour, Hide and Put it on a new chart (A10.2)", async ({ page: signed, browser }) => {
  // V6: this test is recorded (adding chart lines).
  const rec = await browser.newContext({ baseURL: ORIGIN, storageState: await signed.context().storageState(), viewport: { width: 1440, height: 1000 }, recordVideo: { dir: file("video-chart-lines/x").replace(/\/x$/, ""), size: { width: 1440, height: 1000 } } });
  const page = await rec.newPage();
  const slug = `tiles-lines-${RUN}`;
  const chart = "c_linechartx";
  const app = await newApp(page.request, slug, [{ id: chart, type: "chart", name: "Machines", props: { kind: "line", height: 180 }, slot: { x: 0, y: 0, w: 8, h: 40 } }], [
    rangeSource("cpu1", `node_cpu_seconds_total{instance="${PVE1}"}`, "%"),
    rangeSource("cpu2", `node_cpu_seconds_total{instance="${PVE2}"}`, "%"),
    rangeSource("net1", `node_network_receive_bytes_total{instance="${PVE1}"}`, "B/s"),
    rangeSource("temp1", `node_hwmon_temp_celsius{instance="${PVE1}"}`, "°C"),
  ]);
  await open(page, slug);
  await select(page, chart);
  await byHand(page, "lines");
  const addLine = async (i: number, template: string) => {
    await insp(page).locator("[data-lines-editor] [data-lines-add]").click();
    await closeSheets(page);
    const box = insp(page).locator(`[data-lines-row="${i}"] [data-list-value="lines.${i}.data"] textarea`).first();
    await expect(box).toBeVisible();
    await box.click();
    await box.fill(template);
    await untilDraft(page.request, app.id, (x) => JSON.stringify(find(x, chart)?.props.lines ?? []).includes(template.replace(/[{} ]/g, "").slice(0, 5)));
  };
  await addLine(0, "{{ cpu1 }}");
  await addLine(1, "{{ cpu2 }}");
  await fill(page, '[data-list-text="lines.1.label"]', "Second machine");
  await addLine(2, "{{ net1 }}");
  const c = canvas(page, chart);
  await expect(c.locator("[data-lines-chart]")).toHaveAttribute("data-axes", "2", { timeout: 15_000 });
  await expect(c.locator("[data-series-label]")).toHaveCount(3);
  await expect(c.locator('[data-series-label="Second machine"]')).toHaveCount(1);
  await expect(c.locator("[data-axis-right]").first()).toBeVisible();
  await expect(c.locator('[data-legend-axis="1"]')).toHaveCount(1);
  await page.screenshot({ path: shot("chart-three-lines-two-axes") });
  // A fourth line in a third unit: refused in one sentence, on the canvas and next to the line.
  await addLine(3, "{{ temp1 }}");
  await expect(c.locator("[data-third-unit]")).toContainText("A chart shows at most two units", { timeout: 15_000 });
  await expect(insp(page).locator('[data-lines-refused="3"]')).toContainText("put it on a new chart");
  await expect(c.locator("[data-series-label]")).toHaveCount(3);
  await page.screenshot({ path: shot("chart-third-unit-refused") });
  // Colour and Hide.
  await insp(page).locator('[data-lines-color="lines.0.color"]').selectOption("series4");
  await insp(page).locator('[data-lines-hide="1"]').click();
  let d = await untilDraft(page.request, app.id, (x) => (find(x, chart)?.props.lines as { hidden?: boolean }[])?.[1]?.hidden === true && (find(x, chart)?.props.lines as { color?: string }[])[0]?.color === "series4");
  expect((find(d, chart)!.props.lines as { color?: string }[])[0]!.color).toBe("series4");
  await expect(c.locator('[data-series-label="Second machine"]')).toHaveCount(0);
  const stroke = await c.locator('[data-series^="0:"] path').first().getAttribute("stroke");
  expect(stroke).toBe("var(--atr-series-4)");
  // The refused line moves to a new chart of its own.
  await insp(page).locator('[data-lines-new-chart="3"]').click();
  d = await untilDraft(page.request, app.id, (x) => ofType(x, "chart").length === 2);
  const charts = ofType(d, "chart");
  expect((find(d, chart)!.props.lines as unknown[]).length).toBe(3);
  const other = charts.find((n) => n.id !== chart)!;
  expect(other.props.lines).toEqual([{ data: { $bind: "{{ temp1 }}" } }]);
  await expect(c.locator("[data-third-unit]")).toHaveCount(0);
  writeEv("chart-lines-draft.json", { chart: find(d, chart), moved: other });
  await rec.close();
});

test("An existing single-source chart is unchanged, and Add a line keeps its series as the first line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `tiles-old-${RUN}`;
  const chart = "c_oldchartzz";
  const app = await newApp(page.request, slug, [{ id: chart, type: "chart", props: { data: { $bind: "{{ every }}" }, kind: "line" }, slot: { x: 0, y: 0, w: 8, h: 40 } }], [rangeSource("every", "node_cpu_seconds_total", "%")]);
  await open(page, slug);
  const c = canvas(page, chart);
  await expect(c.locator("[data-series]")).toHaveCount(9, { timeout: 15_000 });
  await expect(c.locator("[data-lines-chart]")).toHaveCount(0);
  await select(page, chart);
  await byHand(page, "lines");
  await insp(page).locator("[data-lines-editor] [data-lines-add]").click();
  await closeSheets(page);
  const d = await untilDraft(page.request, app.id, (x) => Array.isArray(find(x, chart)?.props.lines));
  expect(find(d, chart)!.props.data).toBeUndefined();
  expect((find(d, chart)!.props.lines as unknown[])[0]).toEqual({ data: { $bind: "{{ every }}" } });
  await expect(c.locator("[data-series-label]")).toHaveCount(9);
});

test("Published: tiles open their address in a new tab with no opener; a guest gets each line under its own key; 390px has one column, no sideways scroll and 44px controls (V5)", async ({ page, browser }) => {
  const slug = `tiles-pub-${RUN}`;
  const tile = (id: string, props: Record<string, unknown>): Node => ({ id, type: "service-tile", props: { newTab: true, ...props } });
  const app = await newApp(page.request, slug, [
    { id: "c_pubbaraaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: { $bind: "{{ cpu_now }}" }, percent: { $bind: "{{ cpu_now.value }}" }, format: "percent" }, { icon: "disk", label: "Free", value: 412 * 1024 ** 3, format: "bytes", percent: 41 }], clock: true, clockFormat: "date-time", search: true, searchUrl: "https://duckduckgo.com/?q={q}" }, slot: { x: 0, y: 0, w: 12, h: 9 } },
    { id: "c_pubgroupaa", type: "group", props: { title: "Containers", columns: 3, collapsible: true }, slot: { x: 0, y: 9, w: 12, h: 26 }, children: [
      tile("c_pubtileaaa", { icon: "docker", name: "Portainer", description: "Docker management", href: "https://portainer.example.test/", integrationId: promId, stats: [{ label: "CPU", value: { $bind: "{{ cpu_now.value }}" }, format: "percent" }, { label: "Total", value: 45 }] }),
      tile("c_pubtilebbb", { icon: "proxmox", name: "Proxmox", description: "Hypervisor", href: "https://pve.example.test/" }),
      tile("c_pubtileccc", { icon: "film", name: "Jellyfin", description: "Media", href: "https://jellyfin.example.test/", newTab: false }),
    ] },
    { id: "c_pubbookmrk", type: "bookmarks", props: { items: [{ name: "Docs", href: "https://docs.example.test" }, { name: "Mail", href: "https://mail.example.test", icon: "mail" }], columns: 2 }, slot: { x: 0, y: 35, w: 6, h: 10 } },
    { id: "c_pubchartaa", type: "chart", props: { kind: "line", height: 150, lines: [{ data: { $bind: "{{ cpu1 }}" }, label: "pve1" }, { data: { $bind: "{{ net1 }}" }, label: "pve1 in" }] }, slot: { x: 6, y: 35, w: 6, h: 36 } },
  ], [statSource("cpu_now", `node_cpu_seconds_total{instance="${PVE1}"}`, "%"), rangeSource("cpu1", `node_cpu_seconds_total{instance="${PVE1}"}`, "%"), rangeSource("net1", `node_network_receive_bytes_total{instance="${PVE1}"}`, "B/s")]);
  await publish(page.request, app.id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/a/${slug}`);
  const t = page.locator('[data-node="c_pubtileaaa"] a.atr-tile');
  await expect(t).toHaveAttribute("href", "https://portainer.example.test/");
  await expect(t).toHaveAttribute("target", "_blank");
  await expect(t).toHaveAttribute("rel", /noopener/);
  await expect(page.locator('[data-node="c_pubtileccc"] a.atr-tile')).not.toHaveAttribute("target", "_blank");
  await expect(page.locator('[data-node="c_pubtileaaa"] [data-stat-index="0"] [data-stat-value]')).toContainText("34.6", { timeout: 15_000 });
  // integrationId is a builder reference: never drawn (A10.7).
  expect(await page.locator("body").innerText()).not.toContain(promId);
  expect(await page.locator('[data-node="c_pubtileaaa"]').evaluate((e) => e.outerHTML)).not.toContain(promId);
  // A click opens the address in a new tab, with no opener.
  await page.context().route((u) => u.hostname === "portainer.example.test", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>e2e stand-in for a service address</p>" }));
  const [popup] = await Promise.all([page.waitForEvent("popup"), t.click()]);
  expect(popup.url()).toContain("portainer.example.test");
  expect(await popup.evaluate(() => window.opener === null).catch(() => true)).toBe(true);
  await popup.close();
  // The group folds.
  await page.locator('[data-node="c_pubgroupaa"] [data-group-fold]').click();
  await expect(page.locator('[data-node="c_pubgroupaa"] [data-group-body]')).toHaveCount(0);
  await page.locator('[data-node="c_pubgroupaa"] [data-group-fold]').click();
  await expect(page.locator('[data-node="c_pubgroupaa"] [data-group-item]')).toHaveCount(3);
  await expect(page.locator('[data-node="c_pubchartaa"] [data-lines-chart]')).toHaveAttribute("data-axes", "2", { timeout: 15_000 });
  await page.screenshot({ path: shot("published-desktop"), fullPage: true });

  // A guest: the chart draws from "<nodeId>:lines.<i>.data"; no integration id reaches the page.
  const acc = await page.request.put(`/api/apps/${app.id}/access`, { data: { view: "owner", edit: "owner", guests: true }, headers: H });
  expect(acc.ok(), await acc.text()).toBe(true);
  const lr = await page.request.post("/api/auth/atrium/guest-links", { data: { appId: app.id, label: "e2e tiles guest" }, headers: H });
  expect(lr.ok(), await lr.text()).toBe(true);
  const link = (await lr.json()) as { url: string };
  const g = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 900 } });
  const gp = await g.newPage();
  const bodies: string[] = [];
  const streams: string[] = [];
  gp.on("request", (r) => {
    if (r.headers()["accept"]?.includes("text/event-stream") || /stream/.test(r.url())) streams.push(r.url());
  });
  gp.on("response", async (r) => {
    if (!/stream/.test(r.url()) && (/\/api\//.test(r.url()) || /\/a\//.test(r.url()))) bodies.push(await r.text().catch(() => ""));
  });
  await gp.goto(new URL(link.url).pathname);
  await gp.waitForURL(new RegExp(`/a/${slug}`));
  await expect(gp.locator('[data-node="c_pubchartaa"] [data-series-label="pve1"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(gp.locator('[data-node="c_pubchartaa"] [data-lines-chart]')).toHaveAttribute("data-axes", "2");
  await expect(gp.locator('[data-node="c_pubtileaaa"] [data-stat-index="0"] [data-stat-value]')).toContainText("34.6");
  await gp.waitForTimeout(1500);
  // The page stream (server-sent events) carries the guest's resolved values: read its first events.
  const streamText = streams.length
    ? await gp.evaluate(async (url) => {
        const ctl = new AbortController();
        const res = await fetch(url, { signal: ctl.signal, headers: { accept: "text/event-stream" } });
        const rd = res.body!.getReader();
        let out = "";
        const t0 = Date.now();
        while (Date.now() - t0 < 4000 && !out.includes("lines.1.data")) {
          const { value, done } = await Promise.race([rd.read(), new Promise<{ value?: Uint8Array; done: boolean }>((ok) => setTimeout(() => ok({ done: false }), 1000))]);
          if (done) break;
          if (value) out += new TextDecoder().decode(value);
        }
        ctl.abort();
        return out;
      }, streams[0]!)
    : "";
  const joined = bodies.join("\n") + streamText + (await gp.content());
  expect(joined).toContain("c_pubchartaa:lines.0.data");
  expect(joined).toContain("c_pubchartaa:lines.1.data");
  expect(await gp.locator("body").innerText()).not.toContain(promId);
  // Whole reads stay on the server: the stand-in's other machines never reach the guest.
  expect(joined).not.toContain("minipc-ubuntu");
  writeEv("guest-check.json", { streams, responses: bodies.length, linesKeys: joined.includes("c_pubchartaa:lines.1.data"), integrationIdInPayload: joined.includes(promId), otherMachines: joined.includes("minipc-ubuntu") });
  await gp.screenshot({ path: shot("guest-desktop"), fullPage: true });
  await g.close();

  // V5: 390 x 844 touch phone.
  const phone = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, storageState: await page.context().storageState() });
  const p2 = await phone.newPage();
  await p2.goto(`/a/${slug}`);
  await expect(p2.locator('[data-node="c_pubtileaaa"]')).toBeVisible({ timeout: 15_000 });
  const colsPhone = await p2.locator('[data-node="c_pubgroupaa"] [data-group-body]').evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
  expect(colsPhone).toBe(1);
  const xs = await p2.locator('[data-node="c_pubgroupaa"] [data-group-item]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(xs).size).toBe(1);
  const report = await phoneChecks(p2, ".atr-group-fold, .atr-bar-search input, .atr-bar-search button, a.atr-tile, a.atr-bookmark");
  writeEv("v5-phone-390.json", { ...report, groupColumns: colsPhone });
  expect(report.scroll).toBeLessThanOrEqual(0);
  expect(report.sizes.length).toBeGreaterThanOrEqual(7);
  for (const s of report.sizes) expect(s.h, s.what).toBeGreaterThanOrEqual(44);
  await p2.screenshot({ path: shot("v5-phone-390"), fullPage: true });
  await phone.close();
});

const THEMES = ["control-room", "dusk", "solid"] as const;
test("V4: a start page of tiles, groups, the resource bar, bookmarks and chart lines in Control Room, Dusk and Solid, published and in the builder", async ({ page }) => {
  const slug = `tiles-themes-${RUN}`;
  const tile = (id: string, props: Record<string, unknown>): Node => ({ id, type: "service-tile", props: { newTab: true, ...props } });
  const app = await newApp(page.request, slug, [
    { id: "c_thmbaraaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: { $bind: "{{ cpu_now }}" }, percent: { $bind: "{{ cpu_now.value }}" }, format: "percent" }, { icon: "memory", label: "Free", value: 21.4 * 1024 ** 3, format: "bytes", percent: 62 }, { icon: "disk", label: "Free", value: 412 * 1024 ** 3, format: "bytes", percent: 41 }, { icon: "thermometer", label: "Temp", value: 55, format: "celsius" }], clock: true, search: true, searchUrl: "https://duckduckgo.com/?q={q}" }, slot: { x: 0, y: 0, w: 12, h: 9 } },
    { id: "c_thmgroupaa", type: "group", props: { title: "Containers", columns: 3 }, slot: { x: 0, y: 9, w: 12, h: 26 }, children: [
      tile("c_thmtileaaa", { icon: "docker", name: "Portainer", description: "Docker management", href: "https://portainer.example.test/", status: { $bind: "{{ up_now }}" }, stats: [{ label: "CPU", value: { $bind: "{{ cpu_now.value }}" }, format: "percent" }, { label: "Running", value: 42 }, { label: "Total", value: 45 }] }),
      tile("c_thmtilebbb", { icon: "proxmox", name: "Proxmox", description: "Hypervisor", href: "https://pve.example.test/", stats: [{ label: "VMs", value: 12 }, { label: "LXC", value: 7 }] }),
      tile("c_thmtileccc", { icon: "film", name: "Jellyfin", description: "Films and series", href: "https://jellyfin.example.test/" }),
    ] },
    { id: "c_thmgroupbb", type: "group", props: { title: "Links", columns: 1 }, slot: { x: 0, y: 35, w: 4, h: 18 }, children: [
      { id: "c_thmbookmrk", type: "bookmarks", props: { items: [{ name: "Docs", href: "https://docs.example.test" }, { name: "Mail", href: "https://mail.example.test", icon: "mail" }, { name: "Status", href: "https://status.example.test" }] } },
    ] },
    { id: "c_thmchartaa", type: "chart", props: { kind: "line", height: 150, lines: [{ data: { $bind: "{{ cpu1 }}" }, label: "pve1" }, { data: { $bind: "{{ cpu2 }}" }, label: "pve2" }, { data: { $bind: "{{ net1 }}" }, label: "pve1 in" }] }, slot: { x: 4, y: 35, w: 8, h: 36 } },
  ], [statSource("cpu_now", `node_cpu_seconds_total{instance="${PVE1}"}`, "%"), { op: "source.set", source: { name: "up_now", integrationId: promId, endpointId: "targets", refreshSec: 30 } }, rangeSource("cpu1", `node_cpu_seconds_total{instance="${PVE1}"}`, "%"), rangeSource("cpu2", `node_cpu_seconds_total{instance="${PVE2}"}`, "%"), rangeSource("net1", `node_network_receive_bytes_total{instance="${PVE1}"}`, "B/s")]);
  const out: Record<string, unknown> = {};
  for (const theme of THEMES) {
    await ops(page.request, app.id, [{ op: "theme.set", theme: { themeId: theme } }]);
    await publish(page.request, app.id);
    await page.context().addCookies([{ name: "atrium_swept", value: "1", url: ORIGIN }]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/a/${slug}`);
    await expect(page.locator('[data-node="c_thmchartaa"] [data-lines-chart]')).toHaveAttribute("data-axes", "2", { timeout: 15_000 });
    await expect(page.locator('[data-node="c_thmtileaaa"] [data-stat-index="0"] [data-stat-value]')).toContainText("34.6");
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot(`v4-${theme}-published`), fullPage: true });
    // Tokens, not one-off colours: the tile surface, the bar fill and line colours follow the theme.
    out[theme] = await page.evaluate(() => {
      const q = (s: string) => document.querySelector(s) as HTMLElement | null;
      const cs = (s: string, p: string) => (q(s) ? getComputedStyle(q(s)!).getPropertyValue(p) : "");
      return { tileBg: cs('[data-node="c_thmtileaaa"] .atr-tile', "background-color"), tileText: cs('[data-node="c_thmtileaaa"] .atr-tile-name', "color"), barFill: cs('[data-node="c_thmbaraaaa"] .atr-bar-fill', "background-color"), series1: getComputedStyle(q(".atr-render-root")!).getPropertyValue("--atr-series-1").trim(), groupTitle: cs('[data-node="c_thmgroupaa"] .atr-group-title', "color") };
    });
    await open(page, slug);
    await page.screenshot({ path: shot(`v4-${theme}-builder`) });
  }
  writeEv("v4-theme-tokens.json", out);
  const bgs = new Set(THEMES.map((t) => (out[t] as { tileBg: string }).tileBg));
  expect(bgs.size).toBe(3);
});

test("V4 gallery: every tile state (running, stopped and faded, 12 ms, healthy, stale, loading), bookmarks and the 20 of 25 chart, in the three themes, and a guest", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  for (const theme of ["controlRoom", "dusk", "solid"]) {
    await page.goto(gallery({ scene: "tiles", theme }));
    await expect(page.locator('[data-type="service-tile"]').first()).toBeVisible();
    await expect(page.locator('[data-node="c_tkopiaaaaa"] .atr-tile-stats')).toHaveAttribute("data-down", "");
    await expect(page.locator('[data-node="c_tkopiaaaaa"] [data-slot="badge"]')).toContainText("Stopped");
    await expect(page.locator('[data-node="c_tnasaaaaaa"] [data-slot="badge"]')).toContainText("12 ms");
    await expect(page.locator('[data-node="c_tsonarraaa"] [data-state-mark="stale"]')).toBeVisible();
    await expect(page.locator('[data-node="c_tloadingaa"] [data-badge-state="loading"]')).toBeVisible();
    await expect(page.locator('[data-node="c_chartmanya"] [data-series-count]')).toHaveText("20 of 25 series");
    await expect(page.locator('[data-node="c_chartlines"] [data-third-unit]')).toBeVisible();
    await page.screenshot({ path: shot(`v4-gallery-${theme}`), fullPage: true });
  }
  await page.goto(gallery({ scene: "tiles-guest", theme: "dusk" }));
  await expect(page.locator('[data-node="c_chartlines"] [data-lines-chart]')).toHaveAttribute("data-axes", "2");
  await expect(page.locator('[data-node="c_tportainer"] [data-stat-index="0"] [data-stat-value]')).toHaveText("42");
  await page.screenshot({ path: shot("v4-gallery-guest-dusk"), fullPage: true });
});

async function reducedPage(browser: Browser, state: Awaited<ReturnType<ReturnType<Page["context"]>["storageState"]>>) {
  const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: state, viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  return { ctx, page: await ctx.newPage() };
}

test("V8 reduced motion: tiles do not lift on hover, the group folds at once, the bar fills without a transition", async ({ browser, page: signed }) => {
  const { ctx, page } = await reducedPage(browser, await signed.context().storageState());
  await page.goto(gallery({ scene: "tiles", theme: "controlRoom" }));
  const tile = page.locator('[data-node="c_tportainer"] a.atr-tile');
  await tile.hover();
  const tf = await tile.evaluate((e) => getComputedStyle(e).transform);
  expect(tf === "none" || tf === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  const tr = await page.locator(".atr-bar-fill").first().evaluate((e) => getComputedStyle(e).transitionDuration);
  expect(tr.split(",").every((x) => parseFloat(x) === 0)).toBe(true);
  const fold = page.locator('[data-node="c_grpmediaaa"] [data-group-fold]');
  await fold.click();
  await expect(page.locator('[data-node="c_grpmediaaa"] [data-group-body]')).toHaveCount(0, { timeout: 400 });
  await fold.click();
  await expect(page.locator('[data-node="c_grpmediaaa"] [data-group-item]')).toHaveCount(3);
  await page.screenshot({ path: shot("v8-reduced-motion"), fullPage: true });
  // Without reduced motion the same hover lifts the tile.
  await signed.setViewportSize({ width: 1280, height: 900 });
  await signed.goto(gallery({ scene: "tiles", theme: "controlRoom" }));
  const t2 = signed.locator('[data-node="c_tportainer"] a.atr-tile');
  await t2.hover();
  await expect.poll(() => t2.evaluate((e) => getComputedStyle(e).transform)).not.toBe("none");
  writeEv("v8.json", { reducedTransform: tf, barTransition: tr });
  await ctx.close();
});

test("A link tile checks its address on the server: Up with a response time in ms, then Down within 60 s once the stand-in stops, its stats kept and faded (criterion 9)", async ({ page }) => {
  test.skip(!LAN, "this machine has no network address for the stand-in site");
  test.setTimeout(180_000);
  const site = createServer((_q, s) => { s.writeHead(200, { "content-type": "text/plain" }); s.end("e2e stand-in site"); });
  await new Promise<void>((r) => site.listen(0, LAN, () => r()));
  const siteUrl = `http://${LAN}:${(site.address() as AddressInfo).port}/`;
  const slug = `tiles-reach-${RUN}`;
  await newApp(page.request, slug, [
    { id: "c_reachtilea", type: "service-tile", props: { icon: "globe", name: "Stand-in site", description: "e2e link tile", href: siteUrl, newTab: true, status: { $bind: "{{ reach_site }}" }, stats: [{ label: "Users", value: 3 }] }, slot: { x: 0, y: 0, w: 3, h: 17 } },
  ], [{ op: "source.set", source: { name: "reach_site", integrationId: "atrium", endpointId: "reach", params: { url: siteUrl }, refreshSec: 30 } }]).then((a) => publish(page.request, a.id));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/a/${slug}`);
  const badge = page.locator('[data-node="c_reachtilea"] [data-slot="badge"]');
  await expect(badge).toHaveAttribute("data-badge-state", "up", { timeout: 15_000 });
  await expect(badge).toContainText(/\d+ ms/);
  await expect(badge.locator(".sr-only")).toHaveText(/^Up, \d+ ms$/);
  await page.screenshot({ path: shot("reach-up") });
  const t0 = Date.now();
  site.closeAllConnections();
  await new Promise<void>((r) => site.close(() => r()));
  await expect(badge).toHaveAttribute("data-badge-state", "down", { timeout: 60_000 });
  const downSec = Math.round((Date.now() - t0) / 1000);
  await expect(badge).toContainText("Down");
  await expect(page.locator('[data-node="c_reachtilea"] .atr-tile-stats')).toHaveAttribute("data-down", "");
  await expect(page.locator('[data-node="c_reachtilea"] [data-stat-index="0"] [data-stat-value]')).toHaveText("3");
  await page.screenshot({ path: shot("reach-down") });
  writeEv("reach-check.json", { up: true, downAfterSec: downSec });
});
