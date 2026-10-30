// Wave 2.10b components (operator try-out spec F6, F4 for the component inspector panels, and the F10
// sweep samples in icon fields; criteria 12 and 14), through the real builder screen (V11). Each test was
// recorded failing on the build from before the change (evidence/components/w210b-r1/failing-first/).
// Themes (V4): Control Room, Dusk, Solid and a frosted custom theme made here through the real API (a
// FAKE image wallpaper, glass surfaces at 0.3 opacity, 1px blur, soft shadow, 1px border). Served by
// tests/e2e/components/serve.sh (port 3114). Test-only values; none are real credentials.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { signIn } from "./helpers";

test.describe.configure({ timeout: Number(process.env.ATRIUM_E2E_TEST_TIMEOUT ?? 600_000) });
// A control that is not there fails in 15s, not at the test timeout.
test.use({ actionTimeout: 15_000 });
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
const EV = path.resolve(here, `../../../evidence/components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "w210b-r1"}`);
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
  const r = await req.post("/api/apps", { data: { name: `Friction ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await draft(req, id);
  const rootId = d.doc.pages[0]!.root.id;
  if (kids.length) await ops(req, id, kids.map((n) => ({ op: "node.add", parentId: rootId, node: n })));
  return { id, rootId };
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
async function closeSheets(page: Page) {
  const sheet = page.locator('[role="dialog"]');
  if (await sheet.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
}
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
/** Opens every inspector group (Content, Data, Control, Style, Code and conditions) and every fold inside. */
async function openEverything(page: Page) {
  const insp = page.locator("[data-inspector]");
  // Each click changes which ones are closed, so always open the first closed one left.
  const groups = insp.locator("[data-inspector-group]:not([data-open]) > h3 > button");
  for (let i = 0; i < 8 && (await groups.count()); i++) await groups.first().click();
  // Only folds on show: one inside a closed part (the builder's Layout) stays as it is.
  const folds = insp.locator("[data-more-settings]:not([data-open]) > button[data-more-settings-toggle]:visible");
  for (let i = 0; i < 12 && (await folds.count()); i++) await folds.first().click({ timeout: 5000 }).catch(() => {});
}

// ---------- the frosted custom theme (V4) ----------
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

test.beforeEach(async ({ context, page }, info) => {
  // The builder at desktop width; the phone width (390x844) is its own context inside the V5 test.
  test.skip(info.project.name !== "desktop", "desktop project; the phone width is set per test");
  await signIn(context, page.request);
});

// ---------- the visual icon picker ----------
const picker = (page: Page) => page.locator("[data-icon-picker]");
/** Icons in the open picker that are drawn as themselves: an svg with at least one path and a real box. */
async function drawnCount(page: Page): Promise<{ total: number; drawn: number; names: string[] }> {
  return picker(page).evaluate((root) => {
    const choices = [...root.querySelectorAll<HTMLElement>("[data-icon-grid] [data-icon-choice]")];
    const names = new Set<string>();
    let drawn = 0;
    for (const c of choices) {
      const svg = c.querySelector("svg");
      const n = c.getAttribute("data-icon-choice")!;
      if (names.has(n)) continue;
      names.add(n);
      if (!svg) continue;
      const paths = svg.querySelectorAll("path");
      const r = svg.getBoundingClientRect();
      const lit = [...paths].some((p) => (p.getAttribute("d") ?? "").length > 4);
      if (paths.length && lit && r.width >= 12 && r.height >= 12) drawn++;
    }
    return { total: choices.length, drawn, names: [...names] };
  });
}

test("F6 criterion 14: the icon picker shows at least 200 drawn icons, finds server by typing and inserts it; no px field remains", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210b-pick-${RUN}`;
  const app = await newApp(page.request, slug);
  await open(page, slug);
  const id = await insert(page, page.request, app.id, "icon");
  await select(page, id);
  const insp = page.locator(`[data-inspector][data-node-id="${id}"]`);
  // The px field is gone, and Scale is a slider from 25 to 100 percent.
  await openEverything(page);
  await expect(insp.locator('[data-field="size"]'), "no px size field").toHaveCount(0);
  const contentText = await insp.locator('[data-inspector-group="content"]').innerText();
  expect(contentText, "no setting in px on the icon").not.toMatch(/\bin px\b/i);
  const scale = insp.locator('[data-field="scale"] input[type="range"]');
  await expect(scale, "a Scale slider").toHaveCount(1);
  expect(await scale.getAttribute("min")).toBe("25");
  expect(await scale.getAttribute("max")).toBe("100");
  // One visual grid picker opens from the icon field.
  await insp.locator('[data-field="name"] [data-icon-pick]').click();
  await expect(picker(page)).toBeVisible();
  const count = await drawnCount(page);
  const cats = await picker(page).locator("[data-icon-category]").allInnerTexts();
  await page.screenshot({ path: shot("f6-picker-open") });
  writeEv("f6-picker.json", { ...count, categories: cats });
  expect(count.drawn, `${count.drawn} drawn icons in the picker`).toBeGreaterThanOrEqual(200);
  expect(cats.length, `categories: ${cats.join(", ")}`).toBeGreaterThanOrEqual(6);
  await expect(picker(page).locator("[data-icon-upload-entry]"), "an Upload entry").toBeVisible();
  // A category narrows the grid.
  await picker(page).locator("[data-icon-category]").nth(2).click();
  const narrowed = await drawnCount(page);
  expect(narrowed.drawn).toBeLessThan(count.drawn);
  expect(narrowed.drawn).toBeGreaterThan(0);
  // No match says so in a sentence.
  await picker(page).locator("[data-icon-search]").fill("plexx");
  await expect(picker(page).locator("[data-icon-empty]")).toContainText("No icon called 'plexx'");
  // Typing finds server; a click inserts it.
  await picker(page).locator("[data-icon-search]").fill("server");
  await expect(picker(page).locator('[data-icon-grid] [data-icon-choice="server"]')).toBeVisible();
  await page.screenshot({ path: shot("f6-picker-search-server") });
  // Pick router first, then server, so Recent has two in order.
  await picker(page).locator("[data-icon-search]").fill("router");
  await picker(page).locator('[data-icon-grid] [data-icon-choice="router"]').click();
  let d = await untilDraft(page.request, app.id, (x) => nodes(x).find((n) => n.id === id)?.props.name === "router");
  expect(nodes(d).find((n) => n.id === id)?.props.name).toBe("router");
  await insp.locator('[data-field="name"] [data-icon-pick]').click();
  await picker(page).locator("[data-icon-search]").fill("server");
  await picker(page).locator('[data-icon-grid] [data-icon-choice="server"]').click();
  d = await untilDraft(page.request, app.id, (x) => nodes(x).find((n) => n.id === id)?.props.name === "server");
  expect(nodes(d).find((n) => n.id === id)?.props.name, "server inserted").toBe("server");
  await expect(canvas(page, id).locator("svg path").first()).toBeVisible();
  // Recent remembers the last picks, newest first.
  await insp.locator('[data-field="name"] [data-icon-pick]').click();
  const recent = await picker(page).locator("[data-icon-recent] [data-icon-choice]").evaluateAll((els) => els.map((e) => e.getAttribute("data-icon-choice")));
  writeEv("f6-recent.json", { recent });
  expect(recent.slice(0, 2)).toEqual(["server", "router"]);
  await page.screenshot({ path: shot("f6-picker-recent") });
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
});

test("F6: an icon fills its box keeping its shape; Scale draws 25 to 100 percent of the box; a stored px size keeps its drawn size", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210b-scale-${RUN}`;
  const app = await newApp(page.request, slug, [
    { id: "c_scaleaaaaa", type: "icon", props: { name: "server", fill: true }, slot: { x: 0, y: 0, w: 2, h: 16 } },
    { id: "c_scalewidea", type: "icon", props: { name: "cpu", fill: true }, slot: { x: 3, y: 0, w: 4, h: 12 } },
    { id: "c_scalepxaaa", type: "icon", props: { name: "disk", size: 32 }, slot: { x: 8, y: 0, w: 2, h: 16 } },
  ]);
  await open(page, slug);
  const geo = async (id: string) => {
    await page.waitForTimeout(250);
    const el = canvas(page, id);
    const b = (await el.boundingBox())!;
    const s = (await el.locator("svg").first().boundingBox())!;
    return { box: { w: b.width, h: b.height }, icon: { w: s.width, h: s.height } };
  };
  // A stored px size draws the same size before anything is touched (section 9: it becomes the Scale).
  const px = await geo("c_scalepxaaa");
  expect(Math.abs(px.icon.w - 32), `stored 32px icon draws ${px.icon.w}px`).toBeLessThanOrEqual(1);
  await select(page, "c_scalepxaaa");
  const pxScale = Number(await page.locator('[data-field="scale"] input[type="range"]').inputValue());
  const expected = Math.round((32 / Math.min(px.box.w, px.box.h)) * 100);
  expect(Math.abs(pxScale - expected), `Scale shows ${pxScale}%, 32px of the box is ${expected}%`).toBeLessThanOrEqual(2);
  // Scale 100 and 25 on a square box, and on a wide box (the shape stays square, the short side decides).
  const out: Record<string, unknown> = { px, pxScale, expected };
  for (const id of ["c_scaleaaaaa", "c_scalewidea"]) {
    await select(page, id);
    const slider = page.locator(`[data-inspector][data-node-id="${id}"] [data-field="scale"] input[type="range"]`);
    await slider.focus();
    await page.keyboard.press("End");
    await untilDraft(page.request, app.id, (x) => nodes(x).find((n) => n.id === id)?.props.scale === 100);
    const full = await geo(id);
    await page.screenshot({ path: shot(`f6-scale-100-${id}`) });
    await slider.focus();
    await page.keyboard.press("Home");
    await untilDraft(page.request, app.id, (x) => nodes(x).find((n) => n.id === id)?.props.scale === 25);
    const quarter = await geo(id);
    await page.screenshot({ path: shot(`f6-scale-25-${id}`) });
    out[id] = { full, quarter };
    const side = Math.min(full.box.w, full.box.h);
    expect(Math.abs(full.icon.w - full.icon.h), "keeps its shape").toBeLessThanOrEqual(0.5);
    expect(Math.abs(full.icon.w - side), `100%: icon ${full.icon.w}px in a ${side}px side`).toBeLessThanOrEqual(1.5);
    expect(Math.abs(quarter.icon.w - side * 0.25), `25%: icon ${quarter.icon.w}px in a ${side}px side`).toBeLessThanOrEqual(1.5);
  }
  // Moving Scale on the stored-px icon writes a Scale and drops the px size.
  await select(page, "c_scalepxaaa");
  const s3 = page.locator('[data-inspector][data-node-id="c_scalepxaaa"] [data-field="scale"] input[type="range"]');
  await s3.focus();
  await page.keyboard.press("ArrowRight");
  const n3 = (await untilDraft(page.request, app.id, (x) => typeof nodes(x).find((n) => n.id === "c_scalepxaaa")?.props.scale === "number")).doc;
  const p3 = all(n3.pages[0]!.root).find((n) => n.id === "c_scalepxaaa")!.props;
  out.afterMove = p3;
  writeEv("f6-scale.json", out);
  expect(typeof p3.scale).toBe("number");
  expect(p3.size ?? null, "the px size is dropped once Scale is set").toBeNull();
});

test("F6 and F10: every icon field (icon, service tile, bookmarks, resource bar items) opens the same visual grid picker", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210b-fields-${RUN}`;
  const app = await newApp(page.request, slug, [
    { id: "c_fldiconaaa", type: "icon", props: { name: "server" }, slot: { x: 0, y: 0, w: 2, h: 10 } },
    { id: "c_fldtileaaa", type: "service-tile", props: { name: "Media e2e", icon: "film", href: "https://media.e2e.example" }, slot: { x: 2, y: 0, w: 3, h: 14 } },
    { id: "c_fldbookaaa", type: "bookmarks", props: { items: [{ name: "Docs e2e", href: "https://docs.e2e.example", icon: "book" }] }, slot: { x: 5, y: 0, w: 3, h: 10 } },
    { id: "c_fldbaraaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: 41, percent: 41, format: "percent" }] }, slot: { x: 0, y: 16, w: 8, h: 6 } },
  ]);
  await open(page, slug);
  const cases: { id: string; field: string; prop: (p: Record<string, unknown>) => unknown }[] = [
    { id: "c_fldiconaaa", field: "name", prop: (p) => p.name },
    { id: "c_fldtileaaa", field: "icon", prop: (p) => p.icon },
    { id: "c_fldbookaaa", field: "items.0.icon", prop: (p) => (p.items as { icon?: string }[])[0]?.icon },
    { id: "c_fldbaraaaa", field: "items.0.icon", prop: (p) => (p.items as { icon?: string }[])[0]?.icon },
  ];
  const seen: Record<string, unknown> = {};
  for (const c of cases) {
    await select(page, c.id);
    await openEverything(page);
    const insp = page.locator(`[data-inspector][data-node-id="${c.id}"]`);
    const field = insp.locator(`[data-icon-field="${c.field}"], [data-field="${c.field}"]`).first();
    // The field shows the current icon as a drawn sample, not a name in a menu (F10 sweep).
    await expect(field.locator("[data-icon-pick] svg, [data-icon-pick] img").first(), `${c.id}: the field shows its icon drawn`).toBeVisible();
    await expect(field.locator("select"), `${c.id}: no icon menu of names`).toHaveCount(0);
    await field.locator("[data-icon-pick]").click();
    await expect(picker(page)).toBeVisible();
    const count = await drawnCount(page);
    await picker(page).locator("[data-icon-search]").fill("globe");
    await picker(page).locator('[data-icon-grid] [data-icon-choice="globe"]').click();
    const d = await untilDraft(page.request, app.id, (x) => c.prop(nodes(x).find((n) => n.id === c.id)!.props) === "globe");
    const now = c.prop(nodes(d).find((n) => n.id === c.id)!.props);
    seen[c.id] = { drawn: count.drawn, now };
    await page.screenshot({ path: shot(`f6-field-${c.id}`) });
    expect(count.drawn, `${c.id}: ${count.drawn} drawn icons`).toBeGreaterThanOrEqual(200);
    expect(now, `${c.id}: picked globe`).toBe("globe");
  }
  writeEv("f6-fields.json", seen);
});

test("F6 V4 V5 V8: the picker in four themes, at 390px and with reduced motion", async ({ browser, page }) => {
  const slug = `w210b-themes-${RUN}`;
  const app = await newApp(page.request, slug, [{ id: "c_thmiconaaa", type: "icon", props: { name: "server" }, slot: { x: 0, y: 0, w: 2, h: 10 } }]);
  for (const t of await themeIds(page.request)) {
    await ops(page.request, app.id, [{ op: "theme.set", theme: { themeId: t.id } }]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, slug);
    await select(page, "c_thmiconaaa");
    await page.locator('[data-inspector] [data-field="name"] [data-icon-pick]').click();
    await expect(picker(page)).toBeVisible();
    await page.screenshot({ path: shot(`v4-picker-${t.name}`) });
    await page.keyboard.press("Escape");
  }
  const phone = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: "reduce", storageState: await page.context().storageState() });
  const p = await phone.newPage();
  await p.goto(`/build/${slug}`);
  await p.locator('[data-canvas-root] [data-node="c_thmiconaaa"]').tap();
  await p.locator('[data-narrow-tab="edit"]').tap();
  const pick = p.locator('[data-inspector] [data-field="name"] [data-icon-pick]');
  await expect(pick).toBeVisible({ timeout: 10_000 });
  await pick.tap();
  await expect(p.locator("[data-icon-picker]")).toBeVisible();
  const geo = await p.locator("[data-icon-picker]").evaluate((e) => {
    const r = e.getBoundingClientRect();
    const btn = e.querySelector("[data-icon-grid] [data-icon-choice]")!.getBoundingClientRect();
    const sheet = e.closest("[data-sheet]")!;
    const sr = sheet.getBoundingClientRect();
    const boxes: string[] = [];
    for (let a = sheet.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.transform !== "none" || cs.filter !== "none" || cs.contain !== "none" || cs.willChange.includes("transform")) boxes.push(`${a.tagName.toLowerCase()}.${String(a.className).slice(0, 40)} t=${cs.transform} f=${cs.filter} c=${cs.contain}`);
    }
    return { left: r.left, right: r.right, width: r.width, choice: { w: btn.width, h: btn.height }, motion: e.getAttribute("data-motion"), sheet: { top: sr.top, bottom: sr.bottom, transform: getComputedStyle(sheet).transform }, innerHeight: window.innerHeight, boxes };
  });
  await p.screenshot({ path: shot("v5-v8-picker-390-reduced") });
  writeEv("v5-v8-picker.json", geo);
  expect(geo.left).toBeGreaterThanOrEqual(0);
  expect(geo.right).toBeLessThanOrEqual(390.5);
  expect(geo.choice.w, "touch target").toBeGreaterThanOrEqual(44);
  expect(geo.motion).toBe("none");
  await phone.close();
});

