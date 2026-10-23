// Gauntlet r1 security regression tests (Fix List items 1 to 4). Each test replays the critic's
// exploit from app/evidence/gauntlet/r1/security/ against two local servers: A is the host a
// credential was saved for, B is a stand-in attacker host on another port. Every test asserts the
// request now fails safely and that B never received a credential. What B saw is written to
// evidence/integrations/r6/security/regression.jsonl. Test-only secret values; none are real.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";
import { httpServer, json, redirect } from "../host/__tests__/servers";

setupTestDb();

const owner: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const member: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-guest", role: "member", via: "session" };
const NPM_TOKEN = "SECPROBE-npm-token-7f3a9c";
const BASIC_PASS = "SECPROBE-basic-pass-91";
const PENDING_BEARER = "SECPROBE-pending-bearer-55";
const SECRETS = [NPM_TOKEN, BASIC_PASS, PENDING_BEARER];

const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/regression.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
function record(test: string, outcome: unknown, bSaw: unknown[]) {
  appendFileSync(EVIDENCE, `${JSON.stringify({ test, outcome, attackerHostSaw: bSaw })}\n`);
}

let svc: typeof import("../service");
let runtime: typeof import("../runtime");
let repo: typeof import("../repo");
let tryIt: typeof import("../try-it");
let request: typeof import("../host/request");
let outbound: typeof import("../host/outbound");
let A: Awaited<ReturnType<typeof httpServer>>;
let B: Awaited<ReturnType<typeof httpServer>>;

const leaked = (seen: { headers: Record<string, unknown> }[]) => {
  const text = JSON.stringify(seen);
  return SECRETS.some((s) => text.includes(s) || text.includes(Buffer.from(`:${s}`).toString("base64")) || text.includes(Buffer.from(`probe:${s}`).toString("base64")));
};

beforeAll(async () => {
  svc = await import("../service");
  runtime = await import("../runtime");
  repo = await import("../repo");
  tryIt = await import("../try-it");
  request = await import("../host/request");
  outbound = await import("../host/outbound");
  B = await httpServer((req, res) => json(res, 200, { server: "B", path: req.url }));
  A = await httpServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/") return json(res, 200, { status: "OK", version: { major: 2, minor: 12, revision: 6 } });
    if (u.pathname === "/api/users/me") return req.headers.authorization === `Bearer ${NPM_TOKEN}` ? json(res, 200, { id: 1 }) : json(res, 401, {});
    if (u.pathname === "/echo") return json(res, 200, { ok: true, headers: req.headers });
    if (u.pathname === "/redir") return redirect(res, `${B.url}/capture`);
    json(res, 404, {});
  });
});
afterAll(async () => { await A.close(); await B.close(); });

function npmIntegration() {
  return svc.createIntegration(owner, { packageId: "npm", name: "NPM", config: { baseUrl: A.url }, secrets: { token: NPM_TOKEN }, untested: true });
}

