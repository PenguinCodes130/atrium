// SVG sanitiser (architecture 13 "Uploads": scripts, event handlers, foreignObject, external references
// and <use href> to other files removed). Pure and strict: the SVG is tokenised and rebuilt from an
// allowlist of elements and attributes; anything not understood is dropped, never passed through.
// No DOCTYPE (so no entity expansion), no processing instructions, no comments, no <style> blocks.

const ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath",
  "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "symbol", "use", "title", "desc", "marker",
  "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feFlood", "feGaussianBlur", "feMerge", "feMergeNode",
  "feOffset", "feFuncA", "feFuncR", "feFuncG", "feFuncB", "feMorphology", "feDropShadow",
]);
/** Elements whose whole subtree is removed (not just the tag). */
const DROP_SUBTREE = new Set(["script", "foreignobject", "style", "iframe", "object", "embed", "image", "a", "animate", "animatetransform", "animatemotion", "set", "handler", "listener", "metadata", "switch", "audio", "video", "canvas"]);

const ATTR_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const SAFE_ATTRS = new Set([
  "id", "class", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-opacity",
  "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
  "opacity", "transform", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "fx", "fy", "fr",
  "clip-path", "clipPathUnits", "clip-rule", "mask", "maskUnits", "maskContentUnits", "patternUnits", "patternContentUnits", "patternTransform",
  "preserveAspectRatio", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "letter-spacing", "dx", "dy",
  "textLength", "lengthAdjust", "startOffset", "visibility", "display", "color", "xmlns", "xmlns:xlink", "version", "role", "aria-label", "aria-hidden",
  "focusable", "markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits", "filterUnits", "primitiveUnits", "in", "in2", "result",
  "stdDeviation", "mode", "operator", "k1", "k2", "k3", "k4", "values", "type", "flood-color", "flood-opacity", "tableValues", "slope", "intercept",
  "amplitude", "exponent", "radius", "style", "href", "xlink:href", "vector-effect", "shape-rendering", "paint-order", "mix-blend-mode", "isolation",
]);

export type SvgReport = { svg: string; removed: { scripts: number; handlers: number; foreignObjects: number; externalRefs: number; other: number } };

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#([0-9]+);?/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&(lt|gt|amp|quot|apos);/g, (_, n) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[n as "lt"]);
}
function safeChar(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A reference that stays inside this document: `#id` or `url(#id)`. */
const INTERNAL_REF = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const URL_FN = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

function badValue(v: string): boolean {
  const flat = v.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
  return /javascript:|vbscript:|data:|expression\(|@import|behavior|-moz-binding/.test(flat) || v.includes("\\");
}

function urlsExternal(v: string): boolean {
  for (const m of v.matchAll(URL_FN)) if (!INTERNAL_REF.test(m[2]!.trim())) return true;
  return false;
}

type Tok =
  | { t: "open"; name: string; attrs: [string, string][]; self: boolean }
  | { t: "close"; name: string }
  | { t: "text"; text: string };

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out.push({ t: "text", text: src.slice(i) });
      break;
    }
    if (lt > i) out.push({ t: "text", text: src.slice(i, lt) });
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      if (end < 0) return null;
      out.push({ t: "text", text: esc(src.slice(lt + 9, end)) });
      i = end + 3;
      continue;
    }
    if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      // Processing instructions and DOCTYPE (with any internal subset) are dropped entirely.
      let depth = 0, j = lt + 1;
      for (; j < src.length; j++) {
        if (src[j] === "[") depth++;
        else if (src[j] === "]") depth--;
        else if (src[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    const m = /^<\/?\s*([A-Za-z][A-Za-z0-9_.:-]*)/.exec(src.slice(lt, lt + 200));
    if (!m) {
      out.push({ t: "text", text: "&lt;" });
      i = lt + 1;
      continue;
    }
    // Find the end of the tag, honouring quotes.
    let j = lt + m[0].length, q: string | null = null;
    for (; j < src.length; j++) {
      const ch = src[j]!;
      if (q) { if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === ">") break;
    }
    if (j >= src.length) return null;
    const raw = src.slice(lt, j + 1);
    if (raw.startsWith("</")) {
      out.push({ t: "close", name: m[1]! });
    } else {
      const self = /\/\s*>$/.test(raw);
      const body = raw.slice(m[0].length, self ? raw.lastIndexOf("/") : -1);
      const attrs: [string, string][] = [];
      const re = /([^\s=/]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      for (const a of body.matchAll(re)) attrs.push([a[1]!, a[3] ?? a[4] ?? (a[5] !== undefined ? "\u0000unquoted" : "")]);
      out.push({ t: "open", name: m[1]!, attrs, self });
    }
    i = j + 1;
  }
  return out;
}

/** Sanitise an SVG document. Returns null when it cannot be parsed as one. */
export function sanitiseSvg(input: string): SvgReport | null {
  const removed = { scripts: 0, handlers: 0, foreignObjects: 0, externalRefs: 0, other: 0 };
  const toks = tokenize(input.replace(/^﻿/, ""));
  if (!toks) return null;
  const stack: string[] = [];
  let skip = 0; // depth inside a dropped subtree
  let out = "";
  let sawRoot = false;
  for (const tk of toks) {
    if (tk.t === "text") {
      if (skip || !stack.length) continue;
      out += esc(decodeEntities(tk.text));
      continue;
    }
    const lname = tk.name.toLowerCase();
    if (tk.t === "close") {
      if (skip) {
        skip--;
        continue;
      }
      if (stack[stack.length - 1] === tk.name) {
        stack.pop();
        out += `</${tk.name}>`;
      }
      continue;
    }
    if (skip) {
      if (!tk.self) skip++;
      continue;
    }
    if (DROP_SUBTREE.has(lname) || !ELEMENTS.has(tk.name) || (!sawRoot && tk.name !== "svg")) {
      if (lname === "script") removed.scripts++;
      else if (lname === "foreignobject") removed.foreignObjects++;
      else removed.other++;
      if (!tk.self) skip = 1;
      continue;
    }
    sawRoot = true;
    let attrs = "";
    for (const [name, rawVal] of tk.attrs) {
      if (/^on/i.test(name)) { removed.handlers++; continue; }
      if (!ATTR_RE.test(name) || !SAFE_ATTRS.has(name) || rawVal === "\u0000unquoted") { removed.other++; continue; }
      const v = decodeEntities(rawVal);
      if (name === "href" || name === "xlink:href") {
        if (!INTERNAL_REF.test(v.trim())) { removed.externalRefs++; continue; }
      } else if (urlsExternal(v)) { removed.externalRefs++; continue; }
      if (badValue(v)) { removed.externalRefs++; continue; }
      attrs += ` ${name}="${esc(v)}"`;
    }
    if (tk.self) out += `<${tk.name}${attrs}/>`;
    else {
      out += `<${tk.name}${attrs}>`;
      stack.push(tk.name);
    }
  }
  if (!sawRoot) return null;
  while (stack.length) out += `</${stack.pop()}>`;
  return { svg: out, removed };
}
