import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import type { App, AppAccessResolver, Principal, UserSet } from "@/core/contracts";
import { Client, freshDataDir, setEnv, PUBLIC_URL } from "./test/harness";

// Auth round 3: guest links (stages/02-subsystem-spec/output/auth-spec-v2.md, architecture v3 5.1 and
// amendment A1). The app access hook is unregistered in Wave 1, so every test that needs it registers
// the test double below; criterion 28 checks the unregistered behaviour.

const OWNER = { email: "owner@atrium.test", password: "unit-owner-password-123" };
const APP_ROOT = path.resolve(__dirname, "../../..");
const DAY = 86_400_000;
const MIN = 60_000;

vi.setConfig({ testTimeout: 60_000 });

// ---- The app access test double -------------------------------------------------------------------

type TestApps = Map<string, App>;

function inSet(set: UserSet, userId: string): boolean {
  return set === "everyone" || (typeof set === "object" && set.userIds.includes(userId));
}

function testResolver(apps: TestApps): AppAccessResolver {
  return {
    appBySlug: async (slug) => [...apps.values()].find((a) => a.slug === slug) ?? null,
    appById: async (id) => apps.get(id) ?? null,
    appsFor: async () => [],
    guestValues: async () => ({}),
    canOpenApp: async (p, id) => {
      const a = apps.get(id);
      if (!a) return false;
      if (p.kind === "guest") return p.appId === id && a.access.guests;
      if (p.kind !== "user") return false;
      return p.role === "owner" || inSet(a.access.view, p.userId) || inSet(a.access.edit, p.userId);
    },
    canEditApp: async (p, id) => {
      const a = apps.get(id);
      if (!a || p.kind !== "user") return false;
      return p.role === "owner" || (p.role === "member" && inSet(a.access.edit, p.userId));
    },
    publishedControl: async () => null,
  };
}

function makeApp(slug: string, opts: Partial<App["access"]> = {}): App {
  const now = new Date().toISOString();
  return {
    id: `app-${slug}`,
    slug,
    name: `App ${slug}`,
    access: { view: "everyone", edit: "owner", guests: true, ...opts },
    publishedVersion: 1,
    draftRev: 1,
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
  };
}

async function boot(env: Record<string, string | undefined> = {}, opts: { hook?: boolean } = {}) {
  const dir = freshDataDir();
  setEnv({ ATRIUM_DATA_DIR: dir, ATRIUM_OWNER_EMAIL: OWNER.email, ATRIUM_OWNER_PASSWORD: OWNER.password, ...env });
  vi.resetModules();
  const hooks = await import("@/core/hooks");
  hooks.resetAppAccess();
  const apps: TestApps = new Map([
    ["app-lounge", makeApp("lounge")],
    ["app-garage", makeApp("garage")],
  ]);
  if (opts.hook !== false) hooks.registerAppAccess(testResolver(apps));
  const handler = await import("./server/handler");
  const m = {
    dir,
    apps,
    hooks,
    handle: handler.handleAuthRequest,
    bootstrap: await import("./server/bootstrap"),
    session: await import("./server/session"),
    users: await import("./server/users"),
    allowlist: await import("./server/allowlist"),
    authMod: await import("./server/auth"),
    guest: await import("./guest/service"),
    policy: await import("./guest/policy"),
    linksRoute: await import("@/app/api/auth/atrium/guest-links/route"),
    revokeRoute: await import("@/app/api/auth/atrium/guest-links/[id]/revoke/route"),
    gRoute: await import("@/app/g/[token]/route"),
    proxy: (await import("@/proxy")).proxy,
    audit: await import("@/features/audit/write"),
    db: await import("@/core/db"),
  };
  await m.bootstrap.ensureBootstrapped();
  return m;
}
type M = Awaited<ReturnType<typeof boot>>;

/** One in-process client for Better Auth plus auth's guest routes. */
function dispatcher(m: M) {
  return async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    if (u.pathname === "/api/auth/atrium/guest-links") return req.method === "POST" ? m.linksRoute.POST(req) : m.linksRoute.GET(req);
    const rv = /^\/api\/auth\/atrium\/guest-links\/([^/]+)\/revoke$/.exec(u.pathname);
    if (rv) return m.revokeRoute.POST(req, { params: Promise.resolve({ id: rv[1]! }) });
    const g = /^\/g\/([^/]+)$/.exec(u.pathname);
    if (g) {
      const ctx = { params: Promise.resolve({ token: decodeURIComponent(g[1]!) }) };
      return req.method === "POST" ? m.gRoute.POST(req, ctx) : m.gRoute.GET(req, ctx);
    }
    return m.handle(req);
  };
}

const sql = <T = Record<string, unknown>>(m: M, q: string, ...args: unknown[]) => m.db.sqlite().prepare(q).all(...args) as T[];

async function addUser(m: M, email: string, role: "member" | "viewer", password: string) {
  const id = randomUUID();
  const now = Date.now();
  m.db.sqlite().prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, email, email, 1, role, 0, now, now);
  const hash = await m.authMod.hashPassword(password);
  m.db.sqlite().prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, hash, now, now);
  m.allowlist.addAllowlistPattern(email, role);
  return id;
}

let ipN = 10;
async function signedIn(m: M, email = OWNER.email, password = OWNER.password) {
  ipN += 1;
  const c = new Client(dispatcher(m), `203.0.113.${ipN}`);
  const res = await c.post("/api/auth/sign-in/email", { email, password });
  expect(res.status).toBe(200);
  return c;
}

function ownerPrincipal(m: M): Extract<Principal, { kind: "user" }> {
  const [u] = sql<{ id: string }>(m, "SELECT id FROM user WHERE role = 'owner'");
  return { kind: "user", userId: u!.id, role: "owner", via: "session" };
}

async function create(m: M, by: Principal = ownerPrincipal(m), input: Record<string, unknown> = {}) {
  return m.guest.createGuestLink(by, { appId: "app-lounge", label: "Guest room, Sam", ...input });
}

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const guestCookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("atrium.guest="));
const cookieHeaders = (value: string, extra: Record<string, string> = {}) => new Headers({ cookie: `atrium.guest=${value}`, ...extra });

/** Opens a link without a PIN and returns the guest cookie value. */
async function openAsGuest(m: M, token: string, now?: number) {
  const r = await m.guest.openGuestLink(token, new Headers(), { now });
  if (r.kind !== "guest") throw new Error(`expected a guest session, got ${r.kind}`);
  return r.cookie.value;
}

