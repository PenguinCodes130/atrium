// Pure parts: live check classification, PromQL placeholder escaping (A9.4), legends, Grafana skips.
import { describe, expect, it } from "vitest";
import type { ReadResult } from "@/core/contracts";
import { fillExpr, legendText, NO_VALUE } from "@/packages/prometheus/generic";
import { fillRequestText } from "@/packages/declarative/runner";
import { classify, oddValue } from "../classify";
import { mapDashboard } from "../grafana";

const at = "2026-10-20T10:00:00.000Z";
const ok = (data: Extract<ReadResult, { ok: true }>["data"]): ReadResult => ({ ok: true, data, sourceTimestamp: at, fetchedAt: at });

describe("live check classification (A9.2)", () => {
  it("works, empty, failed with reason, looks odd", () => {
    expect(classify(ok({ kind: "stat", value: 7.8, label: "CPU", format: "percent" }), at)).toEqual({ status: "ok", at });
    expect(classify(ok({ kind: "table", columns: [], rows: [] }), at)).toMatchObject({ status: "empty" });
    expect(classify(ok({ kind: "series", series: [] }), at)).toMatchObject({ status: "empty" });
    expect(classify({ ok: false, error: { code: "bad_response", message: NO_VALUE }, fetchedAt: at }, at)).toMatchObject({ status: "empty" });
    expect(classify({ ok: false, error: { code: "bad_response", message: "The service answered, but that path does not exist (HTTP 404)." }, fetchedAt: at }, at)).toEqual({ status: "failed", reason: "The service answered, but that path does not exist (HTTP 404).", at });
    expect(classify(ok({ kind: "stat", value: 12, label: "Size", format: "bytes" }), at)).toMatchObject({ status: "odd", reason: expect.stringContaining("under 1 KB") });
    expect(classify(ok({ kind: "stat", value: 140, label: "Busy", format: "percent" }), at)).toMatchObject({ status: "odd", reason: expect.stringContaining("over 100") });
    expect(classify(ok({ kind: "stat", value: 1.76e9, label: "Uptime", format: "seconds" }), at)).toMatchObject({ status: "odd", reason: expect.stringContaining("1970") });
    expect(classify(ok({ kind: "table", columns: [{ key: "t", label: "Added", type: "time" }], rows: [{ t: 86_400_000 }] }), at)).toMatchObject({ status: "odd", reason: expect.stringContaining("1970") });
    expect(oddValue(0, "bytes")).toBeNull();
  });
});

describe("Prometheus generic read (A9.4)", () => {
  it("puts values in only as escaped string literals", () => {
    expect(fillExpr("up{instance={{ params.node }}}", { node: '10.0.0.1:9100"} or vector(1) or up{x="' })).toBe('up{instance="10.0.0.1:9100\\"} or vector(1) or up{x=\\""}');
    expect(fillExpr("up{i={{params.node}}}", { node: "a\\b\nc" })).toBe('up{i="a\\\\b\\nc"}');
    expect(() => fillExpr("up{i={{ params.node }}}", {})).toThrow(/Pick node first/);
    expect(() => fillExpr("up{i={{ params.mode }}}", { mode: "x" }, { properties: { mode: { enum: ["a", "b"] } } })).toThrow(/not one of the choices/);
  });
  it("names chart lines with Grafana legend syntax", () => {
    expect(legendText("{{device}} - Rx", { device: "eth0", instance: "x" })).toBe("eth0 - Rx");
  });
  it("http placeholders are URL-encoded and never path segments", () => {
    expect(fillRequestText("/api/series/{{ params.id }}", { id: "../admin" }, undefined)).toBe("/api/series/..%2Fadmin");
    expect(() => fillRequestText("/api/series/{{ params.id }}", { id: ".." }, undefined)).toThrow(/not a usable value/);
  });
});

describe("Grafana import lists what it skips", () => {
  it("names transformations, other data sources, unknown panels and placeholders", () => {
    const m = mapDashboard({
      title: "Mixed", uid: "mixed-1", time: { from: "now-24h" },
      templating: { list: [{ type: "query", name: "host", label: "Host", query: "label_values(node_uname_info, instance)" }, { type: "query", name: "weird", query: "query_result(up)" }] },
      panels: [
        { type: "row", title: "Main", panels: [] },
        { type: "stat", title: "Up", targets: [{ expr: 'up{instance="$host"}', refId: "A" }], fieldConfig: { defaults: { unit: "percentunit" } } },
        { type: "timeseries", title: "Net", targets: [{ expr: 'rate(x_bytes{instance="$host"}[$__rate_interval]) * 8', legendFormat: "{{device}}", refId: "A" }], fieldConfig: { defaults: { unit: "bps" } } },
        { type: "stat", title: "Joined", transformations: [{ id: "merge" }], targets: [{ expr: "up", refId: "A" }] },
        { type: "timeseries", title: "Logs", datasource: { type: "loki", uid: "l" }, targets: [{ expr: "{job=\"x\"}" }] },
        { type: "text", title: "Notes" },
        { type: "stat", title: "Odd", targets: [{ expr: 'up{x="$weird"}', refId: "A" }] },
        { type: "stat", title: "Ms", targets: [{ expr: "up[$__interval_ms]", refId: "A" }] },
      ],
    });
    expect(m.recipe.id).toBe("grafana/mixed-1");
    expect(m.skipped).toEqual([
      { title: "Joined", reason: "uses Grafana transformations, which Atrium does not run" },
      { title: "Logs", reason: "reads from a loki data source, not Prometheus" },
      { title: "Notes", reason: "is a text panel, which Atrium has no shape for" },
      { title: "Odd", reason: expect.stringContaining("$weird") },
      { title: "Ms", reason: "uses Grafana's $__interval_ms, which Atrium cannot fill" },
    ]);
    const up = m.recipe.reads.find((r) => r.label === "Up")!;
    expect(up.request).toEqual({ kind: "promql", expr: "(up{instance={{ params.host }}}) * 100" });
    expect(up.format).toBe("percent");
    const net = m.recipe.reads.find((r) => r.label === "Net")!;
    expect(net).toMatchObject({ shape: "series", format: "bytesPerSec", seriesName: "{{device}}", group: "Main", request: { range: { hours: 24 } } });
    expect(net.request.kind === "promql" && net.request.expr).toBe("(rate(x_bytes{instance={{ params.host }}}[5m]) * 8) / 8");
  });
});
