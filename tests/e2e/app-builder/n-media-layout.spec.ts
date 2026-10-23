// Wave 2.7 placing and arranging (stages/02-subsystem-spec/output/media-layout-spec.md 3.2; criteria 10, 13
// to 16, 18) through the real builder (V11): Insert beside to six stats across, Duplicate beside, Shift-click
// and box multi-select with Align, Distribute, Same width, Hide, Delete, Duplicate and group moves (one undo
// each), "covered" on Layers, Insert, drop and Layers drag into a Repeat or a selected container, a dropped
// 16:9 WebM, and a viewer using Enlarge. Runs on the app-builder slot or, with ATRIUM_E2E_PORT and
// ATRIUM_E2E_DATA_DIR, on another slot's server (builder M ran it on the components slot, 3114).
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { addUser, api, contextFor, ev, log, OWNER, PEOPLE, SHELL_VARIANTS, skipPicker } from "./helpers";

test.describe.configure({ timeout: 240_000 });
const RUN = Date.now().toString(36).slice(-4);
const MEDIA = path.resolve("tests/e2e/components/media");
const LIGHT = SHELL_VARIANTS[0]!;
type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: Slot; children?: Node[]; name?: string; hidden?: boolean };
type Draft = { rev: number; doc: { pages: { id: string; slug: string; root: Node }[] } };
const shot = (n: string) => ev("media-layout", `${n}.png`);

let n = 0;
const cid = () => `c_ml${RUN.replace(/[^a-z]/g, "a").padEnd(4, "a").slice(0, 4)}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(n / 26) % 26]}${"abcdefghijklmnopqrstuvwxyz"[n++ % 26]}aa`;
const stat = (name: string, slot: Slot): Node => ({ id: cid(), type: "stat", name, props: { label: name, value: 1 }, slot });
const owner = () => api(OWNER);
async function draft(id: string): Promise<Draft> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function ops(id: string, list: unknown[]) {
  const d = await draft(id);
  const r = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
}
async function newApp(slug: string, kids: Node[] = []): Promise<{ id: string; slug: string; root: string }> {
  const r = await (await owner()).post("/api/apps", { data: { name: `Layout ${slug}`, slug } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  const root = (await draft(id)).doc.pages[0]!.root.id;
  if (kids.length) await ops(id, kids.map((node) => ({ op: "node.add", parentId: root, node })));
  return { id, slug, root };
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
const overlap = (a: Slot, b: Slot) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
async function open(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-canvas-bar]")).toBeVisible();
}
const node = (page: Page, id: string) => page.locator(`[data-canvas-root] [data-node="${id}"]`);
async function insert(page: Page, type: string) {
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator(`[data-insert-item="${type}"]`).first().click();
  await skipPicker(page);
}
/** Undo with the keyboard, as from the page (the inspector column keeps its own keys). */
async function undo(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+z");
}
async function dropFile(page: Page, file: string, mime: string, x: number, y: number) {
  const b64 = readFileSync(file).toString("base64");
  await page.evaluate(({ x, y, b64, mime, name }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: mime }));
    const target = document.elementFromPoint(x, y)!;
    for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  }, { x, y, b64, mime, name: path.basename(file) });
}
async function gridGeom(page: Page) {
  return page.evaluate(() => {
    const g = document.querySelector("[data-canvas-root] .atr-grid") as HTMLElement;
    const r = g.getBoundingClientRect();
    const cs = getComputedStyle(g);
    const cols = Number(g.getAttribute("data-columns"));
    const gap = parseFloat(cs.columnGap) || 0;
    const colW = (r.width - (cols - 1) * gap) / cols;
    return { left: r.left, top: r.top, width: r.width, step: colW + gap, row: 8 };
  });
}

test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== "desktop", "desktop project");
});

