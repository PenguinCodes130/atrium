import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, freshDataDir, secretFromUri, setEnv, totp, PUBLIC_URL } from "./test/harness";
import { stampValue } from "./server/peer";

// In-process tests of the real /api/auth handler, bootstrap, sessions, TOTP, OIDC, roles, step-up
// and rate limits. Each test boots a fresh module graph on a fresh SQLite file.

const OWNER = { email: "owner@atrium.test", password: "unit-owner-password-123" };
const IDP = "https://idp.test";

type Profile = { sub: string; email: string; email_verified: boolean; name?: string };
const idp: { profile?: Profile } = {};
const realFetch = globalThis.fetch;

async function boot(env: Record<string, string | undefined> = {}, dir = freshDataDir()) {
  setEnv({
    ATRIUM_DATA_DIR: dir,
    ATRIUM_OWNER_EMAIL: OWNER.email,
    ATRIUM_OWNER_PASSWORD: OWNER.password,
    ATRIUM_OIDC_CLIENT_ID: "atrium-test",
    ATRIUM_OIDC_CLIENT_SECRET: "mock-oidc-client-value",
    ATRIUM_OIDC_NAME: "Test SSO",
    ATRIUM_OIDC_AUTHORIZATION_URL: `${IDP}/authorize`,
    ATRIUM_OIDC_TOKEN_URL: `${IDP}/token`,
    ATRIUM_OIDC_USERINFO_URL: `${IDP}/userinfo`,
    ...env,
  });
  vi.resetModules();
  const handler = await import("./server/handler");
  const m = {
    dir,
    handle: handler.handleAuthRequest,
    bootstrap: await import("./server/bootstrap"),
    session: await import("./server/session"),
    users: await import("./server/users"),
    manage: await import("./server/manage"),
    allowlist: await import("./server/allowlist"),
    stepUp: await import("./server/step-up"),
    banners: await import("./server/banners"),
    tokens: await import("./server/tokens"),
    authMod: await import("./server/auth"),
    db: await import("@/core/db"),
  };
  await m.bootstrap.ensureBootstrapped();
  return m;
}
type M = Awaited<ReturnType<typeof boot>>;

function sql<T = Record<string, unknown>>(m: M, q: string, ...args: unknown[]): T[] {
  return m.db.sqlite().prepare(q).all(...args) as T[];
}

async function addUser(m: M, email: string, role: "member" | "viewer", password?: string, allow = true) {
  const id = randomUUID();
  const now = Date.now();
  m.db.sqlite().prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, email, email, 1, role, 0, now, now);
  if (password) {
    const hash = await m.authMod.hashPassword(password);
    m.db.sqlite().prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, hash, now, now);
  }
  if (allow) m.allowlist.addAllowlistPattern(email, role);
  return id;
}

async function signIn(m: M, c: Client, email: string, password: string) {
  return c.post("/api/auth/sign-in/email", { email, password });
}

async function oidcSignIn(m: M, c: Client, profile: Profile) {
  const start = await c.post("/api/auth/sign-in/social", { provider: "oidc", callbackURL: "/", errorCallbackURL: "/sign-in" });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  idp.profile = profile;
  const cb = await c.get(`/api/auth/callback/oidc?code=mock-code&state=${encodeURIComponent(state)}`);
  return { status: cb.status, location: cb.headers.get("location") ?? "", authorizeUrl: url };
}

// Clears Atrium's limiter and Better Auth's second-factor lockout (10 straight failures lock 15 minutes).
const clearLimits = (m: M) => {
  m.db.sqlite().prepare("DELETE FROM auth_rate_limit").run();
  m.db.sqlite().prepare("UPDATE two_factor SET failed_verification_count = 0, locked_until = NULL").run();
};

// The first boot builds the template data folder (drizzle-kit migrate, then push): allow for it under load.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(`${IDP}/token`)) return Response.json({ access_token: "mock-access", token_type: "Bearer", expires_in: 3600 });
    if (url.startsWith(`${IDP}/userinfo`)) return Response.json(idp.profile ?? {});
    return realFetch(input, init);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------

