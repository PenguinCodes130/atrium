import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppDocument, ComponentNode, ShapedData } from "@/core/contracts";
import { META, EXAMPLE_CONTROL, EXAMPLE_SOURCES } from "./catalogue/meta";
import { propsSchemas, BUILT_IN_TYPES } from "./catalogue/schemas";
import { validateNodes, validateSubtree } from "./validate";
import { suggestComponent, suggestedType } from "./suggest";
import { insertCatalogue } from "./insert";
import { sourcesUsed, resolveGuestValues } from "./page";

const ARCH_TYPES = ["grid", "stack", "card", "tabs", "section", "repeat", "stat", "chart", "table", "list", "status", "gauge", "progress", "heading", "text", "image", "video", "icon", "link", "divider", "spacer", "clock", "button", "toggle", "slider", "select", "html"];

const exampleDoc = (): Pick<AppDocument, "dataSources" | "controls"> => ({
  dataSources: Object.keys(EXAMPLE_SOURCES).map((name) => ({ name, integrationId: "i1", endpointId: "e1", refreshSec: 30 })),
  controls: [{ id: EXAMPLE_CONTROL, label: "Desk lamp", run: { kind: "command", integrationId: "i1", commandId: "light.toggle" } }],
});

function doc(root: ComponentNode, extra: Partial<AppDocument> = {}): AppDocument {
  return {
    format: "atrium-app", formatVersion: 1, app: { name: "Test", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" },
    ...exampleDoc(), pages: [{ id: "p_aaaaaaaaaa", slug: "home", title: "Home", inNav: true, root }], ...extra,
  };
}

describe("catalogue (criteria 1 and 2)", () => {
  it("has one definition for every architecture 4.4 type", () => {
    expect([...BUILT_IN_TYPES].sort()).toEqual([...ARCH_TYPES].sort());
  });
  for (const type of ARCH_TYPES) {
    it(`${type}: every 3.1 field is filled and every prop is described`, () => {
      const m = META[type as keyof typeof META];
      expect(m.title).toBeTruthy();
      expect(["layout", "data", "content", "control", "code"]).toContain(m.category);
      expect(typeof m.container).toBe("boolean");
      expect(m.defaults).toBeTypeOf("object");
      expect(m.styleSlots.length).toBeGreaterThan(0);
      expect(m.docs.summary.length).toBeGreaterThan(10);
      expect(m.docs.whenToUse.length).toBeGreaterThan(10);
      expect(m.docs.examples.length).toBeGreaterThanOrEqual(1);
      if (m.category === "data") expect(m.accepts?.length).toBeGreaterThan(0);
      const shape = (propsSchemas[type as keyof typeof propsSchemas] as unknown as { shape: Record<string, z.ZodType> }).shape;
      expect(Object.keys(shape).length).toBeGreaterThan(0);
      for (const [k, s] of Object.entries(shape)) expect(s.description, `${type}.${k}`).toBeTruthy();
      const json = z.toJSONSchema(propsSchemas[type as keyof typeof propsSchemas]) as { properties: Record<string, { description?: string }> };
      for (const [k, p] of Object.entries(json.properties)) expect(p.description, `${type}.${k} in JSON Schema`).toBeTruthy();
      expect(propsSchemas[type as keyof typeof propsSchemas].safeParse(m.defaults).success).toBe(true);
    });
    it(`${type}: its examples pass validate`, () => {
      for (const ex of META[type as keyof typeof META].docs.examples) {
        const problems = validateSubtree(ex, exampleDoc()).filter((p) => p.severity === "error");
        expect(problems, JSON.stringify(problems)).toEqual([]);
      }
    });
  }
});

describe("suggestion (criteria 39 and 40)", () => {
  const table = (cols: number): ShapedData => ({ kind: "table", columns: Array.from({ length: cols }, (_, i) => ({ key: `c${i}`, label: `C${i}`, type: "text" as const })), rows: [] });
  it("follows the shape rules", () => {
    expect(suggestedType("stat")).toBe("stat");
    expect(suggestedType("series")).toBe("chart");
    expect(suggestedType("table", table(3))).toBe("table");
    expect(suggestedType("table", table(2))).toBe("list");
    expect(suggestedType("status", { kind: "status", items: [{ label: "a", state: "up" }, { label: "b", state: "down" }] })).toBe("status");
    expect(suggestedType("status", { kind: "status", items: [{ label: "a", state: "up" }] })).toBe("stat");
  });
  it("binds the suggested props to the source and passes validate", () => {
    const cases: [ShapedData, string][] = [
      [EXAMPLE_SOURCES.cpu as ShapedData, "cpu"],
      [EXAMPLE_SOURCES.load as unknown as ShapedData, "load"],
      [EXAMPLE_SOURCES.hosts as unknown as ShapedData, "hosts"],
      [table(2), "hosts"],
      [EXAMPLE_SOURCES.services as unknown as ShapedData, "services"],
      [{ kind: "status", items: [{ label: "x", state: "up" }] }, "services"],
    ];
    for (const [data, source] of cases) {
      const n = suggestComponent(data.kind, source, data);
      expect(JSON.stringify(n.props)).toContain(`{{ ${source}`);
      expect(validateSubtree(n, exampleDoc()).filter((p) => p.severity === "error")).toEqual([]);
    }
  });
});

describe("validate (criterion 14 and friends)", () => {
  it("reports a failing binding with its node id", () => {
    const root: ComponentNode = { id: "c_rootaaaaaa", type: "stack", props: {}, children: [{ id: "c_badbinding", type: "stat", props: { value: { $bind: "{{ nope.value }}" } } }] };
    const p = validateNodes(doc(root));
    expect(p.find((x) => x.code === "binding.unknown_source")?.where.nodeId).toBe("c_badbinding");
  });
  it("names the invalid field", () => {
    const root: ComponentNode = { id: "c_rootaaaaaa", type: "stack", props: {}, children: [{ id: "c_badpropsaa", type: "chart", props: { kind: "pie" } }] };
    const p = validateNodes(doc(root));
    expect(p.find((x) => x.code === "props.invalid")?.where.field).toBe("kind");
  });
  it("checks controls, links, html names and repeat children", () => {
    const root: ComponentNode = {
      id: "c_rootaaaaaa", type: "stack", props: {}, children: [
        { id: "c_buttonaaaa", type: "button", props: { label: "x", control: "k_unknownxxx" } },
        { id: "c_linkaaaaaa", type: "link", props: { label: "x", href: "javascript:alert(1)" } },
        { id: "c_htmlaaaaaa", type: "html", props: { html: "", controls: ["k_unknownxxx"], data: {}, height: "auto" } },
        { id: "c_repeataaaa", type: "repeat", props: { items: { $bind: "{{ hosts.rows }}" } }, children: [{ id: "c_childaaaaa", type: "text", props: { text: { $bind: "{{ $item.name }}" } } }, { id: "c_childbbbbb", type: "text", props: {} }] },
        { id: "c_itemoutsde", type: "text", props: { text: { $bind: "{{ $item.name }}" } } },
      ],
    };
    const codes = validateNodes(doc(root)).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["control.unknown", "link.scheme", "html.unknown_control", "html.unnamed", "repeat.children", "binding.repeat_only"]));
  });
  it("checks paths against current data when given", () => {
    const root: ComponentNode = { id: "c_rootaaaaaa", type: "stack", props: {}, children: [{ id: "c_pathaaaaaa", type: "stat", props: { value: { $bind: "{{ cpu.valu }}" } } }] };
    const p = validateNodes(doc(root), { data: { cpu: EXAMPLE_SOURCES.cpu as ShapedData } });
    expect(p.some((x) => x.code === "binding.unknown_path" && x.where.nodeId === "c_pathaaaaaa")).toBe(true);
  });
});

