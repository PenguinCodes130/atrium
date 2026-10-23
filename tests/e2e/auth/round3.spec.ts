// Auth round 3 e2e, "guest" scenario (guest links, auth-spec-v2). Start the slot first:
//   tests/e2e/auth/serve.sh guest &   then
//   ATRIUM_E2E_ROUND=r3 ATRIUM_E2E_SCENARIO=guest ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 pnpm exec playwright test tests/e2e/auth/round3.spec.ts
// Wave 2: app-builder's real app access hook is live, so the guest apps ("lounge" and "garage") are created,
// published and opened to guests through app-builder's API (seedApps below). The old test-only preload
// resolver (app-access-preload.mjs) is retired.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { EVIDENCE, SCENARIO, VARIANTS, applyVariant, db, freshIp, minContrast, shot, tabAudit, type Variant } from "./helpers";

test.skip(SCENARIO !== "guest", "guest scenario only");
test.describe.configure({ mode: "serial" });

const isMobile = () => test.info().project.name === "mobile";
const suffix = () => (isMobile() ? "-mobile" : "");
const SEEDS = "test-results/auth/v10-seeds-r3.json";
const TRAFFIC = "test-results/auth/traffic-r3.txt";

/** The real guest apps, made through app-builder once per worker: lounge (guests on) and garage (guests on). */
const apps: { lounge: string; garage: string } = { lounge: "", garage: "" };
async function seedApps(api: APIRequestContext): Promise<{ lounge: string; garage: string }> {
  if (apps.lounge && apps.garage) return apps;
  const tiles = ((await (await api.get("/api/apps")).json()).tiles ?? []) as { app: { id: string; slug: string; publishedVersion?: number } }[];
  for (const [slug, name] of [["lounge", "Guest room"], ["garage", "Garage"]] as const) {
    let app = tiles.find((t) => t.app.slug === slug)?.app;
    if (!app) {
      const created = await api.post("/api/apps", { data: { name, slug } });
      expect(created.status(), await created.text()).toBe(201);
      app = (await created.json()).app as { id: string; slug: string };
    }
    if (!app.publishedVersion) {
      const draft = (await (await api.get(`/api/apps/${app.id}/draft`)).json()) as { rev: number; doc: { pages: { root: { id: string } }[] } };
      const add = await api.post(`/api/apps/${app.id}/ops`, { data: { rev: draft.rev, ops: [{ op: "node.add", parentId: draft.doc.pages[0]!.root.id, node: { id: `c_${slug}head`, type: "heading", props: { text: name, level: 1 }, slot: { x: 0, y: 0, w: 12, h: 8 } } }] } });
      expect(add.ok(), await add.text()).toBe(true);
      const review = await (await api.get(`/api/apps/${app.id}/review`)).json();
      const pub = await api.post(`/api/apps/${app.id}/publish`, { data: { expectRev: review.rev, note: "guest e2e" } });
      expect(pub.ok(), await pub.text()).toBe(true);
    }
    const access = await api.put(`/api/apps/${app.id}/access`, { data: { view: "everyone", edit: "owner", guests: true } });
    expect(access.ok(), await access.text()).toBe(true);
    apps[slug] = app.id;
  }
  return apps;
}

function seed(name: string, value: string) {
  mkdirSync("test-results/auth", { recursive: true });
  const all = existsSync(SEEDS) ? JSON.parse(readFileSync(SEEDS, "utf8")) : {};
  all[`${test.info().project.name} ${name}`] = value;
  writeFileSync(SEEDS, JSON.stringify(all, null, 2));
}

/** A random 8-digit PIN, so the V10 grep cannot match it by chance in minified code. */
const randomPin = () => String(10_000_000 + Math.floor(Math.random() * 89_999_999));

/** Records an owner API response that came after the one-time create response. */
async function recordApi(label: string, res: { status(): number; url(): string; headers(): Record<string, string>; text(): Promise<string> }) {
  appendFileSync(TRAFFIC, `--- ${res.status()} ${res.url()} (${label})\n${JSON.stringify(res.headers())}\n${await res.text()}\n`);
}

/** Records every response body a guest browser sees (V10: none may hold a token, PIN, hash or cookie). */
function record(page: Page) {
  page.on("response", async (res) => {
    try {
      const body = await res.text();
      appendFileSync(TRAFFIC, `--- ${res.status()} ${res.url()}\n${JSON.stringify(res.headers())}\n${body}\n`);
    } catch {
      /* redirects and aborted requests have no body */
    }
  });
}

