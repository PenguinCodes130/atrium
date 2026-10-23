// Round 3 commands (spec v2 sections 3.1 to 3.3, criteria 1 to 18): manifest rules, custom and
// declarative commands, method gating, parameter checks, timeouts, cache refresh, who may change
// and bind, and the listings. Local fake servers only; test-only secret values.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/core/contracts";
import { setupTestDb } from "./db-harness";
import { blackhole, httpServer, json, type Seen } from "../host/__tests__/servers";
import { agent, fakeHomeAssistant, HA_TOKEN, member, otherMember, owner, viewer, type FakeHa } from "@/features/controls/__tests__/harness";

setupTestDb();

const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/commands.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
const record = (test: string, data: unknown) => appendFileSync(EVIDENCE, `${JSON.stringify({ test, ...(data as object) })}\n`);

const CUSTOM_SECRET = "atrium-r3-FAKE-custom-secret-d4735e3a265e";

let svc: typeof import("../service");
let cmds: typeof import("../commands");
let host: typeof import("../host/command");
let http: typeof import("../host/http");
let manifest: typeof import("../manifest");
let registry: typeof import("../registry");
let official: typeof import("../official");
let tools: typeof import("../tools");
let data: typeof import("@/features/data/runtime");
let keys: typeof import("@/features/data/keys");
let ha: FakeHa;
let haId: string;
let api: Awaited<ReturnType<typeof httpServer>>;
let customId: string;
const bodies: unknown[] = [];

const lampDef = { id: "lamp.set", label: "Set lamp", description: "Sets the lamp", method: "POST" as const, path: "/lamp", body: { on: "{{ params.on }}", level: "{{ params.level }}", note: "level {{ params.level }}" }, params: { type: "object", required: ["on"], properties: { on: { type: "boolean" }, level: { type: "integer", minimum: 0, maximum: 10 } } }, risk: "low" as const };

beforeAll(async () => {
  svc = await import("../service");
  cmds = await import("../commands");
  host = await import("../host/command");
  http = await import("../host/http");
  manifest = await import("../manifest");
  registry = await import("../registry");
  official = await import("../official");
  tools = await import("../tools");
  data = await import("@/features/data/runtime");
  keys = await import("@/features/data/keys");
  ha = await fakeHomeAssistant();
  haId = svc.createIntegration(owner, { packageId: "home-assistant", name: "Home Assistant", config: { baseUrl: ha.url }, secrets: { token: HA_TOKEN }, untested: true }).id;
  api = await httpServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => { bodies.push(raw ? JSON.parse(raw) : null); json(res, 200, { ok: true }); });
  });
  customId = svc.createIntegration(member, { packageId: "custom-api", name: "Lamp API", config: { baseUrl: api.url }, secrets: {}, untested: true }).id;
});
afterAll(async () => { await ha.close(); await api.close(); });

const baseManifest = () => JSON.parse(JSON.stringify((official.OFFICIAL_PACKAGES.find((p) => (p.manifest as { id: string }).id === "home-assistant")!).manifest)) as Record<string, unknown> & { commands: Record<string, unknown>[]; permissions: Record<string, unknown>[] };
const sink = () => ({ record: () => true, resolveOthers: () => undefined });

