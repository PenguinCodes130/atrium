import { describe, expect, it } from "vitest";
import { scopeCustomCss, scopeCustomCssWithReport } from "./custom-css";

const body = (css: string) => {
  const out = scopeCustomCss(css);
  const m = /@layer atrium-custom\{\n([\s\S]*)\n\}$/.exec(out);
  return m ? m[1]! : out;
};

describe("scopeCustomCss: the three gauntlet r1 escapes", () => {
  it("E1 :root token override is dropped", () => {
    const r = scopeCustomCssWithReport(":root{--glass-thin-fill:oklch(0.6 0.25 25);--bg:oklch(0.6 0.25 25)}");
    expect(r.css).toBe("");
    expect(r.dropped.some((d) => d.kind === "selector" && d.text === ":root")).toBe(true);
  });
  it("E2 html:has() that mentions the canvas is dropped", () => {
    expect(scopeCustomCss('html:has([data-atrium-canvas]) [data-shell="sidebar"]{display:none}')).toBe("");
  });
  it("E3 canvas root position, inset and z-index are dropped on the root (round 4: the root box cannot move)", () => {
    const r = scopeCustomCssWithReport("[data-atrium-canvas]{position:fixed;inset:0;z-index:9999;color:red}");
    expect(r.css).toContain("@layer atrium-shell-guard, atrium-theme, atrium-custom;");
    expect(body("[data-atrium-canvas]{position:fixed;inset:0;z-index:9999;color:red}")).toBe("[data-atrium-canvas]{color:red}");
    expect(r.dropped.map((d) => d.text)).toEqual(["position:fixed", "inset:0", "z-index:9999"]);
  });
});

describe("scopeCustomCss: selectors", () => {
  it("prefixes every selector with the canvas", () => {
    expect(body(".card, h2 > span { color: red }")).toBe("[data-atrium-canvas] .card,[data-atrium-canvas] h2 > span{color:red}");
  });
  it("keeps hand-scoped selectors and :scope", () => {
    expect(body("[data-atrium-canvas] .a{color:red} :scope{color:blue} [data-atrium-canvas]:hover{opacity:.9}")).toBe(
      "[data-atrium-canvas] .a{color:red}\n[data-atrium-canvas]{color:blue}\n[data-atrium-canvas]:hover{opacity:.9}",
    );
  });
  it("refuses siblings of the canvas and selectors that reach outside it", () => {
    for (const sel of ["+ .x", "~ *", "[data-atrium-canvas] + *", "[data-atrium-canvas] ~ aside", "body .x", "html .x", ":host", "x:has(y)", ":is(html) a", "::backdrop", "& .x", ".a [data-atrium-canvas] .b"]) {
      expect(scopeCustomCss(`${sel}{color:red}`), sel).toBe("");
    }
  });
  it("can be limited to one page's canvas", () => {
    expect(body(".a{color:red}")).toBe("[data-atrium-canvas] .a{color:red}");
    expect(scopeCustomCss(".a{color:red}", { scope: "p1" })).toContain('[data-atrium-canvas][data-canvas-scope="p1"] .a{color:red}');
    expect(scopeCustomCss(".a{color:red}", { scope: '"]x' })).toContain("[data-atrium-canvas] .a{color:red}");
  });
});

