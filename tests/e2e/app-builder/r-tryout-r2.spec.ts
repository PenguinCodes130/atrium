// Wave 2.10a round 2, app-builder half: the gauntlet r1 Fix List items for builder B
// (stages/04-gauntlet/output/wave-2-10a-gauntlet-r1.md, items 1, 8 to 14, 16, 17). Each test does what the
// critic did through the real UI and asserts the Fix List's pass (V11). It ran failing first on the
// unchanged code (ATRIUM_E2E_W210_STAGE=failing-first), then passing. Evidence: evidence/app-builder/w210a-r2/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { addUser, api, contextFor, OWNER, PEOPLE, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; title?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Source = { name: string; label?: string; managed?: boolean; integrationId: string; endpointId: string; refreshSec: number; params?: Record<string, unknown> };
type Draft = { rev: number; doc: { dataSources: Source[]; pages: { id: string; slug: string; title: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder/w210a-r2", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const note = (name: string, data: unknown) => writeFileSync(out(`${name}.json`), JSON.stringify(data, null, 2));
const RUN = Date.now().toString(36).slice(-4);
const LIGHT = SHELL_VARIANTS[0]!;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const enc = (v: number, len: number) => Array.from({ length: len }, (_, i) => B32[Math.floor(v / 32 ** (len - 1 - i)) % 32]).join("");
const RUN_N = parseInt(RUN, 36) % 32 ** 4;
let n = 0;
const cid = () => `c_${enc(RUN_N, 4)}${enc(n++, 6)}`;
const owner = () => api(OWNER);
const DID = /\bd_[a-z2-7]{8}\b/;

let prom: FakePrometheus | undefined;
let promId = "";
let otherPromId = "";

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  for (const p of Object.values(PEOPLE)) await addUser(p);
  prom = await startFakePrometheus();
  const c = await owner();
  const r = await c.post("/api/integrations", { data: { packageId: "prometheus", name: `R2 Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" }, secrets: {}, untested: true } });
  if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
  promId = (await r.json()).id as string;
  // Another person's integration on the same instance (the first-timer saw other critics' services pre-ticked).
  const e = await api(PEOPLE.editor);
  const r2 = await e.post("/api/integrations", { data: { packageId: "prometheus", name: `Erin Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" }, secrets: {}, untested: true } });
  if (!r2.ok()) throw new Error(`integration 2: ${await r2.text()}`);
  otherPromId = (await r2.json()).id as string;
});
test.afterAll(async () => { await prom?.close(); });

async function draft(id: string): Promise<Draft> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function ops(id: string, list: unknown[]) {
  const d = await draft(id);
  const r = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
}
async function newApp(slug: string, kids: Node[] = [], extra: unknown[] = [], template = "blank"): Promise<{ id: string; slug: string; root: string }> {
  const r = await (await owner()).post("/api/apps", { data: { name: `R2 ${slug}`, slug, template } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  const root = (await draft(id)).doc.pages[0]!.root.id;
  const list: unknown[] = [...kids.map((node) => ({ op: "node.add", parentId: root, node })), ...extra];
  if (list.length) await ops(id, list);
  return { id, slug, root };
}
async function publish(id: string) {
  const c = await owner();
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note: "r2" } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}
const nodeIn = (d: Draft, id: string): Node | undefined => {
  const walk = (x: Node): Node | undefined => (x.id === id ? x : (x.children ?? []).map(walk).find(Boolean));
  for (const p of d.doc.pages) { const f = walk(p.root); if (f) return f; }
  return undefined;
};
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
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
  const row = page.locator(`[data-layer="${id}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(`[data-selected-outline="${id}"]`)).toBeVisible();
}
async function key(page: Page, combo: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(combo);
}

/**
 * Fit components cut by their box on a canvas (`scope`): for each node directly in a fixed-row grid whose
 * cell says it fits its content, the most any clipping box inside it (or itself) hides, in px.
 */
async function cropped(page: Page, scope: string) {
  return page.evaluate((scope) => {
    const outList: { id: string; type: string; hidden: number; at: string }[] = [];
    const cells = Array.from(document.querySelectorAll(`${scope} .atr-grid > .atr-cell[data-sizing="fit"] > [data-node]`)) as HTMLElement[];
    for (const el of cells) {
      let worst = 0;
      let at = "";
      for (const e of [el, ...(Array.from(el.querySelectorAll("*")) as HTMLElement[])]) {
        const cs = getComputedStyle(e);
        if (cs.position === "absolute" || cs.position === "fixed" || cs.display === "none") continue;
        if (!/hidden|clip|auto|scroll/.test(cs.overflowY) && !/hidden|clip|auto|scroll/.test(cs.overflow)) continue;
        if (e.clientHeight < 4) continue;
        const d = e.scrollHeight - e.clientHeight;
        if (d > worst) { worst = d; at = `${e.tagName}.${String(e.className).slice(0, 40)}`; }
      }
      // The node's box against its cell's drawn rows: content taller than the slot spills or is cut.
      const cell = el.parentElement as HTMLElement;
      const spill = Math.max(0, Math.ceil(el.scrollHeight - cell.getBoundingClientRect().height));
      if (spill > worst) { worst = spill; at = "cell"; }
      if (worst > 2) outList.push({ id: el.getAttribute("data-node") ?? "", type: el.getAttribute("data-type") ?? "", hidden: worst, at });
    }
    return outList;
  }, scope);
}

// ---------------------------------------------------------------------------------------------------------
// Item 1 [high]: edit mode shows the same content as the viewer, nothing cut off.
test("item 1: right after Create app from the start page template, the canvas shows every component whole, like the viewer", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-new-app], [data-new-app-tile]").first().click();
  const slug = `r2-start-${RUN}`;
  await page.locator("[data-new-app-name]").fill(`R2 start ${RUN}`);
  await page.locator("[data-new-app-slug]").fill(slug);
  await page.locator('[data-template-option="start-page"]').click();
  await expect(page.locator("[data-start-form]")).toBeVisible();
  await page.locator("[data-start-link-name]").fill("Jellyfin e2e");
  await page.locator("[data-start-link-href]").fill("http://10.0.0.5:8096");
  await page.locator("[data-start-link-add]").click();
  await page.locator("[data-create-app]").click();
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  // Live stats arrive over a few seconds.
  await page.waitForTimeout(7000);
  const edit = await cropped(page, "[data-canvas-root]");
  await page.screenshot({ path: out("item1-start-builder.png") });
  const view = await ctx.newPage();
  await view.goto(`/a/${slug}?draft=1`);
  await view.waitForTimeout(4000);
  const viewer = await cropped(view, "[data-app-page]");
  await view.screenshot({ path: out("item1-start-viewer.png") });
  note("item1-start", { edit, viewer });
  expect(viewer, "the viewer never cuts a fit component").toEqual([]);
  expect(edit, "edit mode cuts nothing either").toEqual([]);
  await ctx.close();
});

test("item 1: an existing app with boxes too small for their content opens uncropped in the builder", async ({ browser }) => {
  const card = cid();
  const kids: Node[] = [
    { id: card, type: "card", title: "Rack", props: {}, slot: { x: 0, y: 0, w: 4, h: 6 }, children: [{ id: cid(), type: "stat", props: { label: "CPU", value: 42, unit: "%" } }] },
    { id: cid(), type: "stat", props: { label: "Disks", value: 7 }, slot: { x: 4, y: 0, w: 3, h: 5 } },
    { id: cid(), type: "text", props: { text: "A longer line of text that wraps over a few lines in a narrow box on the builder canvas, so it needs more rows than it was drawn with." }, slot: { x: 7, y: 0, w: 3, h: 4 } },
  ];
  const app = await newApp(`r2-old-${RUN}`, kids);
  await publish(app.id);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.waitForTimeout(2500);
  const edit = await cropped(page, "[data-canvas-root]");
  await page.screenshot({ path: out("item1-old-builder.png") });
  const view = await ctx.newPage();
  await view.goto(`/a/${app.slug}`);
  await view.waitForTimeout(1500);
  const viewer = await cropped(view, "[data-app-page]");
  await view.screenshot({ path: out("item1-old-viewer.png") });
  note("item1-old", { edit, viewer });
  expect(viewer).toEqual([]);
  expect(edit, "an old app opens with nothing cut").toEqual([]);
  // The growth is one undo step: Ctrl+Z puts the drawn boxes back.
  const grown = await draft(app.id);
  expect(nodeIn(grown, card)!.slot!.h).toBeGreaterThan(6);
  await key(page, "Control+z");
  const back = await untilDraft(app.id, (d) => nodeIn(d, card)!.slot!.h === 6);
  expect(nodeIn(back, card)!.slot!.h).toBe(6);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 8 [medium]: a theme that differs from the last published snapshot counts as a change.
test("item 8: a saved theme edit after publish shows Theme changed since v1 and lights Publish", async ({ browser }) => {
  const c = await owner();
  const dup = await c.post("/api/settings/themes/control-room/duplicate");
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const themeId = (await dup.json()).id as string;
  const app = await newApp(`r2-theme-${RUN}`, [{ id: cid(), type: "stat", props: { label: "CPU", value: 4 }, slot: { x: 0, y: 0, w: 3, h: 24 } }], [{ op: "theme.set", theme: { themeId } }]);
  await publish(app.id);
  const cur = await (await c.get(`/api/settings/themes/${themeId}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = `R2 theme ${RUN}`;
  theme.tokens.space = { ...theme.tokens.space, density: "compact" };
  const put = await c.put(`/api/settings/themes/${themeId}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  const status = page.locator("[data-draft-status]");
  await expect(status).toContainText("Theme changed since v1", { timeout: 6000 });
  await expect(page.locator('[data-door="outlined"]')).toHaveCount(1);
  await page.locator("[data-publish]").click();
  await expect(page.getByText(/theme .*changed since v1/i).first()).toBeVisible({ timeout: 6000 });
  await expect(page.locator("[data-publish-confirm]")).toBeEnabled();
  await page.screenshot({ path: out("item8-review.png") });
  await page.locator("[data-publish-confirm]").click();
  await expect(status).not.toContainText("Theme changed", { timeout: 8000 });
  await page.screenshot({ path: out("item8-after-publish.png") });
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 9 [medium]: the selection frame and handles follow a resize or drop on the same frame.
async function frameLag(page: Page, nodeId: string, act: () => Promise<void>) {
  await page.evaluate((id) => {
    const w = window as unknown as { __lag: { t: number; node: number[]; frame: number[] | null }[]; __stop: boolean };
    w.__lag = [];
    w.__stop = false;
    const tick = () => {
      const n = document.querySelector(`[data-canvas-root] [data-node="${id}"]`)?.getBoundingClientRect();
      const f = document.querySelector(`[data-selected-outline="${id}"]`)?.getBoundingClientRect();
      if (n) w.__lag.push({ t: performance.now(), node: [n.left, n.top, n.width, n.height], frame: f ? [f.left, f.top, f.width, f.height] : null });
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, nodeId);
  await act();
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const w = window as unknown as { __lag: { t: number; node: number[]; frame: number[] | null }[]; __stop: boolean };
    w.__stop = true;
    return w.__lag;
  });
}
const lagFrames = (log: { node: number[]; frame: number[] | null }[]) => log.filter((s) => s.frame && s.node.some((v, i) => Math.abs(v - s.frame![i]!) > 2.5)).length;

test("item 9: after a resize and after a drop the selection frame and handles match the box on every frame", async ({ browser }) => {
  const stat = cid();
  const app = await newApp(`r2-glide-${RUN}`, [{ id: stat, type: "stat", props: { label: "CPU", value: 4 }, slot: { x: 0, y: 0, w: 3, h: 24 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator(`[data-canvas-root] [data-node="${stat}"]`).click();
  await expect(page.locator(`[data-selected-outline="${stat}"]`)).toBeVisible();
  await page.waitForTimeout(400);
  const h = (await page.locator('[data-resize-handle="se"]').boundingBox())!;
  const resize = await frameLag(page, stat, async () => {
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(h.x + h.width / 2 + i * 14, h.y + h.height / 2 + i * 6);
    await page.mouse.up();
  });
  const after = await untilDraft(app.id, (d) => nodeIn(d, stat)!.slot!.w > 3);
  expect(nodeIn(after, stat)!.slot!.w).toBeGreaterThan(3);
  await page.waitForTimeout(400);
  const grip = (await page.locator("[data-drag-handle]").boundingBox())!;
  const drop = await frameLag(page, stat, async () => {
    await page.mouse.move(grip.x + 10, grip.y + grip.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(grip.x + 10 + i * 25, grip.y + grip.height / 2 + i * 12);
    await page.mouse.up();
  });
  note("item9", { resizeLag: lagFrames(resize), dropLag: lagFrames(drop), resize: resize.slice(-30), drop: drop.slice(-30) });
  expect(lagFrames(resize), "frames where the outline does not match the box after a resize").toBe(0);
  expect(lagFrames(drop), "frames where the outline does not match the box after a drop").toBe(0);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 10 [medium], AppChrome half: phone nav on one line; Boxed tabs joined to the rule.
test("item 10: at 390 px a three-page nav sits on one line, and Boxed tabs meet the rule", async ({ browser }) => {
  const c = await owner();
  const dup = await c.post("/api/settings/themes/control-room/duplicate");
  const themeId = (await dup.json()).id as string;
  const cur = await (await c.get(`/api/settings/themes/${themeId}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = `R2 boxed ${RUN}`;
  theme.tokens.chrome = { ...theme.tokens.chrome, style: "boxed-tabs" };
  expect((await c.put(`/api/settings/themes/${themeId}`, { data: { theme, rev: cur.rev } })).status()).toBe(200);
  const extra = ["Rack", "Media services"].map((t, i) => ({ op: "page.add", page: { id: `p_${enc(RUN_N, 4)}${enc(i, 6)}`, slug: `p${i}-${RUN}`, title: t, inNav: true, root: { id: cid(), type: "grid", props: {}, children: [] } } }));
  const app = await newApp(`r2-nav-${RUN}`, [{ id: cid(), type: "stat", props: { label: "CPU", value: 4 }, slot: { x: 0, y: 0, w: 3, h: 24 } }], [...extra, { op: "theme.set", theme: { themeId } }]);
  await publish(app.id);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 390, height: 844 }, mobile: true });
  const page = await ctx.newPage();
  await page.goto(`/a/${app.slug}`);
  const nav = page.locator("[data-canvas-nav]");
  await expect(nav).toBeVisible();
  const m = await page.evaluate(() => {
    const navEl = document.querySelector("[data-canvas-nav]") as HTMLElement;
    const r = navEl.getBoundingClientRect();
    const items = Array.from(navEl.querySelectorAll("[data-app-nav-item]")).map((a) => { const b = a.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height }; });
    return { navH: r.height, navBottom: r.bottom, items, pageScroll: document.documentElement.scrollWidth };
  });
  await page.screenshot({ path: out("item10-phone-boxed.png") });
  note("item10", m);
  expect(new Set(m.items.map((i) => Math.round(i.top))).size, "every nav item on one line").toBe(1);
  expect(m.navH).toBeLessThanOrEqual(64);
  for (const i of m.items) expect(Math.abs(i.bottom - m.navBottom), "boxed tab joined to the rule").toBeLessThanOrEqual(1.5);
  expect(m.pageScroll).toBeLessThanOrEqual(390);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 11 [high]: inside a repeat, Pick data lists "This row" and its fields first.
test("item 11: Insert Card for each, Skip, then bind it by service: 9 ready cards titled by machine, and a child's Pick data offers This row first", async ({ browser }) => {
  const app = await newApp(`r2-row-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  // The first-timer's path: Insert > Card for each, Skip the sheet, then the repeat's own Pick data by service.
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="card-for-each"]').first().click();
  const sheet0 = page.locator("[data-data-picker]");
  await expect(sheet0).toBeVisible();
  await page.locator("[data-pick-skip], [data-pick-cancel]").first().click();
  await expect(sheet0).toHaveCount(0);
  const made = await untilDraft(app.id, (d) => (d.doc.pages[0]!.root.children ?? []).some((k) => k.type === "repeat"));
  const repeat = made.doc.pages[0]!.root.children!.find((k) => k.type === "repeat")!.id;
  await selectLayer(page, repeat);
  await page.locator("[data-builder-inspector]").getByRole("button", { name: "Pick data" }).first().click();
  await page.locator(`[data-show-service="${promId}"]`).click();
  await page.locator("[data-show-things] [data-show-thing]").filter({ hasText: /every/i }).first().click();
  await page.locator('[data-show-endpoint="machine-summary"], [data-show-endpoint="machines-overview"]').first().click();
  const bound = await untilDraft(app.id, (d) => JSON.stringify(nodeIn(d, repeat)?.props.items ?? "").includes("{{"));
  expect(JSON.stringify(nodeIn(bound, repeat)!.props.items)).toContain("{{");
  const items = page.locator(`[data-canvas-root] [data-node="${repeat}"] [data-slot="item"]`);
  await expect(items, "one card per machine").toHaveCount(9, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out("item11-ready-cards.png") });
  // Ready cards: each is titled with its machine's name, so ACE and pve1 each show once.
  await expect(items.filter({ hasText: "ACE" }), "a card titled ACE").toHaveCount(1, { timeout: 6000 });
  await expect(items.filter({ hasText: "pve1" })).toHaveCount(1);
  // A child's Pick data: This row with its fields comes first.
  const withCard = await draft(app.id);
  const child = nodeIn(withCard, repeat)!.children![0]!;
  await items.first().locator(`[data-node="${child.id}"]`).first().click({ position: { x: 60, y: 36 } });
  await expect(page.locator(`[data-selected-outline="${child.id}"]`)).toBeVisible();
  await page.locator("[data-builder-inspector]").getByRole("button", { name: "Pick data" }).first().click();
  const sheet = page.locator("[role=dialog]").last();
  await expect(sheet).toBeVisible();
  const first = sheet.locator("[data-pick-this-row], [data-show-this-row]").first();
  await expect(first, "This row is offered").toBeVisible({ timeout: 4000 });
  await expect(first).toContainText("This row");
  await expect(first).toContainText(/name/i);
  await page.screenshot({ path: out("item11-this-row.png") });
  await ctx.close();
});

test("item 11: a Card inserted into a bound repeat by hand gets This row in Pick data (Layers path)", async ({ browser }) => {
  const repeat = cid();
  const app = await newApp(`r2-rowb-${RUN}`, [{ id: repeat, type: "repeat", name: "Card for each", props: { columns: 3, max: 50, empty: "Nothing to show" }, children: [{ id: cid(), type: "text", props: { text: "x" } }], slot: { x: 0, y: 0, w: 12, h: 30 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await selectLayer(page, repeat);
  await page.locator("[data-builder-inspector]").getByRole("button", { name: "Pick data" }).first().click();
  await page.locator(`[data-show-service="${promId}"]`).click();
  await page.locator("[data-show-things] [data-show-thing]").filter({ hasText: /every/i }).first().click();
  await page.locator('[data-show-endpoint="machine-summary"], [data-show-endpoint="machines-overview"]').first().click();
  await untilDraft(app.id, (d) => JSON.stringify(nodeIn(d, repeat)?.props.items ?? "").includes("{{"));
  const child = nodeIn(await draft(app.id), repeat)!.children![0]!;
  // The copies draw once the rows arrive.
  // Lead follow-up: the binding must still be there once the pick has settled (it was dropped when the read's
  // value was already known).
  await page.waitForTimeout(1500);
  expect(JSON.stringify(nodeIn(await draft(app.id), repeat)!.props.items), "the repeat keeps its binding").toContain("{{");
  await expect(page.locator(`[data-canvas-root] [data-node="${repeat}"] [data-slot="item"]`).first()).toBeVisible({ timeout: 10_000 });
  await selectLayer(page, child.id);
  await page.locator("[data-builder-inspector]").getByRole("button", { name: "Pick data" }).first().click();
  const sheet = page.locator("[role=dialog]").last();
  const first = sheet.locator("[data-pick-this-row], [data-show-this-row]").first();
  await expect(first).toBeVisible({ timeout: 4000 });
  await expect(first).toContainText("This row");
  await first.getByRole("button").filter({ hasText: /name/i }).first().click();
  const done = sheet.locator("[data-pick-done]");
  if (await done.isVisible().catch(() => false)) await done.click();
  const titled = await untilDraft(app.id, (d) => JSON.stringify(nodeIn(d, child.id)).includes("$item.name"));
  expect(JSON.stringify(nodeIn(titled, child.id))).toContain("$item.name");
  await ctx.close();
});

test("item 11: a wrong guess like {{ row.name }} inside a repeat suggests $item", async ({ browser }) => {
  const repeat = cid();
  const text = cid();
  const app = await newApp(`r2-guess-${RUN}`, [{ id: repeat, type: "repeat", props: { items: [{ name: "a" }, { name: "b" }], columns: 2 }, children: [{ id: text, type: "text", props: { text: "Row" } }], slot: { x: 0, y: 0, w: 12, h: 20 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await selectLayer(page, text);
  const insp = page.locator("[data-builder-inspector]");
  const live = insp.getByRole("button", { name: /live data/i }).first();
  if (await live.count()) await live.click();
  const field = insp.locator('[data-binding-field] textarea').first();
  await field.fill("{{ row.name }}");
  await page.waitForTimeout(700);
  // The field's own words (components') and the builder's row hint above the groups.
  const words = await insp.innerText();
  note("item11-guess", { words });
  await page.screenshot({ path: out("item11-guess.png") });
  expect(words).toContain("$item");
  expect(words).not.toMatch(DID);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 12 [medium]: Layers > More > Delete on a repeat removes it (with undo).
test("item 12: Layers More Delete removes a repeat with a card in it, and undo brings it back", async ({ browser }) => {
  const repeat = cid();
  const app = await newApp(`r2-del-${RUN}`, [{ id: repeat, type: "repeat", props: { items: [{ name: "a" }, { name: "b" }], columns: 2 }, children: [{ id: cid(), type: "card", title: "Card", props: {} }], slot: { x: 0, y: 0, w: 12, h: 20 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator('[data-left-tab="layers"]').click();
  const row = page.locator(`[data-layer="${repeat}"]`);
  await row.hover();
  await row.locator("[data-layer-menu]").click();
  await page.locator("[data-layer-delete]").click();
  const gone = await untilDraft(app.id, (d) => !nodeIn(d, repeat));
  await page.screenshot({ path: out("item12-deleted.png") });
  expect(nodeIn(gone, repeat), "the repeat is deleted").toBeUndefined();
  await key(page, "Control+z");
  const back = await untilDraft(app.id, (d) => !!nodeIn(d, repeat));
  expect(nodeIn(back, repeat)).toBeTruthy();
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 13 [medium]: Pages > Add a page visibly adds and opens the page, with a name field focused.
test("item 13: Pages Add a page adds a page, opens it and focuses its name", async ({ browser }) => {
  const app = await newApp(`r2-page-${RUN}`, [{ id: cid(), type: "stat", props: { label: "CPU", value: 4 }, slot: { x: 0, y: 0, w: 3, h: 24 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator("[data-page-menu]").first().click();
  await page.locator("[data-page-add]").click();
  const two = await untilDraft(app.id, (d) => d.doc.pages.length === 2, 4000);
  await page.screenshot({ path: out("item13-added.png") });
  expect(two.doc.pages.length, "a page was added").toBe(2);
  const added = two.doc.pages.find((p) => p.id !== two.doc.pages[0]!.id)!;
  await expect(page).toHaveURL(new RegExp(`/build/${app.slug}/${added.slug}$`));
  const focused = await page.evaluate(() => { const a = document.activeElement as HTMLInputElement | null; return a?.tagName === "INPUT" ? a.value : null; });
  expect(focused, "the new page's name field is focused").toBe(added.title);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Rack");
  await page.keyboard.press("Enter");
  const named = await untilDraft(app.id, (d) => d.doc.pages.some((p) => p.title === "Rack"));
  expect(named.doc.pages.some((p) => p.title === "Rack")).toBe(true);
  await expect(page.locator("[data-page-switcher]")).toContainText("Rack");
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 14 [medium]: a table inserts wide enough for its columns; Fit never says "fits" while columns hide.
test("item 14: a new table bound to every machine shows its columns, and Fit is honest about hidden ones", async ({ browser }) => {
  const app = await newApp(`r2-table-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="table"]').first().click();
  await page.locator(`[data-show-service="${promId}"]`).click();
  await page.locator("[data-show-things] [data-show-thing]").filter({ hasText: /every/i }).first().click();
  await page.locator('[data-show-endpoint="machine-summary"], [data-show-endpoint="machines-overview"]').first().click();
  const d = await untilDraft(app.id, (x) => (x.doc.pages[0]!.root.children ?? []).some((k) => k.type === "table" && JSON.stringify(k.props).includes("{{")));
  const table = d.doc.pages[0]!.root.children!.find((k) => k.type === "table")!;
  await page.waitForTimeout(2500);
  const hidden = () => page.evaluate((id) => {
    const el = document.querySelector(`[data-canvas-root] [data-node="${id}"]`);
    let worst = 0;
    for (const e of el ? [el, ...Array.from(el.querySelectorAll("*"))] as HTMLElement[] : []) {
      const cs = getComputedStyle(e);
      if (!/hidden|clip|auto|scroll/.test(cs.overflowX)) continue;
      if (cs.position === "absolute") continue;
      worst = Math.max(worst, e.scrollWidth - e.clientWidth);
    }
    return worst;
  }, table.id);
  const atInsert = await hidden();
  await page.screenshot({ path: out("item14-inserted.png") });
  if (!(await page.locator(`[data-selected-outline="${table.id}"]`).isVisible())) await selectLayer(page, table.id);
  const layout = page.locator('[data-inspector-group="layout"]');
  if (!(await layout.evaluate((e) => (e as HTMLDetailsElement).open))) await layout.locator("summary").click();
  await page.locator("[data-layout-fit]").click();
  await page.waitForTimeout(1500);
  const noteText = (await page.locator("[data-layout-fit-note]").textContent()) ?? "";
  const afterFit = await hidden();
  await page.screenshot({ path: out("item14-after-fit.png") });
  note("item14", { atInsert, afterFit, noteText, slot: (await draft(app.id)).doc.pages[0]!.root.children!.find((k) => k.id === table.id)!.slot });
  expect(atInsert, "columns hidden behind a sideways scroll at insert (px)").toBeLessThanOrEqual(2);
  if (afterFit > 2) expect(noteText).not.toMatch(/already shows all its content/i);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 16 [medium]: no d_... ids anywhere a person reads.
test("item 16: a stat bound by service shows no internal ids in the inspector, the sources list or the publish summary", async ({ browser }) => {
  const app = await newApp(`r2-ids-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="table"]').first().click();
  await page.locator(`[data-show-service="${promId}"]`).click();
  await page.locator("[data-show-things] [data-show-thing]").filter({ hasText: /every/i }).first().click();
  await page.locator('[data-show-endpoint="machine-summary"], [data-show-endpoint="machines-overview"]').first().click();
  const d = await untilDraft(app.id, (x) => x.doc.dataSources.length > 0);
  expect(d.doc.dataSources[0]!.name).toMatch(DID);
  await page.waitForTimeout(1200);
  const insp = page.locator("[data-builder-inspector]");
  for (const g of await insp.locator("details[data-inspector-group]").all()) if (!(await g.evaluate((e) => (e as HTMLDetailsElement).open))) await g.locator("summary").click();
  for (const m of await insp.getByRole("button", { name: /more settings/i }).all()) await m.click().catch(() => {});
  await page.waitForTimeout(400);
  // The inspector's own words (B): everything but components' Source dropdown, which is checked on its own below.
  const words = await insp.evaluate((el) => { const c = el.cloneNode(true) as HTMLElement; c.querySelectorAll("select").forEach((x) => x.remove()); document.body.appendChild(c); const t = c.innerText; c.remove(); return t; });
  const options = await insp.locator("select option").allTextContents();
  await page.screenshot({ path: out("item16-inspector.png"), fullPage: true });
  await page.locator("[data-publish]").click();
  const sheet = page.locator("[role=dialog]").last();
  await expect(sheet.getByText(/what changes/i).first()).toBeVisible({ timeout: 6000 });
  await page.waitForTimeout(800);
  const summary = await sheet.innerText();
  await page.screenshot({ path: out("item16-publish.png") });
  note("item16", { inspector: words.match(new RegExp(DID.source, "g")), options, summary: summary.slice(0, 2000) });
  expect(summary, "publish summary").not.toMatch(DID);
  expect(words, "inspector text").not.toMatch(DID);
  // components' Source dropdown (src/features/components/inspector/inspector.tsx) lists sources by name:
  // an Interface request to builder C this round; recorded, not asserted here.
  note("item16-source-dropdown", { options, ids: options.filter((o) => DID.test(o)) });
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------
// Item 17 [medium] and the low "Your services": the New app sheet's machine list stays in its frame and
// reaches the person's own machines; other people's services are not pre-ticked.
test("item 17: the start page form names what happens to machines (F1: no list to escape the sheet), and others' services start unticked", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-new-app], [data-new-app-tile]").first().click();
  await page.locator("[data-new-app-name]").fill(`R2 machines ${RUN}`);
  await page.locator('[data-template-option="start-page"]').click();
  await expect(page.locator("[data-start-form]")).toBeVisible();
  await page.waitForTimeout(1500);
  const mine = page.locator(`[data-start-service="${promId}"]`);
  const theirs = page.locator(`[data-start-service="${otherPromId}"]`);
  await expect(mine).toBeVisible();
  const ticked = async (l: typeof mine) => (await l.getAttribute("aria-checked")) === "true" || (await l.getAttribute("data-state")) === "checked" || (await l.locator('[role="checkbox"][aria-checked="true"], [data-state="checked"]').count()) > 0;
  const lowTicks = { mine: await ticked(mine), theirs: (await theirs.count()) ? await ticked(theirs) : false };
  // Wave 2.10b F1 changed this test: the machine list is gone (every machine of the ticked services gets
  // its own health row), so nothing can be drawn outside the sheet; the Machines line says what happens.
  const line = page.locator("[data-start-machines]");
  await expect(line).toBeVisible();
  await expect(line).toContainText("health row");
  await expect(page.locator("[data-start-machine-list], [data-start-machine-option]")).toHaveCount(0);
  await page.screenshot({ path: out("item17-open.png") });
  note("item17", { lowTicks, machinesLine: await line.textContent() });
  expect(lowTicks.mine).toBe(true);
  expect(lowTicks.theirs, "another person's service starts unticked").toBe(false);
  await ctx.close();
});
