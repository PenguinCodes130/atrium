import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { Client, freshDataDir, setEnv, PUBLIC_URL } from "./test/harness";
import { stampValue } from "./server/peer";

// Auth round 2 (Fix List in stages/04-gauntlet/output/auth-gauntlet-r1.md). Items 1 to 3 each replay
// the security critic's exploit (app/evidence/gauntlet/r1/security/*.txt) and expect a safe failure.

const OWNER = { email: "owner@atrium.test", password: "unit-owner-password-123" };
const REDIRECT = "http://127.0.0.1:7777/callback";
const APP_ROOT = path.resolve(__dirname, "../../..");

async function boot(env: Record<string, string | undefined> = {}, dir = freshDataDir()) {
  setEnv({ ATRIUM_DATA_DIR: dir, ATRIUM_OWNER_EMAIL: OWNER.email, ATRIUM_OWNER_PASSWORD: OWNER.password, ...env });
  vi.resetModules();
  const handler = await import("./server/handler");
  const m = {
    dir,
    handle: handler.handleAuthRequest,
    bootstrap: await import("./server/bootstrap"),
    session: await import("./server/session"),
    users: await import("./server/users"),
    allowlist: await import("./server/allowlist"),
    stepUp: await import("./server/step-up"),
    banners: await import("./server/banners"),
    oauth: await import("./server/oauth"),
    recovery: await import("./server/recovery"),
    authMod: await import("./server/auth"),
    proxy: (await import("@/proxy")).proxy,
    db: await import("@/core/db"),
  };
  await m.bootstrap.ensureBootstrapped();
  return m;
}
type M = Awaited<ReturnType<typeof boot>>;

const sql = <T = Record<string, unknown>>(m: M, q: string, ...args: unknown[]) => m.db.sqlite().prepare(q).all(...args) as T[];
const signIn = (c: Client, email = OWNER.email, password = OWNER.password) => c.post("/api/auth/sign-in/email", { email, password });

async function addUser(m: M, email: string, role: "member" | "viewer", password: string) {
  const id = randomUUID();
  const now = Date.now();
  m.db.sqlite().prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, email, email, 1, role, 0, now, now);
  const hash = await m.authMod.hashPassword(password);
  m.db.sqlite().prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, hash, now, now);
  m.allowlist.addAllowlistPattern(email, role);
  return id;
}

// The first boot compiles the proxy and Next server modules; give every test room under load.
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.useRealTimers();
});

// ---- Fix 1: CSRF ----------------------------------------------------------------------------------

describe("fix 1: the CSRF check holds when a session cookie rides with a bearer header", () => {
  const req = (headers: Record<string, string>) =>
    new NextRequest(new URL("/api/integrations/detect", PUBLIC_URL), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ url: "http://10.77.99.7:9090" }) });

  it("replays csrf-bearer-exemption.txt: foreign Origin + session cookie + junk bearer is refused 403 bad_origin", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    await signIn(c);
    const cookie = c.cookieHeader();
    const without = await m.proxy(req({ origin: "https://evil.example", cookie }));
    expect(without.status).toBe(403);
    const withBearer = await m.proxy(req({ origin: "https://evil.example", cookie, authorization: "Bearer x" }));
    expect(withBearer.status).toBe(403);
    expect(((await withBearer.json()) as { error: { code: string } }).error.code).toBe("bad_origin");
    // Same with no Origin at all, and with a foreign Referer.
    expect((await m.proxy(req({ cookie, authorization: "Bearer x" }))).status).toBe(403);
    expect((await m.proxy(req({ referer: "https://evil.example/x", cookie, authorization: "Bearer x" }))).status).toBe(403);
    // The same-origin request still passes the gate.
    expect((await m.proxy(req({ origin: PUBLIC_URL, cookie, authorization: "Bearer x" }))).status).toBe(200);
  });

  it("a pure bearer call with no cookie skips only the Origin check, and still needs a valid token", async () => {
    const m = await boot();
    const res = await m.proxy(req({ origin: "https://evil.example", authorization: "Bearer x" }));
    expect(res.status).toBe(401); // past the CSRF gate, refused for having no session or valid token
  });

  it("OAuth clients reach the token endpoint without an Origin header when they send no cookie", async () => {
    const m = await boot();
    const res = await m.proxy(new NextRequest(new URL("/api/auth/oauth2/token", PUBLIC_URL), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" }));
    expect(res.status).toBe(200); // NextResponse.next(): handed on to the route
    const cookie = await (async () => {
      const c = new Client(m.handle);
      await signIn(c);
      return c.cookieHeader();
    })();
    const withCookie = await m.proxy(new NextRequest(new URL("/api/auth/oauth2/token", PUBLIC_URL), { method: "POST", headers: { cookie, origin: "https://evil.example" }, body: "x" }));
    expect(withCookie.status).toBe(403);
  });
});