describe("manifest rules (criteria 1, 2)", () => {
  it("rejects a command of risk high and lists the package under Packages with problems", () => {
    const m = baseManifest();
    m.id = "risky";
    m.commands[0]!.risk = "high";
    const v = manifest.validateManifest(m, { hasAdapter: true, source: "official" });
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/risk must be "low" or "medium"/) });
    const r = registry.buildRegistry([{ manifest: m, adapter: { health: async () => ({ status: "ok", latencyMs: 0 }), read: async () => ({ ok: false, error: { code: "config", message: "x" }, fetchedAt: "" }) } }], [], sink(), () => {});
    expect(r.problems).toEqual([expect.objectContaining({ packageId: "risky", source: "official", reason: expect.stringMatching(/risk/) })]);
    expect(r.packages.has("risky")).toBe(false);
  });

  it("rejects a command id missing from the command permission, and a permission naming an undeclared command", () => {
    const a = baseManifest();
    (a.permissions.find((p) => p.kind === "command")!.ids as string[]).pop();
    expect(manifest.validateManifest(a, { hasAdapter: true, source: "official" })).toMatchObject({ ok: false, reason: 'command "script.turn_on" is missing from the command permission' });
    const b = baseManifest();
    (b.permissions.find((p) => p.kind === "command")!.ids as string[]).push("lock.unlock");
    expect(manifest.validateManifest(b, { hasAdapter: true, source: "official" })).toMatchObject({ ok: false, reason: 'the command permission names undeclared command "lock.unlock"' });
    const c = baseManifest();
    (c.commands[0]!.target as { endpointId: string }).endpointId = "nope";
    expect(manifest.validateManifest(c, { hasAdapter: true, source: "official" })).toMatchObject({ ok: false, reason: expect.stringMatching(/targets undeclared endpoint "nope"/) });
  });

  it("the official Home Assistant manifest validates", () => {
    expect(manifest.validateManifest(baseManifest(), { hasAdapter: true, source: "official" }).ok).toBe(true);
  });
});

