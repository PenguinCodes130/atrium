// Wave 2.7 (data ease spec 3.4, criteria 16 and 17; Amendment 8 A8.2, A8.4): Home Assistant "A sensor",
// sensors and unavailable entities; Proxmox guest columns, "A VM or container" and storage; Docker
// "A container" with health, CPU and memory; and the live-choice descriptors on their manifests.
import { describe, expect, it } from "vitest";
import { choicesSummary } from "@/features/integrations/choices";
import { validateManifest } from "@/features/integrations/manifest";
import ha from "../home-assistant/adapter";
import haManifest from "../home-assistant/manifest.json";
import proxmox from "../proxmox/adapter";
import proxmoxManifest from "../proxmox/manifest.json";
import docker from "../docker/adapter";
import dockerManifest from "../docker/manifest.json";
import { fakeCtx, fixture } from "./fake";

const states = { body: fixture("ha-states.json") };
const one = (id: string) => ({ body: JSON.stringify((JSON.parse(fixture("ha-states.json")) as { entity_id: string }[]).find((e) => e.entity_id === id)) });

describe("Home Assistant (criterion 16)", () => {
  it("A sensor shows the picked sensor's number with its unit as a format", async () => {
    const { ctx } = fakeCtx({ "api/states/sensor.living_room_temperature": one("sensor.living_room_temperature") });
    expect(await ha.read(ctx, "sensor", { entityId: "sensor.living_room_temperature" })).toMatchObject({ ok: true, data: { kind: "stat", value: 21.4, label: "Living room temperature", format: "celsius" } });
  });
  it("A sensor that is not a number says so, in words", async () => {
    const { ctx } = fakeCtx({ "api/states/scene.movie_night": one("scene.movie_night") });
    expect(await ha.read(ctx, "sensor", { entityId: "scene.movie_night" })).toMatchObject({ ok: false, error: { message: 'Movie night is "unknown" right now, not a number.' } });
  });
  it("sensors lists only entities with a number, for the sensor list; every sensor answers that list", async () => {
    const { ctx } = fakeCtx({ "api/states": states });
    const r = await ha.read(ctx, "sensors", {});
    expect(r.ok && r.data.kind === "table" && r.data.rows).toEqual([{ entity_id: "sensor.living_room_temperature", name: "Living room temperature", value: 21.4, unit: "C", device_class: "", detail: "21.4 C · sensor.living_room_temperature" }]);
    const every = await ha.read(ctx, "sensor", { entityId: "*" });
    expect(every.ok && every.data.kind === "table" && every.data.rows).toHaveLength(1);
  });
  it("unavailable lists entities that are unavailable or unknown", async () => {
    const { ctx } = fakeCtx({ "api/states": states });
    const r = await ha.read(ctx, "unavailable", {});
    expect(r.ok && r.data.kind === "table" && r.data.rows).toEqual([{ name: "Movie night", entity_id: "scene.movie_night", domain: "scene", state: "warn", since: "2026-10-16T20:00:00Z" }]);
  });
  it("entity settings pick from the live entity, sensor and area lists", () => {
    const by = Object.fromEntries(haManifest.endpoints.map((e) => [e.id, e]));
    expect(choicesSummary(by.entity!.params)).toEqual([{ param: "entityId", endpointId: "states", every: false }]);
    expect(choicesSummary(by.sensor!.params)).toEqual([{ param: "entityId", endpointId: "sensors", every: true }]);
    expect(choicesSummary(by.history!.params)).toEqual([{ param: "entityId", endpointId: "sensors", every: false }]);
    expect(choicesSummary(by.states!.params)).toEqual([{ param: "area", endpointId: "areas", every: false }]);
    expect(validateManifest(haManifest, { hasAdapter: true, source: "official" }).ok).toBe(true);
  });
});