describe("first run", () => {
  it("neither variable: setup required with the exact message, auth API answers 401 (criterion 1)", async () => {
    const m = await boot({ ATRIUM_OWNER_EMAIL: undefined, ATRIUM_OWNER_PASSWORD: undefined });
    const st = await m.bootstrap.ensureBootstrapped();
    expect(st).toMatchObject({ state: "setup-required", message: "Set ATRIUM_OWNER_EMAIL and restart" });
    const res = await new Client(m.handle).post("/api/auth/sign-in/email", { email: "x@y.z", password: "whatever-password" });
    expect(res.status).toBe(401);
    expect(sql(m, "SELECT * FROM user")).toHaveLength(0);
  });

  it("invalid email: the invalid message, nothing created (criterion 2)", async () => {
    const m = await boot({ ATRIUM_OWNER_EMAIL: "not-an-email" });
    expect(await m.bootstrap.ensureBootstrapped()).toMatchObject({ state: "setup-required", message: "ATRIUM_OWNER_EMAIL is not a valid email address" });
    expect(sql(m, "SELECT * FROM user")).toHaveLength(0);
    expect(sql(m, "SELECT * FROM allowlist")).toHaveLength(0);
  });

  it("both set: exactly one owner, allowlisted, argon2id hash (criteria 3, 4)", async () => {
    const m = await boot();
    const users = sql<{ email: string; role: string }>(m, "SELECT email, role FROM user");
    expect(users).toEqual([{ email: OWNER.email, role: "owner" }]);
    expect(sql(m, "SELECT pattern, role FROM allowlist")).toEqual([{ pattern: OWNER.email, role: "owner" }]);
    const [acct] = sql<{ password: string }>(m, "SELECT password FROM account");
    expect(acct!.password.startsWith("$argon2id$")).toBe(true);
    expect(acct!.password).not.toBe(OWNER.password);
    expect(acct!.password).not.toContain(OWNER.password);
  });

  it("restart with a different email changes nothing; a still-set password logs and shows the banner (criteria 6, 7)", async () => {
    const first = await boot();
    const before = sql(first, "SELECT id, email, role FROM user");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
    const m = await boot({ ATRIUM_OWNER_EMAIL: "someone-else@atrium.test" }, first.dir);
    spy.mockRestore();
    expect(sql(m, "SELECT id, email, role FROM user")).toEqual(before);
    expect(lines.some((l) => l.includes("ATRIUM_OWNER_PASSWORD is still set"))).toBe(true);
    const banners = await m.banners.getAuthBanners();
    expect(banners.map((b) => b.id)).toContain("owner-password-var");

    const quiet = await boot({ ATRIUM_OWNER_PASSWORD: undefined }, first.dir);
    expect((await quiet.banners.getAuthBanners()).map((b) => b.id)).not.toContain("owner-password-var");
  });

  it("only the email: no password sign-in, provider sign-in with that address works (criterion 5, OIDC path)", async () => {
    const m = await boot({ ATRIUM_OWNER_PASSWORD: undefined });
    expect(sql(m, "SELECT * FROM account")).toHaveLength(0);
    const c = new Client(m.handle);
    const pw = await signIn(m, c, OWNER.email, "any-password-at-all");
    // Round 5: an allowlisted account with no password is told so (400 no_password), not "do not match".
    expect(pw.status).toBe(400);
    expect(((await pw.clone().json()) as { error: { code: string } }).error.code).toBe("no_password");
    expect(c.jar.has("atrium.session")).toBe(false);
    const r = await oidcSignIn(m, c, { sub: "owner-sub", email: OWNER.email, email_verified: true });
    expect(r.status).toBe(302);
    expect(r.location).not.toContain("error");
    const s = await m.session.sessionFromHeaders(c.headers());
    expect(s?.user.email).toBe(OWNER.email);
    expect(s?.user.role).toBe("owner");
    expect(sql(m, "SELECT * FROM user")).toHaveLength(1);
  });

  it("no public sign-up endpoint exists (criterion 8)", async () => {
    const m = await boot();
    const res = await new Client(m.handle).post("/api/auth/sign-up/email", { email: "new@atrium.test", password: "a-long-new-password", name: "x" });
    expect([403, 404]).toContain(res.status);
    expect(sql(m, "SELECT * FROM user")).toHaveLength(1);
  });
});