// ---------- F4: fold titles, hints and reasons ----------
const F4_NODES: Node[] = [
  { id: "c_f4statxaaa", type: "stat", props: { value: 42.456, label: "CPU e2e", unit: "%" }, slot: { x: 0, y: 0, w: 3, h: 12 } },
  { id: "c_f4gaugeaaa", type: "gauge", props: { value: 50, label: "Load e2e" }, slot: { x: 3, y: 0, w: 3, h: 16 } },
  { id: "c_f4progaaaa", type: "progress", props: { value: 30, label: "Disk e2e" }, slot: { x: 6, y: 0, w: 3, h: 8 } },
  { id: "c_f4headaaaa", type: "heading", props: { text: "Heading e2e" }, slot: { x: 9, y: 0, w: 3, h: 6 } },
  { id: "c_f4textaaaa", type: "text", props: { text: "Text e2e" }, slot: { x: 0, y: 18, w: 3, h: 6 } },
  { id: "c_f4clockaaa", type: "clock", props: {}, slot: { x: 3, y: 18, w: 3, h: 10 } },
  { id: "c_f4iconaaaa", type: "icon", props: { name: "server" }, slot: { x: 6, y: 18, w: 2, h: 10 } },
  { id: "c_f4cardaaaa", type: "card", props: { title: "Card e2e" }, slot: { x: 8, y: 18, w: 4, h: 12 } },
  { id: "c_f4tileaaaa", type: "service-tile", props: { name: "Tile e2e", icon: "film" }, slot: { x: 0, y: 30, w: 3, h: 14 } },
  { id: "c_f4baraaaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: 41, percent: 41, format: "percent" }] }, slot: { x: 3, y: 30, w: 9, h: 6 } },
  { id: "c_f4groupaaa", type: "group", props: { title: "Group e2e" }, slot: { x: 0, y: 46, w: 6, h: 12 } },
  { id: "c_f4bookaaaa", type: "bookmarks", props: { items: [{ name: "Docs e2e", href: "https://docs.e2e.example" }] }, slot: { x: 6, y: 46, w: 6, h: 10 } },
  { id: "c_f4linkaaaa", type: "link", props: { label: "Link e2e", href: "https://e2e.example" }, slot: { x: 0, y: 60, w: 3, h: 5 } },
  { id: "c_f4buttaaaa", type: "button", props: { label: "Button e2e" }, slot: { x: 3, y: 60, w: 3, h: 6 } },
  { id: "c_f4divdaaaa", type: "divider", props: {}, slot: { x: 6, y: 60, w: 6, h: 3 } },
  { id: "c_f4tablaaaa", type: "table", props: { data: [{ name: "a", cpu: 1 }, { name: "b", cpu: 2 }, { name: "c", cpu: 3 }] }, slot: { x: 0, y: 68, w: 6, h: 16 } },
];

type FieldReport = { node: string; type: string; field: string; how: string; changed: boolean; reason: string | null; hint: string | null };

/**
 * Changes one setting the way a person would; returns how, or null when it is not a typed or picked
 * control (or, for a menu, when every choice has been tried). `attempt` walks a menu's choices, since the
 * first other choice may be the default the widget already draws.
 */
async function change(field: Locator, attempt: number, initial: { select?: string }): Promise<string | null> {
  const sel = field.locator("select").first();
  if (await sel.count()) {
    const opts = await sel.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    if (attempt === 0) initial.select = await sel.inputValue();
    const others = opts.filter((o) => o !== initial.select && o !== "");
    const next = others[attempt] ?? null;
    if (next === null) return null;
    await sel.selectOption(next);
    return `select ${next}`;
  }
  const num = field.locator('input[type="number"]').first();
  if (await num.count()) {
    // A second try with a bigger change, since the first may equal what the widget already draws.
    if (attempt > 1) return null;
    const cur = await num.inputValue();
    const v = attempt === 1 ? String((Number(cur) || 0) + 2) : cur === "" ? "1" : String(Number(cur) + 7);
    await num.fill(v);
    return `number ${v}`;
  }
  if (attempt > 0) return null;
  const sw = field.locator('[role="switch"]').first();
  if (await sw.count()) {
    await sw.click();
    return "switch";
  }
  const range = field.locator('input[type="range"]').first();
  if (await range.count()) {
    await range.focus();
    for (let i = 0; i < 3; i++) await range.press("ArrowRight");
    return "range";
  }
  const text = field.locator("input:not([type]), input[type=text], textarea").first();
  if (await text.count()) {
    const cur = await text.inputValue();
    // A number typed in a value box stays a number; other text gets words added.
    const v = cur.trim() !== "" && Number.isFinite(Number(cur)) ? String(Number(cur) + 7) : cur ? `${cur} e2e` : "Words e2e";
    await text.fill(v);
    return `text ${v}`;
  }
  return null;
}

test("F4 criterion 12: no fold is titled More settings; every inspector setting has a hint; changing each setting changes the canvas or shows a reason", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const slug = `w210b-f4-${RUN}`;
  await newApp(page.request, slug, F4_NODES);
  await open(page, slug);
  const folds: { node: string; title: string; holds: string[] }[] = [];
  const missingHint: string[] = [];
  const report: FieldReport[] = [];
  for (const n of F4_NODES) {
    await select(page, n.id);
    await openEverything(page);
    const insp = page.locator(`[data-inspector][data-node-id="${n.id}"]`);
    // Fold titles.
    // The component panels' folds (the builder's own Layout fold is builder D's, Wave 2.10b F4 builder half).
    for (const f of await insp.locator(':is([data-inspector-group="content"], [data-inspector-group="data"], [data-inspector-group="control"], [data-inspector-group="style"]) [data-more-settings]').all()) {
      const title = (await f.locator(":scope > button[data-more-settings-toggle]").innerText()).trim();
      const holds = await f.locator(":scope > [data-more-body] [data-field] [data-field-label], :scope > [data-more-body] [data-style-field] [data-field-label]").allInnerTexts();
      folds.push({ node: n.type, title, holds });
    }
    // Hints: every setting in Content, Data and Control (and the style switch) has a hint or a reason.
    for (const f of await insp.locator('[data-inspector-group="content"] [data-field], [data-inspector-group="data"] [data-field], [data-inspector-group="control"] [data-field]').all()) {
      const key = await f.getAttribute("data-field");
      const h = f.locator("[data-field-hint], [data-field-reason]");
      const hasHint = (await h.count()) > 0 && (await h.first().innerText()).trim().length > 0;
      if (!hasHint) missingHint.push(`${n.type}.${key}`);
    }
  }
  writeEv("f4-folds.json", { folds, missingHint });
  // Fold titles and hints first (soft, so the scripted pass below still runs and is recorded).
  expect.soft(folds.length, "the pass opened folds").toBeGreaterThan(5);
  expect.soft(folds.filter((f) => /more settings/i.test(f.title)).map((f) => `${f.node}: ${f.title}`), "no fold titled More settings").toEqual([]);
  // Each fold is titled with what it holds: its title names the settings inside.
  const vague = folds.filter((f) => f.holds.length && !f.holds.some((h) => f.title.toLowerCase().includes(h.toLowerCase())));
  expect.soft(vague.map((f) => `${f.node}: "${f.title}" holds ${f.holds.join(", ")}`), "fold titles name what they hold").toEqual([]);
  expect.soft(missingHint, "every setting has a hint").toEqual([]);
  // The scripted pass: each simple and More setting of the component (not its data source, that is the
  // builder's data picker) changes the canvas or says why it cannot show now.
  for (const n of F4_NODES) {
    await select(page, n.id);
    await openEverything(page);
    const insp = page.locator(`[data-inspector][data-node-id="${n.id}"]`);
    const keys = await insp.locator('[data-inspector-group="content"] [data-field], [data-inspector-group="data"] [data-field]:not([data-data-empty])').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-field")!).filter((k) => k && !k.includes(" ")))]);
    for (const key of keys) {
      const field = insp.locator(`[data-field="${key}"]`).first();
      if (!(await field.isVisible().catch(() => false))) continue;
      // Wait out the debounce of the previous change, then take the canvas as it is.
      await page.waitForTimeout(700);
      const before = await canvas(page, n.id).screenshot({ animations: "disabled" }).catch(() => null);
      let how: string | null = null;
      let changed = false;
      const initial: { select?: string } = {};
      for (let attempt = 0; attempt < 8 && !changed; attempt++) {
        const did = await change(field, attempt, initial);
        if (!did) break;
        how = did;
        await page.waitForTimeout(900);
        const after = await canvas(page, n.id).screenshot({ animations: "disabled" }).catch(() => null);
        changed = !!before && !!after && !before.equals(after);
      }
      if (!how) continue;
      const reasonEl = insp.locator(`[data-field="${key}"] [data-field-reason]`).first();
      const reason = (await reasonEl.count()) ? (await reasonEl.innerText()).trim() : null;
      const hintEl = insp.locator(`[data-field="${key}"] [data-field-hint]`).first();
      const hint = (await hintEl.count()) ? (await hintEl.innerText()).trim() : null;
      report.push({ node: n.id, type: n.type, field: key, how, changed, reason, hint });
    }
    await page.screenshot({ path: shot(`f4-inspector-${n.type}`) });
  }
  const silent = report.filter((r) => !r.changed && !r.reason);
  writeEv("f4.json", { folds, missingHint, silent, report });
  expect(report.length, "settings changed by the pass").toBeGreaterThan(40);
  expect(silent.map((r) => `${r.type}.${r.field} (${r.how})`), "a change that shows nothing says why").toEqual([]);
});