function proxyReq(pathAndQuery: string, headers: Headers, method = "GET") {
  return new NextRequest(new URL(pathAndQuery, PUBLIC_URL), { method, headers });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- Creating links -------------------------------------------------------------------------------

describe("creating guest links (criteria 1 to 7)", () => {
  it("1: with access.guests off the owner is refused with the reason and nothing is stored", async () => {
    const m = await boot();
    m.apps.get("app-lounge")!.access.guests = false;
    const c = await signedIn(m);
    const res = await c.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "Sam" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Guest links are off for this app");
    expect(sql(m, "SELECT id FROM guest_link")).toHaveLength(0);
  });

  it("2: a member who cannot edit and a viewer get 403; a member who can edit succeeds", async () => {
    const m = await boot();
    const anaId = await addUser(m, "ana@atrium.test", "member", "ana-member-password-1");
    await addUser(m, "vic@atrium.test", "viewer", "vic-viewer-password-1");
    const ana = await signedIn(m, "ana@atrium.test", "ana-member-password-1");
    const vic = await signedIn(m, "vic@atrium.test", "vic-viewer-password-1");
    const body = { appId: "app-lounge", label: "Sam" };
    const refused = await ana.post("/api/auth/atrium/guest-links", body);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Only the owner or an editor of this app can create guest links");
    // A viewer is refused even when listed in the edit set (architecture 4.2: viewers can view only).
    m.apps.get("app-lounge")!.access.edit = { userIds: [anaId, ...sql<{ id: string }>(m, "SELECT id FROM user WHERE email = 'vic@atrium.test'").map((r) => r.id)] };
    expect((await vic.post("/api/auth/atrium/guest-links", body)).status).toBe(403);
    const ok = await ana.post("/api/auth/atrium/guest-links", body);
    expect(ok.status).toBe(201);
    expect(sql(m, "SELECT id FROM guest_link")).toHaveLength(1);
  });

  it("3: MCP tokens, OAuth agents and the built-in setup agent are refused; no guest link tool exists", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    m.session.registerAgentTokenResolver(async (b) =>
      b === "atr_pat_unit" ? { tokenId: "tok-1", userId: owner.userId, agentName: "claude", scopes: ["atrium:read", "atrium:edit", "atrium:propose"], via: "pat", createdAt: new Date() } : null,
    );
    const pat = new Client(dispatcher(m), "203.0.113.200");
    pat.extra = { authorization: "Bearer atr_pat_unit" };
    const res = await pat.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "Sam" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Agents cannot create guest links");
    // A bad bearer is 401, and listing or revoking with a token is refused too.
    pat.extra = { authorization: "Bearer atr_pat_wrong" };
    expect((await pat.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "Sam" })).status).toBe(401);
    pat.extra = { authorization: "Bearer atr_pat_unit" };
    expect((await pat.get("/api/auth/atrium/guest-links?appId=app-lounge")).status).toBe(403);
    const { link } = await create(m);
    expect((await pat.post(`/api/auth/atrium/guest-links/${link.id}/revoke`, {})).status).toBe(403);

    const oauthAgent: Principal = { kind: "agent", userId: owner.userId, role: "owner", via: "mcp-oauth", tokenId: "oat-1", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };
    const builtin: Principal = { kind: "builtin-agent", userId: owner.userId, role: "owner", conversationId: "conv-1" };
    for (const p of [oauthAgent, builtin]) {
      await expect(create(m, p)).rejects.toMatchObject({ status: 403, message: "Agents cannot create guest links" });
    }
    expect(sql(m, "SELECT id FROM guest_link")).toHaveLength(1);

    // No tool definition anywhere creates, lists or revokes guest links (the registry is command-palette's,
    // Wave 2; every subsystem's tools live in src/features/<slug>/tools.ts).
    const features = path.join(APP_ROOT, "src/features");
    const toolFiles = readdirSync(features)
      .map((d) => path.join(features, d, "tools.ts"))
      .filter((f) => existsSync(f));
    // Round 6: judge the code, not its comments (app-builder's tools.ts says in a comment that no tool
    // touches guest links). No tool may be named for guests or call auth's guest link functions.
    const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const f of toolFiles) {
      expect(code(f), f).not.toMatch(/name:\s*["'`][^"'`]*guest/i);
      expect(code(f), f).not.toMatch(/createGuestLink|revokeGuestLink|listGuestLinks|revokeAppGuestLinks|revokeCreatorGuestLinks|guest-links/);
    }
    expect(existsSync(path.join(features, "auth/tools.ts"))).toBe(false);
    const manifest = path.join(features, "registry/manifest.ts");
    if (existsSync(manifest)) expect(readFileSync(manifest, "utf8")).not.toMatch(/guest/i);
  });

  it("4: missing label, PIN of 3 or 9 digits, non-digit PIN, past expiry and 91 days are refused naming the field", async () => {
    const m = await boot();
    const c = await signedIn(m);
    const cases: [Record<string, unknown>, string][] = [
      [{ label: "" }, "label"],
      [{ label: "   " }, "label"],
      [{ pin: "123" }, "pin"],
      [{ pin: "123456789" }, "pin"],
      [{ pin: "12a4" }, "pin"],
      [{ expiresAt: new Date(Date.now() - MIN).toISOString() }, "expiresAt"],
      [{ expiresAt: new Date(Date.now() + 91 * DAY).toISOString() }, "expiresAt"],
    ];
    for (const [extra, field] of cases) {
      const res = await c.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "Sam", ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      const body = (await res.json()) as { error: { field: string; message: string } };
      expect(body.error.field).toBe(field);
      expect(body.error.message.length).toBeGreaterThan(5);
    }
    expect(sql(m, "SELECT id FROM guest_link")).toHaveLength(0);
  });

  it("5: no expiry means 7 days after creation; exactly 90 days is accepted", async () => {
    const m = await boot();
    const before = Date.now();
    const { link } = await create(m);
    const exp = new Date(link.expiresAt).getTime();
    expect(exp - before).toBeGreaterThanOrEqual(7 * DAY);
    expect(exp - before).toBeLessThan(7 * DAY + 5000);
    const at90 = new Date(Date.now() + 90 * DAY).toISOString();
    const { link: l90 } = await create(m, ownerPrincipal(m), { expiresAt: at90 });
    expect(l90.expiresAt).toBe(at90);
  });

  it("6 and 7: the link is <public URL>/g/atr_g_ + 43 base64url chars; only hashes are stored; it appears in one response only", async () => {
    const m = await boot();
    const c = await signedIn(m);
    const res = await c.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "Sam", pin: "4821" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { url: string; link: { id: string } };
    expect(created.url).toMatch(new RegExp(`^${PUBLIC_URL.replace(/[.]/g, "\\.")}/g/atr_g_[A-Za-z0-9_-]{43}$`));
    const token = tokenOf(created.url);
    const [row] = sql<Record<string, unknown>>(m, "SELECT * FROM guest_link");
    expect(row!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(String(row!.pin_hash)).toMatch(/^\$argon2id\$/);
    const stored = JSON.stringify(sql(m, "SELECT * FROM guest_link"));
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('"4821"');

    const list = await c.get("/api/auth/atrium/guest-links?appId=app-lounge");
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(String(row!.token_hash));
    expect(text).not.toContain(String(row!.pin_hash));
    expect(text).not.toContain("4821");
    expect(text).not.toMatch(/"(token|tokenHash|pinHash|pin|url)"/);
    const revoked = await c.post(`/api/auth/atrium/guest-links/${created.link.id}/revoke`, {});
    expect(await revoked.text()).not.toContain(token);
  });
});

