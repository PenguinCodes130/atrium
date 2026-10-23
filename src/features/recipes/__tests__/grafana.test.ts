// Grafana mapping on the saved Node Exporter Full (1860) JSON (spec 3.4, criteria 6 and 7).
import { describe, expect, it } from "vitest";
import g1860 from "../__fixtures__/grafana-1860.json";
import { convertExpr, mapDashboard, unitFormat } from "../grafana";
import { validateRecipe } from "../schema";

describe("Grafana import mapping (1860)", () => {
  const m = mapDashboard(g1860);
  const reads = m.recipe.reads;
  it("makes a valid draft-able recipe with well over 100 query reads", () => {
    const v = validateRecipe(m.recipe);
    if (!v.ok) throw new Error(`${v.problem.field} ${v.problem.message}`);
    expect(m.recipe.id).toBe("grafana/1860");
    expect(m.recipe.source).toBe("grafana");
    expect(reads.filter((r) => r.request.kind === "promql").length).toBeGreaterThan(200);
    expect(m.panels).toBe(124);
  });
  it("turns the leaf variable into a which-machine dropdown with friendly names", () => {
    const list = reads.find((r) => r.request.kind === "label-values")!;
    expect(list.request).toEqual({ kind: "label-values", metric: "node_uname_info", label: "instance", display: "nodename" });
    const cpu = reads.find((r) => r.label === "CPU Busy")!;
    expect(cpu.shape).toBe("stat");
    expect(cpu.format).toBe("percent");
    const props = (cpu.params as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(Object.keys(props)).toEqual(["node"]);
    expect(props.node!["x-atrium-choices"]).toMatchObject({ endpointId: list.id, value: "value", label: "label" });
    if (cpu.request.kind !== "promql") throw new Error();
    expect(cpu.request.expr).toContain('instance={{ params.node }}');
    expect(cpu.request.expr).toContain('job=~".*"');
    expect(cpu.request.expr).toContain("[5m]");
    expect(cpu.request.expr).not.toMatch(/\$/);
  });
  it("maps units, percentunit times 100, legends and rows (criterion 7)", () => {
    const pressure = reads.find((r) => r.label.startsWith("Pressure: CPU"))!;
    expect(pressure.format).toBe("percent");
    if (pressure.request.kind !== "promql") throw new Error();
    expect(pressure.request.expr).toMatch(/\) \* 100$/);
    expect(pressure.group).toBe("Quick CPU / Mem / Disk");
    const ram = reads.find((r) => r.label === "RAM Total")!;
    expect(ram.format).toBe("bytes");
    const net = reads.find((r) => r.shape === "series" && r.seriesName?.includes("{{device}}"))!;
    expect(net).toBeDefined();
    expect(net.request.kind === "promql" && net.request.range).toBeTruthy();
  });
  it("units and placeholders", () => {
    expect(unitFormat("bps")).toEqual({ format: "bytesPerSec", scale: "/ 8" });
    expect(unitFormat("percentunit")).toEqual({ format: "percent", scale: "* 100" });
    expect(convertExpr('rate(x{a="$__foo"}[1m])', [], new Set(), 6)).toEqual({ skip: "uses Grafana's $__foo, which Atrium cannot fill" });
  });
  it("lists skipped panels with reasons", () => {
    for (const s of m.skipped) expect(s.reason.length).toBeGreaterThan(5);
    console.log("reads", reads.length, "skipped", m.skipped.length, m.skipped.slice(0, 5));
  });
});
