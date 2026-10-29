// Wave 2.10a components (operator try-out spec, B1, the CSS half of B2, B8; architecture A11.2 sizing),
// through the real builder screen and the published viewer (V11). Each test was recorded failing on the
// main build first (evidence/components/w210a-r1/failing-first/). Themes (V4): Control Room, Dusk, Solid
// and a frosted custom theme made here through the real API (a FAKE image wallpaper, glass surfaces at
// 0.3 opacity, 1px blur, soft shadow, 1px border), as on the operator's own dashboard. Served by
// tests/e2e/components/serve.sh (port 3114). Test-only values; none are real credentials.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { signIn } from "./helpers";

test.describe.configure({ timeout: 300_000 });
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
const EV = path.resolve(here, `../../../evidence/components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "w210a-r1"}`);
const file = (name: string) => {
  const p = path.join(EV, name);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
};
const shot = (name: string) => file(`${name}.png`);
const writeEv = (name: string, data: unknown) => writeFileSync(file(name), JSON.stringify(data, null, 2));

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: Slot; children?: Node[]; name?: string };
type Draft = { rev: number; doc: { pages: { id: string; slug: string; root: Node }[] } };

async function draft(req: APIRequestContext, id: string): Promise<Draft> {
  return (await req.get(`/api/apps/${id}/draft`)).json();
}
async function ops(req: APIRequestContext, id: string, list: unknown[]) {
  const d = await draft(req, id);
  const r = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function newApp(req: APIRequestContext, slug: string, kids: Node[] = []): Promise<{ id: string; rootId: string }> {
  const r = await req.post("/api/apps", { data: { name: `Bugs ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await draft(req, id);
  const rootId = d.doc.pages[0]!.root.id;
  if (kids.length) await ops(req, id, kids.map((n) => ({ op: "node.add", parentId: rootId, node: n })));
  return { id, rootId };
}
async function publish(req: APIRequestContext, appId: string) {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note: "w210a" }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function untilDraft(req: APIRequestContext, id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(req, id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)];
const nodes = (d: Draft) => all(d.doc.pages[0]!.root);
async function open(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
}
async function select(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${id}"]`).click();
  await expect(page.locator(`[data-inspector][data-node-id="${id}"]`)).toBeVisible();
}
const canvas = (page: Page, id: string) => page.locator(`[data-canvas-root] [data-node="${id}"]`).first();
/** Closes a builder sheet (the data picker, the service chooser) that opened on its own, with Escape. */
async function closeSheets(page: Page) {
  const sheet = page.locator('[role="dialog"]');
  if (await sheet.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
}
/** Inserts through the Insert tab, the way the operator does; returns the new node's id. */
async function insert(page: Page, req: APIRequestContext, appId: string, type: string): Promise<string> {
  const before = new Set(nodes(await draft(req, appId)).map((n) => n.id));
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator(`[data-insert-item="${type}"]`).first().click();
  await closeSheets(page);
  const d = await untilDraft(req, appId, (x) => nodes(x).some((n) => !before.has(n.id) && n.type === type));
  const node = nodes(d).find((n) => !before.has(n.id) && n.type === type);
  expect(node, `${type} was inserted`).toBeTruthy();
  return node!.id;
}

// ---------- the frosted custom theme (V4: the operator's own theme) ----------
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixtures edit a theme document loosely
type Doc = Record<string, any>;
let frostedId = "";
/** Makes (once per run) the frosted custom theme through the real settings API, from a FAKE picture. */
async function frosted(req: APIRequestContext): Promise<string> {
  if (frostedId) return frostedId;
  const wall = png(64, 40, (x, y) => [40 + x * 3, 60 + y * 4, 140 + ((x + y) % 7) * 10]);
  const up = await req.post("/api/settings/uploads", { multipart: { accept: "image", file: { name: "fake-e2e-wallpaper.png", mimeType: "image/png", buffer: wall } }, headers: H });
  expect(up.status(), await up.text()).toBe(201);
  const wallPath = (await up.json()).path as string;
  const dup = await req.post("/api/settings/themes/control-room/duplicate", { headers: H });
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  const cur = await (await req.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme) as Doc;
  theme.name = `Frosted e2e ${RUN}`;
  theme.tokens.wallpaper = { ...theme.tokens.wallpaper, kind: "image", value: wallPath, blurPx: 0, dim: 0 };
  theme.tokens.surface = { ...theme.tokens.surface, material: "glass", opacity: 0.3, blurPx: 1, shadow: "soft", border: { ...theme.tokens.surface.border, widthPx: 1 } };
  const put = await req.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev }, headers: H });
  expect(put.status(), await put.text()).toBe(200);
  frostedId = id;
  return id;
}
async function themeIds(req: APIRequestContext): Promise<{ name: string; id: string }[]> {
  return [{ name: "control-room", id: "control-room" }, { name: "dusk", id: "dusk" }, { name: "solid", id: "solid" }, { name: "frosted", id: await frosted(req) }];
}
/** Puts the app on a theme, with the density changed through a theme copy when asked (compact). */
async function setTheme(req: APIRequestContext, appId: string, themeId: string, density: "comfortable" | "compact" = "comfortable") {
  let id = themeId;
  if (density === "compact") {
    const dup = await req.post(`/api/settings/themes/${themeId}/duplicate`, { headers: H });
    expect(dup.status(), await dup.text()).toBeLessThan(300);
    id = (await dup.json()).id as string;
    const cur = await (await req.get(`/api/settings/themes/${id}`)).json();
    const theme = structuredClone(cur.theme) as Doc;
    theme.name = `${theme.name} compact ${RUN}`;
    theme.tokens.space = { ...theme.tokens.space, density: "compact" };
    const put = await req.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev }, headers: H });
    expect(put.status(), await put.text()).toBe(200);
  }
  await ops(req, appId, [{ op: "theme.set", theme: { themeId: id } }]);
}