test("criterion 13: with a stat selected, Insert Stat five times gives six stats across one row with no typing", async ({ browser }) => {
  const app = await newApp(`ml-six-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 }, recordVideo: ev("media-layout", "video-six-across") });
  const page = await ctx.newPage();
  await open(page, app.slug);
  await insert(page, "stat");
  let d = await untilDraft(app.id, (x) => kids(x).length === 1);
  const first = kids(d)[0]!;
  expect(first.slot).toMatchObject({ x: 0, y: 0, w: 3 });
  // Make it a sixth of the row by dragging its east handle one column left (no typing).
  const g = await gridGeom(page);
  const h = (await page.locator('[data-resize-handle="e"]').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(h.x + h.width / 2 - (g.step * i) / 6, h.y + h.height / 2);
  await page.mouse.up();
  d = await untilDraft(app.id, (x) => kids(x)[0]?.slot?.w === 2);
  expect(kids(d)[0]!.slot!.w).toBe(2);
  for (let i = 0; i < 5; i++) {
    await insert(page, "stat");
    d = await untilDraft(app.id, (x) => kids(x).length === i + 2);
  }
  const slots = kids(d).map((k) => k.slot!);
  log("six across", slots);
  expect(slots.map((s) => [s.x, s.y, s.w])).toEqual([[0, 0, 2], [2, 0, 2], [4, 0, 2], [6, 0, 2], [8, 0, 2], [10, 0, 2]]);
  // On screen too: six boxes in one row, left to right.
  const tops = await Promise.all(kids(d).map(async (k) => (await node(page, k.id).boundingBox())!.y));
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: shot("six-stats-across") });
  await ctx.close();
});

test("criterion 14: Duplicate puts the copy beside the original, selected and in view, never over another widget", async ({ browser }) => {
  const a = stat("Original", { x: 0, y: 0, w: 4, h: 20 });
  const chart: Node = { id: cid(), type: "chart", name: "Chart", props: {}, slot: { x: 0, y: 20, w: 12, h: 35 } };
  const app = await newApp(`ml-dup-${RUN}`, [a, chart]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, app.slug);
  await node(page, a.id).click();
  await page.locator(`[data-selected-outline="${a.id}"] [data-bar-duplicate]`).click();
  let d = await untilDraft(app.id, (x) => kids(x).length === 3);
  const copy = kids(d).find((k) => k.id !== a.id && k.id !== chart.id)!;
  expect(copy.slot).toEqual({ x: 4, y: 0, w: 4, h: 20 });
  for (const k of kids(d)) if (k.id !== copy.id) expect(overlap(copy.slot!, k.slot!), `copy over ${k.name}`).toBe(false);
  await expect(page.locator(`[data-selected-outline="${copy.id}"]`)).toBeVisible();
  const vb = (await page.locator("[data-builder-canvas]").boundingBox())!;
  const cb = (await node(page, copy.id).boundingBox())!;
  expect(cb.y >= vb.y && cb.y + cb.height <= vb.y + vb.height).toBe(true);
  // Ctrl+D on the copy: the next spot on the row.
  await node(page, copy.id).click();
  await page.keyboard.press("Control+d");
  d = await untilDraft(app.id, (x) => kids(x).length === 4);
  const third = kids(d).find((k) => ![a.id, chart.id, copy.id].includes(k.id))!;
  expect(third.slot).toEqual({ x: 8, y: 0, w: 4, h: 20 });
  await expect(page.locator(`[data-selected-outline="${third.id}"]`)).toBeVisible();
  await page.screenshot({ path: shot("duplicate-beside") });
  await ctx.close();
});

test("criteria 15 and 16: Shift-click three widgets, Align top, Distribute across, Same width, group move; a box selects; Hide, Duplicate and Delete; one undo each", async ({ browser }) => {
  const a = stat("Alpha", { x: 0, y: 2, w: 2, h: 10 });
  const b = stat("Bravo", { x: 3, y: 8, w: 3, h: 14 });
  const c = stat("Charlie", { x: 10, y: 0, w: 2, h: 8 });
  const app = await newApp(`ml-multi-${RUN}`, [a, b, c]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 }, recordVideo: ev("media-layout", "video-multi-select") });
  const page = await ctx.newPage();
  await open(page, app.slug);
  await node(page, a.id).click();
  await node(page, b.id).click({ modifiers: ["Shift"] });
  await node(page, c.id).click({ modifiers: ["Shift"] });
  const bar = page.locator("[data-arrange-bar]");
  await expect(bar).toHaveAttribute("data-arrange-bar", "3");
  await expect(page.locator("[data-multi-outline]")).toHaveCount(3);
  await expect(page.locator("[data-multi-panel]")).toBeVisible();
  await page.screenshot({ path: shot("multi-select-toolbar") });
  const slots = (d: Draft) => [a, b, c].map((x) => find(d, x.id)!.slot!);

  // Align top: one top, then one undo puts every one back.
  await bar.locator('[data-arrange="top"]').click();
  let d = await untilDraft(app.id, (x) => new Set(slots(x).map((s) => s.y)).size === 1);
  expect(slots(d).map((s) => s.y)).toEqual([0, 0, 0]);
  await page.screenshot({ path: shot("multi-align-top") });
  await undo(page);
  d = await untilDraft(app.id, (x) => slots(x)[0]!.y === 2);
  expect(slots(d).map((s) => s.y)).toEqual([2, 8, 0]);
  // Distribute across: equal gaps between neighbours.
  await bar.locator('[data-arrange="across"]').click();
  d = await untilDraft(app.id, (x) => slots(x)[1]!.x !== 3);
  const s = slots(d).sort((p, q) => p.x - q.x);
  expect(s[1]!.x - (s[0]!.x + s[0]!.w)).toBeCloseTo(s[2]!.x - (s[1]!.x + s[1]!.w), 5);
  await undo(page);
  d = await untilDraft(app.id, (x) => slots(x)[1]!.x === 3);
  // Same width from the inspector column's words: as wide as the first one picked (Alpha).
  await page.locator('[data-multi-action="width"]').click();
  d = await untilDraft(app.id, (x) => slots(x).every((q) => q.w === 2));
  expect(slots(d).map((q) => q.w)).toEqual([2, 2, 2]);
  await undo(page);
  d = await untilDraft(app.id, (x) => slots(x)[1]!.w === 3);

  // Criterion 16: dragging one of the three moves all three by the same amount (V7 frames sampled).
  const before = slots(await draft(app.id));
  const g = await gridGeom(page);
  const grip = (await page.locator(`[data-multi-grip="${b.id}"]`).boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __f: number[]; __s: boolean };
    w.__f = [];
    w.__s = false;
    let last = performance.now();
    const t = (now: number) => { w.__f.push(now - last); last = now; if (!w.__s) requestAnimationFrame(t); };
    requestAnimationFrame(t);
  });
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(grip.x + grip.width / 2 + (g.step * 1 * i) / 30, grip.y + grip.height / 2 + (g.row * 6 * i) / 30);
  await expect(page.locator("[data-group-ghost]")).toHaveCount(2);
  await page.screenshot({ path: shot("multi-group-move-ghosts") });
  await page.mouse.up();
  const frames = await page.evaluate(() => { const w = window as unknown as { __f: number[]; __s: boolean }; w.__s = true; return w.__f.slice(1); });
  d = await untilDraft(app.id, (x) => slots(x)[0]!.y !== before[0]!.y);
  const after = slots(d);
  const dx = after[1]!.x - before[1]!.x;
  const dy = after[1]!.y - before[1]!.y;
  // Charlie is at the right edge, so the group is held there as one: nothing moves across, all move down 6.
  log("group move", { before, after, frames: frames.length });
  expect(dx).toBe(0);
  expect(dy).toBeGreaterThanOrEqual(5); // the pointer travelled six rows; the grip sits above the box
  for (let i = 0; i < 3; i++) expect([after[i]!.x - before[i]!.x, after[i]!.y - before[i]!.y]).toEqual([dx, dy]);
  const sorted = [...frames].sort((p, q) => p - q);
  log("V7 group move frames", { count: frames.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)] });
  await undo(page);
  d = await untilDraft(app.id, (x) => slots(x)[0]!.y === before[0]!.y);

  // Hide all three, then show them again (one undo).
  await bar.locator('[data-arrange="hide"]').click();
  d = await untilDraft(app.id, (x) => [a, b, c].every((q) => find(x, q.id)?.hidden === true));
  await undo(page);
  d = await untilDraft(app.id, (x) => [a, b, c].every((q) => !find(x, q.id)?.hidden));
  // Escape ends the selection; a box dragged on empty canvas selects the two it touches.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-arrange-bar]")).toHaveCount(0);
  const ab = (await node(page, a.id).boundingBox())!;
  const bb = (await node(page, b.id).boundingBox())!;
  // Start on empty grid between Bravo and Charlie's column, so the box takes Alpha and Bravo only.
  const startX = g.left + 8 * g.step + 10;
  const startY = bb.y + 40;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(startX + (ab.x + 10 - startX) * (i / 10), startY + (ab.y + 10 - startY) * (i / 10));
  await expect(page.locator("[data-marquee]")).toBeVisible();
  await page.screenshot({ path: shot("multi-box-select") });
  await page.mouse.up();
  await expect(page.locator("[data-arrange-bar]")).toHaveAttribute("data-arrange-bar", "2");
  await expect(page.locator(`[data-multi-outline="${a.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-multi-outline="${b.id}"]`)).toBeVisible();
  // Duplicate the two: copies land where they cover nothing.
  await page.locator("[data-arrange-bar] [data-arrange=\"duplicate\"]").click();
  d = await untilDraft(app.id, (x) => kids(x).length === 5);
  const all = kids(d).map((k) => k.slot!);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!)).toBe(false);
  await expect(page.locator("[data-arrange-bar]")).toHaveAttribute("data-arrange-bar", "2");
  // Delete the two copies, and one undo brings both back.
  await page.locator("[data-arrange-bar] [data-arrange=\"delete\"]").click();
  d = await untilDraft(app.id, (x) => kids(x).length === 3);
  await undo(page);
  d = await untilDraft(app.id, (x) => kids(x).length === 5);
  expect(kids(d)).toHaveLength(5);
  await ctx.close();
});

