// Wave 2.10c round 3, builder A (gauntlet r2 Fix List items 1, 3, 5, 14 and A's first-timer lows). Every
// operator action drives the real screen the way the critics did (round 3 brief): the canvas badge's own
// Fit button by mouse click, by Enter and by touch tap; an Insert click into a roulette; a Layers drag onto
// the roulette's row at the left of its name; a resize handle drag on a Text; hover on Undo. The API is
// only read, to check what the draft holds (and to make a fresh blank app to work in).
// Evidence: evidence/app-builder/w210c-r3/<stage>/ (ATRIUM_E2E_W210C_STAGE=failing-first or pass).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { api, contextFor, ORIGIN, OWNER, SHELL_VARIANTS, skipPicker, stateFor } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project (the tap test makes its own touch context)");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210C_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder/w210c-r3", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const note = (name: string, data: unknown) => writeFileSync(out(`${name}.json`), JSON.stringify(data, null, 2));
const RUN = Date.now().toString(36).slice(-4);
const LIGHT = SHELL_VARIANTS[0]!;
const owner = () => api(OWNER);

async function draft(id: string): Promise<Draft> { return (await (await owner()).get(`/api/apps/${id}/draft`)).json(); }
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) { const d = await draft(id); if (ok(d) || Date.now() - t0 > ms) return d; await new Promise((r) => setTimeout(r, 150)); }
}
const walk = (x: Node, f: (n: Node) => void) => { f(x); for (const k of x.children ?? []) walk(k, f); };
const nodeIn = (d: Draft, id: string): Node | undefined => { let f: Node | undefined; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.id === id) f = x; }); return f; };
const parentOf = (d: Draft, id: string): Node | undefined => { let f: Node | undefined; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.children?.some((k) => k.id === id)) f = x; }); return f; };
const kids = (d: Draft, id: string) => (nodeIn(d, id)?.children ?? []).map((c) => c.type);
const rootOf = (d: Draft) => d.doc.pages[0]!.root;
async function newApp(slug: string): Promise<string> {
  const r = await (await owner()).post("/api/apps", { data: { name: `R3 ${slug}`, slug, template: "blank" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app.id as string;
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
async function insertClick(page: Page, appId: string, type: string): Promise<string> {
  await page.locator('[data-left-tab="insert"]').click().catch(() => {});
  const before = new Set<string>();
  walk(rootOf(await draft(appId)), (n) => { before.add(n.id); });
  await page.locator(`[data-insert-item="${type}"]`).click();
  await skipPicker(page);
  await page.keyboard.press("Escape").catch(() => {});
  let id = "";
  await expect.poll(async () => { const d = await draft(appId); walk(rootOf(d), (n) => { if (!before.has(n.id) && n.type === type) id = n.id; }); return id; }, { timeout: 8000 }).toBeTruthy();
  return id;
}
async function selectLayer(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${id}"]`).click();
}
const undoTitle = (page: Page) => page.locator("[data-builder-bar] [data-history-undo]").getAttribute("title");
const badge = (page: Page, id: string) => page.locator(`[data-cut-badge="${id}"]`);
const badgeFit = (page: Page, id: string) => badge(page, id).locator("[data-cut-fit]");
/** The text of the first match now, or null when there is none (never waits for one to appear). */
const textNow = async (l: Locator) => ((await l.count()) ? l.first().textContent() : null);
const shown = async (l: Locator) => (await l.count()) > 0 && (await l.first().isVisible());
/** Clears the canvas selection by Esc on the canvas. */
async function deselect(page: Page) { await page.locator("[data-canvas-root]").focus().catch(() => {}); await page.keyboard.press("Escape"); }

/**
 * A widget made too small by hand (its corner dragged up and left), its badge showing, ready for a Fit. Round 3:
 * a gauge can no longer be cut by hand (its smallest height still holds its dial once C draws the dial as one
 * leaf, item 13), so the item 1 tests cut a Clock (as the first-timer's bare clock) and a Roulette with a stat.
 */
async function cutWidget(page: Page, slug: string, type: "clock" | "roulette") {
  const id = await newApp(slug);
  await openBuilder(page, slug);
  const g = await insertClick(page, id, type);
  if (type === "roulette") {
    await selectLayer(page, g);
    await page.locator('[data-left-tab="insert"]').click();
    await page.locator('[data-insert-item="stat"]').click();
    await skipPicker(page);
    await page.keyboard.press("Escape").catch(() => {});
    await untilDraft(id, (x) => kids(x, g).length === 1);
    await page.waitForTimeout(1200);
  }
  const h0 = nodeIn(await draft(id), g)!.slot!.h;
  // Select it in Layers (a click on a roulette's middle would pick its slot), then drag its own corner.
  if (type === "roulette") await selectLayer(page, g);
  else { const gb = (await page.locator(`[data-canvas-root] [data-node="${g}"]`).first().boundingBox())!; await page.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2); }
  await expect(page.locator(`[data-inspector="${g}"]`)).toBeVisible();
  await page.waitForTimeout(500); // the selection outline settles before its handle is grabbed
  const hb = (await page.locator('[data-resize-handle="se"]').first().boundingBox())!;
  const x = hb.x + hb.width / 2, y = hb.y + hb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(x - 6 * i, y - 17 * i); await page.waitForTimeout(25); }
  await page.mouse.up();
  const hs: number[] = [];
  for (let i = 0; i < 6; i++) { hs.push(nodeIn(await draft(id), g)!.slot!.h); await page.waitForTimeout(400); }
  note(`item1-cut-${type}-${slug.split("-")[1]}`, { h0, hs, ghost: null });
  const d = await untilDraft(id, (x) => nodeIn(x, g)!.slot!.h < h0 - 6);
  const small = nodeIn(d, g)!.slot!.h;
  expect(small, `the ${type} was made shorter by hand`).toBeLessThan(h0 - 6);
  await expect(badge(page, g), `the cut badge shows on the too-small ${type}`).toBeVisible({ timeout: 8000 });
  return { id, g, gridId: parentOf(d, g)!.id, small, kind: type === "clock" ? "Clock" : "Roulette" };
}
/** After a badge Fit: the widget grew in one step "Fit <Kind>", the badge went, the grid was not selected. */
async function expectFitted(page: Page, id: string, g: string, gridId: string, small: number, how: string, kind: string) {
  const d = await untilDraft(id, (x) => nodeIn(x, g)!.slot!.h > small, 6000);
  const h = nodeIn(d, g)!.slot!.h;
  const title = await undoTitle(page);
  const gridSelected = await page.locator(`[data-inspector="${gridId}"]`).count();
  const w = nodeIn(d, g)!.slot!.w;
  note(`item1-${how}`, { kind, h, w, small, title, gridSelected });
  await page.screenshot({ path: out(`r3-1-${how}.png`) });
  expect(h, `${how}: Fit grew the ${kind}`).toBeGreaterThan(small);
  expect(title, `${how}: one step named Fit ${kind}`).toBe(`Undo Fit ${kind}`);
  await expect(badge(page, g), `${how}: the badge went`).toBeHidden({ timeout: 4000 });
  expect(gridSelected, `${how}: pressing Fit did not select the page grid`).toBe(0);
  await expect(page.locator(`[data-inspector="${g}"]`), `${how}: the ${kind} stays selected`).toBeVisible();
}
async function clickBadgeFit(page: Page, g: string) {
  // A mouse click at the centre of the badge's Fit (the element there is the button, as for the critic).
  const b = (await badgeFit(page, g).boundingBox())!;
  const hit = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName} ${e.textContent ?? ""}` : ""; }, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  expect(hit, "the element at the Fit centre is the Fit button").toMatch(/^BUTTON Fit/);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

test("item 1: the canvas badge's own Fit fits a cut Clock as one step Fit Clock, by mouse click and by Enter", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const { id, g, gridId, small, kind } = await cutWidget(page, `r3-fit-${RUN}`, "clock");
  await page.screenshot({ path: out("r3-1-before.png") });
  await clickBadgeFit(page, g);
  await expectFitted(page, id, g, gridId, small, "click", kind);
  // Undo brings the cut back, and the badge with it; then Enter on the focused Fit.
  await page.locator("[data-builder-bar] [data-history-undo]").click();
  await untilDraft(id, (x) => nodeIn(x, g)!.slot!.h === small);
  await expect(badge(page, g)).toBeVisible({ timeout: 8000 });
  await badgeFit(page, g).focus();
  await page.keyboard.press("Enter");
  await expectFitted(page, id, g, gridId, small, "enter", kind);
  await ctx.close();
});

test("item 1: the badge's own Fit on a Roulette made too short fits it as one step Fit Roulette", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const { id, g, gridId, small, kind } = await cutWidget(page, `r3-rfit-${RUN}`, "roulette");
  await page.screenshot({ path: out("r3-1-roulette-before.png") });
  await clickBadgeFit(page, g);
  await expectFitted(page, id, g, gridId, small, "roulette-click", kind);
  await ctx.close();
});

test("item 1: a touch tap on the canvas badge's own Fit fits the cut Clock", async ({ browser }) => {
  // The full builder (1440 wide) on a touch screen: the tap is a real touch event on the badge's Fit.
  const touch = await browser.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), viewport: { width: 1440, height: 900 }, hasTouch: true, colorScheme: "light" });
  await touch.addCookies([{ name: "atrium_theme", value: "light", url: ORIGIN }, { name: "atrium_swept", value: "1", url: ORIGIN }]);
  const page = await touch.newPage();
  const { id, g, gridId, small, kind } = await cutWidget(page, `r3-tap-${RUN}`, "clock");
  await badgeFit(page, g).tap();
  await expectFitted(page, id, g, gridId, small, "tap", kind);
  await touch.close();
});

test("item 1 and 3: a new roulette shows no cut badge; inserting a gauge sizes the roulette to hold it", async ({ browser }) => {
  const slug = `r3-rl-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const r = await insertClick(page, id, "roulette");
  for (const t of ["stat", "gauge"]) {
    await selectLayer(page, r);
    await page.locator('[data-left-tab="insert"]').click();
    await page.locator(`[data-insert-item="${t}"]`).click();
    await skipPicker(page);
    await page.keyboard.press("Escape").catch(() => {});
  }
  const d = await untilDraft(id, (x) => kids(x, r).length === 2);
  expect(kids(d, r), "a stat and a gauge in the roulette").toEqual(["stat", "gauge"]);
  // The builder turns to the gauge it just took (atrium:roulette-show); give the turn and any growth time.
  await page.waitForTimeout(2500);
  await deselect(page);
  // A short trace of the roulette's height and its badge while the growth settles (for the report).
  const trace: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    trace.push({ t: i * 500, h: nodeIn(await draft(id), r)!.slot!.h, cut: (await badge(page, r).count()) ? await badge(page, r).first().getAttribute("data-content-cut") : null });
    await page.waitForTimeout(500);
  }
  note("item1-3-trace", trace);
  const box = page.locator(`[data-canvas-root] [data-node="${r}"]`).first();
  const m = await box.evaluate((el) => {
    const root = el.querySelector(':scope > [data-slot="root"]') as HTMLElement | null;
    const front = el.querySelector('[data-roulette-drum] > [data-face]:not([aria-hidden="true"]) [data-node]') as HTMLElement | null;
    const fr = front?.getBoundingClientRect();
    const stage = el.querySelector("[data-roulette-drum]")?.parentElement?.getBoundingClientRect();
    return { rootH: root?.getBoundingClientRect().height ?? 0, frontType: front?.getAttribute("data-type"), frontBottom: fr?.bottom ?? 0, stageBottom: stage?.bottom ?? 0 };
  });
  const cut = (await badge(page, r).count()) ? await badge(page, r).first().getAttribute("data-content-cut") : null;
  note("item1-3-roulette", { m, cut, h: nodeIn(await draft(id), r)!.slot!.h });
  await page.screenshot({ path: out("r3-3-roulette-gauge.png") });
  expect(await shown(badge(page, r)), "a roulette whose front slot fits shows no cut badge").toBe(false);
  expect(m.frontType, "the gauge is in front").toBe("gauge");
  expect(m.frontBottom, "the gauge in front fits inside the roulette's stage").toBeLessThanOrEqual(m.stageBottom + 1);
  await ctx.close();
});