describe("password sign-in", () => {
  it("sets atrium.session httpOnly, SameSite=Lax, not Secure over http (criterion 19)", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    const res = await signIn(m, c, OWNER.email, OWNER.password);
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((x) => x.startsWith("atrium.session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it("is Secure when the public URL is https (criterion 19)", async () => {
    const m = await boot({ ATRIUM_PUBLIC_URL: "https://atrium.example.test" });
    const c = new Client(m.handle);
    const res = await m.handle(
      new Request("https://atrium.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://atrium.example.test", "x-atrium-peer": stampValue(c.ip) },
        body: JSON.stringify(OWNER),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((x) => x.startsWith("atrium.session="))!;
    expect(cookie).toMatch(/; Secure/i);
  });

  it("a wrong password gets a plain message that does not say which part was wrong", async () => {
    const m = await boot();
    const res = await signIn(m, new Client(m.handle), OWNER.email, "definitely-wrong-password");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message?: string; error?: { message: string } };
    expect(JSON.stringify(body).toLowerCase()).toContain("invalid email or password");
  });

  it("refuses a correct password for an email on no allowlist pattern, with no session (criterion 9)", async () => {
    const m = await boot();
    await addUser(m, "stranger@elsewhere.test", "member", "stranger-password-1", false);
    const c = new Client(m.handle);
    const res = await signIn(m, c, "stranger@elsewhere.test", "stranger-password-1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/not on the allowlist/);
    expect(c.jar.has("atrium.session")).toBe(false);
    expect(sql(m, "SELECT * FROM session")).toHaveLength(0);
  });
});

async function enrolTotp(m: M, c: Client, password: string) {
  const en = await c.post("/api/auth/two-factor/enable", { password });
  expect(en.status).toBe(200);
  const { totpURI, backupCodes } = (await en.json()) as { totpURI: string; backupCodes: string[] };
  const secret = secretFromUri(totpURI);
  const v = await c.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
  expect(v.status).toBe(200);
  return { secret, backupCodes };
}

describe("TOTP and backup codes", () => {
  it("password alone gives no session once TOTP is on; a valid code completes sign-in (criterion 12)", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    await signIn(m, c, OWNER.email, OWNER.password);
    const { secret } = await enrolTotp(m, c, OWNER.password);

    const d = new Client(m.handle, "203.0.113.20");
    const res = await signIn(m, d, OWNER.email, OWNER.password);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(d.jar.has("atrium.session")).toBe(false);
    expect(await m.session.sessionFromHeaders(d.headers())).toBeNull();
    const bad = await d.post("/api/auth/two-factor/verify-totp", { code: "000000" === totp(secret) ? "111111" : "000000" });
    expect(bad.status).toBe(401);
    const ok = await d.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
    expect(ok.status).toBe(200);
    expect((await m.session.sessionFromHeaders(d.headers()))?.user.email).toBe(OWNER.email);
  });

  it("enrolment gives exactly 10 backup codes, each single-use; regenerating voids the old set (criteria 13, 14)", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    await signIn(m, c, OWNER.email, OWNER.password);
    const { backupCodes } = await enrolTotp(m, c, OWNER.password);
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);

    const useCode = async (code: string, ip: string) => {
      clearLimits(m);
      const d = new Client(m.handle, ip);
      await signIn(m, d, OWNER.email, OWNER.password);
      const r = await d.post("/api/auth/two-factor/verify-backup-code", { code });
      return r.status === 200 && !!(await m.session.sessionFromHeaders(d.headers()));
    };
    for (const [i, code] of backupCodes.entries()) expect(await useCode(code, `198.51.100.${i + 1}`), `code ${i}`).toBe(true);
    expect(await useCode(backupCodes[0]!, "198.51.100.50")).toBe(false);

    const regen = await c.post("/api/auth/two-factor/generate-backup-codes", { password: OWNER.password });
    expect(regen.status).toBe(200);
    const fresh = ((await regen.json()) as { backupCodes: string[] }).backupCodes;
    expect(fresh).toHaveLength(10);
    // Earlier set fully refused (a fresh earlier set: regenerate once more and test the previous one).
    const regen2 = await c.post("/api/auth/two-factor/generate-backup-codes", { password: OWNER.password });
    const newest = ((await regen2.json()) as { backupCodes: string[] }).backupCodes;
    for (const [i, code] of fresh.entries()) expect(await useCode(code, `198.51.101.${i + 1}`), `old code ${i}`).toBe(false);
    for (const [i, code] of newest.entries()) expect(await useCode(code, `198.51.102.${i + 1}`), `new code ${i}`).toBe(true);
  });
});

