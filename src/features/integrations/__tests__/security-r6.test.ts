// Gauntlet round 3 security finding (integrations Fix List r3 item 1): the step-up for sending a
// saved credential to a new server could be skipped. Replays
// app/evidence/gauntlet/r3/security/member-scenarios-r3.txt section 4 and stepup-bypass-live-r3.txt
// through the real route handlers, with auth's requireUser replaced by a fixed owner session that
// has NO fresh step-up (and requireStepUp answering step_up_required for it, as auth does), against
// local test servers A (the real server) and EVIL (a server of the attacker's choosing).
// The rule: a credential value never reaches an origin outside its lockedOrigins unless a fresh
// step-up happened and a credential.locked audit entry names that origin, whatever the credential's
// usage; removing a server always needs a step-up; a test before save of an unlocked credential
// needs the step-up too and records the lock. Outcomes and what each server saw go to
// evidence/integrations/r6/security/stepup-bypass.jsonl, with the token replaced by a label.
// Test-only secret values; none are real.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";
import { httpServer, json } from "../host/__tests__/servers";

setupTestDb();

type User = Extract<Principal, { kind: "user" }>;
const owner: User = { kind: "user", userId: "u-owner", role: "owner", via: "session" };

const state = vi.hoisted(() => ({ stepUpAt: null as Date | null }));
vi.mock("@/features/auth", async (orig) => {
  const real = await orig<typeof import("@/features/auth")>();
  const session = () => ({ user: { id: owner.userId, role: owner.role, name: "Owner", email: "owner@atrium.test" }, session: { id: "s-owner", stepUpAt: state.stepUpAt }, principal: owner });
  return {
    ...real,
    requireUser: async () => session(),
    requireStepUp: async () => {
      if (!state.stepUpAt || Date.now() - state.stepUpAt.getTime() > real.STEP_UP_WINDOW_MS) throw new real.StepUpRequired("password");
      return session();
    },
  };
});

const TOKEN = "SECPROBE-owner-prod-token-r6";
const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/stepup-bypass.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
const record = (step: string, data: unknown) => appendFileSync(EVIDENCE, `${JSON.stringify({ step, ...(data as object) }).replaceAll(TOKEN, "<owner SECPROBE token>")}\n`);

let A: Awaited<ReturnType<typeof httpServer>>;
let EVIL: Awaited<ReturnType<typeof httpServer>>;
let auditRows: () => { event: string; targetId: string | null; detail: Record<string, unknown> | null }[];
let routes: {
  integrations: typeof import("@/app/api/integrations/route");
  integration: typeof import("@/app/api/integrations/[id]/route");
  integrationTest: typeof import("@/app/api/integrations/[id]/test/route");
  credentials: typeof import("@/app/api/integrations/credentials/route");
  credential: typeof import("@/app/api/integrations/credentials/[credentialId]/route");
  test: typeof import("@/app/api/integrations/test/route");
};

function npmLike(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/api/") return json(res, 200, { status: "OK", version: { major: 2, minor: 12, revision: 6 } });
  if (u.pathname === "/api/users/me") return req.headers.authorization ? json(res, 200, { id: 1 }) : json(res, 401, {});
  json(res, 404, {});
}

/** Requests that carried the token, per server. */
const tokenSeen = (s: typeof A) => s.seen.filter((r) => String(r.headers.authorization ?? "").includes(TOKEN)).length;

beforeAll(async () => {
  routes = {
    integrations: await import("@/app/api/integrations/route"),
    integration: await import("@/app/api/integrations/[id]/route"),
    integrationTest: await import("@/app/api/integrations/[id]/test/route"),
    credentials: await import("@/app/api/integrations/credentials/route"),
    credential: await import("@/app/api/integrations/credentials/[credentialId]/route"),
    test: await import("@/app/api/integrations/test/route"),
  };
  const { db } = await import("@/core/db");
  const { auditLog } = await import("@/db/schema/audit");
  auditRows = () => db().select().from(auditLog).all().map((r) => ({ event: r.event, targetId: r.targetId, detail: r.detail ?? null }));
  A = await httpServer(npmLike);
  EVIL = await httpServer(npmLike);
});
afterAll(async () => { await A.close(); await EVIL.close(); });
beforeEach(() => { state.stepUpAt = null; A.seen.length = 0; EVIL.seen.length = 0; });

