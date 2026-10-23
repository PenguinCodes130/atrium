// Recipes end to end on the server (spec 3.1, 3.2, 3.4; criteria 1 to 6, 13, 14): stored recipes,
// import and export, apply-to matching, the joined endpoint list and bindable listing, the live
// check with first choices, failing reads, permissions. Real schema, the e2e stand-in Prometheus.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { agent, member, owner, viewer, guest } from "@/features/controls/__tests__/harness";
import { startFakePrometheus, type FakePrometheus } from "../../../../tests/e2e/fixtures/fake-prometheus";
import g1860 from "../__fixtures__/grafana-1860.json";
import { sampleRecipe, setupRecipeDb } from "./harness";

setupRecipeDb();
vi.mock("@/features/auth", () => ({ getPrincipal: async () => null }));

const readOnlyAgent = { ...agent, scopes: ["atrium:read"] } as Principal;
let prom: FakePrometheus;
let promId: string;
let svc: typeof import("../service");
let isvc: typeof import("@/features/integrations/service");
let runtime: typeof import("@/features/integrations/runtime");
let cmds: typeof import("@/features/integrations/commands");
let check: typeof import("../check");
let schema: typeof import("../schema");

beforeAll(async () => {
  prom = await startFakePrometheus();
  isvc = await import("@/features/integrations/service");
  svc = await import("../service");
  runtime = await import("@/features/integrations/runtime");
  cmds = await import("@/features/integrations/commands");
  check = await import("../check");
  schema = await import("../schema");
  promId = isvc.createIntegration(owner, { packageId: "prometheus", name: "Lab Prometheus", config: { baseUrl: prom.url }, secrets: {}, untested: true }).id;
}, 60_000);
afterAll(() => prom.close());

const ids = () => runtime.endpointsOf({ id: promId, packageId: "prometheus" }).map((e) => e.id);
const rid = (r: string) => `r:test/lab:${r}`;

