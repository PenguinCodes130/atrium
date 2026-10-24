// app-builder e2e, round 3: the gauntlet w2-r2 Fix List (stages/04-gauntlet/output/app-builder-gauntlet-r2.md),
// one test per item, each proving its pass condition. Evidence goes to evidence/app-builder/<round>/
// (ATRIUM_E2E_EVIDENCE_ROUND=r3). Self-contained: its own apps (slugs r3-*), its own stand-ins.
//
// The item 1 "SFR" test needs the sign-out Shared File Requests applied (auth and app-shell patches in
// evidence/app-builder/r3/sfr/); both are merged now, so it runs unless ATRIUM_E2E_SFR=0.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { expect, request, test, type BrowserContext, type Page } from "@playwright/test";
import { addUser, api, contextFor, db, ev, FAKE_HA_TOKEN, fakeHa, H, log, ORIGIN, OWNER, PEOPLE, saveText, SHELL_VARIANTS, type FakeHa } from "./helpers";
import { readZipEntries } from "./zip-read";

test.describe.configure({ mode: "default", timeout: 120_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

// Regression r3: the lead merged both sign-out SFRs (auth-sign-out-clear-site-data, shell-sign-out-forget-offline-apps)
// into the real tree, so the item 1 SFR test now runs by default; ATRIUM_E2E_SFR=0 still opts out for a pre-merge tree.
const SFR = process.env.ATRIUM_E2E_SFR !== "0";
const LIGHT = SHELL_VARIANTS[0]!;
const DARK = SHELL_VARIANTS[1]!;
let ha: FakeHa;
let haId = "";

async function owner() {
  return api(OWNER);
}
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: { x: number; y: number; w: number; h: number }; children?: Node[] };
type Doc = { rev: number; doc: { app: { name: string }; pages: { id: string; slug: string; root: Node }[]; controls: { id: string; label: string; run: { params?: Record<string, unknown> } }[]; dataSources: { name: string; integrationId: string }[]; theme: Record<string, unknown>; chrome: Record<string, unknown> } };
async function draftOf(id: string): Promise<Doc> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function ops(id: string, list: unknown[]) {
  const d = await draftOf(id);
  const r = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
}
async function publish(id: string, note = "r3") {
  const c = await owner();
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
  return (await r.json()) as { version: number };
}
async function create(body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  const r = await (await owner()).post("/api/apps", { data: body });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app;
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
}
/** Picks an option in the shared square SelectMenu by its value. */
async function pick(page: Page, name: string, value: string) {
  await page.locator(`[data-select="${name}"]`).click();
  const option = page.locator(`[data-select-menu="${name}"] [data-option="${value}"]`);
  // Long menus scroll inside their own viewport: choose by keyboard (focus the option, then Enter), the
  // way a keyboard user does, so the pick never depends on where the popper lands.
  await option.waitFor();
  await option.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-select-menu="${name}"]`)).toHaveCount(0);
}
async function guestPage(ctx: BrowserContext, appId: string, label: string): Promise<Page> {
  const link = await (await (await owner()).post("/api/auth/atrium/guest-links", { data: { appId, label } })).json();
  const page = await ctx.newPage();
  await page.goto(new URL(link.url).pathname);
  await page.waitForURL(/\/a\//);
  return page;
}

/** A person of our own who signs in fresh (sign-out ends the session, so shared storage states stay untouched). */
async function freshPerson(email: string, role: "member" | "viewer"): Promise<{ email: string; password: string; id: string }> {
  const password = `e2e-${role}-${randomUUID().slice(0, 8)}-password`;
  const d = db();
  try {
    const existing = d.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const now = Date.now();
    const h = await hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    if (!existing) {
      d.prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, email.split("@")[0], email, 1, role, 0, now, now);
      d.prepare("INSERT OR IGNORE INTO allowlist (id, pattern, role, created_at) VALUES (?,?,?,?)").run(randomUUID(), email, role, now);
    } else d.prepare("DELETE FROM account WHERE user_id = ?").run(id);
    d.prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, h, now, now);
    return { email, password, id };
  } finally {
    d.close();
  }
}
let ipN = 60;
async function signedInContext(browser: import("@playwright/test").Browser, who: { email: string; password: string }): Promise<BrowserContext> {
  const r = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { ...H, "x-forwarded-for": `198.51.100.${ipN++}` } });
  const res = await r.post("/api/auth/sign-in/email", { data: { email: who.email, password: who.password } });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()} ${await res.text()}`);
  const state = await r.storageState();
  await r.dispose();
  const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: state, viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name: "atrium_theme", value: "light", url: ORIGIN }, { name: "atrium_swept", value: "1", url: ORIGIN }]);
  return ctx;
}

/** Everything this browser keeps for apps offline: caches (with their text) and the last-values keys. */
async function offlineStores(page: Page) {
  return page.evaluate(async () => {
    const out: { caches: { name: string; url: string; text: string }[]; last: string[]; workers: string[] } = { caches: [], last: [], workers: [] };
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) {
        const res = await c.match(req);
        const ct = res?.headers.get("content-type") ?? "";
        out.caches.push({ name, url: req.url, text: /html|json|text/.test(ct) ? await res!.text() : `(${ct})` });
      }
    }
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith("atrium:last")) out.last.push(k); }
    out.workers = (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope);
    return out;
  });
}

const SECRET = "light.secprobe_door_4821";
const EDITOR_ONLY = [SECRET, "secprobe-chrome", '"domain":"lock"'];

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  for (const p of Object.values(PEOPLE)) await addUser(p);
  ha = await fakeHa();
  const c = await owner();
  const existing = ((await (await c.get("/api/integrations")).json()).integrations ?? []) as { id: string; name: string }[];
  haId = existing.find((i) => i.name === "Home Assistant r3")?.id ?? (await (await c.post("/api/integrations", { data: { packageId: "home-assistant", name: "Home Assistant r3", config: { baseUrl: ha.url }, secrets: { token: FAKE_HA_TOKEN }, untested: true } })).json()).id;
  expect(haId).toBeTruthy();
  // Shared on, so an app a member edits keeps its data (A1.1); item 1's editor is a member.
  await c.patch(`/api/integrations/${haId}`, { data: { shared: true } });
});
test.afterAll(async () => {
  await ha?.close();
});

async function doorApp(slug: string, editorId: string) {
  const app = await create({ name: "Door", slug });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", params: { domain: "lock" }, refreshSec: 10 } },
    { op: "control.set", control: { id: "k_secdooraaa", label: "Front door", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: SECRET } } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_secdoornod", type: "button", props: { label: "Front door", control: "k_secdooraaa" }, slot: { x: 0, y: 0, w: 4, h: 8 } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_seclightsx", type: "text", props: { text: { $bind: "{{ ha.rows | count }} lights known" } }, slot: { x: 4, y: 0, w: 6, h: 6 } } },
    { op: "chrome.update", patch: { css: ":scope { --secprobe-chrome: 1 }" } },
  ]);
  await publish(app.id);
  await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: "everyone", edit: { userIds: [editorId] }, guests: true } });
  return app;
}