// ---- Opening links --------------------------------------------------------------------------------

describe("opening guest links (criteria 9 to 16)", () => {
  it("9: a valid link without a PIN sets atrium.guest (httpOnly, Lax, path /) and redirects to /a/<slug>", async () => {
    const m = await boot();
    const { url } = await create(m);
    const c = new Client(dispatcher(m), "203.0.113.90");
    const res = await c.get(new URL(url).pathname);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/a/lounge");
    const cookie = guestCookieOf(res)!;
    expect(cookie).toMatch(/^atrium\.guest=atr_gs_[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).not.toMatch(/Secure/);
  });

  it("9: the guest cookie is Secure when the public URL is https", async () => {
    const m = await boot({ ATRIUM_PUBLIC_URL: "https://atrium.example" });
    const { url } = await create(m);
    expect(url).toMatch(/^https:\/\/atrium\.example\/g\/atr_g_/);
    const res = await m.gRoute.GET(new Request(url), { params: Promise.resolve({ token: tokenOf(url) }) });
    expect(guestCookieOf(res)).toMatch(/; Secure/);
  });

  it("10: unknown, expired, revoked, guests-off and deleted-app links give identical responses with no cookie, and the screen reads the one sentence", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    m.apps.set("app-attic", makeApp("attic"));
    m.apps.set("app-shed", makeApp("shed"));
    const expired = await m.guest.createGuestLink(owner, { appId: "app-lounge", label: "old" }, { now: Date.now() - 8 * DAY });
    const revoked = await create(m);
    await m.guest.revokeGuestLink(owner, revoked.link.id);
    const off = await m.guest.createGuestLink(owner, { appId: "app-attic", label: "off" });
    m.apps.get("app-attic")!.access.guests = false;
    const gone = await m.guest.createGuestLink(owner, { appId: "app-shed", label: "gone" });
    m.apps.delete("app-shed");
    const tokens = [`atr_g_${"A".repeat(43)}`, tokenOf(expired.url), tokenOf(revoked.url), tokenOf(off.url), tokenOf(gone.url)];
    const seen: string[] = [];
    for (const t of tokens) {
      const res = await m.gRoute.GET(new Request(`${PUBLIC_URL}/g/${t}`), { params: Promise.resolve({ token: t }) });
      expect(res.status).toBe(303);
      expect(res.headers.getSetCookie()).toEqual([]);
      seen.push(JSON.stringify({ status: res.status, location: res.headers.get("location"), cache: res.headers.get("cache-control"), body: await res.text() }));
    }
    expect(new Set(seen).size).toBe(1);
    expect(JSON.parse(seen[0]!)).toMatchObject({ location: "/g/expired", body: "" });
    // The PIN step re-checks too: a POST for each dead link gets the same reply.
    const posts = new Set<string>();
    for (const t of tokens) {
      const res = await m.gRoute.POST(new Request(`${PUBLIC_URL}/g/${t}`, { method: "POST", body: JSON.stringify({ pin: "1234" }) }), { params: Promise.resolve({ token: t }) });
      posts.add(`${res.status} ${await res.text()} ${res.headers.getSetCookie().length}`);
    }
    expect([...posts]).toEqual(['404 {"state":"expired"} 0']);
    // The screen: the sentence, no input, no link, no button.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { GuestExpiredScreen } = await import("./ui/guest-screens");
    const html = renderToStaticMarkup(createElement(GuestExpiredScreen));
    expect(html).toContain("This link has expired or was turned off");
    expect(html).not.toMatch(/<(input|a|button|form)\b/);
  });

  it("11 and 13: with a PIN no cookie is set until the right PIN; each wrong PIN writes one guest.pin_failed with link id and IP", async () => {
    const m = await boot();
    const { url, link } = await create(m, ownerPrincipal(m), { pin: "4821" });
    const token = tokenOf(url);
    const c = new Client(dispatcher(m), "203.0.113.91");
    const first = await c.get(`/g/${token}`);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(`/g/${token}/pin`);
    expect(first.headers.getSetCookie()).toEqual([]);
    const wrong = await c.post(`/g/${token}`, { pin: "0000" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ state: "wrong_pin", triesLeft: 4 });
    expect(guestCookieOf(wrong)).toBeUndefined();
    await c.post(`/g/${token}`, { pin: "1111" });
    const fails = sql<{ actor_guest_link_id: string; actor_ip: string; actor_user_id: string | null; actor_kind: string }>(m, "SELECT * FROM audit_log WHERE event = 'guest.pin_failed'");
    expect(fails).toHaveLength(2);
    for (const f of fails) expect(f).toMatchObject({ actor_guest_link_id: link.id, actor_ip: "203.0.113.91", actor_user_id: null, actor_kind: "guest" });
    const right = await c.post(`/g/${token}`, { pin: "4821" });
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({ state: "redirect", to: "/a/lounge" });
    expect(guestCookieOf(right)).toMatch(/^atrium\.guest=atr_gs_/);
  });

  it("12: the 6th try within 15 minutes is refused unchecked, even correct and from a second device; after 15 minutes the PIN works", async () => {
    const m = await boot();
    const { url } = await create(m, ownerPrincipal(m), { pin: "4821" });
    const token = tokenOf(url);
    const a = new Client(dispatcher(m), "203.0.113.92");
    const b = new Client(dispatcher(m), "198.51.100.7");
    for (let i = 0; i < 4; i++) expect((await a.post(`/g/${token}`, { pin: "0000" })).status).toBe(401);
    const fifth = await b.post(`/g/${token}`, { pin: "9999" });
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toEqual({ state: "locked", minutes: 15 });
    const hash = await import("./server/password-hash");
    const verify = vi.spyOn(hash, "verifyPassword");
    const sixth = await b.post(`/g/${token}`, { pin: "4821" });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBe("900");
    expect(guestCookieOf(sixth)).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    expect(sql(m, "SELECT id FROM audit_log WHERE event = 'guest.pin_failed'")).toHaveLength(5);
    // The list shows it locked; the PIN page would show the lock too.
    expect((await m.guest.listGuestLinks(ownerPrincipal(m), "app-lounge")).links[0]!.status).toBe("locked");
    expect(await m.guest.inspectGuestLink(token, new Headers())).toEqual({ kind: "pin", minutesLocked: 15 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 15 * MIN + 1000);
    const later = await a.post(`/g/${token}`, { pin: "4821" });
    expect(later.status).toBe(200);
    // The spy does see real checks, so "not called" above means the locked try was never checked.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(guestCookieOf(later)).toBeTruthy();
  });

  it("12: parallel tries from many devices cannot slip past the lock", async () => {
    const m = await boot();
    const { url } = await create(m, ownerPrincipal(m), { pin: "4821" });
    const token = tokenOf(url);
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => m.guest.submitGuestPin(token, "0000", new Headers(), { ip: `198.51.100.${i + 1}` })));
    expect(replies.filter((r) => r.kind === "wrong_pin")).toHaveLength(4);
    expect(replies.filter((r) => r.kind === "locked")).toHaveLength(8);
    expect(sql(m, "SELECT id FROM audit_log WHERE event = 'guest.pin_failed'")).toHaveLength(5);
  });

  it("14: 7 days idle ends a session; day 6 use keeps it on day 12 of a 30-day link; a link expiring in 2 days ends it then", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    const t0 = Date.now();
    const long = await m.guest.createGuestLink(owner, { appId: "app-lounge", label: "30 days", expiresAt: new Date(t0 + 30 * DAY).toISOString() }, { now: t0 });
    const idle = await openAsGuest(m, tokenOf(long.url), t0);
    expect(await m.guest.guestFromHeaders(cookieHeaders(idle), t0 + 7 * DAY - MIN)).not.toBeNull();
    const idle2 = await openAsGuest(m, tokenOf(long.url), t0);
    expect(await m.guest.guestFromHeaders(cookieHeaders(idle2), t0 + 7 * DAY + MIN)).toBeNull();

    const used = await openAsGuest(m, tokenOf(long.url), t0);
    expect(await m.guest.guestFromHeaders(cookieHeaders(used), t0 + 6 * DAY)).not.toBeNull();
    expect(await m.guest.guestFromHeaders(cookieHeaders(used), t0 + 12 * DAY)).not.toBeNull();

    const short = await m.guest.createGuestLink(owner, { appId: "app-lounge", label: "2 days", expiresAt: new Date(t0 + 2 * DAY).toISOString() }, { now: t0 });
    const s = await openAsGuest(m, tokenOf(short.url), t0 + 2 * DAY - 60 * MIN);
    expect(await m.guest.guestFromHeaders(cookieHeaders(s), t0 + 2 * DAY - MIN)).not.toBeNull();
    expect(await m.guest.guestFromHeaders(cookieHeaders(s), t0 + 2 * DAY)).toBeNull();
  });

  it("15: with a session cookie and a guest cookie on one request, requireViewer() returns the session user", async () => {
    const m = await boot();
    const { url } = await create(m);
    const guestValue = await openAsGuest(m, tokenOf(url));
    const c = await signedIn(m);
    const h = new Headers({ cookie: `${c.cookieHeader()}; atrium.guest=${guestValue}` });
    expect(await m.guest.requireViewerFrom(h)).toMatchObject({ kind: "user", role: "owner", via: "session" });
    expect(await m.guest.requireViewerFrom(cookieHeaders(guestValue))).toMatchObject({ kind: "guest", appId: "app-lounge", label: "Guest room, Sam" });
  });

  it("16: a signed-in user opening a valid link is sent on as themself: no guest cookie, no guest.opened", async () => {
    const m = await boot();
    const { url } = await create(m, ownerPrincipal(m));
    const pinned = await create(m, ownerPrincipal(m), { pin: "4821" });
    const c = await signedIn(m);
    for (const u of [url, pinned.url]) {
      const res = await c.get(new URL(u).pathname);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/a/lounge");
      expect(guestCookieOf(res)).toBeUndefined();
    }
    expect(sql(m, "SELECT id FROM audit_log WHERE event = 'guest.opened'")).toHaveLength(0);
    expect(sql(m, "SELECT id FROM guest_session")).toHaveLength(0);
    // A dead link still shows the plain screen to a signed-in user.
    const dead = await c.get(`/g/atr_g_${"B".repeat(43)}`);
    expect(dead.headers.get("location")).toBe("/g/expired");
  });
});

