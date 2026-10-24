// Wave 2.9 (Amendment 10): history reads (A10.3), measure and headline on every official package
// (A10.4, A10.5), and the built-in atrium/system package (A10.6), against the e2e stand-in Prometheus.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import os from "node:os";
import type { AdapterContext, PackageManifest, ReadResult } from "@/core/contracts";
import { createHostHttp } from "@/features/integrations/host/http";
import { validateManifest } from "@/features/integrations/manifest";
import { OFFICIAL_PACKAGES } from "@/features/integrations/official";
import { measureOf } from "@/features/data/measure";
import { catalogueKey, canonicalParams, parseCatalogueKey } from "@/features/data/catalogue-key";
import { isLoopback, probeReach, REACH_REFUSED } from "@/features/integrations/host/reach";
import { kindFromTitle } from "@/features/integrations/service-info";
import { startFakePrometheus, type FakePrometheus } from "../../../tests/e2e/fixtures/fake-prometheus";
import prometheus from "../prometheus/adapter";
import { HISTORY_READS, prometheusManifest, RECIPES } from "../prometheus/full-manifest";
import { historyHours } from "../prometheus/recipe";
import { runPromHistory } from "../prometheus/generic";

const ACE = "10.77.99.8:9100";
let prom: FakePrometheus;
let ctx: AdapterContext;
const sent: string[] = [];
beforeAll(async () => {
  prom = await startFakePrometheus();
  const config = { baseUrl: prom.url };
  ctx = { config, http: createHostHttp({ manifest: prometheusManifest, config, secrets: async () => null, onRequest: (r) => sent.push(r.url) }), log: { debug() {}, info() {}, warn() {}, error() {} }, signal: new AbortController().signal, now: () => new Date() };
});
afterAll(() => prom.close());

const ok = (r: ReadResult) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
};

describe("A10.3 history reads", () => {
  it("every instant built-in PromQL read (stat and status) has h:<id> pointing back from its history", () => {
    const byId = new Map(prometheusManifest.endpoints.map((e) => [e.id, e]));
    const instant = RECIPES.filter((r) => r.kind === "stat" || r.kind === "status");
    expect(instant.length).toBeGreaterThan(10);
    for (const r of instant) {
      const e = byId.get(r.id)!;
      expect(e.history?.endpointId).toBe(`h:${r.id}`);
      const h = byId.get(`h:${r.id}`)!;
      expect(h.shape).toBe("series");
      const hours = (h.params as { properties: Record<string, { enum?: number[]; default?: number }> }).properties.hours!;
      expect(hours.enum).toEqual([1, 6, 24, 168]);
      expect(hours.default).toBe(6);
      // The value read's own settings carry over, so a picked machine charts that machine.
      for (const k of Object.keys((e.params as { properties?: object } | undefined)?.properties ?? {})) expect(Object.keys((h.params as { properties: object }).properties)).toContain(k);
    }
    expect(HISTORY_READS.size).toBe(instant.length);
    expect(validateManifest(prometheusManifest, { hasAdapter: true, source: "official" }).ok).toBe(true);
  });

  it("h:machine-cpu runs the same query as a range query with the step for the span", async () => {
    prom.hits.length = 0;
    const d = ok(await prometheus.read(ctx, "h:machine-cpu", { machine: ACE, hours: 24 }));
    expect(d.kind).toBe("series");
    if (d.kind !== "series") return;
    expect(d.series).toHaveLength(1);
    expect(d.series[0]!.display).toBe("ACE");
    expect(d.format).toBe("percent");
    const range = prom.hits.map((h) => new URL(h.url, prom.url)).find((u) => u.pathname.endsWith("/api/v1/query_range"))!;
    expect(range.searchParams.get("query")).toContain('instance="10.77.99.8:9100"');
    expect(range.searchParams.get("query")).toContain("node_cpu_seconds_total");
    expect(Number(range.searchParams.get("step"))).toBe(360); // 24 h in about 240 points
  });

  it("Every machine charts one line per machine, named in words", async () => {
    const d = ok(await prometheus.read(ctx, "h:machine-cpu", { machine: "*" }));
    if (d.kind !== "series") throw new Error("not series");
    expect(d.series.length).toBe(9);
    expect(d.series.map((s) => s.display)).toEqual(expect.arrayContaining(["ACE", "pve1", "RP5-3"]));
  });

  it("refuses an hours value outside 1, 6, 24 and 168, and defaults to 6", async () => {
    expect(historyHours(undefined)).toBe(6);
    expect(historyHours("168")).toBe(168);
    const r = await prometheus.read(ctx, "h:machine-cpu", { machine: ACE, hours: 5 });
    expect(r.ok).toBe(false);
  });

  it("a generic recipe PromQL read runs over time with its expression and legend", async () => {
    const read = { id: "load", label: "Load", request: { kind: "promql" as const, expr: "node_load5{instance={{ params.node }}}" }, shape: "stat" as const, params: { type: "object", properties: { node: { type: "string" } } }, seriesName: "{{instance}}" };
    const { data } = await runPromHistory(ctx, read, { node: ACE, hours: 1 });
    if (data.kind !== "series") throw new Error("not series");
    expect(data.series[0]!.display).toBe(ACE);
    expect(data.series[0]!.points.length).toBeGreaterThan(100);
  });

  it("Home Assistant's sensor names its history read; Prometheus explore-value names explore-history", () => {
    const ha = OFFICIAL_PACKAGES.map((p) => p.manifest as PackageManifest).find((m) => m.id === "home-assistant")!;
    expect(ha.endpoints.find((e) => e.id === "sensor")!.history).toEqual({ endpointId: "history" });
    expect(prometheusManifest.endpoints.find((e) => e.id === "explore-value")!.history).toEqual({ endpointId: "explore-history" });
  });
});

