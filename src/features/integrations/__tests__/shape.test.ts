import { describe, expect, it } from "vitest";
import { buildTree, childPath, evaluate, proposeShape, proposeComponent, shapeFromFields, TRUNCATE_BYTES, type TreeNode } from "../shape";

const sample = {
  name: "nas",
  load: 0.42,
  points: [{ t: "2026-10-17T10:00:00Z", v: 1 }, { t: "2026-10-17T10:01:00Z", v: 3 }],
  disks: [{ dev: "sda", used: 70, ok: true }, { dev: "sdb", used: 12, ok: false }],
};

describe("shape proposal", () => {
  it("one number picked as value proposes a stat shape and a stat widget", () => {
    const p = proposeShape([{ path: "$.load", label: "Load", role: "value" }]);
    expect(p.shape).toBe("stat");
    const data = shapeFromFields(sample, p.shape, p.fields, "Load");
    expect(data).toEqual({ kind: "stat", value: 0.42, label: "Load" });
    expect(proposeComponent(data)).toBe("stat");
  });

  it("a time and a number inside an array propose a series shape and a chart widget", () => {
    const p = proposeShape([{ path: "$.points[0].t", label: "Time", role: "time" }, { path: "$.points[0].v", label: "Value", role: "value" }]);
    expect(p.shape).toBe("series");
    expect(p.fields.map((f) => f.path)).toEqual(["$.points[*].t", "$.points[*].v"]);
    const data = shapeFromFields(sample, p.shape, p.fields, "x");
    // Round 8 (A4.1): custom endpoints carry `total`, their series count (nothing is trimmed).
    expect(data).toEqual({ kind: "series", series: [{ name: "Value", points: [[Date.parse("2026-10-17T10:00:00Z"), 1], [Date.parse("2026-10-17T10:01:00Z"), 3]] }], total: 1 });
    expect(proposeComponent(data)).toBe("chart");
  });

  it("columns in an array propose a table, and a list when there are two columns or fewer", () => {
    const p = proposeShape([{ path: "$.disks[1].dev", label: "Disk", role: "column" }, { path: "$.disks[1].used", label: "Used", role: "value" }, { path: "$.disks[0].ok", label: "OK", role: "column" }]);
    expect(p.shape).toBe("table");
    const data = shapeFromFields(sample, p.shape, p.fields, "x");
    expect(data.kind === "table" && data.rows).toEqual([{ disk: "sda", used: 70, ok: true }, { disk: "sdb", used: 12, ok: false }]);
    expect(proposeComponent(data)).toBe("table");
    expect(proposeComponent(shapeFromFields(sample, "table", p.fields.slice(0, 2), "x"))).toBe("list");
  });

  it("labels with statuses propose a status shape", () => {
    const p = proposeShape([{ path: "$.disks[0].dev", label: "Disk", role: "label" }, { path: "$.disks[0].ok", label: "OK", role: "status" }]);
    expect(p.shape).toBe("status");
    const data = shapeFromFields(sample, p.shape, p.fields, "x");
    expect(data).toEqual({ kind: "status", items: [{ label: "sda", state: "up", detail: "true" }, { label: "sdb", state: "down", detail: "false" }] });
    expect(proposeComponent(data)).toBe("status");
    expect(proposeComponent({ kind: "status", items: [{ label: "a", state: "up" }] })).toBe("stat");
  });

  it("evaluates bracket paths", () => {
    expect(evaluate({ "a b": [1, 2] }, '$["a b"][1]')).toEqual([2]);
    expect(childPath("$", "a b")).toBe('$["a b"]');
  });
});

describe("response tree", () => {
  it("cuts strings over 2 KB short", () => {
    const long = "é".repeat(3000);
    const t = buildTree({ long, short: "hi" }) as Extract<TreeNode, { type: "object" }>;
    const l = t.children[0] as Extract<TreeNode, { type: "string" }>;
    expect(l.truncated).toBe(true);
    expect(new TextEncoder().encode(l.value).length).toBeLessThanOrEqual(TRUNCATE_BYTES + 3);
    expect(t.children[1]).toMatchObject({ type: "string", value: "hi", path: "$.short" });
  });

  it("gives every node a clickable path", () => {
    const t = buildTree(sample) as Extract<TreeNode, { type: "object" }>;
    const disks = t.children.find((c) => c.key === "disks") as Extract<TreeNode, { type: "array" }>;
    expect((disks.children[1] as Extract<TreeNode, { type: "object" }>).children[1]).toMatchObject({ path: "$.disks[1].used", type: "number", value: 12 });
  });
});
