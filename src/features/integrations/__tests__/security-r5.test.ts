// Gauntlet round 2 security finding 1 (Fix List item 1): Try it with `auth: { integrationId }`.
// Replays app/evidence/gauntlet/r2/security/try-it-cross-user.txt through the real route handler
// (POST /api/integrations/try) with auth's requireUser replaced by a fixed session, against a local
// test server A. Every outcome and what A saw is written to
// evidence/integrations/r6/security/try-it-cross-user.jsonl. Test-only secret values; none are real.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";
import { httpServer, json } from "../host/__tests__/servers";

setupTestDb();

type User = Extract<Principal, { kind: "user" }>;
const owner: User = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const member: User = { kind: "user", userId: "u-member", role: "member", via: "session" };
const member2: User = { kind: "user", userId: "u-member2", role: "member", via: "session" };

const state = vi.hoisted(() => ({ principal: null as null | Extract<Principal, { kind: "user" }> }));
vi.mock("@/features/auth", async (orig) => {
  const real = await orig<typeof import("@/features/auth")>();
  return {
    ...real,
    requireUser: async () => {
      const p = state.principal!;
      return { user: { id: p.userId, role: p.role, name: p.userId, email: `${p.userId}@atrium.test` }, session: { id: `s-${p.userId}`, stepUpAt: null }, principal: p };
    },
  };
});

const OWNER_CRED = "SECPROBE-owner-cred-token-r5";
const OWNER_CURL = "SECPROBE-owner-curl-token-r5";
const SECRETS = [OWNER_CRED, OWNER_CURL];

const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/try-it-cross-user.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
// What the test server saw is kept, with the credential itself replaced by its name (the file is
// also part of the V10 grep, which must find no secret value anywhere).
const record = (test: string, data: unknown) => appendFileSync(EVIDENCE, `${JSON.stringify({ test, ...(data as object) }).replaceAll(OWNER_CRED, "[owner's saved credential]").replaceAll(OWNER_CURL, "[owner's curl token]")}\n`);

let svc: typeof import("../service");
let creds: typeof import("../credentials/service");
let tryIt: typeof import("../try-it");
let route: typeof import("@/app/api/integrations/try/route");
let A: Awaited<ReturnType<typeof httpServer>>;

const leaked = (x: unknown) => SECRETS.some((s) => JSON.stringify(x).includes(s));

beforeAll(async () => {
  svc = await import("../service");
  creds = await import("../credentials/service");
  tryIt = await import("../try-it");
  route = await import("@/app/api/integrations/try/route");
  A = await httpServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/private/admin-settings") {
      const auth = req.headers.authorization ?? "";
      return auth ? json(res, 200, { owner_only: "household alarm code area", users: ["owner"] }) : json(res, 401, { error: "no token" });
    }
    if (u.pathname === "/echo") return json(res, 200, { ok: true });
    json(res, 404, {});
  });
});
afterAll(async () => { await A.close(); });
beforeEach(() => { A.seen.length = 0; });

let n = 0;
/** The critic's setup: an owner Custom API integration (Shared off) whose field uses the owner's saved credential. */
async function ownerIntegrationWithCredential() {
  state.principal = owner;
  const t = await tryIt.runTry({ curl: `curl ${A.url}/echo -H 'Authorization: Bearer ${OWNER_CURL}'` }, owner.userId);
  if (!t.ok || !t.pendingId) throw new Error(`setup: ${JSON.stringify(t)}`);
  const i = svc.createIntegration(owner, { packageId: "custom-api", name: `Owner API ${++n}`, config: { baseUrl: A.url }, secrets: {}, pendingId: t.pendingId, untested: true });
  const c = creds.createCredential(owner, { name: `Owner cred ${n}`, kind: "token", values: { token: OWNER_CRED }, server: A.url });
  const key = i.secretFields[0]!.key;
  svc.saveSecrets(owner, i.id, {}, { credentials: { [key]: c.id } });
  A.seen.length = 0;
  return { i, c };
}