describe("OIDC sign-in", () => {
  it("refuses an unverified email; a verified one links to the existing user without a second user (criterion 15)", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    const bad = await oidcSignIn(m, c, { sub: "s-1", email: OWNER.email, email_verified: false });
    expect(bad.location).toContain("error");
    expect(c.jar.has("atrium.session")).toBe(false);
    const good = await oidcSignIn(m, c, { sub: "s-1", email: OWNER.email, email_verified: true });
    expect(good.location).not.toContain("error");
    expect((await m.session.sessionFromHeaders(c.headers()))?.user.role).toBe("owner");
    expect(sql(m, "SELECT * FROM user")).toHaveLength(1);
    expect(sql<{ provider_id: string }>(m, "SELECT provider_id FROM account ORDER BY provider_id").map((a) => a.provider_id)).toEqual(["credential", "oidc"]);
  });

  it("refuses an email on no allowlist pattern (allowlist on every method)", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    const r = await oidcSignIn(m, c, { sub: "s-2", email: "nobody@outside.test", email_verified: true });
    expect(r.location).toContain("error");
    expect(sql(m, "SELECT * FROM user")).toHaveLength(1);
  });

  it("a *@domain viewer stays a viewer when the pattern later becomes member (criterion 16)", async () => {
    const m = await boot();
    const entry = m.allowlist.addAllowlistPattern("*@family.test", "viewer");
    const c = new Client(m.handle);
    const r = await oidcSignIn(m, c, { sub: "kid-1", email: "kid@family.test", email_verified: true });
    expect(r.location).not.toContain("error");
    expect((await m.session.sessionFromHeaders(c.headers()))?.user.role).toBe("viewer");
    // Round 5 (gauntlet r3 fix 2): re-adding a pattern is refused; roles change only by the role control.
    m.allowlist.setAllowlistRole(entry.id, "member");
    expect((await m.session.sessionFromHeaders(c.headers()))?.user.role).toBe("viewer");
    const again = new Client(m.handle, "203.0.113.77");
    await oidcSignIn(m, again, { sub: "kid-1", email: "kid@family.test", email_verified: true });
    expect((await m.session.sessionFromHeaders(again.headers()))?.user.role).toBe("viewer");
  });
});

