// Round 8 (architecture v3 Amendment A4.1): `ShapedData` series carry `total`, the number of series the
// source holds when known. Prometheus fills it with the full result count before Atrium trims to 20;
// custom endpoints fill it with their series count; the chart says "20 of 312 series".
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import prometheus from "@/packages/prometheus/adapter";
import { fakeCtx } from "@/packages/__tests__/fake";
import { shapeFromFields } from "../shape";
import { SeriesChart, seriesCountText } from "../ui/series-chart";

function matrix(n: number) {
  return JSON.stringify({
    status: "success",
    data: { resultType: "matrix", result: Array.from({ length: n }, (_, i) => ({ metric: { __name__: "up", instance: `host-${i}:9100`, job: "node" }, values: [[1792288597, "1"], [1792288657, String(i)]] })) },
  });
}

describe("A4.1 series total", () => {
  it("Prometheus: total is the full result count before the trim to 20", async () => {
    const r = await prometheus.read(fakeCtx({ "api/v1/query_range": { body: matrix(312) } }).ctx, "range", { query: "up" });
    expect(r.ok && r.data.kind === "series" && { n: r.data.series.length, total: r.data.total }).toEqual({ n: 20, total: 312 });
  });
  it("Prometheus: total is known (and equal) when nothing is trimmed", async () => {
    const r = await prometheus.read(fakeCtx({ "api/v1/query_range": { body: matrix(3) } }).ctx, "range", { query: "up" });
    expect(r.ok && r.data.kind === "series" && { n: r.data.series.length, total: r.data.total }).toEqual({ n: 3, total: 3 });
  });
  it("custom endpoints: total is the number of value fields (none are trimmed)", () => {
    const json = { rows: [{ t: "2026-10-18T10:00:00Z", a: 1, b: 2 }, { t: "2026-10-18T10:01:00Z", a: 3, b: 4 }] };
    const d = shapeFromFields(json, "series", [
      { path: "$.rows[*].t", role: "time", label: "time" },
      { path: "$.rows[*].a", role: "value", label: "A" },
      { path: "$.rows[*].b", role: "value", label: "B" },
    ] as Parameters<typeof shapeFromFields>[2], "x");
    expect(d.kind === "series" && { n: d.series.length, total: d.total }).toEqual({ n: 2, total: 2 });
  });
  it("count text: '20 of 312 series' when total is larger, '20 series' otherwise", () => {
    const series = Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, points: [[1, i]] as [number, number | null][] }));
    expect(seriesCountText({ series, total: 312 })).toBe("20 of 312 series");
    expect(seriesCountText({ series, total: 20 })).toBe("20 series");
    expect(seriesCountText({ series })).toBe("20 series");
    expect(seriesCountText({ series: series.slice(0, 1) })).toBe("1 series");
  });
  it("the integrations chart shows the count and names the total in its label and legend", () => {
    const series = Array.from({ length: 20 }, (_, i) => ({ name: `up{instance="h${i}"}`, points: [[1000, i], [61000, i + 1]] as [number, number | null][] }));
    const html = renderToStaticMarkup(createElement(SeriesChart, { data: { kind: "series", series, total: 312 } }));
    expect(html).toContain("20 of 312 series");
    expect(html).toContain('aria-label="Line chart of 20 of 312 series');
    expect(html).toContain("Drawing 5 of them.");
    const plain = renderToStaticMarkup(createElement(SeriesChart, { data: { kind: "series", series: series.slice(0, 3) } }));
    expect(plain).toContain(">3 series<");
    expect(plain).not.toMatch(/\d+ of \d+ series/);
  });
});