// ---------- Item 1 (security) ----------
test("item 1: the offline cache holds only the guest projection; after sign-out the next person offline gets nothing editor-only", async ({ browser }) => {
  const sam = await freshPerson("sam-r3@atrium.test", "member");
  const app = await doorApp("r3-sec-door", sam.id);
  const ctx = await signedInContext(browser, sam);
  const page = await ctx.newPage();
  // The editor's own page (online) does carry the run details: the probe is meaningful.
  const live = await page.request.get(`/a/${app.slug}`);
  expect((await live.text()).includes(SECRET)).toBe(true);
  await page.goto(`/a/${app.slug}`);
  await expect(page.getByText(/^\d+ lights known$/)).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 15_000 });
  await page.reload(); // the worker now handles the navigation and stores the snapshot
  await expect(page.getByText(/^\d+ lights known$/)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  const before = await offlineStores(page);
  const pages = before.caches.filter((x) => new URL(x.url).pathname.startsWith("/a/"));
  expect(pages.length).toBeGreaterThan(0);
  for (const x of pages) {
    expect(x.text).toContain("data-atrium-offline-snapshot");
    for (const s of EDITOR_ONLY) expect(x.text.includes(s), `${x.url} holds ${s}`).toBe(false);
  }
  expect(before.last.length).toBeGreaterThan(0);
  // Offline while still signed in: the editor sees the snapshot with its last values.
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.locator("[data-app-offline]")).toBeVisible();
  await expect(page.getByText(/^\d+ lights known$/)).toBeVisible();
  await page.screenshot({ path: ev("screens", "item1-offline-editor-snapshot.png") });
  await ctx.setOffline(false);
  // Sign out on the server only (the worst case: no page code runs on the way out).
  await page.goto("/");
  const out = await page.evaluate(() => fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status));
  expect(out).toBe(200);
  // The next person on this browser, offline, without signing in: no run details in anything served.
  await ctx.setOffline(true);
  const offlineRes = await page.goto(`/a/${app.slug}`).catch(() => null);
  const offlineHtml = offlineRes ? await offlineRes.text().catch(() => "") : "";
  for (const s of EDITOR_ONLY) expect(offlineHtml.includes(s), `offline after sign-out holds ${s}`).toBe(false);
  // Regression r3 (flake, seen once in 3 full runs): with sign-out's Clear-Site-Data the worker is gone, the offline
  // navigation lands on the browser's own error page, and one capture answered "Unable to capture screenshot".
  // The capture is evidence only; retry it once after the page settles. The assertions above are unchanged.
  const shotPath = ev("screens", "item1-offline-after-signout.png");
  await page.screenshot({ path: shotPath }).catch(async () => {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: shotPath });
  });
  await ctx.setOffline(false);
  // Online again, the app now sends this browser to sign-in: the worker forgets every cache of the app.
  await page.goto(`/a/${app.slug}`);
  await page.waitForURL(/sign-in/);
  await expect.poll(async () => (await offlineStores(page)).caches.filter((x) => x.name.startsWith("atrium-app")).length, { timeout: 10_000 }).toBe(0);
  // A different person signs in on the same browser and goes offline: still nothing editor-only.
  const vic = await freshPerson("vic-r3@atrium.test", "viewer");
  const r = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { ...H, "x-forwarded-for": "198.51.100.99" } });
  await r.post("/api/auth/sign-in/email", { data: { email: vic.email, password: vic.password } });
  await ctx.addCookies((await r.storageState()).cookies);
  await r.dispose();
  await page.goto(`/a/${app.slug}`);
  await expect(page.getByText(/^\d+ lights known$/)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  const lastOwner = await page.evaluate(() => localStorage.getItem("atrium:last-owner"));
  expect(lastOwner).toBe(`user:${vic.id}`); // sam's values were wiped before vic's page used any
  await ctx.setOffline(true);
  const vicOffline = await page.goto(`/a/${app.slug}`).catch(() => null);
  const vicHtml = vicOffline ? await vicOffline.text().catch(() => "") : "";
  for (const s of EDITOR_ONLY) expect(vicHtml.includes(s)).toBe(false);
  await ctx.setOffline(false);
  const after = await offlineStores(page);
  saveText("security/offline-after-signout.json", JSON.stringify({ editorPageHasSecret: true, before: { caches: before.caches.map((x) => ({ name: x.name, url: x.url, snapshot: x.text.includes("data-atrium-offline-snapshot"), editorOnly: EDITOR_ONLY.filter((s) => x.text.includes(s)) })), last: before.last }, signOutStatus: out, offlineAfterSignOut: { status: offlineRes?.status() ?? "no response", editorOnly: EDITOR_ONLY.filter((s) => offlineHtml.includes(s)) }, nextPersonLastOwner: lastOwner, nextPersonOffline: { status: vicOffline?.status() ?? "no response", editorOnly: EDITOR_ONLY.filter((s) => vicHtml.includes(s)) }, after: { caches: after.caches.map((x) => ({ name: x.name, url: x.url, editorOnly: EDITOR_ONLY.filter((s) => x.text.includes(s)) })) } }, null, 2));
  await ctx.close();
});

test("item 1 (with the sign-out Shared File Requests): signing out from the account menu forgets caches, workers and last values at once", async ({ browser }) => {
  test.skip(!SFR, "needs the auth and app-shell sign-out patches (ATRIUM_E2E_SFR=0 opted out)");
  const sam = await freshPerson("sam2-r3@atrium.test", "member");
  const app = await doorApp("r3-sec-door2", sam.id);
  const ctx = await signedInContext(browser, sam);
  const page = await ctx.newPage();
  await page.goto(`/a/${app.slug}`);
  await expect(page.getByText(/^\d+ lights known$/)).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 15_000 });
  await page.reload();
  await page.waitForTimeout(2500);
  const before = await offlineStores(page);
  expect(before.caches.length).toBeGreaterThan(0);
  expect(before.last.length).toBeGreaterThan(0);
  expect(before.workers.length).toBeGreaterThan(0);
  await page.goto("/");
  let clearSiteData: string | null = null;
  // allHeaders(): headers() leaves out security headers such as Clear-Site-Data.
  const seen: Promise<void>[] = [];
  page.on("response", (r) => { if (r.url().endsWith("/api/auth/sign-out")) seen.push(r.allHeaders().then((h) => { clearSiteData = h["clear-site-data"] ?? null; })); });
  await page.locator("[data-account-trigger]").first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/sign-in/);
  await Promise.all(seen);
  const after = await offlineStores(page);
  expect(after.caches).toEqual([]);
  expect(after.last).toEqual([]);
  expect(after.workers.filter((s) => new URL(s).pathname.startsWith("/a/"))).toEqual([]);
  expect(clearSiteData).toBe('"cache", "storage"');
  await ctx.setOffline(true);
  const res = await page.goto(`/a/${app.slug}`).catch(() => null);
  const html = res ? await res.text().catch(() => "") : "";
  for (const s of EDITOR_ONLY) expect(html.includes(s)).toBe(false);
  expect(/\d+ lights known/.test(html)).toBe(false);
  await page.screenshot({ path: ev("screens", "item1-sfr-offline-after-menu-signout.png") });
  await ctx.setOffline(false);
  saveText("security/offline-after-menu-signout.json", JSON.stringify({ before: { caches: before.caches.map((x) => x.url), last: before.last, workers: before.workers }, after, clearSiteData, offline: { status: res?.status() ?? "no response (nothing cached)", editorOnly: EDITOR_ONLY.filter((s) => html.includes(s)) } }, null, 2));
  await ctx.close();
});

