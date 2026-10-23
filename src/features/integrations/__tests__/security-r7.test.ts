// Gauntlet r3 closing re-check, security item 4 (M1), integrations round 7. host.fetch resolved
// secrets for the integration's BASE origin, while the endpoint path could resolve to another
// origin: `/\\host:B/x` passed the path guard (scheme prefix and leading `//` only), WHATWG URL
// parsing turned the backslashes into `//`, and `allowedHosts` compared hostnames only. So a value
// locked to host:A could reach host:B (same hostname, other port).
// These tests drive the real route handlers (create, add endpoint, test, data read) and the real
// host fetch against local stand-ins on fixed ports: A (3150, where the credential is locked), B
// (3151, same hostname, other port) and B6 ([::1]:3152, when IPv6 loopback exists). Every attempt
// must be refused, at save time (400) or at send time (permission), and B must see 0 connections.
// Saved credentials, an integration's own sealed secrets and held curl secrets are all covered.
// Outcomes go to evidence/integrations/r7/security/path-origin-<phase>.jsonl with the token
// replaced by a label. Test-only secret values; none are real.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";

setupTestDb();

type User = Extract<Principal, { kind: "user" }>;
const owner: User = { kind: "user", userId: "u-owner", role: "owner", via: "session" };

vi.mock("@/features/auth", async (orig) => {
  const real = await orig<typeof import("@/features/auth")>();
  const session = () => ({ user: { id: owner.userId, role: owner.role, name: "Owner", email: "owner@atrium.test" }, session: { id: "s-owner", stepUpAt: null }, principal: owner });
  return { ...real, requireUser: async () => session(), requireStepUp: async () => { throw new real.StepUpRequired("password"); } };
});

const CRED = "SECPROBE-r7-locked-cred-token";
const HELD = "SECPROBE-r7-held-curl-bearer";
const SECRETS = [CRED, HELD];
const PORT_A = 3150;
const PORT_B = 3151;
const PORT_B6 = 3152;
const A_ORIGIN = `http://127.0.0.1:${PORT_A}`;

const PHASE = process.env.R7_PHASE ?? "after-fix";
const EVIDENCE = path.resolve(__dirname, `../../../../evidence/integrations/r7/security/path-origin-${PHASE}.jsonl`);
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
const redact = (s: string) => s.replaceAll(CRED, "<locked credential token>").replaceAll(HELD, "<held curl bearer>");
const record = (data: unknown) => appendFileSync(EVIDENCE, `${redact(JSON.stringify(data))}\n`);

type Stand = { port: number; seen: { url: string; auth: string }[]; connections: number; server: Server; close: () => Promise<void> };
async function standIn(port: number, host: string): Promise<Stand> {
  const s: Stand = { port, seen: [], connections: 0, server: undefined as unknown as Server, close: async () => undefined };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    s.seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? "") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ v: 1, server: port }));
  });
  server.on("connection", () => { s.connections++; });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve()); });
  s.server = server;
  s.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return s;
}

let A: Stand;
let B: Stand;
let B6: Stand | null = null;
const tokenHits = (s: Stand | null) => (s ? s.seen.filter((r) => SECRETS.some((t) => r.auth.includes(t))).length : 0);
/** Requests plus new connections on the other port (keep-alive can reuse a socket, so both count). */
const otherPortConnections = () => B.connections + B.seen.length + (B6 ? B6.connections + B6.seen.length : 0);

let routes: {
  integrations: typeof import("@/app/api/integrations/route");
  endpoints: typeof import("@/app/api/integrations/[id]/endpoints/route");
  credentials: typeof import("@/app/api/integrations/credentials/route");
  test: typeof import("@/app/api/integrations/test/route");
  data: typeof import("@/app/api/data/endpoint/route");
};
let repo: typeof import("../repo");
let tryIt: typeof import("../try-it");
let pending: typeof import("../host/pending");
let http: typeof import("../host/http");
let secrets: typeof import("../host/secrets");
let runtime: typeof import("../runtime");
let forget: (id: string) => void;

