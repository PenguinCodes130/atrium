// Wave 2.10a round 2, builder C (components): the gauntlet r1 Fix List items 2, 4 (component half), 6, 7
// and 15, plus the cheap lows (sample bar hint, hover shadow, units on one line) and the table overflow
// report (item 14, component half). Each test does what the critic did, through the real builder and the
// published viewer, and was recorded failing on the code as it was before the fix
// (evidence/components/w210a-r2/failing-first/). Served by tests/e2e/components/serve.sh (port 3114).
// Test-only values; none are real credentials. Addresses are FAKE (example.test, 127.0.0.1).
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn } from "./helpers";

test.describe.configure({ timeout: 240_000 });
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
const EV = path.resolve(here, `../../../evidence/components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "w210a-r2"}`);
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixtures edit a theme document loosely
type Doc = Record<string, any>;

async function draft(req: APIRequestContext, id: string): Promise<Draft> {
  return (await req.get(`/api/apps/${id}/draft`)).json();
}
async function ops(req: APIRequestContext, id: string, list: unknown[]) {
  const d = await draft(req, id);
  const r = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function newApp(req: APIRequestContext, slug: string, kids: Node[] = []): Promise<{ id: string; rootId: string }> {
  const r = await req.post("/api/apps", { data: { name: `R2 ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await draft(req, id);
  const rootId = d.doc.pages[0]!.root.id;
  if (kids.length) await ops(req, id, kids.map((n) => ({ op: "node.add", parentId: rootId, node: n })));
  return { id, rootId };
}
async function publish(req: APIRequestContext, appId: string) {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note: "w210a-r2" }, headers: H });
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
async function view(page: Page, slug: string, id: string) {
  await page.goto(`/a/${slug}`);
  await expect(page.locator(`[data-node="${id}"]`).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);
}
/** A copy of a built-in theme at the given density, made through the real settings API. */
const themeCopies = new Map<string, string>();
async function themeAt(req: APIRequestContext, base: string, density: "comfortable" | "compact"): Promise<string> {
  const key = `${base}-${density}`;
  if (themeCopies.has(key)) return themeCopies.get(key)!;
  const dup = await req.post(`/api/settings/themes/${base}/duplicate`, { headers: H });
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  const cur = await (await req.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme) as Doc;
  theme.name = `${base} ${density} r2 ${RUN}`;
  theme.tokens.space = { ...theme.tokens.space, density };
  const put = await req.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev }, headers: H });
  expect(put.status(), await put.text()).toBe(200);
  themeCopies.set(key, id);
  return id;
}
async function useTheme(req: APIRequestContext, appId: string, themeId: string) {
  await ops(req, appId, [{ op: "theme.set", theme: { themeId } }]);
}
/** Names whose text is cut (ellipsis or clamp): scrollWidth or scrollHeight past the box. */
async function cutNames(scope: Locator): Promise<{ name: string; w: number; sw: number; h: number; sh: number }[]> {
  return scope.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>(".atr-tile-name"))
      .map((e) => ({ name: e.textContent ?? "", w: e.clientWidth, sw: e.scrollWidth, h: e.clientHeight, sh: e.scrollHeight }))
      .filter((x) => x.sw > x.w + 1 || x.sh > x.h + 1 || x.w < 8),
  );
}

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project; the phone width is set per test");
  await signIn(context, page.request);
  await page.context().addCookies([{ name: "atrium_swept", value: "1", url: ORIGIN }]);
});

const SERVICES = ["Jellyfin", "Sonarr", "Radarr", "Prowlarr", "Bazarr", "Overseerr", "Tautulli", "Lidarr"];
const DOWN = { kind: "status", items: [{ label: "FAKE", state: "down", detail: "Connection refused" }] };
const tiles = (prefix: string, n = 8, status: unknown = DOWN): Node[] =>
  SERVICES.slice(0, n).map((name, i) => ({ id: `c_${prefix}${"abcdefgh"[i]}aaaaaaa`, type: "service-tile", props: { name, description: "FAKE e2e", href: `https://${name.toLowerCase()}.example.test/`, newTab: true, status, stats: [] } }));

// ---------- item 2: an icon draws the same size in builder and viewer, whatever its neighbours ----------
test("item 2: a filling icon holds its drawn box in the viewer, alone and beside a tall group, so it draws as in the builder and twice the box draws about twice the icon", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const out: Record<string, unknown> = {};
  for (const scene of ["alone", "beside-group"] as const) {
    const slug = `r2-icons-${scene}-${RUN}`;
    const kids: Node[] = [
      { id: "c_r2iconaaaa", type: "icon", props: { name: "server", size: 24, fill: true }, slot: { x: 0, y: 0, w: 1.375, h: 10 } },
      { id: "c_r2icon2aaa", type: "icon", props: { name: "server", size: 24, fill: true }, slot: { x: 2, y: 0, w: 2.75, h: 20 } },
    ];
    // A group whose tiles need far more than its 12 rows: the viewer grows those rows.
    if (scene === "beside-group") kids.push({ id: "c_r2icgrpaaa", type: "group", props: { title: "Tall", columns: 2 }, slot: { x: 4, y: 0, w: 8, h: 12 }, children: tiles("ig", 8) });
    const app = await newApp(page.request, slug, kids);
    await open(page, slug);
    await expect(canvas(page, "c_r2icon2aaa")).toBeVisible();
    await page.waitForTimeout(500);
    const measure = async (root: (id: string) => Locator) => {
      const r: Record<string, { box: { w: number; h: number }; icon: number }> = {};
      for (const id of ["c_r2iconaaaa", "c_r2icon2aaa"]) {
        const b = (await root(id).boundingBox())!;
        const s = (await root(id).locator("svg").first().boundingBox())!;
        r[id] = { box: { w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 }, icon: Math.round(s.width * 10) / 10 };
      }
      return r;
    };
    const builder = await measure((id) => canvas(page, id));
    await page.screenshot({ path: shot(`item2-${scene}-builder`) });
    await publish(page.request, app.id);
    await view(page, slug, "c_r2icon2aaa");
    const viewer = await measure((id) => page.locator(`[data-node="${id}"]`).first());
    await page.screenshot({ path: shot(`item2-${scene}-viewer`), fullPage: true });
    out[scene] = { builder, viewer };
    for (const id of ["c_r2iconaaaa", "c_r2icon2aaa"]) {
      // The node box keeps the height it was drawn at (its width follows the wider viewer columns).
      expect(Math.abs(viewer[id]!.box.h - builder[id]!.box.h), `${scene} ${id}: viewer box ${viewer[id]!.box.h}px tall, builder ${builder[id]!.box.h}px`).toBeLessThanOrEqual(2);
      // And the icon is half its box's shorter side, as in the builder.
      const want = Math.min(viewer[id]!.box.w, viewer[id]!.box.h) / 2;
      expect(Math.abs(viewer[id]!.icon - want), `${scene} ${id}: icon ${viewer[id]!.icon}px, half the shorter side is ${want}px`).toBeLessThanOrEqual(2);
    }
    const boxRatio = Math.min(viewer.c_r2icon2aaa!.box.w, viewer.c_r2icon2aaa!.box.h) / Math.min(viewer.c_r2iconaaaa!.box.w, viewer.c_r2iconaaaa!.box.h);
    const iconRatio = viewer.c_r2icon2aaa!.icon / viewer.c_r2iconaaaa!.icon;
    expect(Math.abs(iconRatio - boxRatio), `${scene}: icon ratio ${iconRatio.toFixed(2)} vs box ratio ${boxRatio.toFixed(2)}`).toBeLessThanOrEqual(0.15);
    expect(iconRatio, `${scene}: the bigger box draws a bigger icon (x${iconRatio.toFixed(2)})`).toBeGreaterThan(1.8);
  }
  writeEv("item2-icons.json", out);
});

// ---------- item 4 (component half): Compact tightens title bars and service tiles ----------
test("item 4: at Compact a card's title bar is 19px (28 at Comfortable) and service tiles, the group and the resource bar tighten, in the builder and the viewer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `r2-density-${RUN}`;
  const app = await newApp(page.request, slug, [
    { id: "c_r2dcardaaa", type: "card", props: { title: "Rack" }, slot: { x: 0, y: 0, w: 4, h: 20 }, children: [{ id: "c_r2dstataaa", type: "stat", props: { label: "CPU", value: 41, unit: "%" } }] },
    { id: "c_r2dgrpaaaa", type: "group", props: { title: "Media", columns: 2 }, slot: { x: 4, y: 0, w: 8, h: 30 }, children: tiles("dn", 4, "running") },
    { id: "c_r2dbaraaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: 12, percent: 12, format: "percent" }], clock: false, search: false }, slot: { x: 0, y: 30, w: 12, h: 9 } },
  ]);
  const read = async (scope: Locator) =>
    scope.evaluate((root) => {
      const px = (e: Element | null, p: string) => (e ? parseFloat(getComputedStyle(e).getPropertyValue(p)) : NaN);
      const tile = root.querySelector('[data-node="c_r2dgrpaaaa"] .atr-tile');
      const bar = root.querySelector('[data-node="c_r2dbaraaaa"] .atr-bar');
      return {
        titlebar: root.querySelector('[data-node="c_r2dcardaaa"] .atr-titlebar')?.getBoundingClientRect().height ?? null,
        tilePadTop: px(tile, "padding-top"),
        tilePadLeft: px(tile, "padding-left"),
        tileH: tile?.getBoundingClientRect().height ?? null,
        groupHead: root.querySelector('[data-node="c_r2dgrpaaaa"] .atr-group-head')?.getBoundingClientRect().height ?? null,
        barPadTop: px(bar, "padding-top"),
      };
    });
  const out: Record<string, unknown> = {};
  for (const density of ["comfortable", "compact"] as const) {
    await useTheme(page.request, app.id, await themeAt(page.request, "control-room", density));
    await open(page, slug);
    await expect(canvas(page, "c_r2dbaraaaa")).toBeVisible();
    await page.waitForTimeout(400);
    const b = await read(page.locator("[data-canvas-root]"));
    await page.screenshot({ path: shot(`item4-builder-${density}`) });
    await publish(page.request, app.id);
    await view(page, slug, "c_r2dbaraaaa");
    const v = await read(page.locator(".atr-render-root").first());
    await page.screenshot({ path: shot(`item4-viewer-${density}`), fullPage: true });
    out[density] = { builder: b, viewer: v };
  }
  writeEv("item4-density.json", out);
  const c = out.comfortable as { builder: Record<string, number>; viewer: Record<string, number> };
  const k = out.compact as { builder: Record<string, number>; viewer: Record<string, number> };
  for (const where of ["builder", "viewer"] as const) {
    expect(c[where].titlebar, `${where}: comfortable title bar`).toBeCloseTo(28, 0);
    expect(k[where].titlebar, `${where}: compact title bar ${k[where].titlebar}px (28 x 0.67 = 19)`).toBeCloseTo(19, 0);
    expect(k[where].tilePadTop, `${where}: tile padding ${c[where].tilePadTop} -> ${k[where].tilePadTop}`).toBeLessThanOrEqual(c[where].tilePadTop! * 0.7);
    expect(k[where].tileH!, `${where}: tile height ${c[where].tileH} -> ${k[where].tileH}`).toBeLessThan(c[where].tileH! - 6);
    expect(k[where].groupHead!, `${where}: group heading ${c[where].groupHead} -> ${k[where].groupHead}`).toBeLessThan(c[where].groupHead!);
    expect(k[where].barPadTop!, `${where}: bar padding ${c[where].barPadTop} -> ${k[where].barPadTop}`).toBeLessThan(c[where].barPadTop!);
  }
});

// ---------- item 6: a tile always shows its name ----------
test("item 6: in a 4-column group in the default builder view at 1440 and in the viewer at the same width, every tile name shows in full; a group that keeps its height stops adding columns before names are cut", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `r2-names-${RUN}`;
  const app = await newApp(page.request, slug, [
    { id: "c_r2ngrpaaaa", type: "group", props: { title: "Media", columns: 4 }, slot: { x: 0, y: 0, w: 12, h: 30 }, children: tiles("nm", 8) },
    { id: "c_r2nkeepaaa", type: "group", props: { title: "Kept", columns: 2, fixedHeight: true }, slot: { x: 0, y: 30, w: 12, h: 16 }, children: tiles("nk", 8) },
  ]);
  await open(page, slug);
  await expect(canvas(page, "c_r2nkeepaaa")).toBeVisible();
  await page.waitForTimeout(600);
  const canvasW = await page.locator("[data-canvas-root] .atr-grid").first().evaluate((e) => e.getBoundingClientRect().width);
  const inBuilder = await cutNames(canvas(page, "c_r2ngrpaaaa"));
  const keptBuilder = await cutNames(canvas(page, "c_r2nkeepaaa"));
  const keptCols = await canvas(page, "c_r2nkeepaaa").locator('[data-slot="root"]').first().getAttribute("data-columns");
  const keptShown = await canvas(page, "c_r2nkeepaaa").locator("[data-group-item]").count();
  await page.screenshot({ path: shot("item6-builder-1440") });
  await publish(page.request, app.id);
  // The viewer at about the builder canvas's width.
  await page.setViewportSize({ width: Math.round(canvasW) + 32, height: 900 });
  await view(page, slug, "c_r2nkeepaaa");
  const inViewer = await cutNames(page.locator('[data-node="c_r2ngrpaaaa"]').first());
  const keptViewer = await cutNames(page.locator('[data-node="c_r2nkeepaaa"]').first());
  const keptShownViewer = await page.locator('[data-node="c_r2nkeepaaa"] [data-group-item]').count();
  await page.screenshot({ path: shot("item6-viewer-narrow"), fullPage: true });
  writeEv("item6-names.json", { canvasW, keptCols, keptShown, keptShownViewer, inBuilder, keptBuilder, inViewer, keptViewer });
  // The kept-height box has room for a row of tiles: it shows some, not only "+N more".
  expect(keptShown, "builder: tiles shown in the kept-height group").toBeGreaterThan(0);
  expect(keptShownViewer, "viewer: tiles shown in the kept-height group").toBeGreaterThan(0);
  expect(inBuilder, `builder (canvas ${Math.round(canvasW)}px): cut names`).toEqual([]);
  expect(inViewer, "viewer: cut names").toEqual([]);
  expect(keptBuilder, `builder kept-height group (${keptCols} columns): cut names`).toEqual([]);
  expect(keptViewer, "viewer kept-height group: cut names").toEqual([]);
});

// ---------- item 7: an unchecked service is neutral, with its reason on tap or focus ----------
test("item 7: a tile whose address Atrium does not check shows a neutral Not checked badge, and its reason shows on keyboard focus and on a tap of the badge", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `r2-unchecked-${RUN}`;
  const REASON = "Atrium does not check addresses on this server itself or link-local addresses.";
  const app = await newApp(page.request, slug, [
    { id: "c_r2uchkaaaa", type: "service-tile", props: { name: "Local thing", description: "FAKE e2e", href: "http://127.0.0.1:9/", newTab: true, status: { kind: "status", items: [{ label: "127.0.0.1", state: "down", detail: REASON }] }, stats: [] }, slot: { x: 0, y: 0, w: 4, h: 14 } },
    { id: "c_r2udownaaa", type: "service-tile", props: { name: "Really down", description: "FAKE e2e", href: "https://down.example.test/", newTab: true, status: DOWN, stats: [] }, slot: { x: 4, y: 0, w: 4, h: 14 } },
  ]);
  await publish(page.request, app.id);
  await view(page, slug, "c_r2uchkaaaa");
  const tile = page.locator('[data-node="c_r2uchkaaaa"]').first();
  const badge = tile.locator('[data-slot="badge"]');
  const read = async () => badge.evaluate((b) => ({ word: (b.querySelector("[aria-hidden]:not(.atr-badge-dot)") as HTMLElement | null)?.textContent ?? b.textContent, tone: b.getAttribute("data-tone"), state: b.getAttribute("data-badge-state"), border: getComputedStyle(b).borderTopColor }));
  const unchecked = await read();
  const realDown = await page.locator('[data-node="c_r2udownaaa"] [data-slot="badge"]').evaluate((b) => ({ tone: b.getAttribute("data-tone"), border: getComputedStyle(b).borderTopColor }));
  const reasonShown = async () => page.getByText(REASON, { exact: false }).filter({ visible: true }).count();
  const atRest = await reasonShown();
  // Keyboard focus on the tile shows the reason.
  await tile.locator("a.atr-tile").first().focus();
  await page.waitForTimeout(150);
  const onFocus = await reasonShown();
  await page.screenshot({ path: shot("item7-focus") });
  await tile.locator("a.atr-tile").first().blur();
  // A tap (click) on the badge shows it and does not open the address.
  const pages = page.context().pages().length;
  await badge.click();
  await page.waitForTimeout(250);
  const onTap = await reasonShown();
  const opened = page.context().pages().length - pages;
  await page.screenshot({ path: shot("item7-tap") });
  writeEv("item7-unchecked.json", { unchecked, realDown, atRest, onFocus, onTap, opened });
  expect(String(unchecked.word).trim(), "the badge word").toBe("Not checked");
  expect(unchecked.tone, "neutral tone").not.toBe("bad");
  expect(unchecked.border, "not drawn in the down colour").not.toBe(realDown.border);
  expect(realDown.tone, "a real failure still reads as down").toBe("bad");
  expect(onFocus, "reason visible on keyboard focus").toBeGreaterThan(0);
  expect(onTap, "reason visible after a tap on the badge").toBeGreaterThan(0);
  expect(opened, "the tap on the badge opened no tab").toBe(0);
});

// ---------- item 15: Table Columns accepts the headers people see ----------
const TABLE = { kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, { key: "cpu", label: "CPU", type: "number", format: "percent" }, { key: "mem", label: "Memory", type: "number", format: "percent" }, { key: "disk", label: "Disk (/)", type: "number", format: "percent" }], rows: [{ name: "pve1", cpu: 7.8, mem: 40.1, disk: 61 }, { name: "pve2", cpu: 12, mem: 22, disk: 30 }] };
test("item 15: typing the visible headers into Table > Columns shows those columns, and a name that matches nothing says so", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `r2-columns-${RUN}`;
  const app = await newApp(page.request, slug, [{ id: "c_r2tablaaaa", type: "table", props: { maxRows: 20, data: TABLE }, slot: { x: 0, y: 0, w: 12, h: 30 } }]);
  await open(page, slug);
  await select(page, "c_r2tablaaaa");
  const field = page.locator('[data-inspector] [data-field="columns"] input').first();
  await expect(field).toBeVisible();
  await field.click();
  await field.fill("");
  await field.pressSequentially("Name, Disk (/), cpu", { delay: 20 });
  await untilDraft(page.request, app.id, (d) => (nodes(d).find((n) => n.id === "c_r2tablaaaa")?.props.columns as string[] | undefined)?.length === 3);
  const t = canvas(page, "c_r2tablaaaa");
  await page.waitForTimeout(300);
  const heads = await t.locator("th").allTextContents();
  const typed = await field.inputValue();
  await page.screenshot({ path: shot("item15-headers") });
  await field.fill("Name, Nope");
  await page.waitForTimeout(500);
  const heads2 = await t.locator("th").allTextContents();
  const note = await t.getByText(/No column called .?Nope/).count() + (await page.locator("[data-inspector]").getByText(/No column called .?Nope/).count());
  await page.screenshot({ path: shot("item15-unknown") });
  writeEv("item15-columns.json", { heads, typed, heads2, note });
  expect(typed, "the field keeps what was typed, commas included").toBe("Name, Disk (/), cpu");
  expect(heads, "columns by their headers, in the typed order").toEqual(["Name", "Disk (/)", "CPU"]);
  expect(heads2).toEqual(["Name"]);
  expect(note, "a message names the column that matches nothing").toBeGreaterThan(0);
});

