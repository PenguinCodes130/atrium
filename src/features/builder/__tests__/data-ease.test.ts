// Wave 2.7 data ease (data-ease-spec.md, V1): friendly names, reuse instead of copies, cleanup of unused
// sources, all-or-this-one copies, "this row", a card for each, several values, value formats, the Shows
// line, title bars and the publish review's warnings. Ops go through the real applyOpsToDoc.
import { describe, expect, it } from "vitest";
import type { AppDocument, BindingScope, ComponentNode, DataSourceDef, ShapedData } from "@/core/contracts";
import { blankDocument } from "@/features/apps/doc";
import { applyOpsToDoc } from "@/features/apps/ops";
import { reviewWarnings, unusedSourceName } from "@/features/apps/review-warnings";
import { evaluateBinding } from "@/features/components/bindings";
import { durationText, formatParts, formatValue, templateFormat } from "@/features/components/render/format";
import { titleText } from "@/features/components/render/titlebar";
import { seriesLabel } from "@/features/components/render/chart";
import { readLabel } from "@/features/components/render/data";
import {
  cardForEachOps, choiceLabel, choiceParams, copyForOne, EVERY, everyWords, findReusable, keyColumn, mainColumns, manyValueOffers, otherUsers, paramFields, propsToShow, renameOps,
  repeatAround, rowFields, sameRead, showChoices, showsLine, sourceLabelFor, sourceNameFromLabel, switchTypeOp, unusedAdded,
} from "../data-pick";

const overview: ShapedData = {
  kind: "table",
  columns: [
    { key: "name", label: "Name", type: "text" }, { key: "instance", label: "Address", type: "text" }, { key: "up", label: "Up", type: "status" },
    { key: "cpu", label: "CPU", type: "number", format: "percent" }, { key: "memory", label: "Memory", type: "number", format: "percent" }, { key: "disk", label: "Disk (/)", type: "number", format: "percent" },
    { key: "netIn", label: "Network in", type: "number", format: "bytesPerSec" }, { key: "netOut", label: "Network out", type: "number", format: "bytesPerSec" }, { key: "load", label: "Load", type: "number", format: "number" },
    { key: "uptime", label: "Uptime", type: "number", format: "seconds" }, { key: "temperature", label: "Temperature", type: "number", format: "celsius" },
  ],
  rows: [
    { name: "ACE", instance: "10.77.99.8:9100", up: "up", cpu: 7.8, memory: 41.2, disk: 52.3, netIn: 3_100_000, netOut: 420_000, load: 0.41, uptime: 3 * 86400 + 4 * 3600 },
    { name: "RP5-3", instance: "host.docker.internal:9100", up: "up", cpu: 15.1, memory: 58.1, disk: 66.6, netIn: 1_800_000, netOut: 1_100_000, load: 0.7, uptime: 12 * 86400 },
  ],
};

function docWith(nodes: ComponentNode[], sources: DataSourceDef[] = []): AppDocument {
  const d = blankDocument("T");
  d.pages[0]!.root.children = nodes;
  d.dataSources = sources;
  return d;
}
const apply = (d: AppDocument, ops: Parameters<typeof applyOpsToDoc>[1]) => {
  const r = applyOpsToDoc(d, ops);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.doc;
};
let seq = 0;
const makeId = () => { let n = seq++; let t = ""; for (let i = 0; i < 10; i++) { t = String.fromCharCode(97 + (n % 26)) + t; n = Math.floor(n / 26); } return `c_${t.replace(/[^a-z]/g, "a")}`; };
const src = (name: string, extra: Partial<DataSourceDef> = {}): DataSourceDef => ({ name, integrationId: "i1", endpointId: "machine-cpu", refreshSec: 30, ...extra });

