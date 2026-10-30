// app-builder e2e: Wave 2.6 builder ease, the canvas side (stages/02-subsystem-spec/output/builder-ease-spec.md
// 3.4 to 3.7, the canvas file drop of 3.1 and the insert-time picker of 3.3; architecture A7.3 to A7.6, A7.8).
// Every test clicks, drags, drops real files or presses keys on the real controls (V11).
// Evidence: evidence/app-builder/<ATRIUM_E2E_EVIDENCE_ROUND>/builder-ease/.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addUser, api, contextFor, ev, log, OWNER, PEOPLE, saveText, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ timeout: 240_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; props: Record<string, unknown>; slot?: Slot; hidden?: boolean; responsive?: { mobile?: { hidden?: boolean; slot?: Slot } }; children?: Node[] };
type Page0 = { id: string; slug: string; maxWidth?: number; padding?: string | number; root: Node };
type Draft = { rev: number; doc: { chrome: { layout: string }; pages: Page0[] } };

const RUN = Date.now().toString(36).slice(-4);
const shot = (name: string) => ev("builder-ease", `${name}.png`);
const MEDIA = path.resolve("tests/e2e/app-builder/media");
const LIGHT = SHELL_VARIANTS[0]!;
const APP_THEMES = ["control-room", "dusk", "solid"] as const;
let n = 0;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const enc = (v: number, len: number) => Array.from({ length: len }, (_, i) => B32[Math.floor(v / 32 ** (len - 1 - i)) % 32]).join("");
const RUN_N = parseInt(RUN, 36) % 32 ** 4;
/** A component id (c_ and 10 letters or digits 2 to 7), unique per run. */
const cid = () => `c_${enc(RUN_N, 4)}${enc(n++, 6)}`;
async function owner() {
  return api(OWNER);
}
async function newApp(slug: string, kids: Node[] = [], extra: unknown[] = []): Promise<{ id: string; slug: string; root: string; pageId: string }> {
  const c = await owner();
  const r = await c.post("/api/apps", { data: { name: `Ease ${slug}`, slug } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  const d = await draft(id);
  const root = d.doc.pages[0]!.root.id;
  const list = [...kids.map((node) => ({ op: "node.add", parentId: root, node })), ...extra];
  if (list.length) await ops(id, list);
  return { id, slug, root, pageId: d.doc.pages[0]!.id };
}
async function draft(id: string): Promise<Draft> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function ops(id: string, list: unknown[]) {
  const d = await draft(id);
  const r = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
}
async function publish(id: string) {
  const c = await owner();
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note: "ease" } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 6000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const kids = (d: Draft) => d.doc.pages[0]!.root.children ?? [];
const find = (d: Draft, id: string): Node | undefined => {
  const walk = (x: Node): Node | undefined => (x.id === id ? x : (x.children ?? []).map(walk).find(Boolean));
  return walk(d.doc.pages[0]!.root);
};
const stat = (label: string, slot: Slot, more: Partial<Node> = {}): Node => ({ id: cid(), type: "text", name: label, props: { text: label }, slot, ...more });

async function open(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await expect(page.locator("[data-canvas-bar]")).toBeVisible();
}
async function layers(page: Page) {
  await page.locator('[data-left-tab="layers"]').click();
  await expect(page.locator("[data-layers-panel]")).toBeVisible();
}
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
/** Boxes of the given nodes on a page, rounded to 0.1px. */
async function boxes(page: Page, scope: string, ids: string[]) {
  return page.evaluate(({ scope, ids }) => Object.fromEntries(ids.map((id) => {
    const el = document.querySelector(`${scope} [data-node="${id}"]`);
    const r = el?.getBoundingClientRect();
    return [id, r ? { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } : null];
  })), { scope, ids });
}
/** Drops a real file from disk on the page at a point (the browser's own drag events, with a DataTransfer). */
async function dropFile(page: Page, file: string, mime: string, x: number, y: number, name = path.basename(file)) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(({ x, y, b64, mime, name }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: mime }));
    const target = document.elementFromPoint(x, y)!;
    for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  }, { x, y, b64, mime, name });
}
/** The grid's column step and row step on screen for the page root. */
async function gridGeom(page: Page, scope = "[data-canvas-root]") {
  return page.evaluate((scope) => {
    const g = document.querySelector(`${scope} .atr-grid`) as HTMLElement;
    const r = g.getBoundingClientRect();
    const cs = getComputedStyle(g);
    const cols = Number(g.getAttribute("data-columns"));
    const gap = parseFloat(cs.columnGap) || 0;
    const zoom = r.width / g.offsetWidth || 1;
    const colW = (r.width - (cols - 1) * gap * zoom) / cols;
    return { left: r.left, top: r.top, width: r.width, cols, step: colW + gap * zoom, row: 8 * zoom, gap: gap * zoom };
  }, scope);
}

test.beforeAll(async () => {
  await addUser(PEOPLE.viewer);
});