describe("finding 1: a stored secret is pinned to the host it was saved for", () => {
  it("a member cannot retarget, test or re-key an integration someone else added", async () => {
    const i = npmIntegration();
    B.seen.length = 0;
    expect(() => svc.updateIntegration(member, i.id, { config: { baseUrl: B.url } })).toThrow(/Only the owner or the person who added/);
    await expect(svc.testConnection(member, { packageId: "npm", config: { baseUrl: B.url }, secrets: {}, integrationId: i.id })).rejects.toThrow(/Only the owner or the person who added/);
    expect(() => svc.saveSecrets(member, i.id, { token: "x" })).toThrow(/Only the owner/);
    expect(() => svc.deleteIntegration(member, i.id)).toThrow(/Only the owner/);
    expect(B.seen).toEqual([]);
    record("member retarget refused", "Forbidden", B.seen);
  });

  it("step 1 replay: a test with another baseUrl and blank secrets does not send the stored token there", async () => {
    const i = npmIntegration();
    B.seen.length = 0;
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: B.url }, secrets: {}, integrationId: i.id });
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toMatchObject({ code: "permission", message: expect.stringContaining("only sent to the address it was saved for") });
    expect(leaked(B.seen)).toBe(false);
    expect(B.seen.every((s) => s.headers.authorization === undefined)).toBe(true);
    record("test with foreign baseUrl", t, B.seen);
  });

  it("step 2 replay: changing baseUrl with secrets saved needs confirmation, and confirming deletes them", async () => {
    const i = npmIntegration();
    B.seen.length = 0;
    expect(() => svc.updateIntegration(owner, i.id, { config: { baseUrl: B.url } })).toThrow(/Changing the address removes the saved credentials/);
    expect(svc.getIntegration(owner, i.id).config.baseUrl).toBe(A.url);
    const moved = svc.updateIntegration(owner, i.id, { config: { baseUrl: B.url }, clearSecrets: true });
    expect(moved.secrets.find((s) => s.key === "token")?.set).toBe(false);
    // Step 3 replay: the data read path (any reader) now has no token to send.
    const r = await runtime.readEndpoint(i.id, "proxy-hosts", {});
    expect(r.ok).toBe(false);
    expect(leaked(B.seen)).toBe(false);
    record("retarget then read", r, B.seen);
  });

  it("even if the stored address drifts underneath, a read refuses to send the secret to the new origin", async () => {
    const i = npmIntegration();
    B.seen.length = 0;
    // Simulate a write that bypassed the service: the sealed pin recorded at save time still says A.
    const before = repo.getIntegrationRow(i.id)!;
    repo.updateIntegration(i.id, { config: { ...before.config, baseUrl: B.url } });
    const r = await runtime.readEndpoint(i.id, "proxy-hosts", {});
    expect(r).toMatchObject({ ok: false, error: { code: "permission", message: expect.stringContaining("only sent to the address it was saved for") } });
    expect(B.seen).toEqual([]);
    record("drifted config read", r, B.seen);
    const { vaultResolver } = await import("../host/secrets");
    await expect(vaultResolver({ integrationId: i.id, pinOrigin: new URL(B.url).origin })("token", new URL(B.url).origin)).rejects.toMatchObject({ adapterError: { code: "permission" } });
    await expect(vaultResolver({ integrationId: i.id })("token", new URL(A.url).origin)).resolves.toBe(NPM_TOKEN);
  });

  it("a different scheme or port on the same host counts as a different address", async () => {
    const { vaultResolver } = await import("../host/secrets");
    const i = npmIntegration();
    const resolve = vaultResolver({ integrationId: i.id, pinOrigin: new URL(A.url).origin });
    await expect(resolve("token", new URL(A.url).origin.replace("http:", "https:"))).rejects.toMatchObject({ adapterError: { code: "permission" } });
    await expect(resolve("token", `http://127.0.0.1:${A.port + 1}`)).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });

  it("held curl credentials cannot be saved onto an integration at another address", async () => {
    const r = await tryIt.runTry({ curl: `curl ${A.url}/echo -H 'Authorization: Bearer ${PENDING_BEARER}'` }, owner.userId);
    if (!r.ok || !r.pendingId) throw new Error("setup");
    const pendingId = r.pendingId;
    expect(() => svc.createIntegration(owner, { packageId: "custom-api", name: "C", config: { baseUrl: B.url }, secrets: {}, pendingId, untested: true })).toThrow(/only be saved for the address they came with/);
  });
});

async function basicIntegration() {
  const r = await tryIt.runTry({ curl: `curl -u probe:${BASIC_PASS} ${A.url}/echo` }, owner.userId);
  if (!r.ok || !r.pendingId) throw new Error(`setup failed: ${JSON.stringify(r)}`);
  const i = svc.createIntegration(owner, { packageId: "custom-api", name: "Basic probe", config: { baseUrl: A.url, username: "probe" }, secrets: {}, pendingId: r.pendingId, untested: true });
  const row = repo.getIntegrationRow(i.id)!;
  const origin = runtime.pinFor(runtime.effectiveManifest(runtime.getPackage("custom-api")!, row.secretFields), row.config)!;
  return { i, auth: { integrationId: i.id, origin, fields: row.secretFields as never, config: row.config } };
}

