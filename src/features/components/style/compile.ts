// Style overrides (architecture v3 section 4.6, spec 3.3): a node's StyleOverride becomes CSS for its
// slots and states. Every value is checked per property first; a refused value is not applied and the
// reason is reported. The result is NOT yet safe to inject: it always goes through app-shell's
// sanitiser (scopeCustomCss with a node root, amendment A4.2) on the server (style/server.ts).
import type { ComponentState, StyleOverride, StyleProps } from "@/core/contracts";

export type StyleRefusal = { slot: string; state?: string; mobile?: boolean; prop: string; value: string; reason: string };

export const THEME_TOKENS = ["surface", "surfaceText", "surfaceMuted", "canvasText", "accent", "accentText", "ok", "warn", "bad", "info", "line"] as const;
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const NUM = "-?(?:\\d+\\.?\\d*|\\.\\d+)";
const LEN_UNIT = "(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex|fr|svh|dvh|lvh)";
const LEN = new RegExp(`^(?:${NUM}${LEN_UNIT}?|auto|0)$`);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\([0-9a-z.,%\s/+-]*\)$/i;
const NAMED = /^(?:transparent|currentcolor|black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|teal|navy|maroon|olive|lime|aqua|fuchsia|silver|gold|indigo|violet|brown|cyan|magenta|inherit)$/i;
const TOKEN = /^token:([A-Za-z]+)$/;
const TIME = /^(?:\d+\.?\d*|\.\d+)(?:ms|s)$/;
const EASE = /^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|cubic-bezier\(\s*[\d.]+\s*,\s*-?[\d.]+\s*,\s*[\d.]+\s*,\s*-?[\d.]+\s*\))$/;

export function tokenVar(name: string): string | null {
  return (THEME_TOKENS as readonly string[]).includes(name) ? `var(--theme-${kebab(name)})` : null;
}

function color(v: string): string | null {
  const s = v.trim();
  const t = TOKEN.exec(s);
  if (t) return tokenVar(t[1]!);
  if (HEX.test(s) || NAMED.test(s)) return s;
  if (COLOR_FN.test(s) && !/url|expression|var\(/i.test(s)) return s;
  return null;
}

/** Splits on top-level commas (outside parentheses). */
function splitComma(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function gradient(v: string): string | null {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/i.exec(v.trim());
  if (!m) return null;
  const parts = splitComma(m[3]!);
  const out: string[] = [];
  for (const [i, p] of parts.entries()) {
    // A direction or shape first ("90deg", "to right", "circle at center"), then colour stops.
    if (i === 0 && /^(?:-?\d+\.?\d*(?:deg|turn|rad)|to(?:\s+(?:top|bottom|left|right)){1,2}|(?:circle|ellipse)?(?:\s*at\s+[a-z\s%\d.]+)?|from\s+-?\d+\.?\d*deg)$/i.test(p)) {
      out.push(p);
      continue;
    }
    const sm = /^(\S+(?:\([^)]*\))?)(?:\s+(-?\d+\.?\d*%?(?:\s+-?\d+\.?\d*%)?))?$/.exec(p);
    if (!sm) return null;
    const c = color(sm[1]!);
    if (!c) return null;
    out.push(sm[2] ? `${c} ${sm[2]}` : c);
  }
  return `${m[1] ?? ""}${m[2]}-gradient(${out.join(", ")})`;
}

function paint(v: string): string | null {
  return color(v) ?? gradient(v);
}

function len(v: unknown, multi = 1): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? `${v}px` : null;
  if (typeof v !== "string") return null;
  const parts = v.trim().split(/\s+/);
  if (!parts.length || parts.length > multi) return null;
  return parts.every((p) => LEN.test(p)) ? parts.join(" ") : null;
}

/**
 * The farthest a shadow may reach past the component's edge (offset plus blur plus spread), in px
 * (gauntlet w2-r2 Fix 7). A styled node's window shadow is drawn by the node box outside its clip, and
 * plain nodes leave 104px of room for their children's shadows (components.css), so a shadow up to this
 * reach always renders whole.
 */
export const SHADOW_REACH_MAX = 96;
const SHADOW_LEN = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)|0)$/;
const toPx = (t: string): number => (t === "0" ? 0 : parseFloat(t) * (/r?em$/.test(t) ? 16 : 1));

