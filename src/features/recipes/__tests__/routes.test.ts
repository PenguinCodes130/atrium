// Criterion 13 at the route level: every /api/recipes route answers not found to viewers, guests and
// signed-out callers; agents without atrium:edit cannot import, export or turn on. Criterion 14: no
// response carries the integration's address. Real schema; the caller is chosen per request.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { agent, member, owner, viewer } from "@/features/controls/__tests__/harness";
import { startFakePrometheus, type FakePrometheus } from "../../../../tests/e2e/fixtures/fake-prometheus";
import { sampleRecipe, setupRecipeDb } from "./harness";

setupRecipeDb();
const readOnlyAgent = { ...agent, scopes: ["atrium:read"] } as Principal;
const callers: Record<string, Principal | null> = { owner, member, viewer, agent, readOnlyAgent, nobody: null };
vi.mock("@/features/auth", () => ({ getPrincipal: async (req: Request) => callers[req.headers.get("x-test-caller") ?? "nobody"] ?? null }));

let prom: FakePrometheus;
let promId: string;
type Handler = (req: Request) => Promise<Response> | Response;
let routes: Record<string, { GET?: Handler; POST?: Handler }>;

beforeAll(async () => {
  prom = await startFakePrometheus();
  const isvc = await import("@/features/integrations/service");
  promId = isvc.createIntegration(owner, { packageId: "prometheus", name: "Lab", config: { baseUrl: prom.url }, secrets: {}, untested: true }).id;
  routes = {
    list: await import("@/app/api/recipes/route"), import: await import("@/app/api/recipes/import/route"), grafana: await import("@/app/api/recipes/grafana/route"),
    status: await import("@/app/api/recipes/status/route"), export: await import("@/app/api/recipes/export/route"), delete: await import("@/app/api/recipes/delete/route"), check: await import("@/app/api/recipes/check/route"),
  };
}, 60_000);
afterAll(() => prom.close());

const req = (caller: string, path: string, body?: unknown) => new Request(`http://127.0.0.1:3113${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-test-caller": caller, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("recipe routes", () => {
  const calls = () => [
    ["list", "GET", `/api/recipes?integrationId=${promId}`, undefined],
    ["import", "POST", "/api/recipes/import", { text: JSON.stringify(sampleRecipe({ id: "route/x" })) }],
    ["grafana", "POST", "/api/recipes/grafana", { integrationId: promId, dashboardId: "1860" }],
    ["status", "POST", "/api/recipes/status", { id: "prometheus/cadvisor", status: "draft" }],
    ["export", "GET", "/api/recipes/export?id=prometheus/node-exporter", undefined],
    ["delete", "POST", "/api/recipes/delete", { id: "route/x" }],
    ["check", "GET", `/api/recipes/check?integrationId=${promId}`, undefined],
    ["check", "POST", "/api/recipes/check", { integrationId: promId }],
  ] as const;
  it("viewers and signed-out callers get not found from every route", async () => {
    for (const who of ["viewer", "nobody"]) {
      for (const [name, method, path, body] of calls()) {
        const res = await routes[name]![method]!(req(who, path, body));
        expect([name, method, res.status]).toEqual([name, method, 404]);
      }
    }
  });
  it("agents without edit list but cannot import, export or turn on; agents with edit import drafts", async () => {
    expect((await routes.list!.GET!(req("readOnlyAgent", `/api/recipes?integrationId=${promId}`))).status).toBe(200);
    expect((await routes.import!.POST!(req("readOnlyAgent", "/api/recipes/import", { text: JSON.stringify(sampleRecipe({ id: "route/ro" })) }))).status).toBe(403);
    expect((await routes.export!.GET!(req("readOnlyAgent", "/api/recipes/export?id=prometheus/node-exporter"))).status).toBe(403);
    expect((await routes.status!.POST!(req("agent", "/api/recipes/status", { id: "prometheus/cadvisor", status: "draft" }))).status).toBe(403);
    const r = await routes.import!.POST!(req("agent", "/api/recipes/import", { text: JSON.stringify(sampleRecipe({ id: "route/agent" })) }));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: "route/agent", status: "draft" });
  });
  it("owners import, see 409 for the same id, turn on, export a file; no response has the address", async () => {
    const texts: string[] = [];
    const a = await routes.import!.POST!(req("owner", "/api/recipes/import", { text: JSON.stringify(sampleRecipe({ id: "route/own" })), integrationId: promId }));
    texts.push(await a.clone().text());
    expect(a.status).toBe(201);
    const again = await routes.import!.POST!(req("member", "/api/recipes/import", { text: JSON.stringify(sampleRecipe({ id: "route/own", version: "2.0.0" })) }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "recipe_exists" }, existing: { id: "route/own", version: "1.0.0" }, incoming: { version: "2.0.0" } });
    const bad = await routes.import!.POST!(req("owner", "/api/recipes/import", { text: JSON.stringify(sampleRecipe({ id: "route/bad", appliesTo: { pkg: "x" } })) }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_recipe", field: "appliesTo" } });
    expect((await routes.status!.POST!(req("member", "/api/recipes/status", { id: "route/own", status: "active", integrationId: promId }))).status).toBe(200);
    const ex = await routes.export!.GET!(req("owner", "/api/recipes/export?id=route/own"));
    expect(ex.headers.get("content-disposition")).toBe('attachment; filename="route-own.atrium-recipe.json"');
    texts.push(await ex.text());
    const list = await routes.list!.GET!(req("owner", `/api/recipes?integrationId=${promId}`));
    texts.push(await list.text());
    texts.push(await (await routes.check!.GET!(req("owner", `/api/recipes/check?integrationId=${promId}`))).text());
    for (const t of texts) { expect(t).not.toContain(prom.url); expect(t).not.toContain("baseUrl"); }
  });
});