describe("insert catalogue (criterion 32)", () => {
  it("lists every type by category with the code category folded and the HTML block inside it", () => {
    const groups = insertCatalogue({ kind: "user", userId: "u", role: "member", via: "session" });
    const code = groups.find((g) => g.category === "code")!;
    expect(code.folded).toBe(true);
    expect(code.items.map((i) => i.type)).toEqual(["html"]);
    expect(groups.filter((g) => g.category !== "code").every((g) => !g.folded)).toBe(true);
    // One item per type, plus the Card for each starter (a second repeat, Wave 2.7).
    const items = groups.flatMap((g) => g.items);
    expect(items.filter((i) => !i.insertId).length).toBe(ARCH_TYPES.length);
    expect(items.filter((i) => i.insertId).map((i) => [i.insertId, i.type])).toEqual([["card-for-each", "repeat"]]);
  });
  it("gives viewers and guests nothing", () => {
    expect(insertCatalogue({ kind: "user", userId: "u", role: "viewer", via: "session" })).toEqual([]);
    expect(insertCatalogue({ kind: "guest", guestLinkId: "g", appId: "a", label: "x", via: "guest-link" })).toEqual([]);
  });
});

describe("page sources and guest values (criteria 24, 25, 57)", () => {
  const root: ComponentNode = {
    id: "c_rootaaaaaa", type: "grid", props: {}, children: [
      { id: "c_lamptoggle", type: "toggle", props: { label: "Desk lamp", control: EXAMPLE_CONTROL, state: { $bind: '{{ lamps.find("entity", "light.desk").state == "on" }}' } } },
      { id: "c_cpustataaa", type: "stat", props: { value: { $bind: "{{ cpu.value | round(1) }}" }, label: "CPU" }, visibleWhen: { $bind: "{{ cpu.value > 1 }}" } },
      { id: "c_htmlblocka", type: "html", name: "Readout", props: { html: "<p></p>", data: { cpu: { $bind: "{{ cpu.value }}" } }, controls: [], height: "auto" } },
      { id: "c_repeatbbbb", type: "repeat", props: { items: { $bind: "{{ hosts.rows }}" } }, children: [{ id: "c_repeatchld", type: "text", props: { text: { $bind: "{{ $index }}: {{ $item.name }}" } } }] },
    ],
  };
  const d = doc(root, { dataSources: [...exampleDoc().dataSources, { name: "unused", integrationId: "i9", endpointId: "e9", refreshSec: 30 }] });
  it("lists only the sources the page binds", () => {
    expect(sourcesUsed(d, "p_aaaaaaaaaa").map((s) => s.name).sort()).toEqual(["cpu", "hosts", "lamps"]);
  });
  it("resolves guest values keyed by node and prop, never whole sources", () => {
    const v = resolveGuestValues(d, "p_aaaaaaaaaa", EXAMPLE_SOURCES as unknown as Record<string, ShapedData>);
    expect(v["c_lamptoggle:state"]).toBe(true);
    expect(v["c_cpustataaa:value"]).toBe(41.3);
    expect(v["c_cpustataaa:$visible"]).toBe(true);
    expect(v["c_htmlblocka:data"]).toEqual({ cpu: 41.27 });
    expect(v["c_repeatbbbb:$count"]).toBe(2);
    expect(v["c_repeatchld#0:text"]).toBe("0: web");
    expect(v["c_repeatchld#1:text"]).toBe("1: db");
    const json = JSON.stringify(v);
    expect(json).not.toContain("light.desk");
    expect(json).not.toContain("brightness");
    expect(Object.keys(v).every((k) => /^c_[a-z2-7]{10}(#[\d.]+)?:/.test(k))).toBe(true);
  });
});
