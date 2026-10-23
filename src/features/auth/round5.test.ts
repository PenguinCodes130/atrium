import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { Principal } from "@/core/contracts";
import { Client, freshDataDir, setEnv, PUBLIC_URL } from "./test/harness";

// Round 5 (auth-spec-v3, architecture v3 Amendment 3): member invites and resets, and the allowlist
// fix (gauntlet r3 fix 2). Criteria 3 to 20. Each test boots a fresh module graph on a fresh SQLite
// file, with no Google or OIDC configured, and calls the real /api/auth handler, the real
// /invite/<token> route handler and the real manage and service functions in-process.

const OWNER = { email: "owner@atrium.test", password: "unit-owner-password-123" };
const MEMBER_PW = "unit-member-password-456";
const NEW_PW = "unit-invitee-password-789";
const DAY = 86_400_000;

vi.setConfig({ testTimeout: 30_000 });

let ip = 10;
const nextIp = () => `203.0.113.${(ip = (ip % 240) + 1) + 10}`;

async function boot() {
  setEnv({ ATRIUM_DATA_DIR: freshDataDir(), ATRIUM_OWNER_EMAIL: OWNER.email, ATRIUM_OWNER_PASSWORD: OWNER.password });
  vi.resetModules();
  const handler = await import("./server/handler");
  const m = {
    handle: handler.handleAuthRequest,
    bootstrap: await import("./server/bootstrap"),
    session: await import("./server/session"),
    manage: await import("./server/manage"),
    allowlist: await import("./server/allowlist"),
    users: await import("./server/users"),
    authMod: await import("./server/auth"),
    links: await import("./account-links/service"),
    policy: await import("./account-links/policy"),
    rate: await import("./server/rate-limit"),
    route: await import("@/app/invite/[token]/route"),
    db: await import("@/core/db"),
  };
  await m.bootstrap.ensureBootstrapped();
  return m;
}
type M = Awaited<ReturnType<typeof boot>>;

function sql<T = Record<string, unknown>>(m: M, q: string, ...args: unknown[]): T[] {
  return m.db.sqlite().prepare(q).all(...args) as T[];
}

async function addUser(m: M, email: string, role: "member" | "viewer", password?: string) {
  const id = randomUUID();
  const now = Date.now();
  m.db.sqlite().prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, email, email, 1, role, 0, now, now);
  if (password) {
    const hash = await m.authMod.hashPassword(password);
    m.db.sqlite().prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, hash, now, now);
  }
  m.allowlist.addAllowlistPattern(email, role);
  return id;
}

async function signedIn(m: M, email: string, password: string): Promise<Client> {
  const c = new Client(m.handle, nextIp());
  const res = await c.post("/api/auth/sign-in/email", { email, password });
  expect(res.status, `sign-in ${email}`).toBe(200);
  return c;
}

const ownerPrincipal = (m: M): Extract<Principal, { kind: "user" }> => {
  const id = sql<{ id: string }>(m, "SELECT id FROM user WHERE role = 'owner'")[0]!.id;
  return { kind: "user", userId: id, role: "owner", via: "session" };
};
const userPrincipal = (id: string, role: "member" | "viewer"): Principal => ({ kind: "user", userId: id, role, via: "session" });

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const events = (m: M, event: string) => sql<{ event: string; actor_kind: string; actor_user_id: string | null; target_label: string | null; detail: string | null }>(m, "SELECT * FROM audit_log WHERE event = ?", event);

/** Calls the real /invite/<token> route handler with a client's cookies and headers. */
async function openLink(m: M, c: Client | null, token: string, extra: Record<string, string> = {}) {
  const h = c ? c.headers(extra) : new Headers({ origin: PUBLIC_URL, ...extra });
  const res = await m.route.GET(new Request(`${PUBLIC_URL}/invite/${token}`, { headers: h, redirect: "manual" }), { params: Promise.resolve({ token }) });
  c?.absorb(res);
  return res;
}
async function submitLink(m: M, c: Client | null, token: string, body: unknown, extra: Record<string, string> = {}) {
  const h = c ? c.headers({ "content-type": "application/json", ...extra }) : new Headers({ origin: PUBLIC_URL, "content-type": "application/json", ...extra });
  const res = await m.route.POST(new Request(`${PUBLIC_URL}/invite/${token}`, { method: "POST", headers: h, body: JSON.stringify(body) }), { params: Promise.resolve({ token }) });
  c?.absorb(res);
  return res;
}
const anon = () => new Client(async () => new Response(null), nextIp());

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------