// ---------- item 14 (component half) and the units low: a table reports its overflow; units stay put ----------
test("item 14 and units: a narrow table says how much it hides sideways, and at 390px a number and its unit stay on one line", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `r2-tablewide-${RUN}`;
  const wide = { ...TABLE, columns: [...TABLE.columns, { key: "up", label: "Uptime", type: "number", format: "seconds" }, { key: "temp", label: "Temperature", type: "number", format: "celsius" }], rows: TABLE.rows.map((r, i) => ({ ...r, up: 270000 + i, temp: 55 })) };
  const app = await newApp(page.request, slug, [{ id: "c_r2twidaaaa", type: "table", props: { maxRows: 20, data: wide }, slot: { x: 0, y: 0, w: 3, h: 30 } }]);
  await open(page, slug);
  const t = canvas(page, "c_r2twidaaaa");
  await expect(t).toBeVisible();
  await page.waitForTimeout(400);
  const report = await t.evaluate((n) => {
    const w = n.querySelector(".atr-table-wrap") as HTMLElement | null;
    return { attr: w?.getAttribute("data-overflow-x") ?? null, hidden: w?.getAttribute("data-hidden-columns") ?? null, sw: w?.scrollWidth ?? 0, cw: w?.clientWidth ?? 0 };
  });
  await publish(page.request, app.id);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const cookies = await page.context().cookies();
  await phone.addCookies(cookies);
  const p = await phone.newPage();
  await p.goto(`${ORIGIN}/a/${slug}`);
  await expect(p.locator('[data-node="c_r2twidaaaa"]').first()).toBeVisible({ timeout: 15_000 });
  await p.waitForTimeout(400);
  const wrapped = await p.locator('[data-node="c_r2twidaaaa"] td[data-type="number"]').evaluateAll((cells) =>
    cells.map((c) => {
      const range = document.createRange();
      range.selectNodeContents(c);
      const lines = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
      return { text: c.textContent, lines: lines.size };
    }).filter((x) => x.lines > 1),
  );
  await p.screenshot({ path: shot("units-390"), fullPage: true });
  await phone.close();
  writeEv("item14-units.json", { report, wrapped });
  expect(report.sw, "the narrow table does hide columns").toBeGreaterThan(report.cw);
  expect(Number(report.attr), `data-overflow-x reports the hidden width (${report.sw - report.cw}px)`).toBeGreaterThanOrEqual(report.sw - report.cw - 1);
  expect(Number(report.hidden), "data-hidden-columns counts the cut columns").toBeGreaterThan(0);
  expect(wrapped, "number cells on more than one line at 390px").toEqual([]);
});