// ---------- Item 2 ----------
type Lamp = { url: string; hits: unknown[]; on: boolean; close(): Promise<void> };
async function lampServer(): Promise<Lamp> {
  const lamp: Lamp = { url: "", hits: [], on: false, close: async () => {} };
  const s = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/lamp") {
        const body = raw ? JSON.parse(raw) : {};
        lamp.hits.push(body);
        lamp.on = body.on === true;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ on: lamp.on }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: lamp.on ? 1 : 0, unit: "" }));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  lamp.url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  lamp.close = () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); });
  return lamp;
}

test("item 2: a toggle on a Custom API command maps its on/off parameter; the review blocks an unmapped one; guests never see builder repair text; the lamp flips", async ({ browser }) => {
  const lamp = await lampServer();
  try {
    const c = await owner();
    const api0 = await (await c.post("/api/integrations", { data: { packageId: "custom-api", name: "Lamp API r3", config: { baseUrl: lamp.url }, secrets: {}, untested: true } })).json();
    const LAMP_PARAMS = { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] };
    const add = await c.post(`/api/integrations/${api0.id}/commands`, { data: { id: "lamp.toggle", label: "Desk lamp", description: "Turns the desk lamp on or off", method: "POST", path: "/lamp", body: { on: "{{ params.on }}" }, params: LAMP_PARAMS, risk: "low" } });
    expect(add.ok(), await add.text()).toBe(true);
    expect((await c.post(`/api/integrations/${api0.id}/commands/publish`, { data: {} })).ok()).toBe(true);
    const app = await create({ name: "R3 lamp", slug: "r3-lamp" });
    const d = await draftOf(app.id);
    await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3lamptogg", type: "toggle", props: { label: "Desk lamp" }, slot: { x: 0, y: 0, w: 4, h: 9 } } }]);
    const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
    const page = await ctx.newPage();
    await openBuilder(page, app.slug);
    await page.locator('[data-left-tab="layers"]').click();
    await page.locator('[data-layer="c_r3lamptogg"]').click();
    await page.locator("[data-new-control]").click();
    await page.locator("[data-control-label]").fill("Desk lamp");
    await page.locator('[data-select="control-command"]').click();
    await expect(page.locator('[data-select-menu="control-command"]')).toBeVisible();
    const menu = (await page.locator('[data-select-menu="control-command"]').boundingBox())!;
    expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(menu.y + menu.height).toBeLessThanOrEqual(800 + 1); // the menu fits the window, whatever the list length
    await page.screenshot({ path: ev("screens", "item2-command-menu.png") });
    await page.keyboard.press("Escape");
    await pick(page, "control-command", `${api0.id}|lamp.toggle`);
    // Automatic mapping: the command's one on/off parameter takes the switch's value.
    await expect(page.locator('[data-control-param="on"]')).toHaveAttribute("data-param-source", "input");
    await expect(page.locator('[data-select="param-source-on"]')).toContainText("The switch (on or off)");
    await expect(page.locator("[data-control-params-missing]")).toHaveCount(0);
    await page.screenshot({ path: ev("screens", "item2-control-form-mapped.png") });
    // Choosing nothing shows what is missing, at the form.
    await pick(page, "param-source-on", "fixed");
    await expect(page.locator('[data-control-param="on"] [data-select="param-value-on"]')).toBeVisible();
    await pick(page, "param-source-on", "input");
    await page.locator("[data-control-save]").click();
    await expect.poll(async () => JSON.stringify((await draftOf(app.id)).doc.controls[0]?.run.params ?? {})).toBe(JSON.stringify({ on: { $bind: "{{ $input }}" } }));
    // A control saved without the parameter (an agent, or an older draft): the review names it and blocks publishing.
    const ctl = (await draftOf(app.id)).doc.controls[0]!;
    await ops(app.id, [{ op: "control.set", control: { ...ctl, run: { ...ctl.run, params: {} } } }]);
    await page.reload();
    await expect(page.locator("[data-builder-bar]")).toBeVisible();
    await page.locator("[data-publish]").click();
    const blocked = page.locator('[data-review-problem="error"]').filter({ hasText: "Desk lamp needs a value for on." });
    await expect(blocked).toBeVisible();
    await expect(page.locator("[data-publish-confirm]")).toBeDisabled();
    await page.screenshot({ path: ev("screens", "item2-review-blocks-unmapped.png") });
    await page.keyboard.press("Escape");
    await ops(app.id, [{ op: "control.set", control: { ...ctl, run: { ...ctl.run, params: { on: { $bind: "{{ $input }}" } } } } }]);
    await publish(app.id);
    await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: "owner", edit: "owner", guests: true } });
    await ctx.close();
    // The guest flips it: the stand-in lamp receives on: true.
    const g = await contextFor(browser, null, { variant: LIGHT });
    const gp = await guestPage(g, app.id, "r3 lamp guest");
    await gp.waitForLoadState("networkidle").catch(() => {});
    await gp.waitForTimeout(800);
    await gp.getByRole("switch", { name: "Desk lamp" }).click();
    await expect.poll(() => lamp.hits.length, { timeout: 8000 }).toBe(1);
    expect(lamp.hits[0]).toEqual({ on: true });
    await gp.screenshot({ path: ev("screens", "item2-guest-flipped.png") });
    // The command's parameters change after publishing (a new required "level"): the run fails, and the
    // guest reads a plain message with no builder repair text; the owner still gets the repair text.
    expect((await c.post(`/api/integrations/${api0.id}/commands`, { data: { id: "lamp.toggle", label: "Desk lamp", description: "Turns the desk lamp on or off", method: "POST", path: "/lamp", body: { on: "{{ params.on }}" }, params: { type: "object", properties: { on: { type: "boolean" }, level: { type: "integer" } }, required: ["on", "level"] }, risk: "low" } })).ok()).toBe(true);
    expect((await c.post(`/api/integrations/${api0.id}/commands/publish`, { data: {} })).ok()).toBe(true);
    await gp.waitForTimeout(700);
    await gp.getByRole("switch", { name: "Desk lamp" }).click();
    const failure = gp.getByText(/not set up correctly yet/).first();
    await expect(failure).toBeVisible({ timeout: 8000 });
    expect(await gp.getByText(/in the builder/).count()).toBe(0);
    await gp.screenshot({ path: ev("screens", "item2-guest-no-repair-text.png") });
    await g.close();
    const oc = await contextFor(browser, OWNER, { variant: LIGHT });
    const op = await oc.newPage();
    await op.goto(`/a/${app.slug}`);
    await op.waitForLoadState("networkidle").catch(() => {});
    await op.waitForTimeout(1200); // hydrated, and past the control's cooldown from the guest's run
    await op.getByRole("switch", { name: "Desk lamp" }).click();
    await expect(op.getByText(/Fix the control's parameters in the builder/).first()).toBeVisible({ timeout: 8000 });
    await oc.close();
    saveText("logs/item2-lamp.json", JSON.stringify({ hits: lamp.hits, params: (await draftOf(app.id)).doc.controls[0]?.run.params }, null, 2));
  } finally {
    await lamp.close();
  }
});

