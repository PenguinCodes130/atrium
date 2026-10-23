// Home Assistant package (architecture v3 section 3.2, amendment A1.5; spec v2 criteria 17 and 18).
// Fixture-driven; never touches the network. Test-only values; none are real credentials.
import { describe, expect, it } from "vitest";
import type { CommandDef, PackageManifest } from "@/core/contracts";
import { validateManifest } from "@/features/integrations/manifest";
import ha from "../home-assistant/adapter";
import manifestJson from "../home-assistant/manifest.json";
import { fakeCtx, fixture, type Call } from "./fake";

const manifest = manifestJson as unknown as PackageManifest;
const states = { body: fixture("ha-states.json") };

const EXPECTED = ["light.turn_on", "light.turn_off", "light.toggle", "switch.turn_on", "switch.turn_off", "switch.toggle", "scene.turn_on", "script.turn_on"];

describe("Home Assistant manifest", () => {
  it("validates as an official code package", () => {
    const v = validateManifest(manifestJson, { hasAdapter: true, source: "official" });
    expect(v).toMatchObject({ ok: true });
  });
  it("declares exactly the commands of spec 3.3 with A1.5 names, script medium and owner only, the rest low", () => {
    const cmds = manifest.commands as CommandDef[];
    expect(cmds.map((c) => c.id)).toEqual(EXPECTED);
    for (const c of cmds) {
      if (c.id === "script.turn_on") expect(c).toMatchObject({ risk: "medium", ownerOnly: true });
      else { expect(c.risk).toBe("low"); expect(c.ownerOnly).toBeUndefined(); }
      expect(c.target).toEqual({ endpointId: "states", field: "entity_id" });
      expect((c.params as { required: string[] }).required).toEqual(["entityId"]);
    }
    const perm = manifest.permissions.find((p) => p.kind === "command");
    expect(perm && perm.kind === "command" && perm.ids).toEqual(EXPECTED);
  });
  it("has no lock, alarm, fan, cover, media, climate or generic service command", () => {
    const domains = new Set((manifest.commands ?? []).map((c) => c.id.split(".")[0]));
    for (const d of ["lock", "alarm_control_panel", "alarm", "fan", "cover", "media_player", "climate", "homeassistant", "service"]) expect(domains.has(d)).toBe(false);
  });
  it("has the token hint and its reads (Wave 2.7 adds sensor, sensors and unavailable)", () => {
    expect(manifest.secrets).toEqual([{ key: "token", label: "Long-lived access token", hint: "In Home Assistant, open your profile, then Security, then Create token", auth: { as: "bearer" } }]);
    expect(manifest.endpoints.map((e) => e.id)).toEqual(["sensor", "sensors", "states", "entity", "history", "areas", "unavailable"]);
  });
});

describe("Home Assistant health", () => {
  it("is ok with the version from /api/config", async () => {
    const { ctx, calls } = fakeCtx({ "api/config": { body: fixture("ha-config.json") } });
    expect(await ha.health(ctx)).toMatchObject({ status: "ok", version: "2026.10.1" });
    expect(calls).toEqual([{ path: "api/config", method: "GET", auth: "token" }]);
  });
  it("names the token field on a 401", async () => {
    const { ctx } = fakeCtx({ "api/config": { status: 401, body: "401: Unauthorized" } });
    await expect(ha.health(ctx)).rejects.toMatchObject({ adapterError: { code: "auth", message: expect.stringContaining("Long-lived access token") } });
  });
});

