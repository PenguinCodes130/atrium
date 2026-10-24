// Wave 2.9 (Amendment 10 A10.4): GET /api/data/catalogue and POST /api/data/peek. Real schema in a
// throwaway database (plus the integration_service table by drizzle-kit push until the lead's
// migration exists), the e2e stand-in Prometheus and a stand-in Docker, and the caller chosen per request.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CatalogueResponse, Principal } from "@/core/contracts";
import { setupRecipeDb } from "@/features/recipes/__tests__/harness";
import { agent, member, otherMember, owner, viewer } from "@/features/controls/__tests__/harness";
import { blackhole, httpServer, json } from "@/features/integrations/host/__tests__/servers";
import { startFakePrometheus, type FakePrometheus } from "../../../../tests/e2e/fixtures/fake-prometheus";

setupRecipeDb();

const readOnlyAgent: Principal = { ...agent, scopes: ["atrium:read"] } as Principal;
const callers: Record<string, Principal | null> = { owner, member, otherMember, viewer, agent, readOnlyAgent, nobody: null };
vi.setConfig({ testTimeout: 20_000 });
vi.mock("@/features/auth", () => ({ getPrincipal: async (req: Request) => callers[req.headers.get("x-test-caller") ?? "nobody"] ?? null }));

let prom: FakePrometheus;
let hole: Awaited<ReturnType<typeof blackhole>>;
let docker: Awaited<ReturnType<typeof httpServer>>;
let promId: string, slowId: string, dockerId: string, privateId: string;
let routes: typeof import("../catalogue-routes");
let cat: typeof import("../catalogue");
let svc: typeof import("@/features/integrations/service");

const CONTAINERS = [
  { Id: "a1", Names: ["/immich"], Image: "immich:FAKE", State: "running", Status: "Up 2 days" },
  { Id: "a2", Names: ["/jellyfin"], Image: "jellyfin:FAKE", State: "running", Status: "Up 1 day" },
  { Id: "a3", Names: ["/old-job"], Image: "busybox:FAKE", State: "exited", Status: "Exited (0)" },
];

beforeAll(async () => {
  prom = await startFakePrometheus();
  hole = await blackhole();
  docker = await httpServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname.endsWith("/version")) return json(res, 200, { ApiVersion: "1.45", Version: "FAKE" });
    if (u.pathname.endsWith("/containers/json")) return json(res, 200, CONTAINERS);
    return json(res, 404, { message: "not found" });
  });
  svc = await import("@/features/integrations/service");
  cat = await import("../catalogue");
  routes = await import("../catalogue-routes");
  promId = svc.createIntegration(owner, { packageId: "prometheus", name: "Lab Prometheus", config: { baseUrl: prom.url }, secrets: {}, untested: true }).id;
  svc.updateIntegration(owner, promId, { shared: true });
  slowId = svc.createIntegration(owner, { packageId: "prometheus", name: "Silent Prometheus", config: { baseUrl: hole.url }, secrets: {}, untested: true }).id;
  svc.updateIntegration(owner, slowId, { shared: true });
  dockerId = svc.createIntegration(owner, { packageId: "docker", name: "Docker FAKE", config: { endpoint: docker.url.replace("http://", "tcp://") }, secrets: {}, untested: true }).id;
  svc.updateIntegration(owner, dockerId, { shared: true });
  // Not shared: only the owner and its creator may bind it.
  privateId = svc.createIntegration(owner, { packageId: "prometheus", name: "Private Prometheus", config: { baseUrl: prom.url }, secrets: {}, untested: true }).id;
}, 60_000);
afterAll(async () => { await prom.close(); await hole.close(); await docker.close(); });

async function search(caller: string, q: Record<string, string>) {
  const res = await routes.handleCatalogue(new Request(`http://127.0.0.1:3113/api/data/catalogue?${new URLSearchParams(q).toString()}`, { headers: { "x-test-caller": caller } }));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as CatalogueResponse & { error?: unknown }, text };
}

