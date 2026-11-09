// Wave 2.10c round 3, builder C (gauntlet w210c-r2 Fix List items 1 (C half), 2, 3 (C half), 4, 6, 7, 8, 9,
// 12 (C half), 13 and C's first-timer lows). Every operator action drives the real screen the way the critics
// did: the badge's own Fit by mouse click, touch tap and Enter; Insert clicks; typing in the inspector; Pick
// data; the wheel and Esc in the viewer; dots; the icon picker. The API only sets up a stand-in data source,
// a starting layout where a critic had one already, and publishes (as the Publish button would); it is read to
// check what the draft holds. Each test was recorded failing on the build from before any round 3 edit
// (evidence/components/w210c-r3/failing-first/). Integration reads use the stand-in Prometheus; test values.
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn } from "./helpers";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";

test.describe.configure({ timeout: Number(process.env.ATRIUM_E2E_TEST_TIMEOUT ?? 300_000) });
test.use({ actionTimeout: 15_000, trace: "off" });
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
const EV = path.resolve(here, `../../../evidence/components/w210c-r3/${process.env.ATRIUM_E2E_STAGE ?? "pass"}`);
const file = (name: string) => {
  const p = path.join(EV, name);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
};
const shot = (name: string) => file(`${name}.png`);
const writeEv = (name: string, data: unknown) => writeFileSync(file(name), JSON.stringify(data, null, 2));

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: Slot; children?: Node[]; name?: string; title?: string };
type Draft = { rev: number; doc: { pages: { id: string; slug: string; root: Node }[] } };