// ---------- what the screen shows ----------
/** Every element under `scope` that shows a scrollbar or scrolls its own content (any axis). */
async function scrollers(scope: Locator): Promise<{ what: string; node: string | null; overY: string; sh: number; ch: number; bar: number }[]> {
  return scope.evaluate((root) => {
    const out: { what: string; node: string | null; overY: string; sh: number; ch: number; bar: number }[] = [];
    for (const e of [root, ...root.querySelectorAll("*")] as HTMLElement[]) {
      const cs = getComputedStyle(e);
      const scrollY = cs.overflowY === "auto" || cs.overflowY === "scroll";
      const scrollX = cs.overflowX === "auto" || cs.overflowX === "scroll";
      const bar = e.offsetWidth - e.clientWidth - (parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth));
      const overflowsY = scrollY && e.scrollHeight - e.clientHeight > 0;
      const overflowsX = scrollX && e.scrollWidth - e.clientWidth > 0;
      if (overflowsY || overflowsX || (bar > 0.5 && (scrollY || scrollX))) out.push({ what: `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}`, node: e.closest("[data-node]")?.getAttribute("data-node") ?? null, overY: cs.overflowY, sh: e.scrollHeight, ch: e.clientHeight, bar });
    }
    return out;
  });
}
/**
 * The part of an element the viewer can see: its box cut by every clipping ancestor (overflow other
 * than visible clips at the padding box, `overflow: clip` at the padding box plus its clip margin).
 * Returns the element's own rect and the visible rect, both in page pixels.
 */
