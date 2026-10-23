// Data picker rules (Wave 2.5 data picking spec, V1): every template a click writes is run through the real
// binding evaluator, and its words round-trip through describeTemplate.
import { describe, expect, it } from "vitest";
import type { BindingScope, ComponentNode } from "@/core/contracts";
import { blankDocument } from "@/features/apps/doc";
import { applyOpsToDoc } from "@/features/apps/ops";
import { evaluateBinding } from "@/features/components/bindings";
import { describeTemplate, missingParams, paramDefaults, paramFields, renameInTemplate, renameOps, sourceNameFor, templateFor, usersOf, wholeFit, wordsFor, type Pick } from "../data-pick";

const lights = { kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, { key: "value", label: "Value", type: "number" }, { key: "state", label: "State", type: "status" }], rows: [{ name: "alpha", value: 12, state: "up" }, { name: "bravo", value: 48, state: "up" }, { name: "charlie", value: 87, state: "warn" }] };
const cpu = { kind: "series", unit: "%", series: [{ name: "node-1", points: [[1, 10], [2, 30]] }, { name: "node-2", points: [[1, 5], [2, 7]] }] };
const svc = { kind: "status", items: [{ label: "web", state: "up", detail: "200 OK" }, { label: "db", state: "down", detail: "timeout" }] };
const temp = { kind: "stat", value: 21.5, unit: "°C", label: "Living room" };
const scope = { $data: { lights, cpu, svc, temp }, $page: { id: "p", slug: "s", title: "T" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: "user" } } as unknown as BindingScope;

describe("source names", () => {
  it("are made from the endpoint label, valid and unique", () => {
    expect(sourceNameFor("Lights and their states", [])).toBe("lights_and_their");
    expect(sourceNameFor("Lights", ["lights"])).toBe("lights_2");
    expect(sourceNameFor("Lights", ["lights", "lights_2"])).toBe("lights_3");
    expect(sourceNameFor("2024 stats", [])).toMatch(/^data_2024/);
    expect(sourceNameFor("", [])).toBe("data");
  });
});

describe("parameter fields from an endpoint's schema", () => {
  const schema = { type: "object", required: ["domain"], properties: { domain: { type: "string", enum: ["light", "switch"], default: "light", description: "Which entities" }, limit: { type: "integer", default: 20 }, onlyOn: { type: "boolean" }, q: { type: "string", title: "Search" } } };
  it("turn enum into a choice with its default, numbers, switches and text", () => {
    const f = paramFields(schema);
    expect(f.map((x) => [x.key, x.kind, x.required])).toEqual([["domain", "choice", true], ["limit", "number", false], ["onlyOn", "switch", false], ["q", "text", false]]);
    expect(f[0]!.options).toEqual(["light", "switch"]);
    expect(f[0]!.help).toBe("Which entities");
    expect(f[3]!.label).toBe("Search");
    expect(paramDefaults(f)).toEqual({ domain: "light", limit: 20 });
  });
  it("name the required fields left empty", () => {
    const f = paramFields(schema);
    expect(missingParams(f, {})).toEqual(["Domain"]);
    expect(missingParams(f, { domain: "light" })).toEqual([]);
  });
  it("is empty without a schema", () => expect(paramFields(undefined)).toEqual([]));
  it("shows a schema's examples as the hint when there is no description", () => {
    expect(paramFields({ type: "object", properties: { domain: { type: "string", examples: ["light", "switch"] } } })[0]!.help).toBe("For example: light, switch");
  });
});

