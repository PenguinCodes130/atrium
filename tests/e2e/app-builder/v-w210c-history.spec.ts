// Wave 2.10c builder A (app-builder): N2 undo and redo (stages/02-subsystem-spec/output/operator-tryout-spec.md
// section 5 N2, criterion 21; architecture A11.1). Every test drives the real screen the way the operator
// does (V11): Insert, the data picker, a drag on the canvas, a resize handle, typing in the inspector, the
// Delete key and the toast, the Pages menu, the Undo and Redo buttons, the shortcuts, Publish, reload.
// Stand-in: the fake Prometheus (tests/e2e/fixtures); never a real service.
// Evidence: evidence/app-builder/w210c-r1/<stage>/ (ATRIUM_E2E_W210C_STAGE=failing-first or pass).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { api, contextFor, OWNER, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Draft = { rev: number; doc: { dataSources: { name: string }[]; app: { homePage: string; pageOrder: string[] }; pages: { id: string; slug: string; title: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210C_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder/w210c-r1", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const note = (name: string, data: unknown) => writeFileSync(out(`${name}.json`), JSON.stringify(data, null, 2));
const RUN = Date.now().toString(36).slice(-4);
const LIGHT = SHELL_VARIANTS[0]!;
const ACE = "10.77.99.8:9100";
const owner = () => api(OWNER);
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const enc = (v: number, len: number) => Array.from({ length: len }, (_, i) => B32[Math.floor(v / 32 ** (len - 1 - i)) % 32]).join("");
const RUN_N = parseInt(RUN, 36) % 32 ** 4;
let n = 0;
/** A component id the server accepts: c_ and 10 letters or digits 2 to 7. */
const cid = () => `c_${enc(RUN_N, 4)}${enc(n++, 6)}`;

let prom: FakePrometheus | null = null;
let promId = "";
test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  prom = await startFakePrometheus();
  const c = await owner();
  const r = await c.post("/api/integrations", { data: { secrets: {}, untested: true, packageId: "prometheus", name: `Prometheus history ${RUN}`, config: { baseUrl: prom.url, authMode: "none" } } });
  if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
  promId = (await r.json()).id as string;
});
test.afterAll(async () => { await prom?.close(); });

