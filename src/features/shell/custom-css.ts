// Custom CSS scoping (architecture v2 section 13; gauntlet r1 customisation finding 2). SERVER ONLY.
//
// User and theme-package CSS is untrusted. scopeCustomCss() parses it with a small, strict CSS
// parser (no dependency: Lightning CSS is not a runtime dependency of this app) and rebuilds it from
// an allowlist. Anything it does not understand is dropped, never passed through.
//
//  - Every style rule is rewritten so its subject is the dashboard canvas or one of its descendants:
//    `.card` becomes `[data-atrium-canvas] .card`; a selector that is exactly `:scope` or
//    `[data-atrium-canvas]` targets the canvas root itself. Leading `+` / `~` (siblings of the
//    canvas, which are outside it) are refused.
//  - Dropped: `:root`, `html`, `body`, `:host`, `:has()`, `::backdrop`, `&` nesting and nested rules,
//    `@import`, `@font-face`, `@property`, `@layer`, `@scope`, `@namespace`, `@page`, `@charset`,
//    `@counter-style` and every other at-rule except `@media`, `@supports`, `@container` and
//    `@keyframes`; `url()` except the instance's own `/uploads/` paths; `image-set()`, `image()`,
//    `element()`, `paint()`, `attr()`, `src()`, `expression()`, `javascript:`, `behavior` and
//    `-moz-binding`; custom property writes other than `--theme-*` and `--user-*` (so shell token
//    names cannot be set, even inside the canvas); any rule or value containing a backslash escape,
//    `<`, or a stray brace.
//  - `@keyframes` names are renamed to `atrium-user-<name>` (and `animation` references with them),
//    so custom CSS cannot replace a shell animation.
//  - Root kinds (architecture 4.6, gauntlet r2 L2): the same sanitiser scopes theme CSS to the app
//    canvas (`[data-atrium-canvas]`), chrome CSS to the app frame (`[data-atrium-app-frame="<id>"]`)
//    and node CSS to its node (`[data-node="<id>"]`). Ids are validated; `:scope` names the root.
//  - The root's own box (gauntlet r2 H1, Fix 1): on a selector that targets the root itself (`:scope`,
//    the bare marker, or the marker refined with classes, attributes or pseudo-classes), properties
//    that paint or push outside the root's box are dropped with a reason: margins, outline, box-shadow,
//    filter, -webkit-box-reflect, border-image outsets, zoom, position and offsets, transforms, float,
//    z-index, and width or min-width over 100%. The Canvas also renders inside a shell-owned clipping
//    frame and the guard layer pins the same properties, so this is one of three layers.
//  - `position` keeps only the keywords static, relative, absolute and sticky (plus the CSS-wide
//    initial, unset, revert and revert-layer) everywhere: `fixed`, and any value that could become
//    fixed through var() or env() (`position: var(--x, fixed)`), is dropped (architecture 13, gauntlet
//    r2 L1, components gauntlet w2-r2 Fix 2). Containment on the canvas root and each node bounds it too.
//  - The root's own box keeps a box and a sane size (components gauntlet w2-r2 Fixes 1 and 9):
//    `display: contents` (which removes the box, and with it the guard's clip) and any display through
//    var() or env() is dropped on the root; root height, min-height, block-size and min-block-size are
//    capped like width on node roots (auto, a content size or at most 100%), and node root padding to
//    64px a side.
//  - Properties that make parts unusable, editable or tied to document-wide names are dropped
//    everywhere: interactivity, -webkit-user-modify / user-modify, timeline-scope and named scroll or
//    view timelines (components gauntlet w2-r2 Fix 9).
//  - Components final pass (operator decision 2026-10-19 after gauntlet w2-r3): on any root, a selector
//    whose root compound (`:scope`, `:scope:not(...)`, `:scope:is(...)`, the canvas marker refined) is
//    followed by `+` or `~` is dropped, because its subject sits next to the root, outside it; node CSS
//    may not write `--theme-*` (the node box paints with theme tokens, so `--theme-shadow` could paint
//    over the app); and node roots may not set border widths on themselves (a 3000px border stretches
//    the row past the guard's height cap). Each is listed with its reason.
//  - The result is wrapped in `@layer atrium-custom`. The `atrium-shell-guard` layer (canvas-theme.css)
//    comes earlier, and an earlier layer's `!important` beats a later one, so the guard's pins on the
//    canvas root (position, inset, z-index, isolation, containment, transforms) always win.
//
// CSP is the second line of defence (architecture section 13).
import "server-only";

