// Wave 2.10c R1: per-copy changes inside a Repeat (and a roulette in repeat mode). The repeat's optional prop
// `copyOverrides` maps a row's stable key to changes for nodes of the template, by node id:
//   { [rowKey]: { [childNodeId]: { props?: {...}; style?: {...}; hidden?: boolean } } }
// The renderer merges a row's changes over the template for that row only. An override for a row that no
// longer exists is ignored and kept (the row may come back). Pure and isomorphic: the browser renderer and
// the server's guest resolver use the same functions, so both draw the same copy.
import type { ComponentNode, PropValue, StyleOverride } from "@/core/contracts";

export type CopyOverride = { props?: Record<string, PropValue>; style?: StyleOverride; hidden?: boolean };
export type CopyOverrides = Record<string, Record<string, CopyOverride>>;

/** The prop that holds the per-copy changes. It is never resolved as a binding on the repeat itself. */
export const COPY_OVERRIDES = "copyOverrides";
/** Types whose template copies can carry per-copy changes. */
export const COPY_TYPES: ReadonlySet<string> = new Set(["repeat", "roulette"]);

/** Fields of a row that name it, in the order they are tried (a machine's name, a status item's label). */
export const ROW_NAME_FIELDS = ["name", "machine", "instance", "host", "hostname", "node", "label", "title", "entity", "id", "key"] as const;