describe("sessions", () => {
  it("unused for 30 days is rejected; used on day 29 is still valid on day 31 (criterion 20)", async () => {
    const m = await boot();
    const a = new Client(m.handle);
    const b = new Client(m.handle, "203.0.113.30");
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await signIn(m, a, OWNER.email, OWNER.password);
    await signIn(m, b, OWNER.email, OWNER.password);
    vi.setSystemTime(t0 + 29 * 86_400_000);
    expect(await m.session.sessionFromHeaders(b.headers())).not.toBeNull(); // b used on day 29
    vi.setSystemTime(t0 + 30 * 86_400_000 + 60_000);
    expect(await m.session.sessionFromHeaders(a.headers())).toBeNull(); // a unused for 30 days
    vi.setSystemTime(t0 + 31 * 86_400_000);
    expect(await m.session.sessionFromHeaders(b.headers())).not.toBeNull();
  });

  it("a password change rejects every earlier session (criterion 21)", async () => {
    const m = await boot();
    const a = new Client(m.handle);
    const b = new Client(m.handle, "203.0.113.31");
    await signIn(m, a, OWNER.email, OWNER.password);
    await signIn(m, b, OWNER.email, OWNER.password);
    const oldA = a.headers();
    const weak = await a.post("/api/auth/change-password", { currentPassword: OWNER.password, newPassword: "unbelievable" });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { error: { message: string } }).error.message).toMatch(/common passwords/);
    const res = await a.post("/api/auth/change-password", { currentPassword: OWNER.password, newPassword: "a-brand-new-passphrase" });
    expect(res.status).toBe(200);
    expect(await m.session.sessionFromHeaders(b.headers())).toBeNull();
    expect(await m.session.sessionFromHeaders(oldA)).toBeNull();
  });

  it("sign out all others keeps the current session only (criterion 22)", async () => {
    const m = await boot();
    const [a, b, c] = [new Client(m.handle), new Client(m.handle, "203.0.113.32"), new Client(m.handle, "203.0.113.33")];
    for (const x of [a, b, c]) await signIn(m, x, OWNER.email, OWNER.password);
    const list = await m.manage.listMySessions(a.headers());
    expect(list).toHaveLength(3);
    expect(list.filter((x) => x.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(a.jar.get("atrium.session")!.split(".")[0]);
    expect((await a.get("/api/auth/list-sessions")).status).toBe(404); // would hand tokens to the browser
    expect(await m.manage.signOutOtherSessions(a.headers())).toBe(2);
    expect(await m.session.sessionFromHeaders(a.headers())).not.toBeNull();
    expect(await m.session.sessionFromHeaders(b.headers())).toBeNull();
    expect(await m.session.sessionFromHeaders(c.headers())).toBeNull();
  });
});

describe("users, roles and agent tokens", () => {
  it("demoting or removing a user rejects their sessions and agent tokens at once (criterion 17)", async () => {
    const m = await boot();
    const memberId = await addUser(m, "ana@atrium.test", "member", "ana-password-long-1");
    const c = new Client(m.handle, "203.0.113.40");
    await signIn(m, c, "ana@atrium.test", "ana-password-long-1");
    const issued = new Date(Date.now() - 1000);
    m.session.registerAgentTokenResolver(async (bearer) =>
      bearer === "atr_pat_test" ? { tokenId: "tok-1", userId: memberId, agentName: "claude", scopes: ["atrium:read", "atrium:edit"], via: "pat", createdAt: issued } : null,
    );
    const auth = new Headers({ authorization: "Bearer atr_pat_test" });
    expect((await m.session.principalFromHeaders(auth))?.role).toBe("member");
    const revoked: string[] = [];
    m.users.onUserAccessRevoked(({ userId }) => void revoked.push(userId));

    m.users.setUserRole(memberId, "viewer");
    expect(await m.session.sessionFromHeaders(c.headers())).toBeNull();
    expect(await m.session.principalFromHeaders(auth)).toBeNull();
    expect(revoked).toEqual([memberId]);

    const otherId = await addUser(m, "bo@atrium.test", "member", "bo-password-long-12");
    const d = new Client(m.handle, "203.0.113.41");
    await signIn(m, d, "bo@atrium.test", "bo-password-long-12");
    m.users.removeUser(otherId);
    expect(await m.session.sessionFromHeaders(d.headers())).toBeNull();
  });

  it("exactly one owner; removing or demoting the owner is refused; transfer needs step-up (criteria 18, 45)", async () => {
    const m = await boot();
    const ownerId = sql<{ id: string }>(m, "SELECT id FROM user WHERE role = 'owner'")[0]!.id;
    expect(() => m.users.setUserRole(ownerId, "member")).toThrow(/owner cannot be demoted/);
    expect(() => m.users.removeUser(ownerId)).toThrow(/owner cannot be removed/);
    const anaId = await addUser(m, "ana@atrium.test", "member", "ana-password-long-1");
    expect(() => m.users.setUserRole(anaId, "owner")).toThrow(/Transfer ownership/);

    const c = new Client(m.handle);
    await signIn(m, c, OWNER.email, OWNER.password);
    await expect(m.manage.transferOwnershipAs(c.headers(), anaId)).rejects.toMatchObject({ code: "step_up_required" });
    expect(sql(m, "SELECT id FROM user WHERE role = 'owner'")).toEqual([{ id: ownerId }]);

    await m.stepUp.stepUpWithPassword(c.headers(), OWNER.password);
    await m.manage.transferOwnershipAs(c.headers(), anaId);
    expect(sql(m, "SELECT id, role FROM user ORDER BY role")).toEqual(
      expect.arrayContaining([
        { id: anaId, role: "owner" },
        { id: ownerId, role: "member" },
      ]),
    );
    expect(sql(m, "SELECT id FROM user WHERE role = 'owner'")).toHaveLength(1);
  });

  it("a viewer or member cannot manage users or the allowlist (403, criterion 30 for users and allowlist)", async () => {
    const m = await boot();
    await addUser(m, "vee@atrium.test", "viewer", "viewer-password-long");
    const v = new Client(m.handle, "203.0.113.42");
    await signIn(m, v, "vee@atrium.test", "viewer-password-long");
    await expect(m.manage.addPatternAs(v.headers(), "*@x.test", "member")).rejects.toMatchObject({ status: 403 });
    await expect(m.manage.loadUsersPage(v.headers())).rejects.toMatchObject({ status: 403 });
    await expect(m.session.requireScopeFrom(v.headers(), "atrium:edit")).rejects.toMatchObject({ status: 403 });
    await expect(m.session.requireScopeFrom(new Headers(), "atrium:read")).rejects.toMatchObject({ status: 401 });
  });
});