async function visible(el: Locator, pad = 0): Promise<{ box: { top: number; bottom: number; left: number; right: number }; seen: { top: number; bottom: number; left: number; right: number }; clips: string[] }> {
  return el.evaluate((e, pad) => {
    const r0 = e.getBoundingClientRect();
    const box = { top: r0.top - pad, bottom: r0.bottom + pad, left: r0.left - pad, right: r0.right + pad };
    const seen = { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    const clips: string[] = [];
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const r = a.getBoundingClientRect();
      const m = cs.overflowX === "clip" || cs.overflowY === "clip" ? parseFloat(cs.overflowClipMargin || "0") || 0 : 0;
      clips.push(`${a.tagName.toLowerCase()}.${String(a.className).split(" ")[0]} ${cs.overflowX}/${cs.overflowY} margin=${cs.overflowClipMargin} top=${Math.round(r.top)}`);
      const bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth), br = parseFloat(cs.borderRightWidth), bb = parseFloat(cs.borderBottomWidth);
      if (cs.overflowY !== "visible") {
        seen.top = Math.max(seen.top, r.top + bt - m);
        seen.bottom = Math.min(seen.bottom, r.bottom - bb + m);
      }
      if (cs.overflowX !== "visible") {
        seen.left = Math.max(seen.left, r.left + bl - m);
        seen.right = Math.min(seen.right, r.right - br + m);
      }
    }
    return { box, seen, clips };
  }, pad);
}
const fullySeen = (v: { box: { top: number; bottom: number; left: number; right: number }; seen: { top: number; bottom: number; left: number; right: number } }, slack = 0.5) =>
  v.seen.top <= v.box.top + slack && v.seen.bottom >= v.box.bottom - slack && v.seen.left <= v.box.left + slack && v.seen.right >= v.box.right - slack;

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project; the phone width is set per test");
  await signIn(context, page.request);
  await page.context().addCookies([{ name: "atrium_swept", value: "1", url: ORIGIN }]);
});

