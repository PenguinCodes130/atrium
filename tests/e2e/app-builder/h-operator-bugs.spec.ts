// app-builder e2e: Tristan's builder bugs after Wave 2 closed (stages/03-build/output/wave-2-operator-bugs.md).
// 1 remove from the drag bar, 2 resize from edges and corners, 3 add a page, 4 the Pages menu opens on top.
// Self-contained: its own app (slug ob-*), desktop project, phone widths set per test.
import { expect, test, type Page } from "@playwright/test";
import { api, contextFor, ev, log, OWNER, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; slot?: Slot; responsive?: { mobile?: { slot?: Slot } }; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; slug: string; title: string; root: Node }[] } };

const RUN = Date.now().toString(36).slice(-4);
const SLUG = `ob-${RUN}`;
let appId = "";

async function draft(): Promise<Draft> {
  return (await (await api(OWNER)).get(`/api/apps/${appId}/draft`)).json();
}
async function untilDraft(ok: (d: Draft) => boolean, ms = 4000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft();
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 80));
  }
}
const kid = (d: Draft, id: string) => d.doc.pages[0]!.root.children?.find((n) => n.id === id);

async function open(page: Page) {
  await page.goto(`/build/${SLUG}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
}
async function select(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${id}"]`).click();
  await expect(page.locator(`[data-selected-outline="${id}"]`)).toBeVisible();
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  const c = await api(OWNER);
  const r = await c.post("/api/apps", { data: { name: "Operator bugs", slug: SLUG } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  appId = (await r.json()).app.id;
  const d = await draft();
  const root = d.doc.pages[0]!.root.id;
  const ok = await c.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: [
    { op: "node.add", parentId: root, node: { id: "c_obheadingx", type: "heading", name: "Title", props: { text: "Bugs", level: 1 }, slot: { x: 0, y: 0, w: 12, h: 8 } } },
    { op: "node.add", parentId: root, node: { id: "c_obtextnode", type: "text", name: "Intro", props: { text: "Resize me." }, slot: { x: 2, y: 8, w: 4, h: 12 } } },
    { op: "node.add", parentId: root, node: { id: "c_obremoveme", type: "text", name: "Doomed", props: { text: "Remove me." }, slot: { x: 0, y: 20, w: 6, h: 6 } } },
  ] } });
  if (!ok.ok()) throw new Error(`ops failed: ${await ok.text()}`);
});

test("bugs 3 and 4: the Pages menu opens whole and on top of the canvas, in light and dark, and Add a page works", async ({ browser }) => {
  for (const v of SHELL_VARIANTS.slice(0, 2)) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await open(page);
    await page.locator("[data-page-menu]").click();
    const menu = page.locator("[data-page-menu-content]");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    log(`page menu ${v.name}`, box);
    expect(box.height).toBeGreaterThan(200); // eight rows, not a sliver
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    // Every item is the topmost element at its own centre (nothing from the canvas paints over it).
    const covered = await menu.evaluate((el) => [...el.querySelectorAll<HTMLElement>("[role=menuitem]")].filter((it) => {
      const r = it.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !top || !it.contains(top);
    }).map((it) => it.textContent));
    expect(covered).toEqual([]);
    await page.screenshot({ path: ev("operator-bugs", `page-menu-${v.name}.png`) });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await ctx.close();
  }

  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0] });
  const page = await ctx.newPage();
  await open(page);
  const before = (await draft()).doc.pages.length;
  // Round 2 item 13: Add a page adds and opens the page at once, with its name field focused (no browser
  // prompt); naming it there gives the fresh page its URL name.
  const addNamed = async (title: string) => {
    await page.locator("[data-page-menu]").click();
    await page.locator("[data-page-add]").click();
    await expect(page.locator("[data-page-name-input]")).toBeFocused();
    await page.keyboard.press("Control+a");
    await page.keyboard.type(title);
    await page.keyboard.press("Enter");
  };
  await addNamed("Second page");
  await expect(page).toHaveURL(new RegExp(`/build/${SLUG}/second-page$`));
  const after = await untilDraft((d) => d.doc.pages.some((p) => p.slug === "second-page"));
  expect(after.doc.pages.length).toBeGreaterThan(before);
  expect(after.doc.pages.map((p) => p.slug)).toContain("second-page");
  await expect(page.locator("[data-page-switcher]")).toContainText("Second page");
  // A second page with the same title gets its own slug.
  await addNamed("Second page");
  await expect(page).toHaveURL(new RegExp(`/build/${SLUG}/second-page-2$`));
  expect((await untilDraft((d) => d.doc.pages.length > before + 1)).doc.pages).toHaveLength(before + 2);
  await ctx.close();
});