async function peekReq(caller: string, items: unknown[]) {
  const res = await routes.handlePeek(new Request("http://127.0.0.1:3113/api/data/peek", { method: "POST", headers: { "x-test-caller": caller, "content-type": "application/json" }, body: JSON.stringify({ items }) }));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as { values: { key: string; data?: { kind: string; value?: number }; error?: string }[] }, text };
}

describe("catalogue: who may search", () => {
  it("answers 401 signed out and the same 404 to viewers and agents without atrium:edit", async () => {
    expect((await search("nobody", {})).status).toBe(401);
    const v = await search("viewer", {});
    const a = await search("readOnlyAgent", {});
    expect(v.status).toBe(404);
    expect(a.status).toBe(404);
    expect(v.text).toBe(a.text);
    expect((await peekReq("viewer", [{ integrationId: promId, endpointId: "machine-cpu", params: { machine: "10.77.99.8:9100" } }])).status).toBe(404);
  });

  it("follows the sharing rule: a member never sees an unshared integration; the owner does", async () => {
    const m = await search("otherMember", { q: "cpu", limit: "200" });
    expect(m.status).toBe(200);
    expect(m.body.items.some((i) => i.integrationId === privateId)).toBe(false);
    expect(m.body.services.some((s) => s.integrationId === privateId)).toBe(false);
    const o = await search("owner", { q: "cpu", integrationId: privateId });
    expect(o.body.items.some((i) => i.integrationId === privateId)).toBe(true);
    // Peek refuses it to the member in words, without saying whether it exists.
    const pk = await peekReq("otherMember", [{ integrationId: privateId, endpointId: "machine-cpu", params: { machine: "10.77.99.8:9100" } }]);
    expect(pk.body.values[0]!.error).toBe("That read does not exist.");
  });

  it("an agent with atrium:edit gets the same answer as its person", async () => {
    const r = await search("agent", { q: "cpu pve1" });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
  });

  it("never carries config or secrets", async () => {
    const r = await search("owner", { limit: "200" });
    expect(r.text).not.toContain("baseUrl");
    expect(r.text).not.toContain('"config"');
    expect(r.text).not.toContain("secret");
    // The only address that leaves is a service's Open address (not config, A10.5); Docker's API address never does.
    const withoutOpen = r.text.replace(/"openUrl":"[^"]*"/g, "");
    expect(withoutOpen).not.toContain(prom.url);
    expect(r.text).not.toContain(docker.url.replace("http://", ""));
  });
});