// ---------- B8: an icon hugs on insert and scales with its box ----------
test("B8: an inserted icon's box hugs it (at most 2 columns, square within 8px) and resizing to twice the width doubles the icon", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210-icon-${RUN}`;
  const app = await newApp(page.request, slug);
  await open(page, slug);
  const id = await insert(page, page.request, app.id, "icon");
  const box = canvas(page, id);
  await expect(box).toBeVisible();
  await page.waitForTimeout(300);
  const geo = async () => {
    const b = (await box.boundingBox())!;
    const svg = (await box.locator("svg").first().boundingBox())!;
    const grid = await page.locator("[data-canvas-root] .atr-grid").first().evaluate((g) => {
      const cs = getComputedStyle(g);
      const cols = cs.gridTemplateColumns.split(" ").map(parseFloat);
      return { col: cols[0]!, gap: parseFloat(cs.columnGap) || 0 };
    });
    return { box: { w: b.width, h: b.height }, icon: { w: svg.width, h: svg.height }, grid, slot: nodes(await draft(page.request, app.id)).find((n) => n.id === id)?.slot };
  };
  const first = await geo();
  await page.screenshot({ path: shot("b8-icon-inserted") });
  const colStep = first.grid.col + first.grid.gap;
  const twoCols = first.grid.col * 2 + first.grid.gap;
  writeEv("b8-icon-inserted.json", { ...first, twoCols });
  expect(first.box.w, `inserted icon box ${first.box.w}px wide, two columns are ${twoCols}px`).toBeLessThanOrEqual(twoCols + 0.5);
  expect(Math.abs(first.box.w - first.box.h), `inserted icon box ${first.box.w} x ${first.box.h}`).toBeLessThanOrEqual(8);
  // Resize from the south-east corner to twice the width and height (the box stays square), as by hand.
  await select(page, id);
  const handle = (await page.locator('[data-resize-handle="se"]').boundingBox())!;
  const sx = handle.x + handle.width / 2, sy = handle.y + handle.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const dx = first.box.w, dy = first.box.h;
  for (let i = 1; i <= 8; i++) await page.mouse.move(sx + (dx * i) / 8, sy + (dy * i) / 8);
  await page.mouse.up();
  await untilDraft(page.request, app.id, (d) => (nodes(d).find((n) => n.id === id)?.slot?.w ?? 0) > (first.slot?.w ?? 0));
  await page.waitForTimeout(400);
  const second = await geo();
  await page.screenshot({ path: shot("b8-icon-resized") });
  writeEv("b8-icon-resized.json", { first, second, colStep });
  const ratioBox = second.box.w / first.box.w;
  const ratioIcon = second.icon.w / first.icon.w;
  // The box grew by about two (grid steps decide the exact width); the icon grows by the same factor.
  expect(ratioBox, `box grew ${ratioBox.toFixed(2)}x`).toBeGreaterThan(1.7);
  expect(Math.abs(ratioIcon - ratioBox), `icon grew ${ratioIcon.toFixed(2)}x while its box grew ${ratioBox.toFixed(2)}x`).toBeLessThanOrEqual(0.15);
  // Published: the icon still fills its box the same way.
  await publish(page.request, app.id);
  await page.goto(`/a/${slug}`);
  const pub = page.locator(`[data-node="${id}"]`).first();
  await expect(pub).toBeVisible({ timeout: 15_000 });
  const pb = (await pub.boundingBox())!, ps = (await pub.locator("svg").first().boundingBox())!;
  writeEv("b8-icon-published.json", { box: pb, icon: ps });
  expect(ps.width).toBeGreaterThan(first.icon.w * 1.7);
});

// ---------- B1: a group of tiles never crops and never scrolls ----------
/** Checks a group on screen: no scrollbar in it, every tile fully seen, and the hover lift and focus ring seen. */
async function groupChecks(page: Page, groupId: string, tileIds: string[], where: string, barsOnly = false) {
  const g = page.locator(`[data-node="${groupId}"]`).first();
  await page.mouse.move(2, 2);
  const bars = await scrollers(g);
  if (barsOnly) {
    const tiles = [] as { id: string; seen: boolean }[];
    for (const id of tileIds) tiles.push({ id, seen: fullySeen(await visible(page.locator(`[data-node="${id}"] .atr-tile`).first())) });
    return { where, bars, tiles };
  }
  const tiles = [] as { id: string; seen: boolean; v: unknown }[];
  for (const id of tileIds) {
    const v = await visible(page.locator(`[data-node="${id}"] .atr-tile`).first());
    tiles.push({ id, seen: fullySeen(v), v });
  }
  // The hover lift of the first tile (top row) and of the last one (bottom row).
  const lifts = [] as { id: string; seen: boolean; v: unknown }[];
  for (const id of [tileIds[0]!, tileIds[tileIds.length - 1]!]) {
    const t = page.locator(`[data-node="${id}"] .atr-tile`).first();
    await t.hover();
    await page.waitForTimeout(250);
    const v = await visible(t);
    lifts.push({ id, seen: fullySeen(v), v });
  }
  // The focus ring (2px outline 2px out) of the first tile, reached by keyboard focus.
  const first = page.locator(`[data-node="${tileIds[0]}"] a.atr-tile`).first();
  await page.mouse.move(2, 2);
  await page.keyboard.press("Tab");
  await first.focus();
  const out = await first.evaluate((e) => {
    const cs = getComputedStyle(e);
    return { width: parseFloat(cs.outlineWidth) || 0, offset: parseFloat(cs.outlineOffset) || 0, style: cs.outlineStyle };
  });
  const ringSeen = await visible(first, out.width + out.offset);
  await first.blur();
  return { where, bars, tiles, lifts, ring: { ok: out.style !== "none" && out.width > 0 && fullySeen(ringSeen), outline: out, ...ringSeen } };
}

test("B1: a group of 8 service tiles at 4 columns shows both rows in full, with no scrollbar, and every tile's top edge, hover lift and focus ring visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210-group-${RUN}`;
  const app = await newApp(page.request, slug);
  await open(page, slug);
  // The operator's way: Insert a group, then Insert service tiles with the group selected.
  const groupId = await insert(page, page.request, app.id, "group");
  await select(page, groupId);
  const tileIds: string[] = [];
  for (let i = 0; i < 8; i++) tileIds.push(await insert(page, page.request, app.id, "service-tile"));
  const d = await draft(page.request, app.id);
  const group = nodes(d).find((n) => n.id === groupId)!;
  expect(group.children?.map((c) => c.id)).toEqual(tileIds);
  // Each tile gets a name and an address so it is a link with its hover lift, as the operator's are.
  await ops(page.request, app.id, tileIds.map((id, i) => ({ op: "node.update", nodeId: id, patch: { props: { ...nodes(d).find((n) => n.id === id)!.props, name: `Service ${i + 1}`, description: "FAKE e2e service", href: `https://s${i + 1}.example.test/`, stats: [{ label: "CPU", value: 12 + i, format: "percent" }, { label: "Running", value: 40 + i }, { label: "Total", value: 45 }] } } })));
  await page.reload();
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
  await expect(canvas(page, tileIds[7]!)).toBeVisible();
  await page.waitForTimeout(500);
  // In the builder (C's half): nothing in the group scrolls, whatever its box. The box itself is grown by
  // the builder (B's half, A11.2), so whether the second row is inside the drawn box is recorded here.
  const inBuilder = await groupChecks(page, groupId, tileIds, "builder", true);
  await page.screenshot({ path: shot("b1-builder") });
  const out: Record<string, unknown> = { builder: inBuilder, slot: nodes(await draft(page.request, app.id)).find((n) => n.id === groupId)?.slot };
  expect(inBuilder.bars, "no scrollbar in the group in the builder").toEqual([]);
  // Published, in the four themes: both rows in full, nothing scrolls, lift and ring inside what is seen.
  for (const t of await themeIds(page.request)) {
    await setTheme(page.request, app.id, t.id);
    await publish(page.request, app.id);
    await page.goto(`/a/${slug}`);
    await expect(page.locator(`[data-node="${tileIds[7]}"]`)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    const r = await groupChecks(page, groupId, tileIds, `viewer ${t.name}`);
    out[t.name] = r;
    await page.screenshot({ path: shot(`b1-viewer-${t.name}`), fullPage: true });
    expect(r.bars, `${t.name}: no scrollbar in the group`).toEqual([]);
    for (const x of r.tiles as { id: string; seen: boolean; v: unknown }[]) expect(x.seen, `${t.name}: tile ${x.id} fully visible ${JSON.stringify(x.v)}`).toBe(true);
    for (const x of r.lifts!) expect(x.seen, `${t.name}: hover lift of ${x.id} visible ${JSON.stringify(x.v)}`).toBe(true);
    expect(r.ring!.ok, `${t.name}: focus ring visible ${JSON.stringify(r.ring)}`).toBe(true);
    // Both rows: four tiles per row, the second row below the first.
    const tops = await Promise.all(tileIds.map(async (id) => Math.round((await page.locator(`[data-node="${id}"]`).first().boundingBox())!.y)));
    expect(new Set(tops).size, `two rows, tops ${tops.join(",")}`).toBe(2);
  }
  writeEv("b1-group.json", out);
});

