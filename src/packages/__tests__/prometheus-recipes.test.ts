// Wave 2.7 (data ease spec 3.3, criteria 3, 4, 13, 14, 15; Amendment 8 A8.1, A8.2, A8.4): the Prometheus
// recipe table, its interpreter, the friendly name rule, query escaping and available(), run against
// the e2e stand-in Prometheus (9 machines, RP5-3 without a host label, no cAdvisor or Proxmox exporter).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterContext, ReadResult } from "@/core/contracts";
import { createHostHttp, type RequestRecord } from "@/features/integrations/host/http";
import { validateManifest } from "@/features/integrations/manifest";
import { choicesFrom, choicesSpecs, choicesSummary } from "@/features/integrations/choices";
import { startFakePrometheus, type FakePrometheus } from "../../../tests/e2e/fixtures/fake-prometheus";
import prometheus, { available } from "../prometheus/adapter";
import { prometheusManifest, RECIPES } from "../prometheus/full-manifest";
import { fillQuery, loadRecipes } from "../prometheus/recipe";
import recipesJson from "../__fixtures__/prometheus-w27-recipes.json";
import { friendlyName, lit, seriesDisplays, withoutPort } from "../prometheus/promql";

const ACE = "10.77.99.8:9100";
const RP53 = "host.docker.internal:9100";

let prom: FakePrometheus;
let ctx: AdapterContext;
const sent: RequestRecord[] = [];
beforeAll(async () => {
  prom = await startFakePrometheus();
  const config = { baseUrl: prom.url };
  ctx = { config, http: createHostHttp({ manifest: prometheusManifest, config, secrets: async () => null, onRequest: (r) => sent.push(r) }), log: { debug() {}, info() {}, warn() {}, error() {} }, signal: new AbortController().signal, now: () => new Date() };
});
afterAll(() => prom.close());

const ok = (r: ReadResult) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
};

