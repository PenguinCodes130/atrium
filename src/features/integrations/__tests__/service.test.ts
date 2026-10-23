// Service-level tests on a real throwaway database: secrets, drafts, credential links, agent tools,
// declarative packages. Test-only secret values; none are real credentials.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";
import { httpServer, json } from "../host/__tests__/servers";

setupTestDb();

const owner: Principal = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const viewer: Principal = { kind: "user", userId: "u-viewer", role: "viewer", via: "session" };
const agent: Principal = { kind: "agent", userId: "u-owner", role: "owner", via: "pat", tokenId: "t1", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };
const FAKE_TOKEN = "atrium-unit-FAKE-npm-token-5d41402abc4b2a76";

let svc: typeof import("../service");
let tools: typeof import("../tools");
let api: Awaited<ReturnType<typeof httpServer>>;

beforeAll(async () => {
  svc = await import("../service");
  tools = await import("../tools");
  api = await httpServer((req, res) => {
    if (req.url?.startsWith("/api/users/me")) return req.headers.authorization === `Bearer ${FAKE_TOKEN}` ? json(res, 200, { id: 1 }) : json(res, 401, { error: { message: "Invalid token" } });
    if (req.url === "/api/") return json(res, 200, { status: "OK", version: { major: 2, minor: 12, revision: 6 } });
    if (req.url?.startsWith("/stats")) return json(res, 200, { load: 0.25, echo: req.headers.authorization ?? null });
    json(res, 404, {});
  });
});

// Every agent tool response is recorded for the V10 grep.
const TRAFFIC = path.resolve(__dirname, "../../../../evidence/integrations/r6/traffic/agent-tools.jsonl");
mkdirSync(path.dirname(TRAFFIC), { recursive: true });
writeFileSync(TRAFFIC, "");

function tool(name: string) {
  const t = tools.integrationTools.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return async (p: Principal, input: unknown) => {
    try {
      const out = await t.handler({ principal: p, signal: new AbortController().signal }, t.input.parse(input));
      // The one-time credentials link token is replaced; everything else is recorded as returned.
      appendFileSync(TRAFFIC, `${JSON.stringify({ tool: name, out: t.output.parse(out) }).replace(/draft=[A-Za-z0-9_-]+/g, "draft=[link-token]")}\n`);
      return out;
    } catch (err) {
      appendFileSync(TRAFFIC, `${JSON.stringify({ tool: name, error: (err as Error).message })}\n`);
      throw err;
    }
  };
}

