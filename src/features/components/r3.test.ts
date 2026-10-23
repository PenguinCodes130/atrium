// Round 3 (gauntlet w2-r2 Fix List, approved 2026-10-19) unit checks: the node guard against
// display: contents, var()/env() positions and runaway roots; Style panel shadows drawn by the node box
// with a capped reach; bound fields that clear and unbind; cards as the only window with a rolled-up
// status; the padded no-data state and the Connect it link; the chart sample; the library not-found
// room; plain fields that look like bindings; stale console lines; switch labels; shape mismatches;
// status rows.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentNode, LibraryComponent, RenderContext, ShapedData } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));

const { RenderNode } = await import("./render/render-node");
const { RenderDeviceProvider } = await import("./render/context");
const { bindingHoldReason, fixedValueOf } = await import("./inspector/inspector");
const { compileStyle, declarations, shadowReach, SHADOW_REACH_MAX, NODE_BOX } = await import("./style/compile");
const { compileNodeCss, nodeBoxCss } = await import("./style/server");
const { rollupStatus, shapeMismatch } = await import("./render/rollup");
const { SAMPLE_DATA } = await import("./catalogue/samples");
const { newNode, NEW_SIZE } = await import("./insert");
const { pushBlockLog, startBlockRun, blockLogs, clearBlockLogs } = await import("./sandbox/bridge");
const { fieldsFor } = await import("./inspector/fields");

const CSS = readFileSync(path.join(import.meta.dirname, "components.css"), "utf8");
const guard = CSS.slice(CSS.indexOf("@layer atrium-shell-guard {"), CSS.indexOf("@layer atrium-theme {"));