describe("finding 2: a credential never follows a redirect to another host", () => {
  it("step 2 replay: Try it with a saved integration's secret refuses a 302 to another host", async () => {
    const { auth } = await basicIntegration();
    B.seen.length = 0;
    const r = await tryIt.runTry({ url: `${A.url}/redir`, auth: { integrationId: auth.integrationId } }, owner.userId, auth);
    expect(r).toMatchObject({ ok: false, error: { code: "permission", message: expect.stringContaining("does not send credentials there") } });
    expect(B.seen).toEqual([]);
    record("try it saved secret redirect", r, B.seen);
  });

  it("step 3 replay: a pending bearer token from a pasted curl is not carried to another host", async () => {
    B.seen.length = 0;
    const r = await tryIt.runTry({ curl: `curl ${A.url}/redir -H 'Authorization: Bearer ${PENDING_BEARER}'` }, owner.userId);
    expect(r).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(B.seen).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(PENDING_BEARER);
    record("try it pending bearer redirect", r, B.seen);
  });

  it("without credentials a redirect is still followed, and credential headers are dropped on a cross-host hop", async () => {
    B.seen.length = 0;
    const ok = await tryIt.runTry({ url: `${A.url}/redir` }, owner.userId);
    expect(ok.ok).toBe(true);
    expect(B.seen).toHaveLength(1);
    B.seen.length = 0;
    await request.safeRequest({ url: `${A.url}/redir`, headers: { authorization: `Bearer ${PENDING_BEARER}`, cookie: "s=1" }, redirect: { mode: "checked" } });
    expect(B.seen[0]?.headers.authorization).toBeUndefined();
    expect(B.seen[0]?.headers.cookie).toBeUndefined();
    record("checked mode strips credential headers", "stripped", B.seen);
  });

  it("host.fetch reads still refuse a redirect to another host", async () => {
    await expect(request.safeRequest({ url: `${A.url}/redir`, redirect: { mode: "same-host" } })).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });
});

describe("finding 3: no composite form of a secret reaches the browser", () => {
  it("step 1 replay: an echoed Basic header (base64 of user:secret) is scrubbed from the Try it tree", async () => {
    const { auth } = await basicIntegration();
    const r = await tryIt.runTry({ url: `${A.url}/echo`, auth: { integrationId: auth.integrationId } }, owner.userId, auth);
    expect(r.ok).toBe(true);
    const out = JSON.stringify(r);
    expect(out).not.toContain(BASIC_PASS);
    expect(out).not.toContain(Buffer.from(`probe:${BASIC_PASS}`).toString("base64"));
    expect(out).toContain("[secret]");
    // The saved integration keeps its Basic username, and A (the right host) got the real header.
    expect(A.seen.at(-1)?.headers.authorization).toBe(`Basic ${Buffer.from(`probe:${BASIC_PASS}`).toString("base64")}`);
    record("basic echo scrubbed", JSON.parse(out), []);
  });

  it("scrubSecrets covers Basic, Bearer, PVEAPIToken, URL, base64 and JSON-escaped forms", () => {
    const value = "pa ss\"w/rd+9";
    const forms = [
      ...outbound.attachSecret({ as: "basic", userKey: "u" }, value, {}, new URL("http://x"), { u: "bob" }).forms,
      ...outbound.attachSecret({ as: "proxmox-token" }, value, {}, new URL("http://x"), {}).forms,
    ];
    const body = JSON.stringify({ a: `Basic ${Buffer.from(`bob:${value}`).toString("base64")}`, b: `PVEAPIToken=${value}`, c: encodeURIComponent(value), d: Buffer.from(value).toString("base64"), e: value });
    const out = outbound.scrubSecrets(Buffer.from(body), forms).toString();
    expect(out).not.toContain(Buffer.from(`bob:${value}`).toString("base64"));
    expect(out).not.toContain(encodeURIComponent(value));
    expect(out).not.toContain(Buffer.from(value).toString("base64"));
    expect(out).not.toContain("pa ss");
  });

  it("a credential typed as a plain header in Try it is refused, never echoed", async () => {
    const r = await tryIt.runTry({ url: `${A.url}/echo`, headers: { Authorization: `Bearer ${PENDING_BEARER}` } }, owner.userId);
    expect(r).toMatchObject({ ok: false, error: { code: "config" } });
    expect(JSON.stringify(r)).not.toContain(PENDING_BEARER);
  });
});

