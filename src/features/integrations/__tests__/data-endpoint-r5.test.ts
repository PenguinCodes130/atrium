// Round 5 addendum (lead, same rule as Fix List item 1 and Amendment A1.1): GET /api/data/endpoint
// reads an integration's live data only for the owner, the integration's creator, or anyone when it
// is Shared. Otherwise 404 "That endpoint does not exist.", the same answer as an unknown id. Drives
// the real route handler with auth's requireUser replaced by a fixed session (and the real one for
// the bearer case), against a local fake Prometheus. Results go to
// evidence/integrations/r6/security/data-endpoint.jsonl. No secrets involved.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";
import { httpServer, json } from "../host/__tests__/servers";

setupTestDb();

type User = Extract<Principal, { kind: "user" }>;
const owner: User = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const member: User = { kind: "user", userId: "u-member", role: "member", via: "session" };
const member2: User = { kind: "user", userId: "u-member2", role: "member", via: "session" };
const viewer: User = { kind: "user", userId: "u-viewer", role: "viewer", via: "session" };

const state = vi.hoisted(() => ({ principal: null as null | Extract<Principal, { kind: "user" }> }));
vi.mock("@/features/auth", async (orig) => {
  const real = await orig<typeof import("@/features/auth")>();
  return {
    ...real,
    requireUser: async (req?: Request, minRole?: Parameters<typeof real.requireUser>[1]) => {
      const p = state.principal;
      if (!p) return real.requireUser(req, minRole); // the real check (bearer tokens, no session)
      return { user: { id: p.userId, role: p.role, name: p.userId, email: `${p.userId}@atrium.test` }, session: { id: `s-${p.userId}`, stepUpAt: null }, principal: p };
    },
  };
});

const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/data-endpoint.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
const record = (test: string, data: unknown) => appendFileSync(EVIDENCE, `${JSON.stringify({ test, ...(data as object) })}\n`);

let svc: typeof import("../service");
let route: typeof import("@/app/api/data/endpoint/route");
let P: Awaited<ReturnType<typeof httpServer>>;

beforeAll(async () => {
  svc = await import("../service");
  route = await import("@/app/api/data/endpoint/route");
  P = await httpServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/v1/status/buildinfo") return json(res, 200, { status: "success", data: { version: "3.14.0" } });
    if (u.pathname === "/api/v1/targets") return json(res, 200, { status: "success", data: { activeTargets: [{ labels: { job: "owner-only-job", instance: "10.0.0.8:9100" }, health: "up" }] } });
    json(res, 404, {});
  });
});
afterAll(async () => { await P.close(); });

let n = 0;
const promOf = (p: User) => svc.createIntegration(p, { packageId: "prometheus", name: `Prom ${++n}`, config: { baseUrl: P.url }, secrets: {}, untested: true });

async function read(p: User | null, integration: string, endpoint = "targets", headers: Record<string, string> = {}) {
  state.principal = p;
  const res = await route.GET(new Request(`http://127.0.0.1:3113/api/data/endpoint?integration=${encodeURIComponent(integration)}&endpoint=${endpoint}`, { headers }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/data/endpoint: who may read an integration's data", () => {
  it("a member reading the owner's unshared integration gets the same 404 as an unknown id, and nothing is read", async () => {
    const i = promOf(owner);
    expect(i.shared).toBe(false);
    const seen = P.seen.length;
    const r = await read(member, i.id);
    const unknown = await read(member, "no-such-integration");
    record("member, owner's unshared integration", { status: r.status, body: r.body, unknown });
    expect(r.status).toBe(404);
    expect(r.body).toEqual(unknown.body);
    expect(r.body).toMatchObject({ error: { message: "That endpoint does not exist." } });
    expect(JSON.stringify(r.body)).not.toContain("owner-only-job");
    expect(P.seen.length).toBe(seen);
    // A viewer is refused the same way.
    expect((await read(viewer, i.id)).status).toBe(404);
  });

  it("the owner reads it; once it is Shared, a member and a viewer read it too", async () => {
    const i = promOf(owner);
    const own = await read(owner, i.id);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain("owner-only-job");
    svc.updateIntegration(owner, i.id, { shared: true });
    const m = await read(member, i.id);
    const v = await read(viewer, i.id);
    record("shared integration", { member: m.status, viewer: v.status });
    expect(m.status).toBe(200);
    expect(v.status).toBe(200);
  });

  it("a member's own unshared integration: the creator and the owner read it, another member gets 404", async () => {
    const i = promOf(member);
    expect((await read(member, i.id)).status).toBe(200);
    expect((await read(owner, i.id)).status).toBe(200);
    expect((await read(member2, i.id)).status).toBe(404);
  });

  it("a bearer token (agent) never reaches it: auth's session check answers 401", async () => {
    const i = promOf(owner);
    const r = await read(null, i.id, "targets", { authorization: "Bearer atr_pat_FAKE-test-token" });
    record("bearer token", { status: r.status, body: r.body });
    expect(r.status).toBe(401);
  });
});