function resetOwnerLimit() {
  const d = db();
  d.prepare("DELETE FROM auth_rate_limit WHERE key = ?").run(`signInAccount:${OWNER.email}`);
  d.close();
}

async function ownerApi(baseURL: string): Promise<APIRequestContext> {
  resetOwnerLimit();
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL, "x-forwarded-for": freshIp() } });
  const r = await api.post("/api/auth/sign-in/email", { data: { email: OWNER.email, password: OWNER.password } });
  expect(r.status()).toBe(200);
  return api;
}

let n = 0;
async function createLink(api: APIRequestContext, extra: Record<string, unknown> = {}) {
  n += 1;
  const { lounge } = await seedApps(api);
  const res = await api.post("/api/auth/atrium/guest-links", { data: { appId: lounge, label: `Guest room ${n}`, ...extra } });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { url: string; link: { id: string } };
  const token = body.url.slice(body.url.lastIndexOf("/") + 1);
  seed(`guest token ${n}`, token);
  if (typeof extra.pin === "string") seed(`guest PIN ${n}`, extra.pin);
  const row = (() => {
    const d = db();
    try {
      return d.prepare("SELECT token_hash, pin_hash FROM guest_link WHERE id = ?").get(body.link.id) as { token_hash: string; pin_hash: string | null };
    } finally {
      d.close();
    }
  })();
  seed(`guest token hash ${n}`, row.token_hash);
  if (row.pin_hash) seed(`guest PIN hash ${n}`, row.pin_hash);
  return { ...body, token, path: `/g/${token}` };
}