test("V4: the multi-select toolbar in the shell's light, dark and reduce-transparency looks", async ({ browser }) => {
  const a = stat("One", { x: 0, y: 4, w: 3, h: 12 });
  const b = stat("Two", { x: 4, y: 4, w: 3, h: 12 });
  const app = await newApp(`ml-v4-${RUN}`, [a, b]);
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await open(page, app.slug);
    await node(page, a.id).click();
    await node(page, b.id).click({ modifiers: ["Shift"] });
    await expect(page.locator("[data-arrange-bar]")).toBeVisible();
    await page.screenshot({ path: shot(`v4-multi-toolbar-${v.name}`) });
    await ctx.close();
  }
});

test("covered: a widget fully under another is tagged on its Layers row", async ({ browser }) => {
  const under = stat("Hidden under", { x: 1, y: 2, w: 2, h: 6 });
  const over = stat("Big one", { x: 0, y: 0, w: 6, h: 20 });
  const free = stat("Free", { x: 6, y: 0, w: 3, h: 10 });
  const app = await newApp(`ml-cover-${RUN}`, [under, over, free]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, app.slug);
  await page.locator('[data-left-tab="layers"]').click();
  await expect(page.locator(`[data-layer="${under.id}"] [data-covered-tag]`)).toHaveText("covered");
  await expect(page.locator(`[data-layer="${over.id}"] [data-covered-tag]`)).toHaveCount(0);
  await expect(page.locator(`[data-layer="${free.id}"] [data-covered-tag]`)).toHaveCount(0);
  await page.locator("[data-builder-left]").screenshot({ path: shot("layers-covered") });
  // Moving the big one away clears the tag.
  await ops(app.id, [{ op: "node.move", nodeId: over.id, parentId: app.root, index: 1, slot: { x: 0, y: 30, w: 6, h: 20 } }]);
  await page.reload();
  await page.locator('[data-left-tab="layers"]').click();
  await expect(page.locator(`[data-layer="${under.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-layer="${under.id}"] [data-covered-tag]`)).toHaveCount(0);
  await ctx.close();
});

