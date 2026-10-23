// Wave 2.7 (Amendment 8 A8.2, data ease criteria 3, 21, 23): GET /api/data/choices and the bindable
// listing's Amendment 8 fields. Real schema in a throwaway database, the e2e stand-in Prometheus, and
// the caller chosen per request (auth itself is covered by the auth suites).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "@/features/integrations/__tests__/db-harness";
import { agent, member, owner, viewer } from "@/features/controls/__tests__/harness";
import { blackhole } from "@/features/integrations/host/__tests__/servers";
import { startFakePrometheus, type FakePrometheus } from "../../../../tests/e2e/fixtures/fake-prometheus";

setupTestDb();

const readOnlyAgent: Principal = { ...agent, scopes: ["atrium:read"] } as Principal;
const callers: Record<string, Principal | null> = { owner, member, viewer, agent, readOnlyAgent, nobody: null };
vi.mock("@/features/auth", () => ({ getPrincipal: async (req: Request) => callers[req.headers.get("x-test-caller") ?? "nobody"] ?? null }));

let prom: FakePrometheus;
let hole: Awaited<ReturnType<typeof blackhole>>;
let promId: string;
let downId: string;
let route: typeof import("../choices");
let cmds: typeof import("@/features/integrations/commands");
let svc: typeof import("@/features/integrations/service");

beforeAll(async () => {
  prom = await startFakePrometheus();
  hole = await blackhole();
  svc = await import("@/features/integrations/service");
  cmds = await import("@/features/integrations/commands");
  route = await import("../choices");
  promId = svc.createIntegration(owner, { packageId: "prometheus", name: "Lab Prometheus", config: { baseUrl: prom.url }, secrets: {}, untested: true }).id;
  downId = svc.createIntegration(owner, { packageId: "prometheus", name: "Silent Prometheus", config: { baseUrl: hole.url }, secrets: {}, untested: true }).id;
}, 60_000);
afterAll(async () => { await prom.close(); await hole.close(); });

async function get(caller: string, q: Record<string, string>) {
  const res = await route.handleChoices(new Request(`http://127.0.0.1:3113/api/data/choices?${new URLSearchParams(q).toString()}`, { headers: { "x-test-caller": caller } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, text: "" };
}

describe("GET /api/data/choices", () => {
  it("an editor gets the machines as value, label and detail, with Every, and nothing else (criteria 3, 23)", async () => {
    const r = await get("owner", { integrationId: promId, endpointId: "machine-cpu", param: "machine" });
    expect(r.status).toBe(200);
    expect(r.body.every).toBe(true);
    expect(r.body.total).toBe(9);
    const choices = r.body.choices as { value: string; label: string; detail?: string }[];
    expect(choices.map((c) => c.label)).toEqual(["ACE", "firefly", "minipc-ubuntu", "Pelican", "pve1", "pve2", "pve3", "RP5-2", "RP5-3"]);
    expect(choices.find((c) => c.label === "RP5-3")!.value).toBe("host.docker.internal:9100");
    expect(Object.keys(r.body).sort()).toEqual(["choices", "every", "total"]);
    for (const c of choices) expect(Object.keys(c).every((k) => ["value", "label", "detail"].includes(k))).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(prom.url);
  });

  it("search words narrow the list", async () => {
    const r = await get("owner", { integrationId: promId, endpointId: "machine-cpu", param: "machine", q: "pve" });
    expect((r.body.choices as { label: string }[]).map((c) => c.label)).toEqual(["pve1", "pve2", "pve3"]);
  });

  it("a list that depends on another setting needs it first, then follows it", async () => {
    const missing = await get("owner", { integrationId: promId, endpointId: "machine-disk", param: "mount" });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: { code: "needs_param", message: "Pick machine first." } });
    const pve1 = await get("owner", { integrationId: promId, endpointId: "machine-disk", param: "mount", params: JSON.stringify({ machine: "10.77.99.4:9100", mount: "/" }) });
    expect((pve1.body.choices as { value: string }[]).map((c) => c.value)).toEqual(["/", "/data"]);
    expect(pve1.body.every).toBe(false);
  });

  it("viewers, signed-out callers and agents without atrium:edit get the same 404 as an unknown id (criterion 21)", async () => {
    const q = { integrationId: promId, endpointId: "machine-cpu", param: "machine" };
    for (const who of ["viewer", "nobody", "readOnlyAgent"]) {
      const r = await get(who, q);
      expect(r.status, who).toBe(404);
      expect(r.body).toEqual({ error: { code: "not_found", message: "Those choices do not exist." } });
    }
    expect((await get("owner", { ...q, integrationId: "no-such-id" })).status).toBe(404);
    expect((await get("owner", { ...q, param: "nope" })).status).toBe(404);
    expect((await get("owner", { ...q, endpointId: "targets" })).status).toBe(404);
    expect((await get("agent", q)).status).toBe(200);
  });

  it("a member gets them only while the integration is Shared (section 3.1)", async () => {
    const q = { integrationId: promId, endpointId: "machine-cpu", param: "machine" };
    expect((await get("member", q)).status).toBe(404);
    svc.updateIntegration(owner, promId, { shared: true });
    try {
      expect((await get("member", q)).status).toBe(200);
    } finally {
      svc.updateIntegration(owner, promId, { shared: false });
    }
  });

  it("a silent service answers within the 3 s limit with a plain error (502)", async () => {
    const start = Date.now();
    const r = await get("owner", { integrationId: downId, endpointId: "machine-cpu", param: "machine" });
    expect(Date.now() - start).toBeLessThan(4500);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) } });
  }, 10_000);

  it("a second ask within 30 s comes from the cache (no new request to Prometheus)", async () => {
    const q = { integrationId: promId, endpointId: "machine-memory", param: "machine" };
    await get("owner", q);
    const before = prom.hits.length;
    await get("owner", q);
    expect(prom.hits.length).toBe(before);
  });
});

describe("the bindable listing (A8.1, A8.2)", () => {
  it("passes group, advanced, needs, availability and the choices summary", async () => {
    const list = await cmds.listBindableEndpoints(owner);
    const p = list.find((i) => i.integrationId === promId)!;
    expect(p.availabilityChecked).toBe(true);
    const by = Object.fromEntries(p.endpoints.map((e) => [e.id, e]));
    expect(by["machine-cpu"]).toMatchObject({ group: "Machines", needs: "node-exporter on your machines", available: true, choices: [{ param: "machine", endpointId: "machines", every: true }] });
    expect(by["machine-disk"]!.choices).toEqual([{ param: "machine", endpointId: "machines", every: true }, { param: "mount", endpointId: "mounts", every: false, dependsOn: ["machine"] }]);
    expect(by.containers).toMatchObject({ group: "Containers", available: false });
    expect(by["pve-guests"]!.available).toBe(false);
    expect(by.query).toMatchObject({ group: "Advanced", advanced: true, available: true });
    const down = list.find((i) => i.integrationId === downId)!;
    expect(down.availabilityChecked).toBe(false);
    expect(down.endpoints.every((e) => e.available)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(prom.url);
  }, 20_000);

  it("viewers get nothing", async () => {
    expect(await cmds.listBindableEndpoints(viewer)).toEqual([]);
  });
});