describe("allowlist (fix list item 2)", () => {
  it("3: adding an existing pattern, the owner's own email included, is refused and changes nothing", async () => {
    const m = await boot();
    expect(() => m.allowlist.addAllowlistPattern(OWNER.email, "viewer")).toThrow("Already on the allowlist as owner.");
    expect(() => m.allowlist.addAllowlistPattern(` ${OWNER.email.toUpperCase()} `, "member")).toThrow("Already on the allowlist as owner.");
    m.allowlist.addAllowlistPattern("ana@atrium.test", "viewer");
    try {
      m.allowlist.addAllowlistPattern("ana@atrium.test", "member");
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "already_listed", message: "Already on the allowlist as viewer." });
    }
    // Through the owner's signed-in action path too.
    const owner = await signedIn(m, OWNER.email, OWNER.password);
    await expect(m.manage.addPatternAs(owner.headers(), OWNER.email, "member")).rejects.toMatchObject({ status: 409, message: "Already on the allowlist as owner." });
    expect(sql(m, "SELECT pattern, role FROM allowlist ORDER BY pattern")).toEqual([
      { pattern: "ana@atrium.test", role: "viewer" },
      { pattern: OWNER.email, role: "owner" },
    ]);
  });

  it("4: the role control changes a non-owner entry; changing or removing the owner's entry is refused", async () => {
    const m = await boot();
    const ana = m.allowlist.addAllowlistPattern("ana@atrium.test", "viewer");
    const owner = await signedIn(m, OWNER.email, OWNER.password);
    expect((await m.manage.setPatternRoleAs(owner.headers(), ana.id, "member")).role).toBe("member");
    expect(sql(m, "SELECT role FROM allowlist WHERE pattern = 'ana@atrium.test'")).toEqual([{ role: "member" }]);
    const ownerEntry = sql<{ id: string }>(m, "SELECT id FROM allowlist WHERE role = 'owner'")[0]!.id;
    for (const role of ["member", "viewer"] as const) {
      await expect(m.manage.setPatternRoleAs(owner.headers(), ownerEntry, role)).rejects.toMatchObject({ status: 400, code: "owner_entry" });
    }
    await expect(m.manage.removePatternAs(owner.headers(), ownerEntry)).rejects.toMatchObject({ status: 400, code: "owner_entry" });
    expect(() => m.allowlist.setAllowlistRole(ana.id, "owner")).toThrow(/only one owner/);
    expect(sql(m, "SELECT role FROM allowlist WHERE id = ?", ownerEntry)).toEqual([{ role: "owner" }]);
  });
});