// ---- The front gate and requireViewer --------------------------------------------------------------

describe("what a guest may reach (criteria 17 to 20, 26)", () => {
  const PAGES = ["/", "/build/lounge", "/settings", "/library", "/audit", "/integrations", "/approvals", "/settings/users", "/consent"];
  const APIS = ["/api/integrations", "/api/agent-tokens", "/api/palette", "/api/settings", "/api/apps", "/api/library", "/api/actions", "/api/agent"];

  it("17: with only a guest cookie every page outside the guest list goes to sign-in and every API gets 401; /mcp too", async () => {
    const m = await boot();
    const { url } = await create(m);
    const h = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    for (const p of PAGES) {
      const res = await m.proxy(proxyReq(p, h));
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, p).toBe("/sign-in");
    }
    for (const p of [...APIS, "/mcp"]) expect((await m.proxy(proxyReq(p, h))).status, p).toBe(401);
    // Auth's own APIs refuse a guest as signed out.
    const c = new Client(dispatcher(m));
    c.jar.set("atrium.guest", h.get("cookie")!.split("=")[1]!);
    expect((await c.get("/api/auth/atrium/guest-links?appId=app-lounge")).status).toBe(401);
    expect((await c.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "x" })).status).toBe(401);
    expect(await m.session.sessionFromHeaders(h)).toBeNull();
    expect(await m.session.principalFromHeaders(h)).toBeNull();
    await expect(m.session.requireUserFrom(h)).rejects.toMatchObject({ status: 401 });
    await expect(m.session.requireScopeFrom(h, "atrium:read")).rejects.toMatchObject({ status: 401 });
  });

  it("18: another app's guest routes are refused as signed out; its own pages and guest APIs pass", async () => {
    const m = await boot();
    const { url } = await create(m);
    const h = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
    for (const p of ["/a/lounge", "/a/lounge/kitchen", "/a/lounge/manifest.webmanifest", "/a/lounge/sw.js", "/api/data/stream?app=app-lounge", "/api/data/widget/k1", "/uploads/a.png", "/api/img?u=x&s=y"]) {
      expect(passes(await m.proxy(proxyReq(p, h))), p).toBe(true);
    }
    expect(passes(await m.proxy(proxyReq("/api/controls/run", new Headers({ cookie: h.get("cookie")!, origin: PUBLIC_URL, "content-type": "application/json" }), "POST")))).toBe(true);
    for (const p of ["/a/garage", "/a/garage/kitchen", "/a/garage?draft=1"]) {
      const res = await m.proxy(proxyReq(p, h));
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
    }
    // Wave 2 lead (app-builder criterion 17): its own draft preview serves the published page instead.
    for (const [p, to] of [["/a/lounge?draft=1", "/a/lounge"], ["/a/lounge/kitchen?draft=1&x=2", "/a/lounge/kitchen?x=2"]] as const) {
      const res = await m.proxy(proxyReq(p, h));
      expect(res.status, p).toBe(200);
      expect(res.headers.get("location"), p).toBeNull();
      const target = new URL(res.headers.get("x-middleware-rewrite")!);
      expect(`${target.pathname}${target.search}`, p).toBe(to);
    }
    await expect(m.guest.requireViewerFrom(h, { appId: "app-garage" })).rejects.toMatchObject({ status: 401 });
    expect(await m.guest.requireViewerFrom(h, { appId: "app-lounge" })).toMatchObject({ kind: "guest", guestLinkId: expect.any(String) });
  });

  it("19: without any cookie /g/* and /sandbox/* pass the gate; every other non-exempt route still redirects or 401s", async () => {
    const m = await boot();
    const h = new Headers();
    for (const p of [`/g/atr_g_${"C".repeat(43)}`, "/g/expired", "/g/x/pin", "/sandbox/frame", "/sandbox/lib/chart.js"]) {
      expect((await m.proxy(proxyReq(p, h))).headers.get("x-middleware-next"), p).toBe("1");
    }
    for (const p of ["/a/lounge", "/g", ...PAGES]) expect((await m.proxy(proxyReq(p, h))).status, p).toBe(307);
    for (const p of ["/api/data/stream", "/api/controls/run", "/api/img", ...APIS]) expect((await m.proxy(proxyReq(p, h))).status, p).toBe(401);
  });

  it("wave 2 lead: route-owned security headers survive the proxy (components SFR-1, settings SFR 2)", async () => {
    const m = await boot({ ATRIUM_LAN_ORIGINS: "http://192.168.1.20:3102, not a url" });
    const frame = await m.proxy(proxyReq("/sandbox/frame", new Headers()));
    expect(frame.headers.get("x-middleware-next")).toBe("1");
    // The frame route's own CSP, frame-ancestors and DNS prefetch header stand: the proxy adds only nosniff.
    expect(frame.headers.get("content-security-policy")).toBeNull();
    expect(frame.headers.get("x-frame-options")).toBeNull();
    expect(frame.headers.get("x-content-type-options")).toBe("nosniff");
    // Every other page: frame-src names only the frame path, on the public URL and each LAN origin.
    const csp = (await m.proxy(proxyReq("/sign-in", new Headers()))).headers.get("content-security-policy")!;
    const frameSrc = csp.split("; ").find((d) => d.startsWith("frame-src "));
    expect(frameSrc).toBe(`frame-src ${new URL(PUBLIC_URL).origin}/sandbox/frame http://192.168.1.20:3102/sandbox/frame`);
    expect(csp).toContain("frame-ancestors 'none'");
    // Uploads and the image proxy keep the sandbox CSP (signed in, and as the app's guest).
    const { url } = await create(m);
    const guest = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    const c = await signedIn(m);
    const session = new Headers({ cookie: c.cookieHeader() });
    for (const h of [session, guest]) {
      for (const p of ["/uploads/a.png", "/api/img?u=x&s=y"]) {
        const res = await m.proxy(proxyReq(p, h));
        expect(res.headers.get("x-middleware-next"), p).toBe("1");
        expect(res.headers.get("content-security-policy"), p).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
        expect(res.headers.get("x-content-type-options"), p).toBe("nosniff");
      }
    }
    // A signed-in page still gets the full page CSP.
    expect((await m.proxy(proxyReq("/settings", session))).headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-");
  });

  it("20: with the gate bypassed, requireViewer() and auth's guest handlers refuse a request with no valid session or guest session", async () => {
    const m = await boot();
    const { url, link } = await create(m);
    const value = await openAsGuest(m, tokenOf(url));
    const none = new Headers();
    await expect(m.guest.requireViewerFrom(none)).rejects.toMatchObject({ status: 401 });
    await expect(m.guest.requireViewerFrom(cookieHeaders(`atr_gs_${"Z".repeat(43)}`))).rejects.toMatchObject({ status: 401 });
    await expect(m.guest.requireViewerFrom(cookieHeaders("not-a-cookie"))).rejects.toMatchObject({ status: 401 });
    // A bearer token never becomes a viewer.
    await expect(m.guest.requireViewerFrom(new Headers({ authorization: "Bearer atr_pat_x" }))).rejects.toMatchObject({ status: 401 });
    const c = new Client(dispatcher(m));
    expect((await c.get("/api/auth/atrium/guest-links?appId=app-lounge")).status).toBe(401);
    expect((await c.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "x" })).status).toBe(401);
    expect((await c.post(`/api/auth/atrium/guest-links/${link.id}/revoke`, {})).status).toBe(401);
    expect(await m.guest.requireViewerFrom(cookieHeaders(value))).toMatchObject({ kind: "guest" });
  });

  it("26: the 121st guest page or stream request in a minute gets 429 with Retry-After", async () => {
    const m = await boot();
    const { url } = await create(m);
    const h = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    for (let i = 0; i < 120; i++) {
      const res = await m.proxy(proxyReq(i % 2 ? "/a/lounge" : "/api/data/stream", h));
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    const page = await m.proxy(proxyReq("/a/lounge", h));
    expect(page.status).toBe(429);
    expect(Number(page.headers.get("retry-after"))).toBeGreaterThan(0);
    const stream = await m.proxy(proxyReq("/api/data/stream", h));
    expect(stream.status).toBe(429);
    expect(((await stream.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    // Another guest session has its own budget.
    const other = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    expect((await m.proxy(proxyReq("/a/lounge", other))).headers.get("x-middleware-next")).toBe("1");
  });

  it("A1.3: opening /g/<token> is limited to 30 requests per minute per IP", async () => {
    const m = await boot();
    const c = new Client(dispatcher(m), "203.0.113.150");
    for (let i = 0; i < 30; i++) expect((await m.proxy(proxyReq(`/g/atr_g_${"D".repeat(43)}`, c.headers()))).status).not.toBe(429);
    const limited = await m.proxy(proxyReq(`/g/atr_g_${"D".repeat(43)}`, c.headers()));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    const other = new Client(dispatcher(m), "203.0.113.151");
    expect((await m.proxy(proxyReq(`/g/atr_g_${"D".repeat(43)}`, other.headers()))).status).not.toBe(429);
  });

  it("A1.3: an ended guest session on /a/<slug> goes to the viewer (which shows the expired link screen with 404), not sign-in", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    const { url, link } = await create(m);
    const h = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    await m.guest.revokeGuestLink(owner, link.id);
    // The viewer itself answers it (404 with the expired screen, app-builder final r4 SFR); the proxy lets
    // the page request through instead of rewriting it to /g/expired with a 200.
    const res = await m.proxy(proxyReq("/a/lounge", h));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect((await m.proxy(proxyReq("/api/data/stream", h))).status).toBe(401);
    expect((await m.proxy(proxyReq("/settings", h))).status).toBe(307);
  });
});

// ---- Revocation ------------------------------------------------------------------------------------

describe("revocation and side effects (criteria 21 to 23)", () => {
  it("21: revoking a link fails the next request of every session on it and writes one guest_link.revoked (manual)", async () => {
    const m = await boot();
    const c = await signedIn(m);
    const { url, link } = await create(m);
    const s1 = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    const s2 = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    expect(await m.guest.guestFromHeaders(s1)).not.toBeNull();
    const res = await c.post(`/api/auth/atrium/guest-links/${link.id}/revoke`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { link: { status: string } }).link.status).toBe("revoked");
    expect(await m.guest.guestFromHeaders(s1)).toBeNull();
    expect(await m.guest.guestFromHeaders(s2)).toBeNull();
    const rows = sql<{ detail: string; actor_user_id: string }>(m, "SELECT * FROM audit_log WHERE event = 'guest_link.revoked'");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ cause: "manual", by: "person" });
    expect(rows[0]!.actor_user_id).toBe(ownerPrincipal(m).userId);
    // Revoking again changes nothing and writes nothing.
    await m.guest.revokeGuestLink(ownerPrincipal(m), link.id);
    expect(sql(m, "SELECT id FROM audit_log WHERE event = 'guest_link.revoked'")).toHaveLength(1);
  });

  it("A1.1: the creator, an editor and the owner may revoke; a member who cannot edit and a viewer may not", async () => {
    const m = await boot();
    const anaId = await addUser(m, "ana@atrium.test", "member", "ana-member-password-1");
    const boId = await addUser(m, "bo@atrium.test", "member", "bo-member-password-12");
    const vicId = await addUser(m, "vic@atrium.test", "viewer", "vic-viewer-password-1");
    m.apps.get("app-lounge")!.access.edit = { userIds: [anaId] };
    const ana: Principal = { kind: "user", userId: anaId, role: "member", via: "session" };
    const bo: Principal = { kind: "user", userId: boId, role: "member", via: "session" };
    const vic: Principal = { kind: "user", userId: vicId, role: "viewer", via: "session" };
    const byAna = await create(m, ana);
    await expect(m.guest.revokeGuestLink(bo, byAna.link.id)).rejects.toMatchObject({ status: 403 });
    await expect(m.guest.revokeGuestLink(vic, byAna.link.id)).rejects.toMatchObject({ status: 403 });
    expect((await m.guest.revokeGuestLink(ana, byAna.link.id)).status).toBe("revoked");
    m.apps.get("app-lounge")!.access.edit = { userIds: [anaId, boId] };
    const byAna2 = await create(m, ana);
    expect((await m.guest.revokeGuestLink(bo, byAna2.link.id)).status).toBe("revoked");
    const byOwner = await create(m);
    expect((await m.guest.revokeGuestLink(ownerPrincipal(m), byOwner.link.id)).status).toBe("revoked");
  });

  it("22: turning access.guests off or deleting the app fails the next guest request; turning guests back on revives nothing", async () => {
    const m = await boot();
    const lounge = await create(m);
    const garage = await create(m, ownerPrincipal(m), { appId: "app-garage" });
    const a = cookieHeaders(await openAsGuest(m, tokenOf(lounge.url)));
    const b = cookieHeaders(await openAsGuest(m, tokenOf(garage.url)));
    m.apps.get("app-lounge")!.access.guests = false;
    expect(await m.guest.guestFromHeaders(a)).toBeNull();
    m.apps.get("app-lounge")!.access.guests = true;
    expect(await m.guest.guestFromHeaders(a)).toBeNull();
    expect((await m.guest.openGuestLink(tokenOf(lounge.url), new Headers())).kind).toBe("expired");
    m.apps.delete("app-garage");
    expect(await m.guest.guestFromHeaders(b)).toBeNull();
    const causes = sql<{ detail: string }>(m, "SELECT detail FROM audit_log WHERE event = 'guest_link.revoked'").map((r) => JSON.parse(r.detail).cause);
    expect(causes.sort()).toEqual(["app_deleted", "guests_off"]);
    // app-builder's explicit calls do the same, idempotently.
    expect(m.guest.revokeAppGuestLinks("app-lounge", "guests_off", ownerPrincipal(m))).toBe(0);
  });

  it("23: demoting a creator to viewer, or removing them, revokes every link they made on every app, naming the cause; the owner sees them first", async () => {
    const m = await boot();
    const anaId = await addUser(m, "ana@atrium.test", "member", "ana-member-password-1");
    const boId = await addUser(m, "bo@atrium.test", "member", "bo-member-password-12");
    for (const id of ["app-lounge", "app-garage"]) m.apps.get(id)!.access.edit = { userIds: [anaId, boId] };
    const ana: Principal = { kind: "user", userId: anaId, role: "member", via: "session" };
    const bo: Principal = { kind: "user", userId: boId, role: "member", via: "session" };
    const ownerLink = await create(m);
    const a1 = await create(m, ana);
    const a2 = await create(m, ana, { appId: "app-garage" });
    const b1 = await create(m, bo);
    const sA = cookieHeaders(await openAsGuest(m, tokenOf(a2.url)));
    m.users.setUserRole(anaId, "viewer", ownerPrincipal(m));
    expect(await m.guest.guestFromHeaders(sA)).toBeNull();
    m.users.removeUser(boId, ownerPrincipal(m));
    const rows = sql<{ target_id: string; detail: string; actor_user_id: string }>(m, "SELECT * FROM audit_log WHERE event = 'guest_link.revoked'");
    const byLink = Object.fromEntries(rows.map((r) => [r.target_id, JSON.parse(r.detail).cause]));
    expect(byLink).toEqual({ [a1.link.id]: "creator_demoted", [a2.link.id]: "creator_demoted", [b1.link.id]: "creator_removed" });
    for (const r of rows) expect(r.actor_user_id).toBe(ownerPrincipal(m).userId);
    const list = await m.guest.listGuestLinks(ownerPrincipal(m), "app-lounge");
    expect(list.links.map((l) => l.id).slice(0, 2).sort()).toEqual([a1.link.id, b1.link.id].sort());
    expect(list.links[2]!.id).toBe(ownerLink.link.id);
    expect(list.links.find((l) => l.id === b1.link.id)!.createdBy.name).toBe("bo@atrium.test");
  });

  it("A1.1: a member who loses edit access to an app loses their links on that app", async () => {
    const m = await boot();
    const anaId = await addUser(m, "ana@atrium.test", "member", "ana-member-password-1");
    for (const id of ["app-lounge", "app-garage"]) m.apps.get(id)!.access.edit = { userIds: [anaId] };
    const ana: Principal = { kind: "user", userId: anaId, role: "member", via: "session" };
    const l = await create(m, ana);
    const g = await create(m, ana, { appId: "app-garage" });
    const s = cookieHeaders(await openAsGuest(m, tokenOf(l.url)));
    m.apps.get("app-lounge")!.access.edit = "owner";
    expect(await m.guest.guestFromHeaders(s)).toBeNull();
    const rows = sql<{ target_id: string; detail: string }>(m, "SELECT * FROM audit_log WHERE event = 'guest_link.revoked'");
    expect(rows.map((r) => [r.target_id, JSON.parse(r.detail).cause])).toEqual([[l.link.id, "creator_lost_edit"]]);
    expect((await m.guest.openGuestLink(tokenOf(g.url), new Headers())).kind).toBe("guest");
    // app-builder's explicit call for one app.
    expect(m.guest.revokeCreatorGuestLinks(anaId, "creator_lost_edit", ownerPrincipal(m), "app-garage")).toBe(1);
  });
});

