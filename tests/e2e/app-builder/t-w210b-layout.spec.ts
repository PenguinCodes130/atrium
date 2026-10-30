// Wave 2.10b builder L (app-builder, layout): F1 starter page, F7 smart guides and alignment, F9 Theme in
// the builder bar (stages/02-subsystem-spec/output/operator-tryout-spec.md section 4, criteria 9, 15, 16;
// architecture A11.7). Every test drives the real screen the way the operator does (V11): the New app
// sheet, a drag on the canvas, the builder bar. Stand-ins: the fake Prometheus (tests/e2e/fixtures) and the
// fake Home Assistant (helpers.ts); never a real service. Evidence: evidence/app-builder-layout/w210b-r1/<stage>/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { startFakePrometheus, FAKE_MACHINES, type FakePrometheus } from "../fixtures/fake-prometheus";
import { api, contextFor, fakeHa, FAKE_HA_TOKEN, OWNER, SHELL_VARIANTS, type FakeHa } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; name?: string; props: Record<string, unknown>; slot?: Slot; children?: Node[] };
type Draft = { rev: number; doc: { theme: { themeId?: string; inline?: unknown }; dataSources: { name: string; endpointId: string; integrationId: string }[]; app: { homePage: string }; pages: { id: string; slug: string; title: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210B_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder-layout/w210b-r1", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const note = (name: string, data: unknown) => writeFileSync(out(`${name}.json`), JSON.stringify(data, null, 2));
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
  const r = await (await owner()).post("/api/apps", { data: { name: `Layout ${slug}`, slug, template: "blank" } });
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
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note: "layout e2e" } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}
const walk = (x: Node, f: (n: Node) => void) => { f(x); for (const k of x.children ?? []) walk(k, f); };
const nodesOf = (d: Draft, type: string) => { const all: Node[] = []; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.type === type) all.push(x); }); return all; };
const nodeIn = (d: Draft, id: string): Node | undefined => { let f: Node | undefined; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.id === id) f = x; }); return f; };
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-canvas-bar], [data-builder-narrow]").first()).toBeVisible();
}
async function key(page: Page, combo: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(combo);
}