describe("who may create, list and revoke links", () => {
  it("5: members, viewers, agents and bearer-only callers are refused; the owner succeeds", async () => {
    const m = await boot();
    const memberId = await addUser(m, "mem@atrium.test", "member", MEMBER_PW);
    const viewerId = await addUser(m, "vic@atrium.test", "viewer", "unit-viewer-password-321");
    const owner = ownerPrincipal(m);
    const { link } = m.links.createInvite(owner, { email: "new@atrium.test", role: "member" });

    for (const [p, role] of [[userPrincipal(memberId, "member"), "member"], [userPrincipal(viewerId, "viewer"), "viewer"]] as const) {
      const refusal = { status: 403, message: `Only the owner can create invite and reset links; you are a ${role}.` };
      expect(() => m.links.createInvite(p, { email: "x@atrium.test", role: "viewer" })).toThrow(expect.objectContaining(refusal));
      expect(() => m.links.createReset(p, memberId)).toThrow(expect.objectContaining(refusal));
      expect(() => m.links.listAccountLinks(p)).toThrow(expect.objectContaining(refusal));
      expect(() => m.links.revokeAccountLink(p, link.id)).toThrow(expect.objectContaining(refusal));
    }
    const agents: Principal[] = [
      { kind: "agent", userId: owner.userId, role: "owner", via: "pat", tokenId: "t-1", agentName: "claude", scopes: ["atrium:read", "atrium:edit"] },
      { kind: "agent", userId: owner.userId, role: "owner", via: "mcp-oauth", tokenId: "t-2", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] },
      { kind: "builtin-agent", userId: owner.userId, role: "owner", conversationId: "c-1" },
    ];
    for (const p of agents) {
      expect(() => m.links.createInvite(p, { email: "x@atrium.test", role: "viewer" })).toThrow(expect.objectContaining({ status: 403, message: m.policy.LINK_MESSAGES.agents }));
      expect(() => m.links.listAccountLinks(p)).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => m.links.revokeAccountLink(p, link.id)).toThrow(expect.objectContaining({ status: 403 }));
    }
    expect(() => m.links.listAccountLinks(null)).toThrow(expect.objectContaining({ status: 401 }));

    // Through the signed-in action path: a member's session is refused with 403, a bearer-only caller with 401.
    const mem = await signedIn(m, "mem@atrium.test", MEMBER_PW);
    await expect(m.manage.createInviteAs(mem.headers(), { email: "y@atrium.test", role: "viewer" })).rejects.toMatchObject({ status: 403 });
    await expect(m.manage.listLinksAs(mem.headers())).rejects.toMatchObject({ status: 403 });
    await expect(m.manage.revokeLinkAs(mem.headers(), link.id)).rejects.toMatchObject({ status: 403 });
    m.session.registerAgentTokenResolver(async (b) => (b === "atr_pat_unit5" ? { tokenId: "tok-5", userId: owner.userId, agentName: "claude", scopes: ["atrium:read", "atrium:edit"], via: "pat", createdAt: new Date() } : null));
    const bearer = new Headers({ origin: PUBLIC_URL, authorization: "Bearer atr_pat_unit5" });
    await expect(m.manage.createInviteAs(bearer, { email: "y@atrium.test", role: "viewer" })).rejects.toMatchObject({ status: 401 });
    await expect(m.manage.createResetAs(bearer, memberId)).rejects.toMatchObject({ status: 401 });
    await expect(m.manage.listLinksAs(bearer)).rejects.toMatchObject({ status: 401 });
    await expect(m.manage.revokeLinkAs(bearer, link.id)).rejects.toMatchObject({ status: 401 });

    const ownerC = await signedIn(m, OWNER.email, OWNER.password);
    expect((await m.manage.listLinksAs(ownerC.headers())).map((l) => l.status)).toEqual(["waiting"]);
    expect((await m.manage.createInviteAs(ownerC.headers(), { email: "y@atrium.test", role: "viewer" })).url).toMatch(/\/invite\/atr_i_/);
    expect((await m.manage.revokeLinkAs(ownerC.headers(), link.id)).status).toBe("revoked");
    expect(sql(m, "SELECT id FROM account_link")).toHaveLength(2);
  });

  it("6: refusals name the reason; 30 days is accepted and the default is 7", async () => {
    const m = await boot();
    await addUser(m, "mem@atrium.test", "member", MEMBER_PW);
    const owner = ownerPrincipal(m);
    const refused = (input: Record<string, unknown>, message: string) => {
      expect(() => m.links.createInvite(owner, input), JSON.stringify(input)).toThrow(expect.objectContaining({ status: 400, message }));
    };
    refused({ email: "mem@atrium.test", role: "member" }, "mem@atrium.test already has an account. Use Reset password on their row instead.");
    refused({ email: OWNER.email, role: "member" }, `${OWNER.email} already has an account. Use Reset password on their row instead.`);
    refused({ email: "*@family.test", role: "member" }, m.policy.LINK_MESSAGES.exactEmail);
    refused({ email: "not-an-email", role: "member" }, m.policy.LINK_MESSAGES.exactEmail);
    refused({ email: "new@atrium.test", role: "owner" }, m.policy.LINK_MESSAGES.ownerRole);
    refused({ email: "new@atrium.test", role: "viewer", days: 0 }, "Pick between 1 and 30 days.");
    refused({ email: "new@atrium.test", role: "viewer", days: 31 }, "Pick between 1 and 30 days.");
    expect(sql(m, "SELECT id FROM account_link")).toHaveLength(0);
    const now = Date.now();
    const a = m.links.createInvite(owner, { email: "a@atrium.test", role: "viewer", days: 30 }, { now });
    expect(Date.parse(a.link.expiresAt) - now).toBe(30 * DAY);
    const b = m.links.createInvite(owner, { email: "b@atrium.test", role: "viewer" }, { now });
    expect(Date.parse(b.link.expiresAt) - now).toBe(7 * DAY);
    expect(m.policy.DEFAULT_DAYS).toBe(7);
  });

  it("7: a new email gets an exact allowlist entry with the chosen role; a different role than an existing entry is refused", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    m.links.createInvite(owner, { email: "New.Person@Atrium.test", role: "member" });
    expect(sql(m, "SELECT pattern, role FROM allowlist WHERE pattern = 'new.person@atrium.test'")).toEqual([{ pattern: "new.person@atrium.test", role: "member" }]);
    m.allowlist.addAllowlistPattern("kid@atrium.test", "viewer");
    expect(() => m.links.createInvite(owner, { email: "kid@atrium.test", role: "member" })).toThrow(
      expect.objectContaining({ message: "Already on the allowlist as viewer. Change the role on its entry first." }),
    );
    // The entry's own role is used unchanged.
    expect(m.links.createInvite(owner, { email: "kid@atrium.test", role: "viewer" }).link.role).toBe("viewer");
    expect(sql(m, "SELECT role FROM allowlist WHERE pattern = 'kid@atrium.test'")).toEqual([{ role: "viewer" }]);
  });

  it("8: the link is <public URL>/invite/atr_i_ plus 43 base64url characters; only its SHA-256 is stored; listing returns no token or hash", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    const created = m.links.createInvite(owner, { email: "new@atrium.test", role: "viewer" });
    expect(created.url).toMatch(new RegExp(`^${PUBLIC_URL.replace(/[.:/]/g, "\\$&")}/invite/atr_i_[A-Za-z0-9_-]{43}$`));
    const token = tokenOf(created.url);
    const rows = sql<Record<string, unknown>>(m, "SELECT * FROM account_link");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    const listed = JSON.stringify(m.links.listAccountLinks(owner));
    expect(listed).not.toContain(token);
    expect(listed).not.toContain(sha(token));
    expect(listed).not.toMatch(/hash/i);
    const page = JSON.stringify(await m.manage.loadUsersPage((await signedIn(m, OWNER.email, OWNER.password)).headers()));
    expect(page).not.toContain(token);
    expect(page).not.toContain(sha(token));
  });
});

