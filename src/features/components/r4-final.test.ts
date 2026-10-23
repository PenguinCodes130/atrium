// Final pass (operator decision 2026-10-19 after gauntlet w2-r3: a narrow scope cut) adversarial unit
// checks: node CSS cannot write --theme-* (item 1), cannot reach siblings through :scope in any wrapper
// (item 2), cannot put a border on the node box, and layouts take the Style panel only with bounded sizes
// (item 3). The guard layer holds the same lines on its own. Item 4 (canvas word gaps) is a CSS check.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentType } from "@/core/contracts";

const { compileNodeCss } = await import("./style/server");
const { compileStyle, layoutLimit } = await import("./style/compile");
const { enforceNodeCssPolicy, selectorShape, isLayoutType, LAYOUT_TYPES, THEME_WRITE_REASON, SIBLING_REASON, ROOT_BORDER_REASON } = await import("./style/node-css-policy");
const { validateNodes } = await import("./validate");

const CSS = readFileSync(path.join(import.meta.dirname, "components.css"), "utf8");
const guard = CSS.slice(CSS.indexOf("@layer atrium-shell-guard {"), CSS.indexOf("@layer atrium-theme {"));
const ID = "c_r4hostilea";
const M = `[data-node="${ID}"]`;
const compile = (css: string, type = "stat") => compileNodeCss({ id: ID, type: type as ComponentType, css });

/** Every selector of every style rule in a compiled node CSS (inside @layer, @media, @supports, @container). */
function selectors(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/(?:^|[{}\n])\s*([^{}@]+)\{[^{}]*\}/g)) for (const s of m[1]!.split(",")) out.push(s.trim());
  return out;
}

describe("item 1: node CSS cannot write --theme-* (the --theme-shadow paint escape)", () => {
  const escapes = [
    ":scope { --theme-shadow: 0 0 0 3000px rgba(255,0,0,.6); }",
    ":scope { --theme-shadow: -700px -300px 0 400px rgba(255,0,0,.85); --theme-radius: 0px; }",
    ":scope:not(.zz) { --theme-shadow: 0 0 0 3000px red }",
    "@media (min-width: 1px) { :scope { --theme-shadow: 0 0 0 3000px red } }",
    "@supports (display: block) { :scope { --theme-shadow: 0 0 0 3000px red } }",
    "@container (min-width: 0px) { :scope { --THEME-SHADOW: 0 0 0 3000px red } }",
    ":scope { --theme-accent: red, 0 0 0 3000px red; --theme-surface-text: red, 0 0 0 3000px red }",
    "[data-slot] { --theme-shadow: 0 0 0 3000px red; --theme-line: red }",
    ":scope { --theme-shadow : 0 0 0 3000px red !important }",
  ];
  for (const css of escapes)
    it(`removes and lists: ${css.slice(0, 60)}`, () => {
      const r = compile(css);
      expect(r.css.toLowerCase()).not.toMatch(/--theme-[a-z-]+\s*:/);
      expect(r.css).not.toContain("3000px");
      expect(r.removed.some((x) => x.includes(THEME_WRITE_REASON))).toBe(true);
    });
  it("keeps --user-* writes and reading theme tokens", () => {
    const r = compile("[data-slot] { --user-gap: 4px; color: var(--theme-accent); margin-top: var(--user-gap) }");
    expect(r.css).toContain("--user-gap:4px");
    expect(r.css).toContain("color:var(--theme-accent)");
    expect(r.removed).toEqual([]);
  });
  it("a Style panel node-box shadow in a theme colour cannot be widened through the token", () => {
    const r = compileNodeCss({ id: ID, type: "stat", overrideTheme: true, style: { root: { boxShadow: "0 4px 8px token:accent" } }, css: ":scope { --theme-accent: red, 0 0 0 3000px red }" });
    expect(r.css).toContain("box-shadow:0 4px 8px var(--theme-accent)");
    expect(r.css).not.toMatch(/--theme-accent\s*:/);
  });
  it("the node-box rule reads --atr-node-shadow (resolved above the nodes), never --theme-shadow", () => {
    const rule = /\.atr-node\[data-node-styled\]:not\(\.atr-card \.atr-node\):has\([^)]*\) \{([^}]*)\}/.exec(CSS)![1]!;
    expect(rule).toContain("var(--atr-node-shadow, none)");
    expect(rule).not.toContain("--theme-");
    expect(CSS).toMatch(/:is\(\[data-atrium-canvas\], \.atr-render-root\) \{ --atr-node-shadow: var\(--theme-shadow, none\); --atr-node-radius: var\(--theme-radius, 0px\); \}/);
  });
  it("the guard pins every token the node box paints with to the parent's value", () => {
    for (const t of ["--atr-node-shadow", "--atr-node-radius", "--theme-shadow", "--theme-radius", "--theme-surface", "--theme-surface-text", "--theme-surface-muted", "--theme-canvas-text", "--theme-accent", "--theme-accent-text", "--theme-ok", "--theme-warn", "--theme-bad", "--theme-info", "--theme-line"])
      expect(guard).toContain(`${t}: inherit !important;`);
  });
});