describe("scopeCustomCss: at-rules", () => {
  it("drops @import, @font-face, @property, @layer, @scope, @namespace, @page and @charset", () => {
    const css = `@import url(x.css); @import "y.css"; @charset "utf-8"; @namespace svg url(x);
      @font-face { font-family: Inter; src: url(/uploads/a.woff2) }
      @property --bg { syntax: "<color>"; inherits: false; initial-value: red }
      @layer atrium-shell-guard { [data-atrium-canvas] { position: fixed } }
      @scope (body) { * { display: none } }
      @page { margin: 0 }`;
    const r = scopeCustomCssWithReport(css);
    expect(r.css).toBe("");
    expect(r.dropped.filter((d) => d.kind === "at-rule").length).toBe(9);
  });
  it("keeps @media, @supports and @container, scoped inside", () => {
    expect(body("@media (width < 600px) { .a { color: red } } @supports (display:grid) { .b{display:grid} }")).toBe(
      "@media (width < 600px){[data-atrium-canvas] .a{color:red}}\n@supports (display:grid){[data-atrium-canvas] .b{display:grid}}",
    );
  });
  it("renames keyframes so a shell animation cannot be replaced", () => {
    const out = body("@keyframes atrium-shimmer { from { opacity: 0 } to { opacity: 1 } } .a { animation: atrium-shimmer 1s infinite }");
    expect(out).toContain("@keyframes atrium-user-atrium-shimmer{from{opacity:0}to{opacity:1}}");
    expect(out).toContain("[data-atrium-canvas] .a{animation:atrium-user-atrium-shimmer 1s infinite}");
  });
});

describe("scopeCustomCss: declarations", () => {
  it("drops url() except this instance's /uploads/", () => {
    expect(body(".a{background:url(https://evil.example/x.png);color:red}")).toBe("[data-atrium-canvas] .a{color:red}");
    expect(body(".a{background:url(/uploads/../x)}")).toBe("");
    expect(body(".a{background:url(\"/uploads/wall.webp\") center/cover}")).toBe('[data-atrium-canvas] .a{background:url("/uploads/wall.webp") center/cover}');
    expect(body(".a{background:image-set(\"https://x/a.png\" 1x)}")).toBe("");
  });
  it("drops expression, behavior, -moz-binding, javascript:", () => {
    expect(body(".a{width:expression(alert(1));behavior:url(x.htc);-moz-binding:url(x);background:javascript:alert(1)}")).toBe("");
  });
  it("only allows --theme-* and --user-* custom properties", () => {
    expect(body(".a{--bg:red;--glass-thin-fill:red;--theme-accent:red;--user-x:1}")).toBe("[data-atrium-canvas] .a{--theme-accent:red;--user-x:1}");
  });
  it("drops escapes, angle brackets and nested rules", () => {
    expect(body(".a{color:r\\65 d}")).toBe("");
    expect(body('.a{content:"</style><script>alert(1)</script>"}')).toBe("");
    expect(body(".a{color:red; .b{color:blue} background:red}")).toBe("[data-atrium-canvas] .a{color:red;background:red}");
    expect(body(".\\61 {color:red}")).toBe("");
  });
  it("survives unbalanced and hostile input without leaking", () => {
    for (const css of ["}}} :root{--bg:red}", ".a{color:red", ".a{color:red}} body{display:none}", "/* :root{--bg:red} */", '.a{content:"}"} :root{x:y}', "@media screen { :root { --bg: red } }"]) {
      const out = scopeCustomCss(css);
      expect(out, css).not.toMatch(/:root|(^|[\s,}])body/);
      expect(out, css).not.toMatch(/<\//);
    }
  });
  it("keeps !important (the guard layer still wins)", () => {
    expect(body("[data-atrium-canvas] .x{position:absolute !important}")).toBe("[data-atrium-canvas] .x{position:absolute !important}");
  });
  it("drops view-transition and anchor properties and lists each as removed (settings r2 SFR, w2-r1 item 15)", () => {
    const r = scopeCustomCssWithReport("* { view-transition-name: cuhijack; view-transition-class: x; anchor-name: --a; position-anchor: --a; position-area: top; anchor-scope: all; color: red }");
    expect(r.css).not.toMatch(/view-transition|anchor|position-area/);
    expect(r.css).toContain("color:red");
    const removed = r.dropped.filter((d) => d.kind === "declaration").map((d) => d.text.split(":")[0]!.trim());
    for (const p of ["view-transition-name", "view-transition-class", "anchor-name", "position-anchor", "position-area", "anchor-scope"]) expect(removed, p).toContain(p);
  });
});