describe("custom commands (criteria 3, 4, 11, 15)", () => {
  it("cannot save a custom command with an Authorization or X-API-Key header (criterion 3)", () => {
    for (const headers of [{ Authorization: "Bearer abc123456" }, { "X-API-Key": "abc123456" }, { "x-auth-token": "abc" }]) {
      expect(() => cmds.addCommand(member, customId, { ...lampDef, headers })).toThrow(/looks like a credential/);
    }
    expect(manifest.customCommandSchema.safeParse({ ...lampDef, headers: { Authorization: "Bearer x" } }).success).toBe(false);
    expect(cmds.commandsView(member, customId).pending).toHaveLength(0);
  });

  it("refuses placeholders outside the body and placeholders naming undeclared params", () => {
    expect(() => cmds.addCommand(member, customId, { ...lampDef, path: "/lamp/{{ params.on }}" })).toThrow(/placeholders go in the body only/);
    expect(() => cmds.addCommand(member, customId, { ...lampDef, body: { x: "{{ params.missing }}" } })).toThrow(/must name a declared parameter/);
    expect(() => cmds.addCommand(member, customId, { ...lampDef, method: "GET" })).toThrow(/POST, PUT, PATCH or DELETE/);
    expect(() => cmds.addCommand(member, customId, { ...lampDef, risk: "high" })).toThrow(/risk must be/);
  });

  it("round 8: a field's error names the field separately and the message has no trailing \" (at path)\"", async () => {
    const { FieldError } = await import("../field-error");
    for (const path of ["/api\\lamp", "/api\tlamp", "/lamp/{{ params.on }}"]) {
      let caught: unknown;
      try { cmds.addCommand(member, customId, { ...lampDef, path }); } catch (e) { caught = e; }
      expect(caught, path).toBeInstanceOf(FieldError);
      expect((caught as InstanceType<typeof FieldError>).field).toBe("path");
      expect((caught as Error).message).not.toMatch(/\(at /);
      if (!path.includes("{{")) expect((caught as Error).message).toMatch(/\.$/);
    }
  });

  it("a member who did not create the integration cannot add or change its commands, in the app or through the tool (criterion 11)", async () => {
    expect(() => cmds.addCommand(otherMember, customId, lampDef)).toThrow(/Only the owner or the person who added this integration/);
    expect(() => cmds.addCommand(viewer, customId, lampDef)).toThrow();
    const tool = tools.integrationTools.find((t) => t.name === "integrations.add_command")!;
    const otherAgent: Principal = { kind: "agent", userId: "u-member-2", role: "member", via: "pat", tokenId: "t2", agentName: "Bot", scopes: ["atrium:edit"] };
    await expect(tool.handler({ principal: otherAgent, signal: new AbortController().signal }, tool.input.parse({ integrationId: customId, command: lampDef }))).rejects.toThrow(/Only the owner or the person who added/);
    expect(cmds.commandsView(otherMember, customId)).toMatchObject({ canChange: false, pending: [] });
  });

  it("the creator adds a command; it waits under This integration can change until a signed-in person publishes (criterion 15)", async () => {
    const tool = tools.integrationTools.find((t) => t.name === "integrations.add_command")!;
    const creatorAgent: Principal = { kind: "agent", userId: "u-member", role: "member", via: "pat", tokenId: "t3", agentName: "Bot", scopes: ["atrium:edit"] };
    const out = await tool.handler({ principal: creatorAgent, signal: new AbortController().signal }, tool.input.parse({ integrationId: customId, command: lampDef }));
    expect(tool.output.parse(out)).toEqual({ pending: [{ id: "lamp.set", label: "Set lamp", risk: "low", change: "added" }] });
    const v = cmds.commandsView(member, customId);
    expect(v.pending).toEqual([expect.objectContaining({ id: "lamp.set", label: "Set lamp", risk: "low", method: "POST", path: "/lamp", change: "added" })]);
    expect(v.commands).toEqual([]);
    // Not published: it cannot run, and nothing is sent.
    expect(await host.hostCommand(customId, "lamp.set", { on: true })).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(api.seen).toHaveLength(0);
    expect(() => cmds.publishCommands(creatorAgent, customId)).toThrow(/signed-in person/);
    expect(() => cmds.publishCommands(otherMember, customId)).toThrow(/Only the owner or the person who added/);
    const pub = cmds.publishCommands(member, customId);
    expect(pub.pending).toEqual([]);
    expect(pub.commands).toEqual([expect.objectContaining({ id: "lamp.set", risk: "low" })]);
  });

  it("fills body placeholders with the validated parameters; a parameter failing the schema sends no request (criterion 4)", async () => {
    api.seen.length = 0;
    bodies.length = 0;
    const ok = await host.hostCommand(customId, "lamp.set", { on: true, level: 7 });
    expect(ok.ok).toBe(true);
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]).toMatchObject({ method: "POST", url: "/lamp" });
    expect(await host.hostCommand(customId, "lamp.set", { on: false, level: 3 })).toMatchObject({ ok: true });
    const sent = bodies.slice();
    // Whole placeholders keep their type; placeholders inside text become text.
    expect(sent).toEqual([{ on: true, level: 7, note: "level 7" }, { on: false, level: 3, note: "level 3" }]);
    api.seen.length = 0;
    const t0 = performance.now();
    const bad = await host.hostCommand(customId, "lamp.set", { on: "yes", level: 3 });
    const bad2 = await host.hostCommand(customId, "lamp.set", { on: true, level: 11 });
    const bad3 = await host.hostCommand(customId, "lamp.set", { on: true, extra: 1 });
    const elapsed = performance.now() - t0;
    record("placeholders", { sent, bad, bad2, bad3, elapsed, requests: api.seen.length });
    expect(bad).toMatchObject({ ok: false, error: { code: "config", message: expect.stringContaining("on") } });
    expect(bad2).toMatchObject({ ok: false, error: { message: expect.stringContaining("level") } });
    expect(bad3).toMatchObject({ ok: false, error: { message: expect.stringContaining("extra") } });
    expect(api.seen).toHaveLength(0);
    expect(elapsed).toBeLessThan(1000); // criterion 7: within 1 second
  });
});