describe("step-up", () => {
  it("TOTP user: the operation fails without step-up and passes with a code; 9 minutes ok, 11 prompts (criteria 23, 24)", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    await signIn(m, c, OWNER.email, OWNER.password);
    const { secret } = await enrolTotp(m, c, OWNER.password);
    await expect(m.session.requireStepUpFrom(c.headers())).rejects.toMatchObject({ code: "step_up_required", method: "totp" });
    await expect(m.stepUp.stepUpWithTotp(c.headers(), "12345")).rejects.toMatchObject({ code: "invalid_code" });
    // Use the next time step so the enrolment code is not replayed.
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now() + 30_000;
    vi.setSystemTime(t0);
    await m.stepUp.stepUpWithTotp(c.headers(), totp(secret, t0));
    await expect(m.session.requireStepUpFrom(c.headers())).resolves.toBeTruthy();
    vi.setSystemTime(t0 + 9 * 60_000);
    await expect(m.session.requireStepUpFrom(c.headers())).resolves.toBeTruthy();
    vi.setSystemTime(t0 + 11 * 60_000);
    await expect(m.session.requireStepUpFrom(c.headers())).rejects.toMatchObject({ code: "step_up_required" });
  });

  it("provider-only user: a fresh provider sign-in covers the new session (criterion 23, OIDC path)", async () => {
    const m = await boot({ ATRIUM_OWNER_PASSWORD: undefined });
    const c = new Client(m.handle);
    await oidcSignIn(m, c, { sub: "owner-sub", email: OWNER.email, email_verified: true });
    await expect(m.session.requireStepUpFrom(c.headers())).rejects.toMatchObject({ method: "provider" });
    const { url, setCookies } = await m.stepUp.startProviderStepUp(c.headers(), "/settings");
    const u = new URL(url);
    expect(u.origin).toBe(IDP);
    expect(u.searchParams.get("max_age")).toBe("0");
    expect(u.searchParams.get("prompt")).toBe("login");
    c.absorb(new Response(null, { headers: setCookies.map((s) => ["set-cookie", s] as [string, string]) }));
    idp.profile = { sub: "owner-sub", email: OWNER.email, email_verified: true };
    const cb = await c.get(`/api/auth/callback/oidc?code=fresh&state=${encodeURIComponent(u.searchParams.get("state")!)}`);
    expect(cb.status).toBe(302);
    const next = await m.stepUp.finishProviderStepUp(c.headers(), c.jar.get("atrium.step_up"));
    expect(next).toBe("/settings");
    await expect(m.session.requireStepUpFrom(c.headers())).resolves.toBeTruthy();
    // Without the ticket (cancelled or forged), no step-up.
    const d = new Client(m.handle, "203.0.113.60");
    await oidcSignIn(m, d, { sub: "owner-sub", email: OWNER.email, email_verified: true });
    await expect(m.stepUp.finishProviderStepUp(d.headers(), "forged.ticket")).rejects.toMatchObject({ status: 403 });
    await expect(m.session.requireStepUpFrom(d.headers())).rejects.toMatchObject({ code: "step_up_required" });
  });
});