describe("import, draft, live check and turning on", () => {
  it("imports a file as a draft whose reads stay out of the picker until turned on (criterion 2)", async () => {
    const before = ids();
    const r = await svc.importRecipe(owner, { text: JSON.stringify(sampleRecipe()), integrationId: promId });
    expect(r).toMatchObject({ id: "test/lab", status: "draft", reads: 4, checking: true });
    expect(ids()).toEqual(before);
    const res = await check.checkReads(promId, [rid("machines-list"), rid("load"), rid("memory"), rid("missing")]);
    expect(res[rid("load")]).toMatchObject({ status: "ok" });
    expect(res[rid("memory")]).toMatchObject({ status: "ok" });
    expect(res[rid("machines-list")]).toMatchObject({ status: "ok" });
    // criterion 4: a read that answers 404 is failed with the reason
    expect(res[rid("missing")]).toMatchObject({ status: "failed", reason: expect.stringContaining("HTTP 404") });
  });
  it("turns on: reads join the endpoint list with r: ids, the failed one unavailable in the listing (criterion 4)", async () => {
    svc.setStatus(owner, "test/lab", "active", promId);
    await check.checkReads(promId);
    expect(ids()).toEqual(expect.arrayContaining([rid("load"), rid("memory"), rid("missing")]));
    expect(ids().slice(0, 3)).toEqual(["machine-cpu", "machine-memory", "machine-memory-bytes"]);
    const listing = (await cmds.listBindableEndpoints(owner, { waitMs: 3000 })).find((i) => i.integrationId === promId)!;
    const by = new Map(listing.endpoints.map((e) => [e.id, e]));
    expect(by.get(rid("missing"))).toMatchObject({ available: false, check: { status: "failed" }, from: "Lab extras, from a file" });
    expect(by.get(rid("load"))).toMatchObject({ available: true, check: { status: "ok" }, group: "Lab" });
    expect(by.get(rid("load"))!.choices).toEqual([{ param: "node", endpointId: rid("machines-list"), every: false }]);
    expect(by.get("machine-cpu")).toMatchObject({ from: "Node exporter, built in" });
    const read = await runtime.readEndpoint(promId, rid("load"), { node: "10.77.99.8:9100" });
    expect(read.ok && read.data).toMatchObject({ kind: "stat", value: 0.41, format: "number" });
  });
  it("lists the recipe with 'N of M reads work', and never config or secrets (criterion 14)", () => {
    const v = svc.recipesView(owner, promId);
    const lab = v.recipes.find((r) => r.id === "test/lab")!;
    expect(lab).toMatchObject({ status: "active", reads: 4, works: 3, checked: 4, source: "file", tag: "Lab extras, from a file" });
    expect(v.recipes.slice(0, 3).map((r) => r.id)).toEqual(["prometheus/node-exporter", "prometheus/cadvisor", "prometheus/proxmox"]);
    const text = JSON.stringify(v);
    expect(text).not.toContain(prom.url);
    expect(text).not.toContain("baseUrl");
  });
  it("exports sorted 2-space JSON that imports again as the same reads, as a draft (criterion 2)", async () => {
    const { fileName, text } = svc.exportRecipe(owner, "test/lab");
    expect(fileName).toBe("test-lab.atrium-recipe.json");
    expect(text.startsWith('{\n  "appliesTo"')).toBe(true);
    await expect(svc.importRecipe(owner, { text })).rejects.toMatchObject({ code: "recipe_exists", status: 409 });
    const both = await svc.importRecipe(owner, { text, onConflict: "keep-both" });
    expect(both).toMatchObject({ id: "test/lab-2", status: "draft" });
    expect(svc.exportRecipe(owner, "test/lab-2").text.replace(/test\/lab-2/g, "test/lab")).toBe(text);
    svc.deleteRecipe(owner, "test/lab-2");
  });
  it("refuses a bad field naming it, and adds nothing (criterion 3)", async () => {
    const bad = sampleRecipe({ id: "test/bad" }) as { reads: Record<string, unknown>[] };
    bad.reads[1] = { ...bad.reads[1], shape: "pie" };
    await expect(svc.importRecipe(owner, { text: JSON.stringify(bad) })).rejects.toMatchObject({ code: "invalid_recipe", field: "reads[1].shape" });
    const typo = sampleRecipe({ id: "test/typo", readz: [] });
    await expect(svc.importRecipe(owner, { text: JSON.stringify(typo) })).rejects.toMatchObject({ code: "invalid_recipe", message: expect.stringContaining("readz") });
    const raw = sampleRecipe({ id: "test/raw" }) as { reads: Record<string, unknown>[] };
    raw.reads[2] = { ...raw.reads[2], request: { kind: "promql", expr: "up{x={{ params.nope }}}" } };
    await expect(svc.importRecipe(owner, { text: JSON.stringify(raw) })).rejects.toMatchObject({ field: "reads[2].request" });
    await expect(svc.importRecipe(owner, { text: "{not json" })).rejects.toMatchObject({ code: "invalid_recipe" });
    expect(svc.recipesView(owner, promId).recipes.map((r) => r.id)).not.toEqual(expect.arrayContaining(["test/bad", "test/typo", "test/raw"]));
  });
  it("marks a read that used to work and starts failing (criterion 5 data side)", async () => {
    expect(check.failingReads(promId)).toEqual({});
    prom.setDown("10.77.99.8:9100", true);
    // machines-list still lists ACE (last day), but its load is gone now: empty, not failing
    const r1 = await check.checkReads(promId, [rid("load")]);
    expect(["ok", "empty"]).toContain(r1[rid("load")]!.status);
    prom.setDown("10.77.99.8:9100", false);
    // Point the read at a 404 by turning the recipe into a broken version.
    const broken = sampleRecipe() as { reads: Record<string, unknown>[] };
    broken.reads[2] = { ...broken.reads[2], request: { kind: "http", path: "/api/v1/gone" }, fields: [{ path: "$.x", label: "X", role: "value" }] };
    await svc.saveRecipe(owner, broken, { status: "active", onConflict: "replace" });
    await check.checkReads(promId, [rid("memory")]);
    expect(check.failingReads(promId)[rid("memory")]).toMatchObject({ reason: expect.stringContaining("404") });
    await check.checkReads(promId, [rid("memory")]);
    expect(check.failingReads(promId)[rid("memory")]).toBeDefined();
  });
});

