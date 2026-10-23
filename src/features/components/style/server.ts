// Server side of node styling (architecture v3 sections 4.6 and 13, amendment A4.2): style overrides
// and node CSS go through app-shell's one CSS sanitiser, scoped to the node. SERVER ONLY.
import "server-only";
import type { AppDocument, ChromeDef, ComponentNode, LibraryComponent } from "@/core/contracts";
import { scopeCustomCssWithReport, type ScopedCss } from "@/features/shell/server";
import { metaFor } from "../catalogue/meta";
import { compileStyle, NODE_BOX, refusalText } from "./compile";
import { expandInstance } from "../library-instance";
import { enforceNodeCssPolicy, isLayoutType, LAYOUT_CSS_IGNORED } from "./node-css-policy";

export type NodeCss = { css: ScopedCss | ""; removed: string[] };

/** Node CSS may not declare global at-rules; @keyframes are removed here before the shared sanitiser runs. */
function dropGlobalAtRules(css: string, removed: string[]): string {
  let out = "";
  let i = 0;
  const re = /@(-webkit-)?keyframes\b[^{]*\{/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    out += css.slice(i, m.index);
    let depth = 1, j = m.index + m[0].length;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    removed.push(`${m[0].replace(/\s*\{$/, "").trim()}: keyframes come from the theme, not node CSS`);
    i = j;
    re.lastIndex = j;
  }
  return out + css.slice(i);
}

function describeDrop(d: { text: string; reason: string }): string {
  return `${d.text}: ${d.reason}`;
}

/**
 * The scoped CSS for one node: its style override (only while "Override theme" is on) and its CSS box.
 * Final pass (operator decision after gauntlet w2-r3): layout nodes take the Style panel only (saved CSS on
 * one is ignored and listed), and the node CSS policy removes `--theme-*` writes, sibling selectors after
 * `:scope` and borders on the node box (style/node-css-policy.ts), each listed with its reason.
 */
export function compileNodeCss(node: Pick<ComponentNode, "id" | "type" | "style" | "css" | "overrideTheme" | "responsive">): NodeCss {
  const removed: string[] = [];
  const meta = metaFor(node.type);
  const layout = isLayoutType(node.type);
  let src = "";
  let box = "";
  if (node.overrideTheme && (node.style || node.responsive?.mobile?.style)) {
    const { css, refused, nodeBox } = compileStyle(node.style, { slots: meta?.styleSlots ?? ["root"], states: meta?.states, mobile: node.responsive?.mobile?.style, nodeBox: true, layout });
    for (const r of refused) removed.push(refusalText(r));
    src += css;
    box = nodeBoxCss(nodeBox, node.id);
  }
  if (node.css && node.css.trim() && layout) removed.push(`CSS for this component: ${LAYOUT_CSS_IGNORED}`);
  else if (node.css) src += `\n${dropGlobalAtRules(node.css, removed)}`;
  if (!src.trim() && !box) return { css: "", removed };
  const scoped = src.trim() ? scopeCustomCssWithReport(src, { root: { kind: "node", id: node.id } }) : { css: "" as ScopedCss, dropped: [] };
  for (const d of scoped.dropped) removed.push(describeDrop(d));
  // The policy only removes from CSS the sanitiser already produced, so the result is still ScopedCss.
  const css = enforceNodeCssPolicy(scoped.css, node.id, removed) as ScopedCss | "";
  return { css: box ? (`${css}${css ? "\n" : ""}${box}` as ScopedCss) : css, removed };
}

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Characters a checked shadow, radius or the fixed selectors can contain; anything else drops the rules. */
const BOX_SAFE = /^[A-Za-z0-9_\s#.,%()/:+\-="[\]>{};@*]*$/;

/**
 * The node-box rules from compileStyle (gauntlet w2-r2 Fix 7): the Style panel's root shadow and radius,
 * drawn by the node box so the node's clip never cuts them. They are built only from values that passed
 * compileStyle's per-property checks (lengths, theme tokens and colour functions; the shadow's reach is
 * capped at SHADOW_REACH_MAX), never from node CSS text, and they set nothing but box-shadow and
 * border-radius on this one node. Emitted into the atrium-custom layer, so the guard's pins still win.
 */
export function nodeBoxCss(rules: string, id: string): string {
  if (!rules.trim() || !NODE_ID.test(id) || !BOX_SAFE.test(rules) || /<|\\|url\(|expression|@import/i.test(rules)) return "";
  const decls = [...rules.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => m[1]!.split(";"));
  if (decls.some((d) => !/^(box-shadow|border-radius):[^:;]+$/.test(d))) return "";
  return `@layer atrium-custom{\n${rules.split(NODE_BOX).join(`[data-node="${id}"]`)}\n}`;
}

/**
 * Every styled node of a document (or one page), for the server render. Keyed by node id. With the
 * pinned library versions (`id@version`, from the library's `libraryForDoc`), the inner nodes of each
 * instance are compiled too, under the derived ids the renderer gives them.
 */
export function compileDocumentCss(doc: AppDocument, pageId?: string, library: Record<string, LibraryComponent> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (n: ComponentNode, depth: number) => {
    if (n.css || (n.overrideTheme && (n.style || n.responsive?.mobile?.style))) {
      const { css } = compileNodeCss(n);
      if (css) out[n.id] = css;
    }
    for (const c of n.children ?? []) visit(c, depth);
    // An instance renders its pinned version's subtree; nesting is bounded in case of a cycle.
    const lib = n.libraryRef ? library[`${n.libraryRef.componentId}@${n.libraryRef.version}`] : undefined;
    if (lib && depth < 8) visit(expandInstance(n, lib), depth + 1);
  };
  for (const p of doc.pages) {
    if (pageId && p.id !== pageId && p.slug !== pageId) continue;
    visit(p.root, 0);
  }
  return out;
}

/** The app chrome's style and CSS, scoped to the app frame (architecture 4.6). */
export function compileChromeCss(chrome: ChromeDef, frameId: string): NodeCss {
  const removed: string[] = [];
  let src = "";
  if (chrome.style) {
    const { css, refused } = compileStyle(chrome.style, { slots: ["root", "nav", "item", "title", "logo"], states: ["hover", "active", "focus"] });
    for (const r of refused) removed.push(refusalText(r));
    src += css;
  }
  if (chrome.css) src += `\n${dropGlobalAtRules(chrome.css, removed)}`;
  if (!src.trim()) return { css: "", removed };
  const { css, dropped } = scopeCustomCssWithReport(src, { root: { kind: "frame", id: frameId } });
  for (const d of dropped) removed.push(describeDrop(d));
  return { css, removed };
}
