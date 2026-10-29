// app-builder e2e: exact widget boxes (operator, 2026-10-19). Every insertable type spawns at a size its
// content fits, the selected outline, the drawn component and the resize ghost are one box, resizing
// (bigger and smaller) lands exactly, adding more widgets never moves earlier ones, and an Insert click
// adds to the page even while a container is selected.
// Self-contained: its own apps (slug wb-*), desktop project.
import { expect, test, type Page } from "@playwright/test";
import { api, contextFor, ev, log, OWNER, SHELL_VARIANTS, skipPicker } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; slot?: Slot; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; root: Node }[] } };
type Box = { x: number; y: number; w: number; h: number };

const RUN = Date.now().toString(36).slice(-4);
const TYPES = ["text", "status", "grid", "stack", "card", "tabs", "section", "repeat", "stat", "chart", "table", "list", "gauge", "progress", "heading", "image", "icon", "link", "divider", "spacer", "clock", "button", "toggle", "slider", "select"];

async function newApp(slug: string): Promise<string> {
  const r = await (await api(OWNER)).post("/api/apps", { data: { name: `Boxes ${slug}`, slug } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app.id;
}
async function draft(appId: string): Promise<Draft> {
  return (await (await api(OWNER)).get(`/api/apps/${appId}/draft`)).json();
}
async function untilDraft(appId: string, ok: (d: Draft) => boolean, ms = 4000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(appId);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 80));
  }
}
/** The drawn component, its outline (when selected), the cell's gap, and whether the content overflows. */
async function boxes(page: Page, id: string) {
  return page.evaluate((nid) => {
    const hiddenHeight = (root: Element) => { let over = Math.max(0, root.scrollHeight - root.clientHeight); const counted: Element[] = []; for (const e of root.querySelectorAll("*")) { if (counted.some((c) => c.contains(e))) continue; const y = getComputedStyle(e).overflowY; if ((y === "auto" || y === "scroll") && e.scrollHeight - e.clientHeight > 1) { over += e.scrollHeight - e.clientHeight; counted.push(e); } } return over; };
    const node = document.querySelector<HTMLElement>(`[data-canvas-root] [data-node="${CSS.escape(nid)}"]`)!;
    const cell = node.parentElement!;
    const root = node.querySelector<HTMLElement>(':scope > [data-slot="root"]');
    const outline = document.querySelector<HTMLElement>(`[data-selected-outline="${CSS.escape(nid)}"]`);
    // Relative to the canvas, so scrolling to a new widget does not count as a move.
    const o = document.querySelector("[data-canvas-root]")!.getBoundingClientRect();
    const b = (e: Element): Box => { const r = e.getBoundingClientRect(); return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height }; };
    return { node: b(node), outline: outline ? b(outline) : null, pad: parseFloat(getComputedStyle(cell).paddingBottom) || 0, overflow: root ? hiddenHeight(root) : 0 };
  }, id);
}
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol;
function sameBox(a: Box, b: Box, tol = 1.5) {
  expect(near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.w, b.w, tol) && near(a.h, b.h, tol), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(true);
}

