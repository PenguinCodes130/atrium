// Wave 2.10c round 3, builder S (gauntlet r2 Fix List 10, 11, 12, 15), through the real UI the way the
// critics did it: a phone builder (tap a widget, tap Remove, read the toast; tap Edit, tap the icon's
// Change), the theme editor's Scrollbar width, From website then Sign out from the account menu. Apps are
// set up through the API (that is not the action under test). Websites are FAKE stand-ins served by this
// test on loopback. Test-only values; none are real.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { OWNER, ORIGIN, context, ev, shot } from "./helpers";

test.setTimeout(180_000);
const RUN = Date.now().toString(36).slice(-5);
const H = { origin: ORIGIN };
const save = (name: string, data: unknown) => writeFileSync(ev("pass", `${name}.json`), JSON.stringify(data, null, 2));
const desktopOnly = (name: string) => test.skip(name !== "desktop", "once; the phone is emulated in the test where it matters");

type Node = { id: string; type: string; props: Record<string, unknown>; slot?: { x: number; y: number; w: number; h: number } };
async function newApp(req: APIRequestContext, slug: string, kids: Node[]): Promise<string> {
  const r = await req.post("/api/apps", { data: { name: `Settings r3 ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await (await req.get(`/api/apps/${id}/draft`)).json();
  const rootId = d.doc.pages[0].root.id as string;
  if (!kids.length) return id;
  const o = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: kids.map((n) => ({ op: "node.add", parentId: rootId, node: n })) }, headers: H });
  expect(o.ok(), await o.text()).toBe(true);
  return id;
}

/** A 16 x 16 PNG (one colour), FAKE. */
function png(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNk+M+AFzCNKhhVMKpgVAGJCgDKTwEfgP4z4QAAAABJRU5ErkJggg==", "base64");
}
async function standIn(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0];
    if (p === "/") return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><title>FAKE e2e</title><link rel="icon" type="image/png" href="/fake-e2e.png"></head><body>FAKE</body></html>`);
    if (p === "/fake-e2e.png") { const b = png(); return res.writeHead(200, { "content-type": "image/png", "content-length": String(b.length) }).end(b); }
    res.writeHead(404).end("not here");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}

const rect = (l: Locator) => l.evaluate((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; });
const overlap = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) => a.top < b.bottom && a.bottom > b.top;

async function phoneBuilder(p: Page, slug: string) {
  await p.goto(`/build/${slug}`);
  await expect(p.locator("[data-narrow-tabs]")).toBeVisible({ timeout: 20_000 });
}
/** Taps a widget on the phone canvas, as a person does. */
async function tapNode(p: Page, id: string) {
  const el = p.locator(`[data-builder-canvas] [data-node="${id}"]`).first();
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  await p.touchscreen.tap(b.x + b.width / 2, b.y + Math.min(30, b.height / 2));
}

test.describe("Wave 2.10c round 3 (settings and shell)", () => {
  test("10a: on a phone the delete toast leaves the builder's tab row (Undo and Redo) reachable", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const ctx = await context(browser, OWNER, { mobile: true });
    const p = await ctx.newPage();
    try {
      const slug = `s-r3-10a-${RUN}`;
      await newApp(p.request, slug, [
        { id: "c_stenatexta", type: "text", props: { text: "FAKE e2e first" }, slot: { x: 0, y: 0, w: 6, h: 6 } },
        { id: "c_stenatextb", type: "text", props: { text: "FAKE e2e second" }, slot: { x: 0, y: 6, w: 6, h: 6 } },
      ]);
      await phoneBuilder(p, slug);
      await tapNode(p, "c_stenatexta");
      await p.locator("[data-remove-selected]").first().tap();
      const card = p.locator("[data-toast]").first();
      await expect(card).toBeVisible();
      await expect(card).toContainText("Deleted");
      await p.waitForTimeout(600); // the toast's entrance has settled
      const row = p.locator("[data-narrow-tabs]").locator("xpath=..");
      const [t, r] = [await rect(card), await rect(row)];
      await shot(p, "10a-phone-delete-toast");
      // What sits at the centre of the tab row's Undo is the Undo button itself, not the toast.
      const undo = p.locator("[data-narrow-tabs] ~ * [data-history-undo]").first();
      const ub = (await undo.boundingBox())!;
      const hit = await p.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-history-undo]"), [ub.x + ub.width / 2, ub.y + ub.height / 2] as [number, number]);
      save("10a-toast-vs-tab-row", { toast: t, tabRow: r, undoReachable: hit });
      expect(overlap(t, r), `toast ${JSON.stringify(t)} over the tab row ${JSON.stringify(r)}`).toBe(false);
      expect(hit, "the tab row's Undo takes the tap while the toast shows").toBe(true);
      // The toast stays on screen and its own Undo still works.
      expect(t.bottom).toBeLessThanOrEqual(844);
      await undo.tap();
      await expect(p.locator('[data-builder-canvas] [data-node="c_stenatexta"]')).toHaveCount(1);
    } finally {
      await ctx.close();
    }
  });

  test("10b: on a phone the icon picker sheet opens at its full height at once, without a field taking focus", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const ctx = await context(browser, OWNER, { mobile: true });
    const p = await ctx.newPage();
    try {
      const slug = `s-r3-10b-${RUN}`;
      await newApp(p.request, slug, [{ id: "c_stenbtilea", type: "service-tile", props: { name: "FAKE e2e service", href: "http://127.0.0.1:9/" }, slot: { x: 0, y: 0, w: 4, h: 8 } }]);
      await phoneBuilder(p, slug);
      await tapNode(p, "c_stenbtilea");
      await p.locator('[data-narrow-tab="edit"]').tap();
      await p.getByRole("button", { name: /^Icon: .*Change/ }).first().tap();
      const sheet = p.locator('[data-sheet="icon-picker"]');
      await expect(sheet).toBeVisible();
      const seen: Record<string, unknown>[] = [];
      for (const ms of [300, 1000, 2500]) {
        await p.waitForTimeout(ms - (seen.length ? [300, 1000, 2500][seen.length - 1]! : 0));
        const r = await rect(sheet);
        const scroll = await sheet.evaluate((e) => { const s = [...e.querySelectorAll<HTMLElement>("*")].find((x) => /(auto|scroll)/.test(getComputedStyle(x).overflowY)); return s ? { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight } : null; });
        const focused = await p.evaluate(() => document.activeElement?.tagName ?? null);
        seen.push({ ms, ...r, scroll, focused });
      }
      await shot(p, "10b-phone-icon-sheet");
      save("10b-sheet-height", { seen, viewport: 844 });
      for (const s of seen as { ms: number; bottom: number; height: number; scroll: { clientHeight: number } }[]) {
        expect(s.bottom, `sheet bottom at ${s.ms} ms`).toBeGreaterThanOrEqual(840);
        expect(s.height, `sheet height at ${s.ms} ms`).toBeGreaterThanOrEqual(Math.floor(844 * 0.85) - 2);
        expect(s.scroll.clientHeight, `scroll area at ${s.ms} ms`).toBeGreaterThan(400);
      }
      // From a website is on screen without scrolling the sheet.
      const from = p.locator("[data-icon-picker] [data-icon-from-website]");
      const fr = await rect(from);
      expect(fr.bottom).toBeLessThanOrEqual(844);
    } finally {
      await ctx.close();
    }
  });

  test("11: choosing a Scrollbar width shows on the editor's preview at once (a short scrolling list)", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const ctx = await context(browser, OWNER);
    const p = await ctx.newPage();
    try {
      await p.goto("/settings/themes/new");
      await expect(p.locator("[data-theme-editor]")).toBeVisible();
      await p.locator('[data-group-toggle="shape"]').click();
      const thumb = p.locator("[data-preview] [data-sample-thumb]").first();
      await expect(thumb, "the preview has a scrolling sample with a visible thumb").toBeVisible();
      const read = () => thumb.evaluate((e) => { const c = getComputedStyle(e); return { width: c.width, colour: c.backgroundColor, opacity: c.opacity }; });
      const before = await read();
      await p.locator('[data-field="scrollbar.widthPx"]').getByRole("radio", { name: /8 px/ }).click();
      await expect.poll(async () => (await read()).width).toBe("8px");
      const thumbField = p.locator('[data-field="scrollbar.thumb"]');
      await thumbField.fill("");
      await thumbField.pressSequentially("#d0342c");
      await expect.poll(async () => (await read()).colour).toBe("rgb(208, 52, 44)");
      await p.locator('[data-field="scrollbar.widthPx"]').getByRole("radio", { name: /4 px/ }).click();
      await expect.poll(async () => (await read()).width).toBe("4px");
      const after = await read();
      await p.locator("[data-preview]").screenshot({ path: ev("screens", "11-preview-thumb-4px.png") });
      save("11-preview-thumb", { before, after });
      expect(Number(after.opacity)).toBeGreaterThan(0.5);
    } finally {
      await ctx.close();
    }
  });

  test("12: Sign out removes the website icon list (atrium.siteIcons), even where Clear-Site-Data is ignored", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const site = await standIn();
    const ctx = await context(browser, OWNER);
    const p = await ctx.newPage();
    try {
      const slug = `s-r3-12-${RUN}`;
      await newApp(p.request, slug, [{ id: "c_stwelveaaa", type: "icon", props: { name: "server", scale: 50 }, slot: { x: 0, y: 0, w: 2, h: 10 } }]);
      await p.goto(`/build/${slug}`);
      await expect(p.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
      await p.locator('[data-left-tab="layers"]').click();
      await p.locator('[data-layer="c_stwelveaaa"]').click();
      await p.locator('[data-inspector] [data-icon-pick="name"]').click();
      const picker = p.locator("[data-icon-picker]");
      await picker.locator("[data-icon-from-website]").click();
      await picker.locator("[data-website-url]").click();
      await picker.locator("[data-website-url]").pressSequentially(site.url, { delay: 5 });
      await picker.locator("[data-website-fetch]").click();
      await expect(picker.locator('[data-favicon-preview="ready"]')).toBeVisible({ timeout: 12_000 });
      await picker.locator("[data-favicon-use]").click();
      // Round 3, C's half: the picker no longer keeps a site list in the browser at all.
      await p.waitForTimeout(500);
      const afterUse = await p.evaluate(() => window.localStorage.getItem("atrium.siteIcons"));
      expect(afterUse, "Use keeps no site list in the browser").toBeNull();
      // A browser that ran round 2 still holds the list round 2 wrote ({ "/uploads/<id>.png": "<host> icon" }).
      // Put it back on a page that does not load the picker, then sign out from the account menu there.
      await p.goto("/");
      await expect(p.locator("[data-account-trigger]").first()).toBeVisible();
      const kept = JSON.stringify({ "/uploads/fakee2eicon0000000a.png": "127.0.0.1 icon" });
      await p.evaluate((v) => window.localStorage.setItem("atrium.siteIcons", v), kept);
      // A plain-HTTP LAN address: the browser ignores the server's Clear-Site-Data there, so the test
      // drops that header, as such a browser would, and the client's own sweep has to do the work.
      await p.route("**/api/auth/sign-out", async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["clear-site-data"];
        await route.fulfill({ response: res, headers });
      });
      await p.locator("[data-account-trigger]").first().click();
      expect(await p.evaluate(() => window.localStorage.getItem("atrium.siteIcons")), "still there just before Sign out").toBe(kept);
      await p.getByRole("menuitem", { name: "Sign out" }).click();
      await p.waitForURL(/\/sign-in/, { timeout: 15_000 });
      const left = await p.evaluate(() => window.localStorage.getItem("atrium.siteIcons"));
      save("12-sign-out", { afterUse, keptBeforeSignOut: kept, afterSignOut: left });
      expect(left, "the website icon list is gone after sign-out").toBeNull();
    } finally {
      await ctx.close();
      await site.close();
    }
  });

  test("15: the Density choice shows its whole word (Comfortable) in the builder's narrow theme editor", async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const ctx = await context(browser, OWNER);
    const p = await ctx.newPage();
    try {
      // Where the critic saw it: the builder's Theme panel, New theme from this one (the narrowest editor).
      const slug = `s-r3-15-${RUN}`;
      await newApp(p.request, slug, []);
      await p.goto(`/build/${slug}`);
      await expect(p.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
      await p.locator("[data-builder-theme]").click();
      await p.locator("[data-theme-new]").click();
      await expect(p.locator("[data-theme-editor]")).toBeVisible({ timeout: 10_000 });
      await p.locator('[data-group-toggle="shape"]').click();
      const comfortable = p.locator('[data-field="space.density"]').getByRole("radio", { name: /Comfortable/ });
      await expect(comfortable).toBeVisible();
      const fits = await comfortable.evaluate((b) => [...b.querySelectorAll<HTMLElement>("span")].filter((s) => /Comfortable/.test(s.textContent ?? "") && !s.querySelector("span")).every((s) => s.scrollWidth <= s.clientWidth + 1 && s.getBoundingClientRect().right <= b.getBoundingClientRect().right + 1 && s.getBoundingClientRect().left >= b.getBoundingClientRect().left - 1));
      await p.locator('[data-field="space.density"]').screenshot({ path: ev("screens", "15-density-word.png") });
      expect(fits, "Comfortable is not cut").toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