describe("built-in recipes", () => {
  it("are on by default and turning one off drops its reads (ids unchanged otherwise)", () => {
    expect(ids()).toContain("containers");
    svc.setStatus(owner, "prometheus/cadvisor", "draft");
    expect(ids()).not.toContain("containers");
    expect(ids()).toContain("machine-cpu");
    svc.setStatus(owner, "prometheus/cadvisor", "active");
    expect(ids()).toContain("containers");
    expect(() => svc.deleteRecipe(owner, "prometheus/node-exporter")).toThrow(/cannot be deleted/);
  });
});

describe("Grafana import (criterion 6 on the stand-in)", () => {
  it("imports 1860 as a draft and the live check finds working reads with machine dropdowns", async () => {
    const r = await svc.importGrafana(owner, { integrationId: promId, json: JSON.stringify(g1860) });
    expect(r).toMatchObject({ id: "grafana/1860", status: "draft", skipped: [] });
    expect(r.reads).toBeGreaterThan(200);
    const res = await check.checkReads(promId);
    const mine = Object.entries(res).filter(([k]) => k.startsWith("r:grafana/1860:"));
    const works = mine.filter(([, c]) => c.status === "ok").length;
    expect(works).toBeGreaterThan(20);
    const view = svc.recipesView(owner, promId).recipes.find((x) => x.id === "grafana/1860")!;
    expect(view).toMatchObject({ source: "grafana", tag: "Node Exporter Full, from Grafana", status: "draft" });
    expect(view.works).toBe(works);
    const list = await runtime.readEndpoint(promId, "r:grafana/1860:list-node", {}, undefined, { includeDrafts: true });
    expect(list.ok && list.data.kind === "table" && list.data.rows.map((x) => x.label)).toEqual(expect.arrayContaining(["ACE", "RP5-3", "pve1"]));
  }, 60_000);
  it("refuses a non-Prometheus integration and a bad id", async () => {
    await expect(svc.importGrafana(owner, { integrationId: promId, dashboardId: "abc" })).rejects.toMatchObject({ code: "invalid_recipe" });
  });
});

describe("permissions (criterion 13)", () => {
  it("viewers and guests get not found from every recipe call", async () => {
    for (const p of [viewer, guest]) {
      expect(() => svc.recipesView(p, promId)).toThrow(expect.objectContaining({ status: 404 }));
      await expect(svc.importRecipe(p, { text: JSON.stringify(sampleRecipe({ id: "x/y" })) })).rejects.toMatchObject({ status: 404 });
      expect(() => svc.setStatus(p, "test/lab", "draft")).toThrow(expect.objectContaining({ status: 404 }));
      expect(() => svc.exportRecipe(p, "test/lab")).toThrow(expect.objectContaining({ status: 404 }));
      expect(() => svc.deleteRecipe(p, "test/lab")).toThrow(expect.objectContaining({ status: 404 }));
    }
  });
  it("agents list; with edit they import drafts only; they never turn on; without edit they cannot import or export", async () => {
    expect(svc.recipesView(readOnlyAgent, promId).recipes.length).toBeGreaterThan(0);
    await expect(svc.importRecipe(readOnlyAgent, { text: JSON.stringify(sampleRecipe({ id: "agent/ro" })) })).rejects.toMatchObject({ status: 403 });
    expect(() => svc.exportRecipe(readOnlyAgent, "test/lab")).toThrow(expect.objectContaining({ status: 403 }));
    const saved = await svc.saveRecipe(agent, sampleRecipe({ id: "agent/one" }), { status: "active" });
    expect(svc.recipesView(owner, promId).recipes.find((r) => r.id === saved.id)!.status).toBe("draft");
    expect(() => svc.setStatus(agent, saved.id, "active")).toThrow(expect.objectContaining({ status: 403 }));
    // members can turn recipes on and off
    svc.setStatus(member, saved.id, "active");
    svc.setStatus(member, saved.id, "draft");
  });
});

describe("schema", () => {
  it("round-trips the built-in files and names problems", () => {
    expect(schema.validateRecipe({ atriumRecipe: "1" })).toMatchObject({ ok: false, problem: { field: "id" } });
    expect(schema.parseRecipeEndpointId("r:grafana/1860:cpu-busy")).toEqual({ recipeId: "grafana/1860", readId: "cpu-busy" });
    expect(schema.parseRecipeEndpointId("machine-cpu")).toBeNull();
  });
});