test("into containers: Insert into a selected empty Repeat, drag from Insert into a selected card, Layers drag into a Repeat", async ({ browser }) => {
  const rep: Node = { id: cid(), type: "repeat", name: "Each machine", props: {}, children: [], slot: { x: 0, y: 0, w: 6, h: 16 } };
  const card: Node = { id: cid(), type: "card", name: "Box", props: { title: "Box" }, children: [], slot: { x: 6, y: 0, w: 6, h: 20 } };
  const rep2: Node = { id: cid(), type: "repeat", name: "Each disk", props: {}, children: [], slot: { x: 0, y: 24, w: 6, h: 16 } };
  const lone = stat("Lone", { x: 6, y: 24, w: 3, h: 12 });
  const app = await newApp(`ml-into-${RUN}`, [rep, card, rep2, lone]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 }, recordVideo: ev("media-layout", "video-into-containers") });
  const page = await ctx.newPage();
  await open(page, app.slug);
  // Insert while an empty Repeat is selected: the widget becomes its child.
  await node(page, rep.id).click();
  await expect(page.locator(`[data-selected-outline="${rep.id}"]`)).toBeVisible();
  await insert(page, "text");
  let d = await untilDraft(app.id, (x) => (find(x, rep.id)?.children ?? []).length === 1);
  expect(find(d, rep.id)!.children!.map((k) => k.type)).toEqual(["text"]);
  // Drag Insert > Stat onto the selected card: it goes in (the card lights up while over it).
  await node(page, card.id).click();
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="stat"]').first().scrollIntoViewIfNeeded();
  const item = (await page.locator('[data-insert-item="stat"]').first().boundingBox())!;
  const cb = (await node(page, card.id).boundingBox())!;
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) await page.mouse.move(item.x + (cb.x + cb.width / 2 - item.x) * (i / 15), item.y + (cb.y + cb.height / 2 - item.y) * (i / 15));
  await expect(page.locator(`[data-drop-into="${card.id}"]`)).toBeVisible();
  await page.screenshot({ path: shot("drop-into-card") });
  await page.mouse.up();
  await skipPicker(page);
  d = await untilDraft(app.id, (x) => (find(x, card.id)?.children ?? []).length === 1);
  expect(find(d, card.id)!.children!.map((k) => k.type)).toEqual(["stat"]);
  // Layers: drag the lone stat onto the right half of the second Repeat's row.
  await page.locator('[data-left-tab="layers"]').click();
  const target = page.locator(`[data-layer="${rep2.id}"]`);
  const tb = (await target.boundingBox())!;
  await page.locator(`[data-layer="${lone.id}"]`).dragTo(target, { targetPosition: { x: tb.width - 12, y: tb.height / 2 } });
  d = await untilDraft(app.id, (x) => (find(x, rep2.id)?.children ?? []).length === 1);
  expect(find(d, rep2.id)!.children!.map((k) => k.id)).toEqual([lone.id]);
  await page.screenshot({ path: shot("into-containers-done") });
  await ctx.close();
});