describe("click to template: each one evaluates to what was clicked, and its words round-trip", () => {
  const cases: [string, Pick, unknown][] = [
    ["lights", { kind: "cell", col: "value", colLabel: "Value", keyCol: "name", keyLabel: "Name", keyValue: "bravo", index: 1, unique: true }, 48],
    ["lights", { kind: "cell", col: "value", colLabel: "Value", keyCol: "name", keyLabel: "Name", keyValue: "bravo", index: 2, unique: false }, 87],
    ["lights", { kind: "column", col: "value", colLabel: "Value", agg: "count" }, 3],
    ["lights", { kind: "column", col: "value", colLabel: "Value", agg: "sum" }, 147],
    ["lights", { kind: "column", col: "value", colLabel: "Value", agg: "avg" }, 49],
    ["lights", { kind: "column", col: "value", colLabel: "Value", agg: "min" }, 12],
    ["lights", { kind: "column", col: "value", colLabel: "Value", agg: "max" }, 87],
    ["lights", { kind: "column", col: "name", colLabel: "Name", agg: "list" }, "alpha, bravo, charlie"],
    ["cpu", { kind: "series", name: "node-1" }, 30],
    ["svc", { kind: "status", label: "db", field: "state" }, "down"],
    ["svc", { kind: "status", label: "web", field: "detail" }, "200 OK"],
    ["temp", { kind: "stat", field: "value" }, 21.5],
    ["temp", { kind: "stat", field: "unit" }, "°C"],
  ];
  for (const [src, pick, want] of cases) {
    it(`${src}: ${wordsFor(src, pick)}`, () => {
      const t = templateFor(src, pick);
      expect(evaluateBinding(t, scope)).toEqual(want);
      expect(describeTemplate(t)).not.toBeNull();
    });
  }
  it("quotes values safely", () => {
    const t = templateFor("lights", { kind: "cell", col: "value", colLabel: "Value", keyCol: "name", keyLabel: "Name", keyValue: 'say "hi"', index: 0, unique: true });
    expect(t).toBe('{{ lights.find("name", "say \\"hi\\"").value }}');
    expect(describeTemplate(t)).toBe('value of the row where name is say "hi"');
  });
  it("a hand-edited template that the picker cannot describe is custom", () => {
    expect(describeTemplate("{{ lights.rows | count }} lamps on")).toBeNull();
    expect(describeTemplate("{{ temp.value | round }}")).toBeNull();
    expect(describeTemplate("{{ lights.rows | count }}")).toBe("Number of rows in lights");
  });
});

describe("what fits a component", () => {
  it("binds a whole source when the kinds match", () => {
    expect(wholeFit("table", "lights", "table")).toEqual({ ok: true, prop: "data", template: "{{ lights }}" });
    expect(wholeFit("list", "lights", "table")).toEqual({ ok: true, prop: "items", template: "{{ lights.rows }}" });
    expect(wholeFit("chart", "cpu", "series")).toMatchObject({ ok: true });
  });
  it("a stat with a table source says why and offers count, sum and average", () => {
    const f = wholeFit("stat", "lights", "table", [{ key: "value", label: "Value" }]);
    expect(f.ok).toBe(false);
    if (f.ok) return;
    expect(f.why).toBe("A stat shows one number, and lights is a list of rows.");
    expect(f.offers.map((o) => o.label)).toEqual(["Number of rows", "Sum of Value", "Average of Value"]);
    expect(f.offers.map((o) => evaluateBinding(o.template, scope))).toEqual([3, 147, 49]);
    expect(f.fits).toContain("Table");
  });
});

describe("renames and users", () => {
  function app() {
    const d = blankDocument("T");
    d.dataSources = [{ name: "lights", integrationId: "i1", endpointId: "states", refreshSec: 30 }];
    const a: ComponentNode = { id: "c_aaaaaaaaaa", type: "text", props: { text: { $bind: "{{ lights.rows | count }} lamps" } } };
    const b: ComponentNode = { id: "c_bbbbbbbbbb", type: "text", props: { text: "lights are nice" } };
    const c: ComponentNode = { id: "c_cccccccccc", type: "table", props: { data: { $bind: "{{ lights }}" } }, visibleWhen: { $bind: "{{ lights.rows | count }}" } };
    d.pages[0]!.root.children = [a, b, c];
    return d;
  }
  it("renames only source roots, never paths or text in quotes", () => {
    expect(renameInTemplate('{{ lights.find("name", "lights").lights }} and lights', "lights", "lamps")).toBe('{{ lamps.find("name", "lights").lights }} and lights');
    expect(renameInTemplate("{{ a.b | map(\"x\") }}{{ lights }}", "lights", "lamps")).toBe('{{ a.b | map("x") }}{{ lamps }}');
  });
  it("lists who uses a source", () => {
    expect(usersOf(app(), "lights").map((u) => u.nodeId)).toEqual(["c_aaaaaaaaaa", "c_cccccccccc"]);
  });
  it("a rename batch applies and leaves no binding on the old name", () => {
    const d = app();
    const r = applyOpsToDoc(d, renameOps(d, "lights", "lamps"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.dataSources.map((s) => s.name)).toEqual(["lamps"]);
    expect(usersOf(r.doc, "lights")).toEqual([]);
    expect(usersOf(r.doc, "lamps").map((u) => u.nodeId)).toEqual(["c_aaaaaaaaaa", "c_cccccccccc"]);
    expect(JSON.stringify(r.doc.pages[0]!.root.children![1])).toContain("lights are nice");
  });
});
