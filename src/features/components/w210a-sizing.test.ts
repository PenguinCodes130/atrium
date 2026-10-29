// Wave 2.10a (operator try-out spec B1, B2 CSS half, B8; architecture A11.2): every built-in def declares
// its sizing; a kept-height group reflows; only scrolling kinds scroll in an exact box; the viewer grows
// fit rows; an inserted icon fills a box that hugs it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentNode, RenderContext } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));

const { componentDefs, getComponentDef } = await import("./catalogue/defs");
const { SIZING, sizingOf, META } = await import("./catalogue/meta");
const { propsSchemas } = await import("./catalogue/schemas");
const { hugSlot, ICON_HUG_PX, newNode, NEW_SIZE } = await import("./insert");
const { RenderNode } = await import("./render/render-node");
const { RenderDeviceProvider } = await import("./render/context");

const css = readFileSync(path.join(__dirname, "components.css"), "utf8");
function ctx(mode: RenderContext["mode"]): RenderContext {
  return {
    mode, principal: { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_aaaaaaaaaa", version: "draft",
    values: { $data: {}, $sources: {}, $page: { id: "p_aaaaaaaaaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: "user" } } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const render = (node: ComponentNode, c: RenderContext) => renderToStaticMarkup(h(RenderDeviceProvider, { device: "desktop", children: h(RenderNode, { node, ctx: c }) }));

describe("A11.2 sizing on every built-in def", () => {
  it("every def declares one of fit, scale, reflow or scroll, as A11.2 lists them", () => {
    for (const d of componentDefs()) expect(["fit", "scale", "reflow", "scroll"], d.type).toContain(d.sizing);
    expect(Object.keys(SIZING).sort()).toEqual(Object.keys(META).sort());
    const want: Record<string, string[]> = {
      fit: ["stat", "status", "gauge", "progress", "service-tile", "group", "resource-bar", "bookmarks", "heading", "text", "link", "clock", "button", "toggle", "slider", "select", "card", "section", "stack"],
      scale: ["icon", "image", "video", "divider", "spacer", "chart"],
      scroll: ["table", "list", "repeat"],
    };
    for (const [k, types] of Object.entries(want)) for (const t of types) expect(getComponentDef(t as never)?.sizing, t).toBe(k);
  });
  it("only table, list and repeat are scrolling kinds", () => {
    expect(componentDefs().filter((d) => d.sizing === "scroll").map((d) => d.type).sort()).toEqual(["list", "repeat", "table"]);
  });
  it("a group that keeps its height reflows; packages and unknown types are fit", () => {
    expect(sizingOf({ type: "group", props: {} })).toBe("fit");
    expect(sizingOf({ type: "group", props: { fixedHeight: true } })).toBe("reflow");
    expect(sizingOf({ type: "pkg:x/y" as never, props: {} })).toBe("fit");
    expect(sizingOf({ type: "lib:abc" as never, props: {} })).toBe("fit");
  });
  it("the new props validate: group fixedHeight and icon fill are booleans", () => {
    expect(propsSchemas.group.safeParse({ title: "G", fixedHeight: true }).success).toBe(true);
    expect(propsSchemas.group.safeParse({ fixedHeight: "yes" }).success).toBe(false);
    expect(propsSchemas.icon.safeParse({ name: "server", fill: true, size: 24 }).success).toBe(true);
  });
});

describe("B2 CSS half: no root that is not a scrolling kind scrolls", () => {
  it("the exact-box rule clips (never auto) for every root, and only data-sizing=scroll gets overflow auto", () => {
    expect(css).toMatch(/\.atr-grid\[data-fixed-rows\] > \.atr-cell > \.atr-node > \[data-slot="root"\] \{ min-height: 0; overflow: clip;/);
    expect(css).toMatch(/\.atr-grid\[data-fixed-rows\] > \.atr-cell > \.atr-node\[data-sizing="scroll"\] > \[data-slot="root"\] \{ overflow: auto; \}/);
    const autos = [...css.matchAll(/([^{}]+)\{[^}]*overflow(?:-[xy])?: (?:auto|scroll)[^}]*\}/g)].map((m) => m[1]!.trim());
    for (const sel of autos) expect(sel, sel).toMatch(/data-sizing="scroll"|atr-table-wrap/);
  });
  it("the clip margin is the largest shadow offset plus 4px, 16px (A11.2), as a plain length", () => {
    expect(css).toContain('[data-slot="root"] { min-height: 0; overflow: clip; overflow-clip-margin: 16px; }');
    expect(css).toMatch(/\[data-node-styled\][^{]*\{\s*overflow-clip-margin: 12px !important;/);
  });
  it("each node box and cell names its sizing; the viewer's exact grid grows rows, the builder's does not", () => {
    const grid: ComponentNode = { id: "c_gridaaaaaa", type: "grid", props: {}, children: [
      { id: "c_groupaaaaa", type: "group", props: { title: "G" }, slot: { x: 0, y: 0, w: 12, h: 10 }, children: [] },
      { id: "c_tableaaaaa", type: "table", props: {}, slot: { x: 0, y: 10, w: 6, h: 10 } },
      { id: "c_keptaaaaaa", type: "group", props: { title: "K", fixedHeight: true }, slot: { x: 6, y: 10, w: 6, h: 10 }, children: [{ id: "c_tileaaaaaa", type: "service-tile", props: { name: "A" } }] },
    ] };
    const view = render(grid, ctx("view"));
    expect(view).toContain("data-grow-rows");
    expect(view).toContain("grid-auto-rows:minmax(8px, auto)");
    expect(view).toMatch(/data-cell="c_tableaaaaa"[^>]*data-sizing="scroll"/);
    expect(view).toMatch(/data-cell="c_keptaaaaaa"[^>]*data-sizing="reflow"/);
    expect(view).toMatch(/data-node="c_groupaaaaa" data-type="group" data-sizing="fit"/);
    const edit = render(grid, ctx("edit"));
    expect(edit).not.toContain("data-grow-rows");
    expect(edit).toContain("grid-auto-rows:8px");
    expect(css).toMatch(/\.atr-grid\[data-grow-rows\] > \.atr-cell:is\(\[data-sizing="scroll"\], \[data-sizing="reflow"\]\) \{ contain: size; \}/);
  });
  it("a node with its own CSS holds its drawn box in the viewer (containment), and says so on its node box", () => {
    expect(css).toContain(".atr-grid[data-grow-rows] > .atr-cell:has(> [data-node-has-css]) { contain: size; }");
    const m = render({ id: "c_cssnodeaaa", type: "stat", props: { label: "x", value: 1 }, css: "[data-slot=root] { color: red; }" } as ComponentNode, ctx("view"));
    expect(m).toContain("data-node-has-css");
  });
  it("tabs wrap their tab strip instead of scrolling it", () => {
    expect(css).toMatch(/\.atr-tablist \{[^}]*flex-wrap: wrap;/);
  });
});

describe("B8: an icon hugs on insert and scales with its box", () => {
  it("a new icon fills a box of at most 2 columns, about square on the 1280px builder", () => {
    const n = newNode("icon");
    expect(n.props.fill).toBe(true);
    expect(n.slot!.w).toBeLessThanOrEqual(2);
    expect(NEW_SIZE.icon!.slot).toEqual({ w: 1.375, h: 10 });
    // The 1280px builder in the default theme: columns 28.66px, gap 24px, a 6px hard shadow under each cell.
    const colPx = 28.66, gap = 24, padBottom = 30;
    const widthPx = n.slot!.w * (colPx + gap) - gap;
    const heightPx = n.slot!.h * 8 - padBottom;
    expect(Math.abs(widthPx - heightPx)).toBeLessThanOrEqual(8);
  });
  it("hugSlot gives a square box for a measured canvas, in eighths of a column, at most 2 columns", () => {
    for (const g of [{ colPx: 28.66, gapPx: 24, padBottomPx: 30 }, { colPx: 36, gapPx: 16, padBottomPx: 16 }, { colPx: 80, gapPx: 16, padBottomPx: 16 }]) {
      const s = hugSlot(ICON_HUG_PX, g);
      expect(s.w * 8).toBe(Math.round(s.w * 8));
      expect(s.w).toBeLessThanOrEqual(2);
      const w = s.w * (g.colPx + g.gapPx) - g.gapPx;
      const hh = s.h * 8 - g.padBottomPx;
      expect(Math.abs(w - hh), JSON.stringify({ g, s, w, hh })).toBeLessThanOrEqual(8);
    }
  });
  it("a filling icon marks itself and its svg is sized by CSS from the box; a px icon keeps its px", () => {
    const fill = render({ id: "c_iconaaaaaa", type: "icon", props: { name: "server", size: 24, fill: true } }, ctx("view"));
    expect(fill).toMatch(/class="atr-icon" data-fill=""/);
    const px = render({ id: "c_iconbbbbbb", type: "icon", props: { name: "server", size: 40 } }, ctx("view"));
    expect(px).not.toContain("data-fill");
    expect(px).toContain('width="40"');
    expect(css).toMatch(/\.atr-icon\[data-fill\] > svg \{ width: calc\(min\(100cqw, 100cqh\) \* 0\.5\);/);
  });
});

describe("B1: a group never scrolls", () => {
  it("a group's root has no overflow of its own and draws every child when it fits", () => {
    const kids = Array.from({ length: 8 }, (_, i): ComponentNode => ({ id: `c_tile${"abcdefgh"[i]}aaaaa`, type: "service-tile", props: { name: `T${i}` } }));
    const m = render({ id: "c_groupaaaaa", type: "group", props: { title: "G", columns: 4 }, children: kids }, ctx("view"));
    expect((m.match(/data-group-item=/g) ?? []).length).toBe(8);
    expect(m).not.toContain("data-group-more");
    expect(css).not.toMatch(/\.atr-group[^{]*\{[^}]*overflow/);
  });
});