async function draft(req: APIRequestContext, id: string): Promise<Draft> {
  return (await req.get(`/api/apps/${id}/draft`)).json();
}
async function ops(req: APIRequestContext, id: string, list: unknown[]) {
  const d = await draft(req, id);
  const r = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), `ops refused: ${await r.text()}`).toBe(true);
}
async function newApp(req: APIRequestContext, slug: string, kids: Node[] = [], sources: unknown[] = []): Promise<{ id: string; rootId: string }> {
  const r = await req.post("/api/apps", { data: { name: `Round 3 ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await draft(req, id);
  const rootId = d.doc.pages[0]!.root.id;
  if (kids.length || sources.length) await ops(req, id, [...sources, ...kids.map((n) => ({ op: "node.add", parentId: rootId, node: n }))]);
  return { id, rootId };
}
async function publish(req: APIRequestContext, appId: string) {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note: "w210c-r3" }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)];
const nodes = (d: Draft) => all(d.doc.pages[0]!.root);
const find = (d: Draft, id: string) => nodes(d).find((n) => n.id === id);
async function untilDraft(req: APIRequestContext, id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(req, id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
async function select(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${id}"]`).click();
  await expect(page.locator(`[data-inspector][data-node-id="${id}"]`)).toBeVisible();
}
async function view(page: Page, slug: string) {
  await page.goto(`/a/${slug}`);
  await expect(page.locator(".atr-render-root").first()).toBeVisible({ timeout: 15_000 });
}
/** An Insert click; returns the new node's id (from the draft). Closes a data picker that opens for it. */
async function insertClick(page: Page, appId: string, type: string): Promise<string> {
  await page.locator('[data-left-tab="insert"]').click();
  const before = new Set(nodes(await draft(page.request, appId)).map((n) => n.id));
  await page.locator(`[data-insert-item="${type}"]`).first().click();
  const d = await untilDraft(page.request, appId, (x) => nodes(x).some((n) => !before.has(n.id) && n.type === type));
  // A data widget opens the "What should this show?" picker: close it with its own Close, not Esc (Esc
  // would also clear the canvas selection).
  const close = page.locator('[role="dialog"] button[aria-label="Close"], [data-sheet] button[aria-label="Close"]').filter({ visible: true });
  if (await close.count()) await close.first().click();
  return nodes(d).find((n) => !before.has(n.id) && n.type === type)!.id;
}
const undoLabel = (page: Page) => page.locator("[data-builder-bar] button[aria-label^='Undo'], [data-builder-bar] button[aria-label^='Nothing to undo']").first().getAttribute("aria-label");

let prom: FakePrometheus | undefined;
let promId = "";
test.beforeAll(async () => {
  prom = await startFakePrometheus();
});
test.afterAll(async () => {
  await prom?.close();
});
test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project; phone contexts are made per test");
  await signIn(context, page.request);
  await context.addCookies([{ name: "atrium_swept", value: "1", url: ORIGIN }]);
});
async function promIntegration(req: APIRequestContext): Promise<string> {
  if (promId) return promId;
  const r = await req.post("/api/integrations", { data: { packageId: "prometheus", name: `Prometheus r3 ${RUN}`, config: { baseUrl: prom!.url, authMode: "none" }, secrets: {}, untested: true }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  promId = (await r.json()).id as string;
  return promId;
}
const machinesSource = async (req: APIRequestContext) => ({ op: "source.set", source: { name: "machines", integrationId: await promIntegration(req), endpointId: "machines-overview", refreshSec: 60 } });
const cpuStat = (id: string): Node => ({ id, type: "stat", props: { value: { $bind: "{{ $item.cpu }}" }, label: { $bind: "{{ $item.name }}" }, unit: "%" } });
const tall = (id: string, y: number): Node => ({ id, type: "text", props: { text: Array.from({ length: 60 }, (_, i) => `Line ${i + 1} below.`).join("\n") }, slot: { x: 0, y, w: 12, h: 140 } });
const badgeOf = (page: Page, id: string) => page.locator(`[data-canvas-root] [data-cut-badge="${id}"]`).first();

// ---------- item 1: the badge's own Fit, by click, tap and Enter ----------
for (const how of ["click", "Enter", "tap"] as const) {
  test(`item 1 (${how}): the badge's own Fit on a box too small for its content (a gauge; on a phone, a roulette) fits it as one named step, the badge goes and the widget stays selected`, async ({ page, browser }) => {
    const slug = `w210c-r3-fit-${how.toLowerCase()}-${RUN}`;
    // Desktop: a gauge already shrunk too small, as the usability critic made one (116 x 162). Phone (tap):
    // a roulette too short for the gauge in front, as the mobile critic tapped (on a phone, plain widgets grow
    // to their content, so only a roulette keeps its box and its badge there).
    const gauge: Node = how === "tap"
      ? { id: "c_r3fitgauge", type: "roulette", props: { mode: "slots" }, slot: { x: 0, y: 0, w: 4, h: 14 }, children: [{ id: "c_r3fitgaugi", type: "gauge", props: { value: 42, label: "FAKE load", unit: "%" } }, { id: "c_r3fittextb", type: "text", props: { text: "Second" } }] }
      : { id: "c_r3fitgauge", type: "gauge", props: { value: 42, label: "FAKE load", unit: "%" }, slot: { x: 0, y: 0, w: 2, h: 12 } };
    // (tap: a short roulette with a gauge in front, the mobile critic's case, on a touch screen.)
    const app = await newApp(page.request, slug, [gauge, { id: "c_r3fittexta", type: "text", props: { text: "Below" }, slot: { x: 0, y: 30, w: 4, h: 4 } }]);
    let p = page;
    let ctx: BrowserContext | null = null;
    if (how === "tap") {
      // A touch screen at a desktop builder's width (a tablet or touch laptop): the phone builder lets rows
      // follow content, so only a roulette keeps a fixed box there.
      ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
      await ctx.addCookies(await page.context().cookies());
      p = await ctx.newPage();
      await p.goto(`${ORIGIN}/build/${slug}`);
      await expect(p.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
      const at = (await p.locator(`[data-canvas-root] [data-node="${gauge.id}"]`).first().boundingBox())!;
      await p.touchscreen.tap(at.x + at.width / 2, at.y + 20);
    } else {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openBuilder(page, slug);
      await page.locator(`[data-canvas-root] [data-node="${gauge.id}"]`).first().click();
    }
    const badge = badgeOf(p, gauge.id);
    await expect(badge, "the badge shows on the cut gauge").toBeVisible({ timeout: 8000 });
    await p.waitForTimeout(300);
    const selBefore = await p.locator("[data-inspector][data-node-id]").first().getAttribute("data-node-id").catch(() => null);
    const d0 = await draft(p.request, app.id);
    const h0 = find(d0, gauge.id)!.slot!.h;
    const fit = badge.locator("[data-cut-fit]");
    await expect(fit).toBeVisible();
    await fit.scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    const box = (await fit.boundingBox())!;
    if (how === "click") await fit.click();
    else if (how === "tap") await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    else { await fit.focus(); await p.keyboard.press("Enter"); }
    const d = await untilDraft(p.request, app.id, (x) => (find(x, gauge.id)?.slot?.h ?? 0) > h0, 6000);
    await p.waitForTimeout(1200);
    const after = {
      h0,
      selBefore,
      h1: find(d, gauge.id)!.slot!.h,
      changed: JSON.stringify(find(d, gauge.id)) !== JSON.stringify(find(d0, gauge.id)),
      undo: await undoLabel(p),
      coarse: await p.evaluate(() => matchMedia("(pointer: coarse)").matches),
      badgeVisible: await badge.isVisible(),
      selected: await p.locator("[data-inspector][data-node-id]").first().getAttribute("data-node-id").catch(() => null),
      fitBox: box,
    };
    await p.screenshot({ path: shot(`i1-${how}`) });
    writeEv(`i1-${how}.json`, after);
    if (ctx) await ctx.close();
    expect(after.h1, "Fit grows the box").toBeGreaterThan(h0);
    expect(after.undo ?? "", "one named step").toMatch(how === "tap" ? /Fit Roulette/ : /Fit Gauge/);
    expect(after.badgeVisible, "the badge goes").toBe(false);
    expect(selBefore, "something was selected before the press").not.toBeNull();
    expect(after.selected, "the selection stays as it was, never its grid").toBe(selBefore);
    if (how === "tap" && after.coarse) expect(Math.min(box.width, box.height), "Fit is a 44 px target on touch (item 13)").toBeGreaterThanOrEqual(44);
  });
}

// ---------- items 1 and 3: a roulette built through Insert, and one already too short ----------
const frontState = (page: Page, sel: string) => page.evaluate((q) => {
  const node = document.querySelector(q)!;
  const stage = node.querySelector(".atr-roulette-stage")!.getBoundingClientRect();
  const front = node.querySelector('[data-face]:not([aria-hidden="true"]) [data-node]') as HTMLElement | null;
  const fr = front?.getBoundingClientRect();
  const fit = node.querySelector('[data-face]:not([aria-hidden="true"]) [data-slot-fit]');
  return { stageH: Math.round(stage.height), frontType: front?.getAttribute("data-type") ?? null, frontBottomOver: fr ? Math.round(fr.bottom - stage.bottom) : null, scaled: fit?.getAttribute("data-slot-scaled") ?? null };
}, sel);

test("items 1 and 3: a roulette filled through Insert shows no badge and its front slot is never cut; a roulette already too short for its gauge scales the gauge into the slot, and the badge's Fit grows it to show the gauge at full size in one step; the published page is not cut", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const slug = `w210c-r3-roul-${RUN}`;
  // The first critic's case already on the page: a gauge in front of a roulette too short for it.
  const shortId = "c_r3shortrou";
  const short: Node = { id: shortId, type: "roulette", props: { mode: "slots", advance: { scroll: true, arrows: true, dots: true } }, slot: { x: 6, y: 0, w: 3, h: 18 }, children: [{ id: "c_r3shortgau", type: "gauge", props: { value: 64, label: "FAKE disk", unit: "%" } }, { id: "c_r3shorttxt", type: "text", props: { text: "Second" } }] };
  const app = await newApp(page.request, slug, [short, tall("c_r3roultall", 60)]);
  await openBuilder(page, slug);
  // As the usability critic did: Insert > Roulette, then with it selected Insert > Stat, Text and Gauge.
  const rid = await insertClick(page, app.id, "roulette");
  await page.locator(`[data-canvas-root] [data-node="${rid}"] [data-roulette-drop]`).click();
  await expect(page.locator(`[data-inspector][data-node-id="${rid}"]`)).toBeVisible();
  await insertClick(page, app.id, "stat");
  await select(page, rid);
  await insertClick(page, app.id, "text");
  await untilDraft(page.request, app.id, (x) => (find(x, rid)?.children ?? []).length === 2);
  await page.waitForTimeout(1500);
  const fresh = { badge: await badgeOf(page, rid).isVisible(), cut: await badgeOf(page, rid).getAttribute("data-content-cut") };
  await page.screenshot({ path: shot("i1-roulette-fresh") });
  await select(page, rid);
  const gid = await insertClick(page, app.id, "gauge");
  await untilDraft(page.request, app.id, (x) => (find(x, rid)?.children ?? []).some((k) => k.id === gid));
  const r = page.locator(`[data-canvas-root] [data-node="${rid}"] .atr-roulette`).first();
  for (let i = 0; i < 3 && (await r.getAttribute("data-current")) !== "2"; i++) {
    await page.locator(`[data-canvas-root] [data-node="${rid}"] [data-roulette-next]`).first().click();
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(1200);
  const withGauge = await frontState(page, `[data-canvas-root] [data-node="${rid}"]`);
  // The roulette that is too short: the gauge is scaled into its slot, the badge says so, Fit fixes it.
  const sel = `[data-canvas-root] [data-node="${shortId}"]`;
  const before = await frontState(page, sel);
  const badge = badgeOf(page, shortId);
  await expect(badge, "a front slot taller than the roulette shows the badge").toBeVisible({ timeout: 6000 });
  const words = await badge.textContent();
  const h0 = find(await draft(page.request, app.id), shortId)!.slot!.h;
  await badge.locator("[data-cut-fit]").click();
  const d2 = await untilDraft(page.request, app.id, (x) => (find(x, shortId)?.slot?.h ?? 0) > h0, 6000);
  await page.waitForTimeout(1500);
  const afterFit = { h0, h1: find(d2, shortId)!.slot!.h, undo: await undoLabel(page), badge: await badge.isVisible(), selected: await page.locator("[data-inspector][data-node-id]").first().getAttribute("data-node-id").catch(() => null), ...(await frontState(page, sel)) };
  await page.screenshot({ path: shot("i3-roulette-fitted") });
  // Published, the gauge in the roulette inserted by hand is whole.
  await publish(page.request, app.id);
  await view(page, slug);
  const v = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(v).toHaveAttribute("data-count", "3", { timeout: 15_000 });
  await v.focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(900);
  const published = await frontState(page, `.atr-render-root [data-node="${rid}"]`);
  await v.screenshot({ path: shot("i3-published") });
  writeEv("i1-i3-roulette.json", { fresh, withGauge, before, words, afterFit, published });
  expect(fresh.badge, "a new roulette whose front slot fits shows no badge").toBe(false);
  expect(withGauge.frontType).toBe("gauge");
  expect(withGauge.frontBottomOver ?? 99, "the inserted gauge is not cut").toBeLessThanOrEqual(1);
  expect(before.frontType).toBe("gauge");
  expect(before.frontBottomOver ?? 99, "the taller gauge is scaled into its slot, not cut").toBeLessThanOrEqual(1);
  expect(before.scaled, "it is scaled").not.toBeNull();
  expect(afterFit.h1, "Fit grows the roulette").toBeGreaterThan(h0);
  expect(afterFit.undo ?? "").toMatch(/Fit Roulette/);
  expect(afterFit.badge, "the badge goes").toBe(false);
  expect(afterFit.selected, "the page grid is not selected by the press").not.toBe(app.rootId);
  expect(afterFit.scaled, "the gauge shows at full size").toBeNull();
  expect(published.frontType).toBe("gauge");
  expect(published.frontBottomOver ?? 99, "no published cut").toBeLessThanOrEqual(1);
});

// ---------- items 2 and 6: repeat mode built through Pick data and typing ----------
test("items 2 and 6: Pick data on an empty repeat roulette also adds the ready widget; a Gauge's Label typed as {{ $item.name }} reads each machine on the canvas and the published page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const slug = `w210c-r3-rep-${RUN}`;
  const app = await newApp(page.request, slug, [tall("c_r3reptalla", 60)], [await machinesSource(page.request)]);
  const integ = await promIntegration(page.request);
  await openBuilder(page, slug);
  const rid = await insertClick(page, app.id, "roulette");
  await select(page, rid);
  const insp = page.locator(`[data-inspector][data-node-id="${rid}"]`);
  await insp.locator('[data-field="mode"] select').selectOption("repeat");
  await untilDraft(page.request, app.id, (x) => find(x, rid)?.props.mode === "repeat");
  // Item 6: Pick data, search, choose the list; that is all.
  await insp.locator('[data-pick-button="items"]').first().click();
  await page.keyboard.type("CPU in use every machine");
  // This spec's own stand-in (earlier specs in a whole-suite run leave other Prometheus integrations behind,
  // whose stand-ins are closed).
  const row = page.locator(`[data-show-item][data-show-integration="${integ}"]`).filter({ hasText: /CPU in use, Every machine/ }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  const done = page.locator("[data-pick-done]").filter({ visible: true });
  if (await done.count()) await done.first().click();
  const d1 = await untilDraft(page.request, app.id, (x) => (find(x, rid)?.children ?? []).length === 1, 8000);
  const r = page.locator(`[data-canvas-root] [data-node="${rid}"] .atr-roulette`).first();
  const six = { items: find(d1, rid)?.props.items, kids: (find(d1, rid)?.children ?? []).map((k) => k.type), empty: await page.locator(`[data-canvas-root] [data-node="${rid}"] [data-roulette-drop]`).count() };
  await page.screenshot({ path: shot("i6-after-pick") });
  // Item 2: swap the ready Stat for a Gauge, as the first-timer had, and type its Label by hand.
  if (six.kids.length) {
    await select(page, find(d1, rid)!.children![0]!.id);
    await page.keyboard.press("Delete");
    await untilDraft(page.request, app.id, (x) => (find(x, rid)?.children ?? []).length === 0);
  }
  await select(page, rid);
  const gid = await insertClick(page, app.id, "gauge");
  await untilDraft(page.request, app.id, (x) => (find(x, rid)?.children ?? []).some((k) => k.id === gid));
  await select(page, gid);
  // Its value by hand too: the Value field's "Live data" (under its More fold), then the row's CPU typed in.
  const gInsp = page.locator(`[data-inspector][data-node-id="${gid}"]`);
  const folds = gInsp.getByRole("button", { name: /live data for one field/ });
  for (let i = 0; i < (await folds.count()) && !(await gInsp.locator('[data-bind-button="value"]').isVisible()); i++) await folds.nth(i).click();
  await gInsp.locator('[data-bind-button="value"]').click();
  const vbox = gInsp.locator('[data-field="value"] textarea, [data-field="value"] input').first();
  await vbox.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("{{ $item.cpu }}", { delay: 10 });
  await page.keyboard.press("Tab");
  await untilDraft(page.request, app.id, (x) => JSON.stringify(find(x, gid)?.props.value ?? "").includes("$item.cpu"), 5000);
  const label = gInsp.getByLabel("Label", { exact: true });
  await label.click();
  await page.keyboard.type("{{ $item.name }}", { delay: 15 });
  await page.keyboard.press("Tab");
  const d2 = await untilDraft(page.request, app.id, (x) => typeof find(x, gid)?.props.label === "object", 5000);
  await page.waitForTimeout(1500);
  const canvasText = (await r.innerText()).replace(/\s+/g, " ");
  await page.screenshot({ path: shot("i2-canvas") });
  await publish(page.request, app.id);
  await view(page, slug);
  const v = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(v).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  await page.waitForTimeout(800);
  const viewText = (await v.innerText()).replace(/\s+/g, " ");
  await page.screenshot({ path: shot("i2-viewer") });
  writeEv("i2-i6-repeat.json", { six, label: find(d2, gid)?.props.label, canvasText, viewText });
  expect(six.kids, "Pick data alone fills the empty repeat roulette").toHaveLength(1);
  expect(find(d2, gid)?.props.label, "the typed row template is live data").toEqual({ $bind: "{{ $item.name }}" });
  expect(canvasText).not.toContain("{{");
  expect(canvasText).toMatch(/ACE/);
  expect(viewText).not.toContain("{{");
  expect(viewText).toMatch(/ACE/);
});

// ---------- items 4, 7: the viewer ----------
async function repeatRouletteApp(req: APIRequestContext, slug: string, theme?: string) {
  const rid = "c_r3viewroul";
  const roul: Node = { id: rid, type: "roulette", name: "CPU per machine", props: { mode: "repeat", items: { $bind: "{{ machines.rows }}" }, advance: { scroll: true, arrows: true, dots: true } }, slot: { x: 0, y: 0, w: 6, h: 30 }, children: [cpuStat("c_r3viewstat")] };
  const app = await newApp(req, slug, [roul, tall("c_r3viewtall", 32)], [await machinesSource(req)]);
  if (theme) await ops(req, app.id, [{ op: "theme.set", theme: { themeId: theme } }]);
  await publish(req, app.id);
  return rid;
}
const pageY = (p: Page) => p.evaluate(() => (document.scrollingElement?.scrollTop ?? 0) + Math.max(0, ...[...document.querySelectorAll("main, [data-app-scroll]")].map((e) => e.scrollTop)));

test("item 4: after a click, the wheel turns the roulette; Esc releases it, so the next wheel scrolls the page and the slot stays; the first click on a fresh load engages it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210c-r3-esc-${RUN}`;
  const rid = await repeatRouletteApp(page.request, slug);
  const res: { firstClick: boolean[]; turned?: string | null; afterEsc?: { current: string | null; pageMoved: number; engaged: boolean } } = { firstClick: [] };
  for (let i = 0; i < 3; i++) {
    await view(page, slug);
    const r = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
    await expect(r).toHaveAttribute("data-count", "9", { timeout: 20_000 });
    const b = (await r.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 3);
    res.firstClick.push((await r.getAttribute("data-engaged")) !== null);
  }
  const r = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
  const b = (await r.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 3);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(700);
  res.turned = await r.getAttribute("data-current");
  await page.keyboard.press("Escape");
  const y0 = await pageY(page);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(700);
  res.afterEsc = { current: await r.getAttribute("data-current"), pageMoved: (await pageY(page)) - y0, engaged: (await r.getAttribute("data-engaged")) !== null };
  writeEv("i4-esc.json", res);
  expect(res.firstClick, "the first click engages it on every fresh load").toEqual([true, true, true]);
  expect(res.turned).toBe("1");
  expect(res.afterEsc.engaged, "Esc releases it").toBe(false);
  expect(res.afterEsc.current, "the slot stays").toBe("1");
  expect(res.afterEsc.pageMoved, "the wheel scrolls the page").toBeGreaterThan(20);
});

test("item 7: a far dot jump shows a face over the middle in every frame; under reduced motion it crosses from the old slot, the card never dimmed", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210c-r3-spin-${RUN}`;
  const rid = await repeatRouletteApp(page.request, slug);
  const sample = (p: Page) => p.evaluate(async (id) => {
    const out: { t: number; covered: boolean; maxOpacity: number }[] = [];
    const t0 = performance.now();
    const root = document.querySelector(`[data-node="${id}"] .atr-roulette`)!;
    const stage = root.querySelector(".atr-roulette-stage")!.getBoundingClientRect();
    const cx = stage.left + stage.width / 2;
    const cy = stage.top + stage.height / 2;
    while (performance.now() - t0 < 900) {
      await new Promise((res) => requestAnimationFrame(() => res(null)));
      const hit = document.elementsFromPoint(cx, cy).find((e) => e.closest(`[data-node="${id}"] [data-face]`));
      // How opaque the most opaque face over the middle is (face opacity times its content's).
      let maxOpacity = 0;
      for (const f of Array.from(root.querySelectorAll<HTMLElement>("[data-face]"))) {
        const r = f.getBoundingClientRect();
        if (r.top > cy || r.bottom < cy || r.width === 0) continue;
        const inner = f.querySelector<HTMLElement>("[data-face-in]");
        const o = Number(getComputedStyle(f).opacity) * (inner ? Number(getComputedStyle(inner).opacity) : 1);
        maxOpacity = Math.max(maxOpacity, o);
      }
      out.push({ t: Math.round(performance.now() - t0), covered: !!hit, maxOpacity: Math.round(maxOpacity * 100) / 100 });
    }
    return out;
  }, rid);
  await view(page, slug);
  const r = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(r).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  await page.waitForTimeout(700);
  const jumpTo = async (p: Page, i: number) => {
    const dot = p.locator(`[data-node="${rid}"] [data-roulette-dot="${i}"]`);
    if (await dot.count()) await dot.click();
    else { await p.locator(`[data-node="${rid}"] .atr-roulette`).first().focus(); await p.keyboard.press("End"); }
  };
  const [frames] = await Promise.all([sample(page), jumpTo(page, 6)]);
  await page.waitForTimeout(500);
  const turned = await r.getAttribute("data-current");
  const rm = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await rm.addCookies(await page.context().cookies());
  const q = await rm.newPage();
  await q.goto(`${ORIGIN}/a/${slug}`);
  const qr = q.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(qr).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  await q.waitForTimeout(700);
  const [rmFrames] = await Promise.all([sample(q), jumpTo(q, 6)]);
  await rm.close();
  writeEv("i7-frames.json", { turned, frames, rmFrames });
  expect(turned).not.toBe("0");
  // A face's box over the middle at 0.9 or more (hit testing through 3D faces is not reliable, so "covered" is
  // kept as a note only).
  expect(frames.filter((f) => f.maxOpacity < 0.9), "no empty card mid-spin").toEqual([]);
  expect(rmFrames.filter((f) => f.maxOpacity < 0.99), "reduced motion: always a fully drawn slot, never a dim card").toEqual([]);
});

// ---------- item 8: the fade keeps the frame; the rings follow the theme's corners ----------
test("item 8: on Dusk, a list's edge fade leaves its border, corners and shadow whole; the engaged ring is rounded like the card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210c-r3-fade-${RUN}`;
  const list: Node = { id: "c_r3fadelist", type: "list", title: "CPU list", props: { items: { $bind: "{{ machines.rows }}" } }, slot: { x: 0, y: 0, w: 4, h: 20 } };
  const app = await newApp(page.request, slug, [list, tall("c_r3fadetall", 30)], [await machinesSource(page.request)]);
  await ops(page.request, app.id, [{ op: "theme.set", theme: { themeId: "dusk" } }]);
  await publish(page.request, app.id);
  await view(page, slug);
  const n = page.locator(`[data-node="${list.id}"]`).first();
  await expect(n.locator("[data-scroll-port][data-more-below]")).toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(500);
  const frame = await n.evaluate((e) => {
    const root = e.querySelector(':scope > [data-slot="root"]') as HTMLElement;
    const port = e.querySelector("[data-scroll-port]") as HTMLElement;
    const cs = getComputedStyle(root);
    const mask = (el: Element) => getComputedStyle(el).maskImage || (getComputedStyle(el) as unknown as { webkitMaskImage: string }).webkitMaskImage;
    const fadedSurfaces = [root, port].filter((el) => { const c = getComputedStyle(el); return mask(el) !== "none" && (parseFloat(c.borderBottomWidth) > 0 || c.boxShadow !== "none"); }).length;
    const innerMasks = Array.from(port.children).map((k) => mask(k));
    return { radius: cs.borderTopLeftRadius, border: cs.borderBottomWidth, shadow: cs.boxShadow, fadedSurfaces, innerMasks };
  });
  await n.screenshot({ path: shot("i8-dusk-list-rest") });
  const b = (await n.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(300);
  const ring = await n.evaluate((e) => { const cs = getComputedStyle(e, "::after"); return { content: cs.content, radius: cs.borderTopLeftRadius }; });
  await n.screenshot({ path: shot("i8-dusk-list-engaged") });
  writeEv("i8-fade.json", { frame, ring });
  expect(frame.fadedSurfaces, "the framed box itself is not faded").toBe(0);
  expect(frame.innerMasks.some((m) => m.includes("gradient")), "the rows inside fade").toBe(true);
  expect(ring.radius, "the ring follows the card's corners").toBe(frame.radius);
  expect(parseFloat(frame.radius)).toBeGreaterThan(0);
});

// ---------- item 9 and item 13's warning: the roulette's inspector ----------
test("item 9: Shows first counts from 1 like the dots and is held to the slots; item 13: switching off every way to turn with no timer says so", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const slug = `w210c-r3-start-${RUN}`;
  const rid = "c_r3startrou";
  const roul: Node = { id: rid, type: "roulette", props: { mode: "slots" }, slot: { x: 0, y: 0, w: 4, h: 24 }, children: ["One", "Two", "Three"].map((t, i) => ({ id: `c_r3startsl${"abc"[i]}`, type: "heading", props: { text: `Slot ${t}` } })) };
  const app = await newApp(page.request, slug, [roul]);
  await openBuilder(page, slug);
  await select(page, rid);
  const insp = page.locator(`[data-inspector][data-node-id="${rid}"]`);
  // "Shows first" sits under a More fold in Content.
  for (let i = 0; i < 4 && !(await insp.locator('[data-field="startAt"] input').count()); i++) {
    const more = insp.getByRole("button", { name: /shows first/i }).first();
    if (await more.count()) await more.click();
    await page.waitForTimeout(150);
  }
  const start = insp.locator('[data-field="startAt"] input');
  await start.click();
  await start.fill("2");
  await page.keyboard.press("Tab");
  const d1 = await untilDraft(page.request, app.id, (x) => find(x, rid)?.props.startAt !== undefined);
  await start.click();
  await start.fill("9");
  await page.keyboard.press("Tab");
  const d2 = await untilDraft(page.request, app.id, (x) => find(x, rid)?.props.startAt === 2, 4000);
  const said = await insp.locator('[data-field="startAt"]').textContent();
  const shown = await start.inputValue();
  // Item 13: every way to turn off, timer off.
  for (const name of ["The wheel, after a click on it", "Arrow buttons and keys", "Dots, one per slot"]) await insp.getByRole("switch", { name }).click();
  const stuck = await insp.locator("[data-roulette-stuck]").textContent({ timeout: 4000 }).catch(() => null);
  await page.screenshot({ path: shot("i9-start") });
  // The viewer opens on the second slot for 2.
  await ops(page.request, app.id, [{ op: "node.update", nodeId: rid, patch: { props: { ...find(d2, rid)!.props, startAt: 1 } } }]);
  await publish(page.request, app.id);
  await view(page, slug);
  const viewCurrent = await page.locator(`[data-node="${rid}"] .atr-roulette`).first().getAttribute("data-current");
  writeEv("i9-start.json", { first: find(d1, rid)?.props.startAt, held: find(d2, rid)?.props.startAt, said, shown, stuck, viewCurrent });
  expect(find(d1, rid)?.props.startAt, "2 is stored as the second slot").toBe(1);
  expect(find(d2, rid)?.props.startAt, "9 is held to the last slot").toBe(2);
  expect(shown).toBe("3");
  expect(said ?? "").toMatch(/has 3 slots/);
  expect(stuck ?? "").toMatch(/Nothing turns this roulette/);
  expect(viewCurrent).toBe("1");
});

// ---------- item 12 (C half) and item 13's no-icon colour ----------
async function startSite(): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const { deflateSync, crc32 } = await import("node:zlib");
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((32 * 3 + 1) * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) raw.set([200 - x * 4, 60 + y * 3, 90], y * (32 * 3 + 1) + 1 + x * 3);
  const icon = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/fake-e2e-r3-icon.png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(icon); return; }
    if (req.url?.startsWith("/none")) { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>FAKE no icon</title>"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><head><title>FAKE e2e r3 site</title><link rel="icon" type="image/png" sizes="32x32" href="/fake-e2e-r3-icon.png"></head><body>FAKE</body></html>');
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((res) => server.close(() => res())) };
}

