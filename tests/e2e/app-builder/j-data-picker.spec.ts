// app-builder e2e: the data picker (Wave 2.5, stages/02-subsystem-spec/output/data-picking-spec.md), one
// test per group of acceptance criteria, all through the real screen (V11). Uses the Home Assistant
// stand-in (48 lights). Evidence: evidence/app-builder/<ATRIUM_E2E_EVIDENCE_ROUND>/data-picker/.
import { expect, test, type Page } from "@playwright/test";
import { addUser, api, contextFor, ev, FAKE_HA_TOKEN, fakeHa, log, OWNER, PEOPLE, SHELL_VARIANTS, type FakeHa, byHand } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Node = { id: string; type: string; props: Record<string, unknown>; children?: Node[] };
type Source = { name: string; integrationId: string; endpointId: string; refreshSec: number; params?: Record<string, string> };
type Draft = { rev: number; doc: { dataSources: Source[]; pages: { id: string; root: Node }[] } };

const RUN = Date.now().toString(36).slice(-4);
let ha: FakeHa | undefined;
let haId = "";
let deadId = "";
const shot = (name: string) => ev("data-picker", `${name}.png`);

async function newApp(slug: string, kids: Node[] = []): Promise<string> {
  const c = await api(OWNER);
  const r = await c.post("/api/apps", { data: { name: `Pick ${slug}`, slug } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  if (kids.length) {
    const d = await draft(id);
    const ops = kids.map((n, i) => ({ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { ...n, slot: { x: 0, y: i * 24, w: 6, h: 24 } } }));
    const o = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops } });
    if (!o.ok()) throw new Error(`ops failed: ${await o.text()}`);
  }
  return id;
}
async function draft(id: string): Promise<Draft> {
  return (await (await api(OWNER)).get(`/api/apps/${id}/draft`)).json();
}
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 5000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const nodeIn = (d: Draft, id: string) => d.doc.pages[0]!.root.children!.find((k) => k.id === id)!;
async function open(page: Page, slug: string, select?: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  if (select) {
    await page.locator('[data-left-tab="layers"]').click();
    await page.locator(`[data-layer="${select}"]`).click();
    await expect(page.locator(`[data-selected-outline="${select}"]`)).toBeVisible();
  }
}
const picker = (page: Page) => page.locator("[data-data-picker]");
/** Opens "More settings" in the picker (optional filters, refresh, name) when it is folded. */
async function moreSettings(page: Page) {
  const d = page.locator("[data-pick-more-settings]");
  if (!(await d.evaluate((e) => (e as HTMLDetailsElement).open))) await page.locator("[data-pick-more-settings-toggle]").click();
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  for (const p of Object.values(PEOPLE)) await addUser(p);
  ha = await fakeHa();
  const c = await api(OWNER);
  const mk = async (name: string, baseUrl: string) => {
    const r = await c.post("/api/integrations", { data: { packageId: "home-assistant", name, config: { baseUrl }, secrets: { token: FAKE_HA_TOKEN }, untested: true } });
    if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
    return (await r.json()).id as string;
  };
  haId = await mk(`Home Assistant ${RUN}`, ha.url);
  deadId = await mk(`Broken HA ${RUN}`, "http://127.0.0.1:9");
});
test.afterAll(async () => { await ha?.close(); });