test("every widget type spawns at a size its content fits, drawn exactly as its slot, with the outline on it; earlier widgets never move", async ({ browser }) => {
  for (const v of SHELL_VARIANTS.slice(0, 2)) {
    const slug = `wb-all-${v.name}-${RUN}`;
    const appId = await newApp(slug);
    const ctx = await contextFor(browser, OWNER, { variant: v, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`/build/${slug}`);
    await expect(page.locator("[data-builder-bar]")).toBeVisible();
    let first: { id: string; box: Box } | null = null;
    const rows: unknown[] = [];
    for (const type of TYPES) {
      const item = page.locator(`[data-insert-item="${type}"]`).first();
      if (!(await item.count())) continue;
      const before = (await draft(appId)).doc.pages[0]!.root.children?.length ?? 0;
      // Wave 2.7 (media layout 3.2): Insert with an empty Repeat selected fills the Repeat, so step out of it.
      if (type === "stat") await page.keyboard.press("Escape");
      await item.click();
      await skipPicker(page); // Wave 2.6: a new data widget opens the data picker
      const d = await untilDraft(appId, (x) => (x.doc.pages[0]!.root.children?.length ?? 0) > before);
      const kids = d.doc.pages[0]!.root.children!;
      expect(kids.length, `${type} lands on the page, not inside the selected component`).toBe(before + 1);
      const n = kids[kids.length - 1]!;
      expect(n.type).toBe(type);
      await expect(page.locator(`[data-selected-outline="${n.id}"]`)).toBeVisible();
      await page.waitForTimeout(700); // the settle animation
      const m = await boxes(page, n.id);
      rows.push({ type, slot: n.slot, ...m });
      expect(near(m.node.h, n.slot!.h * 8 - m.pad), `${type}: drawn ${m.node.h}px, slot ${n.slot!.h * 8}px less ${m.pad}px gap`).toBe(true);
      expect(m.overflow, `${type}: content fits its spawn size`).toBeLessThanOrEqual(1);
      sameBox(m.outline!, m.node, 2.5);
      if (!first) first = { id: n.id, box: m.node };
      else sameBox((await boxes(page, first.id)).node, first.box);
    }
    log(`spawn boxes ${v.name}`, rows);
    await page.screenshot({ path: ev("widget-boxes", `all-${v.name}.png`), fullPage: true });
    await ctx.close();
  }
});

test("resize bigger and smaller: the ghost while dragging is the box that lands, content scrolls inside, neighbours stay put", async ({ browser }) => {
  const slug = `wb-resize-${RUN}`;
  const appId = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 }, recordVideo: ev("widget-boxes", "video") });
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  for (const type of ["card", "stat", "chart", "table"]) {
    const before = (await draft(appId)).doc.pages[0]!.root.children?.length ?? 0;
    await page.locator(`[data-insert-item="${type}"]`).first().click();
    await skipPicker(page);
    await untilDraft(appId, (x) => (x.doc.pages[0]!.root.children?.length ?? 0) > before);
  }
  const kids = (await draft(appId)).doc.pages[0]!.root.children!;
  const step = await page.locator(`[data-canvas-root] [data-node="${(await draft(appId)).doc.pages[0]!.root.id}"]`).evaluate((el) => {
    const g = el.querySelector(".atr-grid")!;
    const cs = getComputedStyle(g);
    const w = g.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    return { col: (w - 11 * gap) / 12 + gap, row: 8 };
  });

  for (const n of kids) {
    await page.locator('[data-left-tab="layers"]').click();
    await page.locator(`[data-layer="${n.id}"]`).click();
    await expect(page.locator(`[data-selected-outline="${n.id}"]`)).toBeVisible();
    for (const [dc, dr] of [[2, 6], [-1, -12]] as const) {
      const below = kids.filter((k) => k.slot!.y > n.slot!.y);
      const beforeBelow = await Promise.all(below.map(async (k) => (await boxes(page, k.id)).node));
      const start = (await draft(appId)).doc.pages[0]!.root.children!.find((k) => k.id === n.id)!.slot!;
      await page.locator('[data-resize-handle="se"]').scrollIntoViewIfNeeded();
      const h = (await page.locator('[data-resize-handle="se"]').boundingBox())!;
      const x = h.x + h.width / 2;
      const y = h.y + h.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dc * step.col * i) / 8, y + (dr * step.row * i) / 8);
      const g = (await page.locator("[data-drop-ghost]").boundingBox())!;
      const o = (await page.locator("[data-canvas-root]").boundingBox())!;
      const ghost = { ...g, x: g.x - o.x, y: g.y - o.y };
      await page.mouse.up();
      const d = await untilDraft(appId, (z) => z.doc.pages[0]!.root.children!.find((k) => k.id === n.id)!.slot!.h !== start.h);
      const slot = d.doc.pages[0]!.root.children!.find((k) => k.id === n.id)!.slot!;
      // Wave 2.7: Insert places widgets beside each other, so a widening stops at the grid's right edge.
      expect(slot).toEqual({ x: start.x, y: start.y, w: Math.max(1, Math.min(12 - start.x, start.w + dc)), h: Math.max(1, start.h + dr) });
      await page.waitForTimeout(400);
      const m = await boxes(page, n.id);
      log(`resize ${n.type} ${dc},${dr}`, { start, slot, ghost, node: m.node, outline: m.outline, overflow: m.overflow });
      sameBox({ x: ghost.x, y: ghost.y, w: ghost.width, h: ghost.height }, m.node, 2.5);
      sameBox(m.outline!, m.node, 2.5);
      expect(near(m.node.h, slot.h * 8 - m.pad)).toBe(true);
      // Neighbours further down never move: the rows are fixed, the box does not push them.
      const afterBelow = await Promise.all(below.map(async (k) => (await boxes(page, k.id)).node));
      afterBelow.forEach((b, i) => sameBox(b, beforeBelow[i]!));
    }
  }
  await page.screenshot({ path: ev("widget-boxes", "resized.png"), fullPage: true });
  await ctx.close();
});

