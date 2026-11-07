// Wave 2.10c round 2 (gauntlet w210c-r1 Fix List, builder C): what a roulette takes as a child (item 1), its
// rows field (item 2), one cylinder for both modes (items 3 and 10), the wheel, swipe and dots (items 11 and
// 20), the badge in the cell (item 12), the scroll kinds' cues (item 13) and prototype-safe copy overrides
// (item 6c).
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppDocument, ComponentNode, RenderContext, ShapedData } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));

const { RenderNode } = await import("./render/render-node");
const { RenderDeviceProvider } = await import("./render/context");
const { rouletteDropRule, ROULETTE_FULL, ROULETTE_TEMPLATE_TAKEN, ROULETTE_NOT_ITSELF } = await import("./roulette-rules");
const { faceLook, wheelSlots, dotsFit, swipeSlots, drumRadius, ROULETTE_STEP_DEG, ROULETTE_NEIGHBOUR_OPACITY, ROULETTE_NEIGHBOUR_SCALE, WHEEL_SLOT_PX } = await import("./render/roulette");
const { validateNodes } = await import("./validate");
const { propsSchemas } = await import("./catalogue/schemas");
const { META } = await import("./catalogue/meta");
const { fieldsFor } = await import("./inspector/fields");
const { rouletteItemsSentence, rowTemplateNode, rowsTemplate } = await import("./inspector/roulette-panel");
const { copyOverridesOf, applyCopyOverride, rowKeys, hasCopyChange, UNSAFE_KEYS } = await import("./render/copy-overrides");
const { BADGE_GAP_PX, BADGE_INSET_PX } = await import("./render/scroll-area");

