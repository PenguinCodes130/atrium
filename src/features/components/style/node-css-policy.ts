// Node CSS policy (components final pass, operator decision 2026-10-19 after gauntlet w2-r3: a narrow scope
// cut). It runs on the output of app-shell's sanitiser (scopeCustomCss with a node root), which is already
// normalised (no comments, escapes or stray braces; every selector starts at `[data-node="<id>"]`), and
// removes three things from node CSS, each listed with its reason:
//   1. Writes to `--theme-*` custom properties, anywhere in the node's CSS. The node box (and the Style
//      panel's node-box shadow, whose colours are theme tokens) reads theme tokens, so a component that
//      could set `--theme-shadow` could paint over the whole app (w2-r3 item 1).
//   2. Selectors whose root compound (`:scope`, `:scope:not(...)`, `:scope:is(...)` and so on) is followed
//      by a sibling combinator (`+` or `~`): they reach the components next to this one (w2-r3 item 2).
//   3. Border widths on the node's own box (`:scope { border-bottom: 3000px solid }`), which stretch the
//      row past the height cap (w2-r3 item 3). Borders belong on a part, such as `[data-slot="root"]`.
// Layout nodes (grid, stack, section, tabs, repeat) take no node CSS at all: see LAYOUT_TYPES.
// The guard layer in components.css holds the same lines on its own (pinned tokens, border widths and
// box sizing on every node box), so this is one of two layers. SERVER ONLY in practice (style/server.ts).

/** Layout types: Style panel only, no free-form node CSS (their own CSS could stretch the page). */
export const LAYOUT_TYPES: ReadonlySet<string> = new Set(["grid", "stack", "section", "tabs", "repeat"]);
export const isLayoutType = (type: string): boolean => LAYOUT_TYPES.has(type);

/** Shown in the CSS field of a layout node and listed when saved CSS on one is ignored. */
export const LAYOUT_CSS_REFUSAL =
  "Layouts (grid, stack, section, tabs, repeat) take the Style panel only: their own CSS could stretch the page. Turn on Customise the look to style this one.";
export const LAYOUT_CSS_IGNORED = `the saved CSS on this layout is ignored. ${LAYOUT_CSS_REFUSAL}`;

export const THEME_WRITE_REASON = "a component cannot set --theme-* tokens: they come from the app's theme (and could repaint the app)";
export const SIBLING_REASON = "sibling selectors (+ or ~) after :scope are not allowed: they reach the components next to this one";
export const ROOT_BORDER_REASON = 'borders on :scope are not allowed: they stretch the row. Put the border on a part, such as [data-slot="root"]';

/** Border properties that carry a width (border-radius, -color and -style are fine). */
const BORDER_WIDTH = /^border(-(top|right|bottom|left|before|after|start|end|block|inline)(-(start|end))?)?(-width)?$/;

// ---------- string-aware scanning (the input is the sanitiser's output, so strings are the only trap) ----------

function skipString(s: string, i: number): number {
  const end = s.indexOf(s[i]!, i + 1);
  return end === -1 ? s.length : end;
}

/** Index of the first char in `stop` outside strings, parentheses and brackets, from `i`; -1 if none. */
function scanTo(s: string, i: number, stop: string): number {
  let paren = 0;
  let bracket = 0;
  for (; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'") i = skipString(s, i);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (paren === 0 && bracket === 0 && stop.includes(ch)) return i;
  }
  return -1;
}

/** `s[open]` is "{": index of its matching "}" (string aware), or -1. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'") i = skipString(s, i);
    else if (ch === "{") depth++;
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

const short = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s).replace(/\s+/g, " ").trim();

// ---------- selectors ----------

export type SelectorShape = { root: boolean; sibling: boolean };

/**
 * How a scoped selector relates to the node root `[data-node="<id>"]`: `root` when it names the node box
 * itself (the root compound only, no pseudo-element), `sibling` when the root compound is followed by `+`
 * or `~` (the subject then sits next to the node, outside it). A selector that does not start at the root
 * marker is neither (the sanitiser always puts the marker first).
 */