describe("method gating (criterion 5)", () => {
  it("during a read or health check a PUT, PATCH or DELETE is refused and never leaves the server; during a command it is sent", async () => {
    const seen: Seen[] = [];
    const s = await httpServer((req, res) => { seen.push({ method: req.method ?? "", url: req.url ?? "", headers: {} }); json(res, 200, {}); });
    try {
      const m = { ...(registry.buildRegistry(official.OFFICIAL_PACKAGES, [], sink(), () => {}).packages.get("home-assistant")!.manifest) };
      const mk = (mode: "read" | "command" | undefined) => http.createHostHttp({ manifest: m, config: { baseUrl: s.url }, secrets: async () => null, ...(mode ? { mode } : {}) });
      for (const method of ["PUT", "PATCH", "DELETE"] as const) {
        await expect(mk(undefined).fetch({ path: "/x", method })).rejects.toMatchObject({ adapterError: { code: "permission" } });
        await expect(mk("read").fetch({ path: "/x", method })).rejects.toMatchObject({ adapterError: { code: "permission" } });
      }
      expect(seen).toHaveLength(0);
      for (const method of ["PUT", "PATCH", "DELETE"] as const) await mk("command").fetch({ path: "/x", method, body: { a: 1 } });
      expect(seen.map((x) => x.method)).toEqual(["PUT", "PATCH", "DELETE"]);
      // The request engine refuses writes too unless host.command() asked for them.
      const { safeRequest } = await import("../host/request");
      await expect(safeRequest({ url: `${s.url}/y`, method: "DELETE", redirect: { mode: "checked" } })).rejects.toMatchObject({ adapterError: { code: "permission" } });
      expect(seen).toHaveLength(3);
      record("method gating", { sent: seen.map((x) => x.method) });
    } finally {
      await s.close();
    }
  });

  it("a Custom API read with a write method in its record is refused at the host", async () => {
    const bad = { id: "w", label: "W", method: "DELETE", path: "/x", fields: [{ path: "$.ok", label: "ok", role: "value" }], shape: "stat", refreshSec: 30 };
    expect(manifest.customEndpointSchema.safeParse(bad).success).toBe(false);
  });
});

describe("running Home Assistant commands (criteria 6, 7, 17, 18)", () => {
  it("declares the eight commands of spec 3.3 with the A1.5 names, script owner-only and medium (criterion 17)", () => {
    const m = registry.buildRegistry(official.OFFICIAL_PACKAGES, [], sink(), () => {}).packages.get("home-assistant")!.manifest;
    expect((m.commands ?? []).map((c) => [c.id, c.risk, !!c.ownerOnly])).toEqual([
      ["light.turn_on", "low", false], ["light.turn_off", "low", false], ["light.toggle", "low", false],
      ["switch.turn_on", "low", false], ["switch.turn_off", "low", false], ["switch.toggle", "low", false],
      ["scene.turn_on", "low", false], ["script.turn_on", "medium", true],
    ]);
    expect((m.commands ?? []).some((c) => /^(lock|alarm|alarm_control_panel|fan|cover|media_player|climate|homeassistant)\./.test(c.id) || /call_service/.test(c.id))).toBe(false);
  });

  it("each command sends exactly one POST to its service path with the entity id from the parameters (criterion 18)", async () => {
    const cases: [string, string, string][] = [
      ["light.turn_on", "light.lamp", "/api/services/light/turn_on"], ["light.turn_off", "light.lamp", "/api/services/light/turn_off"], ["light.toggle", "light.lamp", "/api/services/light/toggle"],
      ["switch.turn_on", "switch.fan", "/api/services/switch/turn_on"], ["switch.turn_off", "switch.fan", "/api/services/switch/turn_off"], ["switch.toggle", "switch.fan", "/api/services/switch/toggle"],
      ["scene.turn_on", "scene.movie", "/api/services/scene/turn_on"], ["script.turn_on", "script.goodnight", "/api/services/script/turn_on"],
    ];
    for (const [cmd, entity, servicePath] of cases) {
      ha.calls.length = 0;
      const r = await host.hostCommand(haId, cmd, { entityId: entity });
      expect(r.ok).toBe(true);
      expect(ha.calls).toEqual([{ method: "POST", path: servicePath, body: { entity_id: entity }, authOk: true }]);
    }
    ha.calls.length = 0;
    await host.hostCommand(haId, "light.turn_on", { entityId: "light.lamp", brightnessPct: 40, colorTempK: 2700, rgb: [255, 200, 0] });
    expect(ha.calls[0]!.body).toEqual({ entity_id: "light.lamp", brightness_pct: 40, color_temp_kelvin: 2700, rgb_color: [255, 200, 0] });
    record("ha commands", { last: ha.calls });
  });

  it("a command the package's permission does not list fails with a plain message and sends no request (criterion 6)", async () => {
    ha.calls.length = 0;
    for (const c of ["lock.unlock", "homeassistant.restart", "light.delete", ""]) {
      const r = await host.hostCommand(haId, c, { entityId: "lock.front_door" });
      expect(r).toMatchObject({ ok: false, error: { code: "permission", message: expect.stringMatching(/not allowed to run/) } });
    }
    expect(ha.calls).toHaveLength(0);
  });

  it("invalid parameters fail within 1 second with a message naming the parameter, with no request (criterion 7)", async () => {
    ha.calls.length = 0;
    const t0 = performance.now();
    const outs = [
      await host.hostCommand(haId, "light.toggle", {}),
      await host.hostCommand(haId, "light.toggle", { entityId: "switch.fan" }),
      await host.hostCommand(haId, "light.turn_on", { entityId: "light.lamp", brightnessPct: 101 }),
      await host.hostCommand(haId, "light.turn_on", { entityId: "light.lamp", rgb: [1, 2] }),
    ];
    const elapsed = performance.now() - t0;
    record("invalid params", { outs, elapsed });
    expect(outs.map((o) => (o.ok ? "" : o.error.message))).toEqual([
      expect.stringContaining("entityId"), expect.stringContaining("entityId"), expect.stringContaining("brightnessPct"), expect.stringContaining("rgb"),
    ]);
    expect(elapsed).toBeLessThan(1000);
    expect(ha.calls).toHaveLength(0);
  });
});