test("an Insert click while a card is selected adds to the page, not into the card", async ({ browser }) => {
  const slug = `wb-nest-${RUN}`;
  const appId = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await page.locator('[data-insert-item="card"]').first().click();
  const card = (await untilDraft(appId, (x) => (x.doc.pages[0]!.root.children?.length ?? 0) > 0)).doc.pages[0]!.root.children![0]!;
  await expect(page.locator(`[data-selected-outline="${card.id}"]`)).toBeVisible();
  await page.locator('[data-insert-item="stat"]').first().click();
  await skipPicker(page);
  const d = await untilDraft(appId, (x) => (x.doc.pages[0]!.root.children?.length ?? 0) > 1);
  expect(d.doc.pages[0]!.root.children!.map((k) => k.type)).toEqual(["card", "stat"]);
  expect(d.doc.pages[0]!.root.children![0]!.children ?? []).toHaveLength(0);
  await ctx.close();
});

test("every template's widgets fit their boxes at desktop and 390px: nothing scrolls inside on a fresh app", async ({ browser }) => {
  const c = await api(OWNER);
  const report: Record<string, unknown> = {};
  for (const template of ["homelab", "family-wall", "guest-room"]) {
    const slug = `wb-tpl-${template}-${RUN}`;
    const r = await c.post("/api/apps", { data: { name: `Tpl ${template}`, slug, template, mappings: {} } });
    if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
    for (const width of [1440, 390]) {
      const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width, height: 900 }, ...(width < 900 ? { mobile: true } : {}) });
      const page = await ctx.newPage();
      await page.goto(`/build/${slug}`);
      await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
      await page.waitForTimeout(800);
      const over = await page.evaluate(() => { const hiddenHeight = (root: Element) => { let over = Math.max(0, root.scrollHeight - root.clientHeight); const counted: Element[] = []; for (const e of root.querySelectorAll("*")) { if (counted.some((c) => c.contains(e))) continue; const y = getComputedStyle(e).overflowY; if ((y === "auto" || y === "scroll") && e.scrollHeight - e.clientHeight > 1) { over += e.scrollHeight - e.clientHeight; counted.push(e); } } return over; }; return [...document.querySelectorAll<HTMLElement>('[data-canvas-root] .atr-grid[data-fixed-rows] > .atr-cell > [data-node] > [data-slot="root"]')]
        .map((e) => ({ type: e.parentElement!.dataset.type, over: hiddenHeight(e) }))
        .filter((x) => x.over > 1); });
      report[`${template}-${width}`] = over;
      await page.screenshot({ path: ev("widget-boxes", `template-${template}-${width}.png`), fullPage: true });
      await ctx.close();
    }
  }
  log("template overflow", report);
  expect(report).toEqual(Object.fromEntries(Object.keys(report).map((k) => [k, []])));
});

/** An app laid out before exact boxes: widgets in slots smaller than their content, a text block below. */
async function oldLayoutApp(slug: string): Promise<{ appId: string; ids: { heading: string; stat: string; table: string; status: string; text: string } }> {
  const appId = await newApp(slug);
  const d = await draft(appId);
  const root = d.doc.pages[0]!.root.id;
  const ids = { heading: "c_fitheading", stat: "c_fitstataaa", table: "c_fittableaa", status: "c_fitstatusa", text: "c_fittextaaa" };
  const r = await (await api(OWNER)).post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: [
    { op: "node.add", parentId: root, node: { id: ids.heading, type: "heading", props: { text: "Old layout", level: 1 }, slot: { x: 0, y: 0, w: 12, h: 6 } } },
    { op: "node.add", parentId: root, node: { id: ids.stat, type: "stat", props: {}, slot: { x: 0, y: 6, w: 3, h: 16 } } },
    { op: "node.add", parentId: root, node: { id: ids.status, type: "status", props: {}, slot: { x: 3, y: 6, w: 3, h: 16 } } },
    { op: "node.add", parentId: root, node: { id: ids.table, type: "table", props: {}, slot: { x: 6, y: 6, w: 6, h: 16 } } },
    { op: "node.add", parentId: root, node: { id: ids.text, type: "text", props: { text: "Below everything." }, slot: { x: 0, y: 22, w: 12, h: 10 } } },
  ] } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
  return { appId, ids };
}
const slotOf = (d: Draft, id: string) => d.doc.pages[0]!.root.children!.find((k) => k.id === id)!.slot!;
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => { const hiddenHeight = (root: Element) => { let over = Math.max(0, root.scrollHeight - root.clientHeight); const counted: Element[] = []; for (const e of root.querySelectorAll("*")) { if (counted.some((c) => c.contains(e))) continue; const y = getComputedStyle(e).overflowY; if ((y === "auto" || y === "scroll") && e.scrollHeight - e.clientHeight > 1) { over += e.scrollHeight - e.clientHeight; counted.push(e); } } return over; }; return [...document.querySelectorAll<HTMLElement>('[data-canvas-root] .atr-grid[data-fixed-rows] > .atr-cell > [data-node] > [data-slot="root"]')]
    .filter((e) => hiddenHeight(e) > 1).map((e) => e.parentElement!.dataset.node!); });
}
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll<HTMLElement>("[data-canvas-root] .atr-grid > .atr-cell > [data-node]")].map((e) => ({ id: e.dataset.node!, r: e.getBoundingClientRect() }));
    const out: string[] = [];
    for (const a of els) for (const b of els) if (a.id < b.id && a.r.left < b.r.right - 1 && b.r.left < a.r.right - 1 && a.r.top < b.r.bottom - 1 && b.r.top < a.r.bottom - 1) out.push(`${a.id}/${b.id}`);
    return out;
  });
}