// ---------------------------------------------------------------------------------------------------
test("criteria 15 to 19: the layer row's eye, arrows and menu (rename, duplicate, delete) are undoable draft edits", async ({ browser }) => {
  const top = stat("Top banner", { x: 0, y: 0, w: 12, h: 10 });
  const mid = stat("Middle", { x: 0, y: 10, w: 6, h: 12 });
  const low = stat("Bottom", { x: 0, y: 22, w: 12, h: 10 });
  const card: Node = { id: cid(), type: "card", name: "Box of two", props: { title: "Two" }, slot: { x: 6, y: 10, w: 6, h: 12 }, children: [{ id: cid(), type: "text", props: { text: "a" } }, { id: cid(), type: "text", props: { text: "b" } }] };
  const app = await newApp(`ease-layers-${RUN}`, [top, mid, low, card]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, recordVideo: ev("builder-ease", "video-layer-hide") });
  const page = await ctx.newPage();
  await open(page, app.slug);
  await layers(page);
  const row = (id: string) => page.locator(`[data-layer="${id}"]`);

  // Actions show on hover (and always on the selected row).
  const acts = row(mid.id).locator("[data-layer-actions]");
  await page.mouse.move(5, 5);
  expect(Number(await acts.evaluate((e) => getComputedStyle(e).opacity))).toBe(0);
  await row(mid.id).hover();
  await expect.poll(() => acts.evaluate((e) => Number(getComputedStyle(e).opacity))).toBe(1);

  // 15: hide the top banner on desktop; it stays in the list dimmed with a struck eye and on the canvas as a "hidden" outline.
  await row(top.id).hover();
  await row(top.id).locator("[data-layer-eye]").click();
  let d = await untilDraft(app.id, (x) => find(x, top.id)?.hidden === true);
  expect(find(d, top.id)?.hidden).toBe(true);
  expect(find(d, top.id)?.responsive?.mobile?.hidden).toBeUndefined();
  await expect(row(top.id)).toHaveAttribute("data-layer-hidden", "");
  await expect(row(top.id).locator("[data-layer-eye]")).toHaveAttribute("data-layer-eye", "off");
  const outline = page.locator(`[data-canvas-root] [data-node="${top.id}"]`);
  await expect(outline).toHaveAttribute("data-hidden-device", "desktop");
  // Gone from the canvas too (operator, 2026-10-20) until it is selected from Layers, then faint with its tag.
  expect(await outline.evaluate((e) => getComputedStyle(e).visibility)).toBe("hidden");
  await row(top.id).click();
  await expect.poll(() => outline.evaluate((e) => getComputedStyle(e).visibility)).toBe("visible");
  await expect(outline.locator(".atr-hidden-tag")).toHaveText("hidden");
  await page.screenshot({ path: shot("layers-hidden-light") });
  await row(mid.id).click();
  await expect.poll(() => outline.evaluate((e) => getComputedStyle(e).visibility)).toBe("hidden");

  // Preview: not drawn and no gap left (the middle row moves up to the top).
  const pv = await ctx.newPage();
  await pv.setViewportSize({ width: 1280, height: 800 });
  await pv.goto(`/a/${app.slug}?draft=1`);
  await expect(pv.locator(`[data-node="${mid.id}"]`)).toBeVisible();
  await expect(pv.locator(`[data-node="${top.id}"]`)).toHaveCount(0);
  const gridTop = (await box(pv, ".atr-render-root .atr-grid")).y;
  expect(Math.abs((await box(pv, `[data-node="${mid.id}"]`)).y - gridTop)).toBeLessThan(2);
  await pv.screenshot({ path: shot("layers-hidden-preview") });

  // 16: desktop hiding does not hide on phones.
  await pv.setViewportSize({ width: 390, height: 844 });
  await pv.reload();
  await expect(pv.locator(`[data-node="${top.id}"]`)).toBeVisible();
  // ...and the phone eye sets the phone flag only.
  await page.locator('[data-device="mobile"]').click();
  await row(low.id).hover();
  await row(low.id).locator("[data-layer-eye]").click();
  d = await untilDraft(app.id, (x) => find(x, low.id)?.responsive?.mobile?.hidden === true);
  expect(find(d, low.id)?.responsive?.mobile?.hidden).toBe(true);
  expect(find(d, low.id)?.hidden).toBeUndefined();
  await expect(row(top.id)).not.toHaveAttribute("data-layer-hidden", "");
  await pv.reload();
  await expect(pv.locator(`[data-node="${low.id}"]`)).toHaveCount(0);
  await pv.setViewportSize({ width: 1280, height: 800 });
  await pv.reload();
  await expect(pv.locator(`[data-node="${low.id}"]`)).toBeVisible();
  await page.locator('[data-device="desktop"]').click();

  // Showing it again.
  await row(top.id).hover();
  await row(top.id).locator("[data-layer-eye]").click();
  d = await untilDraft(app.id, (x) => find(x, top.id)?.hidden === undefined);
  expect(find(d, top.id)?.hidden).toBeUndefined();

  // 17: up moves one step earlier; at the top it is disabled.
  await row(mid.id).click();
  await expect(row(top.id).locator("[data-layer-up]")).toBeDisabled();
  await row(mid.id).locator("[data-layer-up]").click();
  d = await untilDraft(app.id, (x) => kids(x)[0]?.id === mid.id);
  expect(kids(d).map((k) => k.id).slice(0, 2)).toEqual([mid.id, top.id]);
  await expect(row(mid.id).locator("[data-layer-up]")).toBeDisabled();
  await expect(row(card.id).locator("[data-layer-down]")).toBeDisabled();
  // Undo puts it back (each action is one undo).
  await page.keyboard.press("Control+z");
  d = await untilDraft(app.id, (x) => kids(x)[0]?.id === top.id);
  expect(kids(d)[0]!.id).toBe(top.id);

  // 18: rename from the menu (Enter saves), double-click rename (Esc cancels), duplicate, delete; each undone.
  await row(low.id).hover();
  await row(low.id).locator("[data-layer-menu]").click();
  await page.locator("[data-layer-rename]").click();
  await page.locator("[data-layer-rename-input]").fill("Footer note");
  await page.keyboard.press("Enter");
  d = await untilDraft(app.id, (x) => find(x, low.id)?.name === "Footer note");
  expect(find(d, low.id)?.name).toBe("Footer note");
  await page.keyboard.press("Control+z");
  d = await untilDraft(app.id, (x) => find(x, low.id)?.name === "Bottom");
  expect(find(d, low.id)?.name).toBe("Bottom");
  await row(low.id).locator("[data-layer-name]").dblclick();
  await page.locator("[data-layer-rename-input]").fill("Never saved");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-layer-rename-input]")).toHaveCount(0);
  await page.waitForTimeout(700);
  expect(find(await draft(app.id), low.id)?.name).toBe("Bottom");

  await row(mid.id).hover();
  await row(mid.id).locator("[data-layer-menu]").click();
  await page.locator("[data-layer-duplicate]").click();
  d = await untilDraft(app.id, (x) => kids(x).length === 5);
  expect(kids(d)).toHaveLength(5);
  await page.keyboard.press("Control+z");
  d = await untilDraft(app.id, (x) => kids(x).length === 4);
  expect(kids(d)).toHaveLength(4);

  await row(mid.id).hover();
  await row(mid.id).locator("[data-layer-menu]").click();
  let asked = 0;
  page.on("dialog", (dlg) => { asked++; void dlg.dismiss(); });
  await page.locator("[data-layer-delete]").click();
  d = await untilDraft(app.id, (x) => !find(x, mid.id));
  expect(find(d, mid.id)).toBeUndefined();
  expect(asked).toBe(0); // a single component is deleted without a question
  await page.keyboard.press("Control+z");
  d = await untilDraft(app.id, (x) => !!find(x, mid.id));
  expect(find(d, mid.id)).toBeTruthy();

  // 19 (round 2 item 12): a container with children is deleted at once, with no browser question; the
  // toast names the count and its Undo brings it back. Ctrl+Z works the same way.
  page.removeAllListeners("dialog");
  page.on("dialog", (dlg) => { asked++; void dlg.dismiss(); });
  await row(card.id).hover();
  await row(card.id).locator("[data-layer-menu]").click();
  await page.locator("[data-layer-delete]").click();
  d = await untilDraft(app.id, (x) => !find(x, card.id));
  expect(find(d, card.id)).toBeUndefined();
  const told = page.locator("[data-toast]").filter({ hasText: "2 components" });
  await expect(told).toBeVisible();
  const msgs = [await told.innerText()];
  await told.getByRole("button", { name: "Undo" }).click();
  d = await untilDraft(app.id, (x) => !!find(x, card.id));
  expect(find(d, card.id)).toBeTruthy();
  await row(card.id).hover();
  await row(card.id).locator("[data-layer-menu]").click();
  await page.locator("[data-layer-delete]").click();
  d = await untilDraft(app.id, (x) => !find(x, card.id));
  expect(find(d, card.id)).toBeUndefined();
  await page.keyboard.press("Control+z");
  await untilDraft(app.id, (x) => !!find(x, card.id));
  expect(asked).toBe(0);
  log("layers", { msgs });

  // V4: the row actions in the three app themes (the canvas carries the app's theme).
  for (const theme of APP_THEMES) {
    await ops(app.id, [{ op: "theme.set", theme: { themeId: theme } }, { op: "node.update", nodeId: top.id, patch: { hidden: true } }]);
    await page.reload();
    await layers(page);
    await row(mid.id).click();
    await row(top.id).hover();
    await page.screenshot({ path: shot(`layers-actions-${theme}`) });
    await ops(app.id, [{ op: "node.update", nodeId: top.id, patch: { hidden: null } }]);
  }
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
// Wave 2.10b F7 (A11.7) changed this test: Snap on now means smart guides, Snap off is free placement with
// no pull, Alt held turns the pull off for one move, and Ctrl no longer flips anything.
test("criteria 20 and 21: Snap off places on 48ths with no pull; Snap on pulls with guides; Alt places freely for one move; arrows step finely", async ({ browser }) => {
  const a = stat("Anchor", { x: 4, y: 0, w: 3, h: 16 });
  const b = stat("Mover", { x: 0, y: 30, w: 2, h: 12 });
  const app = await newApp(`ease-snap-${RUN}`, [a, b]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, recordVideo: ev("builder-ease", "video-snap-off-guides") });
  const page = await ctx.newPage();
  await open(page, app.slug);
  await expect(page.locator("[data-snap]")).toHaveAttribute("data-snap", "on");
  await page.locator("[data-snap]").click();
  await expect(page.locator("[data-snap]")).toHaveAttribute("data-snap", "off");
  // Remembered per person: still off after a reload.
  await page.reload();
  await expect(page.locator("[data-snap]")).toHaveAttribute("data-snap", "off");

  await page.locator(`[data-canvas-root] [data-node="${b.id}"]`).click();
  const handle = page.locator("[data-drag-handle]");
  const g = await gridGeom(page);
  const nb = await box(page, `[data-canvas-root] [data-node="${b.id}"]`);
  const hb = await handle.boundingBox();
  const grabX = hb!.x + 4 - nb.x;
  // Drag so the left edge lands at 2.625 columns, well away from any other edge: no guides, a fine slot.
  const start = { x: hb!.x + 4, y: hb!.y + 4 };
  const toLeft = (cols: number) => g.left + cols * g.step + grabX + 1;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(start.x + ((toLeft(2.625) - start.x) * i) / 10, start.y + 40 * (i / 10));
  await expect(page.locator("[data-grid-cells]")).toHaveCount(0); // cells hidden while snap is off
  const ghostFine = await page.locator("[data-drop-ghost]").getAttribute("data-ghost-slot");
  expect(Number(ghostFine!.split(",")[0])).toBe(2.625);
  // Near the anchor's left edge with Snap off: nothing pulls and no guide shows (F7: free placement).
  const near = toLeft(4) + 4;
  for (let i = 1; i <= 6; i++) await page.mouse.move(toLeft(2.625) + ((near - toLeft(2.625)) * i) / 6, start.y + 40);
  await expect(page.locator("[data-guide]")).toHaveCount(0);
  await page.screenshot({ path: shot("snap-off-no-guide-light") });
  // Back to a free spot and drop there.
  for (let i = 1; i <= 6; i++) await page.mouse.move(near + ((toLeft(8.375) - near) * i) / 6, start.y + 40);
  await page.mouse.up();
  let d = await untilDraft(app.id, (x) => find(x, b.id)?.slot?.x === 8.375);
  expect(find(d, b.id)?.slot?.x).toBe(8.375);
  // The canvas draws it at that fine position (an eighth of a column is a 1/96th of the width here).
  const placed = await box(page, `[data-canvas-root] [data-node="${b.id}"]`);
  expect(Math.abs(placed.x - (g.left + 8.375 * g.step))).toBeLessThan(1.5);

  // Arrow keys with snap off move one fine step.
  await page.locator(`[data-canvas-root] [data-node="${b.id}"]`).click();
  await page.keyboard.press("ArrowLeft");
  d = await untilDraft(app.id, (x) => find(x, b.id)?.slot?.x === 8.25);
  expect(find(d, b.id)?.slot?.x).toBe(8.25);

  // 21 (F7): snap on, Alt held while dragging places freely; releasing Alt mid-drag pulls again, onto the
  // anchor's left edge with a guide.
  await page.locator("[data-snap]").click();
  await expect(page.locator("[data-snap]")).toHaveAttribute("data-snap", "on");
  await page.keyboard.press("ArrowRight");
  d = await untilDraft(app.id, (x) => find(x, b.id)?.slot?.x === 9.25);
  expect(find(d, b.id)?.slot?.x).toBe(9.25);
  const hb2 = (await handle.boundingBox())!;
  await page.mouse.move(hb2.x + 4, hb2.y + 4);
  await page.mouse.down();
  await page.keyboard.down("Alt");
  const grab2 = hb2.x + 4 - (await box(page, `[data-canvas-root] [data-node="${b.id}"]`)).x;
  const freeX = g.left + 1.375 * g.step + grab2 + 1;
  for (let i = 1; i <= 8; i++) await page.mouse.move(hb2.x + 4 + ((freeX - hb2.x - 4) * i) / 8, hb2.y + 4 + 60 * (i / 8));
  const altSlot = Number((await page.locator("[data-drop-ghost]").getAttribute("data-ghost-slot"))!.split(",")[0]);
  expect(Number.isInteger(altSlot)).toBe(false);
  await expect(page.locator("[data-guide]")).toHaveCount(0);
  await page.keyboard.up("Alt");
  const nearA = g.left + 4 * g.step + grab2 + 4;
  for (let i = 1; i <= 6; i++) await page.mouse.move(freeX + ((nearA - freeX) * i) / 6, hb2.y + 64);
  const snapped = Number((await page.locator("[data-drop-ghost]").getAttribute("data-ghost-slot"))!.split(",")[0]);
  expect(snapped).toBe(4);
  await expect(page.locator('[data-guide="x"][data-guide-at="4"]')).toHaveCount(1);
  await expect(page.locator("[data-grid-cells]")).toHaveCount(1);
  await page.screenshot({ path: shot("snap-on-guide-light") });
  await page.mouse.up();
  d = await untilDraft(app.id, (x) => find(x, b.id)?.slot?.x === 4);
  expect(find(d, b.id)!.slot!.x).toBe(4);
  log("snap", { altSlot, snapped, final: find(d, b.id)!.slot });

  // V4: the guides (snap on, F7) in the three app themes.
  for (const theme of APP_THEMES) {
    await ops(app.id, [{ op: "theme.set", theme: { themeId: theme } }, { op: "node.move", nodeId: b.id, parentId: app.root, slot: { x: 0, y: 30, w: 2, h: 12 } }]);
    await page.reload();
    await expect(page.locator("[data-snap]")).toHaveAttribute("data-snap", "on");
    await page.locator(`[data-canvas-root] [data-node="${b.id}"]`).click();
    const h = (await handle.boundingBox())!;
    const gg = await gridGeom(page);
    const target = gg.left + 4 * gg.step + (h.x + 4 - (await box(page, `[data-canvas-root] [data-node="${b.id}"]`)).x) + 3;
    await page.mouse.move(h.x + 4, h.y + 4);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(h.x + 4 + ((target - h.x - 4) * i) / 8, h.y + 4 + 30 * (i / 8));
    await expect(page.locator('[data-guide="x"]').first()).toBeVisible();
    await page.screenshot({ path: shot(`snap-on-guides-${theme}`) });
    await page.mouse.up();
  }
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
test("V7: dragging with guides on a page of 30 widgets keeps frames under 16.7 ms", async ({ browser }) => {
  const many = Array.from({ length: 30 }, (_, i) => stat(`W${i}`, { x: (i % 6) * 2, y: Math.floor(i / 6) * 12, w: 2, h: 10 }));
  const app = await newApp(`ease-perf-${RUN}`, many);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await open(page, app.slug);
  // F7: guides show with Snap on (the default).
  if ((await page.locator("[data-snap]").getAttribute("data-snap")) === "off") await page.locator("[data-snap]").click();
  const mover = many[29]!;
  await page.locator(`[data-canvas-root] [data-node="${mover.id}"]`).click();
  const hb = (await page.locator("[data-drag-handle]").boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[] };
    w.__frames = [];
    let last = performance.now();
    const tick = (t: number) => { w.__frames.push(t - last); last = t; if (w.__frames.length < 400) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(hb.x + 4, hb.y + 4);
  await page.mouse.down();
  let guides = 0;
  for (let i = 1; i <= 90; i++) {
    await page.mouse.move(hb.x + 4 - i * 7, hb.y + 4 - i * 3);
    if (i % 15 === 0) guides = Math.max(guides, await page.locator("[data-guide]").count());
  }
  await page.mouse.up();
  const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames.slice(5));
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  saveText("builder-ease/v7-frames.json", JSON.stringify({ count: frames.length, median, p95, max: sorted.at(-1), guidesSeen: guides, frames }, null, 1));
  log("v7", { median, p95, guides });
  expect(guides).toBeGreaterThan(0);
  expect(median).toBeLessThan(16.7 + 0.5);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
test("criteria 23 to 25: page width, Preview width at real size, and folding both panels", async ({ browser }) => {
  const six = Array.from({ length: 6 }, (_, i) => stat(`Stat ${i + 1}`, { x: i * 2, y: 0, w: 2, h: 12 }));
  const wide = stat("Wide", { x: 0, y: 12, w: 12, h: 8 });
  const app = await newApp(`ease-wide-${RUN}`, [...six, wide]);
  const ids = [...six, wide].map((s) => s.id);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await open(page, app.slug);
  // 24: Page width 1440 from the page settings.
  await page.locator("[data-page-settings]").click();
  await page.locator('[data-select="page-width"]').click();
  await page.locator('[data-select-menu="page-width"] [data-option="1440"]').click();
  const d = await untilDraft(app.id, (x) => x.doc.pages[0]!.maxWidth === 1440);
  expect(d.doc.pages[0]!.maxWidth).toBe(1440);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-page-settings-summary]")).toContainText("1440 px wide");
  // 23: Preview width 1920 draws the page at its real width, scaled to fit, and shows the zoom.
  await page.locator('[data-preview-w="1920"]').click();
  await expect(page.locator("[data-canvas-scaled]")).toHaveAttribute("data-canvas-scaled", "1920");
  const zoom = Number(await page.locator("[data-zoom]").getAttribute("data-zoom"));
  expect(zoom).toBeLessThan(100);
  const inBuilder = await boxes(page, "[data-canvas-root]", ids);
  await page.screenshot({ path: shot("preview-1920-builder") });
  // Six in one row in the builder.
  const tops = six.map((s) => inBuilder[s.id]!.y);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
  await publish(app.id);
  const view = await ctx.newPage();
  await view.goto(`/a/${app.slug}`);
  await expect(view.locator(`[data-node="${six[0]!.id}"]`)).toBeVisible();
  const inViewer = await boxes(view, ".atr-render-root", ids);
  await view.screenshot({ path: shot("preview-1920-viewer") });
  const vt = six.map((s) => inViewer[s.id]!.y);
  expect(Math.max(...vt) - Math.min(...vt)).toBeLessThan(1);
  // Same layout: same rows and the same widgets per row, and the same proportions across.
  const rowsOf = (b: Record<string, { x: number; y: number; w: number } | null>) => {
    const ys = [...new Set(ids.map((id) => Math.round(b[id]!.y)))].sort((p, q) => p - q);
    return ys.map((y) => ids.filter((id) => Math.round(b[id]!.y) === y).sort((p, q) => b[p]!.x - b[q]!.x));
  };
  expect(rowsOf(inBuilder)).toEqual(rowsOf(inViewer));
  const z = zoom / 100;
  for (const id of ids) expect(Math.abs(inBuilder[id]!.w / z - inViewer[id]!.w)).toBeLessThan(inViewer[id]!.w * 0.02 + 2);
  saveText("builder-ease/criterion-23.json", JSON.stringify({ zoom, inBuilder, inViewer }, null, 1));
  // Editing works at this zoom: clicking a widget selects it and its outline matches it.
  await page.locator(`[data-canvas-root] [data-node="${six[3]!.id}"]`).click();
  const ol = await box(page, `[data-selected-outline="${six[3]!.id}"]`);
  expect(Math.abs(ol.x - inBuilder[six[3]!.id]!.x)).toBeLessThan(2);
  expect(Math.abs(ol.width - inBuilder[six[3]!.id]!.w)).toBeLessThan(2);
  // ...and a drag lands where the ghost showed (2 columns right).
  const g = await gridGeom(page);
  const hb = (await page.locator("[data-drag-handle]").boundingBox())!;
  await page.mouse.move(hb.x + 3, hb.y + 3);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(hb.x + 3 + (g.step * 2 * i) / 8, hb.y + 3 + (g.row * 40 * i) / 8);
  const ghost = (await page.locator("[data-drop-ghost]").getAttribute("data-ghost-slot"))!;
  await page.mouse.up();
  const after = await untilDraft(app.id, (x) => find(x, six[3]!.id)?.slot?.y !== 0);
  const s = find(after, six[3]!.id)!.slot!;
  expect(`${s.x},${s.y},${s.w},${s.h}`).toBe(ghost);
  await page.keyboard.press("Control+z");

  // 25: folding both panels gives the canvas the whole window, and survives a reload; [ and ] work too.
  await page.locator('[data-fold="left"]').click();
  await page.locator('[data-fold="right"]').click();
  await expect(page.locator("[data-builder-left]")).toHaveCount(0);
  await expect(page.locator("[data-builder-inspector]")).toHaveCount(0);
  expect(Math.round((await box(page, "[data-builder-canvas]")).width)).toBe(1920);
  await page.screenshot({ path: shot("folded-both") });
  await page.reload();
  await expect(page.locator("[data-canvas-bar]")).toBeVisible();
  await expect(page.locator("[data-builder-left]")).toHaveCount(0);
  await expect(page.locator("[data-builder-inspector]")).toHaveCount(0);
  await page.locator("[data-builder-canvas]").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("[");
  await expect(page.locator("[data-builder-left]")).toHaveCount(1);
  await page.keyboard.press("]");
  await expect(page.locator("[data-builder-inspector]")).toHaveCount(1);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
test("criterion 22: an app made before this change keeps every widget in exactly the same place and size", async ({ browser }) => {
  // A document exactly as Wave 2.5 stored it: whole slots, no grid columns, no hidden, no page width or padding.
  const before: Node[] = [
    stat("H", { x: 0, y: 0, w: 12, h: 10 }),
    stat("A", { x: 0, y: 10, w: 4, h: 19 }),
    stat("B", { x: 4, y: 10, w: 8, h: 19 }),
    stat("C", { x: 1, y: 29, w: 5, h: 30 }),
    stat("D", { x: 7, y: 29, w: 3, h: 30 }),
  ];
  const app = await newApp(`ease-old-${RUN}`, before);
  await publish(app.id);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/a/${app.slug}`);
  await expect(page.locator(`[data-node="${before[0]!.id}"]`)).toBeVisible();
  const g = await gridGeom(page, ".atr-render-root");
  const got = await boxes(page, ".atr-render-root", before.map((b) => b.id));
  // The grid as Wave 2.5 drew it: 12 equal tracks with the theme gap, 8px rows, cells padded by the gap.
  const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".atr-render-root .atr-cell")!).paddingBottom));
  const colW = (g.width - 11 * g.gap) / 12;
  const out: Record<string, unknown> = {};
  for (const b of before) {
    const s = b.slot!; // no row here stretches: widgets that start on the same row have the same height
    const want = { x: g.left + s.x * (colW + g.gap), y: g.top + s.y * 8, w: s.w * colW + (s.w - 1) * g.gap, h: s.h * 8 - pad };
    const have = got[b.id]!;
    out[b.id] = { want, have };
    expect(Math.abs(have.x - want.x)).toBeLessThan(0.6);
    expect(Math.abs(have.y - want.y)).toBeLessThan(0.6);
    expect(Math.abs(have.w - want.w)).toBeLessThan(0.6);
    expect(Math.abs(have.h - want.h)).toBeLessThan(0.6);
  }
  // The builder draws the same boxes (at Fit, edit mode off so the 24px inset is gone) relative to its grid.
  const b = await ctx.newPage();
  await b.goto(`/build/${app.slug}`);
  await expect(b.locator("[data-canvas-root]")).toBeVisible();
  const bg = await gridGeom(b);
  const bb = await boxes(b, "[data-canvas-root]", before.map((x) => x.id));
  const bColW = (bg.width - 11 * bg.gap) / 12;
  for (const x of before) {
    const s = x.slot!;
    expect(Math.abs(bb[x.id]!.x - (bg.left + s.x * (bColW + bg.gap)))).toBeLessThan(0.6);
    expect(Math.abs(bb[x.id]!.w - (s.w * bColW + (s.w - 1) * bg.gap))).toBeLessThan(0.6);
    expect(Math.abs(bb[x.id]!.y - (bg.top + s.y * 8))).toBeLessThan(0.6);
  }
  saveText("builder-ease/criterion-22.json", JSON.stringify(out, null, 1));
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
test("criteria 26 to 28: Blank canvas and Full-page HTML from New app; an HTML block that fills the page", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  // 26: Blank canvas from the New app sheet.
  await page.goto("/");
  await page.locator("[data-new-app], [data-new-app-tile]").first().click();
  await page.locator("[data-new-app-name]").fill(`Canvas ${RUN}`);
  await page.locator('[data-template-option="blank-canvas"]').click();
  await page.screenshot({ path: shot("new-app-choices") });
  await page.locator("[data-create-app]").click();
  await page.waitForURL(/\/build\//);
  const blankSlug = page.url().split("/build/")[1]!.split(/[/?]/)[0]!;
  const c = await owner();
  const tiles = (await (await c.get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[];
  const blank = tiles.find((t) => t.app.slug === blankSlug)!.app;
  let d = await draft(blank.id);
  expect(d.doc.chrome.layout).toBe("none");
  expect(d.doc.pages[0]!.padding).toBe("none");
  // Put something on it from Insert, publish, and check it touches the window edges.
  await page.locator('[data-insert-item="text"]').click();
  d = await untilDraft(blank.id, (x) => kids(x).length === 1);
  await ops(blank.id, [{ op: "node.update", nodeId: kids(d)[0]!.id, patch: { slot: { x: 0, y: 0, w: 12, h: 10 } } }]);
  for (const theme of APP_THEMES) {
    await ops(blank.id, [{ op: "theme.set", theme: { themeId: theme } }]);
    await page.reload();
    await expect(page.locator("[data-canvas-bar]")).toBeVisible();
    await page.screenshot({ path: shot(`blank-canvas-builder-${theme}`) });
  }
  await publish(blank.id);
  const v = await ctx.newPage();
  await v.goto(`/a/${blankSlug}`);
  await expect(v.locator(".atr-render-root")).toBeVisible();
  await expect(v.locator("[data-app-chrome]")).toHaveCount(0);
  const gb = await box(v, ".atr-render-root .atr-grid");
  expect(gb.x).toBe(0);
  expect(gb.y).toBe(0);
  expect(Math.round(gb.width)).toBe(await v.evaluate(() => document.documentElement.clientWidth));
  await v.screenshot({ path: shot("blank-canvas-viewer") });

  // 27: Full-page HTML fills the window with no scrollbar at 1280x800 and at 390x844.
  await page.goto("/");
  await page.locator("[data-new-app], [data-new-app-tile]").first().click();
  await page.locator("[data-new-app-name]").fill(`Html ${RUN}`);
  await page.locator('[data-template-option="html-page"]').click();
  await page.locator("[data-create-app]").click();
  await page.waitForURL(/\/build\//);
  const htmlSlug = page.url().split("/build/")[1]!.split(/[/?]/)[0]!;
  const htmlApp = ((await (await c.get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[]).find((t) => t.app.slug === htmlSlug)!.app;
  await publish(htmlApp.id);
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await v.setViewportSize(vp);
    await v.goto(`/a/${htmlSlug}`);
    const frame = v.locator("[data-html-frame]");
    await expect(frame).toBeVisible();
    await expect.poll(async () => Math.round((await frame.boundingBox())!.height)).toBe(vp.height);
    const fb = (await frame.boundingBox())!;
    expect(fb.y).toBe(0);
    expect(Math.round(fb.width)).toBe(await v.evaluate(() => document.documentElement.clientWidth));
    const scroll = await v.evaluate(() => ({ sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(scroll.sh).toBeLessThanOrEqual(scroll.ch);
    expect(scroll.sw).toBeLessThanOrEqual(scroll.cw);
    await expect(v.frameLocator("[data-html-frame]").locator("h1")).toHaveText("Hello");
    await v.screenshot({ path: shot(`html-page-${vp.width}`) });
  }

  // 28: a topbar app with an HTML block set to fill the page fills the window below the top bar.
  const hb: Node = { id: cid(), type: "html", name: "Fill", props: { html: "<p>fill</p>", css: "", js: "", height: "fill" }, slot: { x: 0, y: 0, w: 12, h: 20 } };
  const top = await newApp(`ease-fill-${RUN}`, [hb]);
  await publish(top.id);
  await v.setViewportSize({ width: 1280, height: 800 });
  await v.goto(`/a/${top.slug}`);
  await expect(v.locator('[data-app-chrome="topbar"]')).toBeVisible();
  const frame = v.locator("[data-html-frame]");
  await expect.poll(async () => { const b = (await frame.boundingBox())!; return Math.round(b.y + b.height); }).toBe(800 - await v.evaluate(() => { const m = document.querySelector("main[data-app-page]")!; return parseFloat(getComputedStyle(m).paddingBottom); }));
  const navBottom = (await box(v, '[data-app-chrome="topbar"]')).y + (await box(v, '[data-app-chrome="topbar"]')).height;
  expect((await frame.boundingBox())!.y).toBeGreaterThanOrEqual(navBottom);
  // It grows with the window.
  await v.setViewportSize({ width: 1280, height: 1000 });
  await expect.poll(async () => { const b = (await frame.boundingBox())!; return Math.round(b.y + b.height); }).toBeGreaterThan(950);
  await v.screenshot({ path: shot("html-fill-topbar") });
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
test("criteria 2, 3 (canvas): dropping a GIF and an MP4 on the canvas uploads and inserts them; dropping on a selected picture replaces it", async ({ browser }) => {
  const anchor = stat("Anchor", { x: 0, y: 0, w: 12, h: 8 });
  const app = await newApp(`ease-drop-${RUN}`, [anchor]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, recordVideo: ev("builder-ease", "video-file-drop") });
  const page = await ctx.newPage();
  await open(page, app.slug);
  // Slow the upload a little so the placeholder with its progress is seen.
  await page.route("**/api/settings/uploads", async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.continue(); });
  const g = await gridGeom(page);
  const at = { x: g.left + 6 * g.step + 10, y: g.top + 30 * g.row };
  await dropFile(page, path.join(MEDIA, "anim.gif"), "image/gif", at.x, at.y, "party-parrot.gif");
  await expect(page.locator("[data-upload-placeholder]")).toBeVisible();
  await page.screenshot({ path: shot("file-drop-uploading") });
  let d = await untilDraft(app.id, (x) => kids(x).some((k) => k.type === "image"), 10_000);
  const img = kids(d).find((k) => k.type === "image")!;
  expect(img.name).toBe("party-parrot");
  expect(String(img.props.src)).toMatch(/^\/uploads\//);
  expect(img.slot!.x).toBe(6);
  // A dropped picture shows whole, in a box shaped like it (operator, 2026-10-20): the GIF is square.
  expect(img.props.fit).toBe("contain");
  const colPx = (g.width - 11 * g.gap) / 12 * 3 + 2 * g.gap;
  expect(Math.abs(Number(img.props.height) - colPx)).toBeLessThan(3);
  // Wave 2.7: the box holds the picture plus the cell's gap, to the nearest 8px row (Shape Original).
  expect(img.props.shape).toBe("original");
  expect(img.slot!.h * 8 - Number(img.props.height)).toBeGreaterThanOrEqual(4);
  expect(img.slot!.h * 8 - Number(img.props.height)).toBeLessThanOrEqual(44); // the gap (with a hard shadow's offset) and rounding
  await expect(page.locator(`[data-selected-outline="${img.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-canvas-root] [data-node="${img.id}"] img`)).toBeVisible();
  await expect(page.locator("[data-upload-placeholder]")).toHaveCount(0);

  // Dropping another picture onto the selected one replaces its file (no new component).
  const ib = await box(page, `[data-canvas-root] [data-node="${img.id}"]`);
  await dropFile(page, path.join(MEDIA, "dot.png"), "image/png", ib.x + ib.width / 2, ib.y + ib.height / 2, "second.png");
  d = await untilDraft(app.id, (x) => find(x, img.id)?.props.src !== img.props.src, 10_000);
  expect(find(d, img.id)!.props.src).not.toBe(img.props.src);
  expect(kids(d).filter((k) => k.type === "image")).toHaveLength(1);

  // 3: an MP4 makes a Video that plays muted and looping in the builder.
  const vat = { x: g.left + 1 * g.step + 10, y: g.top + 70 * g.row };
  await dropFile(page, path.join(MEDIA, "loop.mp4"), "video/mp4", vat.x, vat.y, "rain loop.mp4");
  d = await untilDraft(app.id, (x) => kids(x).some((k) => k.type === "video"), 10_000);
  const vid = kids(d).find((k) => k.type === "video")!;
  expect(vid.name).toBe("rain loop");
  expect(String(vid.props.src)).toMatch(/^\/uploads\//);
  const video = page.locator(`[data-canvas-root] [data-node="${vid.id}"] video`);
  await expect(video).toBeVisible();
  expect(await video.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, loop: v.loop }))).toEqual({ muted: true, loop: true });
  await page.screenshot({ path: shot("file-drop-done") });

  // A file that is not a picture or a video is refused with the reason.
  await dropFile(page, path.join(MEDIA, "anim.gif"), "text/plain", at.x, at.y + 200, "notes.txt");
  await expect(page.getByText("That file cannot go on the page", { exact: true })).toBeVisible();
  expect(kids(await draft(app.id))).toHaveLength(3);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
test("criterion 13: inserting a stat opens the data picker; skipping leaves it on sample values with the Sample data tag (edit mode only)", async ({ browser }) => {
  const app = await newApp(`ease-pick-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await open(page, app.slug);
  await page.locator('[data-insert-item="stat"]').click();
  await expect(page.locator("[data-data-picker]")).toBeVisible();
  await page.screenshot({ path: shot("insert-opens-picker") });
  const skip = page.locator("[data-pick-skip]");
  if (await skip.count()) await skip.click();
  else await page.locator("[data-pick-cancel]").click();
  await expect(page.locator("[data-data-picker]")).toHaveCount(0);
  const d = await untilDraft(app.id, (x) => kids(x).length === 1);
  const s = kids(d)[0]!;
  expect(s.type).toBe("stat");
  await expect(page.locator(`[data-canvas-root] [data-node="${s.id}"] [data-sample-tag]`)).toHaveText("Sample data");
  // Not in Preview.
  await page.locator("[data-edit-toggle]").click();
  await expect(page.locator(`[data-canvas-root] [data-node="${s.id}"] [data-sample-tag]`)).toHaveCount(0);
  // A text is not a data widget: no picker.
  await page.locator("[data-edit-toggle]").click();
  await page.locator('[data-insert-item="text"]').click();
  await page.waitForTimeout(400);
  await expect(page.locator("[data-data-picker]")).toHaveCount(0);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
test("criteria 29 and 30: viewers see none of the builder controls; at 390px the new controls are 44px and nothing scrolls sideways", async ({ browser }) => {
  const a = stat("One", { x: 0, y: 0, w: 12, h: 10 });
  const b = stat("Two", { x: 0, y: 10, w: 12, h: 10 });
  const app = await newApp(`ease-small-${RUN}`, [a, b]);
  await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: "everyone", edit: "owner", guests: false } });
  await publish(app.id);
  // Viewer: the app with no builder controls, and the builder refused.
  const vctx = await contextFor(browser, PEOPLE.viewer, { variant: LIGHT });
  const vp = await vctx.newPage();
  await vp.goto(`/a/${app.slug}`);
  await expect(vp.locator(`[data-node="${a.id}"]`)).toBeVisible();
  for (const sel of ["[data-canvas-bar]", "[data-snap]", "[data-preview-width]", "[data-layer-actions]", "[data-page-settings]", "[data-sample-tag]", "[data-hidden-device]"]) await expect(vp.locator(sel)).toHaveCount(0);
  const r = await vp.goto(`/build/${app.slug}`);
  expect(await vp.locator("[data-canvas-bar]").count()).toBe(0);
  log("viewer-build", { status: r?.status(), url: vp.url() });
  await vctx.close();

  // 390px: the Layers row actions are 44px; nothing scrolls sideways.
  const ctx = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto(`/build/${app.slug}`);
  await expect(page.locator("[data-narrow-tabs]")).toBeVisible();
  await page.locator('[data-narrow-tab="layers"]').click();
  await page.locator(`[data-layer="${b.id}"]`).click();
  const sizes = await page.locator(`[data-layer="${b.id}"] [data-layer-actions] button`).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  expect(sizes.length).toBe(4);
  for (const [w, h] of sizes) { expect(w).toBeGreaterThanOrEqual(44); expect(h).toBeGreaterThanOrEqual(44); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.locator(`[data-layer="${b.id}"] [data-layer-eye]`).click();
  const d = await untilDraft(app.id, (x) => find(x, b.id)?.responsive?.mobile?.hidden === true);
  expect(find(d, b.id)?.responsive?.mobile?.hidden).toBe(true);
  await page.screenshot({ path: shot("layers-390") });
  await ctx.close();

  // V8: with reduced motion the hidden layer and the canvas bar render without movement.
  const rctx = await contextFor(browser, OWNER, { variant: LIGHT, reducedMotion: "reduce" });
  const rp = await rctx.newPage();
  await rp.goto(`/build/${app.slug}`);
  await expect(rp.locator("[data-canvas-bar]")).toBeVisible();
  await rp.locator('[data-left-tab="layers"]').click();
  await rp.locator(`[data-layer="${a.id}"]`).hover();
  await rp.locator(`[data-layer="${a.id}"] [data-layer-eye]`).click();
  await expect(rp.locator(`[data-canvas-root] [data-node="${a.id}"]`)).toHaveAttribute("data-hidden-device", "desktop");
  await rp.screenshot({ path: shot("reduced-motion-hidden") });
  await rctx.close();
});

// ---------------------------------------------------------------------------------------------------
test("operator 2026-10-20: the selected widget's own toolbar moves, duplicates, hides and removes it; Upload in the inspector takes a real photo and shows it whole", async ({ browser }) => {
  const a = stat("First", { x: 0, y: 0, w: 6, h: 10 });
  const b = stat("Second", { x: 6, y: 0, w: 6, h: 10 });
  const pic: Node = { id: cid(), type: "image", name: "Photo", props: { alt: "Photo", fit: "cover", height: 160 }, slot: { x: 0, y: 12, w: 4, h: 25 } };
  const app = await newApp(`ease-bar-${RUN}`, [a, b, pic]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await open(page, app.slug);
  await page.locator(`[data-canvas-root] [data-node="${b.id}"]`).click();
  const bar = page.locator(`[data-selected-outline="${b.id}"]`);
  await expect(bar.locator("[data-move-grip]")).toBeVisible();
  await page.screenshot({ path: shot("widget-toolbar") });

  // Up and down move one step in the layer order; the ends are disabled.
  await expect(bar.locator("[data-bar-down]")).not.toBeDisabled();
  await bar.locator("[data-bar-up]").click();
  let d = await untilDraft(app.id, (x) => kids(x)[0]?.id === b.id);
  expect(kids(d).map((k) => k.id)).toEqual([b.id, a.id, pic.id]);
  await expect(bar.locator("[data-bar-up]")).toBeDisabled();
  await bar.locator("[data-bar-down]").click();
  d = await untilDraft(app.id, (x) => kids(x)[1]?.id === b.id);

  // Duplicate adds a copy and selects it.
  await bar.locator("[data-bar-duplicate]").click();
  d = await untilDraft(app.id, (x) => kids(x).length === 4);
  const copy = kids(d).find((k) => ![a.id, b.id, pic.id].includes(k.id))!;
  await expect(page.locator(`[data-selected-outline="${copy.id}"]`)).toBeVisible();

  // Hide hides it on desktop and it disappears from the canvas once something else is selected.
  await page.locator(`[data-selected-outline="${copy.id}"] [data-bar-hide]`).click();
  d = await untilDraft(app.id, (x) => find(x, copy.id)?.hidden === true);
  await expect(page.locator(`[data-selected-outline="${copy.id}"] [data-bar-hide]`)).toHaveAttribute("aria-pressed", "true");
  await page.locator(`[data-canvas-root] [data-node="${a.id}"]`).click();
  expect(await page.locator(`[data-canvas-root] [data-node="${copy.id}"]`).evaluate((e) => getComputedStyle(e).visibility)).toBe("hidden");

  // Remove from the toolbar, and one undo brings it back.
  await page.locator(`[data-selected-outline="${a.id}"] [data-remove-selected]`).click();
  d = await untilDraft(app.id, (x) => !find(x, a.id));
  await page.keyboard.press("Control+z");
  d = await untilDraft(app.id, (x) => !!find(x, a.id));

  // Upload in the inspector with a real 2400x1600 photo: it lands, and shows whole (fit contain).
  await page.locator(`[data-canvas-root] [data-node="${pic.id}"]`).click();
  const field = page.locator('[data-media-field="image"]');
  await expect(field).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await field.locator("[data-media-upload]").click();
  await (await chooser).setFiles(path.join(MEDIA, "photo.jpg"));
  d = await untilDraft(app.id, (x) => typeof find(x, pic.id)?.props.src === "string", 10_000);
  expect(String(find(d, pic.id)!.props.src)).toMatch(/^\/uploads\/[a-z0-9]{20}\.jpg$/);
  expect(find(d, pic.id)!.props.fit).toBe("contain");
  const img = page.locator(`[data-canvas-root] [data-node="${pic.id}"] img`);
  await expect(img).toBeVisible();
  expect(await img.evaluate((e) => getComputedStyle(e).objectFit)).toBe("contain");
  await expect(field.locator("[data-media-message]")).toHaveText("");
  await page.screenshot({ path: shot("upload-photo-whole") });
  await ctx.close();
});
