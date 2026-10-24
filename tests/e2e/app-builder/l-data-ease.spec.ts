// app-builder e2e: Wave 2.7 data ease, the picker side (stages/02-subsystem-spec/output/data-ease-spec.md
// 3.1, 3.2, 3.5 to 3.7). Every criterion is clicked through the real picker (V11) against the stand-in
// Prometheus with 9 machines (tests/e2e/fixtures/fake-prometheus.ts), started here on a free port and
// added as an integration through the API. The UX audit's reproductions (problems 2 to 7, 12 to 14) are
// regression tests here. Evidence: evidence/app-builder/<ATRIUM_E2E_EVIDENCE_ROUND>/data-ease/.
import { expect, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { addUser, api, contextFor, ev, log, OWNER, PEOPLE, SHELL_VARIANTS, byHand } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 240_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Node = { id: string; type: string; title?: string; props: Record<string, unknown>; children?: Node[]; slot?: { x: number; y: number; w: number; h: number } };
type Source = { name: string; label?: string; integrationId: string; endpointId: string; refreshSec: number; params?: Record<string, string> };
type Draft = { rev: number; doc: { dataSources: Source[]; pages: { id: string; root: Node }[] } };

const RUN = Date.now().toString(36).slice(-4);
const ACE = "10.77.99.8:9100";
const RP52 = "10.77.99.6:9100";
let prom: FakePrometheus | undefined;
let promId = "";
const shot = (name: string) => ev("data-ease", `${name}.png`);

async function newApp(slug: string, kids: Node[] = [], sources: Source[] = []): Promise<string> {
  const c = await api(OWNER);
  const r = await c.post("/api/apps", { data: { name: `Ease ${slug}`, slug } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  if (kids.length || sources.length) {
    const d = await draft(id);
    const ops = [...sources.map((s) => ({ op: "source.set", source: s })), ...kids.map((n, i) => ({ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { slot: { x: (i % 4) * 3, y: Math.floor(i / 4) * 24, w: 3, h: 24 }, ...n } }))];
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
const nodeIn = (d: Draft, id: string): Node | undefined => {
  const walk = (n: Node): Node | undefined => (n.id === id ? n : (n.children ?? []).map(walk).find(Boolean));
  return walk(d.doc.pages[0]!.root);
};
async function open(page: Page, slug: string, select?: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  if (select) await selectLayer(page, select);
}
async function selectLayer(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  const row = page.locator(`[data-layer="${id}"]`);
  if (!(await row.isVisible())) {
    // Expand folded containers in Layers until the row shows.
    for (const t of await page.locator("[data-layer-toggle], [data-layer-expand]").all()) { if (await row.isVisible()) break; await t.click().catch(() => {}); }
  }
  await row.click();
  await expect(page.locator(`[data-selected-outline="${id}"]`)).toBeVisible();
}
const picker = (page: Page) => page.locator("[data-data-picker]");
const showPicker = (page: Page) => page.locator("[data-show-picker]");
const canvasNode = (page: Page, id: string) => page.locator(`[data-canvas-root] [data-node="${id}"]`);
async function insertStat(page: Page): Promise<string> {
  await page.locator('[data-left-tab="insert"]').click().catch(() => {});
  const before = new Set(await page.locator("[data-canvas-root] [data-node]").evaluateAll((els) => els.map((e) => e.getAttribute("data-node"))));
  await page.locator('[data-insert-item="stat"]').click();
  await expect(picker(page)).toBeVisible();
  const after = await page.locator("[data-canvas-root] [data-type='stat']").evaluateAll((els) => els.map((e) => e.getAttribute("data-node")));
  return after.find((x) => !before.has(x))!;
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  for (const p of Object.values(PEOPLE)) await addUser(p);
  prom = await startFakePrometheus();
  const c = await api(OWNER);
  const r = await c.post("/api/integrations", { data: { packageId: "prometheus", name: `Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" }, secrets: {}, untested: true } });
  if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
  promId = (await r.json()).id as string;
});
test.afterAll(async () => { await prom?.close(); });

test("criteria 1, 3, 5, 6, 13, 18: ACE's CPU in % from Insert in 6 clicks, no typing; friendly machine names; reuse from In this app and from the service", async ({ browser }) => {
  const slug = `de-cpu-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  let clicks = 0;
  const click = async (sel: string) => { await page.locator(sel).first().click(); clicks++; };
  const statId = await insertStat(page); clicks++;
  await byHand(page);
  await click(`[data-pick-integration="${promId}"]`);
  // Reads come in groups in words; containers (cAdvisor) are hidden on this server (criterion 15).
  await expect(page.locator('[data-pick-group="Machines"]')).toBeVisible();
  await page.screenshot({ path: shot("step2-groups-light") });
  await click('[data-pick-endpoint="machine-cpu"]');
  // Criterion 3: the "which machine" list shows the host label names, and RP5-3 for host.docker.internal.
  await expect(page.locator("[data-pick-things]")).toBeVisible({ timeout: 3000 });
  const names = await page.locator("[data-pick-thing] .type-body").allTextContents();
  log("which machine list", names);
  for (const n of ["ACE", "firefly", "minipc-ubuntu", "Pelican", "pve1", "pve2", "pve3", "RP5-2", "RP5-3"]) expect(names).toContain(n);
  expect(names.join(" ")).not.toContain("host.docker.internal");
  await expect(page.locator(`[data-pick-thing="*"]`)).toContainText("Every machine");
  await page.screenshot({ path: shot("step3-which-machine-light") });
  await click(`[data-pick-thing="${ACE}"]`);
  // One source, named in words from what was picked; the sample shows ACE's CPU formatted (criterion 13).
  const d1 = await untilDraft(id, (d) => d.doc.dataSources.length === 1);
  expect(d1.doc.dataSources[0]!.label).toBe("CPU in use, ACE");
  expect(d1.doc.dataSources[0]!.params).toEqual({ machine: ACE });
  await expect(page.locator("[data-pick-sample]")).toBeVisible({ timeout: 3000 });
  await expect(page.locator('[data-pick-stat="value"]')).toHaveText("7.8");
  await page.screenshot({ path: shot("step4-sample-light") });
  await click("[data-pick-use]");
  await click("[data-pick-done]");
  expect(clicks).toBeLessThanOrEqual(6);
  log("criterion 1 clicks", clicks);
  await expect(canvasNode(page, statId).locator('[data-slot="value"]')).toHaveText("7.8", { timeout: 2000 });
  await expect(canvasNode(page, statId).locator('[data-slot="unit"]')).toHaveText("%");
  // A widget inserted through the picker gets its title from what it shows (A8.5), never a slug.
  const d2 = await untilDraft(id, (x) => !!nodeIn(x, statId)?.title);
  log("inserted node", nodeIn(d2, statId));
  expect(nodeIn(d2, statId)!.title).toBe("CPU in use, ACE");
  await expect(canvasNode(page, statId).locator("[data-titlebar-text]")).toHaveAttribute("data-titlebar-text", "CPU in use, ACE");
  // The inspector's one line names what, the value and where from.
  await expect(page.locator("[data-data-shows] [data-data-summary-words]")).toContainText("Shows: CPU in use, ACE");
  await expect(page.locator("[data-data-shows] [data-data-summary-words]")).toContainText("7.8 %");
  await expect(page.locator("[data-data-shows] [data-data-summary-words]")).toContainText(`Prometheus ${RUN}, every 30 s`);
  await page.screenshot({ path: shot("inspector-shows-light") });
  // Criterion 5: a second stat lists the app's source first with its friendly name and live value; picking it adds nothing.
  const second = await insertStat(page);
  await byHand(page);
  const app = page.locator("[data-pick-in-app] [data-pick-app-source]").first();
  await expect(app).toContainText("CPU in use, ACE");
  await expect(app.locator("[data-pick-app-value]")).toHaveText("7.8 %");
  await page.screenshot({ path: shot("step1-in-this-app-light") });
  await app.click();
  await page.locator("[data-pick-use]").click();
  await page.locator("[data-pick-done]").click();
  await expect(canvasNode(page, second).locator('[data-slot="value"]')).toHaveText("7.8", { timeout: 2000 });
  expect((await draft(id)).doc.dataSources).toHaveLength(1);
  // Criterion 6: the same read and machine picked from the service again reuses the source.
  const third = await insertStat(page);
  await byHand(page);
  await page.locator(`[data-pick-integration="${promId}"]`).click();
  await page.locator('[data-pick-endpoint="machine-cpu"]').click();
  await page.locator(`[data-pick-thing="${ACE}"]`).click();
  await expect(page.locator("[data-pick-reused]")).toBeVisible();
  await page.locator("[data-pick-use]").click();
  await page.locator("[data-pick-done]").click();
  await expect(canvasNode(page, third).locator('[data-slot="value"]')).toHaveText("7.8", { timeout: 2000 });
  await page.waitForTimeout(600);
  expect((await draft(id)).doc.dataSources).toHaveLength(1);
  // Inspector: the shared source says so.
  await expect(page.locator("[data-data-shares]")).toHaveText("Shares its data with 2 other widgets");
  // Criterion 4: renaming the machine in Prometheus keeps the widget on ACE's data (stored by address).
  prom!.setHost(ACE, "ACE-renamed");
  await page.waitForTimeout(1500);
  await expect(canvasNode(page, statId).locator('[data-slot="value"]')).toHaveText("7.8");
  prom!.setHost(ACE, "ACE");
  await ctx.close();
});

test("criteria 2, 11, 13, 22: a card for each machine from the Repeat's picker builds 9 ready cards; This row binds a field with no typing", async ({ browser }) => {
  const slug = `de-cards-${RUN}`;
  const id = await newApp(slug, [{ id: "c_derepeataa", type: "repeat", props: { columns: 1, max: 50, empty: "Nothing to show" }, children: [], slot: { x: 0, y: 0, w: 12, h: 24 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  let clicks = 0;
  const click = async (sel: string) => { await page.locator(sel).first().click(); clicks++; };
  // Insert > Card for each when the builder has it (lead's shared file request); else the Repeat's Pick data.
  const insertCards = page.locator('[data-insert-item="card-for-each"]');
  let repeatId = "c_derepeataa";
  if (await insertCards.count()) {
    await click('[data-insert-item="card-for-each"]');
    await expect(picker(page)).toBeVisible();
    repeatId = (await page.locator("[data-canvas-root] [data-type='repeat']").evaluateAll((els) => els.map((e) => e.getAttribute("data-node")))).find((x) => x !== "c_derepeataa")!;
  } else {
    await selectLayer(page, repeatId); clicks++;
    await click('[data-pick-button="items"]');
  }
  await byHand(page);
  await click(`[data-pick-integration="${promId}"]`);
  await click('[data-pick-endpoint="machines-overview"]');
  // The rows build the cards at once: a title bound to the name and CPU, memory, disk, network in and out, uptime.
  const built = await untilDraft(id, (d) => (nodeIn(d, repeatId)?.children ?? []).length === 1);
  const card = nodeIn(built, repeatId)!.children![0]!;
  expect(card.props.title).toEqual({ $bind: "{{ $item.name }}" });
  expect(card.children![0]!.children!.map((s) => s.props.label)).toEqual(["CPU", "Memory", "Disk (/)", "Network in", "Network out", "Uptime"]);
  await expect(page.locator("[data-pick-cards]")).toBeVisible();
  await page.screenshot({ path: shot("cards-picker-dark") });
  await click("[data-pick-done]");
  expect(clicks).toBeLessThanOrEqual(8);
  log("criterion 2 clicks", clicks);
  const items = page.locator(`[data-canvas-root] [data-node="${repeatId}"] [data-slot="item"]`);
  await expect(items).toHaveCount(9, { timeout: 4000 });
  // Criterion 13: the ACE card shows formatted values.
  const aceCard = items.filter({ hasText: "ACE" }).first();
  await expect(aceCard).toContainText("7.8");
  await expect(aceCard).toContainText("3 d 4 h");
  await expect(aceCard).toContainText("MB/s");
  const rp53 = items.filter({ hasText: "RP5-3" });
  await expect(rp53).toHaveCount(1);
  await page.screenshot({ path: shot("cards-canvas-dark"), fullPage: true });
  // Criterion 11: inside the card, the picker's first option is This row, with values; picking cpu binds it.
  const statId = card.children![0]!.children![0]!.id;
  await page.locator(`[data-canvas-root] [data-node="${repeatId}"] [data-slot="item"]`).first().locator(`[data-node="${statId}"]`).click();
  await expect(page.locator(`[data-selected-outline="${statId}"]`)).toBeVisible();
  await page.locator('[data-pick-button="value"]').first().click();
  const first = page.locator("[data-pick-step=integration] > div").first();
  await expect(first).toHaveAttribute("data-pick-this-row");
  await expect(page.locator('[data-pick-row-field="memory"] [data-pick-row-value]')).not.toHaveText("");
  await page.screenshot({ path: shot("this-row-dark") });
  await page.locator('[data-pick-row-field="memory"]').click();
  await page.locator("[data-pick-done]").click();
  const after = await untilDraft(id, (d) => JSON.stringify(nodeIn(d, statId)?.props).includes("$item.memory"));
  expect(nodeIn(after, statId)!.props.value).toEqual({ $bind: "{{ $item.memory }}" });
  await ctx.close();
  // Criterion 22: at 390px the picker's steps keep 44px controls and never scroll sideways.
  const phone = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 390, height: 844 }, mobile: true });
  const pp = await phone.newPage();
  await pp.goto(`/build/${slug}`);
  await pp.locator(`[data-canvas-root] [data-node="${repeatId}"]`).first().tap({ position: { x: 4, y: 4 } }).catch(() => {});
  await newPhonePicker(pp, slug);
  await phone.close();
});

/** At 390px: open the picker from an inserted stat and walk the steps, checking 44px controls and no sideways scroll. */
async function newPhonePicker(pp: Page, slug: string) {
  const id = await newApp(`${slug}-p`, [{ id: "c_dephonesta", type: "stat", props: {} }]);
  void id;
  await pp.goto(`/build/${slug}-p`);
  await pp.locator('[data-canvas-root] [data-node="c_dephonesta"]').tap();
  await pp.locator('[data-narrow-tab="edit"]').tap();
  await pp.locator("[data-connect-data]").tap();
  await expect(pp.locator("[data-data-picker]")).toBeVisible();
  await byHand(pp);
  await pp.locator(`[data-pick-integration="${promId}"]`).tap();
  await pp.locator('[data-pick-endpoint="machine-cpu"]').tap();
  await expect(pp.locator("[data-pick-things]")).toBeVisible({ timeout: 3000 });
  const check = async (step: string) => {
    const small = await pp.locator("[data-data-picker]").evaluate((root) => [...root.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 43.5 && !e.closest("table") && !e.closest("[data-pick-cards]")).map((e) => `${e.tagName}:${(e.textContent ?? e.getAttribute("aria-label") ?? "").trim().slice(0, 20)}:${Math.round(e.getBoundingClientRect().height)}`));
    expect(small, step).toEqual([]);
    expect(await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), step).toBeLessThanOrEqual(0);
  };
  await check("which machine");
  await pp.screenshot({ path: shot("picker-390-which-machine-dark"), fullPage: true });
  await pp.locator(`[data-pick-thing="${ACE}"]`).tap();
  await expect(pp.locator("[data-pick-sample]")).toBeVisible({ timeout: 3000 });
  await check("sample");
  await pp.screenshot({ path: shot("picker-390-sample-dark"), fullPage: true });
  await pp.locator("[data-pick-cancel]").tap();
}

test("criterion 7 (audit problem 4): renaming a source in the picker and pressing Use this data saves both, with no 'No data source named'", async ({ browser }) => {
  const slug = `de-rename-${RUN}`;
  const id = await newApp(slug, [{ id: "c_derenameaa", type: "stat", props: {} }]);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug, "c_derenameaa");
  const toasts: string[] = [];
  page.on("console", (m) => { if (/no data source named/i.test(m.text())) toasts.push(m.text()); });
  await page.locator("[data-connect-data]").click();
  await byHand(page);
  await page.locator(`[data-pick-integration="${promId}"]`).click();
  await page.locator('[data-pick-endpoint="machine-cpu"]').click();
  await page.locator(`[data-pick-thing="${ACE}"]`).click();
  await expect(page.locator("[data-pick-sample]")).toBeVisible({ timeout: 3000 });
  const d = page.locator("[data-pick-more-settings]");
  if (!(await d.evaluate((e) => (e as HTMLDetailsElement).open))) await page.locator("[data-pick-more-settings-toggle]").click();
  // The audit's reproduction: type the name, then go straight to Use this data (no Enter, no blur first).
  await page.locator("[data-pick-name]").fill("cpu");
  await page.locator("[data-pick-use]").click();
  const saved = await untilDraft(id, (x) => x.doc.dataSources.some((s) => s.name === "cpu") && JSON.stringify(nodeIn(x, "c_derenameaa")?.props).includes("{{ cpu }}"));
  expect(saved.doc.dataSources.map((s) => s.name)).toEqual(["cpu"]);
  expect(nodeIn(saved, "c_derenameaa")!.props.data).toEqual({ $bind: "{{ cpu }}" });
  await expect(page.locator("[data-pick-template]")).toHaveText("{{ cpu }}");
  await page.locator("[data-pick-done]").click();
  await expect(canvasNode(page, "c_derenameaa").locator('[data-slot="value"]')).toHaveText("7.8", { timeout: 2000 });
  expect(await page.getByText(/no data source named/i).count()).toBe(0);
  expect(toasts).toEqual([]);
  await ctx.close();
});

test("criterion 8 (audit problem 5): Change on shared data asks all-or-this-one; this one leaves the other widget unchanged", async ({ browser }) => {
  const slug = `de-shared-${RUN}`;
  const src: Source = { name: "cpu_ace", label: "CPU in use, ACE", integrationId: promId, endpointId: "machine-cpu", refreshSec: 30, params: { machine: ACE } };
  const id = await newApp(slug, [{ id: "c_deoriginal", type: "stat", props: { data: { $bind: "{{ cpu_ace }}" } } }, { id: "c_decopyaaaa", type: "stat", props: { data: { $bind: "{{ cpu_ace }}" } } }], [src]);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug, "c_decopyaaaa");
  await expect(page.locator("[data-data-shares]")).toHaveText("Shares its data with 1 other widget");
  await page.locator("[data-data-change]").click();
  await byHand(page);
  await expect(page.locator("[data-pick-shared]")).toBeVisible();
  await expect(page.locator("[data-pick-shared-all]")).toHaveText("Change it for all 2 widgets");
  await page.screenshot({ path: shot("shared-ask-light") });
  await page.locator("[data-pick-shared-one]").click();
  await page.locator("[data-pick-change-thing]").click();
  await page.locator(`[data-pick-thing="${RP52}"]`).click();
  await expect(page.locator('[data-pick-stat="value"]')).toHaveText("4.4", { timeout: 8000 });
  await page.locator("[data-pick-done]").click();
  await expect(canvasNode(page, "c_decopyaaaa").locator('[data-slot="value"]')).toHaveText("4.4", { timeout: 2000 });
  await expect(canvasNode(page, "c_deoriginal").locator('[data-slot="value"]')).toHaveText("7.8");
  const d = await untilDraft(id, (x) => x.doc.dataSources.length === 2);
  expect(nodeIn(d, "c_deoriginal")!.props.data).toEqual({ $bind: "{{ cpu_ace }}" });
  expect(d.doc.dataSources.find((s) => s.name === "cpu_ace")!.params).toEqual({ machine: ACE });
  const copy = d.doc.dataSources.find((s) => s.name !== "cpu_ace")!;
  expect(copy.params).toEqual({ machine: RP52 });
  expect(nodeIn(d, "c_decopyaaaa")!.props.data).toEqual({ $bind: `{{ ${copy.name} }}` });
  await ctx.close();
});

test("criteria 9, 10, 14, 15 (audit problems 2, 3): several values are never kept silently; Cancel, Escape and close leave nothing; chart lines by name; hidden reads", async ({ browser }) => {
  const slug = `de-many-${RUN}`;
  const id = await newApp(slug, [{ id: "c_demanyaaaa", type: "stat", props: {} }, { id: "c_dechartaaa", type: "chart", props: {} }]);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[2], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug, "c_demanyaaaa");
  // Criterion 9: Every machine on a stat lists "9 values" and offers pick one, Sum, Average, Highest, Lowest and Table.
  await page.locator("[data-connect-data]").click();
  await byHand(page);
  await page.locator(`[data-pick-integration="${promId}"]`).click();
  // Criterion 15: reads needing cAdvisor are hidden, and shown with Show all reads.
  await expect(page.locator('[data-pick-endpoint="containers"]')).toHaveCount(0);
  await page.locator("[data-pick-show-all] [role=switch], [data-pick-show-all] input, [data-pick-show-all] button").first().click();
  await expect(page.locator('[data-pick-endpoint="containers"]')).toBeVisible();
  await expect(page.locator('[data-pick-endpoint="containers"] [data-pick-endpoint-needs]')).toContainText("cAdvisor");
  await page.screenshot({ path: shot("show-all-reads-solid") });
  await page.locator('[data-pick-endpoint="machine-cpu"]').click();
  await page.locator('[data-pick-thing="*"]').click();
  await expect(page.locator("[data-pick-many]")).toHaveText("9 values, one per machine", { timeout: 3000 });
  for (const agg of ["sum", "avg", "max", "min"]) await expect(page.locator(`[data-pick-many-offer="${agg}"]`)).toBeVisible();
  await expect(page.locator("[data-pick-many-table]")).toBeVisible();
  await expect(page.locator("[data-pick-sample] tbody tr").first()).toBeVisible();
  await page.screenshot({ path: shot("many-values-solid") });
  await page.waitForTimeout(800);
  expect(nodeIn(await draft(id), "c_demanyaaaa")!.props.data).toBeUndefined(); // none chosen silently
  await page.locator('[data-pick-many-offer="max"]').click();
  await expect(canvasNode(page, "c_demanyaaaa").locator('[data-slot="value"]')).toHaveText("34.6", { timeout: 2000 });
  await page.locator("[data-pick-done]").click();
  const sources = (await draft(id)).doc.dataSources.map((s) => s.name);
  // Criterion 10: Cancel, Escape and the close button each leave no source the picker added. Wave 2.9: a
  // chart's picker is "What should this show?" in line mode (no by-hand step), which adds nothing until a pick.
  const rev0 = (await draft(id)).rev;
  for (const how of ["cancel", "escape", "close"] as const) {
    await selectLayer(page, "c_dechartaaa");
    await page.locator("[data-connect-data]").click();
    await expect(showPicker(page)).toHaveAttribute("data-mode", "line");
    await page.locator("[data-show-search]").fill("cpu");
    await expect(page.locator(`[data-show-item][data-show-endpoint="machine-cpu"]`).first()).toBeVisible({ timeout: 3000 });
    if (how === "cancel") await page.locator("[data-pick-cancel]").click();
    if (how === "escape") await page.keyboard.press("Escape");
    if (how === "close") await page.locator('[data-sheet="data-picker"] button[aria-label="Close"]').click();
    await expect(showPicker(page)).toHaveCount(0);
    const back = await draft(id);
    expect(back.doc.dataSources.map((s) => s.name), how).toEqual(sources);
    expect(back.rev, how).toBe(rev0);
  }
  // Criterion 14: a chart of CPU for every machine names each line by the machine's name.
  await selectLayer(page, "c_dechartaaa");
  await page.locator("[data-connect-data]").click();
  await page.locator("[data-show-search]").fill("cpu");
  const cpu = page.locator(`[data-show-item][data-show-integration="${promId}"][data-show-endpoint="machine-cpu"][data-show-thing-value="${ACE}"]`).first();
  await expect(cpu).toBeVisible({ timeout: 3000 });
  await cpu.click();
  await expect(showPicker(page)).toHaveCount(0);
  await selectLayer(page, "c_dechartaaa");
  const g = page.locator('section[data-inspector-group="data"]');
  if ((await g.getAttribute("data-open")) === null) await g.locator("h3 > button").click();
  await page.locator('[data-also-for="*"]').click();
  await expect(page.locator('[data-chart-line="1"] [data-chart-line-words]')).toContainText("9 lines", { timeout: 15_000 });
  const legend = canvasNode(page, "c_dechartaaa").locator("[data-legend-line]");
  await expect.poll(async () => (await legend.allTextContents()).length, { timeout: 8000 }).toBeGreaterThan(1);
  const lines = await legend.allTextContents();
  log("chart legend", lines);
  expect(lines.join(" ")).toContain("ACE");
  expect(lines.join(" ")).not.toMatch(/[{}="]|:9100/);
  await page.screenshot({ path: shot("chart-legend-solid") });
  await ctx.close();
});

test("criteria 18, 19, 21 (audit problems 12, 14): review lists an unused source with Remove; viewers see the title, never the slug; viewers get no choices", async ({ browser }) => {
  const slug = `de-review-${RUN}`;
  const used: Source = { name: "cpu_ace", label: "CPU in use, ACE", integrationId: promId, endpointId: "machine-cpu", refreshSec: 30, params: { machine: ACE } };
  const spare: Source = { name: "spare", label: "Memory in use, ACE", integrationId: promId, endpointId: "machine-memory", refreshSec: 30, params: { machine: ACE } };
  const id = await newApp(slug, [{ id: "c_dereviewst", type: "stat", props: { data: { $bind: "{{ cpu_ace }}" } } }], [used, spare]);
  const c = await api(OWNER);
  await c.put(`/api/apps/${id}/access`, { data: { view: "everyone", edit: "owner", guests: false } });
  const d0 = await draft(id);
  await c.post(`/api/apps/${id}/ops`, { data: { rev: d0.rev, ops: [{ op: "node.update", nodeId: "c_dereviewst", patch: { title: "CPU, ACE" } }] } });
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  await page.waitForTimeout(1500);
  await page.locator("[data-publish]").first().click();
  const row = page.locator('[data-review-unused="spare"]');
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row).toContainText("Memory in use, ACE is not shown by any widget.");
  await page.screenshot({ path: shot("review-unused-light") });
  await page.locator('[data-review-remove-source="spare"]').click();
  await expect(row).toHaveCount(0, { timeout: 5000 });
  const d = await untilDraft(id, (x) => x.doc.dataSources.length === 1);
  expect(d.doc.dataSources.map((s) => s.name)).toEqual(["cpu_ace"]);
  await page.locator("[data-publish-confirm]").click();
  await page.waitForTimeout(1500);
  await ctx.close();
  // Criterion 18: the viewer's title bar shows the widget's title, never the app slug or a template name.
  const v = await contextFor(browser, PEOPLE.viewer, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const vp = await v.newPage();
  await vp.goto(`/a/${slug}`);
  const bar = vp.locator('[data-node="c_dereviewst"] [data-titlebar-text]');
  await expect(bar).toHaveAttribute("data-titlebar-text", "CPU, ACE", { timeout: 5000 });
  const html = await vp.locator("[data-node='c_dereviewst']").innerHTML();
  expect(html).not.toContain(`${slug} /`);
  expect(html).not.toContain("cpu_ace");
  // The stat has no label: it shows the read's words, not raw label text.
  await expect(vp.locator('[data-node="c_dereviewst"] [data-slot="label"]')).toHaveText("CPU in use");
  await vp.screenshot({ path: shot("viewer-title-light") });
  // Criterion 21: a viewer asking for a thing list is refused, and sees no picker controls.
  const r = await vp.request.get(`/api/data/choices?integrationId=${promId}&endpointId=machine-cpu&param=machine`);
  expect([403, 404]).toContain(r.status());
  await vp.goto(`/build/${slug}`);
  await vp.waitForTimeout(800);
  expect(await vp.locator("[data-connect-data], [data-pick-button], [data-data-picker], [data-node-title]").count()).toBe(0);
  await v.close();
});

test("criterion 20 (audit problem 13): the Machines overview template, from New app, shows live values on every card at once", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-new-app], [data-new-app-tile]").first().click();
  await page.locator("[data-new-app-name]").fill(`Machines ${RUN}`);
  const opt = page.locator('[data-template-option="machines-overview"]');
  await expect(opt).toContainText("Needs Prometheus (connected)");
  await opt.click();
  await expect(page.locator('[data-map-integration="prometheus"]')).toBeVisible();
  await page.screenshot({ path: shot("template-needs-light") });
  await page.locator("[data-create-app]").click();
  await page.waitForURL(/\/build\//, { timeout: 15_000 });
  const slug = new URL(page.url()).pathname.split("/")[2]!;
  const items = page.locator('[data-canvas-root] [data-type="repeat"] [data-slot="item"]');
  await expect(items).toHaveCount(9, { timeout: 8000 });
  for (let i = 0; i < 9; i++) await expect(items.nth(i).locator('[data-slot="value"]').first()).not.toHaveText(/^\s*$/);
  await expect(items.filter({ hasText: "ACE" }).first()).toContainText("7.8");
  await page.screenshot({ path: shot("template-machines-light"), fullPage: true });
  log("template app", slug);
  await ctx.close();
});