describe("Proxmox (criterion 17)", () => {
  const routes = { "api2/json/nodes": { body: fixture("proxmox-nodes.json") }, "api2/json/cluster/resources": { body: fixture("proxmox-resources.json") } };
  it("the guests table has CPU, memory and disk columns, formatted", async () => {
    const r = await proxmox.read(fakeCtx(routes).ctx, "guests", {});
    if (!r.ok || r.data.kind !== "table") throw new Error("not a table");
    expect(r.data.rows[0]).toMatchObject({ name: "homeassistant", cpu: 7.3, memory: 50, memoryUsed: 2147483648, disk: 0, diskSize: 34359738368, detail: "VM 101 on pve1" });
    expect(Object.fromEntries(r.data.columns.map((c) => [c.key, c.format]))).toMatchObject({ cpu: "percent", memory: "percent", disk: "bytes", uptime: "seconds" });
  });
  it("A VM or container: one guest by its id, or every guest", async () => {
    const one = await proxmox.read(fakeCtx(routes).ctx, "guest", { guest: "lxc/200" });
    expect(one.ok && one.data.kind === "table" && one.data.rows.map((x) => x.name)).toEqual(["pihole"]);
    const all = await proxmox.read(fakeCtx(routes).ctx, "guest", { guest: "*" });
    expect(all.ok && all.data.kind === "table" && all.data.rows).toHaveLength(2);
    expect(await proxmox.read(fakeCtx(routes).ctx, "guest", { guest: "qemu/999" })).toMatchObject({ ok: false, error: { code: "config" } });
  });
  it("storage rows with used and free space", async () => {
    const r = await proxmox.read(fakeCtx(routes).ctx, "storage", {});
    expect(r.ok && r.data.kind === "table" && r.data.rows).toEqual([{ storage: "local", node: "pve1", type: "dir", state: "up", used: 21474836480, size: 107374182400, free: 85899345920, usedPct: 20, shared: "No" }]);
  });
  it("node and guest settings pick from live lists", () => {
    const by = Object.fromEntries(proxmoxManifest.endpoints.map((e) => [e.id, e]));
    expect(choicesSummary(by["node-cpu"]!.params)).toEqual([{ param: "node", endpointId: "nodes", every: false }]);
    expect(choicesSummary(by.guest!.params)).toEqual([{ param: "guest", endpointId: "guests", every: true }]);
    expect(validateManifest(proxmoxManifest, { hasAdapter: true, source: "official" }).ok).toBe(true);
  });
});

describe("Docker", () => {
  const list = [
    { Id: "a".repeat(64), Names: ["/grafana"], Image: "grafana/grafana:12", State: "running", Status: "Up 3 days (healthy)" },
    { Id: "b".repeat(64), Names: ["/backup"], Image: "restic/restic", State: "exited", Status: "Exited (0) 5 hours ago" },
  ];
  const statsBody = { cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 }, precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 80_000_000 }, memory_stats: { usage: 300_000_000, limit: 2_000_000_000, stats: { inactive_file: 50_000_000 } } };
  const routes = { "containers/json": { body: JSON.stringify(list) }, [`containers/${"a".repeat(64)}/stats`]: { body: JSON.stringify(statsBody) } };
  it("A container: state, health, CPU and memory from one stats sample, GET only", async () => {
    const f = fakeCtx(routes);
    const r = await docker.read(f.ctx, "container", { container: "grafana" });
    expect(r.ok && r.data.kind === "table" && r.data.rows[0]).toMatchObject({ name: "grafana", state: "running", health: "up", cpu: 20, memory: 250_000_000, memoryLimit: 2_000_000_000 });
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(await docker.read(fakeCtx(routes).ctx, "container", { container: "../../etc" })).toMatchObject({ ok: false, error: { code: "config" } });
  });
  it("a stopped container needs no stats; every container lists without stats", async () => {
    const f = fakeCtx(routes);
    const r = await docker.read(f.ctx, "container", { container: "backup" });
    expect(r.ok && r.data.kind === "table" && r.data.rows[0]).toMatchObject({ name: "backup", cpu: null, memory: null });
    expect(f.calls.some((c) => c.path.includes("stats"))).toBe(false);
    const all = await docker.read(fakeCtx(routes).ctx, "container", { container: "*" });
    expect(all.ok && all.data.kind === "table" && all.data.rows).toHaveLength(2);
    expect(await docker.read(fakeCtx(routes).ctx, "unhealthy", {})).toMatchObject({ ok: true, data: { value: 0 } });
  });
  it("the container setting picks from the live list", () => {
    expect(choicesSummary(dockerManifest.endpoints.find((e) => e.id === "container")!.params)).toEqual([{ param: "container", endpointId: "containers", every: true }]);
    expect(validateManifest(dockerManifest, { hasAdapter: true, source: "official" }).ok).toBe(true);
  });
});