describe("friendly names (A8.6)", () => {
  it("say what was picked in words and derive a unique template name", () => {
    expect(sourceLabelFor("CPU in use", ["ACE"])).toBe("CPU in use, ACE");
    expect(sourceLabelFor("Machines overview")).toBe("Machines overview");
    expect(sourceLabelFor("CPU in use", [everyWords("Machine")])).toBe("CPU in use, every machine");
    expect(sourceNameFromLabel("CPU in use, ACE", [])).toBe("cpu_in_use_ace");
    expect(sourceNameFromLabel("CPU in use, ACE", ["cpu_in_use_ace"])).toBe("cpu_in_use_ace_2");
    expect(sourceNameFromLabel("Machines overview", [])).toBe("machines_overview");
  });
  it("a source keeps its label through source.set, and a bad label is refused", () => {
    const d = apply(docWith([]), [{ op: "source.set", source: src("cpu_ace", { label: "CPU in use, ACE" }) }]);
    expect(d.dataSources[0]!.label).toBe("CPU in use, ACE");
    expect(applyOpsToDoc(d, [{ op: "source.set", source: { ...src("x"), label: "y".repeat(81) } }]).ok).toBe(false);
  });
});

describe("live choices and labels (A8.2, A8.3)", () => {
  const schema = { type: "object", required: ["machine"], properties: { machine: { type: "string", title: "Machine", "x-atrium-choices": { endpointId: "machines", value: "instance", label: "name", detail: "detail", every: true } }, measure: { type: "string", enum: ["cpu", "memory"], "x-atrium-labels": { cpu: "CPU in use", memory: "Memory in use" } } } };
  it("a choices parameter becomes a 'which thing' field; enum labels are words", () => {
    expect(choiceParams(schema)).toEqual([{ key: "machine", title: "Machine", required: true, spec: { endpointId: "machines", value: "instance", label: "name", detail: "detail", every: true } }]);
    const f = paramFields(schema);
    expect(f[0]!.kind).toBe("thing");
    expect(f[1]!.optionLabels).toEqual({ cpu: "CPU in use", memory: "Memory in use" });
    expect(choiceLabel(schema.properties.measure, "memory")).toBe("Memory in use");
    expect(choiceLabel({ enum: ["a", "b"], "x-atrium-labels": ["Alpha", "Bravo"] }, "b")).toBe("Bravo");
    expect(EVERY).toBe("*");
  });
});

describe("reuse (criterion 6)", () => {
  it("the same read with the same settings is reused; other settings are not", () => {
    const d = docWith([], [src("cpu_ace", { params: { machine: "10.77.99.8:9100" } })]);
    expect(findReusable(d, { integrationId: "i1", endpointId: "machine-cpu", params: { machine: "10.77.99.8:9100" } })?.name).toBe("cpu_ace");
    expect(findReusable(d, { integrationId: "i1", endpointId: "machine-cpu", params: { machine: "10.77.99.6:9100" } })).toBeNull();
    expect(sameRead({ integrationId: "i", endpointId: "e", params: { a: "1", b: "" } }, { integrationId: "i", endpointId: "e", params: { a: "1" } })).toBe(true);
  });
});

describe("leave nothing behind (criterion 10)", () => {
  it("lists sources added since the picker opened that nothing uses", () => {
    const d = docWith([{ id: "c_statstataa", type: "stat", props: { data: { $bind: "{{ used }}" } } }], [src("old"), src("used"), src("orphan")]);
    expect(unusedAdded(d, ["old"])).toEqual(["orphan"]);
    expect(unusedAdded(d, ["old"], undefined, "orphan")).toEqual([]);
  });
});