describe("timeouts (criterion 8)", () => {
  it("a command against a host that never answers fails with the timed out message at 10 seconds plus or minus 1", async () => {
    const hole = await blackhole();
    try {
      const id = svc.createIntegration(owner, { packageId: "custom-api", name: "Hole", config: { baseUrl: hole.url }, secrets: {}, untested: true }).id;
      cmds.addCommand(owner, id, lampDef);
      cmds.publishCommands(owner, id);
      const t0 = performance.now();
      const r = await host.hostCommand(id, "lamp.set", { on: true });
      const s = (performance.now() - t0) / 1000;
      record("timeout", { r, seconds: s });
      expect(r).toMatchObject({ ok: false, error: { code: "timeout", message: "The service did not answer within 10 seconds." } });
      expect(s).toBeGreaterThanOrEqual(9);
      expect(s).toBeLessThanOrEqual(11);
    } finally {
      await hole.close();
    }
  }, 20_000);
});

describe("refresh after a command (criterion 10)", () => {
  it("after a command run on an integration whose active key refreshes every 60 s, a new fetch starts within 2 seconds", async () => {
    const { scheduler, cache } = data.dataRuntime();
    const src = { integrationId: haId, endpointId: "states" };
    const sub = scheduler.subscribe(src, 60);
    const key = keys.cacheKey(src);
    const startsOf = () => scheduler.starts.filter((x) => x.key === key).length;
    const wait = async (pred: () => boolean, ms: number) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 20)); } return true; };
    expect(await wait(() => startsOf() === 1 && !!cache.get(key)?.lastGood, 3000)).toBe(true);
    expect(scheduler.intervalMs(key)).toBe(60_000);
    const before = startsOf();
    const t0 = Date.now();
    await host.hostCommand(haId, "light.toggle", { entityId: "light.lamp" });
    const refreshed = await wait(() => startsOf() > before, 2000);
    const ms = Date.now() - t0;
    expect(await wait(() => (cache.get(key)?.lastGood?.data as unknown as { rows: { entity_id: string; state: string }[] }).rows.find((r) => r.entity_id === "light.lamp")?.state === (ha.lamp.on ? "on" : "off"), 2000)).toBe(true);
    record("refresh", { refreshed, ms });
    expect(refreshed).toBe(true);
    expect(ms).toBeLessThan(2000);
    sub.unsubscribe();
  });
});

