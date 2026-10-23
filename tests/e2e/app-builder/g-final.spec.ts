// app-builder e2e, final pass after gauntlet w2-r3 (operator decision
// stages/04-gauntlet/output/wave-2-r3-operator-decision.md): the two security lows and the small mediums,
// one test per item. Evidence goes to evidence/app-builder/<round>/ (ATRIUM_E2E_EVIDENCE_ROUND=r4).
// Self-contained: its own apps (slugs r4-*), its own stand-ins.
//
// Parts need the final pass's Shared File Requests (evidence/app-builder/r4/sfr/): the proxy that lets an
// ended guest reach the viewer's 404 (auth: item 1's status and last-values checks), the root not-found
// without identity (app-shell: item 2) and the Custom API command form that sends its params
// (integrations: item 3's form test). They run by default (the tree after the lead merges them);
// ATRIUM_E2E_SFR_R4=0 skips them on a tree without the patches.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { expect, request, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { api, contextFor, db, ev, H, ORIGIN, OWNER, saveText, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ mode: "default", timeout: 120_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

const SFR = process.env.ATRIUM_E2E_SFR_R4 !== "0";
const LIGHT = SHELL_VARIANTS[0]!;
const DARK = SHELL_VARIANTS[1]!;
const SOLID = SHELL_VARIANTS[2]!;
/** Slugs get a per-run suffix, so the spec can run again on kept data. */
const RUN = Date.now().toString(36).slice(-4);