/** How far a (checked) shadow list reaches past the box, in px: the largest offset plus blur plus spread. */
export function shadowReach(v: string): number {
  let reach = 0;
  for (const s of splitComma(v)) {
    const toks: string[] = s.match(/(?:[a-z-]+\([^)]*\)|\S+)/gi) ?? [];
    if (toks.includes("inset")) continue;
    const lens = toks.filter((t) => SHADOW_LEN.test(t)).map(toPx);
    const [x = 0, y = 0, blur = 0, spread = 0] = lens;
    reach = Math.max(reach, Math.max(Math.abs(x), Math.abs(y)) + Math.max(0, blur) + Math.max(0, spread));
  }
  return reach;
}

function shadow(v: string): string | null | { refuse: string } {
  if (v.trim() === "none") return "none";
  const list = splitComma(v);
  if (list.length > 4) return null;
  const out: string[] = [];
  for (const s of list) {
    const toks = s.match(/(?:[a-z-]+\([^)]*\)|\S+)/gi) ?? [];
    const lens: string[] = [];
    let c: string | null = null, inset = false;
    for (const t of toks) {
      if (t === "inset") inset = true;
      else if (SHADOW_LEN.test(t)) lens.push(t);
      else if (!c && (c = color(t))) continue;
      else return null;
    }
    if (lens.length < 2 || lens.length > 4) return null;
    out.push([inset ? "inset" : "", ...lens, c ?? ""].filter(Boolean).join(" "));
  }
  const value = out.join(", ");
  const reach = shadowReach(value);
  if (reach > SHADOW_REACH_MAX) return { refuse: `a shadow can reach at most ${SHADOW_REACH_MAX}px past the component (offset + blur + spread); this one reaches ${Math.round(reach)}px` };
  return value;
}

function border(v: string): string | null {
  if (v.trim() === "none") return "none";
  const toks = v.trim().split(/\s+(?![^(]*\))/);
  if (toks.length > 3) return null;
  const out: string[] = [];
  for (const t of toks) {
    if (LEN.test(t) || /^(?:solid|dashed|dotted|double|none)$/.test(t)) out.push(t);
    else {
      const c = color(t);
      if (!c) return null;
      out.push(c);
    }
  }
  return out.join(" ");
}

const FILTER_FN = /^(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia|drop-shadow)\(\s*[-\d.]+(?:px|%|deg|turn)?\s*\)$/;
function filterList(v: string): string | null {
  if (v.trim() === "none") return "none";
  const fns = v.trim().match(/[a-z-]+\([^)]*\)/g);
  if (!fns || fns.join(" ").replace(/\s+/g, "") !== v.replace(/\s+/g, "")) return null;
  return fns.every((f) => FILTER_FN.test(f)) && fns.length <= 6 ? fns.join(" ") : null;
}

const TRANSFORM_FN = /^(?:translate|translateX|translateY|scale|scaleX|scaleY|rotate|skew|skewX|skewY)\(\s*-?[\d.]+(?:px|%|deg|turn|rem|em)?(?:\s*,\s*-?[\d.]+(?:px|%|deg|turn|rem|em)?)?\s*\)$/;
function transform(v: string): string | null {
  if (v.trim() === "none") return "none";
  const fns = v.trim().match(/[a-zA-Z]+\([^)]*\)/g);
  if (!fns || fns.join("").replace(/\s+/g, "") !== v.replace(/\s+/g, "")) return null;
  return fns.length <= 6 && fns.every((f) => TRANSFORM_FN.test(f)) ? fns.join(" ") : null;
}

const TRANSITION_PROPS = new Set(["all", "transform", "opacity", "color", "background-color", "background", "border-color", "box-shadow", "filter"]);
function transition(v: string): string | null {
  if (v.trim() === "none") return "none";
  const list = splitComma(v);
  if (list.length > 4) return null;
  for (const t of list) {
    const toks = t.split(/\s+(?![^(]*\))/);
    if (!toks.length || toks.length > 4) return null;
    if (!TRANSITION_PROPS.has(toks[0]!) || !toks[1] || !TIME.test(toks[1])) return null;
    if (toks[2] && !EASE.test(toks[2]) && !TIME.test(toks[2])) return null;
    if (toks[3] && !TIME.test(toks[3])) return null;
    if (toks.some((x) => TIME.test(x) && parseFloat(x) * (x.endsWith("ms") ? 1 : 1000) > 2000)) return null;
  }
  return list.join(", ");
}