describe("rate limits", () => {
  it("the 6th sign-in from one IP in a minute gets 429 + Retry-After without checking the password (criterion 27)", async () => {
    const m = await boot();
    const c = new Client(m.handle, "192.0.2.1");
    for (let i = 0; i < 5; i++) expect((await signIn(m, c, OWNER.email, "wrong-password-xx")).status).toBe(401);
    // The correct password would succeed if it were evaluated.
    const res = await signIn(m, c, OWNER.email, OWNER.password);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/^Too many attempts\. Try again in \d+ minutes\.$/);
    expect(c.jar.has("atrium.session")).toBe(false);
  });

  it("the 11th sign-in for one account in an hour gets 429 (criterion 27)", async () => {
    const m = await boot();
    for (let i = 0; i < 10; i++) await signIn(m, new Client(m.handle, `192.0.2.${10 + i}`), OWNER.email, "wrong-password-xx");
    const c = new Client(m.handle, "192.0.2.99");
    const res = await signIn(m, c, OWNER.email, OWNER.password);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(c.jar.has("atrium.session")).toBe(false);
  });

  it("the 6th TOTP attempt within 5 minutes gets 429 without checking the code (criterion 28)", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    await signIn(m, c, OWNER.email, OWNER.password);
    const { secret } = await enrolTotp(m, c, OWNER.password);
    clearLimits(m);
    const d = new Client(m.handle, "192.0.2.200");
    await signIn(m, d, OWNER.email, OWNER.password);
    const wrong = totp(secret) === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect((await d.post("/api/auth/two-factor/verify-totp", { code: wrong })).status).toBe(401);
    // 5th attempt is allowed and fails; the 6th is refused before the code is checked, even if correct.
    expect((await d.post("/api/auth/two-factor/verify-totp", { code: wrong })).status).not.toBe(429);
    const res = await d.post("/api/auth/two-factor/verify-totp", { code: totp(secret) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await m.session.sessionFromHeaders(d.headers())).toBeNull();
  });

  it("the 121st MCP request with one token in a minute gets 429 + Retry-After (criterion 29)", async () => {
    const m = await boot();
    const ownerId = sql<{ id: string }>(m, "SELECT id FROM user")[0]!.id;
    m.session.registerAgentTokenResolver(async () => ({ tokenId: "tok-mcp", userId: ownerId, agentName: "a", scopes: ["atrium:read"], via: "pat", createdAt: new Date() }));
    const h = new Headers({ authorization: "Bearer atr_pat_whatever" });
    for (let i = 0; i < 120; i++) await m.session.principalFromHeaders(h);
    await expect(m.session.principalFromHeaders(h)).rejects.toMatchObject({ status: 429, retryAfterSec: expect.any(Number) });
    const { errorResponse } = await import("@/core/errors");
    const res = await m.session.principalFromHeaders(h).catch(errorResponse);
    expect((res as Response).headers.get("Retry-After")).toBeTruthy();
  });
});