describe("the recipe table (lead request: one serialisable table, one interpreter)", () => {
  it("is plain JSON, loads through the recipe schema, and every recipe becomes a manifest endpoint", () => {
    expect(JSON.parse(JSON.stringify(recipesJson))).toEqual(recipesJson);
    expect(loadRecipes(recipesJson)).toHaveLength(RECIPES.length);
    expect(RECIPES.length).toBeGreaterThanOrEqual(30);
    const ids = prometheusManifest.endpoints.map((e) => e.id);
    for (const r of RECIPES) expect(ids).toContain(r.id);
    expect(ids).toEqual(expect.arrayContaining(["targets", "query", "range", "alerts", "disk-health", "explore-value", "explore-history", "metrics"]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateManifest(prometheusManifest, { hasAdapter: true, source: "official" })).toMatchObject({ ok: true });
  });

  it("the validated manifest keeps group, advanced and needs (A8.1)", () => {
    const v = validateManifest(prometheusManifest, { hasAdapter: true, source: "official" });
    if (!v.ok) throw new Error(v.reason);
    const by = Object.fromEntries(v.manifest.endpoints.map((e) => [e.id, e]));
    expect(by["machine-cpu"]).toMatchObject({ group: "Machines", needs: "node-exporter on your machines" });
    expect(by.query).toMatchObject({ group: "Advanced", advanced: true, label: "Custom PromQL: one number" });
    expect(by.containers).toMatchObject({ group: "Containers", needs: "cAdvisor (container metrics)" });
    const groups = new Set(v.manifest.endpoints.map((e) => e.group));
    for (const g of ["Machines", "All machines", "Containers", "Proxmox", "Disks", "Alerts", "Pick a metric", "Advanced"]) expect(groups).toContain(g);
  });

  it("every recipe query fills for one machine and for every machine, with no placeholder left", () => {
    const params = { machine: ACE, mount: "/", direction: "out", period: "15", measure: "memory", hours: 6, count: 3, container: "grafana", guest: "qemu/102" };
    for (const r of RECIPES) {
      const qs = [r.kind === "table" ? r.rows : typeof r.query === "string" ? r.query : Object.values(r.query.cases)[0]!, ...(r.kind === "table" ? r.columns.flatMap((c) => (typeof c.value === "object" ? [c.value.query] : [])) : [])];
      for (const q of qs) {
        for (const p of [params, { ...params, machine: "*", container: "*", guest: "*" }]) {
          const out = fillQuery(r, q, p);
          expect(out, `${r.id}: ${out}`).not.toMatch(/\{\{|\}\}/);
        }
      }
    }
  });

  it("a picked value can never break out of its string literal", () => {
    const r = RECIPES.find((x) => x.id === "machine-cpu")!;
    const evil = 'x"} or vector(1) or up{a="\\';
    const q = fillQuery(r, "{{measure}}", { machine: evil });
    expect(q).toContain(`instance=${lit(evil)},`);
    expect(lit(evil)).toBe('"x\\"} or vector(1) or up{a=\\"\\\\"');
    expect(() => fillQuery(r, "{{measure}}", { machine: "a".repeat(600) })).toThrow();
  });
});

describe("friendly names (spec 3.3, criterion 3)", () => {
  it("host label, else the machine's own hostname, else the address without its port", () => {
    expect(friendlyName({ host: "pve1", instance: "10.77.99.4:9100" }, "proxmox")).toBe("pve1");
    expect(friendlyName({ instance: RP53 }, "RP5-3")).toBe("RP5-3");
    expect(friendlyName({ instance: "10.0.0.9:9100" })).toBe("10.0.0.9");
    expect(withoutPort("[fe80::1]:9100")).toBe("fe80::1");
  });

  it("chart lines are named by machine, and two lines of one machine get what tells them apart", () => {
    expect(seriesDisplays([{ __name__: "up", instance: ACE, job: "node", host: "ACE" }, { __name__: "up", instance: "x:9090", job: "prometheus", host: "ACE" }])).toEqual(["ACE (node)", "ACE (prometheus)"]);
    expect(seriesDisplays([{ instance: ACE, device: "eth0" }, { instance: ACE, device: "eth1" }], new Map([[ACE, "ACE"]]))).toEqual(["ACE eth0", "ACE eth1"]);
  });
});

describe("reads against the stand-in Prometheus", () => {
  it("machines: 9 rows by friendly name, RP5-3 from its nodename, stored by address (criterion 3)", async () => {
    const d = ok(await prometheus.read(ctx, "machines", {}));
    if (d.kind !== "table") throw new Error("not a table");
    expect(d.rows).toHaveLength(9);
    expect(d.rows.map((r) => r.name)).toEqual(["ACE", "firefly", "minipc-ubuntu", "Pelican", "pve1", "pve2", "pve3", "RP5-2", "RP5-3"]);
    expect(d.rows.find((r) => r.name === "RP5-3")).toMatchObject({ instance: RP53, up: "up", cores: 4 });
    expect(d.rows.find((r) => r.name === "pve1")!.detail).toBe("10.77.99.4:9100 · Linux x86_64 · 12 cores");
    expect(d.columns.find((c) => c.key === "memory")).toMatchObject({ format: "bytes" });
  });

  it("one machine gives one formatted value; every machine (\"*\") gives rows (A8.2, criterion 13)", async () => {
    expect(ok(await prometheus.read(ctx, "machine-cpu", { machine: ACE }))).toEqual({ kind: "stat", value: 7.8, label: "CPU in use", format: "percent" });
    expect(ok(await prometheus.read(ctx, "machine-uptime", { machine: ACE }))).toMatchObject({ value: 273600, format: "seconds" });
    expect(ok(await prometheus.read(ctx, "machine-network", { machine: ACE, direction: "out" }))).toMatchObject({ value: 420000, format: "bytesPerSec", label: "Network out" });
    const every = ok(await prometheus.read(ctx, "machine-memory", { machine: "*" }));
    expect(every).toMatchObject({ kind: "table", columns: [{ key: "name" }, { key: "instance" }, { key: "value", format: "percent" }] });
    if (every.kind === "table") expect(every.rows).toHaveLength(9);
    expect(await prometheus.read(ctx, "machine-cpu", {})).toMatchObject({ ok: false, error: { code: "config" } });
    expect(await prometheus.read(ctx, "machine-temperature", { machine: ACE })).toMatchObject({ ok: false, error: { message: "This machine reports no temperature sensors." } });
  });

  it("Machines overview has CPU, memory, disk, network in and out and uptime for all 9, with formats (criteria 2, 13)", async () => {
    const d = ok(await prometheus.read(ctx, "machines-overview", {}));
    if (d.kind !== "table") throw new Error("not a table");
    expect(d.rows).toHaveLength(9);
    expect(d.rows[0]).toMatchObject({ name: "ACE", instance: ACE, up: "up", cpu: 7.8, memory: 41.2, disk: 52.3, netIn: 3100000, netOut: 420000, uptime: 273600 });
    const fmt = Object.fromEntries(d.columns.map((c) => [c.key, c.format]));
    expect(fmt).toMatchObject({ cpu: "percent", memory: "percent", disk: "percent", netIn: "bytesPerSec", netOut: "bytesPerSec", uptime: "seconds", temperature: "celsius" });
    expect(d.rows.find((r) => r.name === "RP5-3")!.temperature).toBe(61.2);
  });

  it("a chart of every machine names each line by its friendly name (criterion 14)", async () => {
    const d = ok(await prometheus.read(ctx, "machines-history", { measure: "cpu", hours: 1 }));
    if (d.kind !== "series") throw new Error("not a series");
    expect(d.format).toBe("percent");
    expect(d.series.map((s) => s.display)).toEqual(["ACE", "firefly", "minipc-ubuntu", "Pelican", "pve1", "pve2", "pve3", "RP5-2", "RP5-3"]);
    expect(d.series.every((s) => s.name.includes("instance="))).toBe(true);
  });

  it("a renamed machine keeps its data, shown under the new name (criterion 4)", async () => {
    prom.setHost(ACE, "ACE-renamed");
    try {
      expect(ok(await prometheus.read(ctx, "machine-cpu", { machine: ACE }))).toMatchObject({ value: 7.8 });
      const d = ok(await prometheus.read(ctx, "machines", {}));
      if (d.kind === "table") expect(d.rows.find((r) => r.instance === ACE)!.name).toBe("ACE-renamed");
    } finally {
      prom.setHost(ACE, "ACE");
    }
  });

  it("a machine that is down still lists, as down", async () => {
    prom.setDown(ACE, true);
    try {
      const d = ok(await prometheus.read(ctx, "machines-up", {}));
      if (d.kind === "status") expect(d.items[0]).toMatchObject({ label: "ACE", state: "down" });
    } finally {
      prom.setDown(ACE, false);
    }
  });

  it("available() hides cAdvisor, Proxmox and disk health reads on a server without them (A8.1, criterion 15)", async () => {
    const a = await available(ctx);
    expect(a).toMatchObject({ "machine-cpu": true, "machines-overview": true, "machine-temperature": true, "machine-updates": true, containers: false, "container-cpu": false, "pve-guests": false, "pve-storage": false, "disk-health": false });
  });

  it("custom PromQL with several series answers rows instead of failing (research 5.9)", async () => {
    const d = ok(await prometheus.read(ctx, "query", { query: "node_load5" }));
    expect(d.kind).toBe("table");
    if (d.kind === "table") expect(d.rows.map((r) => r.name)).toContain("RP5-3");
  });

  it("everything was GET", () => {
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.every((s) => s.method === "GET")).toBe(true);
  });
});