async function draft(id: string): Promise<Draft> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const walk = (x: Node, f: (n: Node) => void) => { f(x); for (const k of x.children ?? []) walk(k, f); };
const nodeIn = (d: Draft, id: string): Node | undefined => { let f: Node | undefined; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.id === id) f = x; }); return f; };
async function newApp(slug: string): Promise<string> {
  const r = await (await owner()).post("/api/apps", { data: { name: `History ${slug}`, slug, template: "blank" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app.id as string;
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
async function insert(page: Page, type: string): Promise<string> {
  await page.locator('[data-left-tab="insert"]').click().catch(() => {});
  const before = new Set(await page.locator("[data-canvas-root] [data-node]").evaluateAll((els) => els.map((e) => e.getAttribute("data-node"))));
  await page.locator(`[data-insert-item="${type}"]`).click();
  await expect.poll(async () => (await page.locator(`[data-canvas-root] [data-type='${type}']`).evaluateAll((els) => els.map((e) => e.getAttribute("data-node")))).find((x) => !before.has(x))).toBeTruthy();
  const after = await page.locator(`[data-canvas-root] [data-type='${type}']`).evaluateAll((els) => els.map((e) => e.getAttribute("data-node")));
  return after.find((x) => !before.has(x))!;
}
const undoBtn = (page: Page) => page.locator("[data-builder-bar] [data-history-undo]");
const redoBtn = (page: Page) => page.locator("[data-builder-bar] [data-history-redo]");
async function key(page: Page, combo: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(combo);
}
/** The draft once saving has settled (nothing queued, the rev unchanged for 700 ms). */
async function settled(id: string): Promise<Draft> {
  let last = await draft(id);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const d = await draft(id);
    if (d.rev === last.rev) return d;
    last = d;
  }
  return last;
}

test("N2 criterion 21: insert, data, move, resize, prop, delete and page add each undo and redo through the buttons and the shortcut; history survives publish, not reload", async ({ browser }) => {
  const slug = `h-all-${RUN}`;
  const id = await newApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const steps: Record<string, unknown> = {};
  await openBuilder(page, slug);

  // The buttons are on the builder bar, disabled at both ends of an empty history.
  await expect(undoBtn(page)).toBeVisible();
  await expect(redoBtn(page)).toBeVisible();
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();

  // 1. Insert (the data picker opens; Escape leaves the stat with no data).
  const stat = await insert(page, "stat");
  await expect(page.locator("[data-show-picker]")).toBeVisible();
  // Scoped to this run's integration name: a typed search lists 50 rows and only some are peeked.
  await page.keyboard.type(`cpu ${RUN}`);
  const ace = page.locator(`[data-show-item][data-show-integration="${promId}"][data-show-endpoint="machine-cpu"][data-show-thing-value="${ACE}"]`).first();
  await expect(ace).toBeVisible({ timeout: 8000 });
  await ace.hover();
  await page.locator("[data-show-preview] [data-show-use]").click();
  await expect(page.locator("[data-show-picker]")).toHaveCount(0);
  let d = await untilDraft(id, (x) => !!nodeIn(x, stat)?.props.data);
  expect(nodeIn(d, stat)!.props.data, "the read is bound").toBeTruthy();

  // 2. Data change: one step named after it. Undo by the button, redo by the shortcut.
  await expect(undoBtn(page)).toHaveAttribute("title", "Undo Change Stat data");
  await expect(undoBtn(page)).toHaveAttribute("aria-label", "Undo Change Stat data");
  await undoBtn(page).click();
  d = await untilDraft(id, (x) => !!nodeIn(x, stat) && !nodeIn(x, stat)!.props.data);
  expect(nodeIn(d, stat)!.props.data, "undo took the data back").toBeFalsy();
  await expect(redoBtn(page)).toHaveAttribute("title", "Redo Change Stat data");
  await key(page, "Control+Shift+z");
  d = await untilDraft(id, (x) => !!nodeIn(x, stat)?.props.data);
  expect(nodeIn(d, stat)!.props.data, "redo put it back").toBeTruthy();
  await expect(redoBtn(page)).toBeDisabled();

  // Insert itself: two undos take the stat away, two redos bring it back with its data.
  await key(page, "Control+z");
  await expect(undoBtn(page)).toHaveAttribute("title", "Undo Insert Stat");
  await undoBtn(page).click();
  d = await untilDraft(id, (x) => !nodeIn(x, stat));
  expect(nodeIn(d, stat), "undo removed the inserted stat").toBeUndefined();
  await expect(undoBtn(page)).toBeDisabled();
  await redoBtn(page).click();
  await key(page, "Control+y");
  d = await untilDraft(id, (x) => !!nodeIn(x, stat)?.props.data);
  expect(nodeIn(d, stat)?.props.data).toBeTruthy();
  steps.insert = nodeIn(d, stat);

  // 3. Move: one drag on the canvas is one step.
  const box = page.locator(`[data-canvas-root] [data-node="${stat}"]`).first();
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${stat}"]`).click();
  d = await settled(id);
  const slot0 = nodeIn(d, stat)!.slot!;
  await box.click();
  const handle = page.locator(`[data-selected-outline="${stat}"] [data-drag-handle]`);
  await expect(handle).toBeVisible();
  const hb0 = (await handle.boundingBox())!;
  const sx = hb0.x + hb0.width - 8, sy = hb0.y + 5;
  // Alt places it exactly where it is dropped (A11.7); a loose drop on an otherwise empty page would snap back.
  await page.keyboard.down("Alt");
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(sx + i * 24, sy + i * 2);
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  d = await untilDraft(id, (x) => JSON.stringify(nodeIn(x, stat)?.slot) !== JSON.stringify(slot0));
  const slot1 = nodeIn(d, stat)!.slot!;
  expect(slot1, "the drag moved the stat").not.toEqual(slot0);
  await expect(undoBtn(page)).toHaveAttribute("title", /^Undo Move Stat( "[^"]*")?$/);
  await key(page, "Control+z");
  d = await untilDraft(id, (x) => JSON.stringify(nodeIn(x, stat)?.slot) === JSON.stringify(slot0));
  expect(nodeIn(d, stat)!.slot, "one undo puts the whole drag back").toEqual(slot0);
  await redoBtn(page).click();
  d = await untilDraft(id, (x) => JSON.stringify(nodeIn(x, stat)?.slot) === JSON.stringify(slot1));
  expect(nodeIn(d, stat)!.slot).toEqual(slot1);
  steps.move = { slot0, slot1 };

  // 4. Resize: one drag of the corner handle is one step.
  const se = page.locator('[data-resize-handle="se"]');
  await expect(se).toBeVisible();
  const hb = (await se.boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(hb.x + hb.width / 2 + i * 14, hb.y + hb.height / 2 + i * 8);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  d = await untilDraft(id, (x) => nodeIn(x, stat)!.slot!.w !== slot1.w || nodeIn(x, stat)!.slot!.h !== slot1.h);
  const slot2 = nodeIn(d, stat)!.slot!;
  expect(slot2.w * 100 + slot2.h, "the resize grew the stat").not.toBe(slot1.w * 100 + slot1.h);
  await expect(undoBtn(page)).toHaveAttribute("title", /^Undo Resize Stat( "[^"]*")?$/);
  await undoBtn(page).click();
  d = await untilDraft(id, (x) => JSON.stringify(nodeIn(x, stat)?.slot) === JSON.stringify(slot1));
  expect(nodeIn(d, stat)!.slot, "one undo puts the whole resize back").toEqual(slot1);
  await key(page, "Control+Shift+z");
  d = await untilDraft(id, (x) => JSON.stringify(nodeIn(x, stat)?.slot) === JSON.stringify(slot2));
  expect(nodeIn(d, stat)!.slot).toEqual(slot2);
  steps.resize = { slot1, slot2 };

  // 5. Prop edit: typing a word in one inspector field is one step; the shortcut works with focus in the
  // inspector (on a control that is not a text field).
  const insp = page.locator(`[data-inspector="${stat}"]`);
  const field = insp.locator('[data-field="label"] input').first();
  await expect(field).toBeVisible();
  const label0 = (nodeIn(d, stat)!.props.label as string | undefined) ?? "";
  await field.click();
  await field.pressSequentially("Load", { delay: 120 });
  d = await untilDraft(id, (x) => nodeIn(x, stat)?.props.label === "Load");
  expect(nodeIn(d, stat)!.props.label).toBe("Load");
  await expect(undoBtn(page)).toHaveAttribute("title", /^Undo Change Stat( "[^"]*")?$/);
  // Focus a non-text control in the inspector (a group heading) and undo from there.
  const heading = insp.locator("[data-inspector-group] h3 button").first();
  await heading.focus();
  await expect(heading).toBeFocused();
  await page.keyboard.press("Control+z");
  d = await untilDraft(id, (x) => ((nodeIn(x, stat)?.props.label as string | undefined) ?? "") === label0);
  expect((nodeIn(d, stat)!.props.label as string | undefined) ?? "", "one undo takes the whole word back").toBe(label0);
  await expect(heading).toBeFocused();
  await page.keyboard.press("Control+Shift+z");
  d = await untilDraft(id, (x) => nodeIn(x, stat)?.props.label === "Load");
  expect(nodeIn(d, stat)!.props.label).toBe("Load");
  // Wave 2.10c r2 item 8 (changed from round 1): inside an inspector text field the shortcut steps the
  // builder's history (the field's typing is that step), so nothing new is recorded on top; Redo brings it back.
  await field.click();
  await page.keyboard.press("Control+z");
  d = await untilDraft(id, (x) => ((nodeIn(x, stat)?.props.label as string | undefined) ?? "") === label0);
  expect((nodeIn(d, stat)!.props.label as string | undefined) ?? "", "Ctrl+Z in the field takes the typed word back as one step").toBe(label0);
  await expect(redoBtn(page)).toHaveAttribute("title", /^Redo Change Stat( "[^"]*")?$/);
  await page.keyboard.press("Control+Shift+z");
  d = await untilDraft(id, (x) => nodeIn(x, stat)?.props.label === "Load");
  expect(nodeIn(d, stat)!.props.label).toBe("Load");
  await page.screenshot({ path: out("n2-prop-edit.png") });

  // 6. Delete: the Delete key shows "Deleted Stat · Undo"; the toast's Undo brings it back.
  await page.locator(`[data-layer="${stat}"]`).click();
  await key(page, "Delete");
  d = await untilDraft(id, (x) => !nodeIn(x, stat));
  expect(nodeIn(d, stat)).toBeUndefined();
  const toastEl = page.locator("[data-toast]").filter({ hasText: "Deleted Stat" });
  await expect(toastEl).toBeVisible();
  await page.screenshot({ path: out("n2-delete-toast.png") });
  steps.toast = await toastEl.innerText();
  await toastEl.getByRole("button", { name: "Undo" }).click();
  d = await untilDraft(id, (x) => !!nodeIn(x, stat));
  expect(nodeIn(d, stat), "the toast's Undo brought it back").toBeTruthy();
  await redoBtn(page).click();
  d = await untilDraft(id, (x) => !nodeIn(x, stat));
  expect(nodeIn(d, stat)).toBeUndefined();
  await key(page, "Control+z");
  d = await untilDraft(id, (x) => !!nodeIn(x, stat));
  expect(nodeIn(d, stat)).toBeTruthy();

  // 7. Page add from the Pages menu.
  await page.locator("[data-page-menu]").click();
  await page.locator("[data-page-add]").click();
  await page.keyboard.press("Escape");
  d = await untilDraft(id, (x) => x.doc.pages.length === 2);
  expect(d.doc.pages).toHaveLength(2);
  await expect(undoBtn(page)).toHaveAttribute("title", /^Undo Add page "New page"/);
  await undoBtn(page).click();
  d = await untilDraft(id, (x) => x.doc.pages.length === 1);
  expect(d.doc.pages, "undo removed the added page").toHaveLength(1);
  await key(page, "Control+Shift+z");
  d = await untilDraft(id, (x) => x.doc.pages.length === 2);
  expect(d.doc.pages).toHaveLength(2);
  await page.screenshot({ path: out("n2-bar-1280.png") });

  // 8. Publish keeps the history: Undo still takes the page back afterwards.
  await page.locator("[data-publish]").click();
  await page.locator("[data-publish-confirm]").click();
  await expect(page.locator("[data-publish-glow], [data-publish-check]").first()).toBeAttached();
  await expect(page.locator("[data-review]")).toHaveCount(0);
  await expect(undoBtn(page)).toBeEnabled();
  await expect(undoBtn(page)).toHaveAttribute("title", /^Undo Add page "New page"/);
  await undoBtn(page).click();
  d = await untilDraft(id, (x) => x.doc.pages.length === 1);
  expect(d.doc.pages, "history survived publish").toHaveLength(1);

  // 9. Reload clears it.
  await page.reload();
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();
  note("n2-criterion-21", steps);
  await ctx.close();
});

test("N2: an undo whose target another editor removed is refused with a sentence and skipped", async ({ browser }) => {
  const slug = `h-gone-${RUN}`;
  const id = await newApp(slug);
  const root = (await draft(id)).doc.pages[0]!.root.id;
  const a = cid();
  const bId = cid();
  const c = await owner();
  const d0 = await draft(id);
  const put = await c.post(`/api/apps/${id}/ops`, { data: { rev: d0.rev, ops: [
    { op: "node.add", parentId: root, node: { id: a, type: "text", props: { text: "Alpha" }, slot: { x: 0, y: 0, w: 4, h: 8 } } },
    { op: "node.add", parentId: root, node: { id: bId, type: "text", props: { text: "Beta" }, slot: { x: 6, y: 0, w: 4, h: 8 } } },
  ] } });
  expect(put.ok(), await put.text()).toBe(true);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${bId}"]`).click();
  await key(page, "ArrowDown");
  await page.locator(`[data-layer="${a}"]`).click();
  await key(page, "ArrowRight");
  let d = await settled(id);
  await expect(undoBtn(page)).toHaveAttribute("title", "Undo Move Text");
  // Another editor (the owner's API session) removes Alpha.
  const r = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: [{ op: "node.remove", nodeId: a }] } });
  expect(r.ok(), await r.text()).toBe(true);
  await undoBtn(page).click();
  const said = page.locator("[data-toast]").filter({ hasText: "was skipped" });
  await expect(said).toBeVisible({ timeout: 8000 });
  await expect(said).toContainText('Undo of "Move Text" was skipped');
  await page.screenshot({ path: out("n2-refused-skipped.png") });
  // Skipped: the next undo goes on with Beta's move.
  const betaY = nodeIn(await draft(id), bId)!.slot!.y;
  await undoBtn(page).click();
  d = await untilDraft(id, (x) => nodeIn(x, bId)!.slot!.y === betaY - 1);
  expect(nodeIn(d, bId)!.slot!.y).toBe(betaY - 1);
  expect(nodeIn(d, a), "Alpha stays removed").toBeUndefined();
  await ctx.close();
});

test("N2 V5 V8: the Undo and Redo buttons at 390x844 with reduced motion", async ({ browser }) => {
  const slug = `h-phone-${RUN}`;
  const id = await newApp(slug);
  const root = (await draft(id)).doc.pages[0]!.root.id;
  const c = await owner();
  const d0 = await draft(id);
  await c.post(`/api/apps/${id}/ops`, { data: { rev: d0.rev, ops: [{ op: "node.add", parentId: root, node: { id: cid(), type: "text", props: { text: "Phone" }, slot: { x: 0, y: 0, w: 4, h: 8 } } }] } });
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 390, height: 844 }, reducedMotion: "reduce", mobile: true });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  // Phones: beside the view tabs (the bar is full at 360 px), like the Pages menu.
  const undo = page.locator("[data-narrow-tabs] ~ span [data-history-undo]");
  const redo = page.locator("[data-narrow-tabs] ~ span [data-history-redo]");
  await expect(undo).toBeVisible();
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  for (const b of [undo, redo]) {
    const bb = (await b.boundingBox())!;
    expect(Math.min(bb.width, bb.height), "44 px touch target").toBeGreaterThanOrEqual(44);
  }
  // The bar still fits: Publish is whole inside the window.
  const pub = (await page.locator("[data-publish]").boundingBox())!;
  expect(pub.x + pub.width, "Publish is not cut off").toBeLessThanOrEqual(390);
  // An edit made on the phone (Edit tab, a text field) is undone by the button.
  await page.locator('[data-narrow-tab="layers"]').click();
  await page.locator("[data-layer]").last().click();
  await page.locator('[data-narrow-tab="edit"]').click();
  const text = page.locator('[data-inspector] [data-field="text"] textarea, [data-inspector] [data-field="text"] input').first();
  await text.fill("Phone FAKE edit");
  await text.blur();
  await expect.poll(async () => JSON.stringify((await draft(id)).doc.pages[0]!.root.children)).toContain("Phone FAKE edit");
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(async () => JSON.stringify((await draft(id)).doc.pages[0]!.root.children)).not.toContain("Phone FAKE edit");
  await page.screenshot({ path: out("n2-bar-390-reduced.png") });
  await ctx.close();
});

test("N2 V4: the builder bar with Undo and Redo in Control Room, Dusk, Solid and a frosted custom theme", async ({ browser }) => {
  const c = await owner();
  const themes: Record<string, string> = { "control-room": "control-room", dusk: "dusk", solid: "solid" };
  // The frosted custom theme, made here through the real API.
  const dup = await c.post("/api/settings/themes/control-room/duplicate");
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const tid = (await dup.json()).id as string;
  const cur = await (await c.get(`/api/settings/themes/${tid}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = `Frosted history e2e ${RUN}`;
  theme.tokens.wallpaper = { ...theme.tokens.wallpaper, kind: "gradient", value: "linear-gradient(135deg, #3c5078, #b4a0c8)", blurPx: 0, dim: 0, grain: 0 };
  theme.tokens.surface = { ...theme.tokens.surface, material: "glass", opacity: 0.3, blurPx: 1, shadow: "soft", border: { ...theme.tokens.surface.border, widthPx: 1 } };
  const put = await c.put(`/api/settings/themes/${tid}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  themes.frosted = tid;
  for (const [name, themeId] of Object.entries(themes)) {
    const slug = `h-v4-${name.slice(0, 6)}-${RUN}`;
    const id = await newApp(slug);
    const d = await draft(id);
    const root = d.doc.pages[0]!.root.id;
    await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: [{ op: "theme.set", theme: { themeId } }, { op: "node.add", parentId: root, node: { id: cid(), type: "stat", props: { label: "Load", value: 42, unit: "%" }, slot: { x: 0, y: 0, w: 3, h: 12 } } }] } });
    const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await openBuilder(page, slug);
    await page.locator('[data-left-tab="layers"]').click();
    await page.locator("[data-layer]").last().click();
    await key(page, "ArrowRight");
    await expect(undoBtn(page)).toBeEnabled();
    await undoBtn(page).hover();
    await page.screenshot({ path: out(`n2-v4-${name}.png`) });
    await ctx.close();
  }
});