const ENUMS: Record<string, readonly string[]> = {
  display: ["block", "flex", "grid", "inline", "inline-block", "inline-flex", "none", "contents"],
  flexDirection: ["row", "column", "row-reverse", "column-reverse"],
  alignItems: ["start", "end", "center", "stretch", "baseline", "flex-start", "flex-end"],
  justifyContent: ["start", "end", "center", "space-between", "space-around", "space-evenly", "flex-start", "flex-end"],
  overflow: ["visible", "hidden", "clip", "auto", "scroll"],
  mixBlendMode: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light", "difference", "exclusion", "luminosity", "color"],
  textAlign: ["left", "right", "center", "justify", "start", "end"],
  textTransform: ["none", "uppercase", "lowercase", "capitalize"],
  fontVariantNumeric: ["normal", "tabular-nums", "proportional-nums", "oldstyle-nums", "lining-nums", "slashed-zero"],
};

export const ANIMATIONS: Record<string, string> = {
  none: "none",
  pulse: "atr-anim-pulse 2s ease-in-out infinite",
  "fade-in": "atr-anim-fade-in 240ms cubic-bezier(0.2, 0, 0, 1) both",
  rise: "atr-anim-rise 320ms cubic-bezier(0.2, 0, 0, 1) both",
  glow: "atr-anim-glow 2.4s ease-in-out infinite",
};

type Check = (v: unknown) => string | null | { refuse: string };