describe("saving and secrets", () => {
  it("can save only after a passed test, or with Save without testing (then Untested)", async () => {
    expect(() => svc.createIntegration(owner, { packageId: "npm", name: "NPM", config: { baseUrl: api.url }, secrets: { token: FAKE_TOKEN } })).toThrow(/Test the connection first/);
    const untested = svc.createIntegration(owner, { packageId: "npm", name: "NPM", config: { baseUrl: api.url }, secrets: { token: FAKE_TOKEN }, untested: true });
    expect(untested).toMatchObject({ untested: true, status: "active" });
    expect(untested.lastHealth).toBeUndefined();
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: api.url }, secrets: { token: FAKE_TOKEN } });
    expect(t).toMatchObject({ ok: true, health: { status: "ok", version: "2.12.6" } });
    // A pass only counts for the exact config and secrets that were tested.
    if (t.ok) expect(() => svc.createIntegration(owner, { packageId: "npm", name: "NPM", config: { baseUrl: api.url }, secrets: { token: "different" }, passId: t.passId })).toThrow(/Test the connection first/);
    const t2 = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: api.url }, secrets: { token: FAKE_TOKEN } });
    const tested = svc.createIntegration(owner, { packageId: "npm", name: "NPM 2", config: { baseUrl: api.url }, secrets: { token: FAKE_TOKEN }, passId: t2.ok ? t2.passId : "" });
    expect(tested).toMatchObject({ untested: false, lastHealth: { status: "ok" } });
  });

  it("a wrong token gives the Wrong credentials heading and names the token field", async () => {
    const t = await svc.testConnection(owner, { packageId: "npm", config: { baseUrl: api.url }, secrets: { token: "wrong-FAKE" } });
    expect(t).toMatchObject({ ok: false, heading: "Wrong credentials", error: { code: "auth", message: expect.stringContaining('"API token"') } });
  });

  it("secret fields are write-only: Saved with a date, never the value; blank keeps the old value", () => {
    const i = svc.createIntegration(owner, { packageId: "npm", name: "W", config: { baseUrl: api.url }, secrets: { token: FAKE_TOKEN }, untested: true });
    const view = svc.getIntegration(owner, i.id);
    expect(view.secretFields).toEqual([expect.objectContaining({ key: "token", set: true, updatedAt: expect.any(String) })]);
    expect(JSON.stringify(view)).not.toContain(FAKE_TOKEN);
    const before = view.secretFields[0]!.updatedAt;
    const after = svc.saveSecrets(owner, i.id, { token: "" });
    expect(after.secretFields[0]).toMatchObject({ set: true, updatedAt: before });
  });

  it("a viewer can read but not add, edit, test or save", async () => {
    expect(svc.listIntegrations(viewer).length).toBeGreaterThan(0);
    expect(svc.canEdit(viewer)).toBe(false);
    expect(() => svc.createIntegration(viewer, { packageId: "npm", name: "x", config: { baseUrl: api.url }, secrets: {}, untested: true })).toThrow(/can view integrations but not change them/);
    await expect(svc.testConnection(viewer, { packageId: "npm", config: { baseUrl: api.url }, secrets: {} })).rejects.toThrow(/not change them/);
  });

  it("a custom endpoint refresh below 10 seconds cannot be saved", () => {
    const i = svc.createIntegration(owner, { packageId: "custom-api", name: "C", config: { baseUrl: api.url }, secrets: {}, untested: true });
    expect(() => svc.addEndpoint(owner, i.id, { id: "load", label: "Load", method: "GET", path: "/stats", fields: [{ path: "$.load", label: "Load", role: "value" }], shape: "stat", refreshSec: 9 })).toThrow(/at least 10 seconds/);
    expect(svc.addEndpoint(owner, i.id, { id: "load", label: "Load", method: "GET", path: "/stats", fields: [{ path: "$.load", label: "Load", role: "value" }], shape: "stat", refreshSec: 10 })).toHaveLength(1);
  });
});

describe("agent tools and drafts", () => {
  let draftId = "";
  it("agent writes land as drafts and cannot carry credentials", async () => {
    const created = await tool("integrations.create")(agent, { packageId: "npm", name: "Agent NPM", config: { baseUrl: api.url } });
    expect(created).toMatchObject({ status: "draft", secrets: [{ key: "token", set: false }] });
    draftId = created.id;
    expect(() => svc.createIntegration(agent, { packageId: "npm", name: "x", config: { baseUrl: api.url }, secrets: { token: "nope" } })).toThrow(/Agents cannot set credentials/);
  });

  it("the test tool returns only status, latency, version and message", async () => {
    const out = await tool("integrations.test")(agent, { integrationId: draftId });
    expect(Object.keys(out).sort()).toEqual(expect.arrayContaining(["latencyMs", "status"]));
    expect(Object.keys(out).every((k) => ["status", "latencyMs", "version", "message"].includes(k))).toBe(true);
    expect(out).toMatchObject({ status: "down", message: expect.stringContaining("not set") });
  });

  it("an agent cannot publish, and a draft without its secrets cannot be published", () => {
    expect(() => svc.publishDraft(agent, draftId, { secrets: { token: FAKE_TOKEN } })).toThrow(/Only a signed-in person/);
    expect(tools.integrationTools.some((t) => /publish/.test(t.name))).toBe(false);
    expect(() => svc.publishDraft(owner, draftId, { secrets: {} })).toThrow(/Enter API token before publishing/);
  });

  it("the credentials link needs to be fresh and unused, and stops working once the secrets are saved", async () => {
    const { credentialsUrl, expiresAt } = await tool("integrations.request_credentials")(agent, { integrationId: draftId });
    const u = new URL(credentialsUrl);
    expect(u.pathname).toBe(`/integrations/${draftId}/credentials`);
    const token = u.searchParams.get("draft")!;
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(svc.checkCredentialLink(draftId, token)).toEqual({ ok: true });
    expect(svc.checkCredentialLink(draftId, token, Date.now() + 24 * 3600_000 + 1000)).toEqual({ ok: false, message: "This link has expired. Ask your agent for a new one" });
    expect(svc.checkCredentialLink("other-id", token)).toMatchObject({ ok: false });
    const published = svc.publishDraft(owner, draftId, { token, secrets: { token: FAKE_TOKEN } });
    expect(published).toMatchObject({ status: "active", secretFields: [{ set: true }] });
    expect(svc.checkCredentialLink(draftId, token)).toEqual({ ok: false, message: "This link has expired. Ask your agent for a new one" });
    expect(() => svc.publishDraft(owner, draftId, { token, secrets: {} })).toThrow(/expired/);
    const out = await tool("integrations.test")(agent, { integrationId: draftId });
    expect(out).toMatchObject({ status: "ok", version: "2.12.6" });
    expect(JSON.stringify(out)).not.toContain(FAKE_TOKEN);
  });

  it("agents cannot change a live integration", async () => {
    await expect(tool("integrations.update")(agent, { integrationId: draftId, name: "renamed" })).rejects.toThrow(/only change draft/);
  });

  it("list, endpoints and data.read never return secret values", async () => {
    const outs = [await tool("integrations.list")(agent, {}), await tool("integrations.endpoints")(agent, { integrationId: draftId }), await tool("data.read")(agent, { integrationId: draftId, endpointId: "proxy-hosts" })];
    for (const o of outs) expect(JSON.stringify(o)).not.toContain(FAKE_TOKEN);
  });

  it("docs lookup refuses a metadata address", async () => {
    await expect(tool("integrations.search_docs")(agent, { url: "http://169.254.169.254/latest/" })).rejects.toThrow(/not allowed to reach that address/);
  });
});