// ---------- lows: the sample-reading bar in the viewer; the hover lift's shadow ----------
test("lows: a resource bar left on sample readings shows a hint in the viewer instead of an empty card, and a tile's hover lift deepens its shadow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `r2-lows-${RUN}`;
  const app = await newApp(page.request, slug, [
    { id: "c_r2lbaraaaa", type: "resource-bar", props: { items: [], clock: true, clockFormat: "date-time", search: true, searchUrl: "https://duckduckgo.com/?q={q}" }, slot: { x: 0, y: 0, w: 12, h: 12 } },
    { id: "c_r2ltileaaa", type: "service-tile", props: { name: "Lift", description: "FAKE e2e", href: "https://lift.example.test/", newTab: true, stats: [] }, slot: { x: 0, y: 12, w: 3, h: 14 } },
  ]);
  await useTheme(page.request, app.id, "dusk");
  await publish(page.request, app.id);
  await view(page, slug, "c_r2lbaraaaa");
  const bar = page.locator('[data-node="c_r2lbaraaaa"]').first();
  const hint = await bar.getByText(/no readings/i).count();
  const tile = page.locator('[data-node="c_r2ltileaaa"] a.atr-tile').first();
  const shadow = () => tile.evaluate((e) => getComputedStyle(e).boxShadow);
  await page.mouse.move(2, 2);
  const rest = await shadow();
  await tile.hover();
  await page.waitForTimeout(300);
  const hover = await shadow();
  await page.screenshot({ path: shot("lows-viewer") });
  writeEv("lows.json", { hint, rest, hover });
  expect(hint, "the viewer's empty bar names what is missing").toBeGreaterThan(0);
  expect(hover, "the hover shadow differs from the resting one").not.toBe(rest);
});