test("F4: a setting whose effect cannot show says why in place of its hint, and the hint returns once it can", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210b-why-${RUN}`;
  await newApp(page.request, slug, [
    { id: "c_whybarxaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: 41 }], clock: false }, slot: { x: 0, y: 0, w: 8, h: 6 } },
    { id: "c_whyclocaaa", type: "clock", props: { show: "date" }, slot: { x: 0, y: 8, w: 3, h: 10 } },
  ]);
  await open(page, slug);
  await select(page, "c_whybarxaaa");
  await openEverything(page);
  const insp = page.locator('[data-inspector][data-node-id="c_whybarxaaa"]');
  const fmt = insp.locator('[data-field="clockFormat"]');
  await expect(fmt.locator("[data-field-reason]")).toHaveText("Needs Show a clock on");
  await page.screenshot({ path: shot("f4-reason-clock-off") });
  await insp.locator('[data-field="clock"] [role="switch"]').click();
  await expect(fmt.locator("[data-field-reason]")).toHaveCount(0);
  await expect(fmt.locator("[data-field-hint]")).toBeVisible();
  await select(page, "c_whyclocaaa");
  await openEverything(page);
  await expect(page.locator('[data-inspector][data-node-id="c_whyclocaaa"] [data-field="seconds"] [data-field-reason]')).toHaveText("Needs Show set to Time, or Time and date");
  await page.screenshot({ path: shot("f4-reason-clock-date") });
});
