// Check V2 for Wave 2.7: every Prometheus read once against a real server, GET only. Run with
//   ATRIUM_TEST_PROM_URL=http://10.77.99.7:9090 [ATRIUM_TEST_PROM_OUT=<file>] pnpm exec vitest run src/packages/__tests__/prometheus-live.test.ts
// Skipped (never passed) without the variable. Reads whose needs the server lacks must say so through available().
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AdapterContext, ReadResult } from "@/core/contracts";
import { createHostHttp, type RequestRecord } from "@/features/integrations/host/http";
import prometheus, { available } from "../prometheus/adapter";
import { prometheusManifest } from "../prometheus/full-manifest";

const URL_ = process.env.ATRIUM_TEST_PROM_URL;
const log = { debug() {}, info() {}, warn() {}, error() {} };

function summary(r: ReadResult): string {
  if (!r.ok) return `FAIL ${r.error.code}: ${r.error.message}`;
  const d = r.data;
  if (d.kind === "stat") return `stat ${d.value}${d.format ? ` (${d.format})` : ""} "${d.label}"`;
  if (d.kind === "status") return `status ${d.items.length} items, ${d.items.filter((i) => i.state !== "up").length} not up; first: ${d.items[0] ? `${d.items[0].label} ${d.items[0].state}` : "-"}`;
  if (d.kind === "series") return `series ${d.series.length} lines (total ${d.total}), ${d.series[0]?.points.length ?? 0} points; names: ${d.series.slice(0, 9).map((s) => s.display ?? s.name).join(", ")}`;
  const first = d.rows[0] ? JSON.stringify(d.rows[0]).slice(0, 300) : "-";
  return `table ${d.rows.length} rows, columns ${d.columns.map((c) => `${c.key}${c.format ? `:${c.format}` : ""}`).join(",")}; first: ${first}`;
}

describe.skipIf(!URL_)(`every Prometheus read against ${URL_}`, () => {
  it("answers every read (or marks it not available), GET only", async () => {
    const sent: RequestRecord[] = [];
    const config = { baseUrl: URL_! };
    const ctx: AdapterContext = { config, http: createHostHttp({ manifest: prometheusManifest, config, secrets: async () => null, onRequest: (r) => sent.push(r) }), log, signal: new AbortController().signal, now: () => new Date() };
    const lines: string[] = [];
    const t0 = Date.now();
    const avail = await available(ctx);
    lines.push(`available(): ${JSON.stringify(avail)}`);
    const machines = await prometheus.read(ctx, "machines", {});
    const rows = machines.ok && machines.data.kind === "table" ? machines.data.rows : [];
    lines.push(`machines: ${rows.map((r) => `${String(r.name)} = ${String(r.instance)}`).join("; ")}`);
    const ace = (rows.find((r) => r.name === "ACE") ?? rows[0])?.instance as string | undefined;
    const pick = async (ep: string, key: string) => {
      const r = await prometheus.read(ctx, ep, {});
      return r.ok && r.data.kind === "table" ? (r.data.rows[0]?.[key] as string | undefined) : undefined;
    };
    const container = await pick("containers", "name");
    const guest = await pick("pve-guests", "id");
    const base: Record<string, unknown> = { machine: ace, container, guest, metric: "node_network_receive_bytes_total", label: "device", query: "count(up)" };
    const failures: string[] = [];
    for (const ep of prometheusManifest.endpoints) {
      const props = Object.keys(((ep.params as { properties?: object } | undefined)?.properties ?? {}) as object);
      const params = Object.fromEntries(props.filter((k) => base[k] !== undefined).map((k) => [k, base[k]]));
      if (ep.id === "range") params.query = "up";
      const variants: [string, Record<string, unknown>][] = [["", params]];
      if (props.includes("machine") && !ep.id.startsWith("explore") && ep.id !== "mounts") variants.push([" machine=*", { ...params, machine: "*" }]);
      if (props.includes("container")) variants.push([" container=*", { ...params, container: "*" }]);
      if (props.includes("guest")) variants.push([" guest=*", { ...params, guest: "*" }]);
      if (ep.id === "explore-value") variants.push([" how=rate splitBy=instance", { ...params, how: "rate", splitBy: "instance" }]);
      for (const [tag, p] of variants) {
        const s = performance.now();
        const r = await prometheus.read(ctx, ep.id, p);
        const ms = Math.round(performance.now() - s);
        const line = `${ep.id}${tag} [${ep.group ?? "-"}${avail[ep.id] === false ? ", not available" : ""}] ${ms} ms: ${summary(r)}`;
        lines.push(line);
        if (!r.ok && avail[ep.id] !== false && !(ep.id === "machine-temperature" || ep.id === "machine-updates")) failures.push(line);
      }
    }
    lines.push(`total ${Date.now() - t0} ms, ${sent.length} requests, methods: ${[...new Set(sent.map((s) => s.method))].join(",")}`);
    const out = lines.join("\n");
    console.log(out);
    if (process.env.ATRIUM_TEST_PROM_OUT) writeFileSync(process.env.ATRIUM_TEST_PROM_OUT, out + "\n");
    expect(sent.every((s) => s.method === "GET")).toBe(true);
    expect(failures).toEqual([]);
  }, 120_000);
});