describe("item 2: no sibling selectors after :scope, in any wrapper", () => {
  const forms = [
    ":scope:not(.zz) ~ * { opacity: .05; translate: 0 -2000px; scale: 3; filter: blur(8px); }",
    ":scope:is(*) + * { visibility: hidden; }",
    ":scope:where(.atr-node) ~ .atr-node [data-slot] { color: red; background: red; }",
    ":scope:not(.zz) ~ * { pointer-events: none; } :scope:not(.zz) ~ * [data-slot] { pointer-events: none; }",
    ":scope.foo~* { opacity: 0 }",
    ":scope[data-type] + .atr-cell { opacity: 0 }",
    ':scope[title="a ~ b"] ~ * { opacity: 0 }',
    ":scope:not(.a, .b) + .c { opacity: 0 }",
    ":scope:nth-child(1)~* { opacity: 0 }",
    ":SCOPE:NOT(.x) ~ * { opacity: 0 }",
    ":scope:is(:not(.a)) ~ * { opacity: 0 }",
    "@media (min-width: 1px) { :scope:is(*) ~ * { opacity: 0 } }",
    "@supports (display: block) { :scope:not(.q) + * { opacity: 0 } }",
    "@container (min-width: 0px) { :scope:where(*) ~ * { opacity: 0 } }",
    "@media (min-width: 1px) { @supports (display: block) { :scope:is(*) ~ * { opacity: 0 } } }",
    "@layer x { :scope:is(*) ~ * { opacity: 0 } }",
    "@scope (.atr-render-root) { :scope ~ * { opacity: 0 } }",
    ":scope { & ~ * { opacity: 0 } }",
    ":scope:has(+ *) { opacity: 0 }",
    ":is(:scope) ~ * { opacity: 0 }",
    ":where(:scope:not(.x)) + * { opacity: 0 }",
    ".x, :scope:not(.y) ~ * { opacity: 0 }",
  ];
  for (const css of forms)
    it(`nothing reaches a sibling: ${css.slice(0, 70)}`, () => {
      const r = compile(css);
      for (const sel of selectors(r.css)) expect(selectorShape(sel, M).sibling, sel).toBe(false);
      // Whatever was kept is inside the node: every kept selector starts at the node root.
      for (const sel of selectors(r.css).filter((s) => s.startsWith("[data-node"))) expect(sel.startsWith(M)).toBe(true);
      expect(r.removed.length).toBeGreaterThan(0);
    });
  it("lists the reason with the selector as written", () => {
    const r = compile(":scope:not(.zz) ~ * { opacity: .05 }");
    // Listed by this policy, or (with the scoper SFR applied) already by the shared sanitiser.
    expect(r.removed.includes(`:scope:not(.zz) ~ *: ${SIBLING_REASON}`) || r.removed.some((x) => x.startsWith(":scope:not(.zz) ~ *: sibling selectors"))).toBe(true);
    expect(r.css).toBe("");
  });
  it("keeps sibling selectors that sit inside the node", () => {
    const r = compile(":scope .a ~ .b { color: red } :scope > [data-slot] + [data-slot] { color: blue } [data-slot] ~ [data-slot] { color: green }");
    expect(r.css).toContain(`${M} .a ~ .b{color:red}`);
    expect(r.css).toContain(`${M} > [data-slot] + [data-slot]{color:blue}`);
    expect(r.css).toContain(`${M} [data-slot] ~ [data-slot]{color:green}`);
    expect(r.removed).toEqual([]);
  });
  it("selectorShape reads the root compound only", () => {
    expect(selectorShape(`${M}:not(.zz) ~ *`, M)).toEqual({ root: false, sibling: true });
    expect(selectorShape(`${M}:is(.a ~ .b)`, M)).toEqual({ root: true, sibling: false });
    expect(selectorShape(`${M} .a ~ .b`, M)).toEqual({ root: false, sibling: false });
    expect(selectorShape(`${M}::after`, M)).toEqual({ root: false, sibling: false });
    expect(selectorShape(`${M}:not(.x)>*~*`, M)).toEqual({ root: false, sibling: false });
    expect(selectorShape(`${M}[a="x + y"]+*`, M)).toEqual({ root: false, sibling: true });
  });
});