// ---------- Items 3 and 4 ----------
test("items 3, 4: Customise on Dusk starts from Dusk's own wallpaper, checks contrast with a one-click fix, and moves the nav pill to the accent", async ({ browser }) => {
  const app = await create({ name: "R3 dusk", slug: "r3-dusk" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "theme.set", theme: { themeId: "dusk" } },
    { op: "chrome.update", patch: { layout: "tabs", title: "R3 dusk" } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3dusktext", type: "text", props: { text: "Readable on the wallpaper" }, slot: { x: 0, y: 0, w: 6, h: 6 } } },
    { op: "page.add", page: { id: "p_r3secondpg", slug: "second", title: "Second", inNav: true, root: { id: "c_r3secroota", type: "grid", props: {}, children: [] } } },
  ]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator("[data-builder-look]").click();
  await page.locator("[data-look-customise-open]").click();
  await page.locator("[data-look-accent]").fill("#22c55e");
  await page.locator('[data-look-wallpaper="gradient"]').click();
  const swatches = { a: await page.locator("[data-look-wallpaper-a]").inputValue(), b: await page.locator("[data-look-wallpaper-b]").inputValue() };
  // Dusk's own wallpaper colours, dark: no contrast warning on the default path.
  expect(swatches.a.toLowerCase()).not.toBe("#f3efe4");
  expect(swatches.b.toLowerCase()).not.toBe("#c9d8e6");
  await expect(page.locator("[data-look-contrast-ok]")).toBeVisible();
  await page.screenshot({ path: ev("screens", "item3-customise-dusk-defaults.png") });
  // The round 2 path (cream to pale blue) is flagged and fixed in one click.
  await page.locator("[data-look-wallpaper-a]").fill("#f3efe4");
  await page.locator("[data-look-wallpaper-b]").fill("#c9d8e6");
  await expect(page.locator('[data-look-contrast-warning="color.canvasText"]')).toBeVisible();
  await page.screenshot({ path: ev("screens", "item3-contrast-warning.png") });
  await page.locator("[data-look-text-fix]").click();
  await expect(page.locator('[data-look-contrast-warning="color.canvasText"]')).toHaveCount(0);
  // Back to the defaults and save: the default path on Dusk publishes readable text.
  await page.locator("[data-look-wallpaper-a]").fill(swatches.a);
  await page.locator("[data-look-wallpaper-b]").fill(swatches.b);
  await expect(page.locator("[data-look-contrast-ok]")).toBeVisible(); // the fix for cream does not carry over
  await page.locator("[data-look-save]").click();
  await expect(page.locator("[data-look-inline]")).toBeVisible();
  await page.waitForTimeout(800);
  const inline = ((await draftOf(app.id)).doc.theme as { inline?: { tokens: { color: Record<string, string>; chrome: Record<string, string>; wallpaper: { colors?: string[] } } } }).inline!;
  expect(inline.tokens.chrome.activeFill?.toLowerCase()).toBe("#22c55e");
  expect(inline.tokens.wallpaper.colors?.map((x) => x.toLowerCase())).toEqual([swatches.a.toLowerCase(), swatches.b.toLowerCase()]);
  await page.keyboard.press("Escape");
  await publish(app.id);
  await ctx.close();
  for (const v of [LIGHT, DARK]) {
    const vc = await contextFor(browser, OWNER, { variant: v });
    const vp = await vc.newPage();
    await vp.goto(`/a/${app.slug}`);
    const pill = await vp.locator('[data-app-nav-item][aria-current="page"]').evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, color: s.color }; });
    expect(pill.bg).toBe("rgb(34, 197, 94)");
    const text = await vp.getByText("Readable on the wallpaper").evaluate((e) => getComputedStyle(e).color);
    // Dusk's light text on Dusk's dark wallpaper.
    const nums = (text.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    const lightness = text.startsWith("oklch") ? nums[0]! : (nums[0]! + nums[1]! + nums[2]!) / 3 / 255;
    expect(lightness).toBeGreaterThan(0.75);
    log(`items 3-4 viewer ${v.name}`, { pill, text, swatches });
    await vp.screenshot({ path: ev("screens", `item3-4-viewer-${v.name}.png`) });
    await vc.close();
  }
});

// ---------- Item 5 ----------
test("item 5: unconnected cards read the same calm state for guest, viewer and owner; only people who can add integrations get Connect it", async ({ browser }) => {
  const app = await create({ name: "R3 homelab", slug: "r3-homelab", template: "homelab", mappings: {} });
  await publish(app.id);
  await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: "everyone", edit: "owner", guests: true } });
  const out: Record<string, unknown> = {};
  const check = async (who: string, page: Page, links: number) => {
    const frame = page.locator("[data-app-page]");
    await expect(frame.locator(".atr-state-empty").first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500); // the stream (if any) has had its say
    const states = await frame.locator(".atr-state-empty").count();
    const connect = await frame.locator("[data-connect-link]").count();
    const liveDots = await frame.locator('[data-live-dot="ok"]').count();
    const notConnected = await frame.getByText("Not connected yet").count();
    out[who] = { states, connect, liveDots, notConnected };
    expect(states).toBe(3);
    expect(liveDots).toBe(0);
    expect(connect).toBe(links);
    if (!links) expect(notConnected).toBe(3);
    await page.screenshot({ path: ev("screens", `item5-${who}.png`), fullPage: true });
  };
  const g = await contextFor(browser, null, { variant: LIGHT });
  await check("guest", await guestPage(g, app.id, "r3 homelab guest"), 0);
  await g.close();
  const v = await contextFor(browser, PEOPLE.viewer, { variant: LIGHT });
  const vp = await v.newPage();
  await vp.goto(`/a/${app.slug}`);
  await check("viewer", vp, 0);
  await v.close();
  const o = await contextFor(browser, OWNER, { variant: LIGHT });
  const op = await o.newPage();
  await op.goto(`/a/${app.slug}`);
  await check("owner", op, 3);
  await o.close();
  saveText("logs/item5-audiences.json", JSON.stringify(out, null, 2));
});