export function selectorShape(sel: string, rootMarker: string): SelectorShape {
  const s = sel.trim();
  if (!s.startsWith(rootMarker)) return { root: false, sibling: false };
  const rest = s.slice(rootMarker.length);
  // The root compound ends at the first whitespace or combinator outside (), [] and strings.
  let end = scanTo(rest, 0, " \t\n\r\f>+~");
  if (end === -1) end = rest.length;
  const compound = rest.slice(0, end);
  const after = rest.slice(end).trimStart();
  const sibling = after.startsWith("+") || after.startsWith("~");
  const pseudoElement = /::/.test(compound.replace(/\([^)]*\)/g, "")) || /:(before|after|first-line|first-letter|marker|placeholder|selection)\b/i.test(compound.replace(/\([^)]*\)/g, ""));
  return { root: after === "" && !pseudoElement, sibling };
}

// ---------- the pass ----------

/**
 * Applies the node CSS policy to CSS that came out of scopeCustomCss with root `[data-node="<id>"]`.
 * Returns the CSS without the removed parts (empty when nothing of the node's own rules is left) and
 * appends one readable line per removal to `removed` ("<text>: <reason>").
 */
export function enforceNodeCssPolicy(css: string, nodeId: string, removed: string[]): string {
  if (!css.trim()) return "";
  const marker = `[data-node="${nodeId}"]`;
  const shown = (sel: string) => short(sel.trim().startsWith(marker) ? `:scope${sel.trim().slice(marker.length)}` : sel);
  const seen = new Set<string>();
  const note = (line: string) => {
    if (seen.has(line)) return;
    seen.add(line);
    removed.push(line);
  };
  let rules = 0;

  const declarations = (block: string, onRoot: boolean): string => {
    const out: string[] = [];
    for (const raw of splitTop(block, ";")) {
      const d = raw.trim();
      if (!d) continue;
      const colon = d.indexOf(":");
      const prop = (colon > 0 ? d.slice(0, colon) : d).trim().toLowerCase();
      if (prop.startsWith("--theme-")) {
        note(`${short(d)}: ${THEME_WRITE_REASON}`);
        continue;
      }
      if (onRoot && BORDER_WIDTH.test(prop.replace(/^-(webkit|moz|ms)-/, ""))) {
        note(`${short(d)}: ${ROOT_BORDER_REASON}`);
        continue;
      }
      out.push(d);
    }
    return out.join(";");
  };

  const list = (src: string): string => {
    const out: string[] = [];
    let i = 0;
    while (i < src.length) {
      while (i < src.length && /[\s;]/.test(src[i]!)) i++;
      if (i >= src.length) break;
      if (src[i] === "@") {
        const end = scanTo(src, i, ";{");
        if (end === -1) break;
        if (src[end] === ";") {
          out.push(src.slice(i, end + 1));
          i = end + 1;
          continue;
        }
        const close = matchBrace(src, end);
        if (close === -1) break;
        const head = src.slice(i, end).trim();
        const body = list(src.slice(end + 1, close));
        i = close + 1;
        if (body.trim()) out.push(`${head}{${body}}`);
        continue;
      }
      const open = scanTo(src, i, "{");
      if (open === -1) break;
      const close = matchBrace(src, open);
      if (close === -1) break;
      const selectorText = src.slice(i, open);
      const block = src.slice(open + 1, close);
      i = close + 1;
      const kept: string[] = [];
      let allRoot = true;
      for (const sel of splitTop(selectorText, ",")) {
        if (!sel.trim()) continue;
        const shape = selectorShape(sel, marker);
        if (shape.sibling) {
          note(`${shown(sel)}: ${SIBLING_REASON}`);
          continue;
        }
        if (!shape.root) allRoot = false;
        kept.push(sel.trim());
      }
      if (!kept.length) continue;
      // The sanitiser gives selectors on the root their own rule, so a rule is either all root or none.
      const decls = declarations(block, allRoot);
      if (!decls) continue;
      // Keyframe selectors (from, to, 50%) are not node selectors; they pass through as they are.
      out.push(`${kept.join(",")}{${decls}}`);
      rules++;
    }
    return out.join("\n");
  };

  const result = list(css);
  return rules ? result : "";
}
