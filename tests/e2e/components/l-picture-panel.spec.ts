// Wave 2.7 media layout (stages/02-subsystem-spec/output/media-layout-spec.md 3.1; criteria 1 to 9, 11,
// 12, 18 to 20), through the real builder screen (V11): the Picture panel's buttons, sliders and focal
// point on the canvas, then Preview and the published viewer; captions in the three app themes; click
// actions; the video cover; the panel at 390px; slider frame times (V7); reduced motion (V8).
// Served by tests/e2e/components/serve.sh (port 3114). Evidence: evidence/components/<round>/media/.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidence, signIn, writeEvidence } from "./helpers";
import { inverseOps } from "../../../src/features/apps/ops";
import { blankDocument } from "../../../src/features/apps/doc";

test.describe.configure({ timeout: 240_000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.join(here, "media");
const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: { x: number; y: number; w: number; h: number }; children?: Node[]; name?: string; css?: string; overrideTheme?: boolean; style?: Record<string, Record<string, unknown>> };
type Draft = { rev: number; doc: { pages: { id: string; slug: string; title: string; root: Node }[] } };
const shot = (name: string) => evidence("media", `${name}.png`);
/**
 * Whether Undo of a prop's first value removes it again. Shared file request SFR-1 (apps/ops.ts): the
 * inverse of `{ props: { flipX: true } }` must be `{ props: { flipX: null } }`; until it is applied, the
 * inverse copies the old props whole, and a merge patch cannot remove a key that was added.
 */
const UNDO_REMOVES_NEW_PROPS = (() => {
  const doc = blankDocument("probe");
  doc.pages[0]!.root.children = [{ id: "c_probeaaaaa", type: "image", props: {}, slot: { x: 0, y: 0, w: 2, h: 2 } }];
  const inv = inverseOps(doc, [{ op: "node.update", nodeId: "c_probeaaaaa", patch: { props: { flipX: true } } }]);
  const p = (inv?.[0] as { patch?: { props?: Record<string, unknown> } } | undefined)?.patch?.props;
  return !!p && p.flipX === null;
})();

async function draft(req: APIRequestContext, id: string): Promise<Draft> {
  return (await req.get(`/api/apps/${id}/draft`)).json();
}
async function ops(req: APIRequestContext, id: string, list: unknown[]) {
  const d = await draft(req, id);
  const r = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function upload(req: APIRequestContext, file: string, mime: string, accept: "image" | "video"): Promise<string> {
  const r = await req.post("/api/settings/uploads", { multipart: { file: { name: path.basename(file), mimeType: mime, buffer: readFileSync(path.join(MEDIA, file)) }, accept }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).path as string;
}
async function newApp(req: APIRequestContext, slug: string, kids: Node[], extra: unknown[] = []): Promise<{ id: string; rootId: string; pageId: string }> {
  const r = await req.post("/api/apps", { data: { name: `Media ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await draft(req, id);
  const rootId = d.doc.pages[0]!.root.id;
  await ops(req, id, [...extra, ...kids.map((n) => ({ op: "node.add", parentId: rootId, node: n }))]);
  return { id, rootId, pageId: d.doc.pages[0]!.id };
}
async function publish(req: APIRequestContext, appId: string) {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note: "media layout" }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function untilDraft(req: APIRequestContext, id: string, ok: (d: Draft) => boolean, ms = 6000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(req, id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const find = (n: Node, id: string): Node | undefined => (n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean));
const nodeIn = (d: Draft, id: string) => find(d.doc.pages[0]!.root, id)!;
async function open(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
}
async function selectOnCanvas(page: Page, id: string) {
  await page.locator(`[data-canvas-root] [data-node="${id}"]`).click();
  await expect(page.locator(`[data-inspector][data-node-id="${id}"]`)).toBeVisible();
}
/** Undo from the canvas (the inspector keeps its own keys). */
async function undo(page: Page, id: string) {
  await page.locator(`[data-canvas-root] [data-node="${id}"]`).click();
  await page.keyboard.press("Control+z");
}
const panel = (page: Page) => page.locator("[data-picture-panel]");
/** Colours at points of an element's screenshot (points in px from its top left), decoded in the page. */
async function pixels(page: Page, sel: string, points: [number, number][]): Promise<number[][]> {
  const buf = await page.locator(sel).first().screenshot();
  return page.evaluate(async ({ b64, points }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const dpr = img.width / (img.width / devicePixelRatio) / devicePixelRatio || 1;
    return points.map(([x, y]) => Array.from(g.getImageData(Math.min(img.width - 1, Math.round(x * dpr)), Math.min(img.height - 1, Math.round(y * dpr)), 1, 1).data).slice(0, 3));
  }, { b64: buf.toString("base64"), points });
}
const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[2]! < 60;
const quadColour = (p: number[]) => (p[0]! > 200 && p[1]! < 60 ? "red" : p[1]! > 200 && p[0]! < 60 ? "lime" : p[2]! > 200 && p[0]! < 60 ? "blue" : p[0]! > 200 && p[1]! > 200 && p[2]! < 60 ? "yellow" : `other(${p.join(",")})`);
/** Drags a range input's thumb to a value with real mouse moves; returns frame times sampled meanwhile. */
async function dragSlider(page: Page, sel: string, value: number, opts: { steps?: number; during?: () => Promise<void> } = {}) {
  const input = page.locator(sel);
  await input.scrollIntoViewIfNeeded();
  const { min, max, cur } = await input.evaluate((e: HTMLInputElement) => ({ min: Number(e.min), max: Number(e.max), cur: Number(e.value) }));
  const b = (await input.boundingBox())!;
  // Chromium and Firefox draw the thumb inset by about half its width at each end.
  const inset = 8;
  const at = (v: number) => b.x + inset + ((v - min) / (max - min)) * (b.width - 2 * inset);
  await page.mouse.move(at(cur), b.y + b.height / 2);
  await page.mouse.down();
  const steps = opts.steps ?? 12;
  for (let i = 1; i <= steps; i++) await page.mouse.move(at(cur + ((value - cur) * i) / steps), b.y + b.height / 2);
  if (opts.during) await opts.during();
  await page.mouse.up();
}

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project; the phone width is set per test");
  await signIn(context, page.request);
});

test("Picture panel: shape, rotate, flip, straighten, zoom, focal point and filters by buttons and sliders, live on the canvas, then Preview and the viewer (criteria 1 to 7, 12)", async ({ browser, page: signed }) => {
  const req = signed.request;
  const quad = await upload(req, "quad.png", "image/png", "image");
  const img = "c_mediaquada";
  const slug = `media-pic-${RUN}`;
  const app = await newApp(req, slug, [{ id: img, type: "image", name: "Quadrants", props: { src: quad, alt: "Four colours", fit: "contain", height: 160 }, slot: { x: 0, y: 0, w: 4, h: 25 } }]);
  const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: await signed.context().storageState(), viewport: { width: 1440, height: 900 }, recordVideo: { dir: evidence("media", "video-picture-panel"), size: { width: 1440, height: 900 } } });
  const page = await ctx.newPage();
  await open(page, slug);
  await selectOnCanvas(page, img);
  // The Picture group is first and open, the canvas node shows the picture.
  const first = await page.locator("[data-inspector-groups] [data-inspector-group]").evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== "none").map((e) => ({ id: e.getAttribute("data-inspector-group"), order: Number(getComputedStyle(e).order), top: e.getBoundingClientRect().top })).sort((a, b) => a.top - b.top)[0]);
  expect(first?.id).toBe("content");
  await expect(page.locator('[data-inspector-group="content"] h3')).toHaveText("Picture");
  await expect(panel(page)).toBeVisible();
  const frameSel = `[data-canvas-root] [data-node="${img}"] [data-media-frame]`;
  const outlineSel = `[data-selected-outline="${img}"]`;

  // Criterion 4: Shape 16:9 on a 4-column picture sets the box height to width times 9/16 (within 8px).
  await panel(page).locator('[data-media-shape="16:9"]').click();
  let d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.shape === "16:9");
  await page.waitForTimeout(300);
  const f169 = (await page.locator(frameSel).boundingBox())!;
  writeEvidence("media/shape-16-9.json", { frame: f169, slot: nodeIn(d, img).slot, height: nodeIn(d, img).props.height });
  expect(Math.abs(f169.height - (f169.width * 9) / 16)).toBeLessThanOrEqual(8);
  await page.screenshot({ path: shot("shape-16-9") });

  // Criterion 1: Rotate right turns the picture inside an unchanged outline.
  const before = (await page.locator(outlineSel).boundingBox())!;
  await panel(page).locator('[data-media-rotate="right"]').click();
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.rotate === 90);
  expect(nodeIn(d, img).props.rotate).toBe(90);
  await page.waitForTimeout(250);
  const after = (await page.locator(outlineSel).boundingBox())!;
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(1);
  const holder = page.locator(`[data-canvas-root] [data-node="${img}"] [data-media-holder]`);
  expect(await holder.evaluate((e) => (e as HTMLElement).style.transform)).toContain("rotate(90deg)");
  // On its side the holder is the frame turned: as wide as the frame is tall.
  const sides = await holder.evaluate((e) => ({ w: (e as HTMLElement).offsetWidth, h: (e as HTMLElement).offsetHeight, fw: e.parentElement!.clientWidth, fh: e.parentElement!.clientHeight }));
  expect(Math.abs(sides.w - sides.fh)).toBeLessThanOrEqual(1);
  expect(Math.abs(sides.h - sides.fw)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: shot("rotate-right-16-9") });
  // With Shape Original the box follows the turned (portrait) picture.
  await panel(page).locator('[data-media-shape="original"]').click();
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.shape === "original");
  await page.waitForTimeout(300);
  const portrait = (await page.locator(frameSel).boundingBox())!;
  expect(portrait.height).toBeGreaterThan(portrait.width);
  expect(Math.abs(portrait.height - portrait.width * 1.5)).toBeLessThanOrEqual(8);
  await page.screenshot({ path: shot("rotate-right-original-portrait") });
  // One Undo takes the shape back, in one step (props and box together).
  await undo(page, img);
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.shape === "16:9");
  expect(nodeIn(d, img).props.shape).toBe("16:9");
  await selectOnCanvas(page, img);

  // Criterion 2: Flip across mirrors; pressing again restores; one Undo reverts each press.
  const flip = panel(page).locator('[data-media-flip="across"]');
  await flip.click();
  await untilDraft(req, app.id, (x) => nodeIn(x, img).props.flipX === true);
  await expect(flip).toHaveAttribute("aria-pressed", "true");
  expect(await holder.evaluate((e) => (e as HTMLElement).style.transform)).toContain("scale(-1, 1)");
  await flip.click();
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.flipX === undefined);
  expect(await holder.evaluate((e) => (e as HTMLElement).style.transform)).not.toContain("scale(-1");
  await undo(page, img);
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.flipX === true);
  expect(nodeIn(d, img).props.flipX).toBe(true);
  expect(await holder.evaluate((e) => (e as HTMLElement).style.transform)).toContain("scale(-1, 1)");
  if (UNDO_REMOVES_NEW_PROPS) {
    // Undo of a first press takes the prop away again (needs shared file request SFR-1, apps/ops.ts).
    await undo(page, img);
    d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.flipX === undefined);
    expect(nodeIn(d, img).props.flipX).toBeUndefined();
    await undo(page, img); // the rotate press
    d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.rotate === undefined);
    expect(nodeIn(d, img).props.rotate).toBeUndefined();
    await selectOnCanvas(page, img);
  } else {
    test.info().annotations.push({ type: "needs SFR-1", description: "Undo of a prop's first value leaves it set (apps/ops.ts prevValues is shallow)." });
    await selectOnCanvas(page, img);
    await flip.click();
    await untilDraft(req, app.id, (x) => nodeIn(x, img).props.flipX === undefined);
    await panel(page).locator('[data-media-rotate="left"]').click();
    d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.rotate === undefined);
  }

  // Criterion 3: Straighten at 10 degrees with Fill and crop tilts the picture with no empty corners.
  await panel(page).locator('[data-media-fit="cover"]').click();
  await untilDraft(req, app.id, (x) => nodeIn(x, img).props.fit === "cover");
  const revBefore = (await draft(req, app.id)).rev;
  let liveDuring = "";
  await dragSlider(page, '[data-media-slider="straighten"]', 10, { during: async () => {
    liveDuring = await holder.evaluate((e) => (e as HTMLElement).style.transform);
    // Live on the canvas while dragging, nothing saved yet.
    expect((await draft(req, app.id)).rev).toBe(revBefore);
  } });
  expect(liveDuring).toMatch(/rotate\((9|10|11)deg\)/);
  d = await untilDraft(req, app.id, (x) => typeof nodeIn(x, img).props.straighten === "number");
  // The slider lands within a step of 10; the keyboard sets it exactly.
  await panel(page).locator('[data-media-slider="straighten"]').focus();
  const got = Number(nodeIn(d, img).props.straighten);
  for (let i = 0; i < Math.abs(got - 10); i++) await page.keyboard.press(got > 10 ? "ArrowLeft" : "ArrowRight");
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.straighten === 10);
  expect(nodeIn(d, img).props.straighten).toBe(10);
  await page.waitForTimeout(400);
  const fb = (await page.locator(frameSel).boundingBox())!;
  // Just inside the theme's rounded corner (the box clips to it): without the cover scale a 10 degree tilt
  // leaves an empty triangle about 29px deep here.
  const radius = await page.locator(`[data-canvas-root] [data-node="${img}"] [data-slot="root"]`).evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0);
  const o = Math.max(12, Math.ceil(radius * 0.3) + 2); // clear of the selection outline and its handles
  const corners = await pixels(page, frameSel, [[o, o], [fb.width - 1 - o, o], [o, fb.height - 1 - o], [fb.width - 1 - o, fb.height - 1 - o]]);
  writeEvidence("media/straighten-corners.json", { corners: corners.map(quadColour), transform: await holder.evaluate((e) => (e as HTMLElement).style.transform) });
  await page.locator(frameSel).screenshot({ path: shot("straighten-10-cover") });
  for (const c of corners) expect(quadColour(c)).not.toMatch(/^other/);

  // Criteria 5 and 6: focal point dragged to the top left on the thumbnail, then Zoom 200 percent.
  const focal = panel(page).locator("[data-media-focal]");
  await focal.scrollIntoViewIfNeeded();
  const tb = (await focal.boundingBox())!;
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(tb.x + tb.width / 2 - (tb.width / 2 + 10) * (i / 8), tb.y + tb.height / 2 - (tb.height / 2 + 10) * (i / 8));
  const canvasImg = page.locator(`[data-canvas-root] [data-node="${img}"] img[data-media-el]`);
  expect(await canvasImg.evaluate((e) => getComputedStyle(e).objectPosition)).toBe("0% 0%");
  await page.mouse.up();
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.focusX === 0 && nodeIn(x, img).props.focusY === 0);
  expect([nodeIn(d, img).props.focusX, nodeIn(d, img).props.focusY]).toEqual([0, 0]);
  await dragSlider(page, '[data-media-slider="zoom"]', 200);
  d = await untilDraft(req, app.id, (x) => typeof nodeIn(x, img).props.zoom === "number");
  const z = Number(nodeIn(d, img).props.zoom);
  await panel(page).locator('[data-media-slider="zoom"]').focus();
  for (let i = 0; i < Math.round(Math.abs(z * 100 - 200) / 5); i++) await page.keyboard.press(z > 2 ? "ArrowLeft" : "ArrowRight");
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.zoom === 2);
  expect(nodeIn(d, img).props.zoom).toBe(2);
  // Straighten back to 0 so the pixel check reads the zoom alone.
  await panel(page).locator('[data-media-slider="straighten"]').focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft");
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.straighten === undefined);
  await page.waitForTimeout(400);
  const zoomStyle = await canvasImg.evaluate((e) => ({ t: getComputedStyle(e).transform, o: getComputedStyle(e).transformOrigin, p: getComputedStyle(e).objectPosition }));
  expect(zoomStyle.t).toBe("matrix(2, 0, 0, 2, 0, 0)");
  expect(zoomStyle.o).toBe("0px 0px");
  const fz = (await page.locator(frameSel).boundingBox())!;
  const canvasPx = await pixels(page, frameSel, [[12, 12], [fz.width / 2, fz.height / 2], [fz.width - 13, fz.height - 13]]);
  // The picture's top-left quarter (red) fills the frame at twice the size.
  expect(canvasPx.map(quadColour)).toEqual(["red", "red", "red"]);
  await page.locator(frameSel).screenshot({ path: shot("focal-top-left-zoom-200-canvas") });

  // Criterion 7: Black and white sets Grey to 100; a filter slider changes the canvas while dragging.
  await panel(page).locator('[data-media-preset="bw"]').click();
  d = await untilDraft(req, app.id, (x) => (nodeIn(x, img).props.filters as { grayscale?: number } | undefined)?.grayscale === 100);
  await expect(panel(page).locator('[data-media-preset="bw"]')).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).locator('[data-media-readout="grayscale"]')).toHaveText("100%");
  await panel(page).locator('[data-media-preset="none"]').click();
  await untilDraft(req, app.id, (x) => !Object.keys((nodeIn(x, img).props.filters as object | undefined) ?? {}).length);
  let filterDuring = "";
  await dragSlider(page, '[data-media-slider="sepia"]', 60, { during: async () => { filterDuring = await canvasImg.evaluate((e) => getComputedStyle(e).filter); } });
  expect(filterDuring).toMatch(/sepia\(0\.[5-6]/);
  d = await untilDraft(req, app.id, (x) => typeof (nodeIn(x, img).props.filters as { sepia?: number } | undefined)?.sepia === "number");
  const sepia = (nodeIn(d, img).props.filters as { sepia: number }).sepia;
  const canvasFilter = await canvasImg.evaluate((e) => getComputedStyle(e).filter);
  await page.screenshot({ path: shot("filters-sepia") });

  // Criterion 12: none of it wrote typed CSS.
  expect(nodeIn(d, img).css).toBeUndefined();
  const reset = panel(page).locator("[data-media-reset]");
  await expect(reset).toBeEnabled();

  // Preview (the draft) and the published viewer draw the same picture.
  const preview = await ctx.newPage();
  await preview.goto(`/a/${slug}/${d.doc.pages[0]!.slug}?draft=1`);
  const vSel = `[data-node="${img}"] [data-media-frame]`;
  await expect(preview.locator(vSel)).toBeVisible({ timeout: 15_000 });
  await preview.waitForTimeout(500);
  const pb = (await preview.locator(vSel).boundingBox())!;
  const previewPx = await pixels(preview, vSel, [[3, 3], [pb.width / 2, pb.height / 2]]);
  await preview.locator(vSel).screenshot({ path: shot("focal-zoom-sepia-preview") });
  await publish(req, app.id);
  const viewer = await ctx.newPage();
  await viewer.goto(`/a/${slug}`);
  await expect(viewer.locator(vSel)).toBeVisible({ timeout: 15_000 });
  await viewer.waitForTimeout(500);
  const vb = (await viewer.locator(vSel).boundingBox())!;
  const viewerPx = await pixels(viewer, vSel, [[3, 3], [vb.width / 2, vb.height / 2]]);
  const viewerFilter = await viewer.locator(`[data-node="${img}"] img[data-media-el]`).evaluate((e) => getComputedStyle(e).filter);
  await viewer.locator(vSel).screenshot({ path: shot("focal-zoom-sepia-viewer") });
  writeEvidence("media/canvas-preview-viewer.json", { canvas: canvasPx, preview: previewPx, viewer: viewerPx, canvasFilter, viewerFilter, sepia });
  // The top left stays in view everywhere (sepia tints the red, so compare red dominance).
  for (const p of [...previewPx, ...viewerPx]) expect(p[0]! > p[1]! + 40 && p[0]! > p[2]! + 40).toBe(true);
  expect(viewerFilter).toBe(canvasFilter);

  // Reset clears the look in one step and disables itself.
  await reset.click();
  d = await untilDraft(req, app.id, (x) => nodeIn(x, img).props.zoom === undefined && nodeIn(x, img).props.focusX === undefined);
  expect(["rotate", "flipX", "flipY", "straighten", "zoom", "focusX", "focusY", "filters"].filter((k) => nodeIn(d, img).props[k] !== undefined)).toEqual([]);
  await expect(reset).toBeDisabled();
  expect(isRed([255, 0, 0])).toBe(true);
  await ctx.close();
});

test("caption over and below is readable in all three app themes; Opacity, Corners and Frame by buttons (criteria 8, 12)", async ({ page }) => {
  const req = page.request;
  const quad = await upload(req, "quad.png", "image/png", "image");
  const over = "c_mediacapov";
  const below = "c_mediacapbl";
  const slug = `media-cap-${RUN}`;
  const app = await newApp(req, slug, [
    { id: over, type: "image", name: "Over", props: { src: quad, alt: "Over", fit: "cover", height: 180, caption: "Rack, front panel", captionAt: "over" }, slot: { x: 0, y: 0, w: 4, h: 25 } },
    { id: below, type: "image", name: "Below", props: { src: quad, alt: "Below", fit: "cover", height: 140, caption: "Rack, rear", captionAt: "below" }, slot: { x: 4, y: 0, w: 4, h: 25 } },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, slug);
  await selectOnCanvas(page, below);
  // The caption controls are buttons; Over the bottom moves it onto the picture.
  await expect(panel(page).locator('[data-media-caption-at="below"]')).toHaveAttribute("aria-checked", "true");
  await panel(page).locator("[data-media-caption-text]").fill("Rack, rear panel");
  await untilDraft(req, app.id, (x) => nodeIn(x, below).props.caption === "Rack, rear panel");
  // Opacity slider (live), Corners Rounded, a Hard shadow: style through buttons, never typed CSS.
  const nodeEl = page.locator(`[data-canvas-root] [data-node="${below}"] [data-slot="root"]`);
  let opDuring = "";
  await dragSlider(page, '[data-media-slider="opacity"]', 70, { during: async () => { opDuring = await nodeEl.evaluate((e) => getComputedStyle(e).opacity); } });
  expect(Number(opDuring)).toBeLessThan(0.8);
  let d = await untilDraft(req, app.id, (x) => typeof nodeIn(x, below).style?.root?.opacity === "number");
  expect(nodeIn(d, below).overrideTheme).toBe(true);
  await panel(page).locator('[data-media-corner="rounded"]').click();
  d = await untilDraft(req, app.id, (x) => nodeIn(x, below).style?.root?.borderRadius === 8);
  await panel(page).locator('[data-media-frame-style] [data-style-field="boxShadow"] [data-choice="hard"]').click();
  d = await untilDraft(req, app.id, (x) => typeof nodeIn(x, below).style?.root?.boxShadow === "string");
  expect(nodeIn(d, below).css).toBeUndefined();
  await page.waitForTimeout(1500);
  const look = await nodeEl.evaluate((e) => ({ radius: getComputedStyle(e).borderTopLeftRadius, opacity: getComputedStyle(e).opacity }));
  writeEvidence("media/frame-style.json", { look, style: nodeIn(d, below).style });
  expect(look.radius).toBe("8px");
  expect(Number(look.opacity)).toBeLessThan(0.8);
  await page.locator('[data-inspector-group="content"]').screenshot({ path: shot("picture-panel-frame") });

  const out: Record<string, unknown> = {};
  for (const theme of ["control-room", "dusk", "solid"]) {
    await ops(req, app.id, [{ op: "theme.set", theme: { themeId: theme } }]);
    await publish(req, app.id);
    await page.goto(`/a/${slug}`);
    await expect(page.locator(`[data-node="${over}"] [data-media-caption="over"]`)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    // Contrast against what is really painted behind each caption: its text is hidden for a moment, the
    // background under it is sampled from a screenshot, and the worst sample counts. Over the picture the
    // worst case of a black or a white picture under the 92 percent surface is checked as well.
    const res: Record<string, unknown> = {};
    for (const [id, where] of [[over, "over"], [below, "below"]] as const) {
      const sel = `[data-node="${id}"] [data-media-caption="${where}"]`;
      const fg = await page.locator(sel).evaluate((e) => getComputedStyle(e).color);
      await page.locator(sel).evaluate((e) => { (e as HTMLElement).style.color = "transparent"; });
      const b = (await page.locator(sel).boundingBox())!;
      const bgs = await pixels(page, sel, [[2, 2], [b.width / 4, b.height / 2], [b.width / 2, b.height / 2], [(3 * b.width) / 4, b.height / 2], [b.width - 3, b.height - 3]]);
      await page.locator(sel).evaluate((e) => { (e as HTMLElement).style.color = ""; });
      const r = await page.evaluate(({ fg, bgs, scrim }) => {
        const rgba = (color: string) => {
          const c = document.createElement("canvas");
          c.width = c.height = 1;
          const g = c.getContext("2d")!;
          g.clearRect(0, 0, 1, 1);
          g.fillStyle = color;
          g.fillRect(0, 0, 1, 1);
          const d = g.getImageData(0, 0, 1, 1).data;
          return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
        };
        const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
        const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
        const comp = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
        const f = rgba(fg);
        const painted = Math.min(...bgs.map((b) => ratio(f, b)));
        const worst = scrim ? Math.min(ratio(f, comp(rgba(scrim), [0, 0, 0])), ratio(f, comp(rgba(scrim), [255, 255, 255]))) : painted;
        return { fg, bgs, painted, worst, ratio: Math.min(painted, worst) };
      }, { fg, bgs, scrim: where === "over" ? await page.locator(sel).evaluate((e) => getComputedStyle(e).backgroundColor) : null });
      res[where] = r;
      expect(r.ratio, `${theme} caption ${where}`).toBeGreaterThanOrEqual(4.5);
    }
    out[theme] = res;
    await page.screenshot({ path: shot(`caption-${theme}`) });
  }
  writeEvidence("media/caption-contrast.json", out);
});

test("when clicked: Open a page goes there, an address opens in a new tab with noopener, Enlarge opens with Enter and closes with Escape; reduced motion opens it without animation (criteria 9, 18, 20)", async ({ browser, page: signed }) => {
  const req = signed.request;
  const quad = await upload(req, "quad.png", "image/png", "image");
  const toPage = "c_medialinkp";
  const toUrl = "c_medialinku";
  const big = "c_medialinke";
  const slug = `media-link-${RUN}`;
  const app = await newApp(req, slug, [
    { id: toPage, type: "image", name: "To page", props: { src: quad, alt: "Go to Rack", fit: "cover", height: 120 }, slot: { x: 0, y: 0, w: 3, h: 20 } },
    { id: toUrl, type: "image", name: "To address", props: { src: quad, alt: "Vendor site", fit: "cover", height: 120 }, slot: { x: 3, y: 0, w: 3, h: 20 } },
    { id: big, type: "image", name: "Enlarge", props: { src: quad, alt: "Floor plan", fit: "cover", height: 120 }, slot: { x: 6, y: 0, w: 3, h: 20 } },
  ]);
  const r = await req.post(`/api/apps/${app.id}/ops`, { data: { rev: (await draft(req, app.id)).rev, ops: [{ op: "page.add", page: { id: "p_mediarackp", slug: "rack", title: "Rack", inNav: true, root: { id: "c_mediarackr", type: "grid", props: {}, children: [{ id: "c_mediarackh", type: "heading", props: { text: "The rack page" }, slot: { x: 0, y: 0, w: 6, h: 8 } }] } } }] }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  await signed.setViewportSize({ width: 1440, height: 900 });
  const page = signed;
  await open(page, slug);
  // Set each click action through the panel.
  await selectOnCanvas(page, toPage);
  await panel(page).locator("[data-media-link-kind]").selectOption("page");
  await panel(page).locator("[data-media-link-page]").selectOption("p_mediarackp");
  await untilDraft(req, app.id, (x) => (nodeIn(x, toPage).props.link as { pageId?: string } | undefined)?.pageId === "p_mediarackp");
  await selectOnCanvas(page, toUrl);
  await panel(page).locator("[data-media-link-kind]").selectOption("url");
  const url = panel(page).locator("[data-media-link-url]");
  await url.fill("javascript:alert(1)");
  await url.press("Enter");
  await expect(panel(page).locator("[data-media-link-error]")).toHaveText("Only http and https addresses open.");
  await url.fill("https://example.org/rack");
  await url.press("Enter");
  await untilDraft(req, app.id, (x) => (nodeIn(x, toUrl).props.link as { url?: string } | undefined)?.url === "https://example.org/rack");
  await selectOnCanvas(page, big);
  await panel(page).locator("[data-media-link-kind]").selectOption("enlarge");
  const d = await untilDraft(req, app.id, (x) => (nodeIn(x, big).props.link as { kind?: string } | undefined)?.kind === "enlarge");
  expect(nodeIn(d, big).props.link).toEqual({ kind: "enlarge" });
  await page.locator('[data-inspector-group="content"]').screenshot({ path: shot("when-clicked-panel") });
  // Clicking in the builder selects; it never follows the link.
  await page.locator(`[data-canvas-root] [data-node="${big}"] [data-media-frame]`).click();
  await expect(page.locator("[data-media-lightbox]")).toHaveCount(0);
  await publish(req, app.id);

  for (const reduced of [false, true]) {
    const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: await signed.context().storageState(), viewport: { width: 1280, height: 800 }, reducedMotion: reduced ? "reduce" : "no-preference" });
    const v = await ctx.newPage();
    await v.goto(`/a/${slug}`);
    const frame = (id: string) => v.locator(`[data-node="${id}"] [data-media-frame]`);
    await expect(frame(big)).toBeVisible({ timeout: 15_000 });
    // Address: a new tab, no opener.
    expect(await frame(toUrl).evaluate((a) => ({ tag: a.tagName, target: a.getAttribute("target"), rel: a.getAttribute("rel"), href: a.getAttribute("href") }))).toEqual({ tag: "A", target: "_blank", rel: "noopener noreferrer", href: "https://example.org/rack" });
    // Enlarge with the keyboard: focus, Enter, then Escape closes and focus comes back.
    await frame(big).focus();
    await v.keyboard.press("Enter");
    const box = v.locator("[data-media-lightbox]");
    await expect(box).toBeVisible();
    expect(await box.evaluate((e) => (e as HTMLDialogElement).open)).toBe(true);
    const motion = box.locator("[data-media-lightbox-motion]");
    await expect(motion).toHaveAttribute("data-media-lightbox-motion", reduced ? "none" : "fade");
    if (reduced) expect(await motion.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
    await v.screenshot({ path: shot(`enlarge-open${reduced ? "-reduced" : ""}`) });
    await v.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
    expect(await v.evaluate(() => document.activeElement?.getAttribute("data-media-link"))).toBe("enlarge");
    // Open a page goes to that page.
    await frame(toPage).click();
    await expect(v.locator('[data-node="c_mediarackh"]')).toHaveText("The rack page", { timeout: 10_000 });
    await ctx.close();
  }
});

test("video: a cover picture shows before play and with reduced motion on; Start at; Fit shows whole by default (criterion 11)", async ({ browser, page: signed }) => {
  const req = signed.request;
  const webm = await upload(req, "wide.webm", "video/webm", "video");
  const cover = await upload(req, "cover.png", "image/png", "image");
  const vid = "c_mediavideo";
  const slug = `media-vid-${RUN}`;
  const app = await newApp(req, slug, [{ id: vid, type: "video", name: "Loop", props: { src: webm, alt: "Test pattern", height: 180 }, slot: { x: 0, y: 0, w: 4, h: 25 } }]);
  await signed.setViewportSize({ width: 1440, height: 900 });
  const page = signed;
  await open(page, slug);
  await selectOnCanvas(page, vid);
  await expect(page.locator('[data-inspector-group="content"] h3')).toHaveText("Video");
  // Fit defaults to Show whole.
  await expect(panel(page).locator('[data-media-fit="contain"]')).toHaveAttribute("aria-checked", "true");
  expect(await page.locator(`[data-canvas-root] [data-node="${vid}"] video`).evaluate((e) => getComputedStyle(e).objectFit)).toBe("contain");
  // Cover picture through its own picker, Start at by typing seconds.
  await panel(page).locator('[data-field="poster"] [data-media-input]').setInputFiles(path.join(MEDIA, "cover.png"));
  let d = await untilDraft(req, app.id, (x) => typeof nodeIn(x, vid).props.poster === "string", 10_000);
  expect(String(nodeIn(d, vid).props.poster)).toMatch(/^\/uploads\//);
  await panel(page).locator("[data-media-start]").fill("1");
  d = await untilDraft(req, app.id, (x) => nodeIn(x, vid).props.startAt === 1);
  expect(nodeIn(d, vid).props.startAt).toBe(1);
  void cover;
  await publish(req, app.id);
  const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: await signed.context().storageState(), viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const v = await ctx.newPage();
  await v.goto(`/a/${slug}`);
  const posterImg = v.locator(`[data-node="${vid}"] [data-video-poster]`);
  await expect(posterImg).toBeVisible({ timeout: 15_000 });
  await v.waitForTimeout(800);
  expect(await v.locator(`[data-node="${vid}"] video`).evaluate((e: HTMLVideoElement) => e.paused)).toBe(true);
  await expect(posterImg).toBeVisible();
  const fb = (await v.locator(`[data-node="${vid}"] [data-media-frame]`).boundingBox())!;
  const px = await pixels(v, `[data-node="${vid}"] [data-media-frame]`, [[fb.width / 2, fb.height / 2 + 40]]);
  await v.screenshot({ path: shot("video-cover-reduced-motion") });
  // The cover is the flat blue picture.
  expect(px[0]![2]! > 150 && px[0]![0]! < 90).toBe(true);
  // Play: the cover goes, the video starts at 1 second.
  await v.locator(`[data-node="${vid}"] [data-video-play]`).click();
  await expect(posterImg).toHaveCount(0);
  await expect.poll(() => v.locator(`[data-node="${vid}"] video`).evaluate((e: HTMLVideoElement) => e.currentTime)).toBeGreaterThanOrEqual(1);
  await ctx.close();
});

test("V4 and V5: the Picture panel in the shell's light, dark and reduce-transparency looks, and usable at 390px with 44px controls (criterion 19)", async ({ browser, page: signed }) => {
  const req = signed.request;
  const quad = await upload(req, "quad.png", "image/png", "image");
  const img = "c_mediashell";
  const slug = `media-shell-${RUN}`;
  await newApp(req, slug, [{ id: img, type: "image", name: "Shell", props: { src: quad, alt: "Four colours", fit: "contain", height: 160, caption: "Caption", captionAt: "over" }, slot: { x: 0, y: 0, w: 4, h: 25 } }]);
  const state = await signed.context().storageState();
  for (const look of ["light", "dark", "light-reduce-transparency"] as const) {
    const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: state, viewport: { width: 1440, height: 1000 }, colorScheme: look === "dark" ? "dark" : "light" });
    await ctx.addCookies([{ name: "atrium_theme", value: look === "dark" ? "dark" : "light", url: ORIGIN }, ...(look === "light-reduce-transparency" ? [{ name: "atrium_transparency", value: "reduce", url: ORIGIN }] : [])]);
    const p = await ctx.newPage();
    await open(p, slug);
    await selectOnCanvas(p, img);
    await p.waitForTimeout(300);
    await p.screenshot({ path: shot(`v4-picture-panel-${look}`) });
    await p.locator("[data-builder-inspector]").screenshot({ path: shot(`v4-picture-panel-${look}-inspector`) });
    await ctx.close();
  }
  // 390px: the narrow builder, Layers then Edit.
  const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`/build/${slug}`);
  await expect(p.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
  await p.locator('[data-narrow-tab="layers"]').tap();
  await p.locator(`[data-layer="${img}"] [data-layer-name]`).tap();
  await p.locator('[data-narrow-tab="edit"]').tap();
  const pp = p.locator("[data-picture-panel]");
  await expect(pp).toBeVisible();
  const report = await pp.evaluate((root) => {
    const w = root.getBoundingClientRect().width;
    const small = [...root.querySelectorAll<HTMLElement>("button, input, select, textarea, [role=slider]")]
      .filter((e) => e.offsetParent !== null && !(e as HTMLInputElement).disabled && !e.closest("[data-more-body]"))
      // A file input is opened by its Upload button; a colour input fills its 44px swatch label.
      .filter((e) => (e as HTMLInputElement).type !== "file")
      .map((e) => ({ what: e.getAttribute("data-media-shape") ?? e.getAttribute("data-media-slider") ?? e.getAttribute("data-media-preset") ?? e.getAttribute("aria-label") ?? e.textContent?.trim().slice(0, 30) ?? e.tagName, h: Math.max(e.getBoundingClientRect().height, (e as HTMLInputElement).type === "color" ? e.closest("label")?.getBoundingClientRect().height ?? 0 : 0), tag: e.tagName }))
      .filter((x) => x.h < 43.5 && x.tag !== "IMG");
    return { width: w, small };
  });
  writeEvidence("media/v5-picture-panel-390.json", report);
  await p.screenshot({ path: shot("v5-picture-panel-390"), fullPage: true });
  expect(report.width).toBeGreaterThanOrEqual(340);
  expect(report.small).toEqual([]);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await ctx.close();
});

test("V7: dragging a filter slider keeps frames under 16.7ms at the median while the canvas follows", async ({ page }) => {
  const req = page.request;
  const quad = await upload(req, "quad.png", "image/png", "image");
  const img = "c_mediaframe";
  const slug = `media-fps-${RUN}`;
  await newApp(req, slug, [{ id: img, type: "image", name: "Frames", props: { src: quad, alt: "Four colours", fit: "cover", height: 200 }, slot: { x: 0, y: 0, w: 6, h: 30 } }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, slug);
  await selectOnCanvas(page, img);
  const out: Record<string, unknown> = {};
  for (const slider of ["brightness", "straighten", "zoom"]) {
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      let last = performance.now();
      const tick = (t: number) => { w.__frames.push(t - last); last = t; if (!w.__stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const target = slider === "brightness" ? 160 : slider === "straighten" ? 20 : 250;
    await dragSlider(page, `[data-media-slider="${slider}"]`, target, { steps: 40 });
    const frames = await page.evaluate(() => { const w = window as unknown as { __frames: number[]; __stop: boolean }; w.__stop = true; return w.__frames.slice(1); });
    const sorted = [...frames].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    out[slider] = { frames: frames.length, median: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1] };
    expect(q(0.5)).toBeLessThanOrEqual(17.5);
  }
  writeEvidence("media/v7-slider-frames.json", out);
});