test("B1 reflow: a group that keeps its height moves tiles into more columns first, then shows +N more, never a scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210-reflow-${RUN}`;
  const tiles: Node[] = Array.from({ length: 10 }, (_, i) => ({ id: `c_rfl${"abcdefghij"[i]}aaaaaa`, type: "service-tile", props: { name: `Service ${i + 1}`, description: "FAKE e2e", href: `https://r${i + 1}.example.test/`, newTab: true, stats: [] } }));
  const app = await newApp(page.request, slug, [{ id: "c_rflgroupaa", type: "group", props: { title: "Kept", columns: 2 }, slot: { x: 0, y: 0, w: 12, h: 16 }, children: tiles }]);
  await open(page, slug);
  await select(page, "c_rflgroupaa");
  // The inspector's own switch: Keep its height.
  const sw = page.locator('[data-inspector] [data-field="fixedHeight"]').first();
  await expect(sw).toBeVisible();
  await sw.locator('button, [role="switch"], input').first().click();
  await untilDraft(page.request, app.id, (d) => nodes(d).find((n) => n.id === "c_rflgroupaa")?.props.fixedHeight === true);
  // Round 2: the builder now fits a too-small box when the app opens (Fix List item 1, app-builder), so
  // the group may have grown to its tiles before the switch was set. The person then drags it short
  // again, which is what Keep its height is for: here the same 16 rows through the draft API.
  const kept = nodes(await draft(page.request, app.id)).find((n) => n.id === "c_rflgroupaa")!;
  if ((kept.slot?.h ?? 16) !== 16) {
    await ops(page.request, app.id, [{ op: "node.update", nodeId: "c_rflgroupaa", patch: { slot: { ...kept.slot!, h: 16 } } }]);
    await page.reload();
    await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
  }
  const g = canvas(page, "c_rflgroupaa");
  await expect(g.locator("[data-group-more]")).toBeVisible({ timeout: 5000 });
  const builder = await g.locator('[data-slot="root"]').first().evaluate((e) => ({ cols: e.getAttribute("data-columns"), chosen: e.getAttribute("data-chosen-columns"), more: e.querySelector("[data-group-more]")?.textContent, shown: e.querySelectorAll("[data-group-item]").length }));
  expect(Number(builder.cols), "more columns than the 2 chosen").toBeGreaterThan(2);
  expect(await scrollers(g)).toEqual([]);
  const moreSeen = await visible(g.locator("[data-group-more]"));
  expect(fullySeen(moreSeen), "+N more line inside the box").toBe(true);
  await page.screenshot({ path: shot("b1-reflow-builder") });
  await publish(page.request, app.id);
  await page.goto(`/a/${slug}`);
  const pg = page.locator('[data-node="c_rflgroupaa"]').first();
  await expect(pg.locator("[data-group-more]")).toBeVisible({ timeout: 15_000 });
  const viewer = await pg.locator('[data-slot="root"]').first().evaluate((e) => ({ cols: e.getAttribute("data-columns"), more: e.querySelector("[data-group-more]")?.textContent, shown: e.querySelectorAll("[data-group-item]").length, h: e.getBoundingClientRect().height }));
  expect(await scrollers(pg)).toEqual([]);
  expect(Number(viewer.shown) + Number(String(viewer.more).replace(/\D/g, ""))).toBe(10);
  await page.screenshot({ path: shot("b1-reflow-viewer"), fullPage: true });
  writeEv("b1-reflow.json", { builder, viewer });
});