async function owner() {
  return api(OWNER);
}
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: { x: number; y: number; w: number; h: number }; children?: Node[] };
type Doc = { rev: number; doc: { pages: { id: string; slug: string; title: string; root: Node }[]; controls: { id: string; label: string; run: Record<string, unknown> }[] } };
async function draftOf(id: string): Promise<Doc> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function ops(id: string, list: unknown[]) {
  const d = await draftOf(id);
  const r = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
}
async function publish(id: string, note = "r4") {
  const c = await owner();
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}
async function create(body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  const r = await (await owner()).post("/api/apps", { data: body });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app;
}
/** A guest link, opened in this context; returns the page and the link id (to revoke or expire it). */
async function guestPage(ctx: BrowserContext, appId: string, label: string): Promise<{ page: Page; linkId: string }> {
  const link = await (await (await owner()).post("/api/auth/atrium/guest-links", { data: { appId, label } })).json();
  const linkId = String(link.link?.id ?? link.id ?? "");
  expect(linkId).toBeTruthy();
  const page = await ctx.newPage();
  await page.goto(new URL(link.url).pathname);
  await page.waitForURL(/\/a\//);
  return { page, linkId };
}
/** Everything this browser keeps for apps offline: caches (with their text) and the last-values keys. */
async function offlineStores(page: Page) {
  return page.evaluate(async () => {
    const out: { caches: { name: string; url: string; text: string }[]; last: string[] } = { caches: [], last: [] };
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) {
        const res = await c.match(req);
        const ct = res?.headers.get("content-type") ?? "";
        out.caches.push({ name, url: req.url, text: /html|json|text|javascript/.test(ct) ? await res!.text() : `(${ct})` });
      }
    }
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith("atrium:last")) out.last.push(k); }
    return out;
  });
}
/** Waits until the app's worker controls the page, reloads once through it, and lets it store the snapshot. */
async function primeOffline(page: Page, slug: string) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 15_000 });
  await page.reload();
  await expect.poll(async () => (await offlineStores(page)).caches.filter((c) => c.name.startsWith(`atrium-app:${slug}:`) && new URL(c.url).pathname.startsWith("/a/")).length, { timeout: 15_000 }).toBeGreaterThan(0);
}
async function freshPerson(email: string, name: string, role: "member" | "viewer"): Promise<{ email: string; password: string; id: string }> {
  const password = `e2e-${role}-${randomUUID().slice(0, 8)}-password`;
  const d = db();
  try {
    const existing = d.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const now = Date.now();
    const h = await hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    if (!existing) {
      d.prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, name, email, 1, role, 0, now, now);
      d.prepare("INSERT OR IGNORE INTO allowlist (id, pattern, role, created_at) VALUES (?,?,?,?)").run(randomUUID(), email, role, now);
    } else d.prepare("DELETE FROM account WHERE user_id = ?").run(id);
    d.prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, h, now, now);
    return { email, password, id };
  } finally {
    d.close();
  }
}
let ipN = 140;
async function signedInContext(browser: Browser, who: { email: string; password: string }): Promise<BrowserContext> {
  const r = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { ...H, "x-forwarded-for": `198.51.100.${ipN++}` } });
  const res = await r.post("/api/auth/sign-in/email", { data: { email: who.email, password: who.password } });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()} ${await res.text()}`);
  const state = await r.storageState();
  await r.dispose();
  const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: state, viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name: "atrium_theme", value: "light", url: ORIGIN }, { name: "atrium_swept", value: "1", url: ORIGIN }]);
  return ctx;
}

// ---------- Item 1 (security): a revoked or expired guest link makes the worker forget the app ----------
const PROBE = "R4PROBE-guest-visible";
async function probeApp(slug: string) {
  const app = await create({ name: "R4 guest probe", slug });
  const d = await draftOf(app.id);
  await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_rfourprobe", type: "text", props: { text: PROBE }, slot: { x: 0, y: 0, w: 6, h: 4 } } }]);
  await publish(app.id);
  await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: "owner", edit: "owner", guests: true } });
  return app;
}

for (const how of ["revoked", "expired"] as const) {
  test(`item 1 (security): a ${how} guest link answers 404 with the friendly screen; the app's caches and last values are gone; offline nothing of the app is served`, async ({ browser }) => {
    const app = await probeApp(`r4-guest-${how}-${RUN}`);
    const ctx = await contextFor(browser, null, { variant: LIGHT });
    const { page, linkId } = await guestPage(ctx, app.id, `r4 ${how}`);
    await expect(page.getByText(PROBE)).toBeVisible();
    await primeOffline(page, app.slug);
    await page.evaluate(() => localStorage.setItem("atrium:last:probe:p1", "{\"data\":{}}")); // stands in for a page's last values
    const before = await offlineStores(page);
    expect(before.caches.some((c) => c.text.includes(PROBE))).toBe(true);
    // The link ends.
    if (how === "revoked") expect((await (await owner()).post(`/api/auth/atrium/guest-links/${linkId}/revoke`, { data: {} })).ok()).toBe(true);
    else {
      const d = db();
      try { d.prepare("UPDATE guest_link SET expires_at = ? WHERE id = ?").run(1000, linkId); } finally { d.close(); }
    }
    // Online again: the same friendly screen, and the browser forgets the app. Without the auth SFR the
    // proxy still rewrites to /g/expired (200), and the worker forgets because the snapshot answer has no
    // snapshot marker; with it, the viewer answers 404 itself and the page also forgets the last values.
    const online = await page.goto(`/a/${app.slug}`);
    await expect(page.locator("[data-guest-expired]")).toBeVisible();
    await expect.poll(async () => (await offlineStores(page)).caches.filter((c) => c.name.startsWith(`atrium-app:${app.slug}:`)).length, { timeout: 10_000 }).toBe(0);
    if (SFR) {
      expect(online?.status()).toBe(404);
      await expect(page.locator("[data-atrium-access-ended]")).toHaveCount(1);
      await expect.poll(async () => (await offlineStores(page)).last.length, { timeout: 10_000 }).toBe(0);
    }
    await page.screenshot({ path: ev("screens", `item1-${how}-online-expired-screen.png`) });
    // Offline: nothing of the app.
    await ctx.setOffline(true);
    const off = await page.goto(`/a/${app.slug}`).catch(() => null);
    const html = off ? await off.text().catch(() => "") : "";
    expect(html.includes(PROBE)).toBe(false);
    expect(await page.getByText(PROBE).count()).toBe(0);
    await page.screenshot({ path: ev("screens", `item1-${how}-offline-after.png`) }).catch(() => {});
    await ctx.setOffline(false);
    const after = await offlineStores(page);
    saveText(`security/item1-guest-${how}.json`, JSON.stringify({ before: { caches: before.caches.map((c) => ({ name: c.name, url: c.url, probe: c.text.includes(PROBE) })), last: before.last }, onlineStatus: online?.status(), after: { caches: after.caches.map((c) => ({ name: c.name, url: c.url, probe: c.text.includes(PROBE) })), last: after.last }, offline: { status: off?.status() ?? "no response", probe: html.includes(PROBE) } }, null, 2));
    await ctx.close();
  });
}