/** True for a node that draws one template once per row: a repeat, or a roulette in repeat mode (A11.4). */
export function repeatsTemplate(node: Pick<ComponentNode, "type" | "props">): boolean {
  return node.type === "repeat" || (node.type === "roulette" && node.props?.mode === "repeat");
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The row's own name: the first non-empty name field, or the value itself for a plain text or number row. */
export function rowName(item: unknown): string | null {
  if (typeof item === "string") return item.trim() ? item.trim().slice(0, 200) : null;
  if (typeof item === "number" && Number.isFinite(item)) return String(item);
  if (!isObj(item)) return null;
  for (const f of ROW_NAME_FIELDS) {
    const v = item[f];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Stable keys for a list of rows: each row's name when it has one ("pve1"), so a copy keeps its changes
 * when rows move or new ones arrive. A second row with the same name gets "pve1 (2)". Only a row with no
 * name at all falls back to its place ("#3"), as nothing else can tell it apart.
 */
export function rowKeys(items: readonly unknown[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item, i) => {
    const base = rowName(item) ?? `#${i}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** The copy overrides a node carries, cleaned: only objects of objects are kept (anything else reads as none). */
export function copyOverridesOf(node: Pick<ComponentNode, "type" | "props"> | undefined): CopyOverrides {
  const raw = node && repeatsTemplate(node) ? node.props?.[COPY_OVERRIDES] : undefined;
  if (!isObj(raw)) return {};
  const out: CopyOverrides = {};
  for (const [rowKey, byNode] of Object.entries(raw)) {
    if (!isObj(byNode)) continue;
    const row: Record<string, CopyOverride> = {};
    for (const [nodeId, raw] of Object.entries(byNode)) {
      if (!isObj(raw)) continue;
      const ov = raw as Record<string, unknown>;
      const o: CopyOverride = {};
      if (isObj(ov.props)) o.props = ov.props as Record<string, PropValue>;
      if (isObj(ov.style)) o.style = ov.style as StyleOverride;
      if (typeof ov.hidden === "boolean") o.hidden = ov.hidden;
      if (o.props || o.style || o.hidden !== undefined) row[nodeId] = o;
    }
    if (Object.keys(row).length) out[rowKey] = row;
  }
  return out;
}

/** True when the row's changes touch at least one node of the template (others are kept but unused). */
export function hasCopyChange(template: ComponentNode, row: Record<string, CopyOverride> | undefined): boolean {
  if (!row) return false;
  const ids = new Set<string>();
  const walk = (n: ComponentNode) => {
    ids.add(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  walk(template);
  return Object.keys(row).some((id) => ids.has(id));
}

function mergeStyle(base: StyleOverride | undefined, over: StyleOverride): StyleOverride {
  const out: StyleOverride = { ...(base ?? {}) };
  for (const [slot, props] of Object.entries(over)) {
    if (!isObj(props)) continue;
    const b = out[slot] ?? {};
    const states = isObj(props.states) || isObj(b.states) ? { ...(b.states ?? {}), ...((props.states as object) ?? {}) } : undefined;
    out[slot] = { ...b, ...props, ...(states ? { states } : {}) };
  }
  return out;
}

/**
 * Remembers which drawn node a copy came from, so the renderer can give a copy with its own style a CSS
 * scope of its own (copyCssId) without changing the node's id (the builder still selects it by id).
 */
const COPY_ORIGIN = new WeakMap<ComponentNode, { rowKey: string; styled: boolean }>();
export function copyOrigin(node: ComponentNode): { rowKey: string; styled: boolean } | undefined {
  return COPY_ORIGIN.get(node);
}

/**
 * The template as one row draws it: each node with changes for this row gets them merged over its own
 * (props and style key by key, hidden replacing hidden on every device). Nodes without changes are the
 * same objects as before, so nothing else re-renders. Ids never change.
 */
export function applyCopyOverride(template: ComponentNode, rowKey: string, row: Record<string, CopyOverride> | undefined): ComponentNode {
  if (!row || !Object.keys(row).length) return template;
  const walk = (n: ComponentNode): ComponentNode => {
    const ov = row[n.id];
    const kids = n.children?.map(walk);
    const kidsChanged = !!kids && kids.some((k, i) => k !== n.children![i]);
    if (!ov && !kidsChanged) return n;
    let out: ComponentNode = kidsChanged ? { ...n, children: kids } : { ...n };
    if (ov?.props) out.props = { ...n.props, ...ov.props };
    if (ov?.style) {
      out.style = mergeStyle(n.overrideTheme ? n.style : undefined, ov.style);
      out.overrideTheme = true;
    }
    if (ov?.hidden !== undefined) {
      out.hidden = ov.hidden;
      out = { ...out, responsive: { ...(n.responsive ?? {}), mobile: { ...(n.responsive?.mobile ?? {}), hidden: ov.hidden } } };
    }
    if (ov) COPY_ORIGIN.set(out, { rowKey, styled: !!ov.style });
    return out;
  };
  return walk(template);
}

/** A short stable hash of a row key, in letters and digits (for CSS scope ids). */
export function keyHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * The CSS scope id of a copy with its own style: the node id plus a hash of the row key. It passes the node
 * id check of the CSS sanitiser ([A-Za-z0-9_-], at most 64), so the copy's CSS is compiled and sanitised
 * exactly as a node's is, then pointed at `[data-node="<id>"][data-copy-css="<scope>"]` (copyScopedCss).
 */
export function copyCssId(nodeId: string, rowKey: string): string {
  return `${nodeId.slice(0, 50)}-r${keyHash(rowKey)}`.slice(0, 64);
}

/**
 * Compiled, sanitised CSS for a copy's scope, pointed at that copy only. The sanitiser scopes every rule to
 * `[data-node="<scope>"]`; the copy carries its node's real id plus `data-copy-css="<scope>"`, and the two
 * attributes together outrank the template's own rules, so the copy's change wins wherever its style tag is.
 * The scope is a checked id (no quotes or brackets), so this exact replacement cannot form a new selector.
 */
export function copyScopedCss(css: string, nodeId: string, scope: string): string {
  if (!css || !/^[A-Za-z0-9_-]{1,64}$/.test(scope) || !/^[A-Za-z0-9_-]{1,64}$/.test(nodeId)) return "";
  return css.split(`[data-node="${scope}"]`).join(`[data-node="${nodeId}"][data-copy-css="${scope}"]`);
}