// ---- Fix 2: per-IP limit and X-Forwarded-For -------------------------------------------------------

describe("fix 2: the per-IP sign-in limit cannot be escaped by rotating X-Forwarded-For", () => {
  it("replays xff-rate-limit-bypass.txt: a direct client rotating the header stays limited on its socket address", async () => {
    const m = await boot();
    const c = new Client(m.handle, "203.0.113.50");
    for (let i = 0; i < 5; i++) {
      c.extra = { "x-forwarded-for": "203.0.113.7" };
      expect((await signIn(c, "stranger@example.org", "whatever-password-1")).status).toBe(403); // not allowlisted
    }
    c.extra = { "x-forwarded-for": "203.0.113.7" };
    expect((await signIn(c, "stranger@example.org", "whatever-password-1")).status).toBe(429);
    for (const forged of ["203.0.113.8", "198.51.100.1", "10.0.0.1, 203.0.113.9"]) {
      c.extra = { "x-forwarded-for": forged };
      const r = await signIn(c, "stranger@example.org", "whatever-password-1");
      expect(r.status, forged).toBe(429);
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });

  it("behind a trusted proxy, each forwarded client gets its own bucket (default deployment behind NPM)", async () => {
    const m = await boot({ ATRIUM_TRUSTED_PROXIES: "10.77.99.6" });
    const npm = new Client(m.handle, "10.77.99.6");
    npm.extra = { "x-forwarded-for": "198.51.100.7" };
    for (let i = 0; i < 5; i++) await signIn(npm, "stranger@example.org", "whatever-password-1");
    expect((await signIn(npm, "stranger@example.org", "whatever-password-1")).status).toBe(429);
    npm.extra = { "x-forwarded-for": "198.51.100.8" };
    expect((await signIn(npm, "stranger@example.org", "whatever-password-1")).status).toBe(403);
    // A client that prepends its own entry is still keyed on the address the proxy appended.
    npm.extra = { "x-forwarded-for": "1.1.1.1, 198.51.100.7" };
    expect((await signIn(npm, "stranger@example.org", "whatever-password-1")).status).toBe(429);
  });

  it("with no usable peer address (missing or forged stamp) every caller shares the global floor", async () => {
    const m = await boot();
    const call = (stamp: string | null, i: number) =>
      m.handle(
        new Request(`${PUBLIC_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: PUBLIC_URL, "x-forwarded-for": `198.51.100.${i}`, ...(stamp ? { "x-atrium-peer": stamp } : {}) },
          body: JSON.stringify({ email: `stranger${i}@example.org`, password: "whatever-password-1" }),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call(i % 2 ? `198.51.100.${i};forged-mac` : null, i)).status);
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // A real peer is not caught by the floor.
    expect((await signIn(new Client(m.handle, "203.0.113.90"), "stranger@example.org", "whatever-password-1")).status).toBe(403);
  });

  it("the peer stamp overwrites a client-sent x-atrium-peer on the real Node HTTP server", async () => {
    const m = await boot();
    const http = await import("node:http");
    const { verifiedPeer, PEER_HEADER } = await import("./server/peer");
    const seen: (string | null)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(verifiedPeer(new Headers(req.headers as Record<string, string>)));
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    for (const forged of [undefined, "203.0.113.7;forged", stampValue("203.0.113.7").replace("203.0.113.7", "203.0.113.8")]) {
      await fetch(`http://127.0.0.1:${port}/`, { headers: forged ? { [PEER_HEADER]: forged, "x-forwarded-for": "203.0.113.7" } : {} });
    }
    server.close();
    expect(seen).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.1"]);
    expect(m).toBeTruthy();
  });
});

// ---- Fix 3: verify-password and other password checks ---------------------------------------------

describe("fix 3: every password-checking endpoint is behind the per-account limit", () => {
  it("replays verify-password-no-limit.txt: the 11th attempt is 429, even with the right password", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    expect((await signIn(c)).status).toBe(200); // counts 1 of 10 for this account
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await c.post("/api/auth/verify-password", { password: `wrong-password-${i}x` })).status);
    expect(statuses.every((s) => s === 400)).toBe(true);
    const limited = await c.post("/api/auth/verify-password", { password: OWNER.password });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("change-password, two-factor enable/disable, backup codes and the TOTP URI share that limit", async () => {
    const m = await boot();
    const c = new Client(m.handle);
    await signIn(c);
    m.db.sqlite().prepare("DELETE FROM auth_rate_limit").run();
    const paths = ["/api/auth/change-password", "/api/auth/two-factor/enable", "/api/auth/two-factor/disable", "/api/auth/two-factor/generate-backup-codes", "/api/auth/two-factor/get-totp-uri"];
    for (let i = 0; i < 10; i++) await c.post(paths[i % paths.length]!, { password: "wrong-password-xx", currentPassword: "wrong-password-xx", newPassword: "another-long-password-1" });
    for (const p of paths) expect((await c.post(p, { password: OWNER.password, currentPassword: OWNER.password, newPassword: "another-long-password-1" })).status, p).toBe(429);
  });
});

// ---- Fix 4: owner recovery ------------------------------------------------------------------------

describe("fix 4: owner recovery from the server", () => {
  it("ATRIUM_RESET_OWNER_PASSWORD applies once: new password works, every session ends, audited, banner, ignored after", async () => {
    const dir = freshDataDir();
    let m = await boot({}, dir);
    const a = new Client(m.handle);
    const b = new Client(m.handle, "203.0.113.61");
    await signIn(a);
    const memberId = await addUser(m, "ana@atrium.test", "member", "ana-member-password-1");
    await signIn(b, "ana@atrium.test", "ana-member-password-1");
    expect(sql(m, "SELECT id FROM session")).toHaveLength(2);

    m = await boot({ ATRIUM_OWNER_PASSWORD: undefined, ATRIUM_RESET_OWNER_PASSWORD: "recovered-owner-password-9" }, dir);
    expect(sql(m, "SELECT id FROM session")).toHaveLength(0); // all users' sessions, the member's too
    expect((await m.session.sessionFromHeaders(a.headers()))).toBeNull();
    expect((await signIn(new Client(m.handle, "203.0.113.62"))).status).toBe(401);
    expect((await signIn(new Client(m.handle, "203.0.113.63"), OWNER.email, "recovered-owner-password-9")).status).toBe(200);
    const audit = readFileSync(path.join(dir, "audit-auth.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ event: "auth.owner_password_reset", result: "ok", detail: { source: "env", sessionsRevoked: 2 } });
    expect(JSON.stringify(audit)).not.toContain("recovered-owner-password-9");
    expect((await m.banners.getAuthBanners()).map((x) => x.id)).toContain("owner-reset-var");
    expect(memberId).toBeTruthy();

    // The owner changes the password; a restart with the same variable must not undo that.
    const s = new Client(m.handle, "203.0.113.64");
    await signIn(s, OWNER.email, "recovered-owner-password-9");
    expect((await s.post("/api/auth/change-password", { currentPassword: "recovered-owner-password-9", newPassword: "owner-chose-this-password-2" })).status).toBe(200);
    // Also when BETTER_AUTH_SECRET changed between restarts (found on the real server in round 2).
    m = await boot({ ATRIUM_OWNER_PASSWORD: undefined, ATRIUM_RESET_OWNER_PASSWORD: "recovered-owner-password-9", BETTER_AUTH_SECRET: "a-rotated-unit-test-auth-secret-not-real-111" }, dir);
    expect(await m.recovery.applyOwnerResetFromEnv("recovered-owner-password-9")).toBe("already-used");
    expect(readFileSync(path.join(dir, "audit-auth.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(path.join(dir, "owner-reset.json"), "utf8")).not.toContain("recovered-owner-password-9");
    expect((await signIn(new Client(m.handle, "203.0.113.65"), OWNER.email, "owner-chose-this-password-2")).status).toBe(200);
  });

  it("a weak reset password is refused and changes nothing; a provider-only owner gets a password", async () => {
    const dir = freshDataDir();
    let m = await boot({ ATRIUM_OWNER_PASSWORD: undefined }, dir);
    expect(sql(m, "SELECT id FROM account")).toHaveLength(0);
    m = await boot({ ATRIUM_OWNER_PASSWORD: undefined, ATRIUM_RESET_OWNER_PASSWORD: "short" }, dir);
    expect(sql(m, "SELECT id FROM account")).toHaveLength(0);
    expect(existsSync(path.join(dir, "owner-reset.json"))).toBe(false);
    await expect(m.recovery.resetOwnerPassword("short-pass", "cli")).rejects.toMatchObject({ code: "weak_password" });
    await m.recovery.resetOwnerPassword("a-fresh-owner-password-3", "cli");
    expect((await signIn(new Client(m.handle), OWNER.email, "a-fresh-owner-password-3")).status).toBe(200);
  });

  it("the CLI resets the owner from the server's own shell (password read from stdin, never argv)", async () => {
    const dir = freshDataDir();
    let m = await boot({}, dir);
    await signIn(new Client(m.handle));
    const out = execFileSync("pnpm", ["exec", "tsx", "--conditions=react-server", "src/features/auth/cli/reset-owner.ts"], {
      cwd: APP_ROOT,
      env: { ...process.env, ATRIUM_DATA_DIR: dir },
      input: "cli-recovered-password-4\n",
      encoding: "utf8",
    });
    expect(out).toContain(`The owner ${OWNER.email} can sign in with the new password. Signed out 1 session.`);
    m = await boot({ ATRIUM_OWNER_PASSWORD: undefined }, dir);
    expect((await signIn(new Client(m.handle), OWNER.email, "cli-recovered-password-4")).status).toBe(200);
    expect(readFileSync(path.join(dir, "audit-auth.jsonl"), "utf8")).toContain('"source":"cli"');
  }, 60_000);
});

// ---- Fix 6: MCP OAuth (auth half) -------------------------------------------------------------------

async function register(m: M, name = "Test Agent") {
  const res = await new Client(m.handle, "203.0.113.70").post("/api/auth/oauth2/register", {
    client_name: name,
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(clientId: string, scope: string, challenge?: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, state: "st-1", resource: `${PUBLIC_URL}/mcp` });
  if (challenge) {
    q.set("code_challenge", challenge);
    q.set("code_challenge_method", "S256");
  }
  return `/api/auth/oauth2/authorize?${q}`;
}

/** Runs authorize, sign-in and consent for `c`; returns the consent response. */
async function consentFor(m: M, c: Client, clientId: string, scope: string, challenge: string, email = OWNER.email, password = OWNER.password) {
  const a = await c.get(authorizeUrl(clientId, scope, challenge));
  expect(a.status).toBe(302);
  const login = new URL(a.headers.get("location")!, PUBLIC_URL);
  expect(login.pathname).toBe("/sign-in");
  const s = await c.post("/api/auth/sign-in/email", { email, password, oauth_query: login.search.slice(1) });
  if (s.status !== 200) return { signIn: s };
  const consentUrl = new URL(((await s.json()) as { url: string }).url, PUBLIC_URL);
  expect(consentUrl.pathname).toBe("/consent");
  const details = await m.oauth.consentDetails(consentUrl.searchParams);
  const consent = () => c.post("/api/auth/oauth2/consent", { accept: true, oauth_query: consentUrl.search.slice(1) });
  return { details, consent, consentUrl };
}

async function exchange(m: M, clientId: string, code: string, verifier: string) {
  return m.handle(
    new Request(`${PUBLIC_URL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${PUBLIC_URL}/mcp` }),
    }),
  );
}

describe("fix 6: MCP OAuth through @better-auth/oauth-provider (criterion 35)", () => {
  it("dynamic registration, PKCE authorization, consent with client name and scopes, token issued and validated", async () => {
    const m = await boot();
    const clientId = await register(m, "Claude Desktop");
    const { verifier, challenge } = pkce();
    const c = new Client(m.handle);
    const flow = await consentFor(m, c, clientId, "atrium:read atrium:edit offline_access", challenge);
    expect(flow.details).toMatchObject({ clientName: "Claude Desktop", scopes: ["atrium:read", "atrium:edit", "offline_access"] });
    const res = await flow.consent!();
    expect(res.status).toBe(200);
    const back = new URL(((await res.json()) as { url: string }).url);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    const tok = await exchange(m, clientId, back.searchParams.get("code")!, verifier);
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token?: string; scope: string; expires_in: number };
    expect(t.access_token.startsWith("atr_oat_")).toBe(true);
    expect(t.refresh_token?.startsWith("atr_ort_")).toBe(true);
    expect(t.expires_in).toBe(3600);
    // The database holds only a hash of the token.
    expect(JSON.stringify(sql(m, "SELECT * FROM oauth_access_token"))).not.toContain(t.access_token.slice(8));
    const bearer = new Headers({ authorization: `Bearer ${t.access_token}` });
    expect(await m.session.principalFromHeaders(bearer)).toMatchObject({ kind: "agent", via: "mcp-oauth", agentName: "Claude Desktop", role: "owner", scopes: ["atrium:read", "atrium:edit"] });
    await expect(m.session.requireScopeFrom(bearer, "atrium:edit")).resolves.toBeTruthy();
    await expect(m.session.requireScopeFrom(bearer, "atrium:propose")).rejects.toMatchObject({ status: 403 });
    // Codes are single use; a wrong PKCE verifier fails.
    expect((await exchange(m, clientId, back.searchParams.get("code")!, verifier)).status).toBe(400);
    // Unknown, expired and revoked tokens give no principal.
    expect(await m.session.principalFromHeaders(new Headers({ authorization: "Bearer atr_oat_unknown" }))).toBeNull();
    m.db.sqlite().prepare("UPDATE oauth_access_token SET expires_at = ?").run(Date.now() - 1000);
    expect(await m.session.principalFromHeaders(bearer)).toBeNull();
  });

  it("PKCE is required and the verifier must match", async () => {
    const m = await boot();
    const clientId = await register(m);
    const c = new Client(m.handle);
    await signIn(c);
    const noPkce = await c.get(authorizeUrl(clientId, "atrium:read"));
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const { challenge } = pkce();
    const flow = await consentFor(m, new Client(m.handle, "203.0.113.71"), clientId, "atrium:read", challenge);
    const code = new URL(((await (await flow.consent!()).json()) as { url: string }).url).searchParams.get("code")!;
    expect((await exchange(m, clientId, code, pkce().verifier)).status).toBe(400);
  });

  it("an email not on the allowlist is refused at the OAuth sign-in, and at authorize once removed", async () => {
    const m = await boot();
    const clientId = await register(m);
    const { challenge } = pkce();
    // A user with a password whose email no pattern admits.
    const id = randomUUID();
    const now = Date.now();
    m.db.sqlite().prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, "x", "outsider@example.org", 1, "viewer", 0, now, now);
    m.db.sqlite().prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, await m.authMod.hashPassword("outsider-password-1"), now, now);
    const out = await consentFor(m, new Client(m.handle, "203.0.113.72"), clientId, "atrium:read", challenge, "outsider@example.org", "outsider-password-1");
    expect(out.signIn?.status).toBe(403);
    expect(sql(m, "SELECT id FROM session WHERE user_id = ?", id)).toHaveLength(0);
    // A member signed in, then taken off the allowlist (still a user): authorize is refused.
    await addUser(m, "ana@atrium.test", "member", "ana-member-password-1");
    const ana = new Client(m.handle, "203.0.113.73");
    await signIn(ana, "ana@atrium.test", "ana-member-password-1");
    m.db.sqlite().prepare("DELETE FROM allowlist WHERE pattern = ?").run("ana@atrium.test");
    const refused = await ana.get(authorizeUrl(clientId, "atrium:read", challenge));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("not_allowlisted");
  });

  it("granting atrium:propose needs a step-up; with one the token carries the scope (criterion 23 for consent)", async () => {
    const m = await boot();
    const clientId = await register(m);
    const { verifier, challenge } = pkce();
    const c = new Client(m.handle);
    const flow = await consentFor(m, c, clientId, "atrium:read atrium:propose", challenge);
    expect(flow.details?.scopes).toEqual(["atrium:read", "atrium:propose"]);
    const first = await flow.consent!();
    expect(first.status).toBe(403);
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe("step_up_required");
    expect(sql(m, "SELECT id FROM oauth_consent")).toHaveLength(0);
    // A denial needs no step-up and grants nothing.
    const deny = await c.post("/api/auth/oauth2/consent", { accept: false, oauth_query: flow.consentUrl!.search.slice(1) });
    expect(new URL(((await deny.json()) as { url: string }).url).searchParams.get("error")).toBe("access_denied");
    await m.stepUp.stepUpWithPassword(c.headers(), OWNER.password);
    const second = await flow.consent!();
    expect(second.status).toBe(200);
    const code = new URL(((await second.json()) as { url: string }).url).searchParams.get("code")!;
    const t = (await (await exchange(m, clientId, code, verifier)).json()) as { access_token: string };
    expect(await m.session.principalFromHeaders(new Headers({ authorization: `Bearer ${t.access_token}` }))).toMatchObject({ kind: "agent", scopes: ["atrium:read", "atrium:propose"] });
  });

  it("demoting the user cuts their OAuth tokens on the next request (criterion 17 for MCP OAuth)", async () => {
    const m = await boot();
    const anaId = await addUser(m, "ana@atrium.test", "member", "ana-member-password-1");
    const clientId = await register(m);
    const { verifier, challenge } = pkce();
    const flow = await consentFor(m, new Client(m.handle, "203.0.113.74"), clientId, "atrium:read atrium:edit", challenge, "ana@atrium.test", "ana-member-password-1");
    const code = new URL(((await (await flow.consent!()).json()) as { url: string }).url).searchParams.get("code")!;
    const t = (await (await exchange(m, clientId, code, verifier)).json()) as { access_token: string };
    const bearer = new Headers({ authorization: `Bearer ${t.access_token}` });
    expect((await m.session.principalFromHeaders(bearer))?.role).toBe("member");
    await new Promise((r) => setTimeout(r, 5));
    m.users.setUserRole(anaId, "viewer");
    expect(await m.session.principalFromHeaders(bearer)).toBeNull();
  });

  it("a forged or expired consent request shows nothing and cannot be accepted", async () => {
    const m = await boot();
    const clientId = await register(m);
    const forged = new URLSearchParams({ client_id: clientId, scope: "atrium:propose", redirect_uri: REDIRECT, response_type: "code", exp: String(Math.floor(Date.now() / 1000) + 600), sig: "forged" });
    expect(await m.oauth.consentDetails(forged)).toBeNull();
    const c = new Client(m.handle);
    await signIn(c);
    const res = await c.post("/api/auth/oauth2/consent", { accept: true, oauth_query: forged.toString() });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("serves authorization server metadata (code + S256 PKCE, registration, Atrium's scopes) for agent-api to link", async () => {
    const m = await boot();
    const res = await new Client(m.handle).get("/api/auth/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: `${PUBLIC_URL}/api/auth`,
      authorization_endpoint: `${PUBLIC_URL}/api/auth/oauth2/authorize`,
      token_endpoint: `${PUBLIC_URL}/api/auth/oauth2/token`,
      registration_endpoint: `${PUBLIC_URL}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    });
    expect(meta.scopes_supported).toEqual(["atrium:read", "atrium:edit", "atrium:propose", "offline_access"]);
    expect(meta.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(m.oauth).toBeTruthy();
  });

  it("dynamic client registration is capped per address", async () => {
    const m = await boot();
    const c = new Client(m.handle, "203.0.113.75");
    const body = { client_name: "Spam", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] };
    for (let i = 0; i < 20; i++) expect((await c.post("/api/auth/oauth2/register", body)).status).toBe(201);
    expect((await c.post("/api/auth/oauth2/register", body)).status).toBe(429);
  });
});