describe("Home Assistant reads", () => {
  it("states: a table of every entity, sorted, with names", async () => {
    const { ctx } = fakeCtx({ "api/states": states });
    const r = await ha.read(ctx, "states", {});
    expect(r.ok && r.data.kind === "table").toBe(true);
    if (r.ok && r.data.kind === "table") {
      expect(r.data.columns.map((c) => c.key)).toEqual(["entity_id", "name", "domain", "state", "unit", "device_class", "attributes"]);
      expect(r.data.rows.map((x) => x.entity_id)).toEqual(["light.bedroom", "light.living_room", "scene.movie_night", "sensor.living_room_temperature", "switch.kettle"]);
      expect(r.data.rows[1]).toMatchObject({ name: "Living room lamp", domain: "light", state: "on" });
    }
  });
  it("states: the domain filter keeps only that domain", async () => {
    const { ctx } = fakeCtx({ "api/states": states });
    const r = await ha.read(ctx, "states", { domain: "light" });
    expect(r.ok && r.data.kind === "table" && r.data.rows.map((x) => x.entity_id)).toEqual(["light.bedroom", "light.living_room"]);
  });
  it("states: the area filter reads through the template POST", async () => {
    const { ctx, calls } = fakeCtx({ "api/states": states, "api/template": { body: fixture("ha-area-entities.json") } });
    const r = await ha.read(ctx, "states", { area: "living_room" });
    expect(r.ok && r.data.kind === "table" && r.data.rows.map((x) => x.entity_id)).toEqual(["light.living_room", "sensor.living_room_temperature"]);
    const t = calls.find((c) => c.path === "api/template")!;
    expect(t).toMatchObject({ method: "POST", auth: "token", body: { template: "{{ area_entities('living_room') | tojson }}" } });
  });
  it.each(["kitchen')}}{{ states", "a'b", "x{y", "Living Room"])("states: refuses the area %j with no request sent (template injection guard)", async (area) => {
    const { ctx, calls } = fakeCtx({ "api/states": states, "api/template": { body: "[]" } });
    const r = await ha.read(ctx, "states", { area });
    expect(r).toMatchObject({ ok: false, error: { code: "config" } });
    expect(calls).toEqual([]);
  });
  it("entity: one entity as a status", async () => {
    const one = JSON.stringify(JSON.parse(fixture("ha-states.json"))[0]);
    const { ctx } = fakeCtx({ "api/states/light.living_room": { body: one } });
    const r = await ha.read(ctx, "entity", { entityId: "light.living_room" });
    expect(r.ok && r.data).toEqual({ kind: "status", items: [{ label: "Living room lamp", state: "up", detail: "on" }] });
  });
  it("entity: refuses a malformed entity id with no request", async () => {
    const { ctx, calls } = fakeCtx({});
    expect(await ha.read(ctx, "entity", { entityId: "../config" })).toMatchObject({ ok: false, error: { code: "config" } });
    expect(calls).toEqual([]);
  });
  it("history: numeric states as a series over the hours asked", async () => {
    const { ctx, calls } = fakeCtx({ "api/history/period/2026-10-16T12:00:00.000Z": { body: fixture("ha-history.json") } });
    const r = await ha.read(ctx, "history", { entityId: "sensor.living_room_temperature", hours: 24 });
    expect(r.ok && r.data).toEqual({ kind: "series", series: [{ name: "sensor.living_room_temperature", points: [[Date.parse("2026-10-17T08:00:00Z"), 20.9], [Date.parse("2026-10-17T11:59:00Z"), 21.4]] }] });
    expect(calls[0]).toMatchObject({ method: "GET", query: { filter_entity_id: "sensor.living_room_temperature", minimal_response: "1" } });
  });
  it("areas: a table from the template POST", async () => {
    const { ctx, calls } = fakeCtx({ "api/template": { body: fixture("ha-areas.json") } });
    const r = await ha.read(ctx, "areas", {});
    expect(r.ok && r.data.kind === "table" && r.data.rows).toEqual([{ id: "living_room", name: "Living room" }, { id: "bedroom", name: "Bedroom" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "api/template", method: "POST" });
  });
});

describe("Home Assistant commands", () => {
  const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
    ["light.turn_on", { entityId: "light.living_room", brightnessPct: 40, colorTempK: 2700, rgb: [255, 200, 10] }, "api/services/light/turn_on", { entity_id: "light.living_room", brightness_pct: 40, color_temp_kelvin: 2700, rgb_color: [255, 200, 10] }],
    ["light.turn_off", { entityId: "light.living_room" }, "api/services/light/turn_off", { entity_id: "light.living_room" }],
    ["light.toggle", { entityId: "light.bedroom" }, "api/services/light/toggle", { entity_id: "light.bedroom" }],
    ["switch.turn_on", { entityId: "switch.kettle" }, "api/services/switch/turn_on", { entity_id: "switch.kettle" }],
    ["switch.turn_off", { entityId: "switch.kettle" }, "api/services/switch/turn_off", { entity_id: "switch.kettle" }],
    ["switch.toggle", { entityId: "switch.kettle" }, "api/services/switch/toggle", { entity_id: "switch.kettle" }],
    ["scene.turn_on", { entityId: "scene.movie_night" }, "api/services/scene/turn_on", { entity_id: "scene.movie_night" }],
    ["script.turn_on", { entityId: "script.goodnight" }, "api/services/script/turn_on", { entity_id: "script.goodnight" }],
  ];
  it.each(cases)("%s sends exactly one POST to its service with the entity id", async (id, params, path, body) => {
    const { ctx, calls } = fakeCtx({ [path]: { body: "[]" } });
    const r = await ha.command!(ctx, id, params);
    expect(r).toMatchObject({ ok: true });
    expect(calls).toEqual<Call[]>([{ path, method: "POST", auth: "token", body }]);
  });
  it("refuses an entity of another domain without sending anything (defense in depth)", async () => {
    const { ctx, calls } = fakeCtx({});
    expect(await ha.command!(ctx, "light.toggle", { entityId: "lock.front_door" })).toMatchObject({ ok: false, error: { code: "config" } });
    expect(calls).toEqual([]);
  });
  it("reports wrong credentials naming the token", async () => {
    const { ctx } = fakeCtx({ "api/services/light/toggle": { status: 401, body: "401: Unauthorized" } });
    expect(await ha.command!(ctx, "light.toggle", { entityId: "light.bedroom" })).toMatchObject({ ok: false, error: { code: "auth", message: expect.stringContaining("Long-lived access token") } });
  });
  it("an undeclared command id fails without a request", async () => {
    const { ctx, calls } = fakeCtx({});
    expect(await ha.command!(ctx, "lock.unlock", { entityId: "lock.front_door" })).toMatchObject({ ok: false, error: { code: "permission" } });
    expect(calls).toEqual([]);
  });
});