describe("shared data: all or this one (criterion 8)", () => {
  it("a copy for this one moves only this widget's bindings; the other keeps the original", () => {
    const d0 = docWith([
      { id: "c_statoneaaa", type: "stat", props: { data: { $bind: "{{ cpu }}" } }, slot: { x: 0, y: 0, w: 3, h: 16 } },
      { id: "c_stattwoaaa", type: "stat", props: { data: { $bind: "{{ cpu }}" } }, slot: { x: 3, y: 0, w: 3, h: 16 } },
    ], [src("cpu", { label: "CPU in use, ACE" })]);
    expect(otherUsers(d0, "cpu", "c_stattwoaaa").map((u) => u.nodeId)).toEqual(["c_statoneaaa"]);
    const c = copyForOne(d0, "c_stattwoaaa", "cpu")!;
    const d = apply(d0, c.ops);
    expect(c.name).toBe("cpu_2");
    expect(d.dataSources.map((s) => [s.name, s.label])).toEqual([["cpu", "CPU in use, ACE"], ["cpu_2", "CPU in use, ACE (copy)"]]);
    const kids = d.pages[0]!.root.children!;
    expect(kids[0]!.props.data).toEqual({ $bind: "{{ cpu }}" });
    expect(kids[1]!.props.data).toEqual({ $bind: "{{ cpu_2 }}" });
  });
});

describe("rename and bind land together (criterion 7)", () => {
  it("rename ops plus a bind with the new name apply as one batch with no unknown source", () => {
    const d0 = docWith([{ id: "c_statoneaaa", type: "stat", props: {} }], [src("range_query_2")]);
    const ops = renameOps(d0, "range_query_2", "cpu");
    const bind = { op: "node.update" as const, nodeId: "c_statoneaaa", patch: { props: { data: { $bind: "{{ cpu }}" } } } };
    const d = apply(d0, [...ops.slice(0, -1), bind, ops.at(-1)!]);
    expect(d.dataSources.map((s) => s.name)).toEqual(["cpu"]);
    expect(d.pages[0]!.root.children![0]!.props.data).toEqual({ $bind: "{{ cpu }}" });
  });
});

describe("this row (criterion 11)", () => {
  it("finds the Repeat around a widget and lists the row's fields with values", () => {
    const d = docWith([{ id: "c_repeataaaa", type: "repeat", props: { items: { $bind: "{{ machines.rows }}" } }, slot: { x: 0, y: 0, w: 12, h: 40 }, children: [{ id: "c_cardaaaaaa", type: "card", props: {}, children: [{ id: "c_statinaaaa", type: "stat", props: {} }] }] }], [src("machines", { endpointId: "machines-overview" })]);
    expect(repeatAround(d, "c_statinaaaa")).toEqual({ repeatId: "c_repeataaaa", source: "machines" });
    expect(repeatAround(d, "c_repeataaaa")).toBeNull();
    const f = rowFields(overview);
    expect(f.find((x) => x.key === "cpu")).toEqual({ key: "cpu", label: "CPU", value: 7.8, format: "percent" });
  });
});

describe("a card for each (criterion 2)", () => {
  it("picks the name column and the main columns", () => {
    expect(keyColumn(overview)).toEqual({ key: "name", label: "Name" });
    expect(mainColumns(overview)).toEqual(["cpu", "memory", "disk", "netIn", "netOut", "uptime"]);
  });
  it("builds a Repeat over the rows with one card: a title bound to the name and a stat per column", () => {
    const d0 = docWith([{ id: "c_repeataaaa", type: "repeat", props: { columns: 1, max: 50, empty: "Nothing to show" }, slot: { x: 0, y: 0, w: 6, h: 16 }, children: [] }], [src("machines", { endpointId: "machines-overview" })]);
    const repeat = d0.pages[0]!.root.children![0]!;
    const d = apply(d0, cardForEachOps(repeat, "machines", overview, mainColumns(overview), { makeId }));
    const r = d.pages[0]!.root.children![0]!;
    expect(r.props.items).toEqual({ $bind: "{{ machines.rows }}" });
    expect(r.props.columns).toBe(3);
    expect(r.slot!.w).toBe(12);
    const card = r.children![0]!;
    expect(card.type).toBe("card");
    expect(card.props.title).toEqual({ $bind: "{{ $item.name }}" });
    const stats = card.children![0]!.children!;
    expect(stats.map((s) => [s.props.label, s.props.value])).toEqual([["CPU", { $bind: "{{ $item.cpu }}" }], ["Memory", { $bind: "{{ $item.memory }}" }], ["Disk (/)", { $bind: "{{ $item.disk }}" }], ["Network in", { $bind: "{{ $item.netIn }}" }], ["Network out", { $bind: "{{ $item.netOut }}" }], ["Uptime", { $bind: "{{ $item.uptime }}" }]]);
    // Building again replaces the card, never adds a second child.
    const again = apply(d, cardForEachOps(r, "machines", overview, ["cpu"], { makeId }));
    expect(again.pages[0]!.root.children![0]!.children).toHaveLength(1);
  });
});