// ---------- Item 2 (security, needs the app-shell SFR): no identity in what the worker stores ----------
test("item 2 (security, with the root not-found SFR): the stored snapshot holds neither the person's email nor name, also offline after the session expires on the server", async ({ browser }) => {
  test.skip(!SFR, "needs evidence/app-builder/r4/sfr/shell-root-not-found-no-identity.patch (ATRIUM_E2E_SFR_R4=0 opted out)");
  const NAME = "Quorra Zephyrine-Vantablack";
  const who = await freshPerson("quorra-r4@atrium.test", NAME, "member");
  const app = await probeApp(`r4-identity-${RUN}`);
  await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: "everyone", edit: "owner", guests: true } });
  const ctx = await signedInContext(browser, who);
  const page = await ctx.newPage();
  // The snapshot as the server renders it for this person.
  const snap = await (await page.request.get(`/a/${app.slug}?offline=1`)).text();
  expect(snap).toContain("data-atrium-offline-snapshot");
  await page.goto(`/a/${app.slug}`);
  await expect(page.getByText(PROBE)).toBeVisible();
  await primeOffline(page, app.slug);
  const stored = await offlineStores(page);
  // The session ends on the server only (expiry), so no sign-out response reaches the browser.
  const d = db();
  try { d.prepare("UPDATE session SET expires_at = ? WHERE user_id = ?").run(1000, who.id); } finally { d.close(); }
  await ctx.setOffline(true);
  const off = await page.goto(`/a/${app.slug}`).catch(() => null);
  const offHtml = off ? await off.text().catch(() => "") : "";
  await expect(page.getByText(PROBE)).toBeVisible(); // the offline copy still works
  await page.screenshot({ path: ev("screens", "item2-offline-after-expiry.png") });
  await ctx.setOffline(false);
  const texts = [{ where: "snapshot fetch", text: snap }, ...stored.caches.map((c) => ({ where: c.url, text: c.text })), { where: "offline answer", text: offHtml }];
  const hits = texts.flatMap((t) => [who.email, NAME, "Quorra", who.id].filter((s) => t.text.includes(s)).map((s) => `${t.where}: ${s}`));
  saveText("security/item2-identity.json", JSON.stringify({ checked: texts.map((t) => ({ where: t.where, bytes: t.text.length })), hits }, null, 2));
  expect(hits).toEqual([]);
  // The shell's own not-found room still names the person (fetched on the client).
  const nf = await signedInContext(browser, who);
  const np = await nf.newPage();
  await np.goto("/no-such-place-r4");
  await expect(np.locator("[data-not-found-in-shell]")).toBeVisible();
  await expect.poll(async () => (await np.content()).includes("Quorra"), { timeout: 10_000 }).toBe(true);
  await nf.close();
  await ctx.close();
});

// ---------- Item 3 (the toggle's value reaches the device) ----------
type Lamp = { url: string; hits: unknown[]; close(): Promise<void> };
async function lampServer(): Promise<Lamp> {
  const lamp: Lamp = { url: "", hits: [], close: async () => {} };
  const s = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/lamp") lamp.hits.push(raw ? JSON.parse(raw) : "(empty body)");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: 1, unit: "" }));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  lamp.url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  lamp.close = () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); });
  return lamp;
}
const LAMP_PARAMS = { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] };