test("Fit on the drag bar: shows only while content scrolls, grows that box, pushes the rows below, undo restores", async ({ browser }) => {
  const slug = `wb-fit1-${RUN}`;
  const { appId, ids } = await oldLayoutApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  // Round 2 item 1: opening the page grows too-small boxes as one undo step. Undo it, so the stat is back
  // in its drawn box (too small for its content) and the Fit button has something to fit.
  await untilDraft(appId, (x) => slotOf(x, ids.stat).h > 16, 8000);
  await page.locator("[data-builder-canvas]").focus();
  await page.keyboard.press("Control+z");
  await untilDraft(appId, (x) => slotOf(x, ids.stat).h === 16);
  await page.waitForTimeout(400);
  expect(await overflowing(page)).toContain(ids.stat);
  // A widget that fits has no Fit button.
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${ids.text}"]`).click();
  await expect(page.locator("[data-remove-selected]")).toBeVisible();
  await expect(page.locator("[data-fit-selected]")).toHaveCount(0);
  // The stat overflows: Fit grows it; the text below moves down by the same rows.
  await page.locator(`[data-layer="${ids.stat}"]`).click();
  await expect(page.locator("[data-fit-selected]")).toBeVisible();
  await page.screenshot({ path: ev("widget-boxes", "fit-button.png") });
  const before = await draft(appId);
  await page.locator("[data-fit-selected]").click();
  const after = await untilDraft(appId, (x) => slotOf(x, ids.stat).h > slotOf(before, ids.stat).h);
  const grown = slotOf(after, ids.stat).h - slotOf(before, ids.stat).h;
  expect(grown).toBeGreaterThan(0);
  expect(slotOf(after, ids.text).y).toBe(slotOf(before, ids.text).y + grown);
  await page.waitForTimeout(400);
  expect(await overflowing(page)).not.toContain(ids.stat);
  await expect(page.locator("[data-fit-selected]")).toHaveCount(0);
  expect(await overlaps(page)).toEqual([]);
  // One undo puts the stat and the text back.
  await page.locator("[data-builder-canvas]").focus();
  await page.keyboard.press("Control+z");
  const undone = await untilDraft(appId, (x) => slotOf(x, ids.stat).h === slotOf(before, ids.stat).h);
  expect(slotOf(undone, ids.stat)).toEqual(slotOf(before, ids.stat));
  expect(slotOf(undone, ids.text)).toEqual(slotOf(before, ids.text));
  await ctx.close();
});

test("Fit every component (Pages menu, desktop and phone): nothing scrolls, nothing overlaps, a second run says it already fits", async ({ browser }) => {
  for (const width of [1440, 390]) {
    const slug = `wb-fitall-${width}-${RUN}`;
    const { appId } = await oldLayoutApp(slug);
    const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width, height: 900 }, ...(width < 900 ? { mobile: true } : {}) });
    const page = await ctx.newPage();
    await page.goto(`/build/${slug}`);
    await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
    await page.waitForTimeout(600);
    const was = await overflowing(page);
    log(`fit all ${width} before`, was);
    const rev = (await draft(appId)).rev;
    await page.locator("[data-page-menu]").click();
    await page.locator("[data-page-fit]").click();
    if (was.length) {
      await untilDraft(appId, (x) => x.rev > rev);
      await page.waitForTimeout(500);
      await expect(page.getByText(/^Fitted \d+ components?$/)).toBeVisible();
    }
    expect(await overflowing(page)).toEqual([]);
    expect(await overlaps(page)).toEqual([]);
    await page.screenshot({ path: ev("widget-boxes", `fit-all-${width}.png`), fullPage: true });
    await page.locator("[data-page-menu]").click();
    await page.locator("[data-page-fit]").click();
    await expect(page.getByText("Everything already fits").first()).toBeVisible();
    await ctx.close();
  }
});