describe("scopeCustomCss: components gauntlet w2-r2 (Fixes 1, 2 and 9)", () => {
  const node = (css: string) => scopeCustomCssWithReport(css, { root: { kind: "node", id: "c_hostileaa" } });
  it("position keeps only static, relative, absolute and sticky: fixed through var() or env() is dropped", () => {
    for (const css of [
      "[data-slot] { position: var(--user-nope, fixed); inset: 0 }",
      "[data-slot] { --theme-cu-pos: fixed; position: var(--theme-cu-pos) }",
      "[data-slot] { position: env(nope, fixed) }",
      "[data-slot] { position: inherit }",
      "[data-slot] { position: FIXED !important }",
      "[data-slot] { position: -webkit-sticky; position: var(--x) }",
    ]) {
      const r = node(css);
      expect(r.css, css).not.toMatch(/position:(?!absolute|relative|static|sticky)/);
      expect(r.dropped.some((d) => /^position/.test(d.text)), css).toBe(true);
    }
    for (const v of ["static", "relative", "absolute", "sticky", "revert-layer", "absolute !important"]) expect(node(`[data-slot] { position: ${v} }`).css, v).toContain(`position:${v}`);
  });
  it("the root cannot drop its own box: display: contents, and display through var() or env()", () => {
    for (const css of [":scope { display: contents }", ":scope { display: contents !important }", ":scope { display: var(--user-d, contents) }", ":scope:not(.x) { display: env(x, contents) }", "@media (min-width: 1px) { :scope { display: contents } }"]) {
      const r = node(css);
      expect(r.css, css).not.toContain("display");
      expect(r.dropped.some((d) => /root keeps its own box/.test(d.reason)), css).toBe(true);
    }
    // A descendant may use contents; the root may use a real display.
    expect(node("[data-slot] { display: contents }").css).toContain("display:contents");
    expect(node(":scope { display: grid }").css).toContain("display:grid");
  });
  it("a node root cannot stretch its row: height, min-height, block-size and padding are capped", () => {
    const r = node(":scope { height: 4000px; min-height: 4000px; block-size: 90vh; min-block-size: var(--user-h, 3000px); padding-bottom: 3000px; padding: 0 0 80px; color: red }");
    expect(r.css).toContain("color:red");
    for (const p of ["height", "min-height", "block-size", "min-block-size", "padding-bottom", "padding"]) expect(r.dropped.map((d) => d.text.split(":")[0]!.trim()), p).toContain(p);
    expect(node(":scope { height: 100%; min-height: auto; padding: 12px 16px; padding-top: 2rem }").dropped).toEqual([]);
    // Theme and chrome roots keep sizing their canvas and frame.
    expect(scopeCustomCss(":scope { min-height: 100vh; padding: 120px }")).toContain("min-height:100vh");
  });
  it("interactivity, user-modify and timeline names are dropped and listed", () => {
    const r = node("[data-slot] { interactivity: inert; -webkit-user-modify: read-write; user-modify: read-write; timeline-scope: --t; scroll-timeline: --t y; scroll-timeline-name: --t; view-timeline-name: --v; view-timeline: --v; color: red }");
    expect(r.css).toContain("color:red");
    expect(r.dropped.map((d) => d.text.split(":")[0]!.trim()).sort()).toEqual(["-webkit-user-modify", "interactivity", "scroll-timeline", "scroll-timeline-name", "timeline-scope", "user-modify", "view-timeline", "view-timeline-name"]);
  });
  it("the 24 hostile node CSS variants of the round 2 customisation probe keep nothing that escapes the root", () => {
    const BIG = "position:absolute;inset:-2000px;background:rgba(255,0,0,.6);z-index:2147483647;";
    const variants = [
      ":scope { position: fixed; inset: 0; box-shadow: 0 0 0 3000px red; } * { position: absolute; top: -2000px; width: 6000px; height: 6000px }",
      `:scope { display: contents !important; } * { ${BIG} }`,
      ":scope { display: contents; } [data-slot] { position: absolute; inset: -3000px; }",
      "[data-slot] { --theme-cu-pos: fixed; position: var(--theme-cu-pos); inset: 0 }",
      "[data-slot] { position: var(--user-nope, fixed); inset: 0 }",
      ":scope { height: 4000px; min-height: 4000px }",
      ":scope { padding-bottom: 3000px }",
      ":scope { transform: scale(30) } :scope:not(.zz) { scale: 30; z-index: 99; box-shadow: 0 0 0 3000px red }",
    ];
    for (const css of variants) {
      const out = node(css).css;
      expect(out, css).not.toMatch(/position:(fixed|var|env|inherit)/);
      expect(out, css).not.toMatch(/\[data-node="c_hostileaa"\]\{[^}]*(display:contents|height:4000|padding-bottom:3000|transform|scale|box-shadow)/);
    }
  });
});