// ---------- Item 6 ----------
test("item 6: app-builder screens use the shared square controls: the native-control audit is empty on every app-builder surface, with 44px targets", async ({ browser }) => {
  const app = await create({ name: "R3 controls", slug: "r3-controls" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3ctltoggl", type: "toggle", props: { label: "Switch" }, slot: { x: 0, y: 0, w: 4, h: 9 } } },
    { op: "page.add", page: { id: "p_r3ctlpage2", slug: "two", title: "Two", inNav: true, root: { id: "c_r3ctlroot2", type: "grid", props: {}, children: [] } } },
  ]);
  await publish(app.id);
  await ops(app.id, [{ op: "chrome.update", patch: { title: "v2" } }]);
  await publish(app.id);
  const audit = async (page: Page, scope = "body") =>
    page.locator(scope).first().evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>("select, input[type=radio], input[type=checkbox], input[type=file]:not(.sr-only)")]
        .filter((e) => (!e.closest("[data-inspector] [data-inspector-group]") || e.closest("[data-builder-slot], [data-control-editor], [data-sources-editor]")) && !e.closest("[data-theme-picker]"))
        .map((e) => `${e.tagName}:${(e as HTMLInputElement).type}:${e.outerHTML.slice(0, 80)}`));
  const out: Record<string, string[]> = {};
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-new-app], [data-new-app-tile]").first().click();
  await expect(page.locator("[data-new-app-form]")).toBeVisible();
  await page.locator('[data-template-option="homelab"]').click();
  out["new app sheet"] = await audit(page, "[data-new-app-form]");
  await page.screenshot({ path: ev("screens", "item6-new-app-sheet.png") });
  await page.keyboard.press("Escape");
  await page.locator("[data-import-app]").click();
  out["import sheet"] = await audit(page);
  await page.keyboard.press("Escape");
  await openBuilder(page, app.slug);
  out["builder bar"] = await audit(page, "[data-builder-bar]");
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_r3ctltoggl"]').click();
  await page.locator("[data-new-control]").click();
  out["inspector (app-builder parts: control form, sources, layout)"] = await audit(page, "[data-builder-inspector]");
  // Wave 2.5: "Add a data source" opens the data picker; it uses the shared controls too.
  const srcs = page.locator('[data-inspector-group="sources"]');
  if (!(await srcs.evaluate((e) => (e as HTMLDetailsElement).open))) await srcs.locator("> summary").click();
  await page.locator("[data-add-source]").click();
  await page.locator("[data-pick-integration]").first().click();
  await page.locator("[data-pick-endpoint]").first().click();
  await page.locator("[data-pick-more-settings-toggle]").click();
  out["data picker"] = await audit(page, "[data-data-picker]");
  await page.locator("[data-pick-cancel]").click();
  await expect(page.locator("[data-data-picker]")).toHaveCount(0);
  out["components' inspector groups (cross-reference, components' code)"] = await page.locator("[data-builder-inspector] [data-inspector]").first().evaluate((root) => [...root.querySelectorAll("[data-inspector-group] select, [data-inspector-group] input[type=radio], [data-inspector-group] input[type=checkbox]")].filter((e) => !e.closest("[data-builder-slot]")).map((e) => `${e.tagName}:${e.getAttribute("data-style-slot") ?? e.getAttribute("data-style-state") ?? e.getAttribute("aria-label") ?? ""}`));
  await page.screenshot({ path: ev("screens", "item6-inspector.png") });
  await page.locator("[data-builder-look]").click();
  out["app look sheet"] = await audit(page, "[data-app-look-sheet]");
  out["settings' ThemePicker in App look (cross-reference, settings' code)"] = await page.locator("[data-app-look-sheet]").evaluate((root) => [...root.querySelectorAll("[data-theme-picker] select")].map((e) => `${e.tagName}:${e.getAttribute("data-theme-select") ?? ""}`));
  await page.keyboard.press("Escape");
  await page.goto(`/build/${app.slug}/settings`);
  await page.locator('[data-access-set="view"] [data-access-mode="chosen"]').click();
  out["app settings"] = await audit(page);
  await page.screenshot({ path: ev("screens", "item6-settings.png"), fullPage: true });
  await page.goto(`/build/${app.slug}/versions`);
  await expect(page.locator("[data-compare]")).toBeVisible();
  out["versions"] = await audit(page);
  await page.screenshot({ path: ev("screens", "item6-versions.png") });
  await ctx.close();
  // 44px on touch for the shared controls on these screens.
  const phone = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: DARK });
  const pp = await phone.newPage();
  await pp.goto(`/build/${app.slug}/settings`);
  // Measure once the rows are drawn (2026-10-19: measuring at once read 0px on one of two fresh runs).
  await expect(pp.locator("[data-access-option]").last()).toBeVisible();
  const heights = await pp.locator("[data-access-option]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  await pp.goto(`/build/${app.slug}/versions`);
  const compare = Math.round((await pp.locator('[data-select="compare"]').boundingBox())!.height);
  await phone.close();
  saveText("logs/item6-native-audit.json", JSON.stringify({ audit: out, accessRowHeights390: heights, compareHeight390: compare }, null, 2));
  for (const [k, v] of Object.entries(out)) if (!k.includes("cross-reference")) expect(v, k).toEqual([]);
  expect(heights.every((h) => h >= 44)).toBe(true);
  expect(compare).toBeGreaterThanOrEqual(44);
});

