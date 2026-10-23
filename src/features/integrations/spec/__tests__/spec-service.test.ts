// Spec import v2 on a real throwaway database against the Shelfarr stand-in (criteria 10, 11, 13,
// 14): preview by probing, by spec URL (JSON and YAML) and from text; import with the API key;
// reads work with no Try it; changes only when picked; viewers, guests' lack of a session aside,
// and agents without atrium:edit get not found. Test-only key; not a credential.
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "../../__tests__/db-harness";
import { FAKE_REST_KEY, startFakeRest, toYaml, FAKE_REST_SPEC, type FakeRest } from "../../../../../tests/e2e/fixtures/fake-rest";

setupTestDb();

const owner: Principal = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const member: Principal = { kind: "user", userId: "u-member", role: "member", via: "session" };
const viewer: Principal = { kind: "user", userId: "u-viewer", role: "viewer", via: "session" };
const readAgent: Principal = { kind: "agent", userId: "u-owner", role: "owner", via: "pat", tokenId: "t0", agentName: "Reader", scopes: ["atrium:read"] };
const editAgent: Principal = { kind: "agent", userId: "u-owner", role: "owner", via: "pat", tokenId: "t1", agentName: "Builder", scopes: ["atrium:read", "atrium:edit"] };

let svc: typeof import("../service");
let runtime: typeof import("../../runtime");
let repo: typeof import("../../repo");
let rest: FakeRest;

function jsYaml() {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const eslintrc = path.dirname(req.resolve("@eslint/eslintrc/package.json", { paths: [path.join(process.cwd(), "node_modules/eslint")] }));
  return createRequire(path.join(eslintrc, "package.json"))("js-yaml");
}

beforeAll(async () => {
  const yaml = await import("../yaml");
  yaml.setYamlLoader(yaml.safeLoaderFrom(jsYaml()));
  svc = await import("../service");
  runtime = await import("../../runtime");
  repo = await import("../../repo");
  rest = await startFakeRest();
});
afterAll(async () => { await rest.close(); });

describe("permissions (criterion 13)", () => {
  it("viewers and agents without atrium:edit get not found from preview and import", async () => {
    for (const p of [viewer, readAgent]) {
      await expect(svc.previewSpec(p, { address: rest.url })).rejects.toMatchObject({ status: 404 });
      await expect(svc.importHeldSpec(p, { specId: "sp_x", name: "x", baseUrl: rest.url })).rejects.toMatchObject({ status: 404 });
    }
  });
  it("a held spec belongs to the person who read it", async () => {
    const pv = await svc.previewSpec(owner, { address: rest.url });
    await expect(svc.importHeldSpec(member, { specId: pv.specId, name: "Shelfarr", baseUrl: rest.url })).rejects.toMatchObject({ status: 400 });
  });
});

