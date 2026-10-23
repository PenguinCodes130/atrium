// app-builder e2e, part B: the builder (criteria 7 to 14, 49; V4, V5, V6 drag and edit mode).
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { addUser, agentAddNode, api, contextFor, ev, log, OWNER, PEOPLE, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ mode: "serial" });
// Each test makes its own contexts and phone widths (as in round 1, run on the desktop project only); a
// second pass on the mobile project would meet the first pass's apps in the same slot database.
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

let appId = "";
const SLUG = "board";

async function draft(): Promise<{ rev: number; doc: { pages: { id: string; slug: string; root: { id: string; children?: { id: string; type: string; slot?: { x: number; y: number; w: number; h: number }; responsive?: unknown }[] } }[] } }> {
  const c = await api(OWNER);
  return (await c.get(`/api/apps/${appId}/draft`)).json();
}

async function waitRev(rev: number, ms = 3000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await draft()).rev >= rev) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`rev ${rev} not reached`);
}

async function open(page: Page) {
  await page.goto(`/build/${SLUG}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return; // the tests skip on other projects (see the skip above)
  for (const p of Object.values(PEOPLE)) await addUser(p);
  const c = await api(OWNER);
  const existing = ((await (await c.get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[]).find((t) => t.app.slug === SLUG);
  if (existing) appId = existing.app.id;
  else appId = (await (await c.post("/api/apps", { data: { name: "Board", slug: SLUG } })).json()).app.id;
  const d = await draft();
  const root = d.doc.pages[0]!.root.id;
  await c.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: [
    { op: "node.add", parentId: root, node: { id: "c_headingaaa", type: "heading", name: "Title", props: { text: "Board", level: 1 }, slot: { x: 0, y: 0, w: 12, h: 8 } } },
    { op: "node.add", parentId: root, node: { id: "c_textnodeaa", type: "text", name: "Intro", props: { text: "Hello from the board." }, slot: { x: 0, y: 8, w: 6, h: 6 } } },
  ] } });
});

test("layout: 48px bar, 264px left with Insert and Layers, the canvas, 320px inspector in group order (criterion 7; V4)", async ({ browser }) => {
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await open(page);
    expect(Math.round((await page.locator("[data-builder-bar]").boundingBox())!.height)).toBe(48);
    expect(Math.round((await page.locator("[data-builder-left]").boundingBox())!.width)).toBe(264);
    expect(Math.round((await page.locator("[data-builder-inspector]").boundingBox())!.width)).toBe(320);
    await expect(page.locator("[data-left-tab]")).toHaveText(["Insert", "Layers"]);
    await page.screenshot({ path: ev("screens", `builder-insert-${v.name}.png`) });
    await page.locator('[data-left-tab="layers"]').click();
    await page.locator('[data-layer="c_textnodeaa"]').click();
    await expect(page.locator('[data-selected-outline="c_textnodeaa"]')).toBeVisible();
    const order = await page.locator("[data-inspector-groups]").evaluate((el) => {
      const groups = [...el.querySelectorAll<HTMLElement>("[data-inspector-group]")];
      return groups.map((g) => ({ id: g.dataset.inspectorGroup!, order: Number(getComputedStyle(g).order), y: g.getBoundingClientRect().top, open: g.hasAttribute("data-open") || (g as HTMLDetailsElement).open === true })).sort((a, b) => a.y - b.y);
    });
    log(`inspector order ${v.name}`, order);
    const named = order.map((g) => g.id).filter((id) => ["content", "data", "control", "layout", "style", "advanced"].includes(id));
    expect(named).toEqual(["content", "data", "layout", "style", "advanced"].filter((x) => named.includes(x)));
    expect(order.find((g) => g.id === "style")?.open ?? false).toBe(false);
    expect(order.find((g) => g.id === "advanced")?.open ?? false).toBe(false);
    await page.screenshot({ path: ev("screens", `builder-${v.name}.png`) });
    await ctx.close();
  }
});

test("drag a stat from Insert into the grid: it lands in the cell under the pointer and rev goes up within 1s (criterion 8; V6)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], recordVideo: ev("video", "drag") });
  const page = await ctx.newPage();
  await open(page);
  const before = await draft();
  const item = page.locator('[data-insert-item="stat"]').first();
  const ib = (await item.boundingBox())!;
  const root = before.doc.pages[0]!.root.id;
  const grid = page.locator(`[data-canvas-root] [data-node="${root}"]`);
  const gb = (await grid.boundingBox())!;
  const target = { x: gb.x + gb.width * 0.62, y: gb.y + 200 };
  const expected = await grid.evaluate((el, t) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    const width = r.width - px(cs.paddingLeft) - px(cs.paddingRight);
    const colGap = px(cs.columnGap);
    const rowGap = px(cs.rowGap);
    const rowPx = px(cs.gridAutoRows) || 8;
    const colW = (width - 11 * colGap) / 12;
    return { x: Math.min(12 - 3, Math.floor((t.x - r.left - px(cs.paddingLeft)) / (colW + colGap))), y: Math.floor((t.y - r.top - px(cs.paddingTop)) / (rowPx + rowGap)) };
  }, target);
  // Round 3 (w2-r2 item 16): a loose drop below the content snaps to the next row at the left; Alt is the
  // deliberate placement that keeps the cell under the pointer, which is what this criterion measures.
  await page.keyboard.down("Alt");
  await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(ib.x + (target.x - ib.x) * (i / 12), ib.y + (target.y - ib.y) * (i / 12));
  await expect(page.locator("[data-drop-ghost]")).toBeVisible();
  await expect(page.locator("[data-grid-cells]")).toBeVisible();
  await page.waitForTimeout(250);
  const t0 = Date.now();
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const elapsed = await waitRev(before.rev + 1, 1000).then((ms) => ms + (Date.now() - t0 - ms));
  const after = await draft();
  expect(after.rev).toBe(before.rev + 1);
  const added = after.doc.pages[0]!.root.children!.find((n) => n.type === "stat")!;
  expect(added.slot).toMatchObject({ x: expected.x, y: expected.y });
  log("drag drop", { expected, slot: added.slot, elapsedMs: Date.now() - t0, revBefore: before.rev, revAfter: after.rev, elapsed });
  expect(Date.now() - t0).toBeLessThan(1000 + 400);
  await page.waitForTimeout(500);
  await ctx.close();
});

test("keyboard: arrows move, Shift resizes, undo and redo, and the live region announces (criteria 9, 11)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await open(page);
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_textnodeaa"]').click();
  await page.locator("[data-builder-canvas]").focus().catch(() => {});
  await page.mouse.click(5, 300).catch(() => {});
  await page.locator('[data-layer="c_textnodeaa"]').click();
  await page.locator("body").focus();
  const before = (await draft()).doc.pages[0]!.root.children!.find((n) => n.id === "c_textnodeaa")!.slot!;
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-builder-announce]")).toHaveText(/column 2, row 9, 6 wide, 6 tall/);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator("[data-builder-announce]")).toHaveText(/6 wide, 7 tall/);
  const d0 = await draft();
  await page.waitForTimeout(700);
  const d1 = await draft();
  expect(d1.rev).toBe(d0.rev + 1); // two edits inside the debounce went as one batch
  expect(d1.doc.pages[0]!.root.children!.find((n) => n.id === "c_textnodeaa")!.slot).toEqual({ ...before, x: before.x + 1, h: before.h + 1 });
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(700);
  expect((await draft()).doc.pages[0]!.root.children!.find((n) => n.id === "c_textnodeaa")!.slot).toEqual(before);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(700);
  expect((await draft()).doc.pages[0]!.root.children!.find((n) => n.id === "c_textnodeaa")!.slot).toEqual({ ...before, x: before.x + 1 });
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(700);
  // Esc selects the parent, Enter selects into it.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-builder-announce]")).toHaveText(/Selected grid/);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-builder-announce]")).toHaveText(/Selected heading Title/);
  await ctx.close();
});

test("mobile edits change only the phone layout: the desktop render is pixel-identical (criterion 12; V5)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await open(page);
  await page.mouse.move(2, 2);
  const shot = async () => createHash("sha256").update(await page.locator("[data-canvas-root] [data-atrium-canvas-frame]").screenshot({ animations: "disabled" })).digest("hex");
  await page.waitForTimeout(400);
  const before = await shot();
  await page.locator('[data-device="mobile"]').click();
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_textnodeaa"]').click();
  await page.locator("body").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(800);
  await page.screenshot({ path: ev("screens", "builder-mobile-edit.png") });
  const node = (await draft()).doc.pages[0]!.root.children!.find((n) => n.id === "c_textnodeaa")!;
  expect(node.responsive).toBeTruthy();
  await page.locator('[data-device="desktop"]').click();
  await page.keyboard.press("Escape");
  await page.locator('[data-left-tab="insert"]').click();
  await page.mouse.move(2, 2);
  await page.reload();
  await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  const after = await shot();
  log("mobile edit desktop hash", { before, after });
  expect(after).toBe(before);
  await ctx.close();
});

// Round 2 (gauntlet w2-r1 item 11, operator approved): under 900px the builder offers a reduced edit mode
// (one view at a time: Canvas, Layers, Edit; no drag, no grid, no keyboard moves) instead of read-only.
// The full flow is in e-gauntlet-r2 item 11; this keeps criterion 13's Preview check.
test("under 900px the builder offers the reduced edit mode and Preview still works (criterion 13 as amended by item 11; V5)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: SHELL_VARIANTS[0] });
  const page = await ctx.newPage();
  await page.goto(`/build/${SLUG}`);
  await expect(page.locator("[data-narrow-note]")).toBeVisible();
  await expect(page.locator("[data-narrow-tab]")).toHaveText(["Canvas", "Layers", "Edit"]);
  await expect(page.locator("[data-builder-left], [data-builder-inspector]")).toHaveCount(0); // one view at a time
  await expect(page.locator("[data-insert-panel], [data-builder-bar] [data-device], [data-edit-toggle]")).toHaveCount(0); // no drag-and-drop editing
  await expect(page.locator("[data-preview]")).toBeVisible();
  await page.screenshot({ path: ev("screens", "mobile-builder-readonly.png"), fullPage: true });
  const href = await page.locator("[data-preview]").getAttribute("href");
  expect(href).toContain("?draft=1");
  await page.goto(href!);
  await expect(page.locator("[data-app-page]")).toBeVisible();
  await ctx.close();
});

test("an agent-made node carries the agent tag in Layers until the next publish (criterion 14)", async ({ browser }) => {
  agentAddNode(appId, { id: "c_agentmadea", type: "text", name: "Agent note", props: { text: "Added by Claude" }, slot: { x: 6, y: 8, w: 6, h: 6 } });
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await open(page);
  await page.locator('[data-left-tab="layers"]').click();
  await expect(page.locator('[data-layer="c_agentmadea"] [data-agent-tag]')).toHaveText("agent");
  await expect(page.locator('[data-layer="c_textnodeaa"] [data-agent-tag]')).toHaveCount(0);
  await page.screenshot({ path: ev("screens", "builder-agent-tag.png") });
  const c = await api(OWNER);
  const review = await (await c.get(`/api/apps/${appId}/review`)).json();
  expect(review.authors).toContainEqual(expect.objectContaining({ kind: "agent", name: "Claude" }));
  const pub = await c.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note: "with the agent note" } });
  expect(pub.ok()).toBe(true);
  await page.reload();
  await page.locator('[data-left-tab="layers"]').click();
  await expect(page.locator('[data-layer="c_agentmadea"]')).toBeVisible();
  await expect(page.locator("[data-agent-tag]")).toHaveCount(0);
  await ctx.close();
});

test("switching into edit mode insets the canvas 24px; reduced motion switches instantly (criterion 49; V6, V8)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { recordVideo: ev("video", "edit-mode") });
  const page = await ctx.newPage();
  await open(page);
  await page.locator("[data-edit-toggle]").click();
  await expect(page.locator("[data-canvas-inset]")).toHaveAttribute("data-canvas-inset", "0");
  await page.waitForTimeout(600);
  await page.locator("[data-edit-toggle]").click();
  const samples: number[] = [];
  for (let i = 0; i < 8; i++) {
    samples.push(await page.locator("[data-canvas-inset]").evaluate((el) => parseFloat(getComputedStyle(el).paddingTop)));
    await page.waitForTimeout(30);
  }
  log("edit mode inset samples", samples);
  expect(samples.at(-1)).toBeCloseTo(24, 0);
  await ctx.close();
  const r = await contextFor(browser, OWNER, { reducedMotion: "reduce" });
  const rp = await r.newPage();
  await open(rp);
  await rp.locator("[data-edit-toggle]").click();
  await rp.locator("[data-edit-toggle]").click();
  const inset = await rp.locator("[data-canvas-inset]").evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
  expect(inset).toBeCloseTo(24, 0);
  await rp.screenshot({ path: ev("screens", "reduced-motion-builder.png") });
  await r.close();
});