// ---------- Item 7 ----------
test("item 7: in the reduced edit mode at 390px, source Edit and Remove, group headers and layer rows are 44px tall", async ({ browser }) => {
  const app = await create({ name: "R3 narrow", slug: "r3-narrow" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", refreshSec: 10 } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3narrowtx", type: "text", props: { text: { $bind: "{{ ha.rows | count }} lights" } }, slot: { x: 0, y: 0, w: 12, h: 6 } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3narrowhd", type: "heading", props: { text: "Hi", level: 2 }, slot: { x: 0, y: 6, w: 12, h: 6 } } },
  ]);
  const ctx = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto(`/build/${app.slug}`);
  await page.locator('[data-canvas-root] [data-node="c_r3narrowtx"]').click();
  await page.locator('[data-narrow-tab="edit"]').click();
  await page.locator('[data-inspector-group="sources"] > summary').click();
  const sizes = await page.locator("[data-builder-inspector]").evaluate((root) => ({
    sourceButtons: [...root.querySelectorAll<HTMLElement>("[data-source-edit], [data-source-remove]")].map((e) => Math.round(e.getBoundingClientRect().height)),
    groupHeaders: [...root.querySelectorAll<HTMLElement>("[data-inspector-group] > h3 > button, [data-inspector-group] > summary")].filter((e) => e.getBoundingClientRect().height > 0).map((e) => `${e.textContent?.trim()}:${Math.round(e.getBoundingClientRect().height)}`),
  }));
  await page.screenshot({ path: ev("screens", "item7-narrow-edit.png"), fullPage: true });
  await page.locator('[data-narrow-tab="layers"]').click();
  const rows = await page.locator("[data-layer]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  await page.screenshot({ path: ev("screens", "item7-narrow-layers.png") });
  saveText("logs/item7-targets.json", JSON.stringify({ ...sizes, layerRows: rows }, null, 2));
  expect(sizes.sourceButtons.length).toBe(2);
  expect(sizes.sourceButtons.every((h) => h >= 44)).toBe(true);
  expect(sizes.groupHeaders.length).toBeGreaterThan(1);
  expect(sizes.groupHeaders.every((x) => Number(x.split(":").pop()) >= 44)).toBe(true);
  expect(rows.every((h) => h >= 44)).toBe(true);
  await ctx.close();
});

// ---------- Item 8 ----------
test("item 8: opening Edit code keeps the selected HTML block in view above the docked window at 1280x800", async ({ browser }) => {
  const app = await create({ name: "R3 dock", slug: "r3-dock" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    ...Array.from({ length: 4 }, (_, i) => ({ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: `c_r3dockf${"abcd"[i]}aa`, type: "text", props: { text: `Filler ${i}` }, slot: { x: 0, y: i * 12, w: 12, h: 12 } } })),
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3dockhtml", type: "html", props: { html: "<p>block</p>", css: "", js: "", data: {}, controls: [], height: 160 }, slot: { x: 0, y: 48, w: 12, h: 24 } } },
  ]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_r3dockhtml"]').click();
  await page.locator("[data-edit-code]").click();
  await expect(page.locator("[data-code-dock] > *").first()).toBeVisible();
  await page.waitForTimeout(900);
  const block = (await page.locator('[data-canvas-root] [data-node="c_r3dockhtml"]').boundingBox())!;
  const canvas = (await page.locator("[data-builder-canvas]").boundingBox())!;
  const dock = (await page.locator("[data-code-dock]").boundingBox())!;
  saveText("logs/item8-dock.json", JSON.stringify({ block, canvas, dock }, null, 2));
  expect(dock.height).toBeGreaterThan(80);
  expect(block.y).toBeGreaterThanOrEqual(canvas.y - 1);
  expect(block.y + Math.min(block.height, 120)).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
  expect(canvas.y + canvas.height).toBeLessThanOrEqual(dock.y + 1);
  await page.screenshot({ path: ev("screens", "item8-code-dock-in-view.png") });
  await ctx.close();
});

// ---------- Items 9, 10, 15, 17 ----------
test("items 9, 10, 15, 17: the canvas tag names a library instance; Preview says it opens a new tab; inspector groups in order in the DOM; the publish toast leaves with the builder", async ({ browser }) => {
  const c = await owner();
  const saved = await c.post("/api/library", { data: { name: "ux-cpu-tile r3", node: { id: "c_r3libtilea", type: "stat", props: { label: "CPU", value: 41 } }, sources: [], controls: [] } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const comp = (await saved.json()) as { id: string; version: number; component?: { id: string; version: number } };
  const compId = comp.component?.id ?? comp.id;
  const compVersion = comp.component?.version ?? comp.version;
  const app = await create({ name: "R3 tags", slug: "r3-tags" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3libinsta", type: `lib:${compId}`, props: {}, libraryRef: { componentId: compId, version: compVersion }, slot: { x: 0, y: 0, w: 4, h: 12 } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3tagtoggl", type: "toggle", props: { label: "Switch" }, slot: { x: 4, y: 0, w: 4, h: 9 } } },
  ]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  // 9
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_r3libinsta"]').click();
  await expect(page.locator("[data-drag-handle]")).toHaveText("ux-cpu-tile r3");
  await page.screenshot({ path: ev("screens", "item9-library-tag.png") });
  // 10
  const preview = page.locator("[data-preview]");
  await expect(preview).toHaveAccessibleName("Preview (opens a new tab)");
  await expect(preview.locator("[data-external-glyph]")).toBeVisible();
  expect(await preview.getAttribute("target")).toBe("_blank");
  await preview.screenshot({ path: ev("screens", "item10-preview-glyph.png") });
  // 15: DOM order (reading and tab order), then the app-level groups below the hairline.
  await page.locator('[data-layer="c_r3tagtoggl"]').click();
  const groups = await page.locator("[data-builder-inspector]").evaluate((root) => [...root.querySelectorAll<HTMLElement>("[data-inspector-group], [data-app-level-rule]")].map((e) => e.dataset.inspectorGroup ?? "rule"));
  const domOrder = groups.filter((g) => ["content", "data", "control", "layout", "style", "advanced", "rule", "app-controls", "sources"].includes(g));
  const visual = await page.locator("[data-builder-inspector]").evaluate((root) => [...root.querySelectorAll<HTMLElement>("[data-inspector-group], [data-app-level-rule]")].map((e) => ({ g: e.dataset.inspectorGroup ?? "rule", y: e.getBoundingClientRect().top })).filter((x) => x.y > 0).sort((a, b) => a.y - b.y).map((x) => x.g));
  saveText("logs/item15-inspector-order.json", JSON.stringify({ domOrder, visual }, null, 2));
  const expected = ["content", "data", "control", "layout", "style", "advanced", "rule", "app-controls", "sources"].filter((g) => domOrder.includes(g));
  expect(domOrder).toEqual(expected);
  expect(visual.filter((g) => expected.includes(g))).toEqual(expected);
  expect(expected.slice(0, 2)).toEqual(["content", "data"]);
  expect(expected.indexOf("layout")).toBeLessThan(expected.indexOf("style"));
  await page.screenshot({ path: ev("screens", "item15-inspector-order.png") });
  // 17
  await page.locator("[data-publish]").click();
  await page.locator("[data-publish-confirm]").click();
  const toastText = page.getByRole("region", { name: "Notifications" }).getByText(/^Published v1$/);
  await expect(toastText).toBeVisible({ timeout: 5000 });
  await page.locator("[data-versions-link]").click();
  await page.waitForURL(/\/versions$/);
  await page.waitForTimeout(700);
  await expect(page.getByRole("region", { name: "Notifications" }).getByText(/^Published v1$/)).toHaveCount(0);
  await page.screenshot({ path: ev("screens", "item17-versions-no-toast.png") });
  await ctx.close();
});

// ---------- Item 11 ----------
test("item 11: while offline the app starts below the offline strip; nothing is covered", async ({ browser }) => {
  const app = await create({ name: "R3 strip", slug: "r3-strip" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "chrome.update", patch: { layout: "topbar", title: "R3 strip" } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3striptxt", type: "heading", props: { text: "Top of the app", level: 1 }, slot: { x: 0, y: 0, w: 12, h: 8 } } },
  ]);
  await publish(app.id);
  const out: Record<string, unknown> = {};
  for (const v of [LIGHT, DARK]) {
    const ctx = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: v });
    const page = await ctx.newPage();
    await page.goto(`/a/${app.slug}`);
    await expect(page.locator("[data-app-title]")).toBeVisible();
    await ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.locator("[data-app-offline]")).toBeVisible();
    await page.waitForTimeout(400);
    const strip = (await page.locator("[data-app-offline]").boundingBox())!;
    const title = (await page.locator("[data-app-title]").boundingBox())!;
    const canvas = (await page.locator("[data-app-canvas]").boundingBox())!;
    out[v.name] = { strip, title, canvas, overlapPx: Math.max(0, strip.y + strip.height - canvas.y) };
    expect(canvas.y).toBeGreaterThanOrEqual(strip.y + strip.height - 0.5);
    expect(title.y).toBeGreaterThanOrEqual(strip.y + strip.height - 0.5);
    await page.screenshot({ path: ev("screens", `item11-offline-strip-${v.name}.png`) });
    await ctx.setOffline(false);
    await ctx.close();
  }
  saveText("logs/item11-strip.json", JSON.stringify(out, null, 2));
});

