// Node resolution shared by the browser renderer and the server's guest resolver (architecture v3
// sections 4.4, 4.5 and 10). Pure and isomorphic: the same node, scope and device always give the
// same props, visibility and data status, so a guest's server-resolved values match what a signed-in
// viewer's browser computes.
import type { BindingScope, ComponentNode, LibraryComponent, PropValue, ShapedData } from "@/core/contracts";
import { evaluateTemplate, isBinding, resolveValue, templatesIn, type BindingFailure, type PropError } from "../bindings";
import { pathsOf, rootsOf } from "../bindings/parse";
import { derivedId } from "../ids";
import { metaFor } from "../catalogue/meta";

export type SourceState = { state?: "fresh" | "stale" | "failed" | "empty"; sourceTimestamp?: string; fetchedAt?: string; refreshSec?: number; error?: { code: string; message: string; hint?: string } };

/** Labels the render context's control list carries (architecture 6.2 and A1.4). */
export type ControlInfo = { label: string; confirm?: string; draftOnly?: boolean };

/**
 * The page scope: the frozen BindingScope plus the extras the renderer reads (all optional).
 * `$sources` carries each data source's state from the page stream; `$available: false` means the
 * app-access hook is not registered yet; `$guest` holds a guest's resolved values ("nodeId:prop").
 */
export type PageScope = BindingScope & {
  $sources?: Record<string, SourceState | undefined>;
  $available?: boolean;
  $guest?: Record<string, unknown>;
  $controls?: Record<string, ControlInfo>;
  $signedUrls?: Record<string, string>;
  $library?: Record<string, LibraryComponent>;
  $pages?: { id: string; slug: string; title: string }[];
  $theme?: Record<string, string>;
  $now?: number;
  $tzOffsetMin?: number;
  /** Inside a library instance: which data source each data parameter points at. */
  $paramSources?: Record<string, string>;
  /** A8.6: each data source's name in words, for labels and title fallbacks ("CPU in use, ACE"). */
  $sourceLabels?: Record<string, string>;
  /** A8.4: inside a Repeat, the format of each column of "this row". */
  $itemFormats?: Record<string, import("@/core/contracts").ValueFormat>;
};

export type Device = "desktop" | "mobile";

export const NOT_SHARED = "No data: this integration is no longer shared";
export const NOT_AVAILABLE = "Not available yet";

export type NodeStatus =
  | { kind: "none" }
  | { kind: "ok" | "stale"; updatedAt?: string }
  | { kind: "failed"; message: string; hint?: string; updatedAt?: string; hasData: boolean }
  | { kind: "empty"; message?: string; href?: string }
  | { kind: "loading" }
  | { kind: "not_shared"; message: string }
  | { kind: "not_available"; message: string };

/** The node as it applies on this device: mobile slot, props and style replace the desktop ones. */
export function effectiveNode(node: ComponentNode, device: Device): ComponentNode {
  const m = device === "mobile" ? node.responsive?.mobile : undefined;
  if (!m) return node;
  return {
    ...node,
    slot: m.slot ?? node.slot,
    props: m.props ? { ...node.props, ...m.props } : node.props,
    style: m.style ? { ...(node.style ?? {}), ...m.style } : node.style,
  };
}

/** Hidden on this device: phones read responsive.mobile.hidden, desktop the node's own `hidden` (A7.3). */
export function hiddenOnDevice(node: ComponentNode, device: Device): boolean {
  return device === "mobile" ? node.responsive?.mobile?.hidden === true : node.hidden === true;
}

/** Props with the type's defaults underneath. */
export function withDefaults(node: ComponentNode): Record<string, PropValue> {
  const meta = metaFor(node.type);
  return meta ? { ...meta.defaults, ...node.props } : node.props;
}

export type Resolved = { props: Record<string, unknown>; errors: PropError[] };

export function resolveProps(node: ComponentNode, scope: PageScope): Resolved {
  const errors: PropError[] = [];
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(withDefaults(node))) {
    // The html block's data map resolves entry by entry; its code is never evaluated.
    props[k] = resolveValue(v, scope, k, errors);
  }
  return { props, errors };
}

/** Visibility: a falsy or failing visibleWhen hides the node. */
export function nodeVisible(node: ComponentNode, scope: PageScope): { visible: boolean; error?: BindingFailure } {
  if (!node.visibleWhen) return { visible: true };
  if (!isBinding(node.visibleWhen)) return { visible: !!node.visibleWhen };
  const r = evaluateTemplate(node.visibleWhen.$bind, scope);
  if (!r.ok) return { visible: false, error: r.error };
  const v = r.value;
  return { visible: Array.isArray(v) ? v.length > 0 : !!v };
}