describe("finding 4: Try it and custom endpoints only read from private addresses", () => {
  it("replay: a POST with a body and an arbitrary header to a loopback 'Docker' is refused before sending", async () => {
    B.seen.length = 0;
    const r = await tryIt.runTry({ url: `${B.url}/v1.43/containers/create`, method: "POST", headers: { "x-anything": "set-by-member" }, body: JSON.stringify({ Image: "alpine", HostConfig: { Binds: ["/:/host"] } }) }, member.userId);
    expect(r).toMatchObject({ ok: false, error: { code: "permission", message: expect.stringContaining("can only read from addresses on your network") } });
    expect(B.seen).toEqual([]);
    record("try it POST to loopback", r, B.seen);
  });

  it("a pasted curl POST to a private address is refused too", async () => {
    B.seen.length = 0;
    const r = await tryIt.runTry({ curl: `curl -X POST ${B.url}/containers/create -d '{"Image":"alpine"}'` }, member.userId);
    expect(r).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(B.seen).toEqual([]);
  });

  it.each([["x-anything", "set-by-member"], ["X-HTTP-Method-Override", "POST"], ["x-forwarded-for", "1.2.3.4"]])("a GET with the %s header to loopback is refused", async (name, value) => {
    B.seen.length = 0;
    const r = await tryIt.runTry({ url: `${B.url}/x`, headers: { [name]: value } }, member.userId);
    expect(r).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(B.seen).toEqual([]);
  });

  it("a plain GET with standard headers still works on the LAN", async () => {
    B.seen.length = 0;
    const r = await tryIt.runTry({ url: `${B.url}/x`, headers: { Accept: "application/json" } }, member.userId);
    expect(r.ok).toBe(true);
    expect(B.seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("a saved custom POST endpoint to a private address is refused at read time (same rule for saved records)", async () => {
    const i = svc.createIntegration(owner, { packageId: "custom-api", name: "Loopback", config: { baseUrl: B.url }, secrets: {}, untested: true, endpoints: [{ id: "create", label: "Create", method: "POST", path: "/containers/create", body: { Image: "alpine" }, fields: [{ path: "$.server", label: "s", role: "value" }], shape: "stat", refreshSec: 30 }] });
    B.seen.length = 0;
    const r = await runtime.readEndpoint(i.id, "create", {});
    expect(r).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(B.seen).toEqual([]);
  });

  it("a saved endpoint cannot keep a credential-looking header", () => {
    const i = svc.createIntegration(owner, { packageId: "custom-api", name: "Hdr", config: { baseUrl: A.url }, secrets: {}, untested: true });
    expect(() => svc.addEndpoint(owner, i.id, { id: "s", label: "S", method: "GET", path: "/echo", headers: { "X-Auth-Token": "abc" }, fields: [{ path: "$.ok", label: "ok", role: "value" }], shape: "stat", refreshSec: 30 })).toThrow(/credential/);
  });

  it("official adapters keep their documented read-only POSTs (not person-shaped)", async () => {
    // Uptime Kuma, pfSense and friends are reviewed adapter code: the private-address rule is not applied.
    const { createHostHttp } = await import("../host/http");
    const manifest = { ...runtime.getPackage("npm")!.manifest, secrets: [], permissions: [{ kind: "network" as const, hosts: "configured" as const }] };
    B.seen.length = 0;
    const http = createHostHttp({ manifest, config: { baseUrl: B.url }, secrets: async () => null });
    const res = await http.fetch({ path: "/read", method: "POST", body: { q: 1 } });
    expect(res.status).toBe(200);
    expect(B.seen.map((s) => s.method)).toEqual(["POST"]);
  });
});