describe("live choices (A8.2)", () => {
  it("descriptors are read from params, with dependsOn for lists that follow another setting", () => {
    const disk = prometheusManifest.endpoints.find((e) => e.id === "machine-disk")!;
    expect(choicesSpecs(disk.params).mount).toMatchObject({ endpointId: "mounts", value: "mount", params: { machine: "machine" } });
    expect(choicesSummary(disk.params)).toEqual([
      { param: "machine", endpointId: "machines", every: true },
      { param: "mount", endpointId: "mounts", every: false, dependsOn: ["machine"] },
    ]);
  });

  it("rows become value, label and detail only; search, de-duplication and the 500 cap", async () => {
    const d = ok(await prometheus.read(ctx, "machines", {}));
    const spec = choicesSpecs(prometheusManifest.endpoints.find((e) => e.id === "machine-cpu")!.params).machine!;
    const all = choicesFrom(d, spec);
    expect(all.total).toBe(9);
    expect(all.choices.find((c) => c.label === "RP5-3")).toEqual({ value: RP53, label: "RP5-3", detail: `${RP53} · Linux aarch64 · 4 cores` });
    expect(Object.keys(all.choices[0]!).sort()).toEqual(["detail", "label", "value"]);
    expect(choicesFrom(d, spec, "pve aarch").choices).toEqual([]);
    expect(choicesFrom(d, spec, "pve").choices.map((c) => c.label)).toEqual(["pve1", "pve2", "pve3"]);
    const big = { kind: "table" as const, columns: [], rows: Array.from({ length: 700 }, (_, i) => ({ v: `m${i % 650}` })) };
    const capped = choicesFrom(big, { endpointId: "x", value: "v", label: "v", every: false });
    expect(capped.choices).toHaveLength(500);
    expect(capped.total).toBe(650);
    expect(choicesFrom({ kind: "status", items: [{ label: "pve2", state: "up", detail: "online" }] }, { endpointId: "nodes", value: "label", label: "label", detail: "detail", every: false }).choices).toEqual([{ value: "pve2", label: "pve2", detail: "online" }]);
  });
});