describe("declarative packages", () => {
  it("can be created, tested, exported, deleted and re-imported, and its reads work again after import", async () => {
    const card = await tools.integrationTools.find((t) => t.name === "packages.create")!.handler({ principal: agent, signal: new AbortController().signal }, {
      name: "Home Stats", description: "Load from my box", endpoints: [{ id: "load", label: "Load", method: "GET", path: "/stats", fields: [{ path: "$.load", label: "Load", role: "value" }], shape: "stat", refreshSec: 30 }],
    });
    expect(card).toMatchObject({ id: "local/home-stats", status: "draft" });
    const t = await svc.testConnection(owner, { packageId: "local/home-stats", config: { baseUrl: api.url }, secrets: {} });
    expect(t.ok).toBe(true);
    const i = svc.createIntegration(owner, { packageId: "local/home-stats", name: "Box", config: { baseUrl: api.url }, secrets: {}, passId: t.ok ? t.passId : "" });
    const { readEndpoint } = await import("../runtime");
    expect(await readEndpoint(i.id, "load", {})).toMatchObject({ ok: true, data: { kind: "stat", value: 0.25 } });
    const file = svc.exportDeclarativePackage("local/home-stats");
    expect(file).toMatchObject({ atriumPackage: "1", manifest: { kind: "declarative", id: "local/home-stats" } });
    svc.deleteDeclarativePackage(owner, "local/home-stats");
    expect(await readEndpoint(i.id, "load", {})).toMatchObject({ ok: false, error: { code: "config", message: expect.stringContaining("not installed") } });
    svc.importDeclarativePackage(owner, JSON.parse(JSON.stringify(file)));
    expect(await readEndpoint(i.id, "load", {})).toMatchObject({ ok: true, data: { kind: "stat", value: 0.25 } });
  });

  it("an imported package with code or a bad manifest is refused", () => {
    expect(() => svc.importDeclarativePackage(owner, { atriumPackage: "1", manifest: { atriumApi: "2" }, endpoints: [] })).toThrow(/not valid/);
    expect(() => svc.importDeclarativePackage(owner, { hello: 1 })).toThrow(/not an Atrium package/);
  });
});

describe("reads stay on their host", () => {
  it("a read cannot reach a host other than the configured one", async () => {
    const i = svc.createIntegration(owner, { packageId: "custom-api", name: "Host", config: { baseUrl: api.url }, secrets: {}, untested: true });
    const { readEndpoint } = await import("../runtime");
    svc.addEndpoint(owner, i.id, { id: "s", label: "S", method: "GET", path: "/stats", fields: [{ path: "$.load", label: "L", role: "value" }], shape: "stat", refreshSec: 10 });
    expect(await readEndpoint(i.id, "s", {})).toMatchObject({ ok: true });
    svc.updateIntegration(owner, i.id, { config: { baseUrl: "http://169.254.169.254" } });
    expect(await readEndpoint(i.id, "s", {})).toMatchObject({ ok: false, error: { code: "permission" } });
  });
});