async function guestContext(browser: Browser, baseURL: string, v?: Variant, reducedMotion: "reduce" | "no-preference" = "no-preference") {
  const ctx = await browser.newContext({ ...test.info().project.use, baseURL, reducedMotion, extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
  if (v) await applyVariant(ctx, v, baseURL);
  return ctx;
}

async function guestCookie(ctx: BrowserContext) {
  const c = (await ctx.cookies()).find((x) => x.name === "atrium.guest");
  if (c) {
    seed(`guest cookie ${c.value.slice(-6)}`, c.value);
    seed(`guest cookie hash ${c.value.slice(-6)}`, createHash("sha256").update(c.value).digest("hex"));
  }
  return c;
}

async function setGuests(api: APIRequestContext, on: boolean) {
  const { lounge } = await seedApps(api);
  const r = await api.put(`/api/apps/${lounge}/access`, { data: { view: "everyone", edit: "owner", guests: on } });
  expect(r.ok(), await r.text()).toBe(true);
}

test.beforeEach(async ({ page }) => {
  resetOwnerLimit();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
});

// ---- Criterion 9 and 16 --------------------------------------------------------------------------

test("a valid link without a PIN sets the guest cookie and lands on /a/<slug> (criterion 9)", async ({ browser, baseURL }) => {
  const api = await ownerApi(baseURL!);
  const link = await createLink(api);
  const ctx = await guestContext(browser, baseURL!);
  const page = await ctx.newPage();
  record(page);
  await page.goto(link.path);
  expect(new URL(page.url()).pathname).toBe("/a/lounge");
  const c = await guestCookie(ctx);
  expect(c).toBeTruthy();
  expect(c!).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/", secure: false });
  expect(c!.value).toMatch(/^atr_gs_[A-Za-z0-9_-]{43}$/);
  writeFileSync(
    path.join(EVIDENCE, `guest-open${suffix()}.txt`),
    [`GET ${"/g/atr_g_<redacted>"} -> ${new URL(page.url()).pathname}`, `cookie atrium.guest: httpOnly=${c!.httpOnly} sameSite=${c!.sameSite} path=${c!.path} secure=${c!.secure} (public URL is http) expires=${new Date(c!.expires * 1000).toISOString()}`].join("\n") + "\n",
  );
  await ctx.close();
  await api.dispose();
});

test("a signed-in user opening a link goes on as themself: no guest cookie (criterion 16)", async ({ page, baseURL }) => {
  const api = await ownerApi(baseURL!);
  const link = await createLink(api);
  resetOwnerLimit();
  const r = await page.request.post(`${baseURL}/api/auth/sign-in/email`, { headers: { origin: baseURL! }, data: { email: OWNER.email, password: OWNER.password } });
  expect(r.status()).toBe(200);
  await page.goto(link.path);
  expect(new URL(page.url()).pathname).toBe("/a/lounge");
  expect((await page.context().cookies()).some((c) => c.name === "atrium.guest")).toBe(false);
  await api.dispose();
});

// ---- Screens: expired, PIN, locked (V4, V5, V8, criterion 31) ------------------------------------------

for (const v of VARIANTS) {
  test(`expired link screen, ${v.name} (criteria 10, 31)`, async ({ browser, baseURL }) => {
    const ctx = await guestContext(browser, baseURL!, v);
    const page = await ctx.newPage();
    record(page);
    await page.goto(`/g/atr_g_${"x".repeat(43)}`);
    expect(new URL(page.url()).pathname).toBe("/g/expired");
    await expect(page.getByText("This link has expired or was turned off")).toBeVisible();
    expect(await ctx.cookies()).not.toContainEqual(expect.objectContaining({ name: "atrium.guest" }));
    const focusables = await page.locator("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])").count();
    expect(focusables).toBe(0);
    const contrast = await minContrast(page);
    expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: shot(`guest-expired-${v.name}${suffix()}`), fullPage: true });
    appendFileSync(path.join(EVIDENCE, "a11y-guest-screens.txt"), `expired ${v.name}${suffix()}: focusable controls ${focusables}; worst text contrast ${contrast.ratio.toFixed(2)} ("${contrast.text}")\n`);
    await ctx.close();
  });

  test(`guest PIN screen by keyboard alone, ${v.name} (criteria 11, 31)`, async ({ browser, baseURL }) => {
    const api = await ownerApi(baseURL!);
    const pin = randomPin();
    const link = await createLink(api, { pin });
    const ctx = await guestContext(browser, baseURL!, v);
    const page = await ctx.newPage();
    record(page);
    await page.goto(link.path);
    expect(new URL(page.url()).pathname).toBe(`${link.path}/pin`);
    expect(await guestCookie(ctx)).toBeUndefined();
    const field = page.getByLabel("PIN");
    await expect(field).toBeFocused();
    await page.screenshot({ path: shot(`guest-pin-${v.name}${suffix()}`), fullPage: true });

    // Keyboard only: a wrong PIN, Enter, then the message with tries left.
    await page.keyboard.type("0000");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Wrong PIN. 4 tries left.")).toBeVisible();
    expect(await guestCookie(ctx)).toBeUndefined();
    await page.screenshot({ path: shot(`guest-pin-wrong-${v.name}${suffix()}`), fullPage: true });

    const tabs = await tabAudit(page, 6);
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll("input, button")].map((e) => {
        const r = e.getBoundingClientRect();
        return { tag: e.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    );
    const contrast = await minContrast(page);
    appendFileSync(
      path.join(EVIDENCE, "a11y-guest-screens.txt"),
      `pin ${v.name}${suffix()}: tab order ${JSON.stringify(tabs)}; control sizes ${JSON.stringify(sizes)}; worst text contrast ${contrast.ratio.toFixed(2)} ("${contrast.text}")\n`,
    );
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    for (const t of tabs) expect(t.outline).toMatch(/^solid 2px 3px$/);
    if (isMobile()) for (const s of sizes) expect(s.h).toBeGreaterThanOrEqual(44);
    expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);

    // The right PIN, by keyboard: the guest lands on the app with the cookie.
    await field.focus();
    await page.keyboard.type(pin);
    await page.keyboard.press("Enter");
    await page.waitForURL("**/a/lounge");
    const c = await guestCookie(ctx);
    expect(c).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    await ctx.close();
    await api.dispose();
  });

  test(`locked PIN screen, ${v.name} (criterion 12)`, async ({ browser, baseURL }) => {
    const api = await ownerApi(baseURL!);
    const pin = randomPin();
    const link = await createLink(api, { pin });
    // Fresh devices with no session (a signed-in user is never asked for the PIN, criterion 16).
    const device = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL! } });
    for (let i = 0; i < 5; i++) {
      const r = await device.post(link.path, { data: { pin: "0000" }, headers: { "x-forwarded-for": freshIp() } });
      expect(r.status()).toBe(i < 4 ? 401 : 429);
    }
    const sixth = await device.post(link.path, { data: { pin }, headers: { "x-forwarded-for": freshIp() } });
    expect(sixth.status()).toBe(429);
    expect(sixth.headers()["set-cookie"] ?? "").not.toContain("atrium.guest");
    const ctx = await guestContext(browser, baseURL!, v);
    const page = await ctx.newPage();
    record(page);
    await page.goto(link.path);
    await expect(page.getByText("Too many tries. Try again in 15 minutes.")).toBeVisible();
    await expect(page.getByLabel("PIN")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    await page.screenshot({ path: shot(`guest-pin-locked-${v.name}${suffix()}`), fullPage: true });
    await ctx.close();
    await device.dispose();
    await api.dispose();
  });
}