describe("catalogue: things, ranking and fit", () => {
  it("expands the first choices param into one item per machine plus Every machine", async () => {
    const r = await search("owner", { q: "cpu", integrationId: promId, limit: "200" });
    const cpu = r.body.items.filter((i) => i.endpointId === "machine-cpu");
    expect(cpu.map((i) => i.thing?.label)).toEqual(expect.arrayContaining(["ACE", "pve1", "pve2", "pve3", "RP5-3", "Every machine"]));
    const pve1 = cpu.find((i) => i.thing?.label === "pve1")!;
    expect(pve1.params).toEqual({ machine: "10.77.99.4:9100" });
    expect(pve1.key).toBe(`${promId}|machine-cpu|{"machine":"10.77.99.4:9100"}`);
    expect(pve1.measure).toBe("cpu");
    expect(pve1.shape).toBe("stat");
    const every = cpu.find((i) => i.thing?.value === "*")!;
    expect(every.shape).toBe("table");
  });

  it("every word must match: 'cpu pve1' names the read and the thing", async () => {
    const r = await search("owner", { q: "cpu pve1", integrationId: promId });
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const i of r.body.items) expect(`${i.label} ${i.thing?.label ?? ""} ${i.thing?.detail ?? ""} ${i.group ?? ""}`.toLowerCase()).toContain("pve1");
    expect(r.body.items[0]!.label).toBe("CPU in use");
  });

  it("fitting items come first, and a chart fits a value read through its history", async () => {
    const r = await search("owner", { q: "memory", fits: "stat", integrationId: promId, limit: "200" });
    const firstMiss = r.body.fits.indexOf(false);
    if (firstMiss >= 0) expect(r.body.fits.slice(firstMiss).every((f) => !f)).toBe(true);
    r.body.items.forEach((it, i) => expect(r.body.fits[i]).toBe(it.shape === "stat"));
    const c = await search("owner", { q: "cpu pve1", fits: "chart", integrationId: promId });
    const stat = c.body.items.findIndex((i) => i.endpointId === "machine-cpu");
    expect(c.body.items[stat]!.history?.endpointId).toBe("h:machine-cpu");
    expect(c.body.fits[stat]).toBe(true);
  });

  it("an unknown component type fits nothing", async () => {
    const r = await search("owner", { q: "cpu", fits: "not-a-component" });
    expect(r.body.fits.every((f) => f === false)).toBe(true);
    expect(cat.fitsType("service-tile-unknown", { shape: "status" })).toBe(false);
  });

  it("filters by measure and lists reads from two services for a shared word", async () => {
    const r = await search("owner", { measure: "count", limit: "200" });
    expect(r.body.items.every((i) => i.measure === "count")).toBe(true);
    const d = await search("owner", { q: "running" });
    expect(new Set(d.body.items.map((i) => i.packageId))).toContain("docker");
  });

  it("lists services with kind, icon, open address and headline stats", async () => {
    const r = await search("owner", {});
    const d = r.body.services.find((s) => s.integrationId === dockerId)!;
    expect(d.kind).toBe("containers");
    expect(d.icon).toBe("docker");
    expect(d.headline.map((h) => h.label)).toEqual(["Running", "Stopped", "Total"]);
    const p = r.body.services.find((s) => s.integrationId === promId)!;
    expect(p.kind).toBe("monitoring");
    expect(p.openUrl).toBe(`${prom.url}/`);
    expect(r.body.services.some((s) => s.integrationId === "atrium")).toBe(true);
  });

  it("answers within the 3 s budget and names a silent service as pending", async () => {
    const t = Date.now();
    const r = await search("owner", { q: "cpu" });
    expect(Date.now() - t).toBeLessThan(4500);
    expect(r.body.pending).toContain(slowId);
    const slow = r.body.items.filter((i) => i.integrationId === slowId);
    for (const i of slow) expect(i.thing).toBeUndefined();
  }, 15_000);
});

describe("peek", () => {
  it("answers live values by catalogue key through the cache", async () => {
    const r = await peekReq("owner", [
      { integrationId: promId, endpointId: "machine-cpu", params: { machine: "10.77.99.8:9100" } },
      { integrationId: dockerId, endpointId: "running", params: {} },
      { integrationId: promId, endpointId: "no-such-read", params: {} },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.values[0]).toMatchObject({ key: `${promId}|machine-cpu|{"machine":"10.77.99.8:9100"}`, data: { kind: "stat", value: 7.8 } });
    expect(r.body.values[1]!.data).toMatchObject({ kind: "stat", value: 2 });
    expect(r.body.values[2]!.error).toBeTruthy();
  });

  it("refuses more than 20 items", async () => {
    const items = Array.from({ length: 21 }, () => ({ integrationId: promId, endpointId: "machine-cpu", params: {} }));
    expect((await peekReq("owner", items)).status).toBe(400);
  });

  it("says no answer within 3 s for a silent service", async () => {
    const t = Date.now();
    const r = await peekReq("owner", [{ integrationId: slowId, endpointId: "alerts-count", params: {} }]);
    expect(Date.now() - t).toBeLessThan(4500);
    expect(r.body.values[0]!.error).toMatch(/3 seconds|answer/);
  }, 15_000);
});