declare const scopedBrand: unique symbol;
/** CSS that has been through scopeCustomCss(). The Canvas primitive accepts only this type. */
export type ScopedCss = string & { readonly [scopedBrand]: true };

export type DroppedItem = { kind: "rule" | "at-rule" | "declaration" | "selector"; text: string; reason: string };
export type ScopeResult = { css: ScopedCss; dropped: DroppedItem[] };

export const CANVAS_ROOT = "[data-atrium-canvas]";
export const MAX_INPUT = 64 * 1024;
const MAX_DEPTH = 3;

const KEEP_AT = new Set(["media", "supports", "container"]);
const BAD_VALUE = /expression\(|javascript:|vbscript:|image-set\(|-webkit-image-set\(|(^|[^a-z-])image\(|element\(|paint\(|attr\(|(^|[^a-z-])src\(|cross-fade\(|@import/i;
const BAD_PROPERTY = new Set(["behavior", "-ms-behavior", "-moz-binding"]);
/**
 * Settings r2 SFR (gauntlet w2-r1 item 15): properties that reach outside the scope through a
 * document-wide name: view transitions (a named element is lifted into the top-level ::view-transition
 * tree, above the shell) and anchor positioning (an anchor name is global, so canvas CSS could tether to
 * a shell element or the reverse). Each is dropped and listed as removed.
 */
const GLOBAL_NAME_PROPERTY: Record<string, string> = {
  "view-transition-name": "view-transition-name is not allowed: it lifts elements above the shell",
  "view-transition-class": "view-transition-class is not allowed: view transitions are document-wide",
  "anchor-name": "anchor-name is not allowed: anchor names are document-wide",
  "anchor-scope": "anchor-scope is not allowed: anchor names are document-wide",
  "position-anchor": "position-anchor is not allowed: anchor names are document-wide",
  "position-area": "position-area is not allowed: it places an element against an anchor",
  "position-try": "position-try is not allowed: it places an element against an anchor",
  "position-try-fallbacks": "position-try-fallbacks is not allowed: it places an element against an anchor",
  "position-try-options": "position-try-options is not allowed: it places an element against an anchor",
  "position-visibility": "position-visibility is not allowed: it follows an anchor",
  "inset-area": "inset-area is not allowed: it places an element against an anchor",
};
const BAD_SELECTOR = /:root\b|:host\b|:has\(|::?backdrop\b|:scope\b|&|(^|[\s>+~(,])(html|body)(?![\w-])/i;
/** Attributes that mark a scope root; a selector may name the root only as its first compound. */
const ROOT_MARKERS = /data-atrium-canvas|data-atrium-app-frame|data-canvas-scope|data-node\b|data-atrium-canvas-frame/i;
const ROOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Properties that would paint or push the root's own box outside its slot (Fix 1). */
const ROOT_BOX_ESCAPES = /^(margin(-[a-z-]+)?|outline(-[a-z-]+)?|box-shadow|filter|-webkit-box-reflect|border-image(-outset|-source|-slice|-width|-repeat)?|zoom|position|inset(-[a-z-]+)?|top|right|bottom|left|transform(-[a-z-]+)?|translate|scale|rotate|float|z-index|offset(-[a-z-]+)?)$/;
const SIZE_PROPS = new Set(["width", "min-width", "inline-size", "min-inline-size"]);
/** On a node root only (Fix 9): the node cannot stretch its row; theme and chrome roots may still size the canvas and frame. */
const NODE_SIZE_PROPS = new Set(["height", "min-height", "block-size", "min-block-size"]);
/** Root padding (Fix 9): each side at most 64px (or 4rem), so one node cannot push its row off screen. */
const PADDING_PROPS = /^padding(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$/;
const PADDING_OK = /^(0|(\d+(\.\d+)?)px|(\d+(\.\d+)?)rem|inherit|initial|unset|revert|revert-layer)$/i;
const MAX_ROOT_PADDING_PX = 64;
/** The only position values kept (Fix 2): no fixed, and nothing that could resolve to fixed. */
const POSITION_OK = /^(static|relative|absolute|sticky|initial|unset|revert|revert-layer)$/i;
/** Properties dropped everywhere (Fix 9), with the reason shown to the author. */
const UNSAFE_PROPERTY: Record<string, string> = {
  interactivity: "interactivity is not allowed: it can make parts of the app unusable",
  "-webkit-user-modify": "-webkit-user-modify is not allowed: it makes content editable",
  "user-modify": "user-modify is not allowed: it makes content editable",
  "timeline-scope": "timeline-scope is not allowed: timeline names are document-wide",
  "scroll-timeline": "scroll-timeline is not allowed: timeline names are document-wide",
  "scroll-timeline-name": "scroll-timeline-name is not allowed: timeline names are document-wide",
  "view-timeline": "view-timeline is not allowed: timeline names are document-wide",
  "view-timeline-name": "view-timeline-name is not allowed: timeline names are document-wide",
};
const SAFE_SIZE = /^(auto|fit-content|min-content|max-content|inherit|initial|unset|revert|revert-layer)$/i;

/** Border properties that carry a width (radius, colour and style are fine): none on a node root (final pass). */
const BORDER_WIDTH_PROPS = /^border(-(top|right|bottom|left|before|after|start|end|block|inline)(-(start|end))?)?(-width)?$/;

/** Why a declaration may not sit on the root itself, or null when it may. `node` is true for a node root. */
function rootBoxProblem(prop: string, value: string, node = false): string | null {
  const name = prop.replace(/^-(webkit|moz|ms)-(?!box-reflect)/, "");
  if (ROOT_BOX_ESCAPES.test(name) || ROOT_BOX_ESCAPES.test(prop)) return "the root's own box cannot move, grow or paint outside its frame";
  if (node && BORDER_WIDTH_PROPS.test(name)) return 'borders on :scope are not allowed: they stretch the row. Put the border on a part, such as [data-slot="root"]';
  const v = value.replace(/\s*!\s*important\s*$/i, "").trim();
  if (SIZE_PROPS.has(name) || (node && NODE_SIZE_PROPS.has(name))) {
    const pctMatch = /^(\d+(?:\.\d+)?)%$/.exec(v);
    if (SAFE_SIZE.test(v) || (pctMatch && parseFloat(pctMatch[1]!) <= 100)) return null;
    return `${name} on the root may only be auto, a content size or at most 100%`;
  }
  if (name === "display" && (/\bcontents\b/i.test(v) || /\b(var|env)\(/i.test(v))) return "display on the root cannot be contents (or come through var() or env()): the root keeps its own box";
  if (node && PADDING_PROPS.test(name)) {
    const parts = v.split(/\s+/);
    const ok = parts.length <= 4 && parts.every((p) => PADDING_OK.test(p) && (!/px$/i.test(p) || parseFloat(p) <= MAX_ROOT_PADDING_PX) && (!/rem$/i.test(p) || parseFloat(p) * 16 <= MAX_ROOT_PADDING_PX));
    return ok ? null : `${name} on the root may be at most ${MAX_ROOT_PADDING_PX}px a side`;
  }
  return null;
}
const URL_RE = /url\(\s*(["']?)([^"')\s]*)\1\s*\)/gi;
const UPLOAD_URL = /^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

// ---------- scanner ----------

/** Index of the first char in `stop` at paren depth 0 (outside strings), from `i`; -1 if none. */
function scanTo(src: string, i: number, stop: string): number {
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && stop.includes(ch)) return i;
  }
  return -1;
}

/** `src[open]` is "{": index of its matching "}" (string aware), or -1. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const j = scanTo(s, i, sep);
    if (j === -1) {
      out.push(s.slice(i));
      return out;
    }
    out.push(s.slice(i, j));
    i = j + 1;
  }
}

function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) return out; // unterminated string: drop the rest
      out += src.slice(i, end + 1);
      i = end;
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return out;
      out += " ";
      i = end + 1;
    } else out += ch;
  }
  return out;
}

const short = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s).replace(/\s+/g, " ").trim();
/** Characters never allowed in a kept selector, prelude or value. */
const UNSAFE = /[\\<{}]/;

// ---------- context ----------

type Ctx = { root: string; canvas: boolean; node: boolean; dropped: DroppedItem[]; keyframes: Map<string, string> };
/** A scoped selector and whether it targets the root element itself. */
type Scoped = { sel: string; root: boolean };

// ---------- declarations ----------

function cleanDeclarations(block: string, ctx: Ctx, onRoot = false): string {
  const out: string[] = [];
  let i = 0;
  // A nested block inside a declaration list (CSS nesting) is dropped whole.
  let body = "";
  while (i < block.length) {
    const j = scanTo(block, i, "{");
    if (j === -1) {
      body += block.slice(i);
      break;
    }
    const k = matchBrace(block, j);
    const segStart = Math.max(block.lastIndexOf(";", j), -1) + 1;
    body += block.slice(i, Math.max(i, segStart));
    ctx.dropped.push({ kind: "rule", text: short(block.slice(segStart, k === -1 ? undefined : k + 1)), reason: "nested rules are not allowed" });
    if (k === -1) break;
    i = k + 1;
  }
  for (const raw of splitTop(body, ";")) {
    const d = raw.trim();
    if (!d) continue;
    const colon = d.indexOf(":");
    if (colon <= 0) {
      ctx.dropped.push({ kind: "declaration", text: short(d), reason: "not a declaration" });
      continue;
    }
    const prop = d.slice(0, colon).trim().toLowerCase();
    let value = d.slice(colon + 1).trim();
    const reason = declarationProblem(prop, value) ?? (ctx.node && prop.startsWith("--theme-") ? "a component cannot set --theme-* tokens: they come from the app's theme (and could repaint the app)" : null) ?? (onRoot ? rootBoxProblem(prop, value, ctx.node) : null);
    if (reason) {
      ctx.dropped.push({ kind: "declaration", text: short(d), reason });
      continue;
    }
    if ((prop === "animation" || prop === "animation-name") && ctx.keyframes.size) {
      value = value.replace(/-?[A-Za-z_][A-Za-z0-9_-]*/g, (w) => ctx.keyframes.get(w) ?? w);
    }
    out.push(`${prop}:${value}`);
  }
  return out.join(";");
}

function declarationProblem(prop: string, value: string): string | null {
  if (!/^(--[A-Za-z0-9_-]+|-?[a-z][a-z-]*)$/.test(prop)) return "invalid property name";
  if (prop.startsWith("--") && !/^--(theme|user)-[A-Za-z0-9_-]+$/.test(prop)) return "only --theme-* and --user-* custom properties may be set";
  if (BAD_PROPERTY.has(prop)) return "property not allowed";
  const globalName = GLOBAL_NAME_PROPERTY[prop.replace(/^-webkit-/, "")];
  if (globalName) return globalName;
  const bare = prop.replace(/^-(webkit|moz|ms)-/, "");
  if (UNSAFE_PROPERTY[prop] ?? UNSAFE_PROPERTY[bare]) return UNSAFE_PROPERTY[prop] ?? UNSAFE_PROPERTY[bare]!;
  if (bare === "position" && !POSITION_OK.test(value.replace(/\s*!\s*important\s*$/i, "").trim())) {
    return /^fixed\b/i.test(value.trim()) ? "position: fixed is not allowed (architecture 13)" : "position may only be static, relative, absolute or sticky (never fixed, and not through var() or env())";
  }
  if (!value) return "empty value";
  if (UNSAFE.test(value)) return "escapes, angle brackets and braces are not allowed";
  if (BAD_VALUE.test(value)) return "function or scheme not allowed";
  const urls = [...value.matchAll(URL_RE)];
  const urlCount = (value.match(/url\(/gi) ?? []).length;
  if (urlCount !== urls.length) return "malformed url()";
  for (const u of urls) if (!UPLOAD_URL.test(u[2]!) || u[2]!.includes("..")) return "url() may only point at this instance's /uploads/";
  return null;
}

// ---------- selectors ----------

/**
 * True when the root compound at the start of `rest` (what follows the root marker) is followed by a
 * sibling combinator (`+` or `~`): the subject is then a sibling of the root, outside it (final pass,
 * gauntlet w2-r3 item 2). The compound ends at the first whitespace or combinator outside (), [] and strings.
 */
function siblingAfterRoot(rest: string): boolean {
  let depth = 0;
  let bracket = 0;
  let i = 0;
  for (; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === '"' || ch === "'") {
      const end = rest.indexOf(ch, i + 1);
      if (end === -1) return true; // unbalanced: refuse
      i = end;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (depth === 0 && bracket === 0 && /[\s>+~]/.test(ch)) break;
  }
  return /^\s*[+~]/.test(rest.slice(i));
}

/** True when `rest` (what follows the root marker) only refines the root: no combinator, no pseudo-element. */
function refinesRootOnly(rest: string): boolean {
  let depth = 0;
  let bracket = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (depth === 0 && bracket === 0 && /[\s>+~]/.test(ch)) return false;
  }
  return !/::/.test(rest.replace(/\([^)]*\)/g, ""));
}

function scopeSelector(sel: string, ctx: Ctx): Scoped | null {
  const s = sel.trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (UNSAFE.test(s) || /[;@]/.test(s)) return drop(s, "unsafe characters");
  if (/^[+~]/.test(s)) return drop(s, "sibling selectors would reach outside the canvas");
  const lower = s.toLowerCase();
  if (lower === ":scope" || (ctx.canvas && lower === CANVAS_ROOT)) return { sel: ctx.root, root: true };
  // `:scope` (any root kind) or the canvas marker (canvas root) as the first compound names the root.
  const lead = lower.startsWith(":scope") ? ":scope" : ctx.canvas && lower.startsWith(CANVAS_ROOT) ? CANVAS_ROOT : null;
  if (lead) {
    const rest = s.slice(lead.length);
    if (BAD_SELECTOR.test(rest)) return drop(s, "selector reaches outside the canvas (:root, html, body, :host, :has(), :scope, &, ::backdrop)");
    if (ROOT_MARKERS.test(rest)) return drop(s, "the root marker may only appear once, at the start");
    if (/^[.:[]/.test(rest)) {
      if (siblingAfterRoot(rest)) return drop(s, "sibling selectors (+ or ~) after :scope are not allowed: they reach the components next to this one");
      return { sel: `${ctx.root}${rest}`, root: refinesRootOnly(rest) };
    }
    const tail = rest.trim();
    if (/^[+~]/.test(tail)) return drop(s, "sibling selectors would reach outside the canvas");
    return { sel: `${ctx.root} ${tail}`, root: false };
  }
  if (BAD_SELECTOR.test(s)) return drop(s, "selector reaches outside the canvas (:root, html, body, :host, :has(), :scope, &, ::backdrop)");
  if (ROOT_MARKERS.test(s)) return drop(s, "the root marker may only appear once, at the start");
  return { sel: `${ctx.root} ${s}`, root: false };

  function drop(text: string, reason: string): null {
    ctx.dropped.push({ kind: "selector", text: short(text), reason });
    return null;
  }
}

// ---------- rules ----------

function parseBlockList(src: string, ctx: Ctx, depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s|;/.test(src[i]!)) i++;
    if (i >= src.length) break;
    if (src[i] === "}") {
      ctx.dropped.push({ kind: "rule", text: "}", reason: "stray brace" });
      i++;
      continue;
    }
    if (src[i] === "@") {
      const m = /^@(-?[A-Za-z][A-Za-z0-9-]*)/.exec(src.slice(i));
      const name = (m?.[1] ?? "").toLowerCase();
      const end = scanTo(src, i, ";{");
      if (end === -1) {
        ctx.dropped.push({ kind: "at-rule", text: short(src.slice(i)), reason: "unterminated at-rule" });
        break;
      }
      const prelude = src.slice(i + 1 + name.length, end).trim();
      if (src[end] === ";") {
        ctx.dropped.push({ kind: "at-rule", text: short(src.slice(i, end + 1)), reason: `@${name || "?"} is not allowed` });
        i = end + 1;
        continue;
      }
      const close = matchBrace(src, end);
      if (close === -1) {
        ctx.dropped.push({ kind: "at-rule", text: short(src.slice(i)), reason: "unbalanced braces" });
        break;
      }
      const inner = src.slice(end + 1, close);
      i = close + 1;
      if (KEEP_AT.has(name)) {
        if (depth >= MAX_DEPTH) {
          ctx.dropped.push({ kind: "at-rule", text: short(`@${name} ${prelude}`), reason: "nested too deeply" });
          continue;
        }
        if (/[\\{}]|<\/|<!--|url\(|@/i.test(prelude) || !prelude) {
          ctx.dropped.push({ kind: "at-rule", text: short(`@${name} ${prelude}`), reason: "unsafe condition" });
          continue;
        }
        const body = parseBlockList(inner, ctx, depth + 1);
        if (body) out.push(`@${name} ${prelude.replace(/\s+/g, " ")}{${body}}`);
      } else if (name === "keyframes" || name === "-webkit-keyframes") {
        const kf = keyframes(prelude, inner, ctx);
        if (kf) out.push(kf);
      } else {
        ctx.dropped.push({ kind: "at-rule", text: short(`@${name} ${prelude}`), reason: `@${name || "?"} is not allowed` });
      }
      continue;
    }
    // style rule
    const open = scanTo(src, i, "{;}");
    if (open === -1) {
      ctx.dropped.push({ kind: "rule", text: short(src.slice(i)), reason: "no declaration block" });
      break;
    }
    if (src[open] !== "{") {
      ctx.dropped.push({ kind: "rule", text: short(src.slice(i, open + 1)), reason: "no declaration block" });
      i = open + 1;
      continue;
    }
    const close = matchBrace(src, open);
    if (close === -1) {
      ctx.dropped.push({ kind: "rule", text: short(src.slice(i)), reason: "unbalanced braces" });
      break;
    }
    const selectorText = src.slice(i, open);
    const block = src.slice(open + 1, close);
    i = close + 1;
    const selectors = splitTop(selectorText, ",").map((s) => scopeSelector(s, ctx)).filter((s): s is Scoped => s !== null);
    if (!selectors.length) {
      ctx.dropped.push({ kind: "rule", text: short(selectorText), reason: "no selector left after scoping" });
      continue;
    }
    // Selectors on the root itself get their own rule, without the box-escaping properties (Fix 1).
    const inner = selectors.filter((x) => !x.root).map((x) => x.sel);
    const onRoot = selectors.filter((x) => x.root).map((x) => x.sel);
    if (inner.length) {
      const decls = cleanDeclarations(block, ctx);
      if (decls) out.push(`${inner.join(",")}{${decls}}`);
    }
    if (onRoot.length) {
      // With a shared rule, report only what the root copy lost on top of what was already reported.
      const seen = ctx.dropped.length;
      const extra: DroppedItem[] = [];
      const decls = cleanDeclarations(block, { ...ctx, dropped: extra }, true);
      for (const d of extra) if (!ctx.dropped.slice(0, inner.length ? undefined : seen).some((b) => b.text === d.text && b.reason === d.reason)) ctx.dropped.push(d);
      if (decls) out.push(`${onRoot.join(",")}{${decls}}`);
    }
  }
  return out.join("\n");
}

function keyframes(prelude: string, inner: string, ctx: Ctx): string | null {
  const name = prelude.trim();
  const renamed = ctx.keyframes.get(name);
  if (!renamed) {
    ctx.dropped.push({ kind: "at-rule", text: short(`@keyframes ${prelude}`), reason: "invalid keyframes name" });
    return null;
  }
  const frames: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const open = scanTo(inner, i, "{");
    if (open === -1) break;
    const close = matchBrace(inner, open);
    if (close === -1) break;
    const sel = inner.slice(i, open).trim().toLowerCase();
    i = close + 1;
    if (!/^(from|to|\d{1,3}(\.\d+)?%)(\s*,\s*(from|to|\d{1,3}(\.\d+)?%))*$/.test(sel)) {
      ctx.dropped.push({ kind: "rule", text: short(sel), reason: "invalid keyframe selector" });
      continue;
    }
    const decls = cleanDeclarations(inner.slice(open + 1, close), ctx);
    if (decls) frames.push(`${sel.replace(/\s+/g, "")}{${decls}}`);
  }
  return frames.length ? `@keyframes ${renamed}{${frames.join("")}}` : null;
}

/** First pass: collect @keyframes names so animation references can be renamed wherever they are. */
function collectKeyframes(src: string, ctx: Ctx) {
  for (const m of src.matchAll(/@(?:-webkit-)?keyframes\s+([^\s{;]+)\s*\{/gi)) {
    const name = m[1]!;
    if (IDENT.test(name) && name.length <= 64) ctx.keyframes.set(name, `atrium-user-${name}`);
  }
}

/** What the CSS is scoped to (architecture 4.6): the app canvas (theme CSS), the app frame (chrome CSS) or one node (node CSS). */
export type ScopeRoot = { kind: "canvas" } | { kind: "frame"; id: string } | { kind: "node"; id: string };

export type ScopeOptions = {
  /** The root to scope to. Default: the canvas. */
  root?: ScopeRoot;
  /** Canvas only: limit the CSS to one canvas, `[data-atrium-canvas][data-canvas-scope="<scope>"]`. */
  scope?: string;
};

/** The root selector for a root kind, or null when the id is not valid. */
export function rootSelector(root: ScopeRoot = { kind: "canvas" }, scope?: string): string | null {
  if (root.kind === "canvas") return scope && ROOT_ID.test(scope) ? `${CANVAS_ROOT}[data-canvas-scope="${scope}"]` : CANVAS_ROOT;
  if (!ROOT_ID.test(root.id)) return null;
  return root.kind === "frame" ? `[data-atrium-app-frame="${root.id}"]` : `[data-node="${root.id}"]`;
}

/** Scope untrusted custom CSS to the dashboard canvas. Returns the CSS and what was dropped, and why. */
export function scopeCustomCssWithReport(input: string, options: ScopeOptions = {}): ScopeResult {
  const dropped: DroppedItem[] = [];
  const kind = options.root ?? { kind: "canvas" as const };
  const root = rootSelector(kind, options.scope);
  if (!root) {
    dropped.push({ kind: "rule", text: "(all)", reason: "invalid root id: letters, digits, _ and - only, at most 64" });
    return { css: "" as ScopedCss, dropped };
  }
  const ctx: Ctx = { root, canvas: kind.kind === "canvas", node: kind.kind === "node", dropped, keyframes: new Map() };
  if (typeof input !== "string" || !input.trim()) return { css: "" as ScopedCss, dropped };
  let src = input;
  if (src.length > MAX_INPUT) {
    dropped.push({ kind: "rule", text: `${src.length} characters`, reason: `custom CSS is limited to ${MAX_INPUT} characters; the rest was ignored` });
    src = src.slice(0, MAX_INPUT);
  }
  // NUL and other control characters (except whitespace) are never needed in CSS.
  src = stripComments(src.replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g, ""));
  collectKeyframes(src, ctx);
  const body = parseBlockList(src, ctx, 0);
  if (!body) return { css: "" as ScopedCss, dropped };
  const css = `@layer atrium-shell-guard, atrium-theme, atrium-custom;\n@layer atrium-custom{\n${body}\n}`;
  // Last line of defence for the <style> element: nothing that could end it or open markup.
  if (/<\/|<!--|<[a-z]/i.test(css)) {
    dropped.push({ kind: "rule", text: "(all)", reason: "output contained markup" });
    return { css: "" as ScopedCss, dropped };
  }
  return { css: css as ScopedCss, dropped };
}

/** Scope untrusted custom CSS to the dashboard canvas (see the file header for the rules). */
export function scopeCustomCss(input: string, options: ScopeOptions = {}): ScopedCss {
  return scopeCustomCssWithReport(input, options).css;
}