describe("opening and using links", () => {
  it("10: a live invite shows the email; short, common or mismatched passwords are refused naming the rule and nothing is consumed", async () => {
    const m = await boot();
    const { url } = m.links.createInvite(ownerPrincipal(m), { email: "new@atrium.test", role: "member" });
    const token = tokenOf(url);
    const open = await openLink(m, null, token);
    expect(open.status).toBe(303);
    expect(open.headers.get("location")).toBe(`/invite/${token}/set`);
    expect(await m.links.inspectAccountLink(token, new Headers())).toMatchObject({ kind: "invite", email: "new@atrium.test", role: "member" });
    const cases: [Record<string, string>, string, string][] = [
      [{ password: "elevenchars", confirm: "elevenchars" }, "password", "Use at least 12 characters."],
      [{ password: "unbelievable", confirm: "unbelievable" }, "password", "That password is on the list of common passwords. Pick another."],
      [{ password: NEW_PW, confirm: `${NEW_PW}x` }, "confirm", m.policy.LINK_MESSAGES.passwordMismatch],
    ];
    for (const [body, field, message] of cases) {
      const res = await submitLink(m, null, token, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ state: "invalid", field, message });
    }
    expect(sql(m, "SELECT used_at FROM account_link")).toEqual([{ used_at: null }]);
    expect(sql(m, "SELECT id FROM user WHERE email = 'new@atrium.test'")).toHaveLength(0);
    expect((await m.links.inspectAccountLink(token, new Headers())).kind).toBe("invite");
  });

  it("11: a valid password creates the user with the invite's role, signs them in, marks the link used, writes one invite_used; a double submit makes one user", async () => {
    const m = await boot();
    const { url } = m.links.createInvite(ownerPrincipal(m), { email: "new@atrium.test", role: "member" });
    const token = tokenOf(url);
    const a = anon();
    const b = anon();
    const [ra, rb] = await Promise.all([submitLink(m, a, token, { password: NEW_PW, confirm: NEW_PW }), submitLink(m, b, token, { password: NEW_PW, confirm: NEW_PW })]);
    const results = [await ra.json(), await rb.json()].map((x) => (x as { state: string }).state).sort();
    expect(results).toEqual(["expired", "invite_done"]);
    const winner = ra.status === 200 ? a : b;
    expect(winner.jar.has("atrium.session")).toBe(true);
    const users = sql<{ id: string; role: string }>(m, "SELECT id, role FROM user WHERE email = 'new@atrium.test'");
    expect(users).toEqual([{ id: expect.any(String), role: "member" }]);
    const s = await m.session.sessionFromHeaders(winner.headers());
    expect(s?.user).toMatchObject({ email: "new@atrium.test", role: "member" });
    expect(sql<{ used_at: number | null }>(m, "SELECT used_at FROM account_link")[0]!.used_at).toBeGreaterThan(0);
    const used = events(m, "account.invite_used");
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ actor_kind: "user", actor_user_id: users[0]!.id });
    expect(sql(m, "SELECT role FROM allowlist WHERE pattern = 'new@atrium.test'")).toEqual([{ role: "member" }]);
    // A third submit, later, is the dead link.
    const again = await submitLink(m, anon(), token, { password: NEW_PW, confirm: NEW_PW });
    expect(again.status).toBe(404);
    expect(sql(m, "SELECT id FROM user WHERE email = 'new@atrium.test'")).toHaveLength(1);
    // And the person can sign in with the password they chose.
    await signedIn(m, "new@atrium.test", NEW_PW);
  });

  it("12: a reset sets the password, ends every session and earlier agent token of that user, marks it used, writes one reset_used", async () => {
    const m = await boot();
    const memberId = await addUser(m, "mem@atrium.test", "member", MEMBER_PW);
    const phone = await signedIn(m, "mem@atrium.test", MEMBER_PW);
    const laptop = await signedIn(m, "mem@atrium.test", MEMBER_PW);
    const tokenCreated = new Date(Date.now() - 60_000);
    m.session.registerAgentTokenResolver(async (b) => (b === "atr_pat_mem" ? { tokenId: "tok-mem", userId: memberId, agentName: "claude", scopes: ["atrium:read"], via: "pat", createdAt: tokenCreated } : null));
    const bearer = new Headers({ authorization: "Bearer atr_pat_mem" });
    expect(await m.session.principalFromHeaders(bearer)).toMatchObject({ kind: "agent", userId: memberId });
    const cut: string[] = [];
    m.users.onUserAccessRevoked(({ userId, reason }) => void cut.push(`${userId}:${reason}`));

    const { url } = m.links.createReset(ownerPrincipal(m), memberId);
    const token = tokenOf(url);
    expect(await m.links.inspectAccountLink(token, new Headers())).toMatchObject({ kind: "reset", email: "mem@atrium.test" });
    const res = await submitLink(m, anon(), token, { password: NEW_PW, confirm: NEW_PW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "reset_done" });
    expect(res.headers.getSetCookie()).toEqual([]);

    expect(await m.session.sessionFromHeaders(phone.headers())).toBeNull();
    expect(await m.session.sessionFromHeaders(laptop.headers())).toBeNull();
    expect(sql(m, "SELECT id FROM session WHERE user_id = ?", memberId)).toHaveLength(0);
    expect(await m.session.principalFromHeaders(bearer)).toBeNull();
    expect(cut).toEqual([`${memberId}:password_reset`]);
    expect(sql<{ used_at: number | null }>(m, "SELECT used_at FROM account_link")[0]!.used_at).toBeGreaterThan(0);
    expect(events(m, "account.reset_used")).toHaveLength(1);
    const old = await new Client(m.handle, nextIp()).post("/api/auth/sign-in/email", { email: "mem@atrium.test", password: MEMBER_PW });
    expect(old.status).toBe(401);
    await signedIn(m, "mem@atrium.test", NEW_PW);
  });

  it("12 (no password before): a reset adds a password for a member who had none", async () => {
    const m = await boot();
    const id = await addUser(m, "google-only@atrium.test", "viewer");
    const { url } = m.links.createReset(ownerPrincipal(m), id);
    expect((await submitLink(m, anon(), tokenOf(url), { password: NEW_PW, confirm: NEW_PW })).status).toBe(200);
    await signedIn(m, "google-only@atrium.test", NEW_PW);
  });

  it("13: a reset for the owner is refused with the server command", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    expect(() => m.links.createReset(owner, owner.userId)).toThrow(expect.objectContaining({ status: 400, message: "The owner's password is reset on the server: pnpm atrium:reset-owner." }));
    expect(sql(m, "SELECT id FROM account_link")).toHaveLength(0);
  });

  it("14: unknown, malformed, expired, used, revoked and no-longer-fitting links answer byte-identically, with no cookie", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    const memberId = await addUser(m, "mem@atrium.test", "member", MEMBER_PW);
    const live = (email: string, opts: { now?: number; days?: number } = {}) => tokenOf(m.links.createInvite(owner, { email, role: "viewer", days: opts.days }, { now: opts.now }).url);
    const expired = live("old@atrium.test", { now: Date.now() - 8 * DAY });
    const used = live("used@atrium.test");
    await submitLink(m, anon(), used, { password: NEW_PW, confirm: NEW_PW });
    const revoked = m.links.createInvite(owner, { email: "rev@atrium.test", role: "viewer" });
    m.links.revokeAccountLink(owner, revoked.link.id);
    const gained = live("gained@atrium.test");
    await addUser(m, "gained-other@atrium.test", "viewer");
    m.db.sqlite().prepare("UPDATE user SET email = 'gained@atrium.test' WHERE email = 'gained-other@atrium.test'").run();
    const resetRemoved = tokenOf(m.links.createReset(owner, memberId).url);
    m.users.removeUser(memberId, owner);

    const cases: [string, string][] = [
      ["unknown", `atr_i_${"A".repeat(43)}`],
      ["malformed", "not-a-token"],
      ["malformed long", `atr_i_${"A".repeat(44)}`],
      ["expired", expired],
      ["used", used],
      ["revoked", tokenOf(revoked.url)],
      ["invite whose email gained an account", gained],
      ["reset whose user was removed", resetRemoved],
    ];
    const snapshot = async (res: Response) => {
      const h = [...res.headers].filter(([k]) => k !== "date").sort();
      return JSON.stringify({ status: res.status, headers: h, body: await res.text() });
    };
    const answers = new Map<string, string>();
    for (const [name, token] of cases) {
      const res = await openLink(m, null, token);
      expect(res.headers.getSetCookie(), name).toEqual([]);
      answers.set(name, await snapshot(res));
    }
    const distinct = new Set(answers.values());
    expect(distinct.size, [...answers].map(([k, v]) => `${k}: ${v}`).join("\n")).toBe(1);
    expect(JSON.parse([...distinct][0]!)).toMatchObject({ status: 303, body: "" });
    expect([...distinct][0]).toContain('"location","/invite/expired"');
    // The screen text the expired page shows, word for word.
    expect(m.policy.DEAD_TEXT).toBe("This link has expired or was already used");
    // Submitting to any of them is the same dead answer.
    const posts = new Set<string>();
    for (const [, token] of cases) posts.add(await snapshot(await submitLink(m, null, token, { password: NEW_PW, confirm: NEW_PW })));
    expect(posts.size).toBe(1);
  });

  it("15: the 31st open of the link addresses in one minute from one IP is limited with Retry-After", async () => {
    const m = await boot();
    const now = Date.now();
    for (let i = 0; i < 30; i++) m.rate.hit("accountLinkIp", "198.51.100.9", now);
    try {
      m.rate.hit("accountLinkIp", "198.51.100.9", now);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 429 });
      expect((err as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    }
    // Another address is not affected, and the window resets after a minute.
    expect(() => m.rate.hit("accountLinkIp", "198.51.100.10", now)).not.toThrow();
    expect(() => m.rate.hit("accountLinkIp", "198.51.100.9", now + 60_000)).not.toThrow();
    expect(m.rate.LIMITS.accountLinkIp).toEqual({ limit: 30, windowMs: 60_000 });
  });

  it("16: a signed-in user opening a live invite is told so, nothing is consumed, and the link still works signed out", async () => {
    const m = await boot();
    const { url } = m.links.createInvite(ownerPrincipal(m), { email: "new@atrium.test", role: "viewer" });
    const token = tokenOf(url);
    const owner = await signedIn(m, OWNER.email, OWNER.password);
    const res = await openLink(m, owner, token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/invite/signed-in");
    const post = await submitLink(m, owner, token, { password: NEW_PW, confirm: NEW_PW });
    expect(await post.json()).toEqual({ state: "signed_in" });
    expect(sql(m, "SELECT used_at, revoked_at FROM account_link")).toEqual([{ used_at: null, revoked_at: null }]);
    expect(m.policy.SIGNED_IN_TEXT).toBe("You are already signed in");
    expect((await openLink(m, null, token)).headers.get("location")).toBe(`/invite/${token}/set`);
    expect((await submitLink(m, anon(), token, { password: NEW_PW, confirm: NEW_PW })).status).toBe(200);
  });

  it("17: revoke ends a link at once; a new invite or reset replaces the earlier one; removing an entry revokes its invite", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    const memberId = await addUser(m, "mem@atrium.test", "member", MEMBER_PW);
    const first = m.links.createInvite(owner, { email: "new@atrium.test", role: "viewer" });
    m.links.revokeAccountLink(owner, first.link.id);
    expect((await m.links.inspectAccountLink(tokenOf(first.url), new Headers())).kind).toBe("dead");
    expect(events(m, "account.link_revoked").map((e) => JSON.parse(e.detail!).cause)).toEqual(["manual"]);

    const a = m.links.createInvite(owner, { email: "two@atrium.test", role: "viewer" });
    const b = m.links.createInvite(owner, { email: "two@atrium.test", role: "viewer" });
    expect((await m.links.inspectAccountLink(tokenOf(a.url), new Headers())).kind).toBe("dead");
    expect((await m.links.inspectAccountLink(tokenOf(b.url), new Headers())).kind).toBe("invite");
    const r1 = m.links.createReset(owner, memberId);
    const r2 = m.links.createReset(owner, memberId);
    expect((await m.links.inspectAccountLink(tokenOf(r1.url), new Headers())).kind).toBe("dead");
    expect((await m.links.inspectAccountLink(tokenOf(r2.url), new Headers())).kind).toBe("reset");

    const entry = sql<{ id: string }>(m, "SELECT id FROM allowlist WHERE pattern = 'two@atrium.test'")[0]!.id;
    expect(m.allowlist.removeAllowlistPattern(entry, owner)).toEqual({ pattern: "two@atrium.test", role: "viewer" });
    expect((await m.links.inspectAccountLink(tokenOf(b.url), new Headers())).kind).toBe("dead");
    expect(events(m, "account.link_revoked").map((e) => JSON.parse(e.detail!).cause)).toEqual(["manual", "replaced", "replaced", "entry_removed"]);

    // The role control on an entry also applies to that email's waiting invite.
    const c = m.links.createInvite(owner, { email: "three@atrium.test", role: "viewer" });
    m.allowlist.setAllowlistRole(sql<{ id: string }>(m, "SELECT id FROM allowlist WHERE pattern = 'three@atrium.test'")[0]!.id, "member");
    expect(await m.links.inspectAccountLink(tokenOf(c.url), new Headers())).toMatchObject({ kind: "invite", role: "member" });
  });

  it("18: create, open, use and revoke write their audit events, and no audit entry or log line holds a token, hash or password", async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    const m = await boot();
    const owner = ownerPrincipal(m);
    const memberId = await addUser(m, "mem@atrium.test", "member", MEMBER_PW);
    const inv = m.links.createInvite(owner, { email: "new@atrium.test", role: "viewer" }, { ip: "198.51.100.4" });
    const rst = m.links.createReset(owner, memberId);
    const extra = m.links.createInvite(owner, { email: "gone@atrium.test", role: "viewer" });
    const secrets = [inv.url, rst.url, extra.url].flatMap((u) => [tokenOf(u), sha(tokenOf(u))]).concat([NEW_PW, MEMBER_PW, OWNER.password, "elevenchars"]);
    await openLink(m, null, tokenOf(inv.url));
    await submitLink(m, null, tokenOf(inv.url), { password: "elevenchars", confirm: "elevenchars" });
    await submitLink(m, anon(), tokenOf(inv.url), { password: NEW_PW, confirm: NEW_PW });
    await submitLink(m, anon(), tokenOf(rst.url), { password: `${NEW_PW}-r`, confirm: `${NEW_PW}-r` });
    secrets.push(`${NEW_PW}-r`);
    m.links.revokeAccountLink(owner, extra.link.id);
    await openLink(m, null, tokenOf(extra.url));

    const created = events(m, "account.invite_created");
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ actor_kind: "user", actor_user_id: owner.userId, target_label: "new@atrium.test" });
    expect(JSON.parse(created[0]!.detail!)).toMatchObject({ kind: "invite", email: "new@atrium.test", role: "viewer", expiresAt: expect.any(String) });
    expect(events(m, "account.reset_created")).toHaveLength(1);
    expect(events(m, "account.invite_used")).toHaveLength(1);
    expect(events(m, "account.reset_used")).toHaveLength(1);
    expect(events(m, "account.link_revoked")).toHaveLength(1);

    const audit = JSON.stringify(sql(m, "SELECT * FROM audit_log"));
    const log = lines.join("\n");
    expect(log).toContain("Account link created");
    for (const s of secrets) {
      expect(audit.includes(s), `audit holds ${s.slice(0, 10)}`).toBe(false);
      expect(log.includes(s), `log holds ${s.slice(0, 10)}`).toBe(false);
    }
  });

  it("19: with only a bearer token, every link address and link action is refused and nothing is consumed", async () => {
    const m = await boot();
    const owner = ownerPrincipal(m);
    m.session.registerAgentTokenResolver(async (b) => (b === "atr_pat_unit19" ? { tokenId: "tok-19", userId: owner.userId, agentName: "claude", scopes: ["atrium:read", "atrium:edit"], via: "pat", createdAt: new Date() } : null));
    const { url, link } = m.links.createInvite(owner, { email: "new@atrium.test", role: "viewer" });
    const token = tokenOf(url);
    const auth = { authorization: "Bearer atr_pat_unit19" };
    const g = await openLink(m, null, token, auth);
    expect(g.status).toBe(403);
    expect(((await g.json()) as { error: { code: string } }).error.code).toBe("agents_refused");
    const p = await submitLink(m, null, token, { password: NEW_PW, confirm: NEW_PW }, auth);
    expect(p.status).toBe(403);
    const h = new Headers({ origin: PUBLIC_URL, ...auth });
    await expect(m.manage.createInviteAs(h, { email: "x@atrium.test", role: "viewer" })).rejects.toMatchObject({ status: 401 });
    await expect(m.manage.listLinksAs(h)).rejects.toMatchObject({ status: 401 });
    await expect(m.manage.revokeLinkAs(h, link.id)).rejects.toMatchObject({ status: 401 });
    expect(sql(m, "SELECT used_at, revoked_at FROM account_link")).toEqual([{ used_at: null, revoked_at: null }]);
    expect(sql(m, "SELECT id FROM user WHERE email = 'new@atrium.test'")).toHaveLength(0);
  });
});

describe("sign-in for an invited person", () => {
  it("20: an allowlisted email with no password is told to ask for an invite link (no providers configured)", async () => {
    const m = await boot();
    m.allowlist.addAllowlistPattern("invited@atrium.test", "member");
    await addUser(m, "nopw@atrium.test", "viewer");
    for (const email of ["invited@atrium.test", "nopw@atrium.test"]) {
      const res = await new Client(m.handle, nextIp()).post("/api/auth/sign-in/email", { email, password: "some-password-here" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe("This email has no password yet. Ask the owner of this Atrium for an invite link.");
    }
  });
});