test("item 12: an icon taken From a website is named from its upload, the browser keeps no list of sites, and the name survives a reload; item 13: no icon is said in plain ink, not error red", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `w210c-r3-icon-${RUN}`;
  const icon: Node = { id: "c_r3iconnode", type: "icon", props: { name: "server", scale: 50 }, slot: { x: 0, y: 0, w: 1.375, h: 10 } };
  const app = await newApp(page.request, slug, [icon]);
  const site = await startSite();
  await openBuilder(page, slug);
  await select(page, icon.id);
  await page.locator(`[data-inspector][data-node-id="${icon.id}"] [data-icon-pick="name"]`).click();
  await page.locator("[data-icon-picker] [data-icon-from-website]").click();
  // No icon first: the sentence is not in error red.
  await page.locator("[data-icon-picker] [data-website-url]").fill(`${site.url}/none`);
  await page.locator("[data-icon-picker] [data-website-fetch]").click();
  const err = page.locator("[data-icon-picker] [data-favicon-error]");
  await expect(err).toBeVisible({ timeout: 12_000 });
  const noIcon = await err.evaluate((e) => ({ text: e.textContent, color: getComputedStyle(e).color, bad: getComputedStyle(document.documentElement).getPropertyValue("--bad").trim() }));
  const badRgb = await page.evaluate((c) => { const d = document.createElement("span"); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }, noIcon.bad || "red");
  await page.locator("[data-icon-picker] [data-website-url]").fill(site.url);
  await page.locator("[data-icon-picker] [data-website-fetch]").click();
  await page.locator("[data-icon-picker] [data-favicon-use]").click({ timeout: 12_000 });
  await untilDraft(page.request, app.id, (x) => String(find(x, icon.id)?.props.name ?? "").startsWith("/uploads/"));
  const words1 = await page.locator(`[data-inspector][data-node-id="${icon.id}"] [data-icon-pick="name"]`).getAttribute("aria-label");
  const stored1 = await page.evaluate(() => Object.keys(localStorage).filter((k) => /site/i.test(k)).map((k) => [k, localStorage.getItem(k)]));
  await page.reload();
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  await select(page, icon.id);
  await expect(page.locator(`[data-inspector][data-node-id="${icon.id}"] [data-icon-pick="name"]`)).toHaveAttribute("aria-label", /from the website/, { timeout: 8000 }).catch(() => undefined);
  const words2 = await page.locator(`[data-inspector][data-node-id="${icon.id}"] [data-icon-pick="name"]`).getAttribute("aria-label");
  const stored2 = await page.evaluate(() => Object.keys(localStorage).filter((k) => /site/i.test(k)).map((k) => [k, localStorage.getItem(k)]));
  await site.close();
  await page.screenshot({ path: shot("i12-icon") });
  writeEv("i12-icon.json", { noIcon, badRgb, words1, words2, stored1, stored2 });
  expect(noIcon.text ?? "").toMatch(/no icon/);
  expect(noIcon.color, "the no-icon answer is not error red").not.toBe(badRgb);
  expect(stored1, "nothing about sites in the browser's storage").toEqual([]);
  expect(stored2).toEqual([]);
  expect(words1 ?? "").toMatch(/127\.0\.0\.1 icon, from the website/);
  expect(words2 ?? "", "the name comes from the server, so it survives a reload").toMatch(/127\.0\.0\.1 icon, from the website/);
});