test("PIN screen with reduced motion (V8)", async ({ browser, baseURL }) => {
  const api = await ownerApi(baseURL!);
  const link = await createLink(api, { pin: randomPin() });
  const ctx = await guestContext(browser, baseURL!, VARIANTS[0], "reduce");
  const page = await ctx.newPage();
  await page.goto(link.path);
  await page.getByLabel("PIN").fill("1357");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Wrong PIN. 4 tries left.")).toBeVisible();
  await page.screenshot({ path: shot(`guest-pin-reduced-motion${suffix()}`), fullPage: true });
  const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  expect(reduced).toBe(true);
  await ctx.close();
  await api.dispose();
});

// ---- Revocation (criteria 21, 22, A1.3) ------------------------------------------------------------------

test("revoking a link or turning guests off ends the guest session on the next load, which shows the expired screen", async ({ browser, baseURL }) => {
  test.skip(isMobile(), "desktop project only");
  const api = await ownerApi(baseURL!);
  const a = await createLink(api);
  const b = await createLink(api);
  const lines: string[] = [];
  const one = await guestContext(browser, baseURL!);
  const p1 = await one.newPage();
  record(p1);
  await p1.goto(a.path);
  expect(new URL(p1.url()).pathname).toBe("/a/lounge");
  const revoke = await api.post(`/api/auth/atrium/guest-links/${a.link.id}/revoke`);
  expect(revoke.status()).toBe(200);
  await recordApi("owner revoke", revoke);
  await p1.reload();
  await expect(p1.getByText("This link has expired or was turned off")).toBeVisible();
  lines.push(`revoked: reload of /a/lounge shows "${await p1.locator("[data-guest-expired]").innerText()}" at ${new URL(p1.url()).pathname}`);
  const stream = await p1.request.get("/api/data/stream");
  expect(stream.status()).toBe(401);
  lines.push(`revoked: GET /api/data/stream -> ${stream.status()}`);
  await p1.screenshot({ path: shot("guest-ended-on-app") });

  const two = await guestContext(browser, baseURL!);
  const p2 = await two.newPage();
  await p2.goto(b.path);
  expect(new URL(p2.url()).pathname).toBe("/a/lounge");
  await setGuests(api, false);
  try {
    await p2.reload();
    await expect(p2.getByText("This link has expired or was turned off")).toBeVisible();
    lines.push("guests off: reload shows the expired screen");
  } finally {
    await setGuests(api, true);
  }
  await p2.reload();
  await expect(p2.getByText("This link has expired or was turned off")).toBeVisible();
  lines.push("guests back on: still the expired screen (links stay revoked, amendment A1.1)");
  const listRes = await api.get(`/api/auth/atrium/guest-links?appId=${apps.lounge}`);
  await recordApi("owner list", listRes);
  const list = (await listRes.json()) as { links: { id: string; status: string; revokedCause: string | null }[] };
  lines.push(`list: ${JSON.stringify(list.links.filter((l) => [a.link.id, b.link.id].includes(l.id)).map((l) => ({ status: l.status, cause: l.revokedCause })))}`);
  writeFileSync(path.join(EVIDENCE, "guest-revocation.txt"), lines.join("\n") + "\n");
  await one.close();
  await two.close();
  await api.dispose();
});

// ---- Route sweep and limits (criteria 17 to 19, 26, A1.3) ------------------------------------------------