// ---------- Item 12 ----------
test("item 12: a light app has one theme-color (its surface); only an app that renders a dark set in dark mode gets a dark one", async ({ browser }) => {
  const light = await create({ name: "R3 light meta", slug: "r3-meta-light" });
  await ops(light.id, [{ op: "node.add", parentId: (await draftOf(light.id)).doc.pages[0]!.root.id, node: { id: "c_r3metatxta", type: "text", props: { text: "x" }, slot: { x: 0, y: 0, w: 4, h: 6 } } }]);
  await publish(light.id);
  const auto = await create({ name: "R3 auto meta", slug: "r3-meta-auto" });
  const theme = { atriumTheme: "2", id: "app-r3-auto", name: "Auto", author: "e2e", version: "1", mode: "auto", tokens: { wallpaper: { kind: "color", value: "#F3EFE4", blurPx: 0, dim: 0, grain: 0 }, color: { surface: "#FBF9F3", surfaceText: "#15130F", surfaceMuted: "#3B372F", canvasText: "#15130F", accent: "#E9B949", accentText: "#15130F", ok: "#2F7A4D", warn: "#B5770C", bad: "#B23B25", info: "#2D5A85", line: "#15130F29" }, surface: { material: "solid", opacity: 1, blurPx: 0, border: { widthPx: 1, color: "#15130F" }, shadow: "hard", shadowOffsetPx: 6, titleBars: true }, type: { display: "Inter Tight", body: "Inter Tight", mono: "Geist Mono", scale: 1, numbers: "tabular", headingTracking: -0.04, headingWeight: 600 }, shape: { radiusPx: 0, controlRadiusPx: 0 }, space: { gapPx: 24, padPx: 20, density: "comfortable" }, motion: { enter: "sweep", lightDrift: true }, chrome: { background: "#F3EFE4", text: "#15130F", activeFill: "#15130F", activeText: "#F3EFE4", style: "boxed-tabs" } }, dark: { color: { surface: "#1D1A15", surfaceText: "#F3EFE4", surfaceMuted: "#CFC8B8", canvasText: "#F3EFE4", accent: "#E9B949", accentText: "#15130F", ok: "#5DBB82", warn: "#E0A23A", bad: "#F07A62", info: "#7FA8CF", line: "#F3EFE429" }, wallpaper: { kind: "color", value: "#15130F", blurPx: 0, dim: 0, grain: 0 } } };
  await ops(auto.id, [{ op: "theme.set", theme: { inline: theme } }, { op: "node.add", parentId: (await draftOf(auto.id)).doc.pages[0]!.root.id, node: { id: "c_r3metatxtb", type: "text", props: { text: "y" }, slot: { x: 0, y: 0, w: 4, h: 6 } } }]);
  await publish(auto.id);
  const out: Record<string, unknown> = {};
  const ctx = await contextFor(browser, OWNER, { variant: DARK });
  const page = await ctx.newPage();
  for (const a of [light, auto]) {
    await page.goto(`/a/${a.slug}`);
    out[a.slug] = await page.locator('meta[name="theme-color"]').evaluateAll((els) => els.map((e) => ({ media: e.getAttribute("media"), content: e.getAttribute("content") })));
  }
  await page.goto(`/a/${light.slug}`);
  await page.screenshot({ path: ev("screens", "item12-light-app-dark-shell.png") });
  await ctx.close();
  saveText("logs/item12-theme-color.json", JSON.stringify(out, null, 2));
  const lightMetas = out[light.slug] as { media: string | null; content: string }[];
  expect(lightMetas.length).toBe(1);
  expect(lightMetas[0]!.media).toBeNull();
  const autoMetas = out[auto.slug] as { media: string | null; content: string }[];
  expect(autoMetas.map((m) => m.content).sort()).toEqual(["#1D1A15", "#FBF9F3"]);
});

