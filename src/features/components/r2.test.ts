// Round 2 (gauntlet w2-r1 Fix List) unit checks: title bars, sample values, grid rows, empty grids,
// status words, chart fills, root colour cascade, binding holds, the inspector header and fold, the
// code action, safe library saves, touch targets and node containment in components.css.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppDocument, ComponentNode, LibraryComponent, RenderContext, ShapedData } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));

const { RenderNode } = await import("./render/render-node");
const { RenderDeviceProvider } = await import("./render/context");
const { InspectorPanels, InspectorHeader, nodeDisplayName, bindingHoldReason } = await import("./inspector/inspector");
const { stretchRows } = await import("./render/layout");
const { notConnected, sampleProps, sampleFor } = await import("./catalogue/samples");
const { compileStyle } = await import("./style/compile");
const { insertCatalogue } = await import("./insert");
const { titlePath } = await import("./render/titlebar");

type Src = Record<string, { state: "fresh" | "stale" | "failed" | "empty"; data?: ShapedData; refreshSec: number }>;
function ctx(mode: RenderContext["mode"], sources: Src = {}): RenderContext {
  const $data: Record<string, ShapedData | undefined> = {};
  for (const [k, v] of Object.entries(sources)) $data[k] = v.data;
  return {
    mode, principal: { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_aaaaaaaaaa", version: "draft",
    values: { $data, $sources: sources, $page: { id: "p_aaaaaaaaaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "homelab", name: "Homelab" }, $user: { kind: "user" } } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const render = (node: ComponentNode, c: RenderContext) => renderToStaticMarkup(h(RenderDeviceProvider, { device: "desktop", children: h(RenderNode, { node, ctx: c }) }));
const fresh = (data: ShapedData): Src[string] => ({ state: "fresh", data, refreshSec: 30 });
const doc = (sources: string[] = []): AppDocument => ({ format: "atrium-app", formatVersion: 1, app: { name: "A", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, dataSources: sources.map((name) => ({ name, integrationId: "i", endpointId: "e", refreshSec: 30 })), controls: [], pages: [{ id: "p_aaaaaaaaaa", slug: "home", title: "Home", inNav: true, root: { id: "c_rootaaaaaa", type: "grid", props: {}, children: [] } }] });

describe("Fix 4: title bars on every card, data surface and chart", () => {
  const cpu = fresh({ kind: "stat", value: 41.3, unit: "%", label: "CPU" });
  for (const node of [
    { id: "c_statcpuaaa", type: "stat", props: { data: { $bind: "{{ cpu }}" } } },
    { id: "c_cardaaaaaa", type: "card", name: "Servers", props: { title: "Servers" }, children: [] },
    { id: "c_chartaaaaa", type: "chart", props: { data: { $bind: "{{ load }}" } } },
    { id: "c_tableaaaaa", type: "table", props: { data: { $bind: "{{ hosts }}" } } },
    { id: "c_listaaaaaa", type: "list", props: { items: { $bind: "{{ hosts.rows }}" } } },
    { id: "c_gaugeaaaaa", type: "gauge", props: { value: { $bind: "{{ cpu.value }}" } } },
  ] as ComponentNode[]) {
    it(`${node.type} carries the 28px title bar (shown by CSS when titleBars is on)`, () => {
      const m = render(node, ctx("view", { cpu, load: fresh({ kind: "series", series: [{ name: "a", points: [[1, 1], [2, 2]] }] }), hosts: fresh({ kind: "table", columns: [{ key: "n", label: "N", type: "text" }], rows: [{ n: "x" }] }) }));
      expect(m).toContain("data-node-titlebar");
      expect(m).not.toContain("homelab / "); // A8.5: never the app slug
    });
  }
  it("the bar shows the widget's own title, never the app slug or the source name (A8.5); the status is live with a lit door", () => {
    const m = render({ id: "c_statcpuaaa", type: "stat", props: { data: { $bind: "{{ cpu }}" } } }, ctx("view", { cpu }));
    expect(m).not.toContain("homelab / cpu");
    expect(render({ id: "c_statcpuaaa", type: "stat", title: "CPU, ACE", props: { data: { $bind: "{{ cpu }}" } } }, ctx("view", { cpu }))).toContain("CPU, ACE");
    expect(m).toMatch(/data-door="lit"/);
    expect(m).toContain(">live<");
  });
  it("titlePath is the node's title only (A8.5)", () => {
    expect(titlePath({ id: "c_x", type: "stat", name: "CPU bar", props: {} }, ctx("view").values as never)).toBe("");
    expect(titlePath({ id: "c_x", type: "stat", title: "CPU bar", props: {} }, ctx("view").values as never)).toBe("CPU bar");
  });
  it("the stylesheet shows the bar only under titlebars on, 28px, mono, and moves the marks below it", () => {
    const css = readFileSync(path.join(__dirname, "components.css"), "utf8");
    expect(css).toMatch(/\.atr-titlebar \{ display: none; \}/);
    expect(css).toMatch(/\[data-canvas-titlebars="on"\] \.atr-titlebar \{[^}]*height: 28px/);
    expect(css).toMatch(/\[data-canvas-titlebars="on"\] \.atr-marks \{ top: 36px; \}/);
  });
});

describe("Fix 7: new data components show sample values in the builder", () => {
  it("a fresh stat, chart and table are not connected and get samples", () => {
    for (const type of ["stat", "chart", "table", "list", "status", "gauge", "progress"]) expect(notConnected({ id: "c_x", type: type as never, props: {} })).toBe(true);
    expect(notConnected({ id: "c_x", type: "stat", props: { data: { $bind: "{{ cpu }}" } } })).toBe(false);
    expect(sampleProps({ id: "c_x", type: "text", props: {} })).toBeNull();
  });
  it("edit mode shows sample values marked sample, with Choose a data source", () => {
    const m = render({ id: "c_newstataa", type: "stat", props: { label: "" } }, ctx("edit"));
    expect(m).toContain('data-sample=""');
    expect(m).toContain(">Sample data<");
    expect(m).toContain("Choose a data source");
    expect(m).toContain("42.5");
  });
  it("view mode shows the designed empty state, never sample values", () => {
    const m = render({ id: "c_newstataa", type: "stat", props: {} }, ctx("view"));
    expect(m).not.toContain("42.5");
    expect(m).toContain("No data yet");
    expect(m).toContain("Not connected to data yet.");
  });
  it("library cards pick the sample by the type that reads the parameter", () => {
    expect(sampleFor("chart").kind).toBe("series");
    expect(sampleFor("table").kind).toBe("table");
    expect(sampleFor("stat").kind).toBe("stat");
  });
});

describe("Fix 9 and 16: grid rows", () => {
  it("cards starting on the same row stretch to the tallest, unless something below in their columns starts first", () => {
    const r = stretchRows([
      { id: "a", slot: { x: 0, y: 0, w: 3, h: 15 } },
      { id: "b", slot: { x: 3, y: 0, w: 3, h: 19 } },
      { id: "c", slot: { x: 6, y: 0, w: 3, h: 10 } },
      { id: "d", slot: { x: 6, y: 12, w: 3, h: 6 } },
    ], 12);
    expect(r.a!.h).toBe(19);
    expect(r.b!.h).toBe(19);
    expect(r.c!.h).toBe(12); // stops where d starts
    expect(r.d!.h).toBe(6);
  });
  it("cells get the gap plus the hard shadow offset as bottom padding (CSS)", () => {
    const css = readFileSync(path.join(__dirname, "components.css"), "utf8");
    expect(css).toContain('[data-canvas-shadow="hard"] .atr-cell { padding-bottom: calc(var(--theme-gap, 16px) + var(--theme-shadow-offset, 0px)); }');
  });
  it("view mode stretches a row; edit mode draws the exact slots", () => {
    const grid: ComponentNode = { id: "c_gridaaaaaa", type: "grid", props: {}, children: [
      { id: "c_shortaaaaa", type: "text", props: { text: "s" }, slot: { x: 0, y: 0, w: 6, h: 4 } },
      { id: "c_tallaaaaaa", type: "text", props: { text: "t" }, slot: { x: 6, y: 0, w: 6, h: 9 } },
    ] };
    expect(render(grid, ctx("view"))).toMatch(/data-cell="c_shortaaaaa" style="grid-column:1 \/ span 6;grid-row:1 \/ span 9/);
    expect(render(grid, ctx("edit"))).toMatch(/data-cell="c_shortaaaaa" style="grid-column:1 \/ span 6;grid-row:1 \/ span 4/);
  });
  it("an empty grid has no height for viewers and keeps its drop area in the builder", () => {
    const empty: ComponentNode = { id: "c_emptygrid", type: "grid", props: {}, children: [] };
    expect(render(empty, ctx("view"))).toContain('data-empty=""');
    expect(render(empty, ctx("view"))).toContain("min-height:0");
    expect(render(empty, ctx("edit"))).not.toContain('data-empty=""');
  });
});

describe("Fix 10: status words never break inside a word", () => {
  it("a text value fits its tile: no word break, steps down by width, ellipsis with the full text as title", () => {
    const m = render({ id: "c_statword", type: "stat", props: { value: "UNKNOWN" } }, ctx("view"));
    expect(m).toContain('data-text-value=""');
    expect(m).toContain('title="UNKNOWN"');
    expect(m).toContain("--atr-chars:7");
    const css = readFileSync(path.join(__dirname, "components.css"), "utf8");
    expect(css).toMatch(/\.atr-stat-value\[data-text-value\] \{[^}]*word-break: keep-all; white-space: nowrap;[^}]*text-overflow: ellipsis/);
  });
});

describe("Fix 11: a multi-series chart draws lines, only the first area is filled", () => {
  const series = (n: number): ShapedData => ({ kind: "series", series: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, points: [[1, i], [2, i + 1], [3, i]] })) });
  it("three area series give one low-opacity fill", () => {
    const m = render({ id: "c_chartaaaaa", type: "chart", props: { data: { $bind: "{{ load }}" }, kind: "area" } }, ctx("view", { load: fresh(series(3)) }));
    expect(m.match(/data-area-fill/g)?.length).toBe(1);
    expect(m).toContain('opacity="0.12"');
  });
  it("one area series keeps its fill", () => {
    const m = render({ id: "c_chartaaaaa", type: "chart", props: { data: { $bind: "{{ load }}" }, kind: "area" } }, ctx("view", { load: fresh(series(1)) }));
    expect(m.match(/data-area-fill/g)?.length).toBe(1);
  });
});

describe("Fix 12: a root colour reaches label and unit", () => {
  it("adds a softened inherit rule for the quiet parts without their own colour", () => {
    const { css } = compileStyle({ root: { color: "#ffffff", background: "#2f6fb0" } }, { slots: ["root", "value", "label", "unit", "delta"], states: ["hover"] });
    expect(css).toContain('[data-slot="root"] :is([data-slot="label"],[data-slot="unit"],[data-slot="delta"]){color:color-mix(in oklab, currentColor 74%, transparent)}');
  });
  it("a part with its own colour keeps it, and controls are untouched", () => {
    expect(compileStyle({ root: { color: "#fff" }, label: { color: "#000" } }, { slots: ["root", "value", "label", "unit"] }).css).not.toContain('[data-slot="label"],');
    expect(compileStyle({ root: { color: "#fff" } }, { slots: ["root", "label"], states: ["hover", "disabled"] }).css).not.toContain(":is(");
  });
});

describe("Fix 3: binding fields hold what the author typed", () => {
  it("syntax errors and unknown sources are held, valid ones save", () => {
    expect(bindingHoldReason("{{ 1 + }}", ["cpu"])).toMatch(/ends too early/);
    // Wave 2.6 (builder ease spec 3.2): the reason is a sentence naming the source, with the closest real name.
    expect(bindingHoldReason("{{ cpu.value }}", [])).toBe("There is no data source called cpu. This app has no data sources yet: add one with Pick data.");
    expect(bindingHoldReason("{{ cpux.value }}", ["cpu", "lights"])).toBe("There is no data source called cpux. Did you mean cpu?");
    expect(bindingHoldReason("{{ cpu.value }}", ["cpu"])).toBeNull();
    expect(bindingHoldReason("{{ $item.name }}", [])).toBeNull();
    expect(bindingHoldReason("", [])).toBeNull();
  });
});

describe("Fix 13: no ids in the inspector header; chevron folds", () => {
  const lib = { id: "l_2xuzdnx43j", name: "ux-cpu-stat", version: 3 } as LibraryComponent;
  it("a library instance shows its name and a library tag, never its id", () => {
    const n: ComponentNode = { id: "c_x", type: "lib:l_2xuzdnx43j", props: {}, libraryRef: { componentId: "l_2xuzdnx43j", version: 3 } };
    expect(nodeDisplayName(n, { "l_2xuzdnx43j@3": lib })).toEqual({ name: "ux-cpu-stat", tag: "library v3" });
    const m = renderToStaticMarkup(h(InspectorHeader, { node: n, library: { "l_2xuzdnx43j@3": lib } }));
    expect(m).not.toContain("l_2xuzdnx43j");
    expect(m).toContain("ux-cpu-stat");
  });
  it("a plain node shows its name once and its type as a mono tag", () => {
    const m = renderToStaticMarkup(h(InspectorHeader, { node: { id: "c_x", type: "heading", name: "Homelab", props: {} } }));
    expect(m.match(/heading/g)?.length).toBe(1);
    expect(m).toContain("Homelab");
    expect(m).toContain("data-type-tag");
  });
  it("groups fold with a chevron, no bare - or + markers", () => {
    const m = renderToStaticMarkup(h(InspectorPanels, { node: { id: "c_statxxxxxx", type: "stat", props: {} }, doc: doc(), onChange: () => {}, ctx: ctx("edit") }));
    expect(m).toContain("data-fold-chevron");
    expect(m).not.toMatch(/>[−+]</);
  });
});

describe("Fix 1, 5 and 6: Edit code, the style panel and Save to library", () => {
  it("an HTML block's inspector offers Edit code", () => {
    const m = renderToStaticMarkup(h(InspectorPanels, { node: { id: "c_htmlxxxxxx", type: "html", name: "Block", props: { html: "<p></p>", data: {}, controls: [], height: "auto" } }, doc: doc(), onChange: () => {}, ctx: ctx("edit") }));
    expect(m).toContain("data-edit-code");
    expect(m).toContain("Edit code");
  });
  it("Save to library sits in the always-visible actions row, not in Advanced", () => {
    const m = renderToStaticMarkup(h(InspectorPanels, { node: { id: "c_statxxxxxx", type: "stat", props: {} }, doc: doc(), onChange: () => {}, ctx: ctx("edit") }));
    const actions = m.indexOf("data-inspector-actions");
    const save = m.indexOf("data-save-to-library");
    const advanced = m.indexOf('data-inspector-group="advanced"');
    expect(actions).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(actions);
    expect(save).toBeLessThan(advanced);
  });
});

describe("Fix 17: the code category is folded on first open", () => {
  it("insertCatalogue marks Code folded and only Code", () => {
    const g = insertCatalogue({ kind: "user", userId: "u", role: "owner", via: "session" }, { library: [] });
    expect(g.filter((x) => x.folded).map((x) => x.category)).toEqual(["code"]);
  });
});

describe("Fix 2 and 8: containment and touch targets in components.css", () => {
  const css = readFileSync(path.join(__dirname, "components.css"), "utf8");
  it("every node box is isolated and clipped in the guard layer, with !important", () => {
    const guard = /@layer atrium-shell-guard \{([\s\S]*?)\n\}/.exec(css)![1]!;
    expect(guard).toMatch(/\[data-node\] \{[^}]*isolation: isolate !important;[^}]*overflow: clip !important;/);
    expect(guard).toMatch(/\[data-node-styled\][^{]*\{[^}]*overflow-clip-margin: 12px !important/);
    // The guard layer is declared first, so its !important beats atrium-custom's.
    expect(css.indexOf("@layer atrium-shell-guard, atrium-theme, atrium-custom;")).toBeLessThan(css.indexOf("@layer atrium-shell-guard {"));
  });
  it("styled nodes are marked", () => {
    const m = render({ id: "c_styledaaa", type: "text", props: { text: "x" }, css: ":scope { color: red }" }, ctx("view"));
    expect(m).toContain('data-node-styled=""');
    expect(render({ id: "c_plainaaaa", type: "text", props: { text: "x" } }, ctx("view"))).not.toContain("data-node-styled");
  });
  it("links, tabs, selects, sliders get 44px on touch", () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{[\s\S]*a\.atr-link, \.atr-tablist \[role="tab"\], \.atr-select select, \.atr-slider-track input[\s\S]*min-height: 44px; min-width: 44px;/);
  });
});