describe("A10.4 measure and A10.5 service on every official package", () => {
  const manifests = OFFICIAL_PACKAGES.map((p) => p.manifest as PackageManifest).map((m) => (m.id === "prometheus" ? prometheusManifest : m));
  const KINDS: Record<string, string> = { docker: "containers", proxmox: "containers", prometheus: "monitoring", "home-assistant": "smart-home", "uptime-kuma": "monitoring", npm: "network", pfsense: "network", rss: "other", "custom-api": "other", "atrium/system": "other" };

  it("every package validates, names its kind, and at most 4 headline stats on declared reads", () => {
    for (const m of manifests) {
      const v = validateManifest(m, { hasAdapter: true, source: "official" });
      expect(v.ok, `${m.id}: ${v.ok ? "" : v.reason}`).toBe(true);
      if (!v.ok) continue;
      expect(v.manifest.service?.kind, m.id).toBe(KINDS[m.id]);
      const ids = new Set(v.manifest.endpoints.map((e) => e.id));
      for (const h of v.manifest.service?.headline ?? []) expect(ids.has(h.endpointId), `${m.id} ${h.endpointId}`).toBe(true);
      expect((v.manifest.service?.headline ?? []).length).toBeLessThanOrEqual(4);
    }
  });

  it("headline stats per package", () => {
    const h = (id: string) => (manifests.find((m) => m.id === id)!.service?.headline ?? []).map((x) => x.label);
    expect(h("docker")).toEqual(["Running", "Stopped", "Total"]);
    expect(h("uptime-kuma")).toEqual(["Up", "Down"]);
    expect(h("prometheus")).toEqual(["Machines up", "Down", "Alerts"]);
    expect(h("proxmox")).toEqual(["Nodes up", "Running", "Guests"]);
    expect(h("home-assistant")).toEqual(["Entities", "Unavailable"]);
    expect(h("npm")).toEqual(["Proxy hosts", "Certificates"]);
    expect(h("pfsense")).toEqual(["Gateways up", "Rules"]);
    expect(h("rss")).toEqual(["Items"]);
  });

  it("every endpoint of every package has a measure, its own or from its label words", () => {
    for (const m of manifests) for (const e of m.endpoints) expect(measureOf(e)).toMatch(/^(cpu|memory|disk|network|temperature|uptime|count|status|other)$/);
    expect(measureOf({ label: "CPU in use" })).toBe("cpu");
    expect(measureOf({ label: "Memory in use" })).toBe("memory");
    expect(measureOf({ label: "Root disk free" })).toBe("disk");
    expect(measureOf({ label: "Network in" })).toBe("network");
    expect(measureOf({ label: "Temperature" })).toBe("temperature");
    expect(measureOf({ label: "Uptime" })).toBe("uptime");
    expect(measureOf({ label: "Monitors", shape: "status" })).toBe("status");
    expect(measureOf({ label: "Running containers" })).toBe("count");
    expect(measureOf({ label: "Pending updates" })).toBe("other");
    expect(measureOf({ label: "Anything", measure: "disk" })).toBe("disk");
  });

  it("spec import takes its kind from words in the spec title", () => {
    expect(kindFromTitle("Jellyfin API")).toBe("media");
    expect(kindFromTitle("Sonarr")).toBe("media");
    expect(kindFromTitle("Portainer CE API")).toBe("containers");
    expect(kindFromTitle("AdGuard Home")).toBe("network");
    expect(kindFromTitle("Paperless-ngx REST API")).toBe("storage");
    expect(kindFromTitle("Some Service")).toBe("other");
  });

  it("catalogue keys are canonical: sorted keys, defaults and empty values dropped, and parse back", () => {
    const schema = { properties: { machine: {}, hours: { default: 6 } } };
    expect(canonicalParams({ machine: "a", hours: 6, x: "" }, schema)).toEqual({ machine: "a" });
    const k = catalogueKey("int-1", "r:lab:load", { z: "2", a: "1" });
    expect(k).toBe('int-1|r:lab:load|{"a":"1","z":"2"}');
    expect(parseCatalogueKey(k)).toEqual({ integrationId: "int-1", endpointId: "r:lab:load", params: { a: "1", z: "2" } });
    expect(parseCatalogueKey("nope")).toBeNull();
  });
});