// ---------- B2 (CSS half): no component root that is not a scrolling kind scrolls ----------
const SMALL: Node[] = [
  { id: "c_b2barbaaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: 41, percent: 41, format: "percent" }, { icon: "memory", label: "Free", value: 21.4 * 1024 ** 3, format: "bytes", percent: 62 }, { icon: "disk", label: "Free", value: 412 * 1024 ** 3, format: "bytes", percent: 41 }, { icon: "thermometer", label: "Temp", value: 55, format: "celsius" }, { icon: "clock", label: "Up", value: 1234567, format: "seconds" }], clock: true, clockFormat: "date-time", search: true, searchUrl: "https://duckduckgo.com/?q={q}" }, slot: { x: 0, y: 0, w: 6, h: 5 } },
  { id: "c_b2statbaaa", type: "stat", props: { label: "CPU", value: 41.2, unit: "%", decimals: 1 }, slot: { x: 6, y: 0, w: 3, h: 6 } },
  { id: "c_b2textbaaa", type: "text", props: { text: "Line one\nLine two\nLine three\nLine four\nLine five\nLine six" }, slot: { x: 9, y: 0, w: 3, h: 6 } },
  { id: "c_b2tilebaaa", type: "service-tile", props: { name: "FAKE tile", description: "e2e", href: "https://t.example.test/", newTab: true, stats: [{ label: "A", value: 1 }, { label: "B", value: 2 }] }, slot: { x: 0, y: 6, w: 3, h: 6 } },
  { id: "c_b2bookbaaa", type: "bookmarks", props: { items: [{ name: "One", href: "https://one.example.test" }, { name: "Two", href: "https://two.example.test" }, { name: "Three", href: "https://three.example.test" }], columns: 1 }, slot: { x: 3, y: 6, w: 3, h: 6 } },
  { id: "c_b2statsaaa", type: "status", props: { data: { kind: "status", items: [{ label: "NPM", state: "up" }, { label: "Kuma", state: "down" }, { label: "Plex", state: "up" }, { label: "Jelly", state: "warn" }] } }, slot: { x: 6, y: 6, w: 3, h: 6 } },
  { id: "c_b2cardbaaa", type: "card", props: { title: "Card" }, slot: { x: 9, y: 6, w: 3, h: 6 }, children: [{ id: "c_b2cardtxta", type: "text", props: { text: "Inside\na card\nthat is\ntoo small" } }] },
  { id: "c_b2tablebaa", type: "table", props: { maxRows: 20, data: { kind: "table", columns: [{ key: "n", label: "Name", type: "text" }], rows: Array.from({ length: 12 }, (_, i) => ({ n: `row ${i + 1}` })) } }, slot: { x: 0, y: 12, w: 6, h: 12 } },
];
const NOT_SCROLL = SMALL.filter((n) => n.type !== "table").map((n) => n.id);

test("B2: in boxes too small for their content, no component that is not a scrolling kind shows a scrollbar or scrolls, at both densities, in four themes and at 390px; a table still scrolls", async ({ page, browser }) => {
  const slug = `w210-noscroll-${RUN}`;
  const app = await newApp(page.request, slug, SMALL);
  const out: Record<string, unknown> = {};
  for (const t of await themeIds(page.request)) {
    for (const density of ["comfortable", "compact"] as const) {
      await setTheme(page.request, app.id, t.id, density);
      // The builder (exact boxes).
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(page, slug);
      await expect(canvas(page, "c_b2tablebaa")).toBeVisible();
      await page.waitForTimeout(400);
      const b = await scrollers(page.locator("[data-canvas-root]"));
      await page.screenshot({ path: shot(`b2-builder-${t.name}-${density}`) });
      // The published viewer.
      await publish(page.request, app.id);
      await page.goto(`/a/${slug}`);
      await expect(page.locator('[data-node="c_b2tablebaa"]')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(300);
      const v = await scrollers(page.locator(".atr-render-root").first());
      await page.screenshot({ path: shot(`b2-viewer-${t.name}-${density}`), fullPage: true });
      out[`${t.name}-${density}`] = { builder: b, viewer: v };
      for (const [where, list] of [["builder", b], ["viewer", v]] as const) {
        const bad = list.filter((x) => x.node && NOT_SCROLL.some((id) => x.node === id || false));
        expect(bad, `${t.name} ${density} ${where}: no scrollbar outside scrolling kinds`).toEqual([]);
      }
    }
  }
  // The table is a scrolling kind: in its exact box in the builder its rows scroll inside it.
  await setTheme(page.request, app.id, "control-room");
  await open(page, slug);
  const table = await canvas(page, "c_b2tablebaa").locator('[data-slot="root"]').first().evaluate((e) => ({ overY: getComputedStyle(e).overflowY, sh: e.scrollHeight, ch: e.clientHeight }));
  out.table = table;
  expect(table.overY).toBe("auto");
  expect(table.sh).toBeGreaterThan(table.ch);
  // 390px phone: the published app, nothing scrolls sideways and no component scrolls.
  await publish(page.request, app.id);
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await page.context().storageState() });
  await phone.goto(`${ORIGIN}/a/${slug}`);
  await expect(phone.locator('[data-node="c_b2tablebaa"]')).toBeVisible({ timeout: 15_000 });
  const p = await scrollers(phone.locator(".atr-render-root").first());
  const sideways = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await phone.screenshot({ path: shot("b2-phone-390"), fullPage: true });
  out.phone = { scrollers: p, sideways };
  expect(p.filter((x) => x.node && NOT_SCROLL.includes(x.node))).toEqual([]);
  expect(sideways).toBeLessThanOrEqual(0);
  await phone.close();
  writeEv("b2-noscroll.json", out);
});

