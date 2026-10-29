// Wave 2.10a operator try-out bugs, app-builder half (stages/02-subsystem-spec/output/operator-tryout-spec.md
// section 3 B7, B2 Fit, B1 builder; criteria 1, 2 and 7; architecture A11.2 and A11.7). Every test drives the
// real builder the way the operator did (V11). Evidence: evidence/app-builder/w210a-r1/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { api, contextFor, OWNER, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; slug: string; root: Node }[] } };

const ROUND = process.env.ATRIUM_E2E_W210_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder/w210a-r1", ROUND, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const RUN = Date.now().toString(36).slice(-4);
const LIGHT = SHELL_VARIANTS[0]!;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const enc = (v: number, len: number) => Array.from({ length: len }, (_, i) => B32[Math.floor(v / 32 ** (len - 1 - i)) % 32]).join("");
const RUN_N = parseInt(RUN, 36) % 32 ** 4;
let n = 0;
const cid = () => `c_${enc(RUN_N, 4)}${enc(n++, 6)}`;
const owner = () => api(OWNER);

async function draft(id: string): Promise<Draft> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function ops(id: string, list: unknown[]) {
  const d = await draft(id);
  const r = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
}
async function newApp(slug: string, kids: Node[] = [], themeId?: string): Promise<{ id: string; slug: string; root: string }> {
  const r = await (await owner()).post("/api/apps", { data: { name: `Tryout ${slug}`, slug, template: "blank" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  const root = (await draft(id)).doc.pages[0]!.root.id;
  const list: unknown[] = kids.map((node) => ({ op: "node.add", parentId: root, node }));
  if (themeId) list.push({ op: "theme.set", theme: { themeId } });
  if (list.length) await ops(id, list);
  return { id, slug, root };
}
async function publish(id: string) {
  const c = await owner();
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note: "tryout" } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}

/** A FAKE wallpaper: a smooth 1600x1000 colour wash as a PNG, made here (no grid or texture of its own). */
function fakeWallpaper(): Buffer {
  const w = 1600, h = 1000;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const i = o + 1 + x * 3;
      raw[i] = Math.round(40 + 150 * (x / w));
      raw[i + 1] = Math.round(90 + 80 * (y / h));
      raw[i + 2] = Math.round(200 - 120 * (x / w) * (y / h));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The operator's own theme (V4 frosted custom theme): an image wallpaper from a FAKE test image, surface
 * glass at 0.3 opacity with a 1 px blur, a soft shadow and a 1 px border. Made through the real API.
 */
async function frostedTheme(c: APIRequestContext, density: Density = "comfortable"): Promise<string> {
  const up = await c.post("/api/settings/uploads", { multipart: { file: { name: "fake-wallpaper.png", mimeType: "image/png", buffer: fakeWallpaper() }, accept: "image" } });
  expect(up.ok(), await up.text()).toBe(true);
  const src = (await up.json()).path as string;
  const dup = await c.post("/api/settings/themes/control-room/duplicate");
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  const cur = await (await c.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = `Frosted e2e ${RUN} ${density} ${n++}`;
  theme.tokens.space = { ...theme.tokens.space, density };
  theme.tokens.wallpaper = { ...theme.tokens.wallpaper, kind: "image", value: src, blurPx: 0, dim: 0, grain: 0 };
  theme.tokens.surface = { ...theme.tokens.surface, material: "glass", opacity: 0.3, blurPx: 1, shadow: "soft", shadowOffsetPx: 0, border: { ...theme.tokens.surface.border, widthPx: 1 } };
  const put = await c.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}

type Density = "comfortable" | "compact";
const THEMES = ["control-room", "dusk", "solid", "frosted"] as const;
type ThemeName = (typeof THEMES)[number];
/** One of the four V4 test themes as a saved theme at a density (built-ins are copied to set it). */
async function testTheme(c: APIRequestContext, name: ThemeName, density: Density): Promise<string> {
  if (name === "frosted") return frostedTheme(c, density);
  if (density === "comfortable") return name;
  const dup = await c.post(`/api/settings/themes/${name}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  const cur = await (await c.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = `${name} compact e2e ${RUN} ${n++}`;
  theme.tokens.space = { ...theme.tokens.space, density };
  const put = await c.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}

/** Elements under `sel` (and itself) that show a scrollbar: an auto box that overflows, or a scroll box. */
async function scrollbarsIn(page: Page, sel: string) {
  return page.evaluate((sel) => {
    const out: { el: string; sh: number; ch: number; sw: number; cw: number; oy: string; ox: string }[] = [];
    for (const top of Array.from(document.querySelectorAll(sel))) {
      for (const e of [top, ...Array.from(top.querySelectorAll("*"))] as HTMLElement[]) {
        const cs = getComputedStyle(e);
        const y = (cs.overflowY === "auto" && e.scrollHeight > e.clientHeight) || cs.overflowY === "scroll";
        const x = (cs.overflowX === "auto" && e.scrollWidth > e.clientWidth) || cs.overflowX === "scroll";
        if (y || x) out.push({ el: `${e.tagName}.${String(e.className).slice(0, 40)}${e.getAttribute("data-slot") ? `[slot=${e.getAttribute("data-slot")}]` : ""}`, sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, oy: cs.overflowY, ox: cs.overflowX });
      }
    }
    return out;
  }, sel);
}
/** The root part of a node: its scroll and client heights. */
async function rootFit(page: Page, scope: string, id: string) {
  return page.evaluate(({ scope, id }) => {
    const el = document.querySelector(`${scope} [data-node="${id}"]`) as HTMLElement | null;
    const root = (el?.querySelector(':scope > [data-slot="root"]') as HTMLElement | null) ?? el;
    return root ? { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, rect: root.getBoundingClientRect().height } : null;
  }, { scope, id });
}
const nodeIn = (d: Draft, id: string): Node | undefined => {
  const walk = (x: Node): Node | undefined => (x.id === id ? x : (x.children ?? []).map(walk).find(Boolean));
  for (const p of d.doc.pages) { const f = walk(p.root); if (f) return f; }
  return undefined;
};
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function insert(page: Page, type: string) {
  await page.locator('[data-left-tab="insert"]').click();
  const item = page.locator(`[data-insert-item="${type}"]`).first();
  await item.scrollIntoViewIfNeeded();
  await item.click();
}
/** Undo or redo from the page with the keyboard (focus off any field). */
async function key(page: Page, combo: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(combo);
}

async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  // Under 900 px the builder is the reduced edit mode, which has no canvas bar by design (round 2 lead follow-up).
  await expect(page.locator("[data-canvas-bar], [data-builder-narrow]").first()).toBeVisible();
}

/** Every element on the page whose own painted background is a repeating line pattern, and visible. */
async function gridPainters(page: Page) {
  return page.evaluate(() => {
    const found: { tag: string; attrs: string; bg: string; size: string; opacity: string; coveredBy: string | null }[] = [];
    for (const el of Array.from(document.querySelectorAll("*")) as HTMLElement[]) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      if (!bg || bg === "none" || !/linear-gradient/.test(bg)) continue;
      if (!/1px, (rgba\(0, 0, 0, 0\)|transparent) 1px/.test(bg) && !/repeating-linear-gradient/.test(bg)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Hidden only when an opaque layer inside it covers its whole box (a cover at full opacity).
      let coveredBy: string | null = null;
      for (const k of Array.from(el.querySelectorAll("*")) as HTMLElement[]) {
        const kr = k.getBoundingClientRect();
        if (kr.left > r.left + 1 || kr.top > r.top + 1 || kr.right < r.right - 1 || kr.bottom < r.bottom - 1) continue;
        const kc = getComputedStyle(k);
        let op = 1;
        for (let e: Element | null = k; e && e !== el; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        const m = /rgba?\(([^)]+)\)/.exec(kc.backgroundColor);
        const alpha = m ? Number(m[1]!.split(",")[3] ?? 1) : 0;
        if (op >= 0.99 && alpha >= 0.99) { coveredBy = `${k.tagName}${Array.from(k.attributes).filter((x) => x.name.startsWith("data-")).map((x) => `[${x.name}]`).join("")}`; break; }
      }
      found.push({ tag: el.tagName, attrs: Array.from(el.attributes).filter((a) => a.name.startsWith("data-") || a.name === "class").map((a) => `${a.name}=${a.value.slice(0, 60)}`).join(" "), bg: bg.slice(0, 160), size: cs.backgroundSize, opacity: cs.opacity, coveredBy });
    }
    return found;
  });
}

test("B7 probe: where the grid shows through the frosted theme", async ({ browser }) => {
  const c = await owner();
  const themeId = await frostedTheme(c);
  const kids: Node[] = [
    { id: cid(), type: "stat", name: "CPU", props: { label: "CPU", value: 42, unit: "%" }, slot: { x: 0, y: 0, w: 3, h: 12 } },
    { id: cid(), type: "stat", name: "Memory", props: { label: "Memory", value: 61, unit: "%" }, slot: { x: 3, y: 0, w: 3, h: 12 } },
    { id: cid(), type: "text", name: "Notes", props: { text: "Frosted glass over the wallpaper." }, slot: { x: 6, y: 0, w: 6, h: 12 } },
  ];
  const app = await newApp(`b7-probe-${RUN}`, kids, themeId);
  await publish(app.id);
  const res: Record<string, unknown> = {};
  for (const vp of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
    const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: vp });
    const page = await ctx.newPage();
    await openBuilder(page, app.slug);
    await page.waitForTimeout(800);
    const tag = `${vp.width}`;
    res[`edit-${tag}`] = await gridPainters(page);
    await page.screenshot({ path: out(`b7-probe-edit-${tag}.png`) });
    res[`canvas-${tag}`] = await page.evaluate(() => {
      const cv = document.querySelector("[data-builder-canvas] [data-atrium-canvas]") as HTMLElement | null;
      const sec = document.querySelector("[data-builder-canvas]") as HTMLElement;
      const r = (e: Element | null | undefined) => (e ? e.getBoundingClientRect().toJSON() : null);
      return { section: r(sec), canvas: r(cv) };
    });
    for (const w of ["1920", "1280"]) {
      const b = page.locator("[data-canvas-bar] button", { hasText: new RegExp(`^${w}$`) });
      if (await b.count()) { await b.first().click(); await page.waitForTimeout(500); await page.screenshot({ path: out(`b7-probe-edit-${tag}-preview${w}.png`) }); res[`edit-${tag}-preview${w}`] = await gridPainters(page); }
    }
    await page.goto(`/a/${app.slug}`);
    await page.waitForTimeout(800);
    res[`view-${tag}`] = await gridPainters(page);
    await page.screenshot({ path: out(`b7-probe-view-${tag}.png`) });
    await ctx.close();
  }
  writeFileSync(out("b7-probe.json"), JSON.stringify(res, null, 2));
});

/** Share of pixels that differ (any channel by more than 24) between two PNGs, compared in a browser canvas. */
async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<{ share: number; w: number; h: number }> {
  return page.evaluate(async ({ a, b }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [ia, ib] = await Promise.all([load(`data:image/png;base64,${a}`), load(`data:image/png;base64,${b}`)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const px = (img: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const da = px(ia), db = px(ib);
    let bad = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i]! - db[i]!) > 24 || Math.abs(da[i + 1]! - db[i + 1]!) > 24 || Math.abs(da[i + 2]! - db[i + 2]!) > 24) bad++;
    return { share: bad / (w * h), w, h };
  }, { a: a.toString("base64"), b: b.toString("base64") });
}

// ---------- B7: no grid in the viewer or published app; in edit mode only the column overlay while dragging ----------
test("B7 criterion 7: frosted theme, no grid outside a drag, a faint column overlay during one, edit matches viewer", async ({ browser }) => {
  const c = await owner();
  const themeId = await frostedTheme(c);
  const a = { id: cid(), type: "stat", name: "CPU", props: { label: "CPU", value: 42, unit: "%" }, slot: { x: 0, y: 0, w: 3, h: 22 } };
  // Boxes that hold their content (as an inserted or fitted widget's do), so the viewer draws them the same size.
  const kids: Node[] = [
    a,
    { id: cid(), type: "stat", name: "Memory", props: { label: "Memory", value: 61, unit: "%" }, slot: { x: 3, y: 0, w: 3, h: 22 } },
    { id: cid(), type: "text", name: "Notes", props: { text: "Frosted glass over the wallpaper." }, slot: { x: 6, y: 0, w: 6, h: 22 } },
  ];
  const app = await newApp(`b7-${RUN}`, kids, themeId);
  await publish(app.id);
  const result: Record<string, unknown> = {};
  // Builder at 1920x1080, Fit width: the canvas is 1288 px wide, the viewer is drawn at 1288 to compare.
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.waitForTimeout(600);
  const painters = await gridPainters(page);
  result.editPainters = painters;
  await page.screenshot({ path: out("b7-edit-frosted.png") });
  const visible = painters.filter((p) => p.coveredBy === null && Number(p.opacity) > 0);
  // Outside a drag no element paints a grid anywhere in the builder.
  expect.soft(visible, `grid painted in edit mode outside a drag: ${JSON.stringify(visible)}`).toEqual([]);
  // During a drag the column overlay shows above the wallpaper at no more than 25% of the line colour.
  await page.locator(`[data-canvas-root] [data-node="${a.id}"]`).click();
  const hb = (await page.locator("[data-drag-handle]").boundingBox())!;
  await page.mouse.move(hb.x + 4, hb.y + 4);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(hb.x + 4 + 30 * i, hb.y + 4 + 25 * i);
  const cells = page.locator("[data-grid-cells]");
  await expect(cells).toHaveCount(1);
  const overlay = await cells.evaluate((el) => {
    const inner = el.firstElementChild as HTMLElement;
    let alpha = 1;
    for (let e: Element | null = el; e && !e.matches("[data-builder-canvas]"); e = e.parentElement) alpha *= Number(getComputedStyle(e).opacity);
    const line = getComputedStyle(document.documentElement).getPropertyValue("--line").trim();
    const probe = document.createElement("div");
    probe.style.color = "var(--line)";
    document.body.appendChild(probe);
    const lineRgb = getComputedStyle(probe).color;
    probe.remove();
    const m = /rgba?\(([^)]+)\)/.exec(lineRgb);
    const lineAlpha = m ? Number(m[1]!.split(",")[3] ?? 1) : 1;
    const wallpaper = document.querySelector("[data-builder-canvas] [data-canvas-wallpaper]")!;
    const above = !!(wallpaper.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { bg: getComputedStyle(inner).backgroundImage.slice(0, 200), opacity: alpha, line, lineRgb, lineAlpha, above };
  });
  result.dragOverlay = overlay;
  await page.screenshot({ path: out("b7-drag-overlay-frosted.png") });
  expect.soft(overlay.above).toBe(true);
  expect.soft(overlay.opacity * overlay.lineAlpha).toBeLessThanOrEqual(0.25 * overlay.lineAlpha + 1e-6);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(cells).toHaveCount(0);
  // Undo any move the drop made, so the edit view matches the published one.
  await untilDraft(app.id, () => true, 500);
  await page.reload();
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  const d = await draft(app.id);
  if (nodeIn(d, a.id)!.slot!.x !== 0 || nodeIn(d, a.id)!.slot!.y !== 0) { await ops(app.id, [{ op: "node.move", nodeId: a.id, parentId: app.root, slot: a.slot }]); await publish(app.id); await page.reload(); await page.waitForTimeout(800); }
  await page.mouse.move(5, 1075);
  const editCanvas = page.locator("[data-builder-canvas] [data-atrium-canvas]");
  const editBox = (await editCanvas.boundingBox())!;
  const editPng = await page.screenshot({ clip: { x: editBox.x, y: editBox.y, width: editBox.width, height: Math.min(editBox.height, 1080 - editBox.y) } });
  writeFileSync(out("b7-edit-canvas.png"), editPng);
  // The published app, for its owner and as a viewer would load it, at the canvas's width.
  const vctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: Math.round(editBox.width), height: 1080 } });
  const view = await vctx.newPage();
  await view.goto(`/a/${app.slug}`);
  await expect(view.locator("[data-atrium-canvas]").first()).toBeVisible({ timeout: 15_000 });
  await view.waitForTimeout(800);
  result.viewPainters = await gridPainters(view);
  expect.soft(result.viewPainters, "the viewer draws no grid").toEqual([]);
  const viewCanvas = view.locator("[data-atrium-canvas]").first();
  const viewBox = (await viewCanvas.boundingBox())!;
  const shift = { x: 0, y: 0 };
  const h = Math.min(editBox.height, 1080 - editBox.y, viewBox.height, 1080 - viewBox.y);
  const viewPng = await view.screenshot({ clip: { x: viewBox.x + shift.x, y: viewBox.y + shift.y, width: Math.min(viewBox.width, editBox.width), height: h } });
  writeFileSync(out("b7-view-canvas.png"), viewPng);
  const editCrop = await page.screenshot({ clip: { x: editBox.x, y: editBox.y, width: Math.min(viewBox.width, editBox.width), height: h } });
  const diff = await pixelDiff(view, editCrop, viewPng);
  result.compare = { editBox, viewBox, diff };
  writeFileSync(out("b7.json"), JSON.stringify(result, null, 2));
  expect.soft(diff.share, "edit canvas matches the viewer within 1%").toBeLessThanOrEqual(0.01);
  await view.screenshot({ path: out("b7-view-frosted.png") });
  await vctx.close();
  await ctx.close();
});

// ---------- B2: Fit makes the box exactly hold the content ----------
test("B2 criterion 2: a resource bar with Fit pressed has scrollHeight equal to clientHeight and no scrollbar, four themes, both densities, 390 px", async ({ browser }) => {
  test.setTimeout(900_000);
  const c = await owner();
  const rows: Record<string, unknown>[] = [];
  for (const theme of THEMES) {
    for (const density of ["comfortable", "compact"] as Density[]) {
      const themeId = await testTheme(c, theme, density);
      const app = await newApp(`b2-${theme}-${density.slice(0, 4)}-${RUN}`, [], themeId);
      const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
      const page = await ctx.newPage();
      await openBuilder(page, app.slug);
      await insert(page, "resource-bar");
      await page.locator('[data-machine-pick="host"]').click();
      await expect(page.locator("[data-machine-chooser]")).toHaveCount(0);
      const d = await untilDraft(app.id, (x) => (x.doc.pages[0]!.root.children ?? []).some((k) => k.type === "resource-bar" && Array.isArray(k.props.items) && (k.props.items as unknown[]).length > 0));
      const bar = (d.doc.pages[0]!.root.children ?? []).find((k) => k.type === "resource-bar")!;
      const node = page.locator(`[data-canvas-root] [data-node="${bar.id}"]`);
      await expect(node).toBeVisible();
      await page.waitForTimeout(1500); // live readings arrive
      const before = await rootFit(page, "[data-canvas-root]", bar.id);
      await node.click();
      const fitTag = page.locator("[data-fit-selected]");
      const pressed = (await fitTag.count()) ? "canvas" : "inspector";
      if (pressed === "canvas") await fitTag.click();
      else {
        // Auto-grow already fitted it on insert (B1), so the canvas has no Fit tag: the inspector's Fit still works.
        const fitBtn = page.locator("[data-layout-fit]");
        if (!(await fitBtn.isVisible())) await page.locator("details:has([data-layout-fit]) > summary").first().click();
        await fitBtn.click();
      }
      await page.waitForTimeout(700);
      const after = await rootFit(page, "[data-canvas-root]", bar.id);
      const bars = await scrollbarsIn(page, `[data-canvas-root] [data-node="${bar.id}"]`);
      await page.screenshot({ path: out(`b2-${theme}-${density}.png`) });
      const fitted = await untilDraft(app.id, () => true, 500);
      rows.push({ theme, density, pressed, before, after, scrollbars: bars, slot: nodeIn(fitted, bar.id)?.slot });
      // The phone viewer of the published app.
      await page.waitForTimeout(400);
      await publish(app.id);
      const pctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 390, height: 844 }, mobile: true });
      const phone = await pctx.newPage();
      await phone.goto(`/a/${app.slug}`);
      await expect(phone.locator(`[data-node="${bar.id}"]`)).toBeVisible({ timeout: 15_000 });
      await phone.waitForTimeout(1200);
      const phoneFit = await rootFit(phone, "[data-atrium-canvas]", bar.id);
      const phoneBars = await scrollbarsIn(phone, `[data-node="${bar.id}"]`);
      await phone.screenshot({ path: out(`b2-${theme}-${density}-390.png`) });
      rows.push({ theme, density, at: 390, phoneFit, phoneBars });
      await pctx.close();
      await ctx.close();
    }
  }
  writeFileSync(out("b2.json"), JSON.stringify(rows, null, 2));
  for (const r of rows) {
    if (r.at === 390) {
      const f = r.phoneFit as { scrollHeight: number; clientHeight: number };
      expect(f.scrollHeight, `390 ${r.theme} ${r.density}`).toBe(f.clientHeight);
      expect(r.phoneBars, `390 ${r.theme} ${r.density} scrollbars`).toEqual([]);
    } else {
      const f = r.after as { scrollHeight: number; clientHeight: number };
      expect(f.scrollHeight, `${r.theme} ${r.density}: scrollHeight equals clientHeight after Fit`).toBe(f.clientHeight);
      expect(r.scrollbars, `${r.theme} ${r.density}: no scrollbar after Fit`).toEqual([]);
    }
  }
});

// ---------- B1 (builder half): a fit group grows its slot to its children, one history entry ----------
test("B1 criterion 1: a group of service tiles grows to show every row (8 at 4 columns in full); insert and grow undo as one step", async ({ browser }) => {
  const c = await owner();
  const themeId = await frostedTheme(c);
  const app = await newApp(`b1-${RUN}`, [], themeId);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await insert(page, "group");
  const d = await untilDraft(app.id, (x) => (x.doc.pages[0]!.root.children ?? []).some((k) => k.type === "group"));
  const group = (d.doc.pages[0]!.root.children ?? []).find((k) => k.type === "group")!;
  const steps: Record<string, unknown>[] = [{ step: "group inserted", slot: group.slot }];
  const groupH = async () => nodeIn(await untilDraft(app.id, () => true, 300), group.id)!.slot!.h;
  const tileCount = async () => (nodeIn(await draft(app.id), group.id)!.children ?? []).length;
  /** Where every tile sits against the group's visible box, and its scroll sizes. */
  const geometry = () => page.evaluate((gid) => {
    const g = document.querySelector(`[data-canvas-root] [data-node="${gid}"]`) as HTMLElement;
    const root = (g.querySelector(':scope > [data-slot="root"]') as HTMLElement) ?? g;
    const r = root.getBoundingClientRect();
    const tiles = Array.from(g.querySelectorAll('[data-node][data-type="service-tile"]')).map((t) => t.getBoundingClientRect().toJSON());
    return { root: r.toJSON(), scroll: [root.scrollHeight, root.clientHeight], tiles };
  }, group.id);
  const allInside = (geo: Awaited<ReturnType<typeof geometry>>) => geo.tiles.every((t) => t.top >= geo.root.top - 0.5 && t.bottom <= geo.root.bottom + 0.5);
  let grewAt = 0;
  let prevH = group.slot!.h;
  // Link tiles are about 62 px tall: two rows fit the group's 208 px insert box, the third row does not.
  for (let i = 1; i <= 12; i++) {
    // Insert with the group (or its last tile) selected: the tile goes into the group.
    await page.locator('[data-left-tab="layers"]').click();
    const last = i === 1 ? group.id : nodeIn(await draft(app.id), group.id)!.children!.at(-1)!.id;
    await page.locator(`[data-layer="${last}"]`).first().click();
    await insert(page, "service-tile");
    await page.locator("[data-service-link-name]").fill(`Service ${i}`);
    await page.locator("[data-service-link-href]").fill(`http://127.0.0.1:${9 + i}`);
    await page.locator("[data-service-link-use]").click();
    await expect(page.locator("[data-service-chooser]")).toHaveCount(0);
    await expect.poll(tileCount, { timeout: 8000 }).toBe(i);
    await page.waitForTimeout(1500);
    const h = await groupH();
    const geo = await geometry();
    steps.push({ step: `tile ${i}`, h, inside: allInside(geo), scroll: geo.scroll });
    writeFileSync(out("b1.json"), JSON.stringify(steps, null, 2));
    expect(allInside(geo), `tile ${i}: every tile inside the group's box`).toBe(true);
    if (i === 8) {
      // Criterion 1: 8 tiles at 4 columns, both rows in full, no scrollbar anywhere in the group.
      expect(geo.tiles.length).toBe(8);
      expect(new Set(geo.tiles.map((t) => Math.round(t.top))).size).toBe(2);
      expect(await scrollbarsIn(page, `[data-canvas-root] [data-node="${group.id}"]`)).toEqual([]);
      await page.mouse.move(5, 795);
      await page.screenshot({ path: out("b1-builder-group-8.png") });
    }
    if (h > prevH && !grewAt) {
      grewAt = i;
      // One undo removes the tile and puts the group's height back; one redo brings both back.
      await key(page, "Control+z");
      await expect.poll(tileCount, { timeout: 8000 }).toBe(i - 1);
      await expect.poll(groupH, { timeout: 8000 }).toBe(prevH);
      await key(page, "Control+Shift+z");
      await expect.poll(tileCount, { timeout: 8000 }).toBe(i);
      await expect.poll(groupH, { timeout: 8000 }).toBe(h);
      steps.push({ step: `undo and redo at tile ${i}`, from: prevH, to: h });
    }
    prevH = h;
  }
  writeFileSync(out("b1.json"), JSON.stringify(steps, null, 2));
  expect(grewAt, "the group grew when a row of tiles no longer fitted").toBeGreaterThan(0);
  await page.mouse.move(5, 795);
  await page.screenshot({ path: out("b1-builder-group-12.png") });
  expect(await scrollbarsIn(page, `[data-canvas-root] [data-node="${group.id}"]`)).toEqual([]);
  // The published viewer shows every row with no scrollbar.
  await page.waitForTimeout(400);
  await publish(app.id);
  const view = await ctx.newPage();
  await view.goto(`/a/${app.slug}`);
  await expect(view.locator(`[data-node="${group.id}"]`)).toBeVisible({ timeout: 15_000 });
  await view.waitForTimeout(800);
  expect(await scrollbarsIn(view, `[data-node="${group.id}"]`)).toEqual([]);
  await view.screenshot({ path: out("b1-viewer-group-12.png") });
  await ctx.close();
});

// ---------- B7 in every test theme (V4), at 390 px (V5) and with reduced motion (V8) ----------
test("B7 V4 V5 V8: no grid in the builder or viewer in all four themes, at 390 px and with reduced motion", async ({ browser }) => {
  const c = await owner();
  const rows: Record<string, unknown>[] = [];
  for (const theme of THEMES) {
    const themeId = theme === "frosted" ? await frostedTheme(c) : theme;
    const kids: Node[] = [
      { id: cid(), type: "stat", name: "CPU", props: { label: "CPU", value: 42, unit: "%" }, slot: { x: 0, y: 0, w: 4, h: 22 } },
      { id: cid(), type: "text", name: "Notes", props: { text: "No grid on this page." }, slot: { x: 4, y: 0, w: 8, h: 22 } },
    ];
    const app = await newApp(`b7v-${theme.slice(0, 5)}-${RUN}`, kids, themeId);
    await publish(app.id);
    for (const mode of [{ tag: "1280", viewport: { width: 1280, height: 800 } }, { tag: "390-reduced", viewport: { width: 390, height: 844 }, mobile: true, reducedMotion: "reduce" as const }]) {
      const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: mode.viewport, ...(mode.mobile ? { mobile: true } : {}), ...(mode.reducedMotion ? { reducedMotion: mode.reducedMotion } : {}) });
      const page = await ctx.newPage();
      await openBuilder(page, app.slug);
      await page.waitForTimeout(600);
      const edit = (await gridPainters(page)).filter((p) => p.coveredBy === null && Number(p.opacity) > 0);
      await page.screenshot({ path: out(`b7-${theme}-builder-${mode.tag}.png`) });
      await page.goto(`/a/${app.slug}`);
      await expect(page.locator("[data-atrium-canvas]").first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(600);
      const view = await gridPainters(page);
      await page.screenshot({ path: out(`b7-${theme}-viewer-${mode.tag}.png`) });
      rows.push({ theme, mode: mode.tag, edit, view });
      await ctx.close();
    }
  }
  writeFileSync(out("b7-themes.json"), JSON.stringify(rows, null, 2));
  for (const r of rows) {
    expect.soft(r.edit, `${r.theme} ${r.mode} builder`).toEqual([]);
    expect.soft(r.view, `${r.theme} ${r.mode} viewer`).toEqual([]);
  }
});