describe("how to show it, and several values (criterion 9)", () => {
  it("offers the widget kinds that fit, and switching a kind rebuilds valid props", () => {
    expect(showChoices("stat").map((s) => s.type)).toEqual(["stat", "gauge", "progress"]);
    expect(showChoices("table").map((s) => s.type)).toEqual(["table", "cards"]);
    expect(propsToShow("gauge", "cpu").value).toEqual({ $bind: "{{ cpu.value }}" });
    const d0 = docWith([{ id: "c_statoneaaa", type: "stat", props: { data: { $bind: "{{ cpu }}" }, decimals: 1 }, slot: { x: 0, y: 0, w: 3, h: 16 } }], [src("cpu")]);
    const d = apply(d0, [switchTypeOp(d0.pages[0]!.root.children![0]!, "gauge", "cpu")]);
    const g = d.pages[0]!.root.children![0]!;
    expect(g.type).toBe("gauge");
    expect(g.props.data).toBeUndefined();
    expect(g.props.value).toEqual({ $bind: "{{ cpu.value }}" });
  });
  it("a table where one number is wanted offers Sum, Average, Highest and Lowest, each through the real evaluator", () => {
    const m = manyValueOffers("machines", overview);
    expect(m.count).toBe(2);
    expect(m.column).toEqual({ key: "cpu", label: "CPU" });
    const scope = { $data: { machines: overview }, $page: { id: "p", slug: "s", title: "T" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: "user" } } as unknown as BindingScope;
    const got = Object.fromEntries(m.offers.map((o) => [o.agg, evaluateBinding(o.template, scope)]));
    expect(got.max).toBe(15.1);
    expect(got.min).toBe(7.8);
    expect(got.sum as number).toBeCloseTo(22.9, 6);
    expect(got.avg as number).toBeCloseTo(11.45, 6);
  });
});

describe("value formats (A8.4, criterion 13)", () => {
  it("percent, bytes, bytes per second, seconds and degrees", () => {
    expect(formatValue(7.84, "percent")).toBe("7.8 %");
    expect(formatValue(12.4 * 1024 ** 3, "bytes")).toBe("12.4 GB");
    expect(formatValue(3.1 * 1024 ** 2, "bytesPerSec")).toBe("3.1 MB/s");
    expect(formatValue(3 * 86400 + 4 * 3600, "seconds")).toBe("3 d 4 h");
    expect(durationText(4 * 3600 + 12 * 60)).toBe("4 h 12 min");
    expect(durationText(42)).toBe("42 s");
    expect(formatValue(61.24, "celsius")).toBe("61.2 °C");
    expect(formatParts(512, "bytes")).toEqual({ text: "512", unit: "B" });
  });
  it("a binding's format comes from its data: a stat, a table column, this row", () => {
    const stat: ShapedData = { kind: "stat", value: 7.8, label: "CPU in use", format: "percent" };
    const scope = { $data: { cpu: stat, machines: overview }, $itemFormats: { netIn: "bytesPerSec" } };
    expect(templateFormat("{{ cpu.value }}", scope)).toBe("percent");
    expect(templateFormat('{{ machines.find("name", "ACE").netIn }}', scope)).toBe("bytesPerSec");
    expect(templateFormat('{{ machines.rows | map("uptime") | max }}', scope)).toBe("seconds");
    expect(templateFormat("{{ machines.rows | count }}", scope)).toBeNull();
    expect(templateFormat("{{ $item.netIn }}", scope)).toBe("bytesPerSec");
    expect(templateFormat("{{ cpu.value }} and {{ cpu.value }}", scope)).toBeNull();
  });
});