describe("sharing and binding (criteria 12, 13, 14)", () => {
  it("a new integration has Shared off (criterion 12)", () => {
    expect(svc.getIntegration(owner, haId).shared).toBe(false);
    expect(svc.createIntegration(member, { packageId: "custom-api", name: "Fresh", config: { baseUrl: api.url }, secrets: {}, untested: true }).shared).toBe(false);
  });

  it("with Shared off a non-creator member is offered none of it; with Shared on its reads appear but its commands do not (criterion 13)", async () => {
    const reads = async (p: Principal) => (await cmds.listBindableEndpoints(p)).filter((x) => x.integrationId === haId);
    const commands = (p: Principal) => cmds.listCommands(p).filter((x) => x.integrationId === haId);
    expect(await reads(member)).toEqual([]);
    expect(commands(member)).toEqual([]);
    expect(await reads(owner)).toHaveLength(1);
    expect(() => svc.updateIntegration(member, haId, { shared: true })).toThrow(/Only the owner or the person who added/);
    expect(() => svc.updateIntegration(agent, haId, { shared: true })).toThrow();
    svc.updateIntegration(owner, haId, { shared: true });
    expect(await reads(member)).toEqual([expect.objectContaining({ integrationName: "Home Assistant", endpoints: expect.arrayContaining([expect.objectContaining({ id: "states" })]) })]);
    expect(commands(member)).toEqual([]);
    expect(await reads(viewer)).toEqual([]);
    svc.updateIntegration(owner, haId, { shared: false });
    const db = await import("@/core/db");
    const rows = db.sqlite().prepare("select detail from audit_log where event = 'integration.updated'").all() as { detail: string }[];
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([{ shared: true }, { shared: false }]);
    record("binding", { memberReadsWhenUnshared: 0, memberCommandsWhenShared: 0 });
  });

  it("the command listing offers owner-only commands (script.turn_on) to the owner only, with targets from the cached states (criterion 14)", async () => {
    const memberHa = svc.createIntegration(member, { packageId: "home-assistant", name: "Member HA", config: { baseUrl: ha.url }, secrets: { token: HA_TOKEN }, untested: true });
    await data.readThrough({ integrationId: memberHa.id, endpointId: "states" }, 10);
    const forMember = cmds.listCommands(member).filter((x) => x.integrationId === memberHa.id).map((x) => x.command.id);
    const forOwner = cmds.listCommands(owner).filter((x) => x.integrationId === memberHa.id);
    expect(forMember).not.toContain("script.turn_on");
    expect(forMember).toHaveLength(7);
    expect(forOwner.map((x) => x.command.id)).toContain("script.turn_on");
    expect(forOwner.find((x) => x.command.id === "light.toggle")!.targets).toEqual([{ id: "light.lamp", label: "Bedroom lamp" }, { id: "light.porch", label: "Porch" }]);
    expect(forOwner.find((x) => x.command.id === "switch.toggle")!.targets).toEqual([{ id: "switch.fan", label: "Fan plug" }]);
    const tool = tools.integrationTools.find((t) => t.name === "controls.commands")!;
    const out = tool.output.parse(await tool.handler({ principal: agent, signal: new AbortController().signal }, {}));
    expect(JSON.stringify(out).includes(HA_TOKEN)).toBe(false);
    expect(cmds.listCommands({ kind: "guest", guestLinkId: "g", appId: "a", label: "x", via: "guest-link" })).toEqual([]);
  });
});