describe("item 3: runaway heights", () => {
  it("drops borders on the node box, with the reason, and keeps them on parts", () => {
    for (const css of [":scope { border-bottom: 3000px solid red }", ":scope { box-sizing: content-box; border-bottom: 5000px solid red }", ":scope { border: 40px solid }", ":scope { border-block-end-width: 900px; border-style: solid }", ":scope:not(.x) { border-width: 0 0 3000px }", "@media (min-width:1px) { :scope { border-top: 3000px solid } }", ":scope { -webkit-border-after: 3000px solid red }"]) {
      const r = compile(css);
      expect(r.css, css).not.toMatch(/border(-[a-z-]+)?(-width)?:\s*[^;}]*\d{3,}px/);
      expect(r.removed.some((x) => x.includes(ROOT_BORDER_REASON) || x.includes("not allowed")), css).toBe(true);
    }
    const ok = compile(':scope { border-radius: 8px } [data-slot="root"] { border: 2px solid red }');
    expect(ok.css).toContain("border-radius:8px");
    expect(ok.css).toContain("border:2px solid red");
    expect(ok.removed).toEqual([]);
  });
  it("the guard pins box sizing and border widths on every node box, and caps a styled HTML block", () => {
    expect(guard).toContain("box-sizing: border-box !important;");
    expect(guard).toContain("border-width: 0 !important;");
    expect(guard).toMatch(/\[data-type="html"\] \{\s*max-height: max\(150vh, 4200px\) !important;/);
  });
  it("layouts take no node CSS: saved CSS is ignored and listed; the Style panel still applies", () => {
    expect([...LAYOUT_TYPES].sort()).toEqual(["grid", "repeat", "section", "stack", "tabs"]);
    for (const type of LAYOUT_TYPES) {
      const r = compileNodeCss({ id: ID, type: type as ComponentType, css: ':scope::after { content: ""; display: block; height: 20000px } .atr-section-body { min-height: 20000px }' });
      expect(r.css, type).toBe("");
      expect(r.removed.join(" "), type).toMatch(/ignored/);
    }
    const styled = compileNodeCss({ id: ID, type: "section", overrideTheme: true, style: { root: { background: "#ffffff", padding: "24px" } }, css: ":scope { color: red }" });
    expect(styled.css).toContain("background:#ffffff");
    expect(styled.css).not.toContain("color:red");
    expect(isLayoutType("card")).toBe(false);
    expect(compile(":scope { color: red }", "card").css).toContain("color:red");
  });
  it("a layout's Style panel sizes are bounded; other components are unchanged (the guard caps them)", () => {
    const big = { root: { minHeight: "20000px", height: "9000px", padding: "4000px", margin: "0 0 3000px", gap: "2000px", borderWidth: "900px", fontSize: "800px", lineHeight: "5000px" } };
    const lay = compileStyle(big as never, { slots: ["root"], layout: true });
    expect(lay.css).toBe("");
    expect(lay.refused.map((r) => r.prop).sort()).toEqual(["borderWidth", "fontSize", "gap", "height", "lineHeight", "margin", "minHeight", "padding"]);
    expect(lay.refused[0]!.reason).toMatch(/on a layout/);
    const fine = compileStyle({ root: { minHeight: "1200px", height: "150vh", padding: "24px 32px", margin: "8px", gap: "1rem", borderWidth: "2px", fontSize: "48px", lineHeight: 1.4, border: "1px solid color-mix(in oklab, red 50%, white)" } } as never, { slots: ["root"], layout: true });
    expect(fine.refused).toEqual([]);
    expect(compileStyle(big as never, { slots: ["root"] }).refused).toEqual([]);
    expect(layoutLimit("padding", "10%")).toBeNull();
    expect(layoutLimit("padding", "50%")).toMatch(/at most 160px/);
    expect(layoutLimit("minHeight", "151vh")).toMatch(/at most 1200px/);
    expect(layoutLimit("lineHeight", "8")).toMatch(/at most 4/);
  });
  it("validate warns about CSS saved on a layout", () => {
    const doc = { dataSources: [], controls: [], pages: [{ id: "p_aaaaaaaaaa", slug: "home", title: "Home", root: { id: "c_rootaaaaaa", type: "grid", props: {}, css: ":scope { color: red }", children: [] } }], chrome: {}, theme: { themeId: "control-room" } } as unknown as AppDocument;
    const problems = validateNodes(doc);
    expect(problems.some((p) => p.code === "css.layout_ignored" && p.severity === "warning")).toBe(true);
  });
});

describe("the policy pass itself", () => {
  it("only removes; everything else in the sanitiser's output is kept (strings with ; and braces included)", () => {
    const css = `@layer atrium-shell-guard, atrium-theme, atrium-custom;\n@layer atrium-custom{\n${M} [data-slot="value"]{color:red;content:"a;b{c}"}\n@media (min-width:1px){${M} .x{margin:0}}\n}`;
    const removed: string[] = [];
    const flat = (x: string) => x.replace(/\n/g, "");
    expect(flat(enforceNodeCssPolicy(css, ID, removed))).toBe(flat(css));
    expect(removed).toEqual([]);
  });
  it("returns nothing when nothing of the node's own rules is left", () => {
    const removed: string[] = [];
    expect(enforceNodeCssPolicy(`@layer atrium-shell-guard, atrium-theme, atrium-custom;\n@layer atrium-custom{\n${M}{--theme-shadow:0 0 0 3000px red}\n}`, ID, removed)).toBe("");
    expect(removed).toHaveLength(1);
  });
});
