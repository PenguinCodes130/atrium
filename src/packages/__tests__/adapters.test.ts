import { describe, expect, it } from "vitest";
import prometheus from "../prometheus/adapter";
import npm from "../npm/adapter";
import proxmox from "../proxmox/adapter";
import pfsense from "../pfsense/adapter";
import docker from "../docker/adapter";
import kuma from "../uptime-kuma/adapter";
import rss from "../rss/adapter";
import { createGenericAdapter } from "../declarative/runner";
import { parseFeed } from "../rss/parse";
import { fakeCtx, fixture } from "./fake";

describe("Prometheus (recorded from the live instance)", () => {
  const routes = {
    "api/v1/status/buildinfo": { body: fixture("prometheus-buildinfo.json") },
    "api/v1/targets": { body: fixture("prometheus-targets.json") },
    "api/v1/query": { body: fixture("prometheus-query.json") },
    "api/v1/query_range": { body: fixture("prometheus-range.json") },
  };
  it("health reports ok with the version", async () => {
    expect(await prometheus.health(fakeCtx(routes).ctx)).toMatchObject({ status: "ok", version: "3.14.0" });
  });
  it("target health as status", async () => {
    const r = await prometheus.read(fakeCtx(routes).ctx, "targets", {});
    expect(r).toMatchObject({ ok: true, data: { kind: "status" } });
    if (r.ok && r.data.kind === "status") expect(r.data.items[0]).toMatchObject({ label: "alertmanager: RP5-3", state: "up" });
  });
  it("instant query as a stat, range query as a series, all with GET", async () => {
    const f = fakeCtx(routes);
    expect(await prometheus.read(f.ctx, "query", { query: "count(up)" })).toMatchObject({ ok: true, data: { kind: "stat", value: 15 } });
    const r = await prometheus.read(f.ctx, "range", { query: "up", rangeSec: 600, stepSec: 120 });
    expect(r).toMatchObject({ ok: true, data: { kind: "series" } });
    if (r.ok && r.data.kind === "series") expect(r.data.series[0]!.points[0]).toEqual([1792288597000, 1]);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("a query error becomes a bad_response with Prometheus's message", async () => {
    const f = fakeCtx({ "api/v1/query": { status: 400, body: JSON.stringify({ status: "error", errorType: "bad_data", error: "parse error" }) } });
    expect(await prometheus.read(f.ctx, "query", { query: "(" })).toMatchObject({ ok: false, error: { code: "bad_response" } });
  });
});

describe("Nginx Proxy Manager (documented format)", () => {
  const routes = {
    "api/": { body: fixture("npm-status.json") },
    "api/users/me": { body: "{}" },
    "api/nginx/proxy-hosts": { body: fixture("npm-proxy-hosts.json") },
    "api/nginx/certificates": { body: fixture("npm-certificates.json") },
  };
  it("proxy hosts as a table with domain, forward target, enabled and SSL", async () => {
    const f = fakeCtx(routes);
    const r = await npm.read(f.ctx, "proxy-hosts", {});
    expect(r.ok && r.data.kind === "table" && r.data.rows).toEqual([
      { domain: "grafana.home.example", forward: "http://10.0.0.7:3000", enabled: "up", ssl: "Forced" },
      { domain: "old.home.example, legacy.home.example", forward: "https://10.0.0.20:8443", enabled: "down", ssl: "Off" },
    ]);
    expect(f.calls.every((c) => c.auth === "token" && c.method === "GET")).toBe(true);
  });
  it("certificates as a table with expiry time, soonest first", async () => {
    const r = await npm.read(fakeCtx(routes).ctx, "certificates", {});
    expect(r.ok && r.data.kind === "table" && r.data.rows.map((x) => [x.name, x.expires])).toEqual([["lab cert", Date.parse("2026-11-01T00:00:00Z")], ["home.example", Date.parse("2026-12-20T08:15:00Z")]]);
  });
  it("health checks the token and reports the version", async () => {
    expect(await npm.health(fakeCtx(routes).ctx)).toMatchObject({ status: "ok", version: "2.12.6" });
  });
  it("a wrong token gives the auth code with a sentence naming the token field", async () => {
    const f = fakeCtx({ ...routes, "api/users/me": { status: 401, body: fixture("npm-401.json") } });
    await expect(npm.health(f.ctx)).rejects.toMatchObject({ adapterError: { code: "auth", message: expect.stringContaining('"API token"') } });
  });
});

describe("Proxmox VE (documented format)", () => {
  const routes = { "api2/json/version": { body: fixture("proxmox-version.json") }, "api2/json/nodes": { body: fixture("proxmox-nodes.json") }, "api2/json/cluster/resources": { body: fixture("proxmox-resources.json") } };
  it("node status as status", async () => {
    const r = await proxmox.read(fakeCtx(routes).ctx, "nodes", {});
    expect(r.ok && r.data.kind === "status" && r.data.items.map((i) => [i.label, i.state])).toEqual([["pve1", "up"], ["pve2", "down"]]);
  });
  it("per-node CPU and memory as stats", async () => {
    expect(await proxmox.read(fakeCtx(routes).ctx, "node-cpu", { node: "pve1" })).toMatchObject({ ok: true, data: { kind: "stat", value: 7.3, format: "percent" } });
    expect(await proxmox.read(fakeCtx(routes).ctx, "node-memory", { node: "pve1" })).toMatchObject({ ok: true, data: { kind: "stat", value: 37.5, format: "percent" } });
    expect(await proxmox.read(fakeCtx(routes).ctx, "node-cpu", { node: "nope" })).toMatchObject({ ok: false, error: { code: "config" } });
  });
  it("VMs and containers as a table with name, node, state and uptime", async () => {
    const r = await proxmox.read(fakeCtx(routes).ctx, "guests", {});
    // Wave 2.7 (spec criterion 17): CPU, memory and disk columns from the same request.
    expect(r.ok && r.data.kind === "table" && r.data.rows).toEqual([
      expect.objectContaining({ name: "homeassistant", id: "qemu/101", node: "pve1", kind: "VM", state: "up", uptime: 400000 }),
      expect.objectContaining({ name: "pihole", id: "lxc/200", node: "pve1", kind: "Container", state: "down", uptime: 0 }),
    ]);
    if (r.ok && r.data.kind === "table") expect(r.data.columns.filter((c) => ["cpu", "memory", "disk"].includes(c.key)).map((c) => c.format)).toEqual(["percent", "percent", "bytes"]);
  });
  it("health uses the token and reports the version", async () => {
    const f = fakeCtx(routes);
    expect(await proxmox.health(f.ctx)).toMatchObject({ status: "ok", version: "9.0.10" });
    expect(f.calls[0]).toMatchObject({ auth: "token", method: "GET" });
  });
});

describe("pfSense (documented format)", () => {
  const routes = { "api/v2/system/version": { body: fixture("pfsense-version.json") }, "api/v2/status/gateways": { body: fixture("pfsense-gateways.json") }, "api/v2/status/interfaces": { body: fixture("pfsense-interfaces.json") }, "api/v2/firewall/rules": { body: fixture("pfsense-rules.json") } };
  it("gateway status, interfaces table and rule count", async () => {
    const c = fakeCtx(routes).ctx;
    const g = await pfsense.read(c, "gateways", {});
    expect(g.ok && g.data.kind === "status" && g.data.items.map((i) => i.state)).toEqual(["up", "down"]);
    const i = await pfsense.read(c, "interfaces", {});
    expect(i.ok && i.data.kind === "table" && i.data.rows.map((r) => r.status)).toEqual(["up", "up", "down"]);
    expect(await pfsense.read(c, "rule-count", {})).toMatchObject({ ok: true, data: { kind: "stat", value: 3 } });
    expect(await pfsense.health(c)).toMatchObject({ status: "ok", version: "2.8.1-RELEASE" });
  });
});

describe("Docker (documented format)", () => {
  it("containers as a table and running count as a stat", async () => {
    const body = JSON.stringify([{ Names: ["/a"], Image: "img:a", State: "running", Status: "Up 1 hour" }, { Names: ["/b"], Image: "img:b", State: "exited", Status: "Exited (1)" }]);
    const f = fakeCtx({ "containers/json": { body }, version: { body: JSON.stringify({ Version: "29.7.2" }) } });
    expect(await docker.read(f.ctx, "containers", {})).toMatchObject({ ok: true, data: { kind: "table", rows: [{ name: "a", image: "img:a", state: "running", status: "Up 1 hour" }, { name: "b" }] } });
    expect(await docker.read(f.ctx, "running", {})).toMatchObject({ ok: true, data: { value: 1 } });
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("Uptime Kuma (documented format)", () => {
  it("monitors as status: up, down, warn and unknown", async () => {
    const f = fakeCtx({ metrics: { body: fixture("uptime-kuma-metrics.txt") } });
    const r = await kuma.read(f.ctx, "monitors", {});
    expect(r.ok && r.data.kind === "status" && r.data.items.map((i) => [i.label, i.state])).toEqual([["Home Assistant", "up"], ["NAS", "down"], ["Backup job", "warn"], ["Printer", "unknown"]]);
    expect(await kuma.health(f.ctx)).toMatchObject({ status: "ok", version: "2.0.2" });
  });
});

describe("RSS / news", () => {
  it("feed items as a table, newest first, for RSS and Atom", async () => {
    const r = await rss.read(fakeCtx({ "": { body: fixture("feed-rss.xml") } }).ctx, "items", {});
    expect(r.ok && r.data.kind === "table" && r.data.rows.map((x) => x.title)).toEqual(["Newest item & more", "Middle ’item’", "Older item"]);
    expect(r.ok && r.data.kind === "table" && r.data.columns.map((c) => c.key)).toEqual(["title", "link", "published"]);
    const a = parseFeed(fixture("feed-atom.xml"));
    expect(a.items.map((i) => [i.title, i.link])).toEqual([["Second", "https://example.org/2"], ["First", "https://example.org/1"]]);
  });
  it("a page that is not a feed is a bad_response", async () => {
    expect(await rss.read(fakeCtx({ "": { body: "<html>hi</html>" } }).ctx, "items", {})).toMatchObject({ ok: false, error: { code: "bad_response" } });
  });
});

describe("generic declarative runner", () => {
  it("runs custom endpoint records and shapes them", async () => {
    const a = createGenericAdapter([{ id: "load", label: "Load", method: "GET", path: "/api/stats", fields: [{ path: "$.load", label: "Load", role: "value" }], shape: "stat", refreshSec: 10, auth: "token" }]);
    const f = fakeCtx({ "/api/stats": { body: JSON.stringify({ load: 1.5 }) } });
    expect(await a.read(f.ctx, "load", {})).toMatchObject({ ok: true, data: { kind: "stat", value: 1.5, label: "Load" } });
    expect(f.calls[0]).toMatchObject({ auth: "token", method: "GET" });
    expect(await a.health(f.ctx)).toMatchObject({ status: "ok" });
  });
});