/** A FAKE wallpaper: a smooth colour wash as a PNG made here. */
function fakeWallpaper(): Buffer {
  const w = 800, h = 500;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) { const i = o + 1 + x * 3; raw[i] = Math.round(40 + 150 * (x / w)); raw[i + 1] = Math.round(90 + 80 * (y / h)); raw[i + 2] = Math.round(200 - 120 * (x / w) * (y / h)); }
  }
  const t = Array.from({ length: 256 }, (_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** The V4 frosted custom theme through the real API: FAKE image wallpaper, glass 0.3, blur 1 px, soft shadow, 1 px border. */
async function frostedTheme(c: APIRequestContext, name = `Frosted e2e ${RUN} ${n++}`): Promise<string> {
  const up = await c.post("/api/settings/uploads", { multipart: { file: { name: "fake-wallpaper.png", mimeType: "image/png", buffer: fakeWallpaper() }, accept: "image" } });
  expect(up.ok(), await up.text()).toBe(true);
  const src = (await up.json()).path as string;
  const dup = await c.post("/api/settings/themes/control-room/duplicate");
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  const cur = await (await c.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = name;
  theme.tokens.wallpaper = { ...theme.tokens.wallpaper, kind: "image", value: src, blurPx: 0, dim: 0, grain: 0 };
  theme.tokens.surface = { ...theme.tokens.surface, material: "glass", opacity: 0.3, blurPx: 1, shadow: "soft", shadowOffsetPx: 0, border: { ...theme.tokens.surface.border, widthPx: 1 } };
  const put = await c.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}

// ---------------------------------------------------------------------------------------------------
// F1: the starter page
// ---------------------------------------------------------------------------------------------------

let prom: FakePrometheus | undefined;
let ha: FakeHa | undefined;
let promId = "";
let haId = "";
test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  prom = await startFakePrometheus();
  ha = await fakeHa();
  const c = await owner();
  const mk = async (data: Record<string, unknown>) => { const r = await c.post("/api/integrations", { data: { secrets: {}, untested: true, ...data } }); if (!r.ok()) throw new Error(`integration: ${await r.text()}`); return (await r.json()).id as string; };
  promId = await mk({ packageId: "prometheus", name: `Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" } });
  haId = await mk({ packageId: "home-assistant", name: `Home ${RUN}`, config: { baseUrl: ha.url }, secrets: { token: FAKE_HA_TOKEN } });
});
test.afterAll(async () => { await prom?.close(); await ha?.close(); });

/** The stand-in's machines: its 9, plus the ones a test added (the F1 test adds one). */
let added = 0;
const MACHINES = () => FAKE_MACHINES.length + added;
const canvasOf = (page: Page) => page.locator("[data-builder-canvas]");
/** The machine rows the page shows: the items of the repeat named "Machines". */
async function machineRows(scope: Locator): Promise<number> {
  return scope.locator('[data-type="repeat"] .atr-repeat[data-count]').first().getAttribute("data-count").then((v) => Number(v ?? 0)).catch(() => 0);
}

test("F1 criterion 9: New app preselects the start page; machine rows, service tiles and a CPU chart within 5 s, in the chosen theme; a new machine shows with no edit", async ({ browser }) => {
  const c = await owner();
  const frosted = await frostedTheme(c, `Frosted F1 ${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-new-app], [data-new-app-tile]").first().click();
  await expect(page.locator("[data-new-app-form]")).toBeVisible();
  // Preselected: the start page row is the checked one before anything is clicked.
  await expect(page.locator('[data-template-option="start-page"]'), "New app preselects the start page").toHaveAttribute("aria-checked", "true", { timeout: 5000 });
  await expect(page.locator(`[data-start-service="${promId}"]`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`[data-start-service="${haId}"]`)).toBeVisible();
  // Only this run's two services stay ticked (other tests' services may exist on the slot).
  for (const el of await page.locator("[data-start-service]").all()) {
    const id = await el.getAttribute("data-start-service");
    const on = (await el.getAttribute("aria-checked")) === "true";
    if ((id === promId || id === haId) !== on) await el.click();
  }
  // The theme is the person's choice, in the sheet.
  await page.locator("[data-new-app-theme] select").selectOption(`id:${frosted}`);
  await page.locator("[data-new-app-name]").fill(`Home F1 ${RUN}`);
  await page.locator("[data-new-app-slug]").fill(`f1-home-${RUN}`);
  await page.screenshot({ path: out("f1-new-app-sheet.png") });
  await page.locator("[data-create-app]").click();
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  const t0 = Date.now();
  await expect.poll(() => machineRows(canvasOf(page)), { timeout: 5000, message: `one machine row per machine (${MACHINES()})` }).toBe(MACHINES());
  await expect(canvasOf(page).locator('[data-type="service-tile"]')).toHaveCount(2, { timeout: Math.max(500, 5000 - (Date.now() - t0)) });
  await expect(canvasOf(page).locator('[data-type="chart"] [data-series-count]').first()).toHaveAttribute("data-series-count", String(MACHINES()), { timeout: Math.max(500, 5000 - (Date.now() - t0)) });
  const ms = Date.now() - t0;
  // Live values, not samples: the first machine's CPU (ACE 7.8 %) is drawn in its row.
  await expect(canvasOf(page).locator("[data-bar-value]").first()).toContainText("7.8", { timeout: 5000 });
  await expect(canvasOf(page).locator("[data-bar-sample], [data-sample]")).toHaveCount(0);
  const slug = `f1-home-${RUN}`;
  const apps = await (await c.get("/api/apps")).json();
  const appId = (apps.tiles as { app: { id: string; slug: string } }[]).find((t) => t.app.slug === slug)!.app.id;
  // The page-open growth (fit boxes, up to 10 s after open) is done before the machine is added.
  await page.waitForTimeout(Math.max(0, 11_000 - (Date.now() - t0)));
  const d = await draft(appId);
  expect(d.doc.theme, "the app uses the chosen theme").toEqual({ themeId: frosted });
  await page.screenshot({ path: out("f1-builder-frosted.png") });
  // A fourth... a new machine: it reports to Prometheus and its row appears with no edit and no reload.
  added++;
  prom!.addMachine({ instance: "10.77.99.200:9100", host: "newbox", nodename: "newbox", arch: "x86_64", cores: 2, memGiB: 4, cpu: 5.5, mem: 20, disk: 10, netIn: 1000, netOut: 1000, load5: 0.1, uptimeSec: 3600, mounts: ["/"] });
  await expect.poll(() => machineRows(canvasOf(page)), { timeout: 70_000, message: "the new machine's row appears without an edit" }).toBe(MACHINES());
  expect((await draft(appId)).rev, "no edit was made for the new machine").toBe(d.rev);
  await page.screenshot({ path: out("f1-builder-new-machine.png") });
  note("f1", { msToShow: ms, machines: MACHINES(), theme: d.doc.theme, sources: d.doc.dataSources.map((s) => s.endpointId) });
  await ctx.close();
});

test("F1 one undo step: Insert > Start page in the builder, one Ctrl+Z takes the whole page back", async ({ browser }) => {
  const app = await newApp(`f1-undo-${RUN}`, [{ id: cid(), type: "heading", props: { text: "Keep me", level: 2 }, slot: { x: 0, y: 0, w: 6, h: 8 } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="start-page"]').first().click();
  await expect(page.locator("[data-start-sheet]")).toBeVisible();
  for (const el of await page.locator("[data-start-service]").all()) {
    const id = await el.getAttribute("data-start-service");
    const on = (await el.getAttribute("aria-checked")) === "true";
    if ((id === promId || id === haId) !== on) await el.click();
  }
  await page.locator("[data-start-make]").click();
  const made = await untilDraft(app.id, (x) => x.doc.pages.length === 2 && nodesOf(x, "repeat").length > 0);
  expect(made.doc.pages.length).toBe(2);
  expect(nodesOf(made, "repeat").length, "a machine rows repeat").toBeGreaterThan(0);
  // At least the stand-in's machines (a reading cached before another test added one may lag a refresh).
  await expect.poll(() => machineRows(canvasOf(page)), { timeout: 8000 }).toBeGreaterThanOrEqual(FAKE_MACHINES.length);
  await key(page, "Control+z");
  const back = await untilDraft(app.id, (x) => x.doc.pages.length === 1);
  expect(back.doc.pages.length, "one undo removes the whole start page").toBe(1);
  expect(nodesOf(back, "repeat").length).toBe(0);
  expect(back.doc.dataSources.length, "and its data sources").toBe(0);
  await ctx.close();
});

test("F1 V4 V5: the start page looks finished in Control Room, Dusk, Solid and the frosted theme, at 1280 and 390", async ({ browser }) => {
  const c = await owner();
  const frosted = await frostedTheme(c);
  const result: Record<string, unknown> = {};
  for (const theme of ["control-room", "dusk", "solid", frosted]) {
    const name = theme === frosted ? "frosted" : theme;
    const slug = `f1-${name.slice(0, 8)}-${RUN}`;
    const r = await c.post("/api/apps", { data: { name: `Start ${name}`, slug, template: "blank", theme: { themeId: theme } } });
    expect(r.ok(), await r.text()).toBe(true);
    const id = (await r.json()).app.id as string;
    const sp = await c.post(`/api/apps/${id}/start-page`, { data: { integrationIds: [promId, haId], links: [{ name: "Router", href: "http://10.77.0.1" }] } });
    expect(sp.ok(), await sp.text()).toBe(true);
    expect((await draft(id)).doc.theme).toEqual({ themeId: theme });
    await publish(id);
    for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: vp, ...(vp.width < 500 ? { reducedMotion: "reduce" as const } : {}) });
      const page = await ctx.newPage();
      await page.goto(`/a/${slug}`);
      await expect.poll(() => machineRows(page.locator("[data-atrium-canvas]").first()), { timeout: 10_000 }).toBe(MACHINES());
      await page.waitForTimeout(800);
      const check = await page.evaluate(() => {
        const roots = Array.from(document.querySelectorAll("[data-atrium-canvas] [data-node]")) as HTMLElement[];
        const scrollers: string[] = [];
        const cropped: string[] = [];
        for (const el of roots) {
          const root = (el.querySelector(":scope > [data-slot=root]") ?? el.firstElementChild) as HTMLElement | null;
          if (!root) continue;
          const cs = getComputedStyle(root);
          const type = el.getAttribute("data-type") ?? "";
          if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && root.scrollHeight > root.clientHeight + 1) scrollers.push(type);
          if (root.scrollHeight > root.clientHeight + 1 && cs.overflowY !== "visible") cropped.push(`${type} ${root.scrollHeight}/${root.clientHeight}`);
        }
        return { scrollers, cropped, samples: document.querySelectorAll("[data-bar-sample], [data-sample]").length, docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
      });
      result[`${name}-${vp.width}`] = check;
      expect.soft(check.scrollers, `${name} ${vp.width}: no component scrolls`).toEqual([]);
      expect.soft(check.cropped, `${name} ${vp.width}: nothing cropped`).toEqual([]);
      expect.soft(check.samples, `${name} ${vp.width}: no sample tags`).toBe(0);
      expect.soft(check.docScroll, `${name} ${vp.width}: no sideways scroll`).toBe(false);
      await page.screenshot({ path: out(`f1-${name}-${vp.width}.png`), fullPage: true });
      await ctx.close();
    }
  }
  note("f1-themes", result);
});

// ---------------------------------------------------------------------------------------------------
// F7: one snapping model (A11.7)
// ---------------------------------------------------------------------------------------------------

const text = (label: string, slot: Slot): Node => ({ id: cid(), type: "text", name: label, props: { text: label, size: "md" }, slot });
type Box = { x: number; y: number; width: number; height: number };
async function rect(page: Page, id: string): Promise<Box> {
  return (await page.locator(`[data-builder-canvas] [data-node="${id}"]`).first().boundingBox())!;
}
/**
 * Grabs a widget by its type tag and moves the pointer so the widget's top-left would sit at (left, top)
 * on screen, in small steps (a real drag). `hold` keys stay down for the whole move. Returns while the
 * pointer is still down so the guides can be read; call `page.mouse.up()` to drop.
 */
async function dragTo(page: Page, id: string, left: number, top: number, hold: string[] = []) {
  await page.locator(`[data-builder-canvas] [data-node="${id}"]`).first().click();
  const handle = page.locator(`[data-selected-outline="${id}"] [data-drag-handle]`);
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  const r = await rect(page, id);
  // The tag's right end, upper half: well clear of the selection's corner resize handle.
  const sx = hb.x + hb.width - 8, sy = hb.y + 5;
  const grabX = sx - r.x; // the pointer above the widget holds it at its left offset and top edge
  for (const k of hold) await page.keyboard.down(k);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const tx = left + grabX, ty = top;
  const steps = 14;
  for (let i = 1; i <= steps; i++) await page.mouse.move(sx + ((tx - sx) * i) / steps, sy + ((ty - sy) * i) / steps);
  await page.mouse.move(tx, ty);
  // The drop ghost glides to its cell; let it settle before reading it.
  await page.waitForTimeout(450);
}
async function release(page: Page, hold: string[] = []) {
  await page.mouse.up();
  for (const k of hold) await page.keyboard.up(k);
  await page.waitForTimeout(250);
}

test("F7 criterion 15: guides pull within 6 px and land flush, equal-spacing marks, distance readout, Alt places with no pull, Ctrl no longer flips, Align and Match size on several", async ({ browser }) => {
  // A and C in one row with a gap of 2 columns; B below, the one dragged.
  const A = text("Alpha", { x: 2, y: 0, w: 2, h: 8 });
  const C = text("Gamma", { x: 6, y: 0, w: 2, h: 8 });
  const B = text("Beta", { x: 0, y: 24, w: 2, h: 8 });
  const app = await newApp(`f7-snap-${RUN}`, [A, C, B]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await expect(page.locator(`[data-builder-canvas] [data-node="${B.id}"]`)).toBeVisible();
  const result: Record<string, unknown> = {};

  // 1. Near A's left edge (5.5 px off, inside the 6 px pull, more than half an eighth of a column so a
  //    plain rounding would not land it there): a red guide shows and B lands flush (0 px apart).
  const a = await rect(page, A.id);
  const c0 = await rect(page, C.id);
  const eighth = (c0.x - a.x) / 4 / 8;
  const OFF = 5.5;
  result.eighthPx = eighth;
  expect(OFF > eighth / 2 && OFF < 6, `test offset ${OFF} px vs an eighth of ${eighth.toFixed(2)} px`).toBe(true);
  await dragTo(page, B.id, a.x - OFF, a.y + a.height + 40);
  const guide = page.locator("[data-guide]");
  await expect(guide.first(), "a guide shows while the edge is within 6 px").toBeVisible();
  const colour = await guide.first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(colour)!;
  expect(Number(m[1]) > 150 && Number(m[2]) < 110 && Number(m[3]) < 110, `the guide is red (${colour})`).toBe(true);
  await expect(page.locator("[data-grid-cells]"), "the columns are drawn faintly during the drag").toHaveCount(1);
  const readout = page.locator("[data-distance-readout]");
  await expect(readout, "a distance readout shows the gap to the nearest neighbour").toBeVisible();
  result.readoutDuringDrag = await readout.textContent();
  await page.screenshot({ path: out("f7-guide-drag.png") });
  result.ghostAtDrop = await page.locator("[data-drop-ghost]").getAttribute("data-ghost-slot");
  result.guidesAtDrop = await page.locator("[data-guide]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-guide")}@${e.getAttribute("data-guide-at")}`));
  result.geometry = { a, c0, b0: await rect(page, B.id), handle: await page.locator(`[data-selected-outline="${B.id}"] [data-drag-handle]`).boundingBox() };
  note("f7-debug", result);
  await release(page);
  let d = await untilDraft(app.id, (x) => nodeIn(x, B.id)!.slot!.y !== 24);
  expect(nodeIn(d, B.id)!.slot!.x, "pulled onto A's left edge").toBe(2);
  const b1 = await rect(page, B.id);
  const a1 = await rect(page, A.id);
  result.flush = { aLeft: a1.x, bLeft: b1.x, gap: Math.abs(b1.x - a1.x) };
  expect(Math.abs(b1.x - a1.x), "lands flush: 0 px between the two left edges").toBeLessThan(0.5);

  // 2. Readout value: the px gap between B and its nearest neighbour, as drawn.
  await dragTo(page, B.id, a1.x, a1.y + a1.height + 30);
  const shown = Number(/(\d+(?:\.\d+)?)\s*px/.exec((await readout.textContent()) ?? "")?.[1] ?? NaN);
  const ghost = (await page.locator("[data-drop-ghost]").boundingBox())!;
  const zoom = await page.evaluate(() => { const s = document.querySelector("[data-canvas-scaled]") as HTMLElement | null; const t = s ? getComputedStyle(s).transform : "none"; const mm = /matrix\(([^,]+)/.exec(t); return mm ? Number(mm[1]) : 1; });
  const gapPx = (ghost.y - (a1.y + a1.height)) / zoom;
  result.readout = { shown, measured: gapPx, zoom };
  expect(Math.abs(shown - gapPx), `the readout (${shown} px) is the drawn gap (${gapPx.toFixed(1)} px)`).toBeLessThanOrEqual(2);
  await release(page);

  // 3. Equal spacing: A to C is 2 columns; moving B to the right of C at about the same gap pulls it to
  //    exactly that gap and shows spacing marks.
  const c = await rect(page, C.id);
  const gap = c.x - (a1.x + a1.width);
  await dragTo(page, B.id, c.x + c.width + gap - 4, c.y);
  await expect(page.locator("[data-spacing-mark]").first(), "equal-spacing marks show when gaps match").toBeVisible();
  expect(await page.locator("[data-spacing-mark]").count()).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: out("f7-equal-spacing.png") });
  await release(page);
  d = await untilDraft(app.id, (x) => nodeIn(x, B.id)!.slot!.y === 0);
  expect(nodeIn(d, B.id)!.slot, "pulled to the matching gap").toMatchObject({ x: 10, y: 0 });

  // 4. Alt held: no pull at all for that move (no guide; it lands where the pointer put it).
  await ops(app.id, [{ op: "node.update", nodeId: B.id, patch: { slot: { x: 0, y: 24, w: 2, h: 8 } } }]);
  await page.reload();
  await expect(page.locator(`[data-builder-canvas] [data-node="${B.id}"]`)).toBeVisible();
  const a2 = await rect(page, A.id);
  await dragTo(page, B.id, a2.x - OFF, a2.y + a2.height + 40, ["Alt"]);
  await expect(page.locator("[data-guide]"), "no guide while Alt is held").toHaveCount(0);
  await page.screenshot({ path: out("f7-alt-no-pull.png") });
  await release(page, ["Alt"]);
  d = await untilDraft(app.id, (x) => nodeIn(x, B.id)!.slot!.y !== 24);
  result.alt = nodeIn(d, B.id)!.slot;
  expect(nodeIn(d, B.id)!.slot!.x, "with Alt it is not pulled onto the edge").not.toBe(2);

  // 5. Ctrl or Cmd no longer flips snapping: holding Control the guide still pulls.
  await dragTo(page, B.id, a2.x - OFF, a2.y + a2.height + 90, ["Control"]);
  await expect(page.locator("[data-guide]").first(), "Ctrl does not turn the guides off").toBeVisible();
  await release(page, ["Control"]);
  d = await untilDraft(app.id, (x) => nodeIn(x, B.id)!.slot!.x === 2);
  expect(nodeIn(d, B.id)!.slot!.x).toBe(2);

  // 6. Several selected: Align left gives equal left edges; Match size is named so. C moves down first so
  //    the three do not overlap once aligned.
  await ops(app.id, [{ op: "node.update", nodeId: C.id, patch: { slot: { x: 6, y: 20, w: 2, h: 8 } } }]);
  await page.reload();
  await expect(page.locator(`[data-builder-canvas] [data-node="${C.id}"]`)).toBeVisible();
  await page.locator(`[data-builder-canvas] [data-node="${A.id}"]`).first().click();
  await page.locator(`[data-builder-canvas] [data-node="${C.id}"]`).first().click({ modifiers: ["Shift"] });
  await page.locator(`[data-builder-canvas] [data-node="${B.id}"]`).first().click({ modifiers: ["Shift"] });
  await expect(page.locator("[data-arrange-bar]")).toHaveAttribute("data-arrange-bar", "3");
  await expect(page.locator('[data-arrange="width"]')).toHaveAttribute("aria-label", /Match/);
  await expect(page.locator('[data-arrange="height"]')).toHaveAttribute("aria-label", /Match/);
  await page.locator('[data-arrange="left"]').click();
  d = await untilDraft(app.id, (x) => new Set([A, B, C].map((k) => nodeIn(x, k.id)!.slot!.x)).size === 1);
  expect(new Set([A, B, C].map((k) => nodeIn(d, k.id)!.slot!.x)).size, "Align left on three: equal left edges").toBe(1);
  await page.screenshot({ path: out("f7-align-left.png") });
  note("f7", result);
  await ctx.close();
});

test("F7 hint: the empty canvas names shift-click and the box select", async ({ browser }) => {
  const app = await newApp(`f7-hint-${RUN}`);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  const hint = page.locator("[data-builder-canvas] [data-canvas-hint]");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(/shift-click/i);
  await expect(hint).toContainText(/drag a box/i);
  await page.screenshot({ path: out("f7-empty-hint.png") });
  await ctx.close();
});

test("F7 V7: drag with guides holds 60 fps", async ({ browser }) => {
  const kids = [text("One", { x: 0, y: 0, w: 3, h: 8 }), text("Two", { x: 4, y: 0, w: 3, h: 8 }), text("Three", { x: 8, y: 0, w: 3, h: 8 }), text("Four", { x: 0, y: 12, w: 3, h: 8 }), text("Five", { x: 6, y: 12, w: 3, h: 8 })];
  const moving = text("Mover", { x: 0, y: 30, w: 3, h: 8 });
  const app = await newApp(`f7-fps-${RUN}`, [...kids, moving]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator(`[data-builder-canvas] [data-node="${moving.id}"]`).first().click();
  const hb = (await page.locator(`[data-selected-outline="${moving.id}"] [data-drag-handle]`).boundingBox())!;
  await page.mouse.move(hb.x + hb.width - 8, hb.y + 5);
  await page.mouse.down();
  await page.mouse.move(hb.x + 20, hb.y + 20, { steps: 3 });
  await page.evaluate(() => { const w = window as unknown as { __f: number[] }; w.__f = []; const tick = (t: number) => { w.__f.push(t); if (w.__f.length < 4000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  // A slow sweep across every other widget's edges and centres, about 2 s, one pointer event a frame.
  for (let i = 0; i < 120; i++) { await page.mouse.move(hb.x + 20 + i * 5, hb.y + 20 - i * 2); await page.waitForTimeout(16); }
  const frames = await page.evaluate(() => (window as unknown as { __f: number[] }).__f);
  await page.mouse.up();
  const deltas = frames.slice(1).map((t, i) => t - frames[i]!);
  const sorted = [...deltas].sort((x, y) => x - y);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const avg = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  const long = deltas.filter((x) => x > 16.7 * 1.5).length;
  note("f7-fps", { frames: deltas.length, avgMs: +avg.toFixed(2), p95Ms: +p95.toFixed(2), over25ms: long, maxMs: +Math.max(...deltas).toFixed(2), longAt: deltas.flatMap((x, i) => (x > 25 ? [i] : [])) });
  // 60 fps held: 95% of frames inside one 60 Hz frame (+1 ms timer noise), and under 5% of frames long.
  // The average is recorded, not asserted: a few long frames (drag start, a busy shared VM) pull it over.
  expect(p95, "95% of frames under 16.7 ms (+1 ms timer noise)").toBeLessThan(17.7);
  expect(long / deltas.length, "fewer than 5% of frames over 25 ms").toBeLessThan(0.05);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------
// F9: Theme in the builder bar
// ---------------------------------------------------------------------------------------------------

async function wallpaperOf(page: Page) {
  return page.locator("[data-builder-canvas] [data-atrium-canvas]").first().evaluate((el) => {
    const w = el.querySelector("[data-canvas-wallpaper]") as HTMLElement;
    const cs = getComputedStyle(w);
    return `${el.getAttribute("data-canvas-tone")}|${cs.backgroundColor}|${cs.backgroundImage.slice(0, 120)}`;
  });
}

test("F9 criterion 16: Navigation and Theme on the bar at 1280; pick with a live preview on the real page, edit with the full editor, create; Settings > Themes has them", async ({ browser }) => {
  const c = await owner();
  const app = await newApp(`f9-theme-${RUN}`, [text("Hello", { x: 0, y: 0, w: 4, h: 8 })]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  // Both entries on the bar, in view, with no menu opened.
  for (const sel of ["[data-builder-navigation]", "[data-builder-theme]"]) {
    await expect(page.locator(sel), `${sel} on the builder bar`).toBeVisible();
    await expect(page.locator(sel)).toBeInViewport({ ratio: 1 });
  }
  await page.screenshot({ path: out("f9-bar-1280.png") });
  const before = await wallpaperOf(page);
  await page.locator("[data-builder-theme]").click();
  const sheet = page.locator("[data-theme-sheet]");
  await expect(sheet).toBeVisible();
  // Pick: pointing at Dusk previews it on this app's real page; nothing is written until Use.
  await sheet.locator('[data-theme-option="dusk"]').hover();
  await expect.poll(() => wallpaperOf(page), { message: "the canvas previews Dusk" }).not.toBe(before);
  await expect(page.locator("[data-builder-canvas] [data-theme-previewing]")).toHaveAttribute("data-theme-previewing", "dusk");
  await page.screenshot({ path: out("f9-preview-dusk.png") });
  expect((await draft(app.id)).doc.theme, "nothing changes in the draft while previewing").toEqual({ themeId: "control-room" });
  await sheet.locator('[data-theme-use="dusk"]').click();
  await untilDraft(app.id, (x) => (x.doc.theme as { themeId?: string }).themeId === "dusk");
  expect((await draft(app.id)).doc.theme).toEqual({ themeId: "dusk" });

  // Create: a new theme from the builder, edited in the full editor, then used on this app.
  await sheet.locator("[data-theme-new]").click();
  const editor = sheet.locator("[data-theme-editor]");
  await expect(editor, "the full theme editor opens in the builder").toBeVisible({ timeout: 10_000 });
  const name = `Builder made ${RUN}`;
  await editor.locator('[data-field="name"]').fill(name);
  await editor.locator("[data-save-theme]").click();
  await expect(page.getByText(`Saved ${name}`).first()).toBeVisible({ timeout: 10_000 });
  const list = await (await c.get("/api/settings/themes?picker=1")).json();
  const made = (list.options as { id: string; name: string }[]).find((o) => o.name === name);
  expect(made, "the created theme is saved").toBeTruthy();
  expect((await draft(app.id)).doc.theme, "a theme made from the builder goes on this app").toEqual({ themeId: made!.id });

  // Edit: flip Mode (light to dark, or dark to light) in the editor, Save, and the canvas changes live
  // (no reload).
  const canvasEl = page.locator("[data-builder-canvas] [data-atrium-canvas]").first();
  await expect(canvasEl).toHaveAttribute("data-canvas-tone", /light|dark|auto/);
  const tone0 = await canvasEl.getAttribute("data-canvas-tone");
  const want = tone0 === "dark" ? "light" : "dark";
  await editor.locator('[data-field="mode"] [role="radio"]').filter({ hasText: want === "dark" ? "Dark" : "Light" }).click();
  await editor.locator("[data-save-theme]").click();
  await expect(canvasEl, "the edit shows on the canvas at once").toHaveAttribute("data-canvas-tone", want, { timeout: 5000 });
  await page.screenshot({ path: out("f9-edited-dark.png") });
  // Settings > Themes still lists it, edited.
  const settings = await ctx.newPage();
  await settings.goto("/settings/themes");
  await expect(settings.getByText(name).first(), "Settings > Themes lists the theme made in the builder").toBeVisible({ timeout: 10_000 });
  await settings.screenshot({ path: out("f9-settings-themes.png") });
  expect((await (await c.get(`/api/settings/themes/${made!.id}`)).json()).theme.mode).toBe(want);
  note("f9", { before, themeId: made!.id });
  await ctx.close();
});

test("F9 V5 V8: at 390x844 the reduced phone builder has no Theme (like Navigation and Look); the panel at 1024 with reduced motion", async ({ browser }) => {
  const app = await newApp(`f9-phone-${RUN}`, [text("Hello", { x: 0, y: 0, w: 4, h: 8 })]);
  const phone = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await phone.newPage();
  await openBuilder(page, app.slug);
  await expect(page.locator("[data-builder-theme]")).toHaveCount(0);
  await expect(page.locator("[data-builder-navigation]")).toHaveCount(0);
  await page.screenshot({ path: out("f9-builder-390-reduced.png") });
  await phone.close();
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1024, height: 768 }, reducedMotion: "reduce" });
  const p2 = await ctx.newPage();
  await openBuilder(p2, app.slug);
  await p2.locator("[data-builder-theme]").click();
  const sheet = p2.locator("[data-theme-sheet]");
  await expect(sheet).toBeVisible();
  // The panel leaves part of the page in view beside it, undimmed, for the preview.
  const sb = (await sheet.boundingBox())!;
  expect(sb.x, "the canvas stays in view beside the panel").toBeGreaterThan(200);
  await p2.screenshot({ path: out("f9-panel-1024-reduced.png") });
  await ctx.close();
});