// ---- Audit and secrets ------------------------------------------------------------------------------

describe("audit and secrets (criteria 24, 25, 27)", () => {
  it("24: each new guest session writes one guest.opened (link id, label, no user id); each create one guest_link.created", async () => {
    const m = await boot();
    const { url, link } = await create(m, ownerPrincipal(m), { pin: "4821", expiresAt: new Date(Date.now() + 3 * DAY).toISOString() });
    const plain = await create(m);
    const created = sql<{ detail: string; actor_user_id: string; target_id: string }>(m, "SELECT * FROM audit_log WHERE event = 'guest_link.created' ORDER BY at");
    expect(created).toHaveLength(2);
    expect(JSON.parse(created[0]!.detail)).toEqual({ appId: "app-lounge", label: "Guest room, Sam", expiresAt: link.expiresAt, requiresCode: true });
    expect(JSON.parse(created[1]!.detail)).toMatchObject({ requiresCode: false });
    expect(created[0]!.actor_user_id).toBe(ownerPrincipal(m).userId);
    await m.guest.submitGuestPin(tokenOf(url), "4821", new Headers(), { ip: "203.0.113.99" });
    await openAsGuest(m, tokenOf(plain.url));
    await openAsGuest(m, tokenOf(plain.url));
    const opened = sql<{ actor_kind: string; actor_user_id: string | null; actor_guest_link_id: string; actor_guest_label: string; actor_ip: string | null; detail: string }>(
      m,
      "SELECT * FROM audit_log WHERE event = 'guest.opened' ORDER BY at",
    );
    expect(opened).toHaveLength(3);
    expect(opened[0]).toMatchObject({ actor_kind: "guest", actor_user_id: null, actor_guest_link_id: link.id, actor_guest_label: "Guest room, Sam", actor_ip: "203.0.113.99" });
    expect(JSON.parse(opened[0]!.detail)).toEqual({ label: "Guest room, Sam" });
    // Requests on an existing session write nothing more.
    expect(sql(m, "SELECT id FROM audit_log WHERE event = 'guest.opened'")).toHaveLength(3);
  });

  it("25 (auth half): a control run audited under the guest principal records actor kind guest, link id and label, no user id", async () => {
    const m = await boot();
    const { url } = await create(m);
    const viewer = await m.guest.requireViewerFrom(cookieHeaders(await openAsGuest(m, tokenOf(url))), { appId: "app-lounge" });
    const entry = m.audit.audit.write({ actor: viewer, event: "control.run", target: { type: "app", id: "app-lounge" }, result: "ok", detail: { controlId: "k_lamp" }, ip: "203.0.113.5" });
    expect(entry.actor).toEqual({ kind: "guest", guestLinkId: (viewer as { guestLinkId: string }).guestLinkId, guestLabel: "Guest room, Sam", ip: "203.0.113.5" });
    const [row] = sql<Record<string, unknown>>(m, "SELECT * FROM audit_log WHERE event = 'control.run'");
    expect(row).toMatchObject({ actor_kind: "guest", actor_user_id: null, actor_guest_label: "Guest room, Sam" });
  });

  it("27: logs and audit entries from create, open, PIN failure and revoke hold no token, PIN, hash or cookie value", async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    const m = await boot();
    const c = await signedIn(m);
    const res = await c.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "Sam", pin: "73195" });
    const { url, link } = (await res.json()) as { url: string; link: { id: string } };
    const token = tokenOf(url);
    const g = new Client(dispatcher(m), "203.0.113.77");
    await g.get(`/g/${token}`);
    await g.post(`/g/${token}`, { pin: "11111" });
    const ok = await g.post(`/g/${token}`, { pin: "73195" });
    const cookie = guestCookieOf(ok)!.split(";")[0]!.split("=")[1]!;
    await m.proxy(proxyReq("/a/lounge", cookieHeaders(cookie)));
    await c.post(`/api/auth/atrium/guest-links/${link.id}/revoke`, {});
    const [row] = sql<{ token_hash: string; pin_hash: string }>(m, "SELECT token_hash, pin_hash FROM guest_link");
    const secrets = [token, token.slice(6), "73195", "11111", row!.token_hash, row!.pin_hash, cookie, createHash("sha256").update(cookie).digest("hex")];
    const auditText = JSON.stringify(sql(m, "SELECT * FROM audit_log"));
    const logText = lines.join("\n");
    expect(logText).toContain("Guest link created");
    expect(auditText).toContain("guest.pin_failed");
    for (const s of secrets) {
      expect(logText.includes(s), `log holds ${s.slice(0, 8)}`).toBe(false);
      expect(auditText.includes(s), `audit holds ${s.slice(0, 8)}`).toBe(false);
    }
  });
});