describe("finding and reading the spec", () => {
  it("probes the address and finds /openapi.json", async () => {
    const pv = await svc.previewSpec(owner, { address: rest.url });
    expect(pv.specUrl).toBe(`${rest.url}/openapi.json`);
    expect(pv.title).toBe("Shelfarr");
    expect(pv.reads.slice(0, pv.totals.headline).every((r) => r.headline)).toBe(true);
    expect(pv.totals.commands).toBe(4);
  });
  it("a pasted YAML spec URL gives the same preview as the JSON one (criterion 9)", async () => {
    const a = await svc.previewSpec(owner, { specUrl: `${rest.url}/openapi.json` });
    const b = await svc.previewSpec(owner, { specUrl: `${rest.url}/docs/spec.yaml` });
    const c = await svc.previewSpec(owner, { text: toYaml(FAKE_REST_SPEC) });
    const strip = (x: typeof a) => ({ ...x, specId: "", specUrl: "" });
    expect(strip(b)).toEqual(strip(a));
    expect(strip(c)).toEqual(strip(a));
  });
  it("names the problem with a bad spec, an unreachable address and a blocked one", async () => {
    await expect(svc.previewSpec(owner, { text: '{"nope": true}' })).rejects.toThrow(/not an OpenAPI or Swagger spec/);
    await expect(svc.previewSpec(owner, { specUrl: `${rest.url}/missing.json` })).rejects.toMatchObject({ status: 400 });
    await expect(svc.previewSpec(owner, { specUrl: "http://169.254.169.254/openapi.json" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("import (criteria 10, 11, 14)", () => {
  let integrationId = "";
  it("imports every read with the key, tested first, and the reads answer with no Try it", async () => {
    const pv = await svc.previewSpec(owner, { address: rest.url });
    const before = rest.writes;
    const out = await svc.importHeldSpec(owner, { specId: pv.specId, name: "Shelfarr", baseUrl: rest.url, authKey: pv.auth[0]!.key, secret: FAKE_REST_KEY });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    integrationId = out.integrationId;
    expect(out.added).toBe(pv.reads.length);
    expect(out.commands.added).toEqual([]);
    expect(rest.writes).toBe(before);
    // No change became a command (criterion 10).
    expect(repo.listCustomCommandRows(integrationId)).toHaveLength(0);
    const status = await runtime.readEndpoint(integrationId, "system-status", {});
    expect(status).toMatchObject({ ok: true, data: { kind: "status", items: [{ state: "up" }] } });
    const series = await runtime.readEndpoint(integrationId, "series", {});
    expect(series).toMatchObject({ ok: true, data: { kind: "table" } });
    if (series.ok && series.data.kind === "table") {
      expect(series.data.columns.find((c) => c.key === "sizeondisk")).toMatchObject({ format: "bytes" });
      expect(series.data.columns.find((c) => c.key === "added")).toMatchObject({ type: "time" });
    }
    const one = await runtime.readEndpoint(integrationId, "series-by-id", { id: "2" });
    expect(one).toMatchObject({ ok: true, data: { kind: "status", items: [{ label: "Severance" }] } });
    const count = await runtime.readEndpoint(integrationId, "queue-count", {});
    expect(count).toMatchObject({ ok: true, data: { kind: "stat", value: 2 } });
    expect(rest.hits.filter((h) => h.path.startsWith("/api/v1/") && h.path !== "/api/v1/openapi.yaml").every((h) => h.key)).toBe(true);
    // The listing gives the detail read its dropdown and the config its spec title.
    const eps = runtime.endpointsOf({ id: integrationId, packageId: "custom-api" });
    const detail = eps.find((e) => e.id === "series-by-id")!;
    expect((detail.params as { properties: Record<string, Record<string, unknown>> }).properties.id!["x-atrium-choices"]).toEqual({ endpointId: "series", value: "id", label: "title" });
    expect(repo.getIntegrationRow(integrationId)!.config.specTitle).toBe("Shelfarr");
    // No secret value, no config in the outcome (criterion 14).
    expect(JSON.stringify(out)).not.toContain(FAKE_REST_KEY);
    expect(JSON.stringify(out)).not.toContain(rest.url);
  });
  it("the live check marks the read the server does not answer as failed", async () => {
    const pv = await svc.previewSpec(owner, { address: rest.url });
    const out = await svc.importHeldSpec(owner, { specId: pv.specId, integrationId, readIds: pv.reads.map((r) => r.id) });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.check.results) return;
    expect(out.check.results.tag).toMatchObject({ status: "failed" });
    expect(out.check.results["system-status"]).toMatchObject({ status: "ok" });
    expect(Object.values(out.check.results).filter((c) => c.status === "ok").length).toBeGreaterThanOrEqual(8);
  });
  it("a change becomes a command only when picked, with the risk the owner set", async () => {
    const pv = await svc.previewSpec(owner, { address: rest.url });
    const run = pv.commands.find((c) => c.path === "/api/v1/command")!;
    const del = pv.commands.find((c) => c.method === "DELETE")!;
    await expect(svc.importHeldSpec(owner, { specId: pv.specId, integrationId, commands: [{ id: del.id, risk: "low" }] })).rejects.toThrow(/cannot be added automatically/);
    const out = await svc.importHeldSpec(owner, { specId: pv.specId, integrationId, commands: [{ id: run.id, risk: "medium" }] });
    expect(out.ok && out.commands.added).toEqual([run.id]);
    const rows = repo.listCustomCommandRows(integrationId);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('"risk":"medium"');
  });
  it("a wrong key fails the test and saves nothing", async () => {
    const pv = await svc.previewSpec(owner, { address: rest.url });
    const n = repo.listIntegrationRows().length;
    const out = await svc.importHeldSpec(owner, { specId: pv.specId, name: "Shelfarr wrong", baseUrl: rest.url, authKey: pv.auth[0]!.key, secret: "atrium-v10-FAKE-wrong-key" });
    expect(out).toMatchObject({ ok: false, error: { code: "auth" } });
    expect(repo.listIntegrationRows().length).toBe(n);
  });
  it("an agent with atrium:edit makes a draft without credentials", async () => {
    const pv = await svc.previewSpec(editAgent, { address: rest.url });
    const out = await svc.importHeldSpec(editAgent, { specId: pv.specId, name: "Shelfarr agent", baseUrl: rest.url, secret: FAKE_REST_KEY });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const row = repo.getIntegrationRow(out.integrationId)!;
    expect(row.status).toBe("draft");
    expect(row.secretFields).toEqual([]);
    expect(repo.listCustomEndpoints(out.integrationId).every((e) => !e.auth)).toBe(true);
  });
});
