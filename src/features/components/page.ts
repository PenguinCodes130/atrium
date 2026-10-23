// Page-level helpers over a document (architecture v3 sections 4.5 and 10, amendments A1.2 and A4.3):
// the data sources a page's bindings use, and a guest's server-resolved values. Pure and isomorphic.
import type { AppDocument, BindingScope, ComponentNode, DataSourceDef, LibraryComponent, PageDoc, PropValue, ShapedData } from "@/core/contracts";
import { isBinding, templatesIn } from "./bindings";
import { rootsOf } from "./bindings/parse";
import { expandInstance } from "./library-instance";
import {
  instanceComponent,
  instanceScope,
  libKey,
  nodeStatus,
  nodeVisible,
  repeatItems,
  resolveProps,
  effectiveNode,
  valueKey,
  type PageScope,
} from "./render/resolve";

export function findPage(doc: AppDocument, pageId: string): PageDoc | undefined {
  return doc.pages.find((p) => p.id === pageId || p.slug === pageId);
}

/** Every node of a tree, depth first. */
export function eachNode(root: ComponentNode, fn: (n: ComponentNode, parent: ComponentNode | null) => void, parent: ComponentNode | null = null): void {
  fn(root, parent);
  for (const c of root.children ?? []) eachNode(c, fn, root);
}

/** The data sources the page's bindings reference (props, visibility, html data maps, library instance parameters). */
export function sourcesUsed(doc: AppDocument, pageId: string): DataSourceDef[] {
  const page = findPage(doc, pageId);
  if (!page) return [];
  const names = new Set(doc.dataSources.map((d) => d.name));
  const used = new Set<string>();
  const addTemplate = (t: string) => {
    for (const r of rootsOf(t)) if (names.has(r)) used.add(r);
  };
  eachNode(page.root, (n) => {
    for (const { template } of templatesIn(n.props as PropValue, "props")) addTemplate(template);
    if (n.responsive?.mobile?.props) for (const { template } of templatesIn(n.responsive.mobile.props as PropValue, "props")) addTemplate(template);
    if (isBinding(n.visibleWhen)) addTemplate(n.visibleWhen.$bind);
    // A library instance names its data sources as plain parameter values.
    if (n.type.startsWith("lib:")) for (const v of Object.values(n.props)) if (typeof v === "string" && names.has(v)) used.add(v);
  });
  return doc.dataSources.filter((d) => used.has(d.name));
}

/** The guest scope: data, page and app roots, and the viewer as a guest. */
export function guestScope(doc: AppDocument, page: PageDoc, sources: Record<string, ShapedData>, extra: Partial<PageScope> = {}): PageScope {
  const $data: Record<string, ShapedData | undefined> = {};
  for (const d of doc.dataSources) $data[d.name] = sources[d.name];
  return {
    $data,
    $page: { id: page.id, slug: page.slug, title: page.title },
    $app: { id: "", slug: "", name: doc.app.name },
    $user: { kind: "guest" },
    ...extra,
  } as PageScope;
}

type Lib = Record<string, LibraryComponent>;
let libraryLookup: ((doc: AppDocument) => Lib) | undefined;
/** The library server module registers this so guest resolution can expand library instances. */
export function registerLibraryLookup(fn: (doc: AppDocument) => Lib): void {
  libraryLookup = fn;
}

/**
 * Server side (A1.2): a guest's resolved values for one page, keyed "nodeId:prop" ("nodeId#i:prop"
 * inside repeats). Only bound props are sent (literals are already in the published document), plus
 * "$visible" for nodes with a visibility rule, "$count" for repeats, "$status" for data components and
 * "data" for html blocks (their resolved map only). Never whole sources unless a prop binds one.
 */