const css = readFileSync(path.join(__dirname, "components.css"), "utf8");
const STAT = "c_r2statxaaa";
const stat = (id = STAT): ComponentNode => ({ id, type: "stat", props: { value: { $bind: "{{ $item.cpu }}" }, label: { $bind: "{{ $item.name }}" } } });
const roul = (props: Record<string, unknown>, children: ComponentNode[] = []): ComponentNode => ({ id: "c_r2roulxaaa", type: "roulette", props: props as never, children });
const slots = (n: number) => Array.from({ length: n }, (_, i): ComponentNode => ({ id: `c_r2s${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}xaaaa`, type: "heading", props: { text: `Slot ${i + 1}` } }));
function doc(root: ComponentNode): AppDocument {
  return {
    format: "atrium-app", formatVersion: 1, app: { name: "N", homePage: "p_r2pagexaaa", pageOrder: ["p_r2pagexaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" },
    dataSources: [{ name: "machines", integrationId: "i_fakepromaa", endpointId: "machines-overview", refreshSec: 30 }], controls: [],
    pages: [{ id: "p_r2pagexaaa", slug: "home", title: "Home", inNav: true, root: { id: "c_r2rootxaaa", type: "grid", props: {}, children: [root] } }],
  } as AppDocument;
}
function ctx(data: Record<string, ShapedData>, mode: RenderContext["mode"] = "view"): RenderContext {
  return {
    mode, principal: { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_r2pagexaaa", version: 1,
    values: { $data: data, $page: { id: "p_r2pagexaaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: "user" } } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const render = (node: ComponentNode, c: RenderContext) => renderToStaticMarkup(h(RenderDeviceProvider, { device: "desktop", children: h(RenderNode, { node, ctx: c }) }));
const machines = (n: number) => ({ kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, { key: "cpu", label: "CPU", type: "number" }], rows: Array.from({ length: n }, (_, i) => ({ name: `m${i + 1}`, cpu: 10 + i })) }) as ShapedData & { kind: "table"; rows: Record<string, unknown>[] };

describe("item 1: what a roulette takes as a child (A11.4)", () => {
  it("slots mode takes widgets at the end up to 50, then refuses with a sentence", () => {
    expect(rouletteDropRule(roul({ mode: "slots" }))).toEqual({ accepts: true, mode: "slots", index: 0 });
    expect(rouletteDropRule(roul({ mode: "slots" }, slots(3)))).toEqual({ accepts: true, mode: "slots", index: 3 });
    expect(rouletteDropRule(roul({}, slots(49)))).toMatchObject({ accepts: true, index: 49 });
    expect(rouletteDropRule(roul({ mode: "slots" }, slots(50)))).toEqual({ accepts: false, reason: ROULETTE_FULL });
    // A slot moved inside it (a reorder) is always taken.
    expect(rouletteDropRule(roul({ mode: "slots" }, slots(50)), slots(50)[4]!.id)).toMatchObject({ accepts: true });
  });
  it("repeat mode takes exactly one template; a second is refused with a sentence; never itself", () => {
    expect(rouletteDropRule(roul({ mode: "repeat" }))).toEqual({ accepts: true, mode: "repeat", index: 0 });
    expect(rouletteDropRule(roul({ mode: "repeat" }, [stat()]))).toEqual({ accepts: false, reason: ROULETTE_TEMPLATE_TAKEN });
    expect(rouletteDropRule(roul({ mode: "repeat" }, [stat()]), STAT)).toMatchObject({ accepts: true });
    expect(rouletteDropRule(roul({ mode: "slots" }), "c_r2roulxaaa")).toEqual({ accepts: false, reason: ROULETTE_NOT_ITSELF });
    expect(ROULETTE_TEMPLATE_TAKEN).toMatch(/one widget/);
  });
  it("validation: children are accepted; a 51st slot is an error (the draft refuses it); a second template in repeat mode is named as a warning", () => {
    const errors = (n: ComponentNode) => validateNodes(doc(n)).filter((p) => p.severity === "error");
    expect(errors(roul({ mode: "slots" }, slots(2)))).toEqual([]);
    expect(errors(roul({ mode: "slots" }, slots(50)))).toEqual([]);
    expect(errors(roul({ mode: "repeat", items: { $bind: "{{ machines.rows }}" } }, [stat()]))).toEqual([]);
    const two = validateNodes(doc(roul({ mode: "repeat", items: [] }, [stat(), stat("c_r2stat2aaa")])));
    expect(two.filter((p) => p.severity === "error")).toEqual([]);
    expect(two.filter((p) => p.code === "roulette.template").map((p) => [p.severity, p.message])).toEqual([["warning", ROULETTE_TEMPLATE_TAKEN]]);
    expect(errors(roul({ mode: "slots" }, slots(51))).map((p) => p.code)).toEqual(["roulette.children"]);
    // No slot inside a roulette is needed or wanted: its children stack, they have no grid slot.
    expect(META.roulette.container).toBe(true);
  });
  it("every roulette root is a drop zone with its answer in the DOM; the empty one draws the drop target", () => {
    const empty = render(roul({ mode: "slots" }), ctx({}, "edit"));
    expect(empty).toContain('data-drop-zone="roulette"');
    expect(empty).toContain('data-drop-node="c_r2roulxaaa"');
    expect(empty).toContain('data-drop-accepts="true"');
    expect(empty).toContain("data-roulette-drop");
    expect(empty).toContain("Drop widgets here, or repeat one for each row");
    expect(empty).toContain("Drop to put it here");
    const taken = render(roul({ mode: "repeat", items: machines(3).rows as never }, [stat()]), ctx({}, "edit"));
    expect(taken).toContain('data-drop-accepts="false"');
    expect(taken).toContain(`data-drop-refusal="${ROULETTE_TEMPLATE_TAKEN}"`);
    expect(css).toMatch(/\[data-node\]\[data-drop-over\] > \.atr-roulette\) \{[^}]*outline: 2px dashed/);
  });
});

describe("item 2: the repeat-mode rows field", () => {
  it("is a data field (Pick data, Write a template), not a JSON box that drops a typed template", () => {
    expect(fieldsFor("roulette").find((f) => f.key === "items")).toMatchObject({ field: { kind: "data" }, bindable: true, group: "data" });
    // The repeat's field is unchanged.
    expect(fieldsFor("repeat").find((f) => f.key === "items")?.field.kind).toBe("json");
  });
  it("says why in a sentence when what it reads is not rows, and nothing while it is right or still loading", () => {
    const src = ["machines", "cpu"];
    expect(rouletteItemsSentence({ $bind: "{{ machines.rows }}" }, machines(3).rows, src)).toBeNull();
    expect(rouletteItemsSentence({ $bind: "{{ machines }}" }, machines(3), src)).toBeNull();
    expect(rouletteItemsSentence({ $bind: "{{ machines.rows }}" }, undefined, src)).toBeNull();
    expect(rouletteItemsSentence({ $bind: "CPU in use, Every machine" }, undefined, src)).toMatch(/double braces/);
    expect(rouletteItemsSentence({ $bind: "{{ nothere.rows }}" }, undefined, src)).toMatch(/no data called nothere/);
    expect(rouletteItemsSentence({ $bind: "{{ cpu }}" }, { kind: "stat", value: 3 }, src)).toMatch(/one number, not rows/);
    expect(rouletteItemsSentence(undefined, undefined, src)).toBeNull();
  });
  it("Rows from binds the source's rows and makes a ready widget for each row", () => {
    expect(rowsTemplate("machines", machines(2) as never)).toBe("{{ machines.rows }}");
    expect(rowsTemplate("svc", { kind: "status", items: [] } as never)).toBe("{{ svc.items }}");
    const t = rowTemplateNode(machines(2) as never);
    expect(t.type).toBe("stat");
    expect(t.props).toEqual({ value: { $bind: "{{ $item.cpu }}" }, label: { $bind: "{{ $item.name }}" } });
    expect(t.slot).toBeUndefined();
  });
});

describe("items 3 and 10: one cylinder for both modes, as design Note 2 says", () => {
  it("36 degrees apart, neighbours at 60% and 0.92 scale; the radius puts faces edge to edge", () => {
    expect(ROULETTE_STEP_DEG).toBe(36);
    expect(ROULETTE_NEIGHBOUR_OPACITY).toBe(0.6);
    expect(ROULETTE_NEIGHBOUR_SCALE).toBe(0.92);
    const r = drumRadius(200);
    expect(r).toBeCloseTo(100 / Math.tan((18 * Math.PI) / 180), 5);
    // A neighbour's centre sits r * sin(36deg) from the middle, past the stage's half height: outside it at rest.
    expect(r * Math.sin((36 * Math.PI) / 180)).toBeGreaterThan(100 + 200 * 0.92 * Math.cos((36 * Math.PI) / 180) / 2 - 1);
  });
  it("a face's look follows its angle: opaque within half a step of the front (never see-through mid-turn), the neighbours' 60% and 0.92 at one step", () => {
    expect(faceLook(0)).toEqual({ opacity: 1, scale: 1 });
    expect(faceLook(-18)).toEqual({ opacity: 1, scale: 1 });
    const n = faceLook(36);
    expect(n.opacity).toBeCloseTo(0.6, 6);
    expect(n.scale).toBeCloseTo(0.92, 6);
    expect(faceLook(-72).opacity).toBeCloseTo(0.6, 6);
    const mid = faceLook(27);
    expect(mid.opacity).toBeGreaterThan(0.6);
    expect(mid.opacity).toBeLessThan(1);
  });
  it("repeat and slots modes draw the same face structure (a face on the drum, its content inside)", () => {
    const rep = render(roul({ mode: "repeat", items: machines(4).rows as never }, [stat()]), ctx({}));
    const sl = render(roul({ mode: "slots" }, slots(4)), ctx({}));
    for (const html of [rep, sl]) {
      expect(html).toContain('data-motion="turn"');
      expect(html).toContain("data-face-in");
      expect(html).toMatch(/class="atr-roulette-face"[^>]*style="transform:rotateX\(/);
    }
    expect(rep).toMatch(/data-slot="arrows"/);
  });
});

describe("items 11 and 20: wheel, swipe, dots", () => {
  it("one slot per mouse notch with no dead time: five quick notches turn five", () => {
    let acc = 0;
    let turned = 0;
    for (let i = 0; i < 5; i++) {
      const w = wheelSlots(100, acc);
      acc = w.acc;
      turned += w.slots;
    }
    expect(turned).toBe(5);
    expect(wheelSlots(-120, 0).slots).toBe(-1);
  });
  it("trackpad travel adds up, one slot per 80 px, and a change of direction starts again", () => {
    let acc = 0;
    let turned = 0;
    for (let i = 0; i < 16; i++) {
      const w = wheelSlots(10, acc);
      acc = w.acc;
      turned += w.slots;
    }
    expect(turned).toBe(Math.floor(160 / WHEEL_SLOT_PX));
    expect(wheelSlots(-10, 70)).toEqual({ slots: 0, acc: -10 });
  });
  it("a swipe of 30 px or more along its longer axis turns one slot (up or left is the next one)", () => {
    expect(swipeSlots(0, -150)).toBe(1);
    expect(swipeSlots(5, 120)).toBe(-1);
    expect(swipeSlots(-200, 10)).toBe(1);
    expect(swipeSlots(200, -10)).toBe(-1);
    expect(swipeSlots(10, 20)).toBe(0);
  });
  it("dots stay on one line or become a count", () => {
    expect(dotsFit(9, 600, true)).toBe(true);
    expect(dotsFit(9, 180, true)).toBe(false);
    expect(dotsFit(9, 390, true, 44)).toBe(false);
    expect(dotsFit(13, 2000, true)).toBe(false);
    expect(css).toMatch(/\.atr-roulette-dots \{[^}]*flex-wrap: nowrap/);
    expect(css).toMatch(/\.atr-roulette\[data-engaged\] \{[^}]*touch-action: none/);
  });
});

describe("items 12 and 13: the cut badge and the scroll kinds' cues", () => {
  it("the badge sits under the box in its cell, clear of the corner handles, never cut", () => {
    expect(BADGE_GAP_PX).toBeGreaterThanOrEqual(12);
    expect(BADGE_INSET_PX).toBeGreaterThanOrEqual(12);
    expect(css).toMatch(/\.atr-grid\[data-fixed-rows\] > \.atr-cell \{ position: relative; \}/);
    expect(css).not.toMatch(/\.atr-cut-badge \{[^}]*max-width/);
  });
  it("the engaged ring is drawn above the content by the node box, the end of an engaged list keeps the wheel, the thumb fades in 120 ms", () => {
    expect(css).toMatch(/\[data-scroll-engaged\]::after[^{]*\{[^}]*border: 1px solid var\(--theme-accent\)/);
    expect(css).toMatch(/\[data-scroll-engaged\] \[data-scroll-port\] \{ overscroll-behavior: contain; \}/);
    expect(css).toMatch(/\.atr-scroll-thumb \{[^}]*transition: opacity 120ms/);
    expect(css).toMatch(/thead th \{ position: sticky; top: 0;/);
    expect(css).toMatch(/\[data-more-below\]/);
  });
  it("a scrolling kind draws its rest cue (hidden until there is more to scroll)", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ name: `r${i}` }));
    const html = render({ id: "c_r2listxaaa", type: "list", props: { items: rows as never, labelKey: "name" } }, ctx({}));
    expect(html).toMatch(/class="atr-scroll-cue"[^>]*hidden/);
    expect(html).toContain("Click to scroll");
  });
});

describe("item 6c: copy overrides can never reach a prototype", () => {
  it("drops __proto__, constructor and prototype row keys and node ids, and Object.prototype stays clean", () => {
    const raw = JSON.parse('{"__proto__": {"c_r2statxaaa": {"props": {"label": "bad"}}}, "constructor": {"c_r2statxaaa": {"hidden": true}}, "pve1": {"__proto__": {"hidden": true}, "c_r2statxaaa": {"props": {"label": "ok"}}}}');
    const node: ComponentNode = { id: "c_r2repxaaaa", type: "repeat", props: { copyOverrides: raw }, children: [stat()] };
    const o = copyOverridesOf(node);
    expect(Object.keys(o)).toEqual(["pve1"]);
    expect(Object.keys(o.pve1!)).toEqual([STAT]);
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(({} as Record<string, unknown>).label).toBeUndefined();
    expect(({} as Record<string, unknown>).hidden).toBeUndefined();
    expect(applyCopyOverride(stat(), "pve1", o.pve1).props.label).toBe("ok");
    expect(hasCopyChange(stat(), { __proto__: {} } as never)).toBe(false);
    for (const k of UNSAFE_KEYS) expect(rowKeys([{ name: k }])).toEqual([`${k} (row)`]);
  });
  it("the schema refuses them, on repeat and roulette", () => {
    for (const t of ["repeat", "roulette"] as const) {
      const bad = JSON.parse('{"copyOverrides": {"__proto__": {"c_r2statxaaa": {"hidden": true}}}}');
      expect(propsSchemas[t].safeParse(bad).success, t).toBe(false);
      expect(propsSchemas[t].safeParse({ copyOverrides: { pve1: { prototype: { hidden: true } } } }).success, t).toBe(false);
      expect(propsSchemas[t].safeParse({ copyOverrides: { pve1: { [STAT]: { hidden: true } } } }).success, t).toBe(true);
    }
  });
});
