import { describe, expect, it } from "vitest";
import { compileStyle, declarations, type StyleRefusal } from "./style/compile";
import { compileNodeCss, compileDocumentCss } from "./style/server";
import { expandInstance } from "./library-instance";
import type { AppDocument } from "@/core/contracts";

const ID = "c_stylenodea";

describe("style overrides (criteria 33, 34)", () => {
  it("scopes a hover style on the value slot to that node and that state", () => {
    const { css } = compileNodeCss({ id: ID, type: "stat", overrideTheme: true, style: { value: { states: { hover: { color: "#ff0000" } } } } });
    expect(css).toContain(`[data-node="${ID}"] [data-slot="root"]:hover [data-slot="value"]{color:#ff0000}`);
    expect(css).not.toContain(`[data-node="${ID}"] [data-slot="value"]{`); // never without :hover
  });
  it("turns token colours into theme variables", () => {
    const { css } = compileStyle({ root: { background: "token:accent", color: "token:surfaceText" } }, { slots: ["root"] });
    expect(css).toContain("background:var(--theme-accent)");
    expect(css).toContain("color:var(--theme-surface-text)");
    const g = compileStyle({ root: { background: "linear-gradient(90deg, token:accent, #ffffff 80%)" } }, { slots: ["root"] });
    expect(g.css).toContain("linear-gradient(90deg, var(--theme-accent), #ffffff 80%)");
  });
  it("applies nothing while Override theme is off, but the style is kept on the node", () => {
    const node = { id: ID, type: "stat" as const, overrideTheme: false, style: { value: { color: "red" } } };
    expect(compileNodeCss(node).css).toBe("");
    expect(node.style.value.color).toBe("red");
  });
  it("refuses bad values per property, naming why", () => {
    const refusals: StyleRefusal[] = [];
    const ok = declarations({ color: "javascript:alert(1)", opacity: 2, width: "100px", backgroundImage: "url(https://example.com/x.png)", boxShadow: "0 0 10px red" }, { slot: "root" }, refusals);
    expect(ok).toEqual(["width:100px", "box-shadow:0 0 10px red"]);
    expect(refusals.map((r) => r.prop).sort()).toEqual(["backgroundImage", "color", "opacity"]);
    expect(refusals.find((r) => r.prop === "backgroundImage")!.reason).toMatch(/uploads/);
  });
  it("refuses unknown parts and states", () => {
    const { refused } = compileStyle({ nope: { color: "red" }, root: { states: { on: { color: "red" } } } }, { slots: ["root"], states: ["hover"] });
    expect(refused.map((r) => r.prop)).toEqual(["(slot)", "(state)"]);
  });
  it("puts phone styles under the page container query", () => {
    const { css } = compileStyle({ root: { padding: 20 } }, { slots: ["root"], mobile: { root: { padding: 8 } } });
    expect(css).toContain("@container atrium-page (max-width: 639.98px)");
    expect(css).toContain("padding:8px");
  });
});

describe("node CSS through the shared sanitiser (criteria 35, 36, 37)", () => {
  const evil = [
    "@import url(https://example.com/x.css);",
    ".a { background: url(https://example.com/x.png) }",
    ".b { position: fixed; top: 0 }",
    "body { color: red }",
    "+ .sib { color: red }",
    "~ .sib2 { color: red }",
    "@font-face { font-family: x; src: url(/uploads/f.woff2) }",
    "@keyframes spin { from { opacity: 0 } }",
    "html .x { color: red }",
    ":root { --x: 1 }",
  ].join("\n");
  const { css, removed } = compileNodeCss({ id: ID, type: "stat", css: evil });
  it("removes or refuses each item and lists every removal", () => {
    expect(css).not.toMatch(/@import|example\.com|position:\s*fixed|@font-face|@keyframes|:root|\bbody\b|\bhtml\b/);
    expect(css).not.toContain(".sib");
    const text = removed.join("\n");
    for (const m of ["@import", "example.com", "position: fixed", "body", "@font-face", "keyframes", ".sib", ".sib2"]) expect(text, m).toContain(m);
  });
  it("keeps url() for this instance's own uploads", () => {
    const r = compileNodeCss({ id: ID, type: "stat", css: ".w { background-image: url(/uploads/plan.png) }" });
    expect(r.css).toContain("url(/uploads/plan.png)");
    expect(r.removed).toEqual([]);
  });
  it("scopes * to the node's subtree", () => {
    const r = compileNodeCss({ id: ID, type: "stat", css: "* { color: red }" });
    expect(r.css).toContain(`[data-node="${ID}"] *{color:red}`);
    expect(r.css).not.toMatch(/(^|[\n}])\s*\*\s*\{/);
  });
  it("compiles every styled node of a document", () => {
    const doc = { pages: [{ id: "p_aaaaaaaaaa", slug: "h", title: "H", inNav: true, root: { id: "c_rootaaaaaa", type: "stack", props: {}, children: [{ id: ID, type: "stat", props: {}, css: ".v{color:red}" }, { id: "c_plainnodea", type: "stat", props: {} }] } }] } as unknown as AppDocument;
    const map = compileDocumentCss(doc);
    expect(Object.keys(map)).toEqual([ID]);
  });
  it("compiles the inner nodes of a pinned library instance from that version (Wave 2 lead wiring)", () => {
    const inst = { id: "c_instaaaaaa", type: "lib:l_aaaaaaaaaa", props: {}, libraryRef: { componentId: "l_aaaaaaaaaa", version: 2 } };
    const doc = { pages: [{ id: "p_aaaaaaaaaa", slug: "h", title: "H", inNav: true, root: { id: "c_rootaaaaaa", type: "stack", props: {}, children: [inst] } }] } as unknown as AppDocument;
    const v = (version: number, color: string) => ({ id: "l_aaaaaaaaaa", name: "Card", tags: [], version, params: [], containsCode: false, source: "local", createdBy: "u", createdAt: "", updatedAt: "", node: { id: "c_librootaa", type: "stat", props: {}, css: `.v{color:${color}}` } });
    expect(compileDocumentCss(doc)).toEqual({});
    const inner = expandInstance(inst as never, v(2, "red") as never).id;
    const map = compileDocumentCss(doc, undefined, { "l_aaaaaaaaaa@1": v(1, "blue"), "l_aaaaaaaaaa@2": v(2, "red") } as never);
    expect(Object.keys(map)).toEqual([inner]);
    expect(map[inner]).toContain("color:red");
    expect(map[inner]).not.toContain("blue");
  });
});