test("criterion 10: a dropped 16:9 WebM gets a 16:9 box that shows the whole video", async ({ browser }) => {
  const anchor = stat("Anchor", { x: 0, y: 0, w: 12, h: 8 });
  const app = await newApp(`ml-drop-${RUN}`, [anchor]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page, app.slug);
  const g = await gridGeom(page);
  await dropFile(page, path.join(MEDIA, "wide.webm"), "video/webm", g.left + 2 * g.step + 10, g.top + 20 * g.row);
  const d = await untilDraft(app.id, (x) => kids(x).some((k) => k.type === "video"), 10_000);
  const vid = kids(d).find((k) => k.type === "video")!;
  expect(vid.props.fit).toBe("contain");
  expect(vid.props.shape).toBe("original");
  const frame = page.locator(`[data-canvas-root] [data-node="${vid.id}"] [data-media-frame]`);
  await expect(frame).toBeVisible();
  await page.waitForTimeout(300);
  const fb = (await frame.boundingBox())!;
  log("dropped webm", { slot: vid.slot, height: vid.props.height, frame: fb });
  expect(Math.abs(fb.height - (fb.width * 9) / 16)).toBeLessThanOrEqual(8);
  expect(await page.locator(`[data-canvas-root] [data-node="${vid.id}"] video`).evaluate((e) => getComputedStyle(e).objectFit)).toBe("contain");
  await page.screenshot({ path: shot("dropped-webm-16-9") });
  await ctx.close();
});