test("bug 1: Remove on the drag bar removes the component, selects its parent, and undo restores it", async ({ browser }) => {
  for (const v of SHELL_VARIANTS.slice(0, 2)) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await open(page);
    await select(page, "c_obremoveme");
    const btn = page.locator("[data-remove-selected]");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("aria-label", "Remove text Doomed");
    await page.screenshot({ path: ev("operator-bugs", `remove-button-${v.name}.png`) });
    await btn.click();
    expect(kid(await untilDraft((d) => !kid(d, "c_obremoveme")), "c_obremoveme")).toBeUndefined();
    await expect(page.locator('[data-selected-outline="c_obremoveme"]')).toHaveCount(0);
    await page.locator("[data-builder-canvas]").focus();
    await page.keyboard.press("Control+z");
    expect(kid(await untilDraft((d) => !!kid(d, "c_obremoveme")), "c_obremoveme")).toBeTruthy();
    await ctx.close();
  }
});

test("bug 1 at 390px: the remove button shows on the selected component and works", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 390, height: 844 }, mobile: true });
  const page = await ctx.newPage();
  await page.goto(`/build/${SLUG}`);
  await expect(page.locator("[data-narrow-tabs]")).toBeVisible();
  await page.locator('[data-canvas-root] [data-node="c_obremoveme"]').tap();
  const btn = page.locator("[data-remove-selected]");
  await expect(btn).toBeVisible();
  // The hit area (button plus its ::after) is at least 44px on a touch screen.
  const hit = await btn.evaluate((el) => { const a = getComputedStyle(el, "::after"); const r = el.getBoundingClientRect(); return { w: r.width - 2 * parseFloat(a.left), h: r.height - 2 * parseFloat(a.top) }; });
  log("remove hit area 390", hit);
  expect(hit.w).toBeGreaterThanOrEqual(44);
  expect(hit.h).toBeGreaterThanOrEqual(44);
  await expect(page.locator("[data-resize-handle]")).toHaveCount(0); // no grid editing under 900px
  await page.screenshot({ path: ev("operator-bugs", "remove-button-390-dark.png") });
  await btn.tap();
  expect(kid(await untilDraft((d) => !kid(d, "c_obremoveme")), "c_obremoveme")).toBeUndefined();
  await ctx.close();
  // Put it back for the next tests.
  const c = await api(OWNER);
  const d = await draft();
  await c.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_obremoveme", type: "text", name: "Doomed", props: { text: "Remove me." }, slot: { x: 0, y: 20, w: 6, h: 6 } } }] } });
});