// ---- Before the hook is registered (Wave 1) ---------------------------------------------------------

describe("28: with no app access hook registered", () => {
  it("create says not available, /g/<token> shows the plain screen with no cookie, a guest cookie is signed out", async () => {
    const m = await boot();
    const { url } = await create(m);
    const h = cookieHeaders(await openAsGuest(m, tokenOf(url)));
    m.hooks.resetAppAccess();
    const c = await signedIn(m);
    const res = await c.post("/api/auth/atrium/guest-links", { appId: "app-lounge", label: "Sam" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Guest links are not available yet");
    expect((await c.get("/api/auth/atrium/guest-links?appId=app-lounge")).status).toBe(403);
    const open = await m.gRoute.GET(new Request(url), { params: Promise.resolve({ token: tokenOf(url) }) });
    expect(open.headers.get("location")).toBe("/g/expired");
    expect(open.headers.getSetCookie()).toEqual([]);
    await expect(m.guest.requireViewerFrom(h)).rejects.toMatchObject({ status: 401 });
    expect((await m.proxy(proxyReq("/api/data/stream", h))).status).toBe(401);
    expect((await m.proxy(proxyReq("/", h))).status).toBe(307);
    // Session users are unaffected, and no link was revoked by the missing hook.
    expect(await m.guest.requireViewerFrom(c.headers())).toMatchObject({ kind: "user" });
    expect(sql(m, "SELECT id FROM guest_link WHERE revoked_at IS NOT NULL")).toHaveLength(0);
  });
});

// ---- Pure rules ----------------------------------------------------------------------------------------

describe("guest policy (pure)", () => {
  it("checks create input and computes session expiry and PIN lock", async () => {
    const p = await import("./guest/policy");
    const now = Date.UTC(2026, 9, 18);
    expect(p.checkCreateInput({ label: "x" }, now)).toMatchObject({ ok: true, value: { expiresAt: new Date(now + 7 * DAY), pin: null } });
    expect(p.checkCreateInput({ label: "x", pin: "" }, now)).toMatchObject({ ok: true, value: { pin: null } });
    expect(p.checkCreateInput({ label: "x", pin: 1234 }, now)).toMatchObject({ ok: false, problem: { field: "pin" } });
    expect(p.checkCreateInput({ label: "x", expiresAt: "soon" }, now)).toMatchObject({ ok: false, problem: { field: "expiresAt" } });
    expect(p.checkCreateInput({ label: "x".repeat(81) }, now)).toMatchObject({ ok: false, problem: { field: "label" } });
    expect(p.guestSessionExpiry(now, now + 30 * DAY)).toBe(now + 7 * DAY);
    expect(p.guestSessionExpiry(now, now + DAY)).toBe(now + DAY);
    let s = { failCount: 0, windowStart: null as number | null, lockedUntil: null as number | null };
    for (let i = 1; i <= 4; i++) {
      const n = p.afterWrongPin(s, now + i);
      expect(n.triesLeft).toBe(5 - i);
      s = n;
    }
    const locked = p.afterWrongPin(s, now + 5);
    expect(locked).toMatchObject({ locked: true, lockedUntil: now + 5 + 15 * MIN });
    expect(p.pinLockMinutes(locked, now + 5)).toBe(15);
    expect(p.pinLockMinutes(locked, now + 5 + 15 * MIN)).toBe(0);
    // Wrong PINs further apart than 15 minutes start a new window.
    expect(p.afterWrongPin({ failCount: 4, windowStart: now, lockedUntil: null }, now + 15 * MIN)).toMatchObject({ locked: false, triesLeft: 4 });
    expect(p.guestRouteOf("/a/lounge/x")).toEqual({ kind: "page", slug: "lounge" });
    expect(p.guestRouteOf("/api/data/stream")).toEqual({ kind: "stream" });
    expect(p.guestRouteOf("/api/controls/run")).toEqual({ kind: "control" });
    expect(p.guestRouteOf("/api/controls/other")).toBeNull();
    expect(p.guestRouteOf("/build/lounge")).toBeNull();
    expect(p.isDraftRequest("?draft=1")).toBe(true);
    expect(p.isDraftRequest("?x=1")).toBe(false);
  });

  it("checkScope refuses a guest with the usual permission error", async () => {
    const { checkScope } = await import("./server/policy");
    const guest: Principal = { kind: "guest", guestLinkId: "l1", appId: "a1", label: "Sam", via: "guest-link" };
    expect(checkScope(guest, "atrium:read")).toEqual({ ok: false, status: 403, missing: { role: "viewer" }, message: "You do not have permission to do that." });
  });

  it("the schema file is owned and lists only hashes", () => {
    const src = readFileSync(path.join(APP_ROOT, "src/db/schema/guests.ts"), "utf8");
    expect(src).toMatch(/token_hash/);
    expect(src).not.toMatch(/text\("(token|pin|cookie)"\)/);
    expect(statSync(path.join(APP_ROOT, "src/db/schema/guests.ts")).isFile()).toBe(true);
  });
});