test("item 3: the publish review warns when a toggle maps a parameter its command never sends (empty body); publishing stays possible", async ({ browser }) => {
  const lamp = await lampServer();
  try {
    const c = await owner();
    const integ = await (await c.post("/api/integrations", { data: { packageId: "custom-api", name: "Lamp API r4 empty", config: { baseUrl: lamp.url }, secrets: {}, untested: true } })).json();
    expect((await c.post(`/api/integrations/${integ.id}/commands`, { data: { id: "lamp.toggle", label: "Desk lamp", description: "Desk lamp", method: "POST", path: "/lamp", params: LAMP_PARAMS, risk: "low" } })).ok()).toBe(true);
    expect((await c.post(`/api/integrations/${integ.id}/commands/publish`, { data: {} })).ok()).toBe(true);
    const app = await create({ name: "R4 lamp empty", slug: `r4-lamp-empty-${RUN}` });
    const d = await draftOf(app.id);
    await ops(app.id, [
      { op: "control.set", control: { id: "k_rfourlampe", label: "Desk lamp", run: { kind: "command", integrationId: integ.id, commandId: "lamp.toggle", params: { on: { $bind: "{{ $input }}" } } } } },
      { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_rfourlampe", type: "toggle", props: { label: "Desk lamp", control: "k_rfourlampe" }, slot: { x: 0, y: 0, w: 4, h: 9 } } },
    ]);
    const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
    const page = await ctx.newPage();
    await page.goto(`/build/${app.slug}`);
    await expect(page.locator("[data-builder-bar]")).toBeVisible();
    await page.locator("[data-publish]").click();
    const warning = page.locator('[data-review-problem="warning"]').filter({ hasText: "Desk lamp sets on, but the command Desk lamp never sends it" });
    await expect(warning).toBeVisible();
    await expect(page.locator("[data-publish-confirm]")).toBeEnabled();
    await page.screenshot({ path: ev("screens", "item3-review-warns-unsent.png") });
    saveText("logs/item3-review.json", JSON.stringify({ warning: await warning.innerText() }, null, 2));
    await ctx.close();
  } finally {
    await lamp.close();
  }
});

test("item 3 (with the integrations SFR): the Add a command form pre-fills a body that sends on, warns when it does not, and a guest's flips reach the stand-in lamp as on true and false", async ({ browser }) => {
  test.skip(!SFR, "needs evidence/app-builder/r4/sfr/integrations-command-form-sends-params.patch (ATRIUM_E2E_SFR_R4=0 opted out)");
  const lamp = await lampServer();
  try {
    const c = await owner();
    const integ = await (await c.post("/api/integrations", { data: { packageId: "custom-api", name: "Lamp API r4", config: { baseUrl: lamp.url }, secrets: {}, untested: true } })).json();
    const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
    const page = await ctx.newPage();
    await page.goto(`/integrations/${integ.id}`);
    await expect(page.locator("[data-add-command]")).toBeVisible();
    const body = page.locator("#cmd-body");
    const defaults = { body: await body.inputValue(), params: await page.locator("#cmd-params").inputValue() };
    expect(JSON.parse(defaults.body)).toEqual({ on: "{{ params.on }}" });
    await expect(page.locator("[data-unsent-params]")).toHaveCount(0);
    // An empty body says what would be lost.
    await body.fill("");
    await expect(page.locator('[data-unsent-params="on"]')).toContainText('"on" is declared but never sent');
    await page.screenshot({ path: ev("screens", "item3-command-form-warns.png") });
    await body.fill(defaults.body);
    await expect(page.locator("[data-unsent-params]")).toHaveCount(0);
    await page.locator("#cmd-id").fill("lamp.toggle");
    await page.locator("#cmd-label").fill("Desk lamp");
    await page.locator("#cmd-path").fill("/lamp");
    await page.screenshot({ path: ev("screens", "item3-command-form-defaults.png") });
    await page.locator("[data-add-command] button[type=submit]").click();
    await page.locator("[data-publish-commands]").click();
    await expect(page.locator("[data-pending-commands]")).toHaveCount(0);
    await ctx.close();
    // A toggle mapped to on, published for guests; the review has nothing to say about it.
    const app = await create({ name: "R4 lamp", slug: `r4-lamp-${RUN}` });
    const d = await draftOf(app.id);
    await ops(app.id, [
      { op: "control.set", control: { id: "k_rfourlampa", label: "Desk lamp", run: { kind: "command", integrationId: integ.id, commandId: "lamp.toggle", params: { on: { $bind: "{{ $input }}" } } } } },
      { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_rfourlampa", type: "toggle", props: { label: "Desk lamp", control: "k_rfourlampa" }, slot: { x: 0, y: 0, w: 4, h: 9 } } },
    ]);
    const review = await (await c.get(`/api/apps/${app.id}/review`)).json();
    expect((review.problems as { code: string }[]).filter((p) => p.code.startsWith("control."))).toEqual([]);
    await publish(app.id);
    await c.put(`/api/apps/${app.id}/access`, { data: { view: "owner", edit: "owner", guests: true } });
    const g = await contextFor(browser, null, { variant: LIGHT });
    const { page: gp } = await guestPage(g, app.id, "r4 lamp guest");
    await gp.waitForLoadState("networkidle").catch(() => {});
    await gp.waitForTimeout(800);
    const sw = gp.getByRole("switch", { name: "Desk lamp" });
    await sw.click();
    await expect.poll(() => lamp.hits.length, { timeout: 8000 }).toBe(1);
    await gp.waitForTimeout(800); // past the control's cooldown
    await sw.click();
    await expect.poll(() => lamp.hits.length, { timeout: 8000 }).toBe(2);
    expect(lamp.hits).toEqual([{ on: true }, { on: false }]);
    await gp.screenshot({ path: ev("screens", "item3-guest-flipped.png") });
    await g.close();
    saveText("logs/item3-lamp.json", JSON.stringify({ formDefaults: defaults, hits: lamp.hits }, null, 2));
  } finally {
    await lamp.close();
  }
});

// ---------- Item 4: a guest sees source-free bindings resolved ----------
test("item 4: a guest's stat bound to a source-free expression reads 41.3 % like the owner's, online and in the offline snapshot, with and without unconnected sources", async ({ browser }) => {
  const out: Record<string, unknown> = {};
  for (const withUnmapped of [false, true]) {
    const slug = `r4-free-${withUnmapped ? "u" : "p"}-${RUN}`;
    const app = withUnmapped ? await create({ name: "R4 free u", slug, template: "homelab", mappings: {} }) : await create({ name: "R4 free p", slug });
    const d = await draftOf(app.id);
    await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_rfourstat2", type: "stat", props: { data: { $bind: "{{ 41.27 | round(1) }}" }, unit: "%", label: "CPU" }, slot: { x: 0, y: 90, w: 4, h: 8 } } }]);
    await publish(app.id);
    await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: "owner", edit: "owner", guests: true } });
    const stat = (p: Page) => p.locator('[data-node-id="c_rfourstat2"], [data-node="c_rfourstat2"]').first();
    const o = await contextFor(browser, OWNER, { variant: LIGHT });
    const op = await o.newPage();
    await op.goto(`/a/${app.slug}`);
    await expect(stat(op)).toContainText("41.3");
    const ownerText = (await stat(op).innerText()).replace(/\s+/g, " ").trim();
    await o.close();
    const g = await contextFor(browser, null, { variant: LIGHT });
    const { page: gp } = await guestPage(g, app.id, `r4 free ${withUnmapped ? "u" : "p"}`);
    await expect(stat(gp)).toContainText("41.3");
    const guestText = (await stat(gp).innerText()).replace(/\s+/g, " ").trim();
    expect(guestText).toBe(ownerText);
    await stat(gp).scrollIntoViewIfNeeded();
    await gp.screenshot({ path: ev("screens", `item4-guest-stat-${withUnmapped ? "unconnected" : "plain"}.png`) });
    // The offline snapshot (the guest projection) has the value in its server render.
    const snap = await (await gp.request.get(`/a/${app.slug}?offline=1`)).text();
    expect(snap).toContain("data-atrium-offline-snapshot");
    expect(snap).toMatch(/41\.3/);
    out[slug] = { ownerText, guestText, snapshotHas413: /41\.3/.test(snap) };
    await g.close();
  }
  saveText("logs/item4-guest-stat.json", JSON.stringify(out, null, 2));
});