test("item 5: a Layers drag onto the roulette's row, at the left of its name, puts the widget inside it, with an Into hint", async ({ browser }) => {
  const slug = `r3-layers-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const r = await insertClick(page, id, "roulette");
  await selectLayer(page, r);
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="stat"]').click();
  await skipPicker(page);
  await page.keyboard.press("Escape").catch(() => {});
  await untilDraft(id, (x) => kids(x, r).length === 1);
  await selectLayer(page, rootOf(await draft(id)).id);
  const p = await insertClick(page, id, "progress");
  await page.locator('[data-left-tab="layers"]').click();
  const from = (await page.locator(`[data-layer="${p}"] [data-layer-name]`).boundingBox())!;
  const to = (await page.locator(`[data-layer="${r}"] [data-layer-name]`).boundingBox())!;
  // As the critic did: grab the row's name, drag to 30 px into the roulette row's name, at its middle.
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 25, from.y - 10, { steps: 5 });
  await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 15 });
  await page.waitForTimeout(400);
  const hint = await page.locator(`[data-layer="${r}"]`).getAttribute("data-layer-drop");
  const hintText = await textNow(page.locator(`[data-layer="${r}"] [data-layer-drop-hint]`));
  await page.screenshot({ path: out("r3-5-layers-drag.png") });
  await page.mouse.up();
  const d = await untilDraft(id, (x) => kids(x, r).length === 2);
  note("item5-layers", { hint, hintText, kids: kids(d, r), title: await undoTitle(page) });
  await page.screenshot({ path: out("r3-5-layers-after.png") });
  expect(hint, "the roulette row lights up as the drop's target").toBe("into");
  expect(hintText ?? "", "the row says where it goes").toMatch(/Into/i);
  expect(kids(d, r), "the progress is the roulette's next slot").toEqual(["stat", "progress"]);
  await ctx.close();
});

test("item 14: a Text resize that cannot get shorter says why while dragging; Undo and Redo show a drawn tooltip", async ({ browser }) => {
  const slug = `r3-low-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const t = await insertClick(page, id, "text");
  await selectLayer(page, t);
  const h0 = nodeIn(await draft(id), t)!.slot!.h;
  // Drag the bottom edge's handle up by 90 px, slowly: past the one line of words the new Text holds.
  const handle = page.locator('[data-resize-handle="s"], [data-resize="s"]').first();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - i * 9);
  await page.waitForTimeout(250);
  const during = await textNow(page.locator("[data-resize-note]"));
  await page.screenshot({ path: out("r3-14-text-resize.png") });
  await page.mouse.up();
  note("item14-text", { h0, during });
  expect(during ?? "", "while dragging, a note says why the Text keeps its height").toMatch(/grows to fit its words/i);
  // Undo's drawn tooltip on hover names the step.
  await page.locator("[data-builder-bar] [data-history-undo]").hover();
  const tip = page.locator("[data-tooltip]").filter({ hasText: /Undo/ });
  await expect(tip, "Undo shows a drawn tooltip, not only the browser's").toBeVisible({ timeout: 3000 });
  // It names the newest step, the same words as the button's own label (the clamped resize, or the insert).
  // Read both at the same moment, polled: the clamped resize may still be settling with the server.
  await expect.poll(async () => { const t = (await textNow(tip))?.trim() ?? ""; const u = (await undoTitle(page)) ?? "-"; return t.includes(u) ? "same" : `${t} | ${u}`; }, { timeout: 5000 }).toBe("same");
  await page.screenshot({ path: out("r3-14-undo-tip.png") });
  await ctx.close();
});