type Src = Record<string, { state: "fresh" | "stale" | "failed" | "empty"; data?: ShapedData; refreshSec: number; error?: { code: string; message: string; hint?: string } }>;
function ctx(mode: RenderContext["mode"], sources: Src = {}, extra: Record<string, unknown> = {}): RenderContext {
  const $data: Record<string, ShapedData | undefined> = {};
  for (const [k, v] of Object.entries(sources)) $data[k] = v.data;
  return {
    mode, principal: { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_aaaaaaaaaa", version: "draft",
    values: { $data, $sources: sources, $page: { id: "p_aaaaaaaaaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "homelab", name: "Homelab" }, $user: { kind: "user" }, ...extra } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const render = (node: ComponentNode, c: RenderContext) => renderToStaticMarkup(h(RenderDeviceProvider, { device: "desktop", children: h(RenderNode, { node, ctx: c }) }));
const fresh = (data: ShapedData): Src[string] => ({ state: "fresh", data, refreshSec: 30 });

describe("Fixes 1, 2 and 9: the guard pins the node's own box whatever value reaches it", () => {
  it("every node keeps a box (display pinned), is the containing block for fixed descendants and clips", () => {
    for (const decl of ["display: block !important", "contain: layout !important", "overflow: clip !important", "isolation: isolate !important", "position: relative !important"]) expect(guard, decl).toContain(decl);
    // A node that fills a grid cell keeps its flex column.
    expect(guard).toMatch(/\.atr-cell > \[data-node\][^{]*\{\s*display: flex !important;/);
  });
  it("the node cannot move, grow, pad or animate itself out of its slot", () => {
    for (const decl of ["max-height: max(150vh, 1200px) !important", "inset: auto !important", "z-index: auto !important", "margin: 0 !important", "padding: 0 !important", "height: auto !important", "min-height: auto !important", "max-height: none !important", "width: auto !important", "zoom: 1 !important", "animation: none !important", "float: none !important"]) expect(guard, decl).toContain(decl);
  });
  it("clip margins: 12px for styled nodes, 104px for plain nodes (room for child shadows up to the reach cap)", () => {
    expect(guard).toContain("overflow-clip-margin: 104px !important");
    expect(guard).toMatch(/\[data-node-styled\][^{]*\{\s*overflow-clip-margin: 12px !important;/);
    expect(104).toBeGreaterThan(SHADOW_REACH_MAX);
  });
  it("the guard is declared first, so its !important pins beat custom CSS and custom !important", () => {
    expect(CSS.indexOf("@layer atrium-shell-guard, atrium-theme, atrium-custom;")).toBeLessThan(CSS.indexOf("@layer atrium-shell-guard {"));
  });
  it("node CSS from the 24 hostile probe variants compiles to rules the guard pins (no root position, display or size escapes)", () => {
    const BIG = "position:absolute;inset:-2000px;background:rgba(255,0,0,.6);z-index:2147483647;";
    const variants = [
      "* { position: absolute; top: -2000px; left: -2000px; width: 6000px; height: 6000px; z-index: 2147483647 } :scope { position: fixed; inset: 0; box-shadow: 0 0 0 3000px rgba(255,0,0,.4) }",
      "* { position: fixed; inset: 0; z-index: 2147483647 }",
      ":scope { transform: scale(30) }",
      ":scope:not(.zz) { scale: 30; z-index: 99; box-shadow: 0 0 0 3000px red }",
      "@media (min-width: 1px) { :scope { transform: scale(30); outline: 3000px solid red } }",
      `:scope { overflow: visible !important; isolation: auto !important; position: static !important; contain: none !important } * { ${BIG} }`,
      `:scope { all: revert-layer !important } * { ${BIG} }`,
      ":scope { animation: cuatk 1ms forwards } @keyframes cuatk { to { scale: 30 } }",
      ":scope { grid-row: 1 / 60; grid-column: 1 / -1; order: -1 }",
    ];
    for (const css of variants) {
      const out = compileNodeCss({ id: "c_hostilenod", type: "stat", css }).css;
      expect(out, css).not.toMatch(/\[data-node="c_hostilenod"\]\{[^}]*(position|transform|scale|box-shadow|outline|z-index)/);
      expect(out, css).not.toMatch(/@keyframes/);
    }
  });
});

describe("Fix 7: Style panel shadows render whole, drawn by the node box, with a stated reach", () => {
  it("shadowReach: the largest offset plus blur plus spread; inset shadows do not reach out", () => {
    expect(shadowReach("0 24px 48px rgba(0,0,0,.55)")).toBe(72);
    expect(shadowReach("0 12px 32px rgb(0 0 0 / 0.14)")).toBe(44);
    expect(shadowReach("6px 6px 0 0 var(--theme-surface-text)")).toBe(6);
    expect(shadowReach("inset 0 0 0 400px red, 2px 2px 4px 1px red")).toBe(7);
    expect(shadowReach("0 0 1rem 0 red")).toBe(16);
  });
  it("the presets and the critic's soft shadow pass; a shadow beyond the cap or in viewport units is refused with the reach named", () => {
    for (const v of ["0 12px 32px rgb(0 0 0 / 0.14)", "6px 6px 0 0 token:surfaceText", "0 24px 48px rgba(0,0,0,.55)", "none"]) {
      const r: never[] = [];
      expect(declarations({ boxShadow: v }, { slot: "root" }, r), v).toHaveLength(1);
    }
    const refused: { reason: string }[] = [];
    declarations({ boxShadow: "0 0 0 3000px red" }, { slot: "root" }, refused as never);
    expect(refused[0]!.reason).toMatch(new RegExp(`at most ${SHADOW_REACH_MAX}px.*reaches 3000px`));
    const vw: { reason: string }[] = [];
    declarations({ boxShadow: "0 0 0 50vw red" }, { slot: "root" }, vw as never);
    expect(vw).toHaveLength(1);
  });
  it("with nodeBox, the root's shadow (and radius) leave the root part's CSS for node-box rules, also per state and on phones", () => {
    const r = compileStyle({ root: { boxShadow: "0 24px 48px rgba(0,0,0,.55)", borderRadius: 12, background: "#fff", states: { hover: { boxShadow: "0 8px 16px red" } } } }, { slots: ["root"], states: ["hover"], mobile: { root: { boxShadow: "none" } }, nodeBox: true });
    expect(r.css).not.toContain("box-shadow");
    expect(r.css).toContain("border-radius:12px");
    expect(r.nodeBox).toContain(`${NODE_BOX}{box-shadow:0 24px 48px rgba(0,0,0,.55);border-radius:12px}`);
    expect(r.nodeBox).toContain(`${NODE_BOX}:has(> [data-slot="root"]:hover){box-shadow:0 8px 16px red}`);
    expect(r.nodeBox).toMatch(/@container atrium-page \(max-width: 639\.98px\)\{:node-box\{box-shadow:none\}\}/);
    // Chrome styles (no nodeBox) keep the shadow on their own root part.
    expect(compileStyle({ root: { boxShadow: "0 2px 4px red" } }, { slots: ["root"] }).css).toContain("box-shadow:0 2px 4px red");
  });
  it("compileNodeCss emits the node-box rules for this node only, in atrium-custom; nodeBoxCss refuses anything unexpected", () => {
    const out = compileNodeCss({ id: "c_shadowaaaa", type: "stat", overrideTheme: true, style: { root: { boxShadow: "0 24px 48px rgba(0,0,0,.55)" } } }).css;
    expect(out).toContain('@layer atrium-custom{\n[data-node="c_shadowaaaa"]{box-shadow:0 24px 48px rgba(0,0,0,.55)}\n}');
    expect(nodeBoxCss(`${NODE_BOX}{box-shadow:0 0 1px red}`, "bad id!")).toBe("");
    expect(nodeBoxCss(`${NODE_BOX}{position:fixed}`, "c_x")).toBe("");
    expect(nodeBoxCss(`${NODE_BOX}{box-shadow:url(x)}`, "c_x")).toBe("");
    expect(nodeBoxCss(`${NODE_BOX}{box-shadow:0 0 1px red}</style>`, "c_x")).toBe("");
    // Node CSS text can never reach the node-box rules: a root shadow in node CSS is still dropped.
    expect(compileNodeCss({ id: "c_shadowaaab", type: "stat", css: ":scope { box-shadow: 0 0 0 40px red }" }).css).not.toContain("box-shadow");
  });
  it("a styled node draws the theme's window shadow on its own box, except inside a card", () => {
    // Final pass (w2-r3 item 1): through --atr-node-shadow, resolved above the nodes and pinned on each node box.
    expect(CSS).toMatch(/\.atr-node\[data-node-styled\]:not\(\.atr-card \.atr-node\):has\(> \[data-slot="root"\]\.canvas-surface\) \{ box-shadow: var\(--atr-node-shadow, none\)/);
    expect(CSS).toContain('.atr-node[data-node-styled] > [data-slot="root"].canvas-surface { box-shadow: none; }');
  });
});

describe("Fix 3: bound fields hold half-typed braces, clear and unbind", () => {
  it("a half-typed binding is held, never saved as text", () => {
    for (const t of ["{", "{{", "{{ disk.un", "{{ disk.unit }", "41 {"]) expect(bindingHoldReason(t, ["disk"]), t).toMatch(/not finished/);
    expect(bindingHoldReason("{{ disk.unit }}", ["disk"])).toBeNull();
    expect(bindingHoldReason("GB", ["disk"])).toBeNull();
    expect(bindingHoldReason("", [])).toBeNull();
  });
  it("Use a fixed value keeps the literal the binding holds", () => {
    const text = { field: { kind: "text" as const } };
    const num = { field: { kind: "number" as const } };
    expect(fixedValueOf("x", text)).toBe("x");
    expect(fixedValueOf("{{ 'GB' }}", text)).toBe("GB");
    expect(fixedValueOf("{{ 512 }}", num)).toBe(512);
    expect(fixedValueOf("{{ cpu.value }}", num)).toBeNull();
    expect(fixedValueOf("", text)).toBeNull();
    expect(fixedValueOf("{{ 1 + }}", text)).toBeNull();
  });
  it("the inspector removes a prop with a merge-patch null (a missing key would mean unchanged)", () => {
    const src = readFileSync(path.join(import.meta.dirname, "inspector/inspector.tsx"), "utf8");
    expect(src).toContain("const setProp = (k: string, v: PropValue | null) => onChange({ props: { ...node.props, [k]: v } }");
    expect(src).toContain('spec.field.kind === "data" ? null : { $bind: "" }');
    expect(src).toContain("css: e.target.value || null");
    expect(src).toContain("visibleWhen: t.trim() ? { $bind: t } : null");
  });
});

describe("Fix 4: one window, wells inside, rolled-up status, the saved value", () => {
  const cpu = fresh({ kind: "stat", value: 41.3, unit: "%", label: "CPU" });
  const card: ComponentNode = { id: "c_cardaaaaaa", type: "card", props: { title: "pve1" }, children: [
    { id: "c_statinner1", type: "stat", props: { data: { $bind: "{{ cpu }}" } } },
    { id: "c_statinner2", type: "stat", props: { label: "CPU", data: 42 } },
  ] };
  it("a stat whose data is a plain number shows it (the saved Server card reads 42)", () => {
    const m = render({ id: "c_seedstatia", type: "stat", props: { label: "CPU", data: 42 } }, ctx("view"));
    expect(m).toMatch(/data-slot="value"[^>]*>42</);
    expect(m).not.toContain("data-shape-mismatch");
  });
  it("the card's bar carries the worst status of the components inside", () => {
    expect(render(card, ctx("view", { cpu }))).toMatch(/data-rollup="ok"[\s\S]*data-titlebar-status="live"/);
    expect(render(card, ctx("view", { cpu: { state: "stale", data: cpu.data, refreshSec: 30 } }))).toMatch(/data-rollup="stale"/);
    expect(render(card, ctx("view", { cpu: { state: "empty", refreshSec: 30, error: { code: "unmapped", message: "No data: connect Docker", hint: "/integrations/new/docker" } } }))).toMatch(/data-titlebar-status="no data"/);
  });
  it("rollupStatus expands library instances and treats unconnected components as samples in edit", () => {
    const lib = { id: "l_aaaaaaaaaa", name: "cpu", version: 1, params: [{ name: "cpu", label: "cpu", kind: "data", default: "cpu" }], node: { id: "c_libstataa", type: "stat", props: { data: { $bind: "{{ $param.cpu }}" } } } } as unknown as LibraryComponent;
    const inst: ComponentNode = { id: "c_instaaaaaa", type: "lib:l_aaaaaaaaaa", props: { cpu: "cpu" }, libraryRef: { componentId: "l_aaaaaaaaaa", version: 1 } };
    const scope = { $data: { cpu: cpu.data }, $sources: { cpu: { state: "failed", error: { code: "x", message: "down" } } }, $library: { "l_aaaaaaaaaa@1": lib } } as never;
    expect(rollupStatus([inst], scope, { edit: false, path: "" }).kind).toBe("failed");
    expect(rollupStatus([{ id: "c_new", type: "stat", props: {} }], {} as never, { edit: true, path: "" }).kind).toBe("none");
    expect(rollupStatus([{ id: "c_new", type: "stat", props: {} }], {} as never, { edit: false, path: "" }).kind).toBe("empty");
  });
  it("inside a card a window is a well: sunk, no border, shadow or bar of its own", () => {
    expect(CSS).toMatch(/\.atr-card \.atr-node \.canvas-surface \{ background-color: var\(--bg-sunk[^}]*border-color: transparent; box-shadow: none;/);
    expect(CSS).toContain('[data-canvas-titlebars="on"] .atr-card .atr-node .atr-titlebar { display: none; }');
  });
  it("library previews show no component bars and no theme shadows; the card's window says sample, never live", () => {
    expect(CSS).toContain('[data-library-preview] [data-canvas-titlebars="on"] .atr-titlebar { display: none; }');
    const src = readFileSync(path.join(import.meta.dirname, "../library/ui/library-screen.tsx"), "utf8");
    expect(src).toMatch(/status=\{c\.params\.some\(\(p\) => p\.kind === "data"\) \? `sample · v\$\{c\.version\}` : `v\$\{c\.version\}`\} live=\{false\}/);
  });
});

describe("Fix 5: the no-data state is padded everywhere and Connect it is a link", () => {
  const unmapped = { state: "empty" as const, refreshSec: 30, error: { code: "unmapped", message: "No data: connect Docker", hint: "/integrations/new/docker" } };
  it("the link is an accent link with an arrow, in table, list and stat", () => {
    for (const type of ["table", "list", "stat"]) {
      const m = render({ id: `c_${type}aaaaaa`, type: type as ComponentNode["type"], props: type === "list" ? { items: { $bind: "{{ docker.rows }}" } } : { data: { $bind: "{{ docker }}" } } }, ctx("view", { docker: unmapped }));
      expect(m, type).toMatch(/<a class="atr-state-link" href="\/integrations\/new\/docker" data-connect-link="true">Connect it <span aria-hidden="true">→<\/span><\/a>/);
    }
    expect(CSS).toMatch(/\.atr-state-link \{[^}]*color: var\(--theme-accent-ink[^}]*text-decoration: underline/);
  });
  it("the flush table's state gets the window padding, and the link is 44px on touch", () => {
    expect(CSS).toContain(".canvas-surface-flush > .atr-state { padding: var(--theme-pad, 20px); }");
    expect(CSS).toContain(".atr-render-root a.atr-state-link { min-height: 44px; min-width: 44px; }");
  });
});

describe("Fix 6: a new chart reads as a chart", () => {
  it("lands landscape: 6 columns by 35 rows (exact boxes, 2026-10-19), 150px of plot", () => {
    const n = newNode("chart");
    expect(n.slot).toEqual({ x: 0, y: 0, w: 6, h: 35 });
    expect(n.props.height).toBe(150);
    expect(NEW_SIZE.text).toBeUndefined(); // types that fit 3 by 16 keep the builder default
  });
  it("the sample has three named series, named in the title bar", () => {
    const s = SAMPLE_DATA.series as Extract<ShapedData, { kind: "series" }>;
    expect(s.series.map((x) => x.name)).toEqual(["node-1", "node-2", "node-3"]);
    const m = render({ id: "c_chartaaaaa", type: "chart", props: { kind: "line", legend: true } }, ctx("edit"));
    expect(m).toMatch(/data-titlebar-legend="true"[\s\S]*node-1[\s\S]*node-2[\s\S]*node-3/);
    expect(m).toContain("data-legend-in-bar");
  });
  it("a gap in the first series breaks the line, never the fill", () => {
    const pts: [number, number | null][] = [[0, 1], [1, 2], [2, null], [3, 3], [4, 2]];
    const m = render({ id: "c_chartbbbbb", type: "chart", props: { kind: "area", data: { $bind: "{{ load }}" } } }, ctx("view", { load: fresh({ kind: "series", series: [{ name: "a", points: pts }, { name: "b", points: pts }] }) }));
    expect(m.match(/data-area-fill/g)).toHaveLength(1);
    expect(m).toMatch(/data-segments="2"/);
  });
});

describe("Fix 10, 13, 14, 15, 11", () => {
  it("Fix 13: field labels are sentence case", () => {
    const labels = fieldsFor("stat").map((f) => f.label);
    // Wave 2.6 (builder ease spec 3.2): written labels replace the generated "Show updated".
    expect(labels).toContain("Show when it was updated");
    expect(labels.some((l) => / [A-Z]/.test(l))).toBe(false);
  });
  it("Fix 14: a component bound to the wrong shape says so calmly, with no live dot", () => {
    expect(shapeMismatch("status", { kind: "stat", value: 1 }, "cpu")).toBe("cpu is a single value; Status needs a status list. Try Stat.");
    expect(shapeMismatch("table", [1, 2], "x")).toBe("x is a list; Table needs a table. Try List.");
    expect(shapeMismatch("chart", { kind: "stat", value: 1 }, "cpu")).toMatch(/Chart needs a series over time\. Try Stat\./);
    expect(shapeMismatch("status", { kind: "status", items: [] }, "x")).toBeNull();
    expect(shapeMismatch("stat", 42, "x")).toBeNull();
    const m = render({ id: "c_statusaaaa", type: "status", props: { data: { $bind: "{{ cpu }}" } } }, ctx("view", { cpu: fresh({ kind: "stat", value: 41, label: "CPU" }) }));
    expect(m).toContain("cpu is a single value; Status needs a status list. Try Stat.");
    expect(m).toContain('data-titlebar-status="check data"');
    expect(m).not.toContain('data-titlebar-status="live"');
  });
  it("Fix 15: the status word stays inline at the right", () => {
    expect(CSS).toMatch(/\.atr-state-word \{[^}]*flex: none; margin-left: auto; white-space: nowrap;/);
    expect(CSS).toMatch(/\.atr-status li > \[data-slot="label"\], \.atr-status li > a \{ flex: 1 1 0; min-width: 0;/);
  });
  it("Fix 11: a new run marks earlier console lines stale", () => {
    clearBlockLogs("c_htmlaaaaaa");
    pushBlockLog("c_htmlaaaaaa", { at: 1, level: "error", message: "Unexpected end of input" });
    startBlockRun("c_htmlaaaaaa");
    pushBlockLog("c_htmlaaaaaa", { at: 2, level: "info", message: "ran" });
    expect(blockLogs("c_htmlaaaaaa").map((l) => [l.message, !!l.stale])).toEqual([["Unexpected end of input", true], ["ran", false]]);
  });
});