describe("drafts that add commands (criterion 15) and declarative commands.json", () => {
  it("an agent's Home Assistant draft lists every command it can change before publishing", () => {
    const draft = svc.createIntegration(agent, { packageId: "home-assistant", name: "Agent HA", config: { baseUrl: ha.url }, secrets: {} });
    const v = cmds.commandsView(owner, draft.id);
    expect(v.pending.map((c) => [c.id, c.label, c.risk])).toEqual(expect.arrayContaining([["light.toggle", expect.any(String), "low"], ["script.turn_on", expect.any(String), "medium"]]));
    expect(v.pending).toHaveLength(8);
  });

  it("a declarative package's commands wait as a draft, then run through the generic runner once published", async () => {
    const card = svc.saveDeclarativePackage(owner, { name: "Lamp box", endpoints: [{ id: "status", label: "Status", method: "GET", path: "/status", fields: [{ path: "$.ok", label: "ok", role: "value" }], shape: "stat", refreshSec: 30 }], secrets: [{ key: "key", label: "Key", hint: "A test key", auth: { as: "header", name: "X-Lamp-Key" } }], commands: [{ ...lampDef, auth: "key" }] });
    expect(card.commands).toEqual([]);
    expect(card.pendingCommands).toEqual([expect.objectContaining({ id: "lamp.set", method: "POST", path: "/lamp" })]);
    const i = svc.createIntegration(owner, { packageId: card.id, name: "Lamp box", config: { baseUrl: api.url }, secrets: { key: CUSTOM_SECRET }, untested: true });
    expect(await host.hostCommand(i.id, "lamp.set", { on: true })).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(() => svc.publishPackageCommands(agent, card.id)).toThrow(/signed-in person/);
    const pub = svc.publishPackageCommands(owner, card.id);
    expect(pub.commands).toEqual([expect.objectContaining({ id: "lamp.set" })]);
    expect(pub.pendingCommands).toEqual([]);
    api.seen.length = 0;
    const r = await host.hostCommand(i.id, "lamp.set", { on: true, level: 2 });
    expect(r.ok).toBe(true);
    expect(api.seen[0]).toMatchObject({ method: "POST", url: "/lamp" });
    expect(api.seen[0]!.headers["x-lamp-key"]).toBe(CUSTOM_SECRET); // attached by the host, never seen by the record
    const exported = svc.exportDeclarativePackage(card.id);
    expect(exported.commands).toHaveLength(1);
    expect(JSON.stringify(exported).includes(CUSTOM_SECRET)).toBe(false);
  });

  it("an imported package's commands never arrive live", () => {
    const file = svc.exportDeclarativePackage("local/lamp-box");
    svc.deleteDeclarativePackage(owner, "local/lamp-box");
    const card = svc.importDeclarativePackage(owner, file);
    expect(card.commands).toEqual([]);
    expect(card.pendingCommands).toHaveLength(1);
  });
});

describe("no secret in command results (criterion 9)", () => {
  it("command results, views and listings never carry the token or the custom secret", async () => {
    const wrong = svc.createIntegration(owner, { packageId: "home-assistant", name: "Wrong HA", config: { baseUrl: ha.url }, secrets: { token: "atrium-r3-FAKE-wrong" }, untested: true });
    const results = [
      await host.hostCommand(haId, "light.toggle", { entityId: "light.lamp" }),
      await host.hostCommand(wrong.id, "light.toggle", { entityId: "light.lamp" }),
      await host.hostCommand(haId, "light.toggle", { entityId: HA_TOKEN }),
    ];
    const text = JSON.stringify({ results, views: [cmds.commandsView(owner, haId), cmds.commandsView(owner, customId)], list: cmds.listCommands(owner), cards: svc.gallery() });
    record("no secrets", { results, hits: [HA_TOKEN, CUSTOM_SECRET].filter((s) => text.includes(s)).length });
    expect(text.includes(HA_TOKEN)).toBe(false);
    expect(text.includes(CUSTOM_SECRET)).toBe(false);
    expect(results[1]).toMatchObject({ ok: false, error: { code: "auth", message: expect.stringContaining("Long-lived access token") } });
  });
});
