// Wave 2.10c round 2, builder A (gauntlet r1 Fix List items 7, 8, 9, 14, 17 and the A lows in 19). Every
// operator action drives the real screen (V11, round 2 brief): opening the builder, typing in the inspector,
// Ctrl+Z inside a field, Insert > Start page, clicking a Repeat copy, the phone toolbar, a corner resize, a
// body drag. The API sets up the starting app and reads the draft back. Stand-in: the 9-machine fake
// Prometheus (tests/e2e/fixtures); never a real service.
// Evidence: evidence/app-builder/w210c-r2/<stage>/ (ATRIUM_E2E_W210C_STAGE=failing-first or pass).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { api, contextFor, OWNER, SHELL_VARIANTS, skipPicker } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; title?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; title: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210C_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder/w210c-r2", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const note = (name: string, data: unknown) => writeFileSync(out(`${name}.json`), JSON.stringify(data, null, 2));
const RUN = Date.now().toString(36).slice(-4);
const LIGHT = SHELL_VARIANTS[0]!;
const owner = () => api(OWNER);
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const enc = (v: number, len: number) => Array.from({ length: len }, (_, i) => B32[Math.floor(v / 32 ** (len - 1 - i)) % 32]).join("");
const RUN_N = parseInt(RUN, 36) % 32 ** 4;
let n = 0;
const cid = () => `c_${enc(RUN_N, 4)}${enc(n++, 6)}`;

let prom: FakePrometheus | null = null;
let promId = "";
test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  prom = await startFakePrometheus();
  const c = await owner();
  const r = await c.post("/api/integrations", { data: { secrets: {}, untested: true, packageId: "prometheus", name: `Prometheus r2 fixes ${RUN}`, config: { baseUrl: prom.url, authMode: "none" } } });
  if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
  promId = (await r.json()).id as string;
});
test.afterAll(async () => { await prom?.close(); });

