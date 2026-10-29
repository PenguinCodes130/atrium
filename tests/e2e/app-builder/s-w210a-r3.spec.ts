// Wave 2.10a round 3, app-builder half: the gauntlet r2 recheck (stages/04-gauntlet/output/critics-w210a-r2/
// recheck.md) H1 builder side, M1, M2 and item 16. Each test walks the critic's first-timer path (Insert >
// Card for each, Skip, Pick data by service, every machine) through the real UI. Recorded failing first on
// the round 2 code (ATRIUM_E2E_W210_STAGE=failing-first), then passing. Evidence: evidence/lead/w210a-r3/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { api, contextFor, OWNER, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Source = { name: string; label?: string; managed?: boolean };
type Draft = { rev: number; doc: { dataSources: Source[]; pages: { id: string; slug: string; title: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/lead/w210a-r3", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const note = (name: string, data: unknown) => writeFileSync(out(`${name}.json`), JSON.stringify(data, null, 2));
const RUN = Date.now().toString(36).slice(-4);
const LIGHT = SHELL_VARIANTS[0]!;
const owner = () => api(OWNER);

let prom: FakePrometheus | undefined;
let promId = "";
test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  prom = await startFakePrometheus();
  const r = await (await owner()).post("/api/integrations", { data: { packageId: "prometheus", name: `R3 Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" }, secrets: {}, untested: true } });
  if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
  promId = (await r.json()).id as string;
});
test.afterAll(async () => { await prom?.close(); });

async function draft(id: string): Promise<Draft> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function newApp(slug: string, kids: Node[] = []): Promise<{ id: string; slug: string }> {
  const c = await owner();
  const r = await c.post("/api/apps", { data: { name: `R3 ${slug}`, slug, template: "blank" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  if (kids.length) {
    const d = await draft(id);
    const o = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: kids.map((node) => ({ op: "node.add", parentId: d.doc.pages[0]!.root.id, node })) } });
    if (!o.ok()) throw new Error(`ops failed: ${await o.text()}`);
  }
  return { id, slug };
}
const nodeIn = (d: Draft, id: string): Node | undefined => {
  const walk = (x: Node): Node | undefined => (x.id === id ? x : (x.children ?? []).map(walk).find(Boolean));
  for (const p of d.doc.pages) { const f = walk(p.root); if (f) return f; }
  return undefined;
};
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 10_000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-canvas-bar]")).toBeVisible();
}
async function selectLayer(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  const row = page.locator(`[data-layer="${id}"]`).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(`[data-selected-outline="${id}"]`)).toBeVisible();
}

/**
 * The critic's first-timer path (recheck f05, f06): Insert > Card for each, then in its own sheet the
 * service, Everything about a machine, Every machine, Done.
 */
async function cardsByService(page: Page, appId: string): Promise<{ repeat: string; card: string; source: Source }> {
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="card-for-each"]').first().click();
  const sheet = page.locator("[data-data-picker]");
  await expect(sheet).toBeVisible();
  const made = await untilDraft(appId, (d) => (d.doc.pages[0]!.root.children ?? []).some((k) => k.type === "repeat"));
  const repeat = made.doc.pages[0]!.root.children!.find((k) => k.type === "repeat")!.id;
  await page.locator(`[data-pick-integration="${promId}"]`).first().click({ timeout: 15_000 });
  await page.locator('[data-pick-endpoint="machine-summary"]').first().click();
  const every = sheet.locator("[data-pick-thing-param] button").filter({ hasText: /^Every machine/ }).first();
  await every.click({ timeout: 15_000 });
  const bound = await untilDraft(appId, (d) => (nodeIn(d, repeat)?.children ?? []).some((k) => k.type === "card") && d.doc.dataSources.length > 0, 20_000);
  expect((nodeIn(bound, repeat)?.children ?? []).some((k) => k.type === "card"), "the rows built the ready card").toBe(true);
  await expect(page.locator("[data-pick-cards]")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-pick-done]").first().click();
  await expect(sheet).toHaveCount(0);
  const items = page.locator(`[data-canvas-root] [data-node="${repeat}"] [data-slot="item"]`);
  await expect(items, "one card per machine").toHaveCount(9, { timeout: 10_000 });
  await page.waitForTimeout(1500);
  const settled = await draft(appId);
  return { repeat, card: nodeIn(bound, repeat)!.children!.find((k) => k.type === "card")!.id, source: settled.doc.dataSources[0]! };
}

test("M1 and M2: the ready card's {{ $item.name }} title is not flagged inside the repeat, and at Fit no stat value breaks inside its number", async ({ browser }) => {
  const app = await newApp(`r3-row-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  const { repeat, card } = await cardsByService(page, app.id);
  // M2: every stat value in the 808px canvas at Fit draws on one line (as the viewer does), its unit beside it.
  const broken = await page.locator(`[data-canvas-root] [data-node="${repeat}"] .atr-stat-line`).evaluateAll((lines) =>
    lines.map((l) => {
      const v = l.querySelector<HTMLElement>(".atr-stat-value")!;
      const u = l.querySelector<HTMLElement>(".atr-stat-unit");
      const range = document.createRange();
      range.selectNodeContents(v);
      const rows = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
      const ur = document.createRange();
      if (u) ur.selectNodeContents(u);
      const unitRows = u ? new Set(Array.from(ur.getClientRects()).map((r) => Math.round(r.top))).size : 0;
      // The value's right edge inside its stat: a number held on one line must not run past the stat.
      const stat = l.closest<HTMLElement>(".atr-stat")!;
      const spills = v.getBoundingClientRect().right > stat.getBoundingClientRect().right + 1;
      return { text: `${v.textContent}${u ? ` ${u.textContent}` : ""}`, valueLines: rows.size, unitLines: unitRows, spills };
    }).filter((x) => x.valueLines > 1 || x.unitLines > 1 || x.spills),
  );
  await page.screenshot({ path: out("m2-builder-fit.png") });
  // M1: the template card's own Title is not an error.
  await selectLayer(page, card);
  const insp = page.locator("[data-builder-inspector]");
  const title = insp.locator('[data-binding-field="title"], [data-binding-field="Title"]').first();
  await expect(title).toBeVisible();
  await page.waitForTimeout(700);
  const inside = { invalid: await title.locator("textarea").getAttribute("aria-invalid"), live: await title.locator("[data-live-value]").getAttribute("data-live-value"), words: await title.innerText() };
  await page.screenshot({ path: out("m1-title-inside.png") });
  note("m1-m2", { broken, inside });
  expect(broken, "stat values or units that break inside themselves, or run past their stat").toEqual([]);
  expect(inside.words, "inside the repeat").not.toContain("works only inside a repeat");
  expect(inside.invalid, "inside the repeat the field is not outlined red").toBeNull();
  expect(inside.live).toBe("ok");
  await ctx.close();
});

test("item 16: the repeat's inspector and the Publish summary name the Card for each source by its label, never its key", async ({ browser }) => {
  const app = await newApp(`r3-key-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  const { repeat, source } = await cardsByService(page, app.id);
  await selectLayer(page, repeat);
  const insp = page.locator("[data-builder-inspector]");
  await page.waitForTimeout(600);
  const sentence = await insp.locator("[data-data-sentence-text]").allInnerTexts();
  const chips = await insp.locator("[data-chip-line]").allInnerTexts();
  await page.screenshot({ path: out("item16-repeat-inspector.png") });
  await page.locator("[data-publish]").click();
  const sheet = page.locator("[role=dialog]").last();
  await expect(sheet.getByText(/what changes/i).first()).toBeVisible({ timeout: 6000 });
  await page.waitForTimeout(800);
  const summary = await sheet.innerText();
  await page.screenshot({ path: out("item16-publish.png") });
  note("item16", { source, sentence, chips, summary: summary.slice(0, 1500) });
  expect(source.label, "the source has a label to show").toBeTruthy();
  const key = new RegExp(`\\b${source.name}\\b`);
  for (const s of [...sentence, ...chips]) expect(s, "inspector words").not.toMatch(key);
  expect([...sentence, ...chips].join(" "), "the words name the source").toContain(source.label!.split(",")[0]!);
  expect(summary, "publish summary").not.toMatch(key);
  expect(summary).toContain(source.label!.split(",")[0]!);
  await ctx.close();
});

test("H1 (builder side): a Card for each drawn shorter than its cards opens grown in the builder, with no inner scroll", async ({ browser }) => {
  const rows = ["ACE", "firefly", "minipc-ubuntu", "Pelican", "pve1", "pve2", "pve3", "RP5-2", "RP5-3"].map((name, i) => ({ name, cpu: 7.8 + i }));
  const stat: Node = { id: "c_r3bstataaa", type: "stat", props: { value: { $bind: "{{ $item.cpu }}" }, label: "CPU", unit: "%" }, slot: { x: 0, y: 0, w: 6, h: 14 } };
  const card: Node = { id: "c_r3bcardaaa", type: "card", name: "Card for each row", props: { title: { $bind: "{{ $item.name }}" }, padded: true }, children: [{ id: "c_r3bgridaaa", type: "grid", props: { minRows: 1, gap: 8 }, children: [stat] }] };
  const rep: Node = { id: "c_r3breptaaa", type: "repeat", name: "Card for each", props: { items: rows, columns: 3, gap: 12 }, slot: { x: 0, y: 0, w: 12, h: 30 }, children: [card] };
  const app = await newApp(`r3-grow-${RUN}`, [rep]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await expect(page.locator(`[data-canvas-root] [data-node="${rep.id}"] [data-slot="item"]`)).toHaveCount(9);
  const grown = await untilDraft(app.id, (d) => (nodeIn(d, rep.id)?.slot?.h ?? 0) > 30, 8000);
  await page.waitForTimeout(1500);
  const m = await page.locator(`[data-canvas-root] [data-node="${rep.id}"] .atr-repeat`).first().evaluate((r) => ({ client: r.clientHeight, scroll: r.scrollHeight }));
  await page.screenshot({ path: out("h1-builder-open.png") });
  note("h1-builder", { h: nodeIn(grown, rep.id)?.slot?.h, m });
  expect(nodeIn(grown, rep.id)?.slot?.h ?? 0, "the repeat grew on open").toBeGreaterThan(30);
  expect(m.scroll, `cards ${m.scroll}px in ${m.client}px`).toBeLessThanOrEqual(m.client + 1);
  await ctx.close();
});

test("H1 follow-up (recheck r3): a Card for each settles; once settled, reopening the builder grows nothing and writes no draft change", async ({ browser }) => {
  const app = await newApp(`r3-settle-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  const { repeat } = await cardsByService(page, app.id);
  // The recheck saw the box grow on every open (7362, then 7794 px, a draft change each time). One later
  // growth may still land (a card's own clipped stat taking its room, the carried "opening writes a draft"
  // low); after that the size holds and opens write nothing.
  const heights: number[] = [];
  const revs: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (i) await openBuilder(page, app.slug);
    await page.waitForTimeout(11_000);
    const d = await draft(app.id);
    heights.push(nodeIn(d, repeat)!.slot!.h);
    revs.push(d.rev);
  }
  // The cards fill the box: no empty band below the last card.
  const slack = await page.locator(`[data-canvas-root] [data-node="${repeat}"]`).first().evaluate((n) => {
    const items = Array.from(n.querySelectorAll<HTMLElement>('[data-slot="item"]'));
    return n.getBoundingClientRect().bottom - Math.max(...items.map((i) => i.getBoundingClientRect().bottom));
  });
  await page.screenshot({ path: out("h1-settle.png") });
  note("h1-settle", { heights, revs, slack });
  expect(heights[3], "the size holds once settled").toBe(heights[2]);
  expect(revs[3], "a settled open writes nothing").toBe(revs[2]);
  expect(heights[3]! - heights[0]!, "at most one later growth, never a runaway").toBeLessThan(80);
  expect(slack, "no empty band below the cards").toBeLessThan(48);
  await ctx.close();
});