// ---------- A's first-timer lows (item 15): the roulette's data picker and the copy-only CSS note ----------
// Stand-in: the 9-machine fake Prometheus (tests/e2e/fixtures), FAKE data; never a real service.
let prom: FakePrometheus | null = null;
let promId = "";
async function promIntegration(): Promise<string> {
  if (promId) return promId;
  prom = await startFakePrometheus();
  const r = await (await owner()).post("/api/integrations", { data: { secrets: {}, untested: true, packageId: "prometheus", name: `Prometheus r3 ${RUN}`, config: { baseUrl: prom.url, authMode: "none" } } });
  if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
  promId = (await r.json()).id as string;
  return promId;
}
test.afterAll(async () => { await prom?.close(); });

test("item 15: a repeat roulette's Pick data lists the lists that fit first, and its preview names the roulette", async ({ browser }) => {
  const integ = await promIntegration();
  const slug = `r3-pick-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const r = await insertClick(page, id, "roulette");
  await selectLayer(page, r);
  const insp = page.locator(`[data-inspector="${r}"]`);
  await insp.locator('[data-field="mode"] select').selectOption("repeat");
  await untilDraft(id, (x) => nodeIn(x, r)?.props.mode === "repeat");
  await insp.locator('[data-pick-button="items"]').first().click();
  // Scoped to this run's own stand-in by its name (a whole-suite run leaves other Prometheus integrations, and a
  // search lists 50 rows at most): "CPU" plus the run token in the integration's name.
  await page.keyboard.type(`CPU ${RUN}`);
  const rows = page.locator(`[data-show-item][data-show-integration="${integ}"]`);
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(600);
  const listed = await rows.evaluateAll((els) => els.map((e) => ({ fits: e.getAttribute("data-fits"), text: (e.textContent ?? "").trim().slice(0, 60) })));
  const preview = await textNow(page.locator("[data-show-preview-empty]"));
  note("item15-pick", { listed, preview });
  await page.screenshot({ path: out("r3-15-roulette-pick.png") });
  expect(listed[0]?.text ?? "", "the first choice is a list (every machine)").toMatch(/Every machine/i);
  expect(listed[0]?.fits, "the first choice fits the roulette's rows").toBe("yes");
  const firstOther = listed.findIndex((x) => x.fits !== "yes");
  const lastFit = listed.map((x) => x.fits).lastIndexOf("yes");
  expect(firstOther === -1 || lastFit < firstOther, "every choice that fits is listed before the ones that do not").toBe(true);
  expect(preview ?? "", "the preview names the widget being set").toMatch(/in the roulette here/);
  await ctx.close();
});

test("item 15: on one Repeat copy, This copy only says the CSS lock in plain words and keeps the selector behind a fold", async ({ browser }) => {
  const integ = await promIntegration();
  const slug = `r3-cp-${RUN}`;
  const id = await newApp(slug);
  const d = await draft(id);
  // Component ids are c_ plus 10 of a to z and 2 to 7: a fixed stem plus this run's 4 letters.
  const tag = RUN.replace(/[^a-z2-7]/g, "a").padEnd(4, "a").slice(0, 4);
  const repeat = `c_rcprep${tag}`;
  const stat = `c_rcpsta${tag}`;
  const ops = [
    { op: "source.set", source: { name: "hosts", integrationId: integ, endpointId: "machines-overview", refreshSec: 30 } },
    { op: "node.add", parentId: rootOf(d).id, node: { id: repeat, type: "repeat", name: "Machines", props: { items: { $bind: "{{ hosts.rows }}" }, columns: 3, max: 50, empty: "No machines" }, slot: { x: 0, y: 0, w: 12, h: 40 }, children: [
      { id: stat, type: "stat", props: { label: { $bind: "{{ $item.name }}" }, value: { $bind: "{{ $item.cpu }}" }, unit: "%" } },
    ] } },
  ];
  const put = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops } });
  if (!put.ok()) throw new Error(`ops failed: ${await put.text()}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const ace = page.locator(`[data-canvas-root] [data-node="${stat}"]`).filter({ hasText: "ACE" }).first();
  await expect(ace).toBeVisible({ timeout: 15_000 });
  await ace.click();
  const insp = page.locator(`[data-inspector="${stat}"]`);
  await insp.locator('[data-copy-scope] [data-copy-mode="one"]').click();
  const cssNote = insp.locator('[data-copy-every="css"]');
  await expect(cssNote).toBeVisible();
  const noteText = (await cssNote.innerText()).trim();
  const fold = insp.locator("[data-copy-css-advanced]");
  const foldShown = await shown(fold);
  const foldOpen = foldShown ? await fold.evaluate((e) => (e as HTMLDetailsElement).open) : null;
  note("item15-copy-css", { noteText, foldShown, foldOpen });
  await page.screenshot({ path: out("r3-15-copy-css.png") });
  expect(noteText, "the lock is said in plain words, with no selector").not.toMatch(/data-row-key/);
  expect(foldShown, "the selector for one copy sits behind a fold").toBe(true);
  expect(foldOpen, "the fold starts closed").toBe(false);
  await ctx.close();
});