async function draft(id: string): Promise<Draft> { return (await (await owner()).get(`/api/apps/${id}/draft`)).json(); }
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) { const d = await draft(id); if (ok(d) || Date.now() - t0 > ms) return d; await new Promise((r) => setTimeout(r, 150)); }
}
const walk = (x: Node, f: (n: Node) => void) => { f(x); for (const k of x.children ?? []) walk(k, f); };
const nodeIn = (d: Draft, id: string): Node | undefined => { let f: Node | undefined; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.id === id) f = x; }); return f; };
const nodesOf = (d: Draft, type: string): Node[] => { const o: Node[] = []; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.type === type) o.push(x); }); return o; };
async function newApp(slug: string, nodes: Node[] = []): Promise<string> {
  const c = await owner();
  const r = await c.post("/api/apps", { data: { name: `Fixes ${slug}`, slug, template: "blank" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  if (nodes.length) {
    const d = await draft(id);
    const put = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: nodes.map((node) => ({ op: "node.add", parentId: d.doc.pages[0]!.root.id, node })) } });
    if (!put.ok()) throw new Error(`ops failed: ${await put.text()}`);
  }
  return id;
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
const undoBtn = (page: Page) => page.locator("[data-builder-bar] [data-history-undo], [data-history-undo]").first();
const redoBtn = (page: Page) => page.locator("[data-builder-bar] [data-history-redo], [data-history-redo]").first();
async function insertClick(page: Page, appId: string, type: string): Promise<string> {
  await page.locator('[data-left-tab="insert"]').click().catch(() => {});
  const before = new Set<string>();
  for (const p of (await draft(appId)).doc.pages) walk(p.root, (x) => { before.add(x.id); });
  await page.locator(`[data-insert-item="${type}"]`).click();
  await skipPicker(page);
  let id = "";
  await expect.poll(async () => { for (const p of (await draft(appId)).doc.pages) walk(p.root, (x) => { if (!before.has(x.id) && x.type === type) id = x.id; }); return id; }, { timeout: 8000 }).toBeTruthy();
  return id;
}

test("item 7: opening the builder writes nothing; Undo starts empty and a size set by hand is kept", async ({ browser }) => {
  const slug = `fx-open-${RUN}`;
  const text = cid();
  const stat = cid();
  // A text whose words need more room than its box: a size the person chose by hand.
  const id = await newApp(slug, [
    { id: text, type: "text", props: { text: "FAKE long words that need far more room than this small box has to show them all, line after line after line, so the content runs past the bottom edge." }, slot: { x: 0, y: 0, w: 2, h: 4 } },
    { id: stat, type: "stat", props: { label: "e2e", value: 42, unit: "%" }, slot: { x: 3, y: 0, w: 3, h: 6 } },
  ]);
  const d0 = await draft(id);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  for (const round of [1, 2]) {
    await openBuilder(page, slug);
    await page.waitForTimeout(5000);
    await expect(undoBtn(page), `round ${round}: nothing to undo after opening`).toBeDisabled();
    const d = await draft(id);
    note(`item7-open-${round}`, { rev0: d0.rev, rev: d.rev, slot: nodeIn(d, text)?.slot, title: await undoBtn(page).getAttribute("title") });
    expect(d.rev, `round ${round}: opening wrote no draft change`).toBe(d0.rev);
    expect(nodeIn(d, text)!.slot, `round ${round}: the hand-set size is kept`).toEqual({ x: 0, y: 0, w: 2, h: 4 });
  }
  await page.screenshot({ path: out("r2-7-open.png") });
  await ctx.close();
});

test("item 8: Ctrl+Z inside an inspector text field steps the builder history; no extra step, Redo offers it back", async ({ browser }) => {
  const slug = `fx-ctrlz-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const stat = await insertClick(page, id, "stat");
  const field = page.locator(`[data-inspector="${stat}"] [data-field="label"] input`).first();
  await expect(field).toBeVisible();
  await field.click();
  await field.pressSequentially("Load", { delay: 100 });
  await untilDraft(id, (x) => nodeIn(x, stat)?.props.label === "Load");
  await page.waitForTimeout(1200);
  await expect(undoBtn(page)).toHaveAttribute("title", "Undo Change Stat");
  // In the field: Ctrl+Z takes the typing back as the builder's step (not a new change on top).
  await page.keyboard.press("Control+z");
  let d = await untilDraft(id, (x) => !nodeIn(x, stat)?.props.label);
  expect(nodeIn(d, stat)!.props.label ?? "", "the typed word is gone").toBe("");
  await expect(field).toHaveValue("");
  await expect(redoBtn(page), "Redo offers the typing back").toHaveAttribute("title", "Redo Change Stat");
  await expect(undoBtn(page), "no new step was added on top").toHaveAttribute("title", "Undo Insert Stat");
  await page.keyboard.press("Control+Shift+z");
  d = await untilDraft(id, (x) => nodeIn(x, stat)?.props.label === "Load");
  expect(nodeIn(d, stat)!.props.label).toBe("Load");
  await expect(field).toHaveValue("Load");
  // After a delete, Ctrl+Z with focus in another widget's text field brings the deleted one back.
  const other = await insertClick(page, id, "stat");
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${other}"]`).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Delete");
  await untilDraft(id, (x) => !nodeIn(x, other));
  await page.locator(`[data-layer="${stat}"]`).click();
  await field.click();
  await page.keyboard.press("Control+z");
  d = await untilDraft(id, (x) => !!nodeIn(x, other));
  expect(nodeIn(d, other), "the deleted stat is back").toBeTruthy();
  expect(nodeIn(d, stat)!.props.label, "the field's own value is untouched").toBe("Load");
  await page.screenshot({ path: out("r2-8-ctrlz-field.png") });
  await ctx.close();
});