test("bug 2: dragging edges and corners resizes on the grid, shows the ghost, and undo puts it back", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], recordVideo: ev("operator-bugs", "video") });
  const page = await ctx.newPage();
  await open(page);
  await select(page, "c_obtextnode");
  await expect(page.locator("[data-resize-handle]")).toHaveCount(8);
  const start = kid(await draft(), "c_obtextnode")!.slot!;
  const step = await page.locator(`[data-canvas-root] [data-node="${(await draft()).doc.pages[0]!.root.id}"]`).evaluate((el) => {
    const cs = getComputedStyle(el);
    const w = el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    return { col: (w - 11 * gap) / 12 + gap, row: (parseFloat(cs.gridAutoRows) || 8) + (parseFloat(cs.rowGap) || 0) };
  });
  const dragBy = async (id: string, dx: number, dy: number) => {
    const b = (await page.locator(`[data-resize-handle="${id}"]`).boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
    await expect(page.locator("[data-drop-ghost]")).toBeVisible();
    await page.mouse.up();
  };

  // South-east corner: two columns wider, four rows taller.
  await dragBy("se", step.col * 2, step.row * 4);
  let d = await untilDraft((x) => kid(x, "c_obtextnode")!.slot!.w !== start.w);
  expect(kid(d, "c_obtextnode")!.slot).toEqual({ x: start.x, y: start.y, w: start.w + 2, h: start.h + 4 });
  await page.screenshot({ path: ev("operator-bugs", "resize-se.png") });

  // West edge: one column out to the left, the right side stays.
  await dragBy("w", -step.col, 0);
  d = await untilDraft((x) => kid(x, "c_obtextnode")!.slot!.x !== start.x);
  expect(kid(d, "c_obtextnode")!.slot).toEqual({ x: start.x - 1, y: start.y, w: start.w + 3, h: start.h + 4 });

  // Undo twice restores the starting slot.
  await page.locator("[data-builder-canvas]").focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  d = await untilDraft((x) => kid(x, "c_obtextnode")!.slot!.w === start.w);
  expect(kid(d, "c_obtextnode")!.slot).toEqual(start);

  // On the phone layout a resize edits only the phone slot (4 columns), never the desktop one.
  await page.locator('[data-device="mobile"]').click();
  await select(page, "c_obtextnode");
  const phoneStep = await page.locator(`[data-canvas-root] [data-node="${d.doc.pages[0]!.root.id}"]`).evaluate((el) => {
    const cs = getComputedStyle(el);
    const w = el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    return (w - 3 * gap) / 4 + gap;
  });
  await dragBy("e", phoneStep * 10, 0);
  d = await untilDraft((x) => !!kid(x, "c_obtextnode")!.responsive?.mobile?.slot);
  const n = kid(d, "c_obtextnode")!;
  log("phone resize", n);
  expect(n.slot).toEqual(start);
  expect(n.responsive?.mobile?.slot?.x ?? 0).toBeGreaterThanOrEqual(0);
  expect((n.responsive!.mobile!.slot!.x) + n.responsive!.mobile!.slot!.w).toBeLessThanOrEqual(4);
  await ctx.close();
});

test("bug 3 at 360 and 390px: the Pages menu is on the phone bar, opens on top, and adds a page", async ({ browser }) => {
  for (const width of [360, 390]) {
    const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[width === 360 ? 0 : 1], viewport: { width, height: 800 }, mobile: true });
    const page = await ctx.newPage();
    await page.goto(`/build/${SLUG}`);
    await expect(page.locator("[data-narrow-tabs]")).toBeVisible();
    const trigger = page.locator("[data-page-menu]");
    const tb = (await trigger.boundingBox())!;
    expect(Math.min(tb.width, tb.height)).toBeGreaterThanOrEqual(44);
    expect(tb.x + tb.width).toBeLessThanOrEqual(width);
    expect(await page.locator("[data-builder-bar]").evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    await trigger.tap();
    const menu = page.locator("[data-page-menu-content]");
    await expect(menu).toBeVisible();
    const mb = (await menu.boundingBox())!;
    expect(mb.x).toBeGreaterThanOrEqual(0);
    expect(mb.x + mb.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: ev("operator-bugs", `page-menu-${width}.png`) });
    const before = (await draft()).doc.pages.length;
    // Round 2 item 13: the page is added and opened at once, with its name field focused (no browser prompt).
    await page.locator("[data-page-add]").tap();
    const name = page.locator("[data-page-name-input]");
    await expect(name).toBeFocused();
    await name.fill(`Phone ${width}`);
    await name.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/build/${SLUG}/phone-${width}$`));
    expect((await untilDraft((d) => d.doc.pages.length > before)).doc.pages.map((p) => p.slug)).toContain(`phone-${width}`);
    await ctx.close();
  }
});