test("route sweep with only a guest cookie, and with no cookie (criteria 17 to 19)", async ({ baseURL }) => {
  test.skip(isMobile(), "desktop project only");
  const api = await ownerApi(baseURL!);
  const link = await createLink(api);
  const open = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
  const first = await open.get(link.path, { maxRedirects: 0 });
  expect(first.status()).toBe(303);
  const value = /atrium\.guest=([^;]+)/.exec(first.headers()["set-cookie"] ?? "")![1]!;
  seed("guest cookie sweep", value);
  const guest = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { cookie: `atrium.guest=${value}`, "x-forwarded-for": freshIp(), origin: baseURL! } });
  const none = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
  const lines: string[] = [];
  const check = async (ctx: APIRequestContext, who: string, p: string, method: "GET" | "POST" = "GET") => {
    const res = method === "GET" ? await ctx.get(p, { maxRedirects: 0 }) : await ctx.post(p, { maxRedirects: 0, data: {} });
    const loc = res.headers()["location"] ?? "";
    lines.push(`${who.padEnd(12)} ${method.padEnd(4)} ${p.padEnd(34)} ${res.status()} ${loc ? new URL(loc, baseURL).pathname : ""}`);
    return { status: res.status(), loc: loc ? new URL(loc, baseURL).pathname : "" };
  };
  for (const p of ["/", "/build/lounge", "/settings", "/library", "/audit", "/integrations", "/approvals", "/settings/users"]) {
    expect(await check(guest, "guest cookie", p)).toEqual({ status: 307, loc: "/sign-in" });
  }
  for (const p of ["/mcp", "/api/integrations", "/api/agent-tokens", "/api/palette", "/api/settings", "/api/apps", `/api/auth/atrium/guest-links?appId=${apps.lounge}`]) {
    expect((await check(guest, "guest cookie", p)).status).toBe(401);
  }
  // Another app: signed out, even with guests on for it.
  expect(await check(guest, "guest cookie", "/a/garage")).toEqual({ status: 307, loc: "/sign-in" });
  // Own app: app-builder's pages answer. A guest asking for the draft gets the published page (A4, lead item A).
  for (const p of ["/a/lounge", "/a/lounge?draft=1", "/a/lounge/manifest.webmanifest"]) expect((await check(guest, "guest cookie", p)).status).toBe(200);
  const draftAsk = await guest.get("/a/lounge?draft=1", { maxRedirects: 0 });
  expect(await draftAsk.text()).not.toContain("data-draft-preview-bar");
  // The control run route is integrations': the gate lets the guest through (no sign-in redirect); the
  // handler's own answer is recorded, not asserted, because its requireViewer() wiring is integrations' work.
  expect((await check(guest, "guest cookie", "/api/controls/run", "POST")).loc).not.toBe("/sign-in");
  // No cookie: /g/* and /sandbox/* pass the gate; the rest redirect or 401.
  expect((await check(none, "no cookie", `/g/atr_g_${"q".repeat(43)}`)).loc).toBe("/g/expired");
  expect((await check(none, "no cookie", "/g/expired")).status).toBe(200);
  expect((await check(none, "no cookie", "/sandbox/frame")).loc).not.toBe("/sign-in");
  for (const p of ["/a/lounge", "/settings", "/"]) expect((await check(none, "no cookie", p)).status).toBe(307);
  for (const p of ["/api/data/stream", "/api/controls/run", "/api/integrations"]) expect((await check(none, "no cookie", p)).status).toBe(401);
  writeFileSync(path.join(EVIDENCE, "route-sweep-guest.txt"), lines.join("\n") + "\n");
  for (const c of [api, open, guest, none]) await c.dispose();
});

test("the 121st guest request in a minute gets 429 with Retry-After; /g/ opens are limited to 30 per IP (criterion 26, A1.3)", async ({ baseURL }) => {
  test.skip(isMobile(), "desktop project only");
  const api = await ownerApi(baseURL!);
  const link = await createLink(api);
  const ip = freshIp();
  const open = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": ip } });
  const first = await open.get(link.path, { maxRedirects: 0 });
  const value = /atrium\.guest=([^;]+)/.exec(first.headers()["set-cookie"] ?? "")![1]!;
  seed("guest cookie limit", value);
  const guest = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { cookie: `atrium.guest=${value}`, "x-forwarded-for": freshIp() } });
  const statuses: number[] = [];
  for (let i = 0; i < 121; i++) statuses.push((await guest.get(i % 2 ? "/a/lounge" : "/api/data/widget/probe", { maxRedirects: 0, timeout: 10_000 }).catch(() => null))?.status() ?? -1);
  const last = await guest.get("/a/lounge", { maxRedirects: 0 });
  const lines = [`statuses 1..121: ${JSON.stringify(statuses.reduce<Record<string, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {}))}`, `request 122: ${last.status()} Retry-After ${last.headers()["retry-after"]}`];
  expect(statuses.slice(0, 120)).not.toContain(429);
  expect(statuses[120]).toBe(429);
  expect(last.status()).toBe(429);
  expect(Number(last.headers()["retry-after"])).toBeGreaterThan(0);
  // /g/<token> from one IP: 30 per minute (the first open above counted once).
  const opens: number[] = [];
  for (let i = 0; i < 30; i++) opens.push((await open.get(`/g/atr_g_${"r".repeat(43)}`, { maxRedirects: 0 })).status());
  lines.push(`/g/ opens from one IP, 2..31: ${JSON.stringify(opens.reduce<Record<string, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {}))}`);
  expect(opens.slice(0, 29)).not.toContain(429);
  expect(opens[29]).toBe(429);
  writeFileSync(path.join(EVIDENCE, "guest-rate-limits.txt"), lines.join("\n") + "\n");
  for (const c of [api, open, guest]) await c.dispose();
});