describe("tokens and MCP", () => {
  it("a new PAT has the documented format and only its SHA-256 hash is meant for storage (criterion 34, auth part)", async () => {
    const m = await boot();
    const { token, hash } = m.tokens.createPersonalAccessToken();
    expect(token).toMatch(/^atr_pat_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(m.tokens.hashPersonalAccessToken(token));
    expect(hash).not.toContain(token.slice(8));
  });

  it("an MCP 401 points at the protected resource metadata (criterion 33, auth part)", async () => {
    const m = await boot();
    const res = m.tokens.mcpUnauthorized();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
    // No resolver match (unknown, revoked or expired token): no principal.
    m.session.registerAgentTokenResolver(async () => null);
    expect(await m.session.principalFromHeaders(new Headers({ authorization: "Bearer atr_pat_revoked" }))).toBeNull();
  });
});

describe("route handlers refuse unauthenticated calls with the front gate bypassed (criterion 26)", () => {
  it("every auth-owned route handler and action answers 401 or refuses without a session", async () => {
    const m = await boot();
    const stepUp = await import("@/app/api/auth/atrium/step-up/route");
    const provider = await import("@/app/api/auth/atrium/step-up/provider/route");
    const req = (method: string, body?: unknown) =>
      new Request(`${PUBLIC_URL}/api/auth/atrium/step-up`, { method, headers: { "content-type": "application/json", origin: PUBLIC_URL }, body: body ? JSON.stringify(body) : undefined });
    expect((await stepUp.GET(req("GET"))).status).toBe(401);
    expect((await stepUp.POST(req("POST", { method: "totp", code: "123456" }))).status).toBe(401);
    expect((await provider.POST(req("POST", {}))).status).toBe(401);
    for (const fn of [
      () => m.manage.loadUsersPage(new Headers()),
      () => m.manage.addPatternAs(new Headers(), "*@x.test", "viewer"),
      () => m.manage.removePatternAs(new Headers(), "x"),
      () => m.manage.changeRoleAs(new Headers(), "x", "viewer"),
      () => m.manage.removeUserAs(new Headers(), "x"),
      () => m.manage.transferOwnershipAs(new Headers(), "x"),
      () => m.stepUp.stepUpWithTotp(new Headers(), "123456"),
      () => m.stepUp.stepUpWithPassword(new Headers(), "x"),
      () => m.stepUp.finishProviderStepUp(new Headers(), undefined),
    ]) {
      await expect(fn()).rejects.toMatchObject({ status: 401 });
    }
    // Better Auth's own session endpoints refuse too.
    await expect(m.manage.listMySessions(new Headers())).rejects.toMatchObject({ status: 401 });
    await expect(m.manage.signOutOtherSessions(new Headers())).rejects.toMatchObject({ status: 401 });
    expect((await new Client(m.handle).post("/api/auth/revoke-other-sessions", {})).status).toBe(401);
    expect((await new Client(m.handle).post("/api/auth/two-factor/enable", { password: "x" })).status).toBe(401);
  });
});

describe("logs carry no secrets (criterion 41)", () => {
  it("sign-in, TOTP, token creation and a secret save log no password, cookie, bearer or secret value", async () => {
    const lines: string[] = [];
    const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    const spies = [vi.spyOn(console, "log").mockImplementation(push), vi.spyOn(console, "error").mockImplementation(push), vi.spyOn(console, "warn").mockImplementation(push), vi.spyOn(console, "info").mockImplementation(push)];
    const m = await boot();
    const c = new Client(m.handle);
    await signIn(m, c, OWNER.email, "a-wrong-password-1");
    await signIn(m, c, OWNER.email, OWNER.password);
    const { secret, backupCodes } = await enrolTotp(m, c, OWNER.password);
    const { token } = m.tokens.createPersonalAccessToken();
    const vault = await import("@/features/vault");
    vault.seal({ ownerType: "integration", ownerId: "i1", key: "apiKey" }, "vault-secret-value-777");
    await m.stepUp.stepUpWithTotp(c.headers(), totp(secret, Date.now() + 30_000)).catch(() => undefined);
    for (const s of spies) s.mockRestore();
    const all = lines.join("\n");
    const cookie = c.jar.get("atrium.session")!;
    for (const needle of [OWNER.password, "a-wrong-password-1", cookie, cookie.split(".")[0]!, token, secret, ...backupCodes, "vault-secret-value-777", "mock-oidc-client-value", "unit-test-auth-secret"]) {
      expect(all.includes(needle), `log contains ${needle.slice(0, 6)}...`).toBe(false);
    }
  });
});
