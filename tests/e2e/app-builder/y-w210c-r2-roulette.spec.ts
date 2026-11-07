// Wave 2.10c round 2, builder A (gauntlet r1 Fix List items 1, 4 and 5). Every operator action drives the
// real screen the way the critics did (V11, round 2 brief): an Insert click, a drag from Insert, a drag of a
// widget's handle on the canvas, a Layers drag, Ctrl+X and Ctrl+V, the Delete key and the toast, the bar's
// Undo and Redo, the inspector's Fit. The API is only read, to check what the draft holds.
// Evidence: evidence/app-builder/w210c-r2/<stage>/ (ATRIUM_E2E_W210C_STAGE=failing-first or pass).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { api, contextFor, OWNER, SHELL_VARIANTS, skipPicker } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210C_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder/w210c-r2", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
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
const kids = (d: Draft, id: string) => (nodeIn(d, id)?.children ?? []).map((c) => c.type);
const rootOf = (d: Draft) => d.doc.pages[0]!.root;
async function newApp(slug: string): Promise<string> {
  const r = await (await owner()).post("/api/apps", { data: { name: `Roulette ${slug}`, slug, template: "blank" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app.id as string;
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
/** Clicks an Insert tile (the operator's Insert click) and returns the new widget's id from the draft. */
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
/** A slow pointer drag from one point to another, the way a person moves a mouse. */
async function dragPointer(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 18;
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.waitForTimeout(250);
  if (during) await during();
  await page.mouse.up();
}
const centre = async (l: Locator) => { await l.first().scrollIntoViewIfNeeded(); const b = (await l.first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const roulette = (page: Page, id: string) => page.locator(`[data-canvas-root] [data-node="${id}"]`).first();
async function setMode(page: Page, rouletteId: string, mode: "slots" | "repeat") {
  await selectLayer(page, rouletteId);
  const f = page.locator(`[data-inspector="${rouletteId}"] [data-field="mode"]`).first();
  await expect(f).toBeVisible();
  const sel = f.locator("select");
  if (await sel.count()) await sel.selectOption(mode);
  else await f.locator(`[data-choice="${mode}"], [role=radio][value="${mode}"]`).first().click();
}

test("item 1 slots mode: drop from Insert, Insert click, a canvas move, a Layers drag and Ctrl+X then Ctrl+V each put the widget inside the roulette", async ({ browser }) => {
  const slug = `rl-slots-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const steps: Record<string, unknown> = {};

  const r = await insertClick(page, id, "roulette");
  await expect(roulette(page, r).locator("[data-roulette-drop], [data-roulette-empty]").first()).toBeVisible();

  // (a) Drag Stat from Insert onto "Drop widgets here": the roulette lights up as the target, and the stat
  // becomes its first slot (not a page widget beside it).
  await page.locator('[data-left-tab="insert"]').click();
  let lit = false;
  await dragPointer(page, await centre(page.locator('[data-insert-item="stat"]')), await centre(roulette(page, r).locator("[data-roulette-drop], [data-roulette-empty]").first()), async () => {
    lit = await page.locator(`[data-drop-into="${r}"]`).isVisible();
    await page.screenshot({ path: out("r2-1a-drag-over-roulette.png") });
  });
  await skipPicker(page);
  await page.keyboard.press("Escape").catch(() => {});
  let d = await untilDraft(id, (x) => kids(x, r).includes("stat"));
  steps.a = { lit, kids: kids(d, r) };
  expect(lit, "the roulette highlights as the drop target during the drag").toBe(true);
  expect(kids(d, r), "the dragged stat is the roulette's slot").toEqual(["stat"]);

  // (b) With the roulette selected, an Insert click adds into it.
  await selectLayer(page, r);
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="text"]').click();
  await skipPicker(page);
  d = await untilDraft(id, (x) => kids(x, r).includes("text"));
  steps.b = kids(d, r);
  expect(kids(d, r), "Insert with the roulette selected adds a slot").toEqual(["stat", "text"]);

  // (c) A widget on the page, moved onto the roulette by its drag handle.
  await selectLayer(page, rootOf(d).id);
  const clock = await insertClick(page, id, "clock");
  d = await draft(id);
  expect(rootOf(d).children!.map((c) => c.id), "the clock starts on the page").toContain(clock);
  await selectLayer(page, clock);
  const handle = page.locator(`[data-selected-outline="${clock}"] [data-drag-handle]`);
  await expect(handle).toBeVisible();
  await dragPointer(page, await centre(handle), await centre(roulette(page, r)));
  d = await untilDraft(id, (x) => kids(x, r).includes("clock"));
  steps.c = kids(d, r);
  expect(kids(d, r), "moving the clock onto the roulette makes it a slot").toEqual(["stat", "text", "clock"]);

  // (d) Layers: a heading's row dropped on the right half of the roulette's row.
  await selectLayer(page, rootOf(d).id);
  const heading = await insertClick(page, id, "heading");
  await page.locator('[data-left-tab="layers"]').click();
  const rowR = page.locator(`[data-layer="${r}"]`);
  const rb = (await rowR.boundingBox())!;
  await page.locator(`[data-layer="${heading}"]`).dragTo(rowR, { targetPosition: { x: rb.width - 12, y: rb.height / 2 } });
  d = await untilDraft(id, (x) => kids(x, r).includes("heading"));
  steps.d = kids(d, r);
  expect(kids(d, r), "a Layers drag onto the roulette's row nests the heading").toEqual(["stat", "text", "clock", "heading"]);

  // (e) Ctrl+X on a page widget, then Ctrl+V with the roulette selected.
  await selectLayer(page, rootOf(d).id);
  const gauge = await insertClick(page, id, "gauge");
  await selectLayer(page, gauge);
  await page.locator(`[data-canvas-root] [data-node="${gauge}"]`).first().click();
  await page.keyboard.press("Control+x");
  d = await untilDraft(id, (x) => !nodeIn(x, gauge));
  expect(nodeIn(d, gauge), "Ctrl+X takes the gauge off the page").toBeUndefined();
  await selectLayer(page, r);
  await page.keyboard.press("Control+v");
  d = await untilDraft(id, (x) => kids(x, r).includes("gauge"));
  steps.e = kids(d, r);
  expect(kids(d, r), "Ctrl+V with the roulette selected pastes it in as a slot").toEqual(["stat", "text", "clock", "heading", "gauge"]);
  expect(rootOf(d).children!.filter((c) => c.type !== "roulette").length, "nothing was left beside it on the page").toBe(0);
  await page.screenshot({ path: out("r2-1-slots-filled.png") });
  note("item1-slots", steps);
  await ctx.close();
});

test("item 1 repeat mode: the empty roulette takes one template; a second drop is refused with a sentence", async ({ browser }) => {
  const slug = `rl-rep-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const r = await insertClick(page, id, "roulette");
  await setMode(page, r, "repeat");
  await untilDraft(id, (x) => nodeIn(x, r)?.props.mode === "repeat");
  await page.locator('[data-left-tab="insert"]').click();
  await dragPointer(page, await centre(page.locator('[data-insert-item="stat"]')), await centre(roulette(page, r)));
  await skipPicker(page);
  await page.keyboard.press("Escape").catch(() => {});
  let d = await untilDraft(id, (x) => kids(x, r).length === 1);
  expect(kids(d, r), "the stat is the roulette's one template").toEqual(["stat"]);
  // A second drop: refused in words, nothing changes.
  await page.locator('[data-left-tab="insert"]').click();
  await dragPointer(page, await centre(page.locator('[data-insert-item="text"]')), await centre(roulette(page, r)));
  await expect(page.locator("[data-toast]").filter({ hasText: "already has" })).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: out("r2-1-repeat-refused.png") });
  d = await draft(id);
  expect(kids(d, r), "the template is unchanged").toEqual(["stat"]);
  expect(rootOf(d).children!.map((c) => c.type), "nothing landed on the page either").toEqual(["roulette"]);
  await ctx.close();
});

test("item 5: deleting a roulette slot undoes from the toast and the bar, back in its place, with no false conflict", async ({ browser }) => {
  const slug = `rl-del-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const r = await insertClick(page, id, "roulette");
  for (const t of ["text", "clock", "heading"]) {
    await selectLayer(page, r);
    await page.locator('[data-left-tab="insert"]').click();
    await page.locator(`[data-insert-item="${t}"]`).click();
    await skipPicker(page);
    await untilDraft(id, (x) => kids(x, r).includes(t));
  }
  let d = await draft(id);
  const order = nodeIn(d, r)!.children!.map((c) => c.id);
  expect(order.length, "three slots").toBe(3);
  const clock = order[1]!;
  // Delete key on the selected slot; the toast's Undo puts it back at index 1.
  await selectLayer(page, clock);
  await page.locator('[data-left-tab="layers"]').focus().catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Delete");
  d = await untilDraft(id, (x) => !nodeIn(x, clock));
  expect(nodeIn(d, clock), "Delete removed the slot").toBeUndefined();
  const toast = page.locator("[data-toast]").filter({ hasText: "Deleted" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Undo" }).click();
  d = await untilDraft(id, (x) => !!nodeIn(x, clock));
  await expect(page.locator("[data-toast]").filter({ hasText: "skipped" })).toHaveCount(0);
  expect(nodeIn(d, r)!.children!.map((c) => c.id), "the toast's Undo put it back in its place").toEqual(order);
  // Again through the bar's Undo and Redo.
  await selectLayer(page, clock);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Delete");
  await untilDraft(id, (x) => !nodeIn(x, clock));
  await page.locator("[data-builder-bar] [data-history-undo]").click();
  d = await untilDraft(id, (x) => !!nodeIn(x, clock));
  expect(nodeIn(d, r)!.children!.map((c) => c.id), "the bar's Undo put it back in its place").toEqual(order);
  await page.locator("[data-builder-bar] [data-history-redo]").click();
  d = await untilDraft(id, (x) => !nodeIn(x, clock));
  expect(nodeIn(d, clock), "Redo deletes it again").toBeUndefined();
  await expect(page.locator("[data-toast]").filter({ hasText: "skipped" })).toHaveCount(0);
  await page.screenshot({ path: out("r2-5-after-redo.png") });
  await ctx.close();
});

test("item 4: Fit on a slots-mode roulette sizes it to its front slot at most, as one step named Fit Roulette", async ({ browser }) => {
  const slug = `rl-fit-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const r = await insertClick(page, id, "roulette");
  for (const t of ["stat", "stat", "text"]) {
    await selectLayer(page, r);
    await page.locator('[data-left-tab="insert"]').click();
    await page.locator(`[data-insert-item="${t}"]`).click();
    await skipPicker(page);
    await page.keyboard.press("Escape").catch(() => {});
  }
  let d = await untilDraft(id, (x) => kids(x, r).length === 3);
  expect(kids(d, r).length, "three slots").toBe(3);
  // A widget below it, so a runaway Fit would push it down.
  await selectLayer(page, rootOf(d).id);
  await insertClick(page, id, "text");
  d = await draft(id);
  const h0 = nodeIn(d, r)!.slot!.h;
  await selectLayer(page, r);
  const fit = page.locator(`[data-inspector="${r}"] [data-layout-fit]`).first();
  if (!(await fit.isVisible())) await page.locator(`[data-inspector="${r}"]`).getByText("Layout", { exact: true }).first().click();
  // Made too small by hand first (64 px), so Fit has something to do.
  const hField = page.locator(`[data-inspector="${r}"] [data-layout-field="h"]`).first();
  const more = page.locator(`[data-inspector="${r}"] [data-more-settings="layout"]`).first();
  if (!(await hField.isVisible())) await more.locator(":scope > button").first().click();
  await hField.fill("64");
  await hField.press("Enter");
  await untilDraft(id, (x) => nodeIn(x, r)!.slot!.h === 8);
  await fit.click();
  await page.waitForTimeout(1500);
  d = await draft(id);
  const h1 = nodeIn(d, r)!.slot!.h;
  const title = await page.locator("[data-builder-bar] [data-history-undo]").getAttribute("title");
  note("item4-fit", { h0, h1, title });
  await page.screenshot({ path: out("r2-4-fit-roulette.png") });
  // A stat slot needs a stat's box plus the arrows and dots: never more than 20 rows above its start box.
  expect(h1, "Fit does not grow the roulette by the whole drum").toBeLessThanOrEqual(h0 + 20);
  expect(h1, "Fit grew the too-small roulette back").toBeGreaterThan(8);
  expect(title, "the step is named after the Fit").toBe("Undo Fit Roulette");
  await ctx.close();
});