test("criterion 18: a viewer gets no builder or panel, and Enlarge and page links work for them", async ({ browser }) => {
  await addUser(PEOPLE.viewer);
  const c = await owner();
  const up = await c.post("/api/settings/uploads", { multipart: { file: { name: "quad.png", mimeType: "image/png", buffer: readFileSync(path.join(MEDIA, "quad.png")) }, accept: "image" } });
  expect(up.ok(), await up.text()).toBe(true);
  const src = (await up.json()).path as string;
  const big: Node = { id: cid(), type: "image", name: "Plan", props: { src, alt: "Plan", fit: "cover", height: 120, link: { kind: "enlarge" } }, slot: { x: 0, y: 0, w: 3, h: 20 } };
  const go: Node = { id: cid(), type: "image", name: "Go", props: { src, alt: "Go to Rack", fit: "cover", height: 120, link: { kind: "page", pageId: "p_mlrackpage" } }, slot: { x: 3, y: 0, w: 3, h: 20 } };
  const app = await newApp(`ml-viewer-${RUN}`, [big, go]);
  const acc = await c.put(`/api/apps/${app.id}/access`, { data: { view: "everyone", edit: { userIds: [] }, guests: false } });
  expect(acc.ok(), await acc.text()).toBe(true);
  await ops(app.id, [{ op: "page.add", page: { id: "p_mlrackpage", slug: "rack", title: "Rack", inNav: true, root: { id: cid(), type: "grid", props: {}, children: [{ id: cid(), type: "heading", props: { text: "Rack page" }, slot: { x: 0, y: 0, w: 6, h: 8 } }] } } }]);
  const review = await (await c.get(`/api/apps/${app.id}/review`)).json();
  const pub = await c.post(`/api/apps/${app.id}/publish`, { data: { expectRev: review.rev, note: "viewer" } });
  expect(pub.ok(), await pub.text()).toBe(true);
  const ctx = await contextFor(browser, PEOPLE.viewer, { variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto(`/a/${app.slug}`);
  const frame = page.locator(`[data-node="${big.id}"] [data-media-frame]`);
  await expect(frame).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-picture-panel], [data-inspector], [data-arrange-bar]")).toHaveCount(0);
  await frame.click();
  await expect(page.locator("[data-media-lightbox]")).toBeVisible();
  await page.screenshot({ path: shot("viewer-enlarge") });
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-media-lightbox]")).toHaveCount(0);
  await page.locator(`[data-node="${go.id}"] [data-media-frame]`).click();
  await expect(page.getByText("Rack page")).toBeVisible({ timeout: 10_000 });
  await page.goto(`/build/${app.slug}`);
  await expect(page.locator("[data-picture-panel]")).toHaveCount(0);
  await expect(page.locator("[data-builder-bar]")).toHaveCount(0);
  await ctx.close();
});