// ---------- Item 5: the narrow builder bar fits its controls ----------
test("item 5: at 360 and 390px, light, dark and light-solid, every builder bar label sits inside its 44px+ box; Publish keeps its padding; the app name shows a few letters; Apps is one line", async ({ browser }) => {
  const app = await create({ name: "My homelab dashboard", slug: `r4-narrow-bar-${RUN}`, template: "homelab", mappings: {} });
  const out: Record<string, unknown> = {};
  for (const width of [360, 390]) {
    for (const v of [LIGHT, DARK, SOLID]) {
      const ctx = await contextFor(browser, OWNER, { variant: v, viewport: { width, height: 800 }, mobile: true });
      const page = await ctx.newPage();
      await page.goto(`/build/${app.slug}`);
      const bar = page.locator("[data-builder-bar]");
      await expect(bar).toBeVisible();
      await page.waitForTimeout(400);
      const m = await bar.evaluate((root) => {
        const rect = (r: DOMRect) => ({ l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10, t: Math.round(r.top * 10) / 10, b: Math.round(r.bottom * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
        // Every drawn text node of the element: its union box, and the most lines any one node wraps to.
        const textBox = (el: Element) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const rs: DOMRect[] = [];
          let lines = 0;
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim() || n.parentElement?.closest(".sr-only")) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            // Text cut off by an ellipsis inside the control (overflow hidden) is not drawn: clip to that box.
            let clip: DOMRect | null = null;
            for (let a = n.parentElement; a && a !== el.parentElement; a = a.parentElement) {
              const o = getComputedStyle(a).overflowX;
              if (o === "hidden" || o === "clip") { clip = a.getBoundingClientRect(); break; }
            }
            const own = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => (clip ? new DOMRect(Math.max(r.left, clip.left), r.top, Math.max(0, Math.min(r.right, clip.right) - Math.max(r.left, clip.left)), r.height) : r));
            lines = Math.max(lines, new Set(own.map((r) => Math.round(r.top))).size);
            rs.push(...own);
          }
          if (!rs.length) return null;
          return { l: Math.min(...rs.map((r) => r.left)), r: Math.max(...rs.map((r) => r.right)), t: Math.min(...rs.map((r) => r.top)), b: Math.max(...rs.map((r) => r.bottom)), lines };
        };
        const visible = (el: Element) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0; };
        const controls = [...root.querySelectorAll("a, button, [data-select]")].filter(visible).filter((el) => !el.closest("[data-select]") || el.matches("[data-select]"));
        const items = controls.map((el) => {
          const box = el.getBoundingClientRect();
          // Text that is visually hidden (sr-only) is not drawn, so textBox leaves it out.
          const t = textBox(el);
          let spill = 0;
          if (t) spill = Math.max(0, box.left - t.l, t.r - box.right, box.top - t.t, t.b - box.bottom);
          return { name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40), box: rect(box), text: t ? { l: Math.round(t.l), r: Math.round(t.r), lines: t.lines } : null, spill: Math.round(spill * 10) / 10, minSide: Math.round(Math.min(box.width, box.height)) };
        });
        const pub = root.querySelector("[data-publish]")!;
        const pt = textBox(pub)!;
        const pb = pub.getBoundingClientRect();
        const title = root.querySelector("[data-builder-title]")!;
        const back = root.querySelector("[data-back-to-apps]")!;
        return {
          items,
          barOverflow: root.scrollWidth - root.clientWidth,
          publishPad: { left: Math.round(pt.l - pb.left), right: Math.round(pb.right - pt.r) },
          title: { width: Math.round(title.getBoundingClientRect().width), shown: title.textContent },
          backLines: textBox(back)!.lines,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      out[`${width}-${v.name}`] = m;
      for (const it of m.items) {
        expect(it.spill, `${width} ${v.name}: "${it.name}" text spills ${it.spill}px`).toBeLessThanOrEqual(0.5);
        expect(it.minSide, `${width} ${v.name}: "${it.name}" is ${it.minSide}px`).toBeGreaterThanOrEqual(44);
        if (it.text) expect(it.text.lines, `${width} ${v.name}: "${it.name}" wraps`).toBe(1);
      }
      expect(m.publishPad.left).toBeGreaterThanOrEqual(8);
      expect(m.publishPad.right).toBeGreaterThanOrEqual(8);
      expect(m.title.width).toBeGreaterThanOrEqual(40); // a few letters, not one
      expect(m.backLines).toBe(1);
      expect(m.barOverflow).toBeLessThanOrEqual(0);
      expect(m.pageOverflow).toBeLessThanOrEqual(0);
      await bar.screenshot({ path: ev("screens", `item5-bar-${width}-${v.name}.png`) });
      await page.screenshot({ path: ev("screens", `item5-builder-${width}-${v.name}.png`) });
      await ctx.close();
    }
  }
  saveText("logs/item5-bar.json", JSON.stringify(out, null, 2));
});