/** Data source names a node's props read (visibility excluded), through $param when inside an instance. */
export function nodeSources(node: ComponentNode, scope?: PageScope): string[] {
  const out = new Set<string>();
  for (const { template } of templatesIn(node.props as PropValue, "props")) {
    for (const r of rootsOf(template)) if (!r.startsWith("$")) out.add(r);
    if (scope?.$paramSources) {
      for (const p of pathsOf(template)) {
        const m = /^\$param\.([A-Za-z_][A-Za-z0-9_]*)/.exec(p);
        const src = m ? scope.$paramSources[m[1]!] : undefined;
        if (src) out.add(src);
      }
    }
  }
  return [...out];
}

const RANK: Record<string, number> = { not_available: 7, not_shared: 6, loading: 5, empty: 4, failed: 3, stale: 2, ok: 1, none: 0 };

/** The data status a data component shows (spec section 4): the worst state among the sources it reads. */
export function nodeStatus(node: ComponentNode, scope: PageScope): NodeStatus {
  const names = nodeSources(node, scope);
  if (!names.length) return { kind: "none" };
  if (scope.$available === false) return { kind: "not_available", message: NOT_AVAILABLE };
  let worst: NodeStatus | null = null;
  for (const name of names) {
    const s = scope.$sources?.[name];
    const data = scope.$data?.[name];
    let st: NodeStatus;
    if (s?.error?.code === "permission" && s.error.message === NOT_SHARED) st = { kind: "not_shared", message: NOT_SHARED };
    else if (!s && data === undefined) st = scope.$sources ? { kind: "loading" } : { kind: "ok" };
    else if (s?.state === "empty" || (data === undefined && s?.state !== "failed")) {
      // An unconnected source (app-builder's "Skip for now") links to where it gets connected: own paths only.
      const hint = s?.error?.code === "unmapped" ? s.error.hint : undefined;
      st = { kind: "empty", message: s?.error?.message, ...(hint && /^\/(?!\/)/.test(hint) ? { href: hint } : {}) };
    }
    else if (s?.state === "failed") st = { kind: "failed", message: s.error?.message ?? "The last refresh failed.", hint: s.error?.hint, updatedAt: s.sourceTimestamp ?? s.fetchedAt, hasData: data !== undefined };
    else if (s?.state === "stale") st = { kind: "stale", updatedAt: s.sourceTimestamp ?? s.fetchedAt };
    else st = { kind: "ok", updatedAt: s?.sourceTimestamp ?? s?.fetchedAt };
    if (st.kind === "failed" && !st.hasData) st = { kind: "empty", message: st.message };
    if (!worst || RANK[st.kind]! > RANK[worst.kind]!) worst = st;
  }
  return worst ?? { kind: "ok" };
}

/** The list a repeat draws: an array, or a table's rows, or a status source's items. */
export function repeatItems(v: unknown, max = 200): unknown[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else if (v && typeof v === "object") {
    const o = v as { rows?: unknown; items?: unknown };
    if (Array.isArray(o.rows)) list = o.rows;
    else if (Array.isArray(o.items)) list = o.items;
  }
  return list.slice(0, Math.max(0, Math.min(200, max)));
}

/** A guest value key: "nodeId:prop", with the repeat item path when inside repeats ("nodeId#0.2:prop"). */
export function valueKey(nodeId: string, prop: string, path = ""): string {
  return `${nodeId}${path ? `#${path}` : ""}:${prop}`;
}

// ---------- library instances ----------

export const libKey = (componentId: string, version: number) => `${componentId}@${version}`;

/** The library component an instance shows, at its pinned version, or undefined when missing. */
export function instanceComponent(node: ComponentNode, scope: PageScope): LibraryComponent | undefined {
  if (!node.libraryRef) return undefined;
  return scope.$library?.[libKey(node.libraryRef.componentId, node.libraryRef.version)];
}

/** Rewrites every id in a saved subtree to one derived from the instance, so ids stay unique and stable. */
export function instanceTree(instanceId: string, lib: ComponentNode): ComponentNode {
  const walk = (n: ComponentNode): ComponentNode => ({ ...n, id: derivedId(`${instanceId}/${n.id}`), ...(n.children ? { children: n.children.map(walk) } : {}) });
  return walk(lib);
}

/** The scope inside an instance: $param from its props; data parameters point at the chosen sources. */
export function instanceScope(node: ComponentNode, lib: LibraryComponent, scope: PageScope): PageScope {
  const $param: Record<string, unknown> = {};
  const $paramSources: Record<string, string> = {};
  for (const p of lib.params) {
    const raw = Object.prototype.hasOwnProperty.call(node.props, p.name) ? node.props[p.name] : p.default;
    if (p.kind === "data") {
      const name = typeof raw === "string" ? raw : "";
      $param[p.name] = name ? scope.$data?.[name] : undefined;
      if (name) $paramSources[p.name] = name;
    } else {
      const errors: PropError[] = [];
      $param[p.name] = resolveValue(raw as PropValue, scope, p.name, errors);
    }
  }
  return { ...scope, $param, $paramSources };
}

/** Data sources named by a shaped-data map, as the scope's $data. */
export function dataScope(sources: Record<string, ShapedData | undefined>): Record<string, ShapedData | undefined> {
  return { ...sources };
}