beforeAll(async () => {
  A = await standIn(PORT_A, "127.0.0.1");
  B = await standIn(PORT_B, "127.0.0.1");
  try { B6 = await standIn(PORT_B6, "::1"); } catch { B6 = null; }
  routes = {
    integrations: await import("@/app/api/integrations/route"),
    endpoints: await import("@/app/api/integrations/[id]/endpoints/route"),
    credentials: await import("@/app/api/integrations/credentials/route"),
    test: await import("@/app/api/integrations/test/route"),
    data: await import("@/app/api/data/endpoint/route"),
  };
  repo = await import("../repo");
  tryIt = await import("../try-it");
  pending = await import("../host/pending");
  http = await import("../host/http");
  secrets = await import("../host/secrets");
  runtime = await import("../runtime");
  forget = (await import("@/features/data/runtime")).forgetIntegration;
  record({ phase: PHASE, ipv6StandIn: B6 !== null });
});
afterAll(async () => { await A.close(); await B.close(); await B6?.close(); });
beforeEach(() => { for (const s of [A, B, B6]) if (s) { s.seen.length = 0; s.connections = 0; } });

const req = (method: string, p: string, body?: unknown) => new Request(`http://127.0.0.1:3113${p}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function out(res: Response) {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body: body as Record<string, unknown> & { error?: { code: string; message: string }; id?: string } };
}

// Paths a person can save on a custom endpoint (they start with "/"). `cross` marks the ones that
// resolved to another origin before the fix; every one must now be refused.
const SAVED_VARIANTS: { name: string; path: string; cross: boolean }[] = [
  { name: "critic: two backslashes", path: `/\\\\127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "critic: backslash then slash", path: `/\\/127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "one backslash", path: `/\\127.0.0.1:${PORT_B}/x`, cross: false },
  { name: "slash backslash backslash slash", path: `/\\\\/127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "tab inside the authority marker", path: `/\t\\127.0.0.1:${PORT_B}/x`, cross: false },
  { name: "tab then two slashes", path: `/\t//127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "newline then slash", path: `/\n/127.0.0.1:${PORT_B}/x`, cross: false },
  { name: "NUL byte", path: `/\u0000/127.0.0.1:${PORT_B}/x`, cross: false },
  { name: "DEL byte", path: `/x\u007f`, cross: false },
  { name: "absolute URL after the slash", path: `/http://127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "absolute URL, upper case scheme", path: `/HTTP://127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "absolute URL with backslashes", path: `/http:\\\\127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "different scheme (https) on the other port", path: `/https://127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "different scheme on the same port", path: `/https://127.0.0.1:${PORT_A}/x`, cross: true },
  { name: "userinfo trick", path: `/\\\\user@127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "userinfo naming A", path: `/\\\\127.0.0.1:${PORT_A}@127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "IPv6 loopback", path: `/\\\\[::1]:${PORT_B6}/x`, cross: true },
  { name: "dot segments then two slashes", path: `/..//127.0.0.1:${PORT_B}/x`, cross: false },
  { name: "encoded backslashes", path: `/%5C%5C127.0.0.1:${PORT_B}/x`, cross: false },
  { name: "encoded dots then two slashes", path: `/%2e%2e//127.0.0.1:${PORT_B}/x`, cross: false },
];
// Paths only adapter code could pass (they do not start with "/"): the send-time guard alone.
const HOST_ONLY_VARIANTS: { name: string; path: string; cross: boolean }[] = [
  { name: "leading tab then //", path: `\t//127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "leading space then //", path: ` //127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "bare two backslashes", path: `\\\\127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "bare backslash slash", path: `\\/127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "scheme-relative", path: `//127.0.0.1:${PORT_B}/x`, cross: true },
  { name: "absolute URL", path: `http://127.0.0.1:${PORT_B}/x`, cross: true },
];
/** Paths containing a backslash or a control character must be refused when saved. */
const mustRefuseAtSave = (p: string) => /[\\\u0000-\u001f\u007f]/.test(p);

const endpoint = (id: string, p: string, auth: string) => ({ id, label: id, method: "GET", path: p, auth, fields: [{ path: "$.v", label: "v", role: "value" }], shape: "stat", refreshSec: 30 });

/** Holds a curl bearer for A and returns its pending id and secret key. */
async function holdCurl() {
  const r = await tryIt.runTry({ curl: `curl ${A_ORIGIN}/data -H 'Authorization: Bearer ${HELD}'` }, owner.userId);
  if (!r.ok || !r.pendingId) throw new Error(`curl setup failed: ${JSON.stringify(r)}`);
  const key = pending.pendingFields(r.pendingId, owner.userId)![0]!.key;
  return { pendingId: r.pendingId, key };
}

let cred: { id: string } | null = null;
async function lockedCredential() {
  if (cred) return cred;
  const r = await out(await routes.credentials.POST(req("POST", "/api/integrations/credentials", { name: "R7 token", kind: "token", values: { token: CRED }, server: A_ORIGIN })));
  expect(r.status).toBe(201);
  expect((r.body as { lockedOrigins: string[] }).lockedOrigins).toEqual([A_ORIGIN]);
  cred = r.body as { id: string };
  return cred;
}

let n = 0;
/**
 * Saves a Custom API integration on A whose endpoint uses `p`, with the secret from `source`, and
 * reads it through GET /api/data/endpoint (the saved data endpoint refresh). When the save is
 * refused (the fix), the same record is planted straight into the database, as a record saved by
 * an older build would be, and read again, so the send-time guard is exercised too.
 */
async function savedEndpointAttempt(p: string, source: "credential" | "own-secret") {
  const { pendingId, key } = await holdCurl();
  const credentials = source === "credential" ? { [key]: (await lockedCredential()).id } : {};
  const name = `R7 ${source} ${++n}`;
  const created = await out(await routes.integrations.POST(req("POST", "/api/integrations", { packageId: "custom-api", name, config: { baseUrl: A_ORIGIN }, secrets: {}, pendingId, credentials, untested: true, endpoints: [endpoint("ep", p, key)] })));
  let integrationId = created.body.id as string | undefined;
  let planted = false;
  if (created.status !== 201) {
    const clean = await out(await routes.integrations.POST(req("POST", "/api/integrations", { packageId: "custom-api", name: `${name} clean`, config: { baseUrl: A_ORIGIN }, secrets: {}, pendingId: (await holdCurl()).pendingId, credentials, untested: true })));
    expect(clean.status).toBe(201);
    integrationId = clean.body.id!;
    // The held key differs per paste only by value; the field key is the same ("authorization" style).
    const key2 = repo.getIntegrationRow(integrationId)!.secretFields[0]!.key;
    const viaRoute = await out(await routes.endpoints.POST(req("POST", `/api/integrations/${integrationId}/endpoints`, endpoint("ep", p, key2)), ctx(integrationId)));
    repo.upsertCustomEndpoint(integrationId, endpoint("ep", p, key2) as never);
    forget(integrationId);
    planted = true;
    record({ step: "add endpoint route", source, path: p, status: viaRoute.status, error: viaRoute.body.error });
  }
  const read = await out(await routes.data.GET(req("GET", `/api/data/endpoint?integration=${encodeURIComponent(integrationId!)}&endpoint=ep`)));
  return { save: { status: created.status, error: created.body.error }, planted, read: { status: read.status, state: read.body.state, error: (read.body as { error?: unknown }).error } };
}

/** Test connection before saving, with the held curl secret and the endpoint in the request. */
async function heldTestAttempt(p: string) {
  const { pendingId, key } = await holdCurl();
  const r = await out(await routes.test.POST(req("POST", "/api/integrations/test", { packageId: "custom-api", config: { baseUrl: A_ORIGIN }, secrets: {}, pendingId, customEndpoints: [endpoint("ep", p, key)] })));
  return { status: r.status, ok: r.body.ok, error: r.body.error };
}

/** The real host fetch with the real resolvers, the way runtime builds it for a person-shaped read. */
async function hostAttempt(p: string, source: "credential" | "own-secret" | "held") {
  const manifest = { ...runtime.getPackage("custom-api")!.manifest, secrets: [{ key: "token", label: "Token", hint: "t", auth: { as: "bearer" as const } }], permissions: [{ kind: "network" as const, hosts: "configured" as const }, { kind: "secret" as const, key: "token" }] };
  let resolver: import("../host/secrets").SecretResolver;
  if (source === "credential") resolver = secrets.vaultResolver({ credentialRefs: { token: (await lockedCredential()).id } });
  else if (source === "held") {
    const id = pending.holdSecrets(owner.userId, A_ORIGIN, [{ key: "token", label: "Token", hint: "t", auth: { as: "bearer" }, value: HELD }]);
    resolver = secrets.vaultResolver({ pending: { id, userId: owner.userId } });
  } else {
    // An integration's own sealed secret, pinned to A.
    const { pendingId } = await holdCurl();
    const c = await out(await routes.integrations.POST(req("POST", "/api/integrations", { packageId: "custom-api", name: `R7 host own ${++n}`, config: { baseUrl: A_ORIGIN }, secrets: {}, pendingId, untested: true })));
    expect(c.status).toBe(201);
    const key = repo.getIntegrationRow(c.body.id!)!.secretFields[0]!.key;
    const base = secrets.vaultResolver({ integrationId: c.body.id!, pinOrigin: A_ORIGIN });
    resolver = (k, d) => base(k === "token" ? key : k, d);
  }
  const h = http.createHostHttp({ manifest, config: { baseUrl: A_ORIGIN }, secrets: resolver, userShaped: true });
  try {
    const res = await h.fetch({ path: p, auth: "token" });
    return { ok: true, status: res.status };
  } catch (err) {
    const e = (err as { adapterError?: { code: string; message: string } }).adapterError;
    return { ok: false, code: e?.code ?? "thrown", message: e?.message ?? String(err) };
  }
}

const isRefusal = (o: unknown) => {
  const s = JSON.stringify(o);
  return s.includes('"code":"permission"') || /"status":400/.test(s);
};

describe("M1: a secret is attached only for the origin actually requested", () => {
  it("control: a normal path on A still reads, and A sees the locked credential", async () => {
    const r = await savedEndpointAttempt("/data", "credential");
    record({ test: "control saved credential", ...r, aSawToken: tokenHits(A) });
    expect(r.save.status).toBe(201);
    expect(r.read.state).toBe("fresh");
    expect(A.seen.some((s) => s.auth.includes(CRED))).toBe(true);
    expect(otherPortConnections()).toBe(0);
  });

  for (const source of ["credential", "own-secret"] as const) {
    describe(`saved data endpoint, ${source === "credential" ? "saved credential locked to A" : "integration's own sealed secret pinned to A"}`, () => {
      for (const v of SAVED_VARIANTS) {
        it(`${v.name}: refused, 0 connections on the other port`, async () => {
          const r = await savedEndpointAttempt(v.path, source);
          const bConn = otherPortConnections();
          const bToken = tokenHits(B) + tokenHits(B6);
          record({ test: `saved ${source}`, variant: v.name, path: v.path, ...r, otherPortConnections: bConn, otherPortTokenHits: bToken });
          expect(bToken).toBe(0);
          expect(bConn).toBe(0);
          if (v.cross) expect(isRefusal(r.save) || isRefusal(r.read)).toBe(true);
          if (mustRefuseAtSave(v.path)) {
            expect(r.save.status).toBe(400);
            expect(r.save.error?.message).toMatch(/backslash|control character/);
            // The planted record is refused again when it is sent.
            expect(JSON.stringify(r.read)).toContain("permission");
          }
        });
      }
    });
  }

  describe("test before save with a held curl secret", () => {
    for (const v of SAVED_VARIANTS) {
      it(`${v.name}: refused, 0 connections on the other port`, async () => {
        const r = await heldTestAttempt(v.path);
        const bConn = otherPortConnections();
        record({ test: "held curl test", variant: v.name, path: v.path, outcome: r, otherPortConnections: bConn, otherPortTokenHits: tokenHits(B) + tokenHits(B6) });
        expect(tokenHits(B) + tokenHits(B6)).toBe(0);
        expect(bConn).toBe(0);
        if (v.cross) expect(r.ok).not.toBe(true);
        if (mustRefuseAtSave(v.path)) expect(r.status).toBe(400);
      });
    }
  });

  for (const source of ["credential", "own-secret", "held"] as const) {
    describe(`host fetch send-time guard, ${source}`, () => {
      for (const v of [...SAVED_VARIANTS, ...HOST_ONLY_VARIANTS]) {
        it(`${v.name}: permission error, 0 connections on the other port`, async () => {
          const r = await hostAttempt(v.path, source);
          const bConn = otherPortConnections();
          record({ test: `host ${source}`, variant: v.name, path: v.path, outcome: r, otherPortConnections: bConn, otherPortTokenHits: tokenHits(B) + tokenHits(B6) });
          expect(tokenHits(B) + tokenHits(B6)).toBe(0);
          expect(bConn).toBe(0);
          if (v.cross || mustRefuseAtSave(v.path)) expect(r).toMatchObject({ ok: false, code: "permission" });
          else if (r.ok) expect(A.seen.length).toBeGreaterThan(0);
        });
      }
    });
  }

  it("safeRequest allowedOrigins compares scheme, host and port", async () => {
    const { safeRequest } = await import("../host/request");
    const sr = safeRequest as unknown as (r: Record<string, unknown>) => Promise<unknown>;
    await expect(sr({ url: `http://127.0.0.1:${PORT_B}/x`, redirect: { mode: "same-host" }, allowedOrigins: [A_ORIGIN] })).rejects.toMatchObject({ adapterError: { code: "permission" } });
    expect(B.connections + B.seen.length).toBe(0);
    await expect(sr({ url: `${A_ORIGIN}/x`, redirect: { mode: "same-host" }, allowedOrigins: [A_ORIGIN] })).resolves.toMatchObject({ status: 200 });
  });
});