const str = (f: (s: string) => string | null | { refuse: string }): Check => (v) => (typeof v === "string" ? f(v) : null);
const CHECKS: Record<keyof StyleProps, Check> = {
  display: str((s) => (ENUMS.display!.includes(s) ? s : null)),
  flexDirection: str((s) => (ENUMS.flexDirection!.includes(s) ? s : null)),
  gap: (v) => len(v, 2),
  alignItems: str((s) => (ENUMS.alignItems!.includes(s) ? s : null)),
  justifyContent: str((s) => (ENUMS.justifyContent!.includes(s) ? s : null)),
  padding: (v) => len(v, 4),
  margin: (v) => len(v, 4),
  width: (v) => len(v),
  height: (v) => len(v),
  minHeight: (v) => len(v),
  maxWidth: (v) => len(v),
  overflow: str((s) => (ENUMS.overflow!.includes(s) ? s : null)),
  color: str(color),
  background: str(paint),
  backgroundImage: str((s) => {
    const u = /^url\(\s*(["']?)(\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*)\1\s*\)$/.exec(s.trim());
    if (u) return /\.\./.test(u[2]!) ? null : `url("${u[2]}")`;
    if (/url\(/i.test(s)) return { refuse: "only this Atrium's own uploads (/uploads/...) can be used as images" };
    return gradient(s);
  }),
  opacity: (v) => (typeof v === "number" && v >= 0 && v <= 1 ? String(v) : null),
  mixBlendMode: str((s) => (ENUMS.mixBlendMode!.includes(s) ? s : null)),
  backdropFilter: str(filterList),
  filter: str(filterList),
  border: str(border),
  borderColor: str(paint),
  borderWidth: (v) => len(v, 4),
  borderRadius: (v) => len(v, 4),
  boxShadow: str(shadow),
  outline: str(border),
  fontFamily: str((s) => (/^[A-Za-z0-9 ,"'-]{1,120}$/.test(s) ? s : null)),
  fontSize: (v) => len(v),
  fontWeight: (v) => (typeof v === "number" && v >= 100 && v <= 900 ? String(v) : typeof v === "string" && /^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(v) ? v : null),
  lineHeight: (v) => (typeof v === "number" && v > 0 && v < 10 ? String(v) : len(v)),
  letterSpacing: (v) => len(v),
  textAlign: str((s) => (ENUMS.textAlign!.includes(s) ? s : null)),
  textTransform: str((s) => (ENUMS.textTransform!.includes(s) ? s : null)),
  fontVariantNumeric: str((s) => (ENUMS.fontVariantNumeric!.includes(s) ? s : null)),
  textShadow: str(shadow),
  transition: str(transition),
  transform: str(transform),
  animation: str((s) => ANIMATIONS[s] ?? null),
};

const STATE_SEL: Record<ComponentState, string> = {
  hover: ":hover",
  active: ":active",
  focus: ":focus-visible",
  on: '[data-state="on"]',
  off: '[data-state="off"]',
  disabled: "[data-disabled]",
};

/** Parts drawn in the muted text colour by default; a root colour cascades into them. */
export const QUIET_SLOTS = new Set(["label", "unit", "delta", "detail", "date", "description", "subtitle", "header", "legend", "axis"]);

const slotSel = (slot: string) => `[data-slot="${slot}"]`;
const SLOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Size limits for layout nodes (grid, stack, section, tabs, repeat; components final pass after gauntlet
 * w2-r3 item 3). Layouts are not cut at a height, because they grow with their children, and they take
 * the Style panel only, so the panel's own sizes on them are bounded: no single value can stretch the page.
 * In px, with rem and em at 16px, viewport units at 10px (vw and vmax at 14.4px), % at 14.4px and ch or ex
 * at 8px. Height and minimum height may also be up to 150 viewport-height units or 100%.
 */
export const LAYOUT_LIMITS: Partial<Record<keyof StyleProps, number>> = { height: 1200, minHeight: 1200, padding: 160, margin: 160, gap: 160, borderWidth: 16, border: 16, fontSize: 160, lineHeight: 200, letterSpacing: 100 };
const UNIT_PX: Record<string, number> = { px: 1, rem: 16, em: 16, vh: 10, svh: 10, dvh: 10, lvh: 10, vmin: 10, vw: 14.4, vmax: 14.4, "%": 14.4, ch: 8, ex: 8 };

/** Why a (checked) Style panel value is too large for a layout node, or null. */
export function layoutLimit(prop: keyof StyleProps, value: string): string | null {
  const max = LAYOUT_LIMITS[prop];
  if (max === undefined) return null;
  // Whole length tokens only (a colour such as color-mix(... 50%) or #15130f is not a size).
  for (const tok of value.trim().split(/\s+(?![^(]*\))/)) {
    const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|svh|dvh|lvh|vh|vmin|vmax|vw|%|ch|ex|fr)?$/i.exec(tok);
    if (!m) continue;
    const n = Math.abs(parseFloat(m[1]!));
    const unit = (m[2] ?? "").toLowerCase();
    if (!unit) {
      if (prop === "lineHeight" && n <= 4) continue; // a unitless line height is a multiple of the text size
      if (n === 0) continue;
      if (prop === "lineHeight") return `on a layout, a line height can be at most 4 (or ${max}px)`;
      continue;
    }
    if ((prop === "height" || prop === "minHeight") && ((/^[sdl]?vh$|^vmin$/.test(unit) && n <= 150) || (unit === "%" && n <= 100))) continue;
    if (unit === "fr") continue;
    if (n * (UNIT_PX[unit] ?? 1) > max) return `on a layout (grid, stack, section, tabs, repeat), ${kebab(prop)} can be at most ${max}px, so one layout cannot stretch the page`;
  }
  return null;
}

/** Declarations for one StyleProps block, with refusals. With `layout`, sizes are bounded (LAYOUT_LIMITS). */
export function declarations(props: StyleProps, where: Omit<StyleRefusal, "prop" | "value" | "reason">, refusals: StyleRefusal[], opts: { layout?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const [k, raw] of Object.entries(props)) {
    if (k === "states" || raw === undefined || raw === null || raw === "") continue;
    const check = CHECKS[k as keyof StyleProps];
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (!check) {
      refusals.push({ ...where, prop: k, value, reason: `${k} is not a style property Atrium supports` });
      continue;
    }
    if (typeof raw === "string" && (/[;{}<>\\]/.test(raw) || raw.length > 400)) {
      refusals.push({ ...where, prop: k, value, reason: "the value contains characters that are not allowed" });
      continue;
    }
    const r = check(raw);
    if (r === null) refusals.push({ ...where, prop: k, value, reason: `"${value}" is not a valid ${kebab(k)}` });
    else if (typeof r === "object") refusals.push({ ...where, prop: k, value, reason: r.refuse });
    else {
      const tooBig = opts.layout ? layoutLimit(k as keyof StyleProps, r) : null;
      if (tooBig) refusals.push({ ...where, prop: k, value, reason: tooBig });
      else out.push(`${kebab(k)}:${r}`);
    }
  }
  return out;
}

/** The node-box placeholder in `nodeBox` rules; the server swaps in the node's own selector. */
export const NODE_BOX = ":node-box";
const STATE_HAS: Record<ComponentState, string> = {
  hover: ":hover",
  active: ":active",
  focus: ":focus-visible",
  on: '[data-state="on"]',
  off: '[data-state="off"]',
  disabled: "[data-disabled]",
};

/**
 * CSS for a node's style override (selectors relative to the node root, `:scope`-free: every slot is
 * an element inside the node wrapper, so shadows and transforms on "root" stay allowed and clipped by
 * the node). Mobile overrides go under a container query on the render root.
 *
 * With `nodeBox` (node styles, not chrome), the root part's box shadow (and its corner radius, so the
 * shadow keeps the shape) is NOT in `css`: it
 * comes back in `nodeBox`, rules on the node box itself (selector `:node-box`), so the shadow is drawn
 * outside the node's 12px clip and never cut (gauntlet w2-r2 Fix 7). Its values passed the same checks,
 * including the SHADOW_REACH_MAX cap.
 */
export function compileStyle(style: StyleOverride | undefined, opts: { slots: string[]; states?: ComponentState[]; mobile?: StyleOverride; nodeBox?: boolean; layout?: boolean } = { slots: ["root"] }): { css: string; refused: StyleRefusal[]; nodeBox: string } {
  const refused: StyleRefusal[] = [];
  const box: { desktop: string[]; mobile: string[] } = { desktop: [], mobile: [] };
  const toBox = (decls: string[], sel: string, mobile: boolean): string[] => {
    const shadow = decls.filter((d) => d.startsWith("box-shadow:"));
    if (!shadow.length) return decls;
    const radius = decls.filter((d) => d.startsWith("border-radius:"));
    (mobile ? box.mobile : box.desktop).push(`${sel}{${[...shadow, ...radius].join(";")}}`);
    return decls.filter((d) => !d.startsWith("box-shadow:"));
  };
  const blocks = (s: StyleOverride | undefined, mobile: boolean): string[] => {
    const rules: string[] = [];
    for (const [slot, sp] of Object.entries(s ?? {})) {
      if (!SLOT_NAME.test(slot) || !opts.slots.includes(slot)) {
        refused.push({ slot, mobile, prop: "(slot)", value: slot, reason: `this component has no "${slot}" part to style` });
        continue;
      }
      let base = declarations(sp, { slot, mobile }, refused, { layout: opts.layout });
      if (slot === "root" && opts.nodeBox) base = toBox(base, NODE_BOX, mobile);
      if (base.length) rules.push(`${slotSel(slot)}{${base.join(";")}}`);
      // A root text colour reaches the quieter parts (label, unit, ...) that have no colour of their own,
      // slightly softened, so a recoloured stat never keeps dark labels on its new background (Fix 12).
      const rootColor = slot === "root" && base.some((d) => d.startsWith("color:"));
      // Controls (the only types with a disabled state) keep their label at full strength.
      if (rootColor && !(opts.states ?? []).includes("disabled")) {
        const quiet = opts.slots.filter((x) => QUIET_SLOTS.has(x) && !(s?.[x] as StyleProps | undefined)?.color);
        if (quiet.length) rules.push(`${slotSel("root")} :is(${quiet.map(slotSel).join(",")}){color:color-mix(in oklab, currentColor 74%, transparent)}`);
      }
      for (const [state, stp] of Object.entries(sp.states ?? {})) {
        if (!stp) continue;
        if (!(state in STATE_SEL) || !(opts.states ?? []).includes(state as ComponentState)) {
          refused.push({ slot, state, mobile, prop: "(state)", value: state, reason: `this component has no "${state}" state` });
          continue;
        }
        let d = declarations(stp, { slot, state, mobile }, refused, { layout: opts.layout });
        if (slot === "root" && opts.nodeBox) d = toBox(d, `${NODE_BOX}:has(> ${slotSel("root")}${STATE_HAS[state as ComponentState]})`, mobile);
        if (!d.length) continue;
        const st = STATE_SEL[state as ComponentState];
        const sel = slot === "root" ? `${slotSel("root")}${st}` : `${slotSel("root")}${st} ${slotSel(slot)}`;
        rules.push(`${sel}{${d.join(";")}}`);
      }
    }
    return rules;
  };
  const desktop = blocks(style, false);
  const mobile = opts.mobile ? blocks(opts.mobile, true) : [];
  const css = [...desktop, ...(mobile.length ? [`@container atrium-page (max-width: 639.98px){${mobile.join("")}}`] : [])].join("\n");
  const nodeBox = [...box.desktop, ...(box.mobile.length ? [`@container atrium-page (max-width: 639.98px){${box.mobile.join("")}}`] : [])].join("\n");
  return { css, refused, nodeBox };
}

/** One readable line per refusal, for the inspector and validate. */
export function refusalText(r: StyleRefusal): string {
  return `${r.slot}${r.state ? ` (${r.state})` : ""}${r.mobile ? " on phones" : ""}: ${r.reason}`;
}