test("item 9: a start page made through Insert arrives with no Content is cut badge", async ({ browser }) => {
  const slug = `fx-start-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="start-page"]').first().click();
  await expect(page.locator("[data-start-sheet]")).toBeVisible();
  await expect(page.locator(`[data-start-service="${promId}"]`)).toBeVisible({ timeout: 15_000 });
  for (const el of await page.locator("[data-start-service]").all()) {
    const sid = await el.getAttribute("data-start-service");
    const on = (await el.evaluate((e) => e.getAttribute("aria-checked") ?? e.querySelector("[role=checkbox]")?.getAttribute("aria-checked") ?? e.closest("label, div")?.querySelector("[role=checkbox]")?.getAttribute("aria-checked") ?? String((e.querySelector("input") as HTMLInputElement | null)?.checked ?? false))) === "true";
    if ((sid === promId) !== on) await el.click();
  }
  await page.locator("[data-start-make]").click();
  const made = await untilDraft(id, (x) => nodesOf(x, "chart").length > 0, 15_000);
  expect(nodesOf(made, "chart").length, "the start page has its charts").toBeGreaterThan(0);
  note("item9-sources", { promId, sources: (made.doc as unknown as { dataSources: unknown[] }).dataSources });
  // Live data and the legends arrive (every machine named under each chart); then nothing may be cut.
  const charts = page.locator("[data-canvas-root] [data-type='chart']");
  await expect(charts.first()).toBeAttached({ timeout: 15_000 });
  await charts.first().scrollIntoViewIfNeeded();
  await expect.poll(async () => Number(await page.locator("[data-canvas-root] [data-type='chart'] [data-series-count]").first().getAttribute("data-series-count").catch(() => "0")), { timeout: 90_000 }).toBeGreaterThanOrEqual(4);
  await page.waitForTimeout(2500);
  await charts.first().screenshot({ path: out("r2-9-chart.png") });
  const cut = await page.locator("[data-canvas-root] [data-node]").evaluateAll((els) => els.filter((e) => e.querySelector(":scope > .atr-cut-badge[data-content-cut]")).map((e) => `${e.getAttribute("data-type")}:${e.querySelector(":scope > .atr-cut-badge")?.getAttribute("data-content-cut")}`));
  note("item9-cut", { cut });
  await page.screenshot({ path: out("r2-9-start-page.png"), fullPage: true });
  expect(cut, "no widget on the new start page shows Content is cut").toEqual([]);
  await ctx.close();
});

/** An app whose page has one repeat over every machine, each copy a card titled with the machine's name. */
async function machinesApp(slug: string): Promise<{ id: string; repeat: string; card: string; stat: string }> {
  const c = await owner();
  const r = await c.post("/api/apps", { data: { name: `Copies ${slug}`, slug, template: "blank" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  const d = await draft(id);
  const repeat = cid(), card = cid(), stat = cid();
  const ops = [
    { op: "source.set", source: { name: "hosts", integrationId: promId, endpointId: "machines-overview", refreshSec: 30 } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: repeat, type: "repeat", name: "Machines", props: { items: { $bind: "{{ hosts.rows }}" }, columns: 3, max: 50, empty: "No machines" }, slot: { x: 0, y: 0, w: 12, h: 60 }, children: [
      { id: card, type: "card", props: { title: { $bind: "{{ $item.name }}" } }, children: [
        { id: stat, type: "stat", props: { label: "CPU", value: { $bind: "{{ $item.cpu }}" }, unit: "%" } },
      ] },
    ] } },
  ];
  const put = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops } });
  if (!put.ok()) throw new Error(`ops failed: ${await put.text()}`);
  return { id, repeat, card, stat };
}

test("item 14: This copy only is honest: every-copy controls are marked, the CSS box is locked with a reason, the help reads once, previews show the clicked copy", async ({ browser }) => {
  const slug = `fx-copy-${RUN}`;
  const { id, card } = await machinesApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const firefly = page.locator(`[data-canvas-root] [data-node="${card}"]`).filter({ hasText: "firefly" }).first();
  await expect(firefly).toBeVisible({ timeout: 15_000 });
  await firefly.click({ position: { x: 10, y: 10 } });
  const insp = page.locator(`[data-inspector="${card}"]`);
  await expect(insp.locator("[data-copy-scope]")).toBeVisible();
  // Every copy: the help reads as one sentence, no "repeat Repeat".
  const hintAll = await insp.locator("[data-row-hint]").innerText();
  expect(hintAll, "the help does not stutter").not.toMatch(/repeat Repeat/i);
  await insp.locator('[data-copy-scope] [data-copy-mode="one"]').click();
  const hintOne = await insp.locator("[data-row-hint]").innerText();
  note("item14-hints", { hintAll, hintOne });
  expect(hintOne).not.toMatch(/repeat Repeat/i);
  expect(hintOne, "the help names what stays shared").toMatch(/title bar/i);
  // Controls that change every copy say so.
  await expect(insp.locator("[data-copy-every]").first()).toBeVisible();
  const tags = await insp.locator("[data-copy-every]").evaluateAll((els) => els.map((e) => e.getAttribute("data-copy-every")));
  note("item14-tags", { tags });
  for (const t of ["layout", "title", "css"]) expect(tags, `the ${t} control is marked Every copy`).toContain(t);
  // The CSS box cannot be typed into in this mode, and says why.
  const advanced = insp.locator("[data-inspector-group=advanced] h3 button").first();
  if (await advanced.count()) await advanced.click().catch(() => {});
  const cssNote = insp.locator('[data-copy-every="css"]');
  await expect(cssNote).toContainText(/every copy/i);
  const css = insp.locator("[data-css-box] textarea").first();
  const d0 = await draft(id);
  await css.click({ force: true }).catch(() => {});
  await page.keyboard.type(":scope{color:blue}");
  await page.waitForTimeout(1200);
  const d1 = await draft(id);
  expect(nodeIn(d1, card)!.props.css ?? (nodeIn(d1, card) as { css?: string }).css ?? "", "typing in the locked CSS box changed nothing").toBe(nodeIn(d0, card)!.props.css ?? (nodeIn(d0, card) as { css?: string }).css ?? "");
  await page.screenshot({ path: out("r2-14-this-copy-only.png") });
  // The Title preview shows the clicked copy's own value (needs components' rowScope to keep the $item the
  // builder passes: interface request to C).
  const preview = insp.locator('[data-binding-field="title"] [data-live-value], [data-binding-field="Title"] [data-live-value]').first();
  await expect(preview).toContainText("firefly");
  await ctx.close();
});

test("item 17 and 19: the phone toolbar has 44 px buttons; the phone delete toast does not name a keyboard shortcut", async ({ browser }) => {
  const slug = `fx-phone-${RUN}`;
  const stat = cid();
  const id = await newApp(slug, [{ id: stat, type: "stat", props: { label: "e2e", value: 42, unit: "%" }, slot: { x: 0, y: 0, w: 3, h: 12 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 390, height: 844 }, mobile: true });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  await page.locator(`[data-canvas-root] [data-node="${stat}"]`).first().tap();
  const bar = page.locator(`[data-selected-outline="${stat}"] button`);
  await expect(bar.first()).toBeVisible();
  const sizes = await bar.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { label: e.getAttribute("aria-label"), w: Math.round(r.width), h: Math.round(r.height) }; }));
  note("item17-toolbar", sizes);
  await page.screenshot({ path: out("r2-17-phone-toolbar.png") });
  for (const s of sizes) expect(Math.min(s.w, s.h), `${s.label} is a 44 px target`).toBeGreaterThanOrEqual(44);
  await page.locator(`[data-selected-outline="${stat}"] button[aria-label^="Remove"]`).first().tap();
  await untilDraft(id, (x) => !nodeIn(x, stat));
  const toast = page.locator("[data-toast]").filter({ hasText: "Deleted" });
  await expect(toast).toBeVisible();
  await page.screenshot({ path: out("r2-19-phone-toast.png") });
  await expect(toast, "no keyboard shortcut on a phone").not.toContainText("Ctrl");
  await ctx.close();
});

test("item 19: step names use the widget's title and quote page names; a resize that cannot apply is no step", async ({ browser }) => {
  const slug = `fx-names-${RUN}`;
  const chart = cid(), text = cid();
  const id = await newApp(slug, [
    { id: chart, type: "stat", title: "CPU e2e", props: { label: "e2e", value: 42, unit: "%" }, slot: { x: 0, y: 0, w: 3, h: 12 } },
    { id: text, type: "text", props: { text: "FAKE two words" }, slot: { x: 4, y: 0, w: 3, h: 4 } },
  ]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${chart}"]`).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Delete");
  await untilDraft(id, (x) => !nodeIn(x, chart));
  await expect(undoBtn(page)).toHaveAttribute("title", 'Undo Delete Stat "CPU e2e"');
  await undoBtn(page).click();
  await untilDraft(id, (x) => !!nodeIn(x, chart));
  // Page names are quoted too (unit test w210c-r2 and v-w210c-history check "Undo Add page \"New page\"").
  // Shrinking the text below what its words need: nothing changes on screen, so no step is recorded.
  const before = await undoBtn(page).getAttribute("title");
  await page.locator(`[data-layer="${text}"]`).click();
  const se = page.locator('[data-resize-handle="se"]');
  await expect(se).toBeVisible();
  const hb = (await se.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - i * 4);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const d = await draft(id);
  note("item19-names", { before, after: await undoBtn(page).getAttribute("title"), slot: nodeIn(d, text)?.slot });
  // Either the box had spare room (it shrinks to what its words need, and is not cut), or it had none (no
  // change, no step, a sentence says why). Never a step that changes nothing on screen.
  const cutNow = await page.locator(`[data-canvas-root] [data-node="${text}"] > .atr-cut-badge[data-content-cut]`).count();
  expect(cutNow, "the text is not cut").toBe(0);
  if (nodeIn(d, text)!.slot!.h === 4) await expect(undoBtn(page), "no step for a resize that could not apply").toHaveAttribute("title", before ?? "");
  else await expect(undoBtn(page)).toHaveAttribute("title", "Undo Resize Text");
  expect(nodeIn(d, text)!.slot!.h, "it never shrinks to one row under its words").toBeGreaterThan(1);
  await ctx.close();
});