describe("what viewers see (A8.5, criterion 18)", () => {
  it("a title bar shows the widget's own title, never the app slug or the source name", () => {
    expect(titleText({ id: "c_x", type: "stat", props: {} })).toBe("");
    expect(titleText({ id: "c_x", type: "stat", title: "CPU, ACE", props: {} })).toBe("CPU, ACE");
    expect(titleText({ id: "c_x", type: "stat", showTitle: true, props: {} }, "CPU in use")).toBe("CPU in use");
  });
  it("a stat with no label shows the read's name, never raw label text", () => {
    const node: ComponentNode = { id: "c_x", type: "stat", props: { data: { $bind: "{{ cpu }}" } } };
    const scope = { $sourceLabels: { cpu: "CPU in use, ACE" } } as never;
    expect(readLabel('{host="ACE"}', node, scope)).toBe("CPU in use, ACE");
    expect(readLabel("value", node, scope)).toBe("CPU in use, ACE");
    expect(readLabel("Living room", node, scope)).toBe("Living room");
  });
  it("chart lines use the friendly name", () => {
    expect(seriesLabel({ name: '{host="ACE"}', display: "ACE" })).toBe("ACE");
    expect(seriesLabel({ name: "node-1" })).toBe("node-1");
  });
});

describe("the inspector's Shows line", () => {
  it("names what, which, value and where from", () => {
    expect(showsLine(src("cpu", { label: "CPU in use, ACE" }), "{{ cpu }}", { integrationName: "Prometheus", value: "7.8 %" })).toEqual({ what: "CPU in use, ACE", detail: null, value: "7.8 %", from: "Prometheus, every 30 s" });
    expect(showsLine(src("machines"), '{{ machines.find("name", "ACE").cpu }}', { readLabel: "Machines overview" }).detail).toBe("cpu of the row where name is ACE");
  });
});

describe("publish review warnings (spec 3.6, criterion 19)", () => {
  const doc = docWith([
    { id: "c_statoneaaa", type: "stat", props: { data: { $bind: "{{ machines }}" } }, slot: { x: 0, y: 0, w: 3, h: 16 } },
    { id: "c_textoneaaa", type: "text", props: { text: { $bind: '{{ machines.find("name", "nope").cpu }}' } }, slot: { x: 3, y: 0, w: 3, h: 8 } },
    { id: "c_hiddenaaaa", type: "text", props: { text: "under" }, slot: { x: 6, y: 0, w: 2, h: 4 } },
    { id: "c_overaaaaaa", type: "text", props: { text: "over" }, slot: { x: 6, y: 0, w: 4, h: 8 } },
  ], [src("machines", { endpointId: "machines-overview", label: "Machines overview" }), src("spare", { label: "CPU in use, ACE" })]);
  const w = reviewWarnings(doc, (n) => (n === "machines" ? { data: overview, kind: "table" } : {}));
  it("lists an unused source with a name the Remove can read", () => {
    const u = w.find((p) => p.code === "source.unused")!;
    expect(u.message).toBe("CPU in use, ACE is not shown by any widget.");
    expect(unusedSourceName(u)).toBe("spare");
    expect(w.filter((p) => p.code === "source.unused")).toHaveLength(1);
  });
  it("flags the wrong kind, a field with no data and a widget hidden under another, each naming the component", () => {
    expect(w.find((p) => p.code === "data.wrong_kind")?.where.nodeId).toBe("c_statoneaaa");
    expect(w.find((p) => p.code === "data.no_value")?.where.nodeId).toBe("c_textoneaaa");
    expect(w.find((p) => p.code === "layout.covered")?.where.nodeId).toBe("c_hiddenaaaa");
  });
  it("a source with no cached data is not judged", () => {
    expect(reviewWarnings(doc, () => ({})).some((p) => p.code === "data.no_value" || p.code === "data.wrong_kind")).toBe(false);
  });
});