test("B2 with Fit: a resource bar after Fit (the builder's button) holds its content exactly, with no scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210-fit-${RUN}`;
  const app = await newApp(page.request, slug, [SMALL[0]!]);
  await open(page, slug);
  // Round 2: the builder grows a too-small box when the app opens (Fix List item 1, app-builder), so the
  // bar already fits. Put it back in its drawn 5 rows (that growth is one undo step), so Fit has work to do.
  // A reload would grow it again, so the shrink is the undo itself.
  await untilDraft(page.request, app.id, (d) => (nodes(d).find((n) => n.id === "c_b2barbaaaa")?.slot?.h ?? 5) !== 5, 8000);
  await page.locator("[data-builder-canvas]").focus();
  await page.keyboard.press("Control+z");
  await untilDraft(page.request, app.id, (d) => nodes(d).find((n) => n.id === "c_b2barbaaaa")?.slot?.h === 5);
  await page.waitForTimeout(400);
  await select(page, "c_b2barbaaaa");
  const before = await canvas(page, "c_b2barbaaaa").locator('[data-slot="root"]').first().evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight, overY: getComputedStyle(e).overflowY }));
  await page.locator("[data-fit-selected]").click();
  await untilDraft(page.request, app.id, (d) => (nodes(d).find((n) => n.id === "c_b2barbaaaa")?.slot?.h ?? 0) !== 5);
  await page.waitForTimeout(400);
  const after = await canvas(page, "c_b2barbaaaa").locator('[data-slot="root"]').first().evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight, overY: getComputedStyle(e).overflowY }));
  const bars = await scrollers(canvas(page, "c_b2barbaaaa"));
  writeEv("b2-fit.json", { before, after, bars, slot: nodes(await draft(page.request, app.id)).find((n) => n.id === "c_b2barbaaaa")?.slot });
  await page.screenshot({ path: shot("b2-fit-builder") });
  expect(bars).toEqual([]);
  expect(after.overY).not.toBe("auto");
  expect(after.sh, "scrollHeight equals clientHeight after Fit").toBe(after.ch);
});