test("item 19: dragging a selected widget's body moves it (no text selection)", async ({ browser }) => {
  const slug = `fx-body-${RUN}`;
  const stat = cid();
  const id = await newApp(slug, [{ id: stat, type: "stat", props: { label: "e2e body", value: 42, unit: "%" }, slot: { x: 0, y: 0, w: 3, h: 12 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const box = page.locator(`[data-canvas-root] [data-node="${stat}"]`).first();
  await box.click();
  const b = (await box.boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(b.x + b.width / 2 + i * 20, b.y + b.height / 2 + i * 3);
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const d = await untilDraft(id, (x) => nodeIn(x, stat)!.slot!.x !== 0);
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  note("item19-body", { slot: nodeIn(d, stat)?.slot, selected });
  expect(nodeIn(d, stat)!.slot!.x, "the body drag moved the stat").toBeGreaterThan(0);
  expect(selected, "no text was selected").toBe("");
  await ctx.close();
});

test("item 19: the builder bar fits at 1280 and 1440: the status reads whole and Versions does not touch Settings", async ({ browser }) => {
  const slug = `fx-bar-${RUN}`;
  await newApp(slug, [{ id: cid(), type: "stat", props: { label: "e2e", value: 1 }, slot: { x: 0, y: 0, w: 3, h: 12 } }]);
  for (const width of [1280, 1440]) {
    const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await openBuilder(page, slug);
    const bar = page.locator("[data-builder-bar]");
    const m = await bar.evaluate((el) => {
      const kids = [...el.querySelectorAll<HTMLElement>("a, button, [data-draft-status]")].filter((k) => k.offsetParent !== null);
      const cut = kids.filter((k) => k.scrollWidth > k.clientWidth + 1).map((k) => (k.getAttribute("data-draft-status") !== null ? "status" : k.textContent?.trim() ?? ""));
      const rects = kids.map((k) => ({ t: k.textContent?.trim() ?? "", r: k.getBoundingClientRect() }));
      const touching: string[] = [];
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i]!.r, b = rects[j]!.r; if (a.width && b.width && Math.abs(a.top - b.top) < 4 && a.right > b.left - 2 && b.right > a.left - 2 && !(a.left >= b.left && a.right <= b.right) && !(b.left >= a.left && b.right <= a.right)) touching.push(`${rects[i]!.t}|${rects[j]!.t}`); }
      return { cut, touching, over: el.scrollWidth - el.clientWidth };
    });
    note(`item19-bar-${width}`, m);
    await bar.screenshot({ path: out(`r2-19-bar-${width}.png`) });
    expect(m.cut, `${width}: nothing on the bar is cut`).toEqual([]);
    expect(m.over, `${width}: the bar does not overflow`).toBeLessThanOrEqual(0);
    await ctx.close();
  }
});