// ---------- item 13 (C lows): the roulette face and the sticky header ----------
test("item 13: an untitled widget in a roulette slot draws no empty title bar; a table's sticky header has a rule under it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210c-r3-lows-${RUN}`;
  const rid = await repeatRouletteApp(page.request, slug, "control-room");
  const slug2 = `w210c-r3-lowt-${RUN}`;
  const table: Node = { id: "c_r3lowtable", type: "table", props: { data: { $bind: "{{ machines }}" } }, slot: { x: 0, y: 0, w: 6, h: 22 } };
  const a2 = await newApp(page.request, slug2, [table, tall("c_r3lowtalla", 30)], [await machinesSource(page.request)]);
  await publish(page.request, a2.id);
  await view(page, slug);
  const r = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(r).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  await page.waitForTimeout(600);
  const bars = await page.locator(`[data-node="${rid}"] [data-face] .atr-titlebar`).evaluateAll((els) => els.map((e) => ({ display: getComputedStyle(e).display, text: e.querySelector("[data-titlebar-text]")?.getAttribute("data-titlebar-text") ?? null })));
  const titlebarsOn = await page.locator("[data-canvas-titlebars]").first().getAttribute("data-canvas-titlebars");
  await r.screenshot({ path: shot("i13-face") });
  await view(page, slug2);
  const th = page.locator(`[data-node="${table.id}"] thead th`).first();
  await expect(th).toBeVisible({ timeout: 20_000 });
  const rule = await th.evaluate((e) => getComputedStyle(e).boxShadow);
  writeEv("i13-lows.json", { titlebarsOn, bars, rule });
  expect(titlebarsOn).toBe("on");
  expect(bars.length).toBeGreaterThan(0);
  expect(bars.filter((b) => b.text === "" && b.display !== "none"), "no empty title bar strip").toEqual([]);
  expect(rule).toContain("inset");
});

