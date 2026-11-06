// Wave 2.10c R1 (render half): per-copy changes inside a Repeat. The renderer merges a copy's override over
// the template for that row only, keyed by the row's name (never its place); an override for a row that no
// longer exists is ignored and kept; validation accepts the prop; guests draw the same copies.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppDocument, ComponentNode, RenderContext, ShapedData } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));
vi.mock("server-only", () => ({}));

const { RenderNode } = await import("./render/render-node");
const { RenderDeviceProvider, NodeCssProvider } = await import("./render/context");
const { applyCopyOverride, copyCssId, copyOverridesOf, copyScopedCss, rowKeys, rowName } = await import("./render/copy-overrides");
const { resolveGuestValues } = await import("./page");
const { validateNodes } = await import("./validate");
const { propsSchemas } = await import("./catalogue/schemas");
const { compileDocumentCss } = await import("./style/server");
const { resolveProps, nodeSources } = await import("./render/resolve");

const rows = [
  { name: "pve1", cpu: 12 },
  { name: "pve2", cpu: 55 },
  { name: "nas", cpu: 3 },
];
const machines: ShapedData = { kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, { key: "cpu", label: "CPU", type: "number" }], rows };
const STAT = "c_copystataa";
const REP = "c_copyrepaaa";
function repeat(over?: unknown): ComponentNode {
  return {
    id: REP,
    type: "repeat",
    props: { items: { $bind: "{{ machines.rows }}" }, columns: 3, ...(over ? { copyOverrides: over as never } : {}) } as unknown as Record<string, never>,
    children: [{ id: STAT, type: "stat", props: { value: { $bind: "{{ $item.cpu }}" }, label: { $bind: "{{ $item.name }}" }, unit: "%" } }],
  };
}
function ctx(data: Record<string, ShapedData>, mode: RenderContext["mode"] = "view", guest?: Record<string, unknown>): RenderContext {
  return {
    mode, principal: guest ? { kind: "guest", guestLinkId: "g", appId: "a", label: "g", via: "guest-link" } : { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_copypageaa", version: 1,
    values: { $data: data, $page: { id: "p_copypageaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: guest ? "guest" : "user" }, ...(guest ? { $guest: guest } : {}) } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const render = (node: ComponentNode, c: RenderContext, css: Record<string, string> = {}) =>
  renderToStaticMarkup(h(RenderDeviceProvider, { device: "desktop", children: h(NodeCssProvider, { css, children: h(RenderNode, { node, ctx: c }) }) }));
const copies = (html: string) => html.split(' data-row-key="').slice(1).map((part) => { const key = part.slice(0, part.indexOf('"')); const head = part.slice(0, part.indexOf(">")); return { key, changed: head.includes("data-copy-changed"), html: part }; });
function doc(root: ComponentNode): AppDocument {
  return {
    format: "atrium-app", formatVersion: 1, app: { name: "Copies", homePage: "p_copypageaa", pageOrder: ["p_copypageaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" },
    dataSources: [{ name: "machines", integrationId: "i_fakepromaa", endpointId: "machines-overview", refreshSec: 30 }], controls: [],
    pages: [{ id: "p_copypageaa", slug: "home", title: "Home", inNav: true, root: { id: "c_copyrootaa", type: "grid", props: {}, children: [root] } }],
  } as AppDocument;
}

describe("R1 row keys", () => {
  it("a row is keyed by its name, never by its place; duplicates and nameless rows still get a key", () => {
    expect(rowKeys(rows)).toEqual(["pve1", "pve2", "nas"]);
    expect(rowKeys([{ label: "NPM", state: "up" }, { label: "Kuma" }])).toEqual(["NPM", "Kuma"]);
    expect(rowKeys([{ name: "a" }, { name: "a" }, { cpu: 1 }, "web", 7])).toEqual(["a", "a (2)", "#2", "web", "7"]);
    expect(rowName({ instance: "10.77.0.2:9100" })).toBe("10.77.0.2:9100");
    // A reordered list keeps each row's key.
    expect(rowKeys([rows[2], rows[0], rows[1]])).toEqual(["nas", "pve1", "pve2"]);
  });
});

describe("R1 render: one copy changes, the others stay", () => {
  const over = { pve2: { [STAT]: { props: { unit: " pct", label: "Main box" } } } };
  it("merges the override over the template for that row only", () => {
    const html = render(repeat(over), ctx({ machines }));
    const c = copies(html);
    expect(c.map((x) => x.key)).toEqual(["pve1", "pve2", "nas"]);
    expect(c.find((x) => x.key === "pve2")!.html).toContain("Main box");
    expect(c.find((x) => x.key === "pve2")!.html).toContain("pct");
    expect(c.find((x) => x.key === "pve2")!.changed).toBe(true);
    for (const k of ["pve1", "nas"]) {
      const x = c.find((y) => y.key === k)!;
      expect(x.changed).toBe(false);
      expect(x.html).toContain(k);
      expect(x.html).not.toContain("Main box");
    }
  });
  it("follows the row when rows move, and an override for a row that is gone is ignored", () => {
    const moved: ShapedData = { ...machines, rows: [rows[1]!, rows[0]!] } as ShapedData;
    const html = render(repeat({ ...over, gone: { [STAT]: { props: { label: "Ghost" } } } }), ctx({ machines: moved }));
    const c = copies(html);
    expect(c.map((x) => x.key)).toEqual(["pve2", "pve1"]);
    expect(c[0]!.html).toContain("Main box");
    expect(html).not.toContain("Ghost");
  });
  it("hides a node in one copy only, on desktop and phones", () => {
    const tpl: ComponentNode = { id: "c_copycardaa", type: "card", props: { title: { $bind: "{{ $item.name }}" } }, children: [{ id: STAT, type: "stat", props: { value: { $bind: "{{ $item.cpu }}" } } }] };
    const n: ComponentNode = { ...repeat({ nas: { [STAT]: { hidden: true } } }), children: [tpl] };
    const drawn = applyCopyOverride(tpl, "nas", copyOverridesOf(n).nas);
    expect(drawn.children![0]!.hidden).toBe(true);
    expect(drawn.children![0]!.responsive?.mobile?.hidden).toBe(true);
    expect(tpl.children![0]!.hidden).toBeUndefined(); // the template itself is never changed
    const html = render(n, ctx({ machines }));
    expect((html.match(new RegExp(`data-node="${STAT}"`, "g")) ?? []).length).toBe(2);
  });
  it("a copy's own bindings read that copy's row", () => {
    const html = render(repeat({ pve1: { [STAT]: { props: { label: { $bind: "{{ $item.name | upper }} box" } } } } }), ctx({ machines }));
    expect(copies(html)[0]!.html).toContain("PVE1 box");
  });
  it("the repeat itself never resolves the copies' bindings, and they are not the repeat's own reads", () => {
    const n = repeat({ pve1: { [STAT]: { props: { label: { $bind: "{{ $item.name }}" } } } } });
    const r = resolveProps(n, ctx({ machines }).values as never);
    expect(r.errors).toEqual([]);
    expect(nodeSources(n)).toEqual(["machines"]);
  });
  it("a copy with its own style gets its own CSS scope, aimed at that copy only", () => {
    const n = repeat({ pve1: { [STAT]: { style: { value: { color: "token:bad" } } } } });
    const css = compileDocumentCss(doc(n), "p_copypageaa");
    const scope = copyCssId(STAT, "pve1");
    expect(Object.keys(css)).toContain(scope);
    expect(css[scope]).toContain(`[data-node="${scope}"]`);
    const html = render(n, ctx({ machines }), css);
    expect(html).toContain(`data-copy-css="${scope}"`);
    expect(html).toContain(`[data-node="${STAT}"][data-copy-css="${scope}"]`);
    expect(html).not.toContain(`[data-node="${scope}"]`);
    expect((html.match(/ data-copy-css="/g) ?? []).length).toBe(1);
    expect(copyScopedCss('x[data-node="a-r1"]{}', "a", 'a-r1"]')).toBe("");
  });
});

describe("R1 guests and validation", () => {
  it("guests get the row keys and the changed copy's resolved values", () => {
    const n = repeat({ pve2: { [STAT]: { props: { label: { $bind: "{{ $item.name }} (main)" } } } } });
    const values = resolveGuestValues(doc(n), "p_copypageaa", { machines });
    expect(values[`${REP}:$keys`]).toEqual(["pve1", "pve2", "nas"]);
    expect(values[`${STAT}#1:label`]).toBe("pve2 (main)");
    expect(values[`${STAT}#0:label`]).toBe("pve1");
    expect(Object.keys(values).some((k) => k.includes("copyOverrides"))).toBe(false);
    const html = render(n, ctx({}, "view", values));
    const c = copies(html);
    expect(c.map((x) => x.key)).toEqual(["pve1", "pve2", "nas"]);
    expect(c[1]!.html).toContain("pve2 (main)");
  });
  it("the schema and validate accept copyOverrides, with $item allowed inside it", () => {
    expect(propsSchemas.repeat.safeParse({ copyOverrides: { pve1: { [STAT]: { props: { unit: "x" }, hidden: false, style: { root: { color: "red" } } } } } }).success).toBe(true);
    expect(propsSchemas.repeat.safeParse({ copyOverrides: { pve1: { [STAT]: { colour: "red" } } } }).success).toBe(false);
    const ok = validateNodes(doc(repeat({ pve1: { [STAT]: { props: { label: { $bind: "{{ $item.name }}" } } } }, gone: { c_nothereaaa: { hidden: true } } })));
    expect(ok.filter((p) => p.severity === "error")).toEqual([]);
    const bad = validateNodes(doc(repeat({ pve1: { [STAT]: { props: { decimals: "many" } } } })));
    expect(bad.some((p) => p.code === "props.invalid" && p.message.includes('copy "pve1"'))).toBe(true);
  });
});
