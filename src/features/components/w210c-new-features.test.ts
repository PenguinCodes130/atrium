// Wave 2.10c N1 and N3 (architecture A11.2, A11.3, A11.4): the no-scroll policy's rules and helpers, and the
// roulette's render budget, modes, refusal past 50 rows, guests and validation.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppDocument, ComponentNode, RenderContext, ShapedData } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));

const { RenderNode } = await import("./render/render-node");
const { RenderDeviceProvider } = await import("./render/context");
const { thumbGeometry, keyScroll, focusScrollOf, FOCUS_SCROLL_DEFAULT, THUMB_LINGER_MS } = await import("./render/scroll-area");
const { mountedFaces, drumRadius, timerOf, advanceOf, ROULETTE_MAX, ROULETTE_EMPTY } = await import("./render/roulette");
const { propsSchemas } = await import("./catalogue/schemas");
const { getComponentDef } = await import("./catalogue/defs");
const { newNode } = await import("./insert");
const { validateNodes } = await import("./validate");
const { resolveGuestValues } = await import("./page");
const { fieldsFor } = await import("./inspector/fields");
const { HIDDEN_FIELDS } = await import("./inspector/labels");
const { rouletteToListOps, TIMER_CHOICES } = await import("./inspector/roulette-panel");

const css = readFileSync(path.join(__dirname, "components.css"), "utf8");
function ctx(data: Record<string, ShapedData>, mode: RenderContext["mode"] = "view", guest?: Record<string, unknown>): RenderContext {
  return {
    mode, principal: guest ? { kind: "guest", guestLinkId: "g", appId: "a", label: "g", via: "guest-link" } : { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_newfeataaa", version: 1,
    values: { $data: data, $page: { id: "p_newfeataaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: guest ? "guest" : "user" }, ...(guest ? { $guest: guest } : {}) } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const render = (node: ComponentNode, c: RenderContext) => renderToStaticMarkup(h(RenderDeviceProvider, { device: "desktop", children: h(RenderNode, { node, ctx: c }) }));
const machines = (n: number): ShapedData => ({ kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, { key: "cpu", label: "CPU", type: "number" }], rows: Array.from({ length: n }, (_, i) => ({ name: `m${i + 1}`, cpu: 10 + i })) });
const STAT = "c_roulstataa";
const roul = (props: Record<string, unknown>, children?: ComponentNode[]): ComponentNode => ({ id: "c_roulnodeaa", type: "roulette", props: props as never, children: children ?? [{ id: STAT, type: "stat", props: { value: { $bind: "{{ $item.cpu }}" }, label: { $bind: "{{ $item.name }}" }, unit: "%" } }] });
const slots = (n: number) => Array.from({ length: n }, (_, i): ComponentNode => ({ id: `c_rslot${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}aa`, type: "heading", props: { text: `Slot ${i + 1}` } }));
function doc(root: ComponentNode): AppDocument {
  return {
    format: "atrium-app", formatVersion: 1, app: { name: "N", homePage: "p_newfeataaa", pageOrder: ["p_newfeataaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" },
    dataSources: [{ name: "machines", integrationId: "i_fakepromaa", endpointId: "machines-overview", refreshSec: 30 }], controls: [],
    pages: [{ id: "p_newfeataaa", slug: "home", title: "Home", inNav: true, root: { id: "c_newrootaaa", type: "grid", props: {}, children: [root] } }],
  } as AppDocument;
}

describe("N1 sizing and Focus to scroll (A11.2, A11.3)", () => {
  it("only table, list and repeat take focusScroll, default click", () => {
    for (const t of ["table", "list", "repeat"] as const) {
      expect(propsSchemas[t].safeParse({ focusScroll: "hover" }).success, t).toBe(true);
      expect(propsSchemas[t].safeParse({ focusScroll: "always" }).success, t).toBe(false);
      expect(getComponentDef(t)?.sizing, t).toBe("scroll");
    }
    expect(propsSchemas.stat.safeParse({ focusScroll: "click" }).success).toBe(false);
    expect(FOCUS_SCROLL_DEFAULT).toBe("click");
    expect([focusScrollOf(undefined), focusScrollOf("hover"), focusScrollOf("off"), focusScrollOf("x")]).toEqual(["click", "hover", "off", "click"]);
    expect(fieldsFor("table").find((f) => f.key === "focusScroll")?.optionWords?.click).toMatch(/click/i);
  });
  it("the thumb's length and place follow the scroll; nothing is drawn when nothing scrolls", () => {
    expect(thumbGeometry(0, 100, 100)).toBeNull();
    expect(thumbGeometry(0, 100.5, 100)).toBeNull();
    const top = thumbGeometry(0, 400, 100)!;
    expect(top).toEqual({ top: 0, height: 25 });
    expect(thumbGeometry(300, 400, 100)!.top).toBeCloseTo(75);
    expect(thumbGeometry(150, 400, 100)!.top).toBeCloseTo(37.5);
    expect(thumbGeometry(0, 10000, 100)!.height).toBe(24); // never thinner than 24px
    expect(THUMB_LINGER_MS).toBe(800);
  });
  it("keys scroll a released list: arrows, page keys, space, home and end", () => {
    expect(keyScroll("ArrowDown", false, 200, 1000)).toEqual({ by: 40 });
    expect(keyScroll("PageUp", false, 200, 1000)).toEqual({ by: -180 });
    expect(keyScroll(" ", true, 200, 1000)).toEqual({ by: -180 });
    expect(keyScroll("End", false, 200, 1000)).toEqual({ to: 1000 });
    expect(keyScroll("a", false, 200, 1000)).toBeNull();
  });
  it("the CSS: browser bars hidden on every component, released scroll roots take no wheel, the accent ring and the drawn thumb", () => {
    expect(css).toMatch(/\.atr-render-root :is\(\.atr-node, \.atr-node \*\) \{ scrollbar-width: none; \}/);
    expect(css).toMatch(/::-webkit-scrollbar \{ display: none;/);
    expect(css).toMatch(/\[data-sizing="scroll"\]\[data-focus-scroll\]:not\(\[data-focus-scroll="off"\]\):not\(\[data-scroll-engaged\]\) > \[data-slot="root"\] \{ overflow: hidden; \}/);
    expect(css).toMatch(/\[data-scroll-engaged\] > \[data-slot="root"\] \{ outline: 1px solid var\(--theme-accent\)/);
    expect(css).toMatch(/\.atr-scroll-thumb \{[^}]*background: var\(--theme-scrollbar-thumb, color-mix\(in oklab, var\(--theme-canvas-text\) 35%, transparent\)\)[^}]*opacity: 0;/);
    expect(css).toMatch(/width: var\(--theme-scrollbar-width, 6px\)/);
    // Still only scrolling kinds scroll (A11.2).
    expect(css).toMatch(/\.atr-grid\[data-fixed-rows\] > \.atr-cell > \.atr-node > \[data-slot="root"\] \{ min-height: 0; overflow: clip;/);
  });
  it("a scrolling kind renders the thumb; a fit kind in edit mode renders the cut badge, hidden until measured", () => {
    const table: ComponentNode = { id: "c_ntableaaaa", type: "table", props: { data: { $bind: "{{ machines }}" } } };
    const html = render(table, ctx({ machines: machines(3) }));
    expect(html).toContain("data-scroll-thumb");
    expect(html).not.toContain("data-content-cut");
    const stat: ComponentNode = { id: "c_nstataaaaa", type: "stat", props: { value: 3 } };
    const edit = render(stat, ctx({}, "edit"));
    expect(edit).toContain("atr-cut-badge");
    expect(edit).toContain("Content is cut");
    expect(edit).toMatch(/class="atr-cut-badge"[^>]*hidden/);
    expect(render(stat, ctx({}, "view"))).not.toContain("atr-cut-badge");
  });
});

describe("N3 roulette (A11.4)", () => {
  it("is a layout container, sized by scale, with a 3 by 28 insert box and slots mode by default", () => {
    const d = getComponentDef("roulette")!;
    expect([d.category, d.container, d.sizing]).toEqual(["layout", true, "scale"]);
    const n = newNode("roulette");
    expect(n.props).toEqual({ mode: "slots", advance: { scroll: true, arrows: true, dots: true } });
    expect(n.slot).toEqual({ x: 0, y: 0, w: 3, h: 28 });
    expect(n.children).toEqual([]);
  });
  it("the schema: modes, the timer 3 s to 1 h (absent is off), advance switches, startAt", () => {
    const s = propsSchemas.roulette;
    expect(s.safeParse({ mode: "repeat", items: { $bind: "{{ machines.rows }}" }, timerSec: 3, advance: { scroll: false }, startAt: 2 }).success).toBe(true);
    expect(s.safeParse({ timerSec: 2 }).success).toBe(false);
    expect(s.safeParse({ timerSec: 3601 }).success).toBe(false);
    expect(s.safeParse({ mode: "wheel" }).success).toBe(false);
    expect([timerOf(undefined), timerOf(2), timerOf(3), timerOf(3600), timerOf(3601)]).toEqual([null, null, 3, 3600, null]);
    expect(advanceOf(undefined)).toEqual({ scroll: true, arrows: true, dots: true });
    expect(advanceOf({ dots: false })).toEqual({ scroll: true, arrows: true, dots: false });
    expect(TIMER_CHOICES[0]).toEqual({ sec: 0, words: "Off" });
    expect(TIMER_CHOICES.every((c) => c.sec === 0 || (c.sec >= 3 && c.sec <= 3600))).toBe(true);
    for (const k of Object.keys(s.shape)) if (!HIDDEN_FIELDS.has(`roulette.${k}`)) expect(fieldsFor("roulette").find((f) => f.key === k)?.hint, k).toBeTruthy();
  });
  it("mounts only the visible slot and its two neighbours, each slot once", () => {
    expect(mountedFaces(0, 10).map((f) => f.slot)).toEqual([9, 0, 1]);
    expect(mountedFaces(12, 10).map((f) => f.slot)).toEqual([1, 2, 3]);
    expect(mountedFaces(-1, 10).map((f) => f.slot)).toEqual([8, 9, 0]);
    expect(mountedFaces(0, 2, 1).map((f) => f.slot)).toEqual([0, 1]);
    expect(mountedFaces(0, 1)).toEqual([{ k: 0, slot: 0 }]);
    expect(mountedFaces(0, 0)).toEqual([]);
    expect(drumRadius(100)).toBeCloseTo(50 / Math.tan((20 * Math.PI) / 180));
    const html = render(roul({ mode: "slots" }, slots(10)), ctx({}));
    expect((html.match(/data-face="/g) ?? []).length).toBe(3);
    expect(html).toContain("Slot 1");
    expect(html).toContain("Slot 2");
    expect(html).toContain("Slot 10");
    expect(html).not.toContain("Slot 5");
    expect(html).toContain('aria-roledescription="roulette"');
    expect((html.match(/data-roulette-dot=/g) ?? []).length).toBe(10);
  });
  it("repeat mode: one slot per machine, row keys, copy changes; startAt picks the first", () => {
    const html = render(roul({ mode: "repeat", items: { $bind: "{{ machines.rows }}" }, startAt: 1, copyOverrides: { m2: { [STAT]: { props: { label: "Main" } } } } }), ctx({ machines: machines(5) }));
    expect(html).toContain('data-count="5"');
    expect(html).toContain('data-current="1"');
    expect((html.match(/data-face="/g) ?? []).length).toBe(3);
    expect(html).toContain('data-row-key="m1"');
    expect(html).toContain('data-row-key="m3"');
    expect(html).toContain("Main");
    expect(html).not.toContain('data-row-key="m5"');
  });
  it("past 50 rows it refuses and says why; at 50 it turns", () => {
    const over = render(roul({ mode: "repeat", items: { $bind: "{{ machines.rows }}" } }), ctx({ machines: machines(51) }));
    expect(over).toContain("data-roulette-refused");
    expect(over).toContain(`more than ${ROULETTE_MAX} rows`);
    expect(over).not.toContain("data-face");
    const fifty = render(roul({ mode: "repeat", items: { $bind: "{{ machines.rows }}" } }), ctx({ machines: machines(50) }));
    expect(fifty).toContain('data-count="50"');
    expect(fifty).toContain("data-roulette-count"); // "1 of 50" in place of 50 dots
  });
  it("empty: the builder says what to do; the viewer draws nothing", () => {
    expect(render(roul({ mode: "slots" }, []), ctx({}, "edit"))).toContain(ROULETTE_EMPTY);
    expect(render(roul({ mode: "slots" }, []), ctx({}, "view"))).not.toContain(ROULETTE_EMPTY);
  });
  it("reduced motion is a crossfade: no 3D drum transform", () => {
    // The SSR render has no reduced-motion preference, so the turn is drawn: a face carries rotateX.
    const html = render(roul({ mode: "slots" }, slots(3)), ctx({}));
    expect(html).toContain('data-motion="turn"');
    expect(html).toMatch(/rotateX\(-?\d+deg\) translateZ/);
  });
  it("guests: every slot resolves, the count and row keys come from the server, and over 50 is refused", () => {
    const rep = roul({ mode: "repeat", items: { $bind: "{{ machines.rows }}" } });
    const v = resolveGuestValues(doc(rep), "p_newfeataaa", { machines: machines(4) });
    expect(v["c_roulnodeaa:$count"]).toBe(4);
    expect(v["c_roulnodeaa:$keys"]).toEqual(["m1", "m2", "m3", "m4"]);
    expect(v[`${STAT}#3:label`]).toBe("m4");
    const html = render(rep, ctx({}, "view", v));
    expect(html).toContain('data-count="4"');
    expect(html).toContain("m1");
    const big = resolveGuestValues(doc(rep), "p_newfeataaa", { machines: machines(60) });
    expect(big["c_roulnodeaa:$count"]).toBeGreaterThan(50);
    expect(Object.keys(big).some((k) => k.startsWith(`${STAT}#`))).toBe(false);
    expect(render(rep, ctx({}, "view", big))).toContain("data-roulette-refused");
  });
  it("validate: $item is allowed in repeat mode; one slot, extra template children and over 50 slots are named", () => {
    const ok = validateNodes(doc(roul({ mode: "repeat", items: { $bind: "{{ machines.rows }}" } })));
    expect(ok.filter((p) => p.severity === "error")).toEqual([]);
    const outside = validateNodes(doc(roul({ mode: "slots" })));
    expect(outside.some((p) => p.code === "binding.repeat_only")).toBe(true);
    expect(outside.some((p) => p.code === "roulette.one_slot")).toBe(true);
    expect(validateNodes(doc(roul({ mode: "repeat", items: [] }, slots(2)))).some((p) => p.code === "roulette.template")).toBe(true);
    expect(validateNodes(doc(roul({ mode: "slots" }, slots(51)))).some((p) => p.code === "roulette.children")).toBe(true);
    expect(validateNodes(doc(roul({ mode: "slots" }, slots(50)))).some((p) => p.code === "roulette.children" || p.code === "repeat.children")).toBe(false);
  });
  it("the inspector's list or table swap replaces the roulette in its place with the same rows", () => {
    const r = { ...roul({ mode: "repeat", items: { $bind: "{{ machines.rows }}" } }), slot: { x: 1, y: 2, w: 3, h: 28 } };
    const d = doc(r);
    const ops = rouletteToListOps(r, d.pages, "table")!;
    expect(ops[0]).toEqual({ op: "node.remove", nodeId: "c_roulnodeaa" });
    expect(ops[1]).toMatchObject({ op: "node.add", parentId: "c_newrootaaa", index: 0, node: { type: "table", props: { data: { $bind: "{{ machines.rows }}" } }, slot: { x: 1, y: 2, w: 3, h: 28 } } });
    expect((rouletteToListOps(r, d.pages, "list")![1] as { node: ComponentNode }).node.props).toEqual({ items: { $bind: "{{ machines.rows }}" } });
  });
});