async function post(p: User, body: unknown) {
  state.principal = p;
  const res = await route.POST(new Request("http://127.0.0.1:3113/api/integrations/try", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("finding 1: Try it with another person's integration (try-it-cross-user.txt)", () => {
  it("the critic's replay: a member's Try it GET with the owner's integrationId is refused and nothing is sent", async () => {
    const { i, c } = await ownerIntegrationWithCredential();
    expect(i.shared).toBe(false);
    // The member can neither see the credential nor change the integration (the critic's preconditions).
    expect(creds.listCredentials(member)).toEqual([]);
    expect(() => creds.usableCredential(member, c.id)).toThrow(/does not exist/);
    expect(() => svc.updateIntegration(member, i.id, { name: "x" })).toThrow(/Only the owner or the person who added/);
    const r = await post(member, { url: `${A.url}/api/private/admin-settings`, auth: { integrationId: i.id } });
    record("member GET with owner integrationId", { status: r.status, body: r.body, serverSaw: A.seen });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toMatch(/Only the owner or the person who added/);
    expect(JSON.stringify(r.body)).not.toContain("household alarm code area");
    expect(A.seen).toEqual([]);
    expect(leaked(r.body)).toBe(false);
  });

  it("POST is refused the same way", async () => {
    const { i } = await ownerIntegrationWithCredential();
    const r = await post(member, { url: `${A.url}/api/private/admin-settings`, method: "POST", body: "{}", auth: { integrationId: i.id } });
    record("member POST with owner integrationId", { status: r.status, body: r.body, serverSaw: A.seen });
    expect(r.status).toBe(403);
    expect(A.seen).toEqual([]);
  });

  it("an unknown integration id answers not found and sends nothing", async () => {
    const r = await post(member, { url: `${A.url}/api/private/admin-settings`, auth: { integrationId: "no-such-integration" } });
    record("unknown integrationId", { status: r.status, body: r.body, serverSaw: A.seen });
    expect(r.status).toBe(404);
    expect(A.seen).toEqual([]);
  });

  it("the owner (who may manage it and use the credential) still gets the saved credential attached", async () => {
    const { i } = await ownerIntegrationWithCredential();
    const r = await post(owner, { url: `${A.url}/api/private/admin-settings`, auth: { integrationId: i.id } });
    record("owner GET with own integrationId", { status: r.status, ok: r.body.ok, serverSawAuthorization: A.seen.map((s) => (s.headers.authorization ? "Bearer [credential]" : null)) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(A.seen.at(-1)?.headers.authorization).toBe(`Bearer ${OWNER_CRED}`);
    expect(leaked(r.body)).toBe(false);
  });

  it("a member's own integration that the owner switched to the owner's credential: the member creator is refused", async () => {
    // The member creates an integration (so may manage it); the owner then points its field at the owner's credential.
    state.principal = member;
    const t = await tryIt.runTry({ curl: `curl ${A.url}/echo -H 'Authorization: Bearer ${OWNER_CURL}'` }, member.userId);
    if (!t.ok || !t.pendingId) throw new Error("setup");
    const i = svc.createIntegration(member, { packageId: "custom-api", name: `Member API ${++n}`, config: { baseUrl: A.url }, secrets: {}, pendingId: t.pendingId, untested: true });
    const c = creds.createCredential(owner, { name: `Owner only ${n}`, kind: "token", values: { token: OWNER_CRED }, server: A.url });
    svc.saveSecrets(owner, i.id, {}, { credentials: { [i.secretFields[0]!.key]: c.id } });
    A.seen.length = 0;
    const r = await post(member, { url: `${A.url}/api/private/admin-settings`, auth: { integrationId: i.id } });
    record("member creator, owner's credential", { status: r.status, body: r.body, serverSaw: A.seen });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { message: tryIt.TRY_FOREIGN_CREDENTIAL_MESSAGE } });
    expect(JSON.stringify(r.body)).not.toContain(c.name); // the member never learns the credential's name
    expect(A.seen).toEqual([]);
    // Another member, who is neither creator nor owner, is refused before any credential check.
    const r2 = await post(member2, { url: `${A.url}/api/private/admin-settings`, auth: { integrationId: i.id } });
    expect(r2.status).toBe(403);
    expect(A.seen).toEqual([]);
  });

  it("integrationAuthFor (the check behind the route) refuses a member directly", async () => {
    const { i } = await ownerIntegrationWithCredential();
    expect(() => tryIt.integrationAuthFor(member, i.id)).toThrow(/Only the owner or the person who added/);
    expect(tryIt.integrationAuthFor(owner, i.id)).toMatchObject({ integrationId: i.id, origin: new URL(A.url).origin });
  });
});