export function resolveGuestValues(doc: AppDocument, pageId: string, sources: Record<string, ShapedData>, opts: { library?: Lib; scope?: Partial<PageScope> } = {}): Record<string, unknown> {
  const page = findPage(doc, pageId);
  if (!page) return {};
  const library = opts.library ?? libraryLookup?.(doc) ?? {};
  const out: Record<string, unknown> = {};
  const root = guestScope(doc, page, sources, { $library: library, ...opts.scope });
  const visit = (raw: ComponentNode, scope: PageScope, path: string) => {
    for (const device of ["desktop", "mobile"] as const) {
      if (device === "mobile" && !raw.responsive?.mobile?.props) continue;
      const n = effectiveNode(raw, device);
      const suffix = device === "mobile" ? "@mobile" : "";
      if (device === "desktop" && raw.visibleWhen) {
        const vis = nodeVisible(raw, scope);
        out[valueKey(raw.id, "$visible", path)] = vis.visible;
        if (!vis.visible) return;
      }
      const { props } = resolveProps(n, scope);
      for (const [k, v] of Object.entries(n.props)) {
        if (raw.type === "html" && k === "data") continue;
        if (templatesIn(v as PropValue, k).length) out[valueKey(raw.id, `${k}${suffix}`, path)] = props[k];
      }
      if (device === "desktop") {
        if (raw.type === "html") out[valueKey(raw.id, "data", path)] = props.data ?? {};
        const st = nodeStatus(n, scope);
        if (st.kind !== "none") out[valueKey(raw.id, "$status", path)] = st;
      }
    }
    if (raw.type === "repeat") {
      const { props } = resolveProps(raw, scope);
      const items = repeatItems(props.items, typeof props.max === "number" ? props.max : 50);
      out[valueKey(raw.id, "$count", path)] = items.length;
      const child = raw.children?.[0];
      if (child) items.forEach((item, i) => visit(child, { ...scope, $item: item, $index: i } as PageScope, path ? `${path}.${i}` : String(i)));
      return;
    }
    if (raw.type.startsWith("lib:")) {
      const lib = instanceComponent(raw, scope);
      if (lib) visit(expandInstance(raw, lib), instanceScope(raw, lib, scope), path);
      return;
    }
    for (const c of raw.children ?? []) visit(c, scope, path);
  };
  visit(page.root, root, "");
  return out;
}

/** The library components a document's instances need, as `id@version` keys (for app-builder's loaders). */
export function libraryRefs(doc: AppDocument): { componentId: string; version: number; key: string }[] {
  const seen = new Map<string, { componentId: string; version: number; key: string }>();
  for (const p of doc.pages)
    eachNode(p.root, (n) => {
      if (n.libraryRef) seen.set(libKey(n.libraryRef.componentId, n.libraryRef.version), { ...n.libraryRef, key: libKey(n.libraryRef.componentId, n.libraryRef.version) });
    });
  return [...seen.values()];
}

/** Builds the binding scope for a signed-in page from the stream's values (the shape RenderNode reads). */
export function pageScope(args: {
  doc: AppDocument;
  page: PageDoc;
  appId: string;
  appSlug: string;
  viewer: { kind: "user" | "guest"; name?: string };
  sources?: Record<string, { state: "fresh" | "stale" | "failed" | "empty"; data?: ShapedData; sourceTimestamp?: string; fetchedAt?: string; refreshSec: number; error?: { code: string; message: string; hint?: string } }>;
  available?: boolean;
  guest?: Record<string, unknown>;
  signedUrls?: Record<string, string>;
  library?: Lib;
  theme?: Record<string, string>;
  draftOnlyControls?: string[];
}): PageScope {
  const $data: Record<string, ShapedData | undefined> = {};
  for (const d of args.doc.dataSources) $data[d.name] = args.sources?.[d.name]?.data;
  const $controls: PageScope["$controls"] = {};
  for (const c of args.doc.controls) $controls[c.id] = { label: c.label, ...(c.confirm ? { confirm: c.confirm } : {}), ...(args.draftOnlyControls?.includes(c.id) ? { draftOnly: true } : {}) };
  return {
    $data,
    $sources: args.sources ?? {},
    $available: args.available ?? true,
    ...(args.guest ? { $guest: args.guest } : {}),
    $controls,
    $signedUrls: args.signedUrls ?? {},
    $library: args.library ?? {},
    $pages: args.doc.pages.map((p) => ({ id: p.id, slug: p.slug, title: p.title })),
    ...(args.theme ? { $theme: args.theme } : {}),
    $page: { id: args.page.id, slug: args.page.slug, title: args.page.title },
    $app: { id: args.appId, slug: args.appSlug, name: args.doc.app.name },
    $user: args.viewer,
  } as PageScope & BindingScope;
}