// ---------- V5 and V8 ----------
test("V5 and V8: at 390px and with reduced motion, groups stack in one column with every tile seen, no tile lifts, and an icon fills its box", async ({ browser, page }) => {
  const slug = `w210-phone-${RUN}`;
  const tiles: Node[] = Array.from({ length: 4 }, (_, i) => ({ id: `c_phn${"abcd"[i]}aaaaaa`, type: "service-tile", props: { name: `Service ${i + 1}`, description: "FAKE e2e", href: `https://p${i + 1}.example.test/`, newTab: true, stats: [] } }));
  const app = await newApp(page.request, slug, [
    { id: "c_phngroupaa", type: "group", props: { title: "Phone", columns: 4 }, slot: { x: 0, y: 0, w: 12, h: 26 }, children: tiles },
    { id: "c_phniconaaa", type: "icon", props: { name: "server", size: 24, fill: true }, slot: { x: 0, y: 26, w: 1.375, h: 10 } },
  ]);
  await setTheme(page.request, app.id, await frosted(page.request));
  await publish(page.request, app.id);
  const state = await page.context().storageState();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", storageState: state });
  await phone.goto(`${ORIGIN}/a/${slug}`);
  await expect(phone.locator('[data-node="c_phngroupaa"]')).toBeVisible({ timeout: 15_000 });
  await phone.waitForTimeout(400);
  const cols = await phone.locator('[data-node="c_phngroupaa"] [data-slot="root"]').first().getAttribute("data-columns");
  const seen = [] as boolean[];
  for (const t of tiles) seen.push(fullySeen(await visible(phone.locator(`[data-node="${t.id}"] .atr-tile`).first())));
  const bars = await scrollers(phone.locator('[data-node="c_phngroupaa"]').first());
  const icon = await phone.locator('[data-node="c_phniconaaa"]').first().evaluate((e) => ({ box: e.getBoundingClientRect().toJSON(), svg: e.querySelector("svg")!.getBoundingClientRect().toJSON() }));
  await phone.screenshot({ path: shot("v5-phone-390-reduced"), fullPage: true });
  // Reduced motion: hovering a tile does not lift it.
  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce", storageState: state });
  await desk.goto(`${ORIGIN}/a/${slug}`);
  const tile = desk.locator(`[data-node="${tiles[0]!.id}"] .atr-tile`).first();
  await expect(tile).toBeVisible({ timeout: 15_000 });
  const y0 = (await tile.boundingBox())!.y;
  await tile.hover();
  await desk.waitForTimeout(250);
  const y1 = (await tile.boundingBox())!.y;
  await desk.screenshot({ path: shot("v8-reduced-motion-hover") });
  writeEv("v5-v8.json", { cols, seen, bars, icon, hover: { y0, y1 } });
  expect(cols).toBe("1");
  expect(seen.every(Boolean)).toBe(true);
  expect(bars).toEqual([]);
  expect(icon.svg.width).toBeGreaterThan(12);
  expect(icon.svg.width).toBeLessThanOrEqual(Math.min(icon.box.width, icon.box.height) + 0.5);
  expect(Math.abs(y1 - y0)).toBeLessThan(0.5);
  await phone.close();
  await desk.close();
});