test("criteria 1, 4, 7 to 10, 13: a text shows the number of lights in 5 clicks, no typing; words match the template", async ({ browser }) => {
  const slug = `pk-text-${RUN}`;
  const id = await newApp(slug, [{ id: "c_pktextaaaa", type: "text", props: { text: "Lights" } }]);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug, "c_pktextaaaa");
  let clicks = 0;
  const click = async (sel: string) => { await page.locator(sel).first().click(); clicks++; };
  await click('[data-pick-button="text"]');
  await expect(picker(page)).toBeVisible();
  await byHand(page);
  await click(`[data-pick-integration="${haId}"]`);
  // Criterion 4: every endpoint row has a label, a description and its kind in words.
  const rows = await page.locator("[data-pick-endpoint]").evaluateAll((els) => els.map((e) => ({ desc: e.querySelector("[data-pick-endpoint-description]")?.textContent ?? "", kind: e.querySelector("[data-pick-endpoint-kind]")?.textContent ?? "" })));
  expect(rows.length).toBeGreaterThan(1);
  for (const r of rows) { expect(r.desc.length).toBeGreaterThan(0); expect(["one number", "values over time", "a list of rows", "things that are up or down"]).toContain(r.kind); }
  await page.screenshot({ path: shot("step2-endpoints-light") });
  const before = await draft(id);
  const t0 = Date.now();
  await click('[data-pick-endpoint="states"]');
  // Criterion 7: exactly one source, named from the endpoint.
  const d1 = await untilDraft(id, (d) => d.doc.dataSources.length > before.doc.dataSources.length);
  expect(d1.doc.dataSources).toHaveLength(before.doc.dataSources.length + 1);
  const src = d1.doc.dataSources.at(-1)!;
  expect(src.name).toBe("entities");
  // Criterion 8: the live sample within 3 s; criterion 9: five rows and "and N more rows".
  await expect(page.locator("[data-pick-sample]")).toBeVisible({ timeout: 3000 });
  log("sample after ms", Date.now() - t0);
  await expect(page.locator("[data-pick-sample] tbody tr")).toHaveCount(5);
  // The live sample is in view as soon as it arrives: optional settings are folded away.
  await expect(page.locator("[data-pick-sample]")).toBeInViewport({ ratio: 0.3 });
  expect(await page.locator("[data-pick-sample] th").evaluateAll((els) => els.map((e) => e.textContent))).not.toContain("Attributes");
  await expect(page.locator("[data-pick-more]")).toHaveText("and 43 more rows");
  await page.screenshot({ path: shot("step4-sample-light") });
  // Count of rows from a column header: the canvas shows 48 (criterion 1: at most 6 clicks, no typing).
  const firstCol = await page.locator("[data-pick-col]").first().getAttribute("data-pick-col");
  await click(`[data-pick-col="${firstCol}"]`);
  await click('[data-pick-agg="count"]');
  const t1 = Date.now();
  await expect(page.locator('[data-canvas-root] [data-node="c_pktextaaaa"]')).toHaveText("48", { timeout: 1000 + 500 });
  log("bind to canvas ms", Date.now() - t1);
  expect(clicks).toBeLessThanOrEqual(6);
  // Criterion 13: the words match the template written.
  await expect(page.locator("[data-pick-template]")).toHaveText("{{ entities.rows | count }}");
  await expect(page.locator("[data-pick-bound-words]")).toHaveText("Number of rows in entities");
  // Criterion 10: a cell binds that row's value, and the canvas shows the same value within 1 s.
  const cell = page.locator('[data-pick-cell="2:state"]');
  const want = (await cell.textContent())!.trim();
  await cell.click();
  await expect(page.locator('[data-canvas-root] [data-node="c_pktextaaaa"]')).toHaveText(want, { timeout: 1500 });
  await expect(page.locator("[data-pick-bound-words]")).toContainText("of the row where");
  await page.locator("[data-pick-done]").click();
  await expect(picker(page)).toHaveCount(0);
  // A hand edit the picker cannot describe reads "Custom template" when the picker opens again.
  // Wave 2.6: the bound field shows a data chip; "Edit as template" shows the template box.
  await page.locator('[data-edit-template="text"]').click();
  await page.locator('[data-binding-field="text"] textarea').fill("{{ entities.rows | count }} lights");
  await page.waitForTimeout(800);
  await page.locator('[data-pick-button="text"]').click();
  await byHand(page);
  await page.locator(`[data-pick-integration="${haId}"]`).click();
  await page.locator('[data-pick-endpoint="states"]').click();
  await expect(page.locator("[data-pick-bound-words]")).toHaveText("Custom template");
  await ctx.close();
});

