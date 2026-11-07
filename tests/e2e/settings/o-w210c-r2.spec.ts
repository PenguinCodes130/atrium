// Wave 2.10c round 2, builder S (gauntlet r1 Fix List 6b, 15, 16, 21), through the real UI the way the
// critics did it: the icon picker's From website in the builder, the theme editor's fields and its
// Custom CSS box, and the builder's Theme panel. Apps are set up through the API (that is not the action
// under test); every action under test is a click or a keystroke. Websites are FAKE stand-ins served by
// this test on loopback; nothing here leaves this machine. Test-only values; none are real.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { OWNER, ORIGIN, context, ev, shot } from "./helpers";

test.setTimeout(180_000);
const RUN = Date.now().toString(36).slice(-5);
const H = { origin: ORIGIN };

// ---- FAKE icons ----

/** A BMP entry for an ICO: `w` x `w` at 32 bpp, one colour. */
function dib32(w: number, rgb: [number, number, number]): Buffer {
  const b = Buffer.alloc(40 + w * w * 4 + (((w + 31) >> 5) * 4) * w);
  b.writeUInt32LE(40, 0); b.writeInt32LE(w, 4); b.writeInt32LE(w * 2, 8); b.writeUInt16LE(1, 12); b.writeUInt16LE(32, 14);
  for (let i = 0; i < w * w; i++) b.set([rgb[2], rgb[1], rgb[0], 255], 40 + i * 4);
  return b;
}
/** An ICO with 16 and 32 px entries, coloured by `seed` so each run's bytes are new. */
function ico(seed: number): Buffer {
  const rgb: [number, number, number] = [seed & 0xff, (seed >> 8) & 0xff, 120];
  const datas = [dib32(16, rgb), dib32(32, rgb)];
  const head = Buffer.alloc(6 + 32);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(2, 4);
  let offset = head.length;
  [16, 32].forEach((w, k) => {
    const at = 6 + k * 16;
    head[at] = w;
    head[at + 1] = w;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(datas[k]!.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += datas[k]!.length;
  });
  return Buffer.concat([head, ...datas]);
}

type Hit = { path: string; range: string | null };
type StandIn = { url: string; hits: Hit[]; close: () => Promise<void> };
type Route = { type: string; body: Buffer };

/** One FAKE website on loopback that answers `Range: bytes=0-N` with 206, as most servers do. */
async function standIn(routes: Record<string, Route>): Promise<StandIn> {
  const hits: Hit[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const p = (req.url ?? "/").split("?")[0]!;
    const range = typeof req.headers.range === "string" ? req.headers.range : null;
    hits.push({ path: p, range });
    const r = routes[p];
    if (!r) return res.writeHead(404, { "content-type": "text/plain" }).end("not here");
    const m = range ? /^bytes=0-(\d+)$/.exec(range) : null;
    if (m) {
      const part = r.body.subarray(0, Number(m[1]) + 1);
      return res.writeHead(206, { "content-type": r.type, "content-length": String(part.length), "content-range": `bytes 0-${part.length - 1}/${r.body.length}` }).end(part);
    }
    res.writeHead(200, { "content-type": r.type, "content-length": String(r.body.length) }).end(r.body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}
const page = (head: string, filler = "") => ({ type: "text/html; charset=utf-8", body: Buffer.from(`<!doctype html><html><head><title>FAKE e2e project site</title>${head}</head><body>FAKE${filler}</body></html>`) });

// ---- Apps (set up through the API) ----

type Node = { id: string; type: string; props: Record<string, unknown>; slot?: { x: number; y: number; w: number; h: number } };
async function newApp(req: APIRequestContext, slug: string, kids: Node[], extra: unknown[] = []): Promise<string> {
  const r = await req.post("/api/apps", { data: { name: `Settings r2 ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await (await req.get(`/api/apps/${id}/draft`)).json();
  const rootId = d.doc.pages[0].root.id as string;
  const ops = [...extra, ...kids.map((n) => ({ op: "node.add", parentId: rootId, node: n }))];
  if (!ops.length) return id;
  const o = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops }, headers: H });
  expect(o.ok(), await o.text()).toBe(true);
  return id;
}
async function iconName(req: APIRequestContext, appId: string, nodeId: string): Promise<unknown> {
  const d = await (await req.get(`/api/apps/${appId}/draft`)).json();
  const find = (n: { id: string; props: Record<string, unknown>; children?: unknown[] }): unknown => (n.id === nodeId ? n.props.name : (n.children ?? []).map((c) => find(c as never)).find((x) => x !== undefined));
  return find(d.doc.pages[0].root);
}
async function openBuilder(p: Page, slug: string) {
  await p.goto(`/build/${slug}`);
  await expect(p.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
async function select(p: Page, id: string) {
  await p.locator('[data-left-tab="layers"]').click();
  await p.locator(`[data-layer="${id}"]`).click();
  await expect(p.locator(`[data-inspector][data-node-id="${id}"]`)).toBeVisible();
}
/** Types an address into the icon picker's From website and presses Get icon, as a person would. */
async function fromWebsite(p: Page, address: string) {
  await p.locator('[data-inspector] [data-icon-pick="name"]').click();
  const picker = p.locator("[data-icon-picker]");
  await picker.locator("[data-icon-from-website]").click();
  await picker.locator("[data-website-url]").click();
  await picker.locator("[data-website-url]").pressSequentially(address, { delay: 5 });
  await picker.locator("[data-website-fetch]").click();
  await expect(picker.locator('[data-favicon-preview="ready"], [data-favicon-error]').first()).toBeVisible({ timeout: 12_000 });
  return picker;
}
const save = (name: string, data: unknown) => writeFileSync(ev("pass", `${name}.json`), JSON.stringify(data, null, 2));
const desktopOnly = (name: string) => test.skip(name !== "desktop", "once, at 1280");

test.describe("Wave 2.10c round 2 (settings)", () => {
  test("16: From website finds an icon a big page declares at /images/favicon.ico (no /favicon.ico at the root)", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    // Like a popular project's site: a 600 KB page whose head declares the icon under /images/.
    const site = await standIn({ "/": page(`<link data-rh="true" rel="icon" href="/images/favicon.ico">`, "x".repeat(600 * 1024)), "/images/favicon.ico": { type: "image/vnd.microsoft.icon", body: ico(Date.now() % 60000) } });
    const ctx = await context(browser, OWNER);
    const p = await ctx.newPage();
    try {
      const slug = `s-r2-16-${RUN}`;
      const appId = await newApp(p.request, slug, [{ id: "c_ssixteenaa", type: "icon", props: { name: "server", scale: 50 }, slot: { x: 0, y: 0, w: 2, h: 10 } }]);
      await openBuilder(p, slug);
      await select(p, "c_ssixteenaa");
      const picker = await fromWebsite(p, site.url);
      await shot(p, "16-from-website-big-page");
      await expect(picker.locator("[data-favicon-error]")).toHaveCount(0);
      const stored = await picker.locator("[data-from-website] [data-favicon-img]").getAttribute("data-favicon-img");
      expect(stored).toMatch(/^\/uploads\/[a-z0-9]{20}\.png$/);
      await picker.locator("[data-favicon-use]").click();
      await expect.poll(() => iconName(p.request, appId, "c_ssixteenaa")).toBe(stored);
      // The server read the page whole (too large), then its first 512 KB, then the declared icon.
      expect(site.hits).toEqual([{ path: "/", range: null }, { path: "/", range: "bytes=0-524287" }, { path: "/images/favicon.ico", range: null }]);
      save("16-big-page", { stored, hits: site.hits });
    } finally {
      await ctx.close();
      await site.close();
    }
  });

  test("6b: an icon fetched for one page is not answered for the bare site; the same address is", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const site = await standIn({
      "/~member/page": page(`<link rel="icon" href="/~member/chosen.ico">`),
      "/~member/chosen.ico": { type: "image/x-icon", body: ico(1000 + (Date.now() % 9000)) },
      "/": page(`<link rel="icon" href="/site.ico">`),
      "/site.ico": { type: "image/x-icon", body: ico(20000 + (Date.now() % 9000)) },
    });
    const ctx = await context(browser, OWNER);
    const p = await ctx.newPage();
    try {
      const slug = `s-r2-6b-${RUN}`;
      await newApp(p.request, slug, [{ id: "c_ssixbaaaaa", type: "icon", props: { name: "server", scale: 50 }, slot: { x: 0, y: 0, w: 2, h: 10 } }]);
      await openBuilder(p, slug);
      await select(p, "c_ssixbaaaaa");
      let picker = await fromWebsite(p, `${site.url}/~member/page`);
      const pinned = await picker.locator("[data-from-website] [data-favicon-img]").getAttribute("data-favicon-img");
      await picker.locator("[data-favicon-cancel]").click();
      await p.keyboard.press("Escape");
      const before = site.hits.length;
      picker = await fromWebsite(p, `${site.url}/`);
      const bare = await picker.locator("[data-from-website] [data-favicon-img]").getAttribute("data-favicon-img");
      await shot(p, "6b-bare-site-own-icon");
      expect(bare).toMatch(/^\/uploads\//);
      expect(bare, "the bare site gets its own icon, not the page's").not.toBe(pinned);
      expect(site.hits.slice(before).map((h) => h.path)).toEqual(["/", "/site.ico"]);
      await picker.locator("[data-favicon-cancel]").click();
      await p.keyboard.press("Escape");
      // The same address again answers from the store: no new request to the site.
      const n = site.hits.length;
      picker = await fromWebsite(p, `${site.url}/~member/page`);
      expect(await picker.locator("[data-from-website] [data-favicon-img]").getAttribute("data-favicon-img")).toBe(pinned);
      expect(site.hits.length).toBe(n);
      save("6b-exact-key", { pinned, bare, hits: site.hits });
    } finally {
      await ctx.close();
      await site.close();
    }
  });

  test("15: the theme editor has a Scrollbar control (colour, 4/6/8 px) that every thumb follows", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const ctx = await context(browser, OWNER);
    const p = await ctx.newPage();
    try {
      await p.goto("/settings/themes/new");
      await expect(p.locator("[data-theme-editor]")).toBeVisible();
      const name = `Scrollbar e2e ${RUN}`;
      await p.locator('[data-field="name"]').fill(name);
      await p.locator('[data-group-toggle="shape"]').click();
      const thumb = p.locator('[data-field="scrollbar.thumb"]');
      await expect(thumb).toBeVisible();
      await thumb.fill("");
      await thumb.pressSequentially("#d0342c");
      await p.locator('[data-field="scrollbar.widthPx"]').getByRole("radio", { name: /8 px/ }).click();
      await shot(p, "15-scrollbar-control");
      await p.locator("[data-save-theme]").click();
      await p.waitForURL(/\/settings\/themes\/(?!new)[a-z0-9-]+$/, { timeout: 15_000 });
      const themeId = new URL(p.url()).pathname.split("/").pop()!;
      const saved = await (await p.request.get(`/api/settings/themes/${themeId}`)).json();
      expect(saved.theme.tokens.scrollbar).toEqual({ thumb: "#d0342c", widthPx: 8 });
      // An app on that theme: the table's drawn thumb takes the colour and the width.
      const rows = Array.from({ length: 30 }, (_, i) => ({ name: `FAKE machine ${i + 1}`, cpu: i }));
      const slug = `s-r2-15-${RUN}`;
      await newApp(p.request, slug, [{ id: "c_sfifteenta", type: "table", props: { data: rows }, slot: { x: 0, y: 0, w: 6, h: 24 } }], [{ op: "theme.set", theme: { themeId } }]);
      await openBuilder(p, slug);
      const thumbEl = p.locator('[data-canvas-root] [data-node="c_sfifteenta"] .atr-scroll-thumb').first();
      await expect(thumbEl).toBeAttached({ timeout: 15_000 });
      await p.locator('[data-canvas-root] [data-node="c_sfifteenta"]').hover();
      const look = await thumbEl.evaluate((el) => { const s = getComputedStyle(el); return { width: s.width, background: s.backgroundColor }; });
      await shot(p, "15-thumb-on-canvas");
      expect(look).toEqual({ width: "8px", background: "rgb(208, 52, 44)" });
      save("15-scrollbar", { themeId, tokens: saved.theme.tokens.scrollbar, look });
    } finally {
      await ctx.close();
    }
  });

  test("15: the theme's Custom CSS box names what it drops, and how to set a token instead", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const ctx = await context(browser, OWNER);
    const p = await ctx.newPage();
    try {
      await p.goto("/settings/themes/new");
      await p.locator('[data-group-toggle="advanced"]').click();
      const box = p.locator('[data-field="customCss"]');
      await box.click();
      await box.pressSequentially(":root{--theme-scrollbar-width:14px} .ok{color:red} .bad{color:expression(1)}", { delay: 2 });
      const removed = p.locator("[data-css-removed] li");
      await expect(removed.first()).toBeVisible({ timeout: 5_000 });
      const lines = await removed.allTextContents();
      await shot(p, "15-theme-css-removed");
      expect(lines.some((l) => l.includes(":root") && /outside the canvas/.test(l))).toBe(true);
      expect(lines.some((l) => l.includes("color:expression(1)"))).toBe(true);
      expect(lines.some((l) => l.includes(".ok"))).toBe(false);
      await expect(p.locator("[data-css-token-hint]")).toContainText(":scope");
      // Fixed as the hint says: nothing is removed any more.
      await box.fill(":scope{--theme-scrollbar-width:14px} .ok{color:red}");
      await expect(p.locator("[data-css-removed]")).toHaveCount(0, { timeout: 5_000 });
      save("15-theme-css", { lines });
    } finally {
      await ctx.close();
    }
  });

  test("21: New theme from this one stores nothing until Save", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const ctx = await context(browser, OWNER);
    const p = await ctx.newPage();
    try {
      const slug = `s-r2-21-${RUN}`;
      await newApp(p.request, slug, []);
      const count = async () => ((await (await p.request.get("/api/settings/themes")).json()).themes as unknown[]).length;
      const before = await count();
      await openBuilder(p, slug);
      await p.locator("[data-builder-theme]").click();
      await p.locator("[data-theme-new]").click();
      await expect(p.locator("[data-theme-editor]")).toBeVisible({ timeout: 10_000 });
      await shot(p, "21-new-theme-open");
      const opened = await count();
      // Leave without saving.
      await p.locator("[data-theme-close]").click();
      await p.waitForTimeout(800);
      const after = await count();
      save("21-new-theme", { before, opened, after });
      expect(opened, "opening the editor stored nothing").toBe(before);
      expect(after, "closing without Save stored nothing").toBe(before);
      // Saving stores it and puts it on the app.
      await p.locator("[data-builder-theme]").click();
      await p.locator("[data-theme-new]").click();
      await p.locator("[data-theme-sheet] [data-save-theme]").click();
      await expect.poll(count, { timeout: 10_000 }).toBe(before + 1);
    } finally {
      await ctx.close();
    }
  });
});