const req = (method: string, p: string, body?: unknown) => new Request(`http://127.0.0.1:3113${p}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const ctx = <K extends string>(k: K, v: string) => ({ params: Promise.resolve({ [k]: v } as Record<K, string>) });
/** A JSON answer from a route; the test reads whichever fields that route sends. */
type Body = { error: { code: string; message: string }; ok: boolean; confirm: unknown; id: string; name: string; lockedOrigins: string[] };
async function out(res: Response) {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body: body as Body };
}

let n = 0;
async function newCredential(server?: string) {
  const r = await out(await routes.credentials.POST(req("POST", "/api/integrations/credentials", { name: `Owner prod token ${++n}`, kind: "token", values: { token: TOKEN }, ...(server ? { server } : {}) })));
  expect(r.status).toBe(201);
  return r.body as { id: string; name: string; lockedOrigins: string[] };
}
const createOn = (url: string, cid: string, extra: Record<string, unknown> = {}) =>
  routes.integrations.POST(req("POST", "/api/integrations", { packageId: "npm", name: `NPM ${++n}`, config: { baseUrl: url }, secrets: {}, credentials: { token: cid }, untested: true, ...extra })).then(out);
const removeServer = (cid: string, origin: string) => routes.credential.PATCH(req("PATCH", `/api/integrations/credentials/${cid}`, { removeOrigins: [origin] }), ctx("credentialId", cid)).then(out);
const testBeforeSave = (url: string, cid: string, extra: Record<string, unknown> = {}) =>
  routes.test.POST(req("POST", "/api/integrations/test", { packageId: "npm", config: { baseUrl: url }, secrets: {}, credentials: { token: cid }, ...extra })).then(out);
const lockedEntries = (cid: string) => auditRows().filter((r) => r.event === "credential.locked" && r.targetId === cid);
const credentialOf = async (cid: string) => (await out(await routes.credential.GET(req("GET", `/api/integrations/credentials/${cid}`), ctx("credentialId", cid)))).body as { lockedOrigins: string[] };

describe("r3 finding: delete, remove, then test or save elsewhere with no step-up", () => {
  it("the critic's chain never sends the token to EVIL and never moves the lock", async () => {
    const a = new URL(A.url).origin;
    const evil = new URL(EVIL.url).origin;
    const c = await newCredential(A.url);
    expect(c.lockedOrigins).toEqual([a]);
    const i = await createOn(A.url, c.id);
    record("1 integration on A using it", { status: i.status });
    expect(i.status).toBe(201);

    // The intended guards (held before the fix too).
    const r1 = await removeServer(c.id, a);
    record("2 remove A while in use, no step-up", r1);
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe("step_up_required");
    const r2 = await createOn(EVIL.url, c.id, { confirmOrigins: true });
    record("3 save on EVIL with confirm, no step-up", r2);
    expect(r2.status).toBe(403);

    // The bypass: delete the integration (asks for nothing), then remove A from the unused credential.
    const del = await out(await routes.integration.DELETE(req("DELETE", `/api/integrations/${i.body.id}`), ctx("id", i.body.id)));
    record("4 delete the integration", { status: del.status });
    expect(del.status).toBe(204);
    const r3 = await removeServer(c.id, a);
    record("5 remove A now that nothing uses it, no step-up", { status: r3.status, body: r3.body, lockedOrigins: (await credentialOf(c.id)).lockedOrigins });
    expect(r3.status).toBe(403);
    expect(r3.body.error.code).toBe("step_up_required");
    expect((await credentialOf(c.id)).lockedOrigins).toEqual([a]);

    // Test connection and save on EVIL: refused, nothing sent, the lock list unchanged.
    const t = await testBeforeSave(EVIL.url, c.id);
    record("6 test before save on EVIL", { status: t.status, body: t.body, evilSawToken: tokenSeen(EVIL) });
    expect(t.body?.ok).not.toBe(true);
    const s = await createOn(EVIL.url, c.id);
    record("7 save on EVIL, no confirm, no step-up", { status: s.status, body: s.body, evilSawToken: tokenSeen(EVIL) });
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe("credential_origin_confirm");
    const s2 = await createOn(EVIL.url, c.id, { confirmOrigins: true });
    expect(s2.status).toBe(403);

    expect(tokenSeen(EVIL)).toBe(0);
    expect(EVIL.seen.filter((r) => r.headers.authorization)).toEqual([]);
    expect((await credentialOf(c.id)).lockedOrigins).toEqual([a]);
    expect(lockedEntries(c.id).filter((e) => e.detail?.origin === evil)).toEqual([]);
    record("audit for the credential", { rows: auditRows().filter((r) => r.targetId === c.id).map((r) => `${r.event} ${JSON.stringify(r.detail)}`) });
  });

  it("removing a server from an unused credential needs a step-up; with one it works and is audited", async () => {
    const a = new URL(A.url).origin;
    const c = await newCredential(A.url);
    const r = await removeServer(c.id, a);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("step_up_required");
    state.stepUpAt = new Date();
    const ok = await removeServer(c.id, a);
    record("remove from unused credential after step-up", ok);
    expect(ok.status).toBe(200);
    expect(ok.body.lockedOrigins).toEqual([]);
    expect(auditRows().filter((x) => x.event === "credential.updated" && x.targetId === c.id).at(-1)!.detail).toMatchObject({ removedOrigins: [a] });
  });

  it("an emptied credential is not a free first use: test and save on EVIL need the confirm and a step-up", async () => {
    const a = new URL(A.url).origin;
    const c = await newCredential(A.url);
    state.stepUpAt = new Date();
    expect((await removeServer(c.id, a)).status).toBe(200);
    state.stepUpAt = null; // the step-up has expired by the time the attacker acts
    const t1 = await testBeforeSave(EVIL.url, c.id);
    record("emptied: test on EVIL, no confirm", { status: t1.status, body: t1.body, evilSawToken: tokenSeen(EVIL) });
    expect(t1.status).toBe(409);
    expect(t1.body.error.code).toBe("credential_origin_confirm");
    const t2 = await testBeforeSave(EVIL.url, c.id, { confirmOrigins: true });
    record("emptied: test on EVIL, confirm, no step-up", { status: t2.status, body: t2.body });
    expect(t2.status).toBe(403);
    expect(t2.body.error.code).toBe("step_up_required");
    const s = await createOn(EVIL.url, c.id, { confirmOrigins: true });
    expect(s.status).toBe(403);
    expect(tokenSeen(EVIL)).toBe(0);
    expect((await credentialOf(c.id)).lockedOrigins).toEqual([]);
  });
});

describe("test before save of an unlocked credential (the new rule)", () => {
  it("never saved to a server: the test asks to lock it, needs a step-up, then locks and audits before sending", async () => {
    const evil = new URL(EVIL.url).origin;
    const c = await newCredential();
    expect(c.lockedOrigins).toEqual([]);
    const t1 = await testBeforeSave(EVIL.url, c.id);
    expect(t1.status).toBe(409);
    expect(t1.body.confirm).toMatchObject({ origin: evil, credentials: [{ id: c.id, lockedOrigins: [] }] });
    const t2 = await testBeforeSave(EVIL.url, c.id, { confirmOrigins: true });
    expect(t2.status).toBe(403);
    expect(tokenSeen(EVIL)).toBe(0);
    expect(lockedEntries(c.id)).toEqual([]);
    expect(auditRows().some((r) => r.targetId === c.id && JSON.stringify(r.detail).includes(evil))).toBe(false);

    state.stepUpAt = new Date();
    const t3 = await testBeforeSave(EVIL.url, c.id, { confirmOrigins: true });
    record("unlocked: test after confirm and step-up", { status: t3.status, body: t3.body, serverSawToken: tokenSeen(EVIL) });
    expect(t3.status).toBe(200);
    expect(t3.body.ok).toBe(true);
    expect(tokenSeen(EVIL)).toBe(1);
    expect((await credentialOf(c.id)).lockedOrigins).toEqual([evil]);
    const entry = lockedEntries(c.id).at(-1)!;
    expect(entry.detail).toMatchObject({ origin: evil, firstUse: true, via: "test" });
    // Later tests and the save on that server need nothing more: it is on the lock list now.
    state.stepUpAt = null;
    EVIL.seen.length = 0;
    expect((await testBeforeSave(EVIL.url, c.id)).body.ok).toBe(true);
    expect((await createOn(EVIL.url, c.id)).status).toBe(201);
    expect(lockedEntries(c.id)).toHaveLength(1);
  });

  it("saving with a never-locked credential (Save without testing) also needs the confirm and a step-up", async () => {
    const a = new URL(A.url).origin;
    const c = await newCredential();
    expect((await createOn(A.url, c.id)).status).toBe(409);
    expect((await createOn(A.url, c.id, { confirmOrigins: true })).status).toBe(403);
    expect((await credentialOf(c.id)).lockedOrigins).toEqual([]);
    state.stepUpAt = new Date();
    const s = await createOn(A.url, c.id, { confirmOrigins: true });
    expect(s.status).toBe(201);
    expect(lockedEntries(c.id).at(-1)!.detail).toMatchObject({ origin: a, firstUse: true, integrationId: s.body.id });
  });

  it("a credential saved with its server needs no step-up there, and is never sent anywhere else", async () => {
    const c = await newCredential(A.url);
    const t = await testBeforeSave(A.url, c.id);
    expect(t.body.ok).toBe(true);
    expect(tokenSeen(A)).toBe(1);
    // A saved integration's own Test connection with a moved address still never carries it.
    const i = await createOn(A.url, c.id);
    const moved = await out(await routes.integrationTest.POST(req("POST", `/api/integrations/${i.body.id}/test`, { config: { baseUrl: EVIL.url }, secrets: {} }), ctx("id", i.body.id)));
    record("saved integration tested on EVIL", { status: moved.status, body: moved.body, evilSawToken: tokenSeen(EVIL) });
    expect(moved.body.ok).toBe(false);
    expect(tokenSeen(EVIL)).toBe(0);
  });
});

describe("every send matches the lock list and the audit", () => {
  it("after all of the above, each origin that ever received the token is on a lock list with a credential.locked or creation entry", () => {
    // EVIL only ever got the token in the step-up test above, which wrote credential.locked naming it.
    const evil = new URL(EVIL.url).origin;
    expect(auditRows().filter((r) => r.event === "credential.locked" && r.detail?.origin === evil).length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
  });
});