// ---------- item 13 / first-timer low: the badge only when something is hidden ----------
test("item 13: the badge never cries wolf: narrow gauges whose dial and label all show, and a 3-row sample table with room to spare on Solid, show no badge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `w210c-r3-wolf-${RUN}`;
  // Gauges narrower than their dial (the usability critic's 116 px case) at heights from cut to roomy, and a
  // table with its three sample rows and room below (the first-timer's Solid case).
  const gauges: Node[] = Array.from({ length: 9 }, (_, i) => ({ id: `c_r3wolfgau${String.fromCharCode(97 + i)}`, type: "gauge", props: { value: 42, label: "FAKE load", unit: "%" }, slot: { x: (i % 6) * 2, y: i < 6 ? 0 : 30, w: 2, h: 19 + i } }));
  const table: Node = { id: "c_r3wolftabl", type: "table", props: {}, slot: { x: 0, y: 60, w: 8, h: 34 } };
  const app = await newApp(page.request, slug, [...gauges, table]);
  await ops(page.request, app.id, [{ op: "theme.set", theme: { themeId: "solid" } }]);
  await openBuilder(page, slug);
  await expect(page.locator(`[data-canvas-root] [data-node="${table.id}"]`).first()).toBeVisible();
  await page.waitForTimeout(1500);
  const ids = [...gauges.map((g) => g.id), table.id];
  const state = await page.evaluate((list) => list.map((id) => {
    const n = document.querySelector(`[data-canvas-root] [data-node="${id}"]`) as HTMLElement;
    const root = (n.querySelector(':scope > [data-slot="root"]') ?? n) as HTMLElement;
    const cs = getComputedStyle(root);
    const r = root.getBoundingClientRect();
    const inner = r.bottom - (parseFloat(cs.paddingBottom) || 0) - (parseFloat(cs.borderBottomWidth) || 0);
    // What is really drawn: text-bearing leaves and whole drawings (an svg's own box; its shapes are clipped by it).
    const leaves = [...root.querySelectorAll("*")].filter((e) => !e.closest("svg") || e.tagName.toLowerCase() === "svg").filter((e) => e.tagName.toLowerCase() === "svg" || (!e.children.length && (e.textContent ?? "").trim()));
    const lowest = Math.max(...leaves.map((e) => e.getBoundingClientRect().bottom));
    const b = document.querySelector(`[data-canvas-root] [data-cut-badge="${id}"]`) as HTMLElement | null;
    return { id, h: Math.round(r.height), spare: Math.round((inner - lowest) * 10) / 10, badge: !!b && !b.hidden, cut: b?.getAttribute("data-content-cut") ?? null };
  }), ids);
  await page.screenshot({ path: shot("i13-no-wolf"), fullPage: true });
  writeEv("i13-no-wolf.json", state);
  const t = state.find((x) => x.id === table.id)!;
  expect(t.spare, "the table really has room below its rows").toBeGreaterThan(0);
  expect(state.filter((x) => x.spare >= 1 && x.badge), "no badge on a box that shows everything").toEqual([]);
  expect(state.filter((x) => x.spare < -1 && !x.badge), "a box that really hides something keeps its badge").toEqual([]);
});

export type { Locator };