// ---------- Item 13 ----------
test("item 13: App look's navigation style uses theme token swatches that save token values, for bar, item and active item", async ({ browser }) => {
  const app = await create({ name: "R3 navstyle", slug: "r3-navstyle" });
  await ops(app.id, [{ op: "chrome.update", patch: { layout: "tabs", title: "R3 navstyle" } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator("[data-builder-look]").click();
  await expect(page.locator("[data-chrome-style-target]")).toHaveText(["Bar", "Item", "Active item"]);
  await page.locator('[data-chrome-style-target="active"]').click();
  await page.locator('[data-chrome-style-field="background"] [data-chrome-swatch="accent"]').click();
  await page.locator('[data-chrome-style-field="color"] [data-chrome-swatch="accentText"]').click();
  await page.locator('[data-chrome-style-target="root"]').click();
  await page.locator('[data-chrome-style-field="background"] [data-chrome-swatch="surface"]').click();
  await page.waitForTimeout(800);
  const style = ((await draftOf(app.id)).doc.chrome as { style?: { root?: { background?: string }; item?: { states?: { active?: { background?: string; color?: string } } } } }).style;
  expect(style?.item?.states?.active).toEqual({ background: "token:accent", color: "token:accentText" });
  expect(style?.root?.background).toBe("token:surface");
  await page.screenshot({ path: ev("screens", "item13-nav-style-tokens.png") });
  await ctx.close();
});

// ---------- Item 14 ----------
test("item 14: importing an app file whose library component was deleted here brings it back as a visible component and says so", async ({ browser }) => {
  const c = await owner();
  const saved = await c.post("/api/library", { data: { name: "R3 deleted card", node: { id: "c_r3delcarda", type: "stat", props: { label: "Deleted", value: 1 } }, sources: [], controls: [] } });
  const comp = (await saved.json()) as { id: string; version: number; component?: { id: string; version: number } };
  const compId = comp.component?.id ?? comp.id;
  const compVersion = comp.component?.version ?? comp.version;
  const app = await create({ name: "R3 relink", slug: "r3-relink" });
  const d = await draftOf(app.id);
  await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r3relinkin", type: `lib:${compId}`, props: {}, libraryRef: { componentId: compId, version: compVersion }, slot: { x: 0, y: 0, w: 4, h: 12 } } }]);
  await publish(app.id);
  const zip = Buffer.from(await (await c.get(`/api/apps/${app.id}/export`)).body());
  expect(readZipEntries(zip).map((e) => e.path)).toContain(`library/${compId}@${compVersion}.json`);
  const del = await c.delete(`/api/library/${compId}`);
  expect(del.ok(), await del.text()).toBe(true);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-import-app]").click();
  await page.locator("[data-import-file]").setInputFiles({ name: "r3-relink.atrium-app.zip", mimeType: "application/zip", buffer: zip });
  await page.locator("[data-import-check]").click();
  await expect(page.locator('[data-import-library-item="restored"]')).toContainText("was deleted here");
  await page.screenshot({ path: ev("screens", "item14-import-says-restored.png") });
  await page.locator("[data-import-confirm]").click();
  await page.waitForURL(/\/build\/r3-relink-?\d*$/);
  const list = ((await (await c.get("/api/library")).json()) as { components?: { id: string; name: string }[]; items?: { id: string; name: string }[] });
  const visible = (list.components ?? list.items ?? []).filter((x) => x.name.startsWith("R3 deleted card"));
  expect(visible.length).toBe(1);
  expect(visible[0]!.id).not.toBe(compId);
  saveText("logs/item14-relink.json", JSON.stringify({ deletedId: compId, broughtBack: visible }, null, 2));
  await ctx.close();
});

// ---------- Item 16 ----------
test("item 16: a loose drop below the content lands on the next row at the left; deleting a row closes its band in the builder and the published app", async ({ browser }) => {
  const app = await create({ name: "R3 bands", slug: "r3-bands" });
  const d = await draftOf(app.id);
  const root = d.doc.pages[0]!.root.id;
  await ops(app.id, [
    { op: "node.add", parentId: root, node: { id: "c_r3bandtopa", type: "heading", props: { text: "Top", level: 2 }, slot: { x: 0, y: 0, w: 12, h: 8 } } },
    { op: "node.add", parentId: root, node: { id: "c_r3bandmidl", type: "text", props: { text: "Middle (deleted)" }, slot: { x: 0, y: 8, w: 12, h: 20 } } },
    { op: "node.add", parentId: root, node: { id: "c_r3bandbott", type: "text", props: { text: "Bottom" }, slot: { x: 0, y: 28, w: 12, h: 8 } } },
  ]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  // Delete the middle row with the keyboard.
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_r3bandmidl"]').click();
  await page.locator("[data-builder-canvas]").focus().catch(() => {});
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await draftOf(app.id)).doc.pages[0]!.root.children!.map((n) => `${n.id}@${n.slot?.y}`).join(",")).toBe("c_r3bandtopa@0,c_r3bandbott@8");
  const gap = async (p: Page) => {
    const a = (await p.locator('[data-node="c_r3bandtopa"]').first().boundingBox())!;
    const b = (await p.locator('[data-node="c_r3bandbott"]').first().boundingBox())!;
    return Math.round(b.y - (a.y + a.height));
  };
  await page.waitForTimeout(500);
  const builderGap = await gap(page);
  await page.screenshot({ path: ev("screens", "item16-builder-after-delete.png") });
  // A loose drop far below the content.
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="stat"]').first().scrollIntoViewIfNeeded();
  const item = (await page.locator('[data-insert-item="stat"]').first().boundingBox())!;
  const grid = (await page.locator(`[data-canvas-root] [data-node="${root}"]`).boundingBox())!;
  const target = { x: grid.x + grid.width * 0.7, y: grid.y + 420 };
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(item.x + (target.x - item.x) * (i / 12), item.y + (target.y - item.y) * (i / 12));
  await expect(page.locator("[data-drop-ghost]")).toHaveAttribute("data-drop-ghost", "0,16");
  await page.screenshot({ path: ev("screens", "item16-drop-snaps.png") });
  await page.mouse.up();
  await expect.poll(async () => (await draftOf(app.id)).doc.pages[0]!.root.children!.find((n) => n.type === "stat")?.slot ?? null).toMatchObject({ x: 0, y: 16 });
  await page.keyboard.press("Escape");
  await publish(app.id);
  await page.goto(`/a/${app.slug}`);
  await expect(page.getByText("Bottom")).toBeVisible();
  const viewerGap = await gap(page);
  await page.screenshot({ path: ev("screens", "item16-viewer-no-band.png") });
  saveText("logs/item16-bands.json", JSON.stringify({ builderGap, viewerGap }, null, 2));
  expect(builderGap).toBeLessThan(40);
  expect(viewerGap).toBeLessThan(40);
  await ctx.close();
});

// ---------- Item 18 ----------
test("item 18: the Family wall clock is display size across row 1, and the cards share one body size", async ({ browser }) => {
  const app = await create({ name: "R3 wall", slug: "r3-wall", template: "family-wall" });
  await publish(app.id);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/a/${app.slug}`);
  const clock = page.locator('[data-app-page] [data-node]').filter({ has: page.locator("time") }).first();
  await expect(clock).toBeVisible();
  const m = await page.locator("[data-app-page]").evaluate((root) => {
    const times = [...root.querySelectorAll<HTMLElement>("time")];
    const biggest = Math.max(...times.map((t) => parseFloat(getComputedStyle(t).fontSize)));
    const body = [...root.querySelectorAll<HTMLElement>("p")].filter((p) => /one line each|Leave a note|Bind the family calendar/.test(p.textContent ?? "")).map((p) => getComputedStyle(p).fontSize);
    return { biggest, body };
  });
  saveText("logs/item18-wall.json", JSON.stringify(m, null, 2));
  await page.screenshot({ path: ev("screens", "item18-family-wall-1440.png") });
  expect(m.biggest).toBeGreaterThanOrEqual(64);
  expect(new Set(m.body).size).toBe(1);
  await ctx.close();
});