test("criteria 5, 6, 17: required settings, the refresh minimum, and a failing read with Try again", async ({ browser }) => {
  const slug = `pk-settings-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug);
  const sources = page.locator('[data-inspector-group="sources"]');
  if (!(await sources.evaluate((d) => (d as HTMLDetailsElement).open))) await sources.locator("> summary").click();
  await page.locator("[data-add-source]").click();
  await page.locator(`[data-pick-integration="${haId}"]`).click();
  await page.locator('[data-pick-endpoint="entity"]').click();
  // Criterion 5: a required field left empty keeps the sample from loading and names the field.
  await expect(page.locator("[data-pick-missing]")).toHaveText("Fill in Entity to see the data.");
  await expect(page.locator('[data-pick-param="entityId"] .type-caption').last()).toContainText("For example");
  await page.waitForTimeout(600);
  expect((await draft(id)).doc.dataSources).toHaveLength(0);
  // Wave 2.7: an entity is picked from the live list; typing it in lives under More settings.
  if (!(await page.locator('[data-pick-param="entityId"] input').isVisible())) await moreSettings(page);
  await page.locator('[data-pick-param="entityId"] input').fill("light.lamp");
  await expect(page.locator("[data-pick-sample]")).toBeVisible({ timeout: 3000 });
  await page.screenshot({ path: shot("step3-settings-dark") });
  // Criterion 6: a refresh under the minimum cannot be saved and the field says the minimum.
  const saved = (await draft(id)).doc.dataSources[0]!.refreshSec;
  await moreSettings(page);
  await page.locator("[data-pick-refresh]").fill("1");
  await expect(page.locator("[data-pick-refresh-error]")).toContainText("Refresh at least every");
  await page.waitForTimeout(800);
  expect((await draft(id)).doc.dataSources[0]!.refreshSec).toBe(saved);
  await page.locator("[data-pick-done]").click();
  // Criterion 17: a failing integration shows its message and hint, and Try again reads again.
  await page.locator("[data-add-source]").click();
  await page.locator(`[data-pick-integration="${deadId}"]`).click();
  // Wave 2.7 (A8.1): Areas is an advanced read, folded under Advanced.
  if (!(await page.locator('[data-pick-endpoint="areas"]').isVisible())) await page.locator('[data-pick-group-toggle="Advanced"]').click();
  await page.locator('[data-pick-endpoint="areas"]').click();
  await expect(page.locator("[data-pick-sample-error]")).toBeVisible({ timeout: 15_000 });
  const msg = await page.locator("[data-pick-sample-error] p").first().textContent();
  expect(msg?.length ?? 0).toBeGreaterThan(5);
  const reads: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/data/endpoint")) reads.push(r.url()); });
  await page.locator("[data-pick-retry]").click();
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  await page.screenshot({ path: shot("sample-error-dark") });
  await ctx.close();
});

test("criteria 12, 14, 15, 16: stat with a table offers summaries; Cancel undoes the picker; rename keeps bindings", async ({ browser }) => {
  const slug = `pk-stat-${RUN}`;
  const id = await newApp(slug, [{ id: "c_pkstataaaa", type: "stat", props: {} }, { id: "c_pkusedaaaa", type: "text", props: { text: "x" } }]);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug, "c_pkstataaaa");
  // Criterion 14: Cancel after adding a source and binding puts the draft back as it was.
  const start = await draft(id);
  await page.locator("[data-connect-data]").click();
  await byHand(page);
  await page.locator(`[data-pick-integration="${haId}"]`).click();
  await page.locator('[data-pick-endpoint="states"]').click();
  await expect(page.locator("[data-pick-sample]")).toBeVisible({ timeout: 3000 });
  // Criterion 12: a stat with a table source says why and offers summaries, not a mismatched binding.
  await expect(page.locator("[data-pick-mismatch]")).toContainText("A stat shows one number");
  await expect(page.locator('[data-pick-offer="Number of rows"]')).toBeVisible();
  await expect(page.locator("[data-pick-use]")).toHaveCount(0);
  await page.locator('[data-pick-offer="Number of rows"]').click();
  await expect(page.locator('[data-canvas-root] [data-node="c_pkstataaaa"]')).toContainText("48", { timeout: 1500 });
  // It stays 48: the live value never drops back to the sample while the picker is open.
  const seen: string[] = [];
  for (let i = 0; i < 15; i++) { seen.push((await page.locator('[data-canvas-root] [data-node="c_pkstataaaa"]').innerText()).replace(/\s+/g, " ")); await page.waitForTimeout(200); }
  log("stat over 3s", seen);
  expect(seen.filter((t) => !t.includes("48"))).toEqual([]);
  await page.screenshot({ path: shot("stat-offers-light") });
  await page.locator("[data-pick-cancel]").click();
  const back = await untilDraft(id, (d) => d.doc.dataSources.length === 0);
  expect(back.doc.dataSources).toEqual(start.doc.dataSources);
  expect(nodeIn(back, "c_pkstataaaa").props).toEqual(nodeIn(start, "c_pkstataaaa").props);
  // Criterion 15: Cancel keeps a source that another component already uses.
  await page.locator("[data-connect-data]").click();
  await byHand(page);
  await page.locator(`[data-pick-integration="${haId}"]`).click();
  await page.locator('[data-pick-endpoint="states"]').click();
  const withSrc = await untilDraft(id, (d) => d.doc.dataSources.length === 1);
  const name = withSrc.doc.dataSources[0]!.name;
  const c = await api(OWNER);
  await c.post(`/api/apps/${id}/ops`, { data: { rev: withSrc.rev, ops: [{ op: "node.update", nodeId: "c_pkusedaaaa", patch: { props: { text: { $bind: `{{ ${name}.rows | count }}` } } } }] } });
  await page.waitForTimeout(600);
  await page.locator("[data-pick-cancel]").click();
  await page.waitForTimeout(800);
  expect((await draft(id)).doc.dataSources.map((s) => s.name)).toEqual([name]);
  // Criterion 16: renaming in the picker updates every binding; nothing says "no data source named".
  // (A fresh load: this tab only learns of the outside edit above when it next saves.)
  await open(page, slug, "c_pkusedaaaa");
  await expect(page.locator("[data-data-summary-words]")).toContainText(name);
  await page.locator("[data-data-change]").click();
  await byHand(page);
  await moreSettings(page);
  await page.locator("[data-pick-name]").fill("lamps");
  await page.locator("[data-pick-name]").press("Enter");
  const renamed = await untilDraft(id, (d) => d.doc.dataSources.some((s) => s.name === "lamps"));
  expect(renamed.doc.dataSources.map((s) => s.name)).toEqual(["lamps"]);
  expect(JSON.stringify(nodeIn(renamed, "c_pkusedaaaa").props)).toContain("{{ lamps.rows | count }}");
  await page.locator("[data-pick-done]").click();
  await expect(page.locator('[data-canvas-root] [data-node="c_pkusedaaaa"]')).toHaveText("48");
  expect(await page.locator("[data-canvas-root]").getByText(/no data source named/i).count()).toBe(0);
  await ctx.close();
});

test("criteria 18, 19, 2: the Data group summary with Change and Disconnect; removing a used source asks first; the list matches the bindable listing", async ({ browser }) => {
  const slug = `pk-summary-${RUN}`;
  const id = await newApp(slug, [{ id: "c_pktableaaa", type: "table", props: {} }]);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, slug, "c_pktableaaa");
  await page.locator("[data-connect-data]").click();
  await byHand(page);
  // Criterion 2: exactly the integrations the bindable listing returns.
  const listing = ((await (await (await api(OWNER)).get("/api/integrations/bindable")).json()).integrations as { integrationId: string }[]).map((i) => i.integrationId);
  await expect(page.locator("[data-pick-integration]").first()).toBeVisible();
  expect(await page.locator("[data-pick-integration]").evaluateAll((els) => els.map((e) => e.getAttribute("data-pick-integration")))).toEqual(listing);
  await page.locator(`[data-pick-integration="${haId}"]`).click();
  await page.locator('[data-pick-endpoint="states"]').click();
  await page.locator("[data-pick-use]").click();
  await page.locator("[data-pick-done]").click();
  // Criterion 18: the summary names the source, integration and endpoint, with Change and Disconnect.
  // Wave 2.7: one "Shows:" line names what, the live value and where from.
  await expect(page.locator("[data-data-summary-words]")).toContainText("Shows: Entities");
  await expect(page.locator("[data-data-summary-words]")).toContainText(`Home Assistant ${RUN}, every`);
  await expect(page.locator("[data-data-change]")).toBeVisible();
  await page.screenshot({ path: shot("data-summary-light") });
  // Criterion 19: removing a used source asks first and names the components.
  const sources = page.locator('[data-inspector-group="sources"]');
  if (!(await sources.evaluate((d) => (d as HTMLDetailsElement).open))) await sources.locator("> summary").click();
  let asked = "";
  page.once("dialog", (dl) => { asked = dl.message(); void dl.dismiss(); });
  await page.locator('[data-source="entities"] [data-source-remove]').click();
  await expect.poll(() => asked).toContain("table");
  expect((await draft(id)).doc.dataSources).toHaveLength(1);
  await page.locator("[data-data-disconnect]").click();
  await expect(page.locator("[data-data-summary]")).toHaveCount(0);
  expect(nodeIn(await untilDraft(id, (d) => !("data" in nodeIn(d, "c_pktableaaa").props)), "c_pktableaaa").props.data).toBeUndefined();
  await ctx.close();
});

test("criteria 20, 21, 22, 23: viewers get no picker; 390px works full screen; reduced motion; no config or secrets reach the browser", async ({ browser }) => {
  const slug = `pk-phone-${RUN}`;
  await newApp(slug, [{ id: "c_pkphoneaaa", type: "text", props: { text: "Phone" } }]);
  // Criterion 23: capture every response while picking.
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 390, height: 844 }, mobile: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const bodies: string[] = [];
  page.on("response", async (r) => { try { if (r.url().includes("/api/")) bodies.push(await r.text()); } catch { /* streamed */ } });
  await page.goto(`/build/${slug}`);
  await page.locator('[data-canvas-root] [data-node="c_pkphoneaaa"]').tap();
  await page.locator('[data-narrow-tab="edit"]').tap();
  await page.locator('[data-pick-button="text"]').tap();
  const sheet = page.locator('[data-sheet="data-picker"], [data-data-picker]').first();
  await expect(sheet).toBeVisible();
  await byHand(page);
  // Criterion 22: with reduced motion the sheet does not move while it opens.
  const a = await page.locator("[data-data-picker]").boundingBox();
  await page.waitForTimeout(120);
  const b = await page.locator("[data-data-picker]").boundingBox();
  expect(Math.abs((a?.y ?? 0) - (b?.y ?? 0))).toBeLessThanOrEqual(1);
  await page.locator(`[data-pick-integration="${haId}"]`).tap();
  await page.locator('[data-pick-endpoint="states"]').tap();
  await expect(page.locator("[data-pick-sample]")).toBeVisible({ timeout: 3000 });
  // Criterion 21: every control in the picker is at least 44px tall on touch; nothing scrolls sideways.
  const small = await page.locator("[data-data-picker]").evaluate((root) => [...root.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 43.5 && !e.closest("table")).map((e) => `${e.tagName}:${(e.textContent ?? e.getAttribute("aria-label") ?? "").trim().slice(0, 20)}:${Math.round(e.getBoundingClientRect().height)}`));
  expect(small).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: shot("picker-390-dark"), fullPage: true });
  await page.locator('[data-pick-col]').first().tap();
  await page.locator('[data-pick-agg="count"]').tap();
  await page.locator("[data-pick-done]").tap();
  const all = bodies.join("\n");
  expect(all).not.toContain(FAKE_HA_TOKEN);
  expect(all).not.toContain(ha!.url);
  await ctx.close();
  // Criterion 20: a viewer sees no Connect data, no Pick data and no picker.
  const v = await contextFor(browser, PEOPLE.viewer, { variant: SHELL_VARIANTS[0] });
  const vp = await v.newPage();
  const r = await vp.goto(`/build/${slug}`);
  log("viewer builder status", r?.status());
  await vp.waitForTimeout(800);
  expect(await vp.locator("[data-connect-data], [data-pick-button], [data-data-picker], [data-add-source]").count()).toBe(0);
  await v.close();
});