describe("A10.6 reach", () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  let server: Server | undefined;
  let url = "";
  beforeAll(async () => {
    if (!lan) return;
    server = createServer((req, res) => { res.writeHead(req.url === "/broken" ? 503 : 200); res.end("ok"); });
    await new Promise<void>((r) => server!.listen(0, lan, () => r()));
    url = `http://${lan}:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it.runIf(!!lan)("answers up with a response time from a stand-in on the network", async () => {
    const r = await probeReach(url);
    expect(r.up).toBe(true);
    expect(r.ms).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(5000);
  });

  it.runIf(!!lan)("answers down for a 5xx and when nothing listens", async () => {
    expect((await probeReach(`${url}/broken`)).up).toBe(false);
    const port = (server!.address() as { port: number }).port;
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const r = await probeReach(`http://${lan}:${port}`);
    expect(r.up).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("refuses loopback, localhost, link-local and metadata addresses without contacting them", async () => {
    for (const u of ["http://127.0.0.1:3113", "http://localhost:80", "http://[::1]:80", "http://169.254.169.254/latest", "http://0.0.0.0:80", "http://[::ffff:127.0.0.1]/"]) {
      const r = await probeReach(u);
      expect(r, u).toEqual({ up: false, ms: 0, reason: REACH_REFUSED });
    }
    expect(isLoopback("127.9.9.9")).toBe(true);
    expect(isLoopback("10.0.0.5")).toBe(false);
    await expect(probeReach("ftp://10.0.0.5/")).rejects.toThrow(/http and https/);
  });

  it("gives up after 5 s on an address that never answers", async () => {
    // 10.255.255.1 is a private address nothing routes to; a SYN there hangs.
    const t = Date.now();
    const r = await probeReach("http://10.255.255.1:81/", { timeoutMs: 1500 });
    expect(r.up).toBe(false);
    expect(Date.now() - t).toBeLessThan(4000);
  });
});