describe("scopeCustomCss: components final pass (gauntlet w2-r3 items 1 to 3)", () => {
  const node = (css: string) => scopeCustomCssWithReport(css, { root: { kind: "node", id: "c_hostile" } });
  it("node CSS cannot write --theme-* anywhere; --user-* stays; theme CSS still may", () => {
    const r = node(":scope { --theme-shadow: 0 0 0 3000px red; --user-x: 1px } [data-slot] { --theme-accent: red, 0 0 0 3000px red }");
    expect(r.css).not.toMatch(/--theme-[a-z-]+:/);
    expect(r.css).toContain("--user-x:1px");
    expect(r.dropped.filter((d) => /--theme-\* tokens/.test(d.reason))).toHaveLength(2);
    expect(scopeCustomCss(":scope { --theme-accent: red }")).toContain("--theme-accent:red");
  });
  it("drops + and ~ after the root compound, in any wrapper and on every root kind", () => {
    const forms = [":scope:not(.zz) ~ *", ":scope:is(*) + *", ":scope:where(.atr-node) ~ .atr-node [data-slot]", ":scope.a~*", ':scope[title="a ~ b"] ~ *', ":scope:not(.a, .b) + .c", ":SCOPE:NOT(.x) ~ *"];
    for (const f of forms) {
      for (const root of [{ kind: "node", id: "c_hostile" }, { kind: "frame", id: "f1" }, { kind: "canvas" }] as const) {
        const r = scopeCustomCssWithReport(`${f} { opacity: 0 } @media (min-width: 1px) { ${f} { opacity: 0 } } @supports (display: block) { @container (min-width: 0px) { ${f} { opacity: 0 } } }`, { root });
        expect(r.css, `${f} on ${root.kind}`).toBe("");
        expect(r.dropped.filter((d) => /sibling selectors/.test(d.reason)).length, f).toBe(3);
      }
    }
    const canvas = scopeCustomCssWithReport("[data-atrium-canvas]:not(.x) ~ * { display: none }");
    expect(canvas.css).toBe("");
  });
  it("keeps sibling selectors inside the root", () => {
    const r = node(":scope .a ~ .b { color: red } :scope > i + b { color: red } :scope:is(.p ~ .q) { color: red }");
    expect(r.css).toContain('[data-node="c_hostile"] .a ~ .b{color:red}');
    expect(r.css).toContain('[data-node="c_hostile"] > i + b{color:red}');
    expect(r.css).toContain('[data-node="c_hostile"]:is(.p ~ .q){color:red}');
    expect(r.dropped).toEqual([]);
  });
  it("node roots take no border widths; parts and the frame root keep theirs", () => {
    const r = node(":scope { border-bottom: 3000px solid red; border-width: 0 0 9px; -webkit-border-after: 900px solid; border-radius: 8px; border-color: red } [data-slot] { border: 2px solid }");
    expect(r.css).not.toMatch(/border-bottom|border-width|border-after/);
    expect(r.css).toContain("border-radius:8px");
    expect(r.css).toContain("border:2px solid");
    expect(r.dropped.filter((d) => /borders on :scope/.test(d.reason))).toHaveLength(3);
    expect(scopeCustomCss(":scope { border-bottom: 2px solid }", { root: { kind: "frame", id: "f1" } })).toContain("border-bottom:2px solid");
  });
});
