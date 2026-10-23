// Pure helpers over the app document (architecture v3 sections 4.2 to 4.4). Isomorphic: used by the
// server (ops, validate, diff, guest views) and by the builder in the browser (undo, layers, drag).
import type { AppDocument, Binding, ComponentNode, ControlDef, PageDoc, PropValue } from "@/core/contracts";

// ---- Ids (section 4.3): <prefix>_<10 random base32 chars> ----

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out;
}

export type IdPrefix = "c" | "p" | "k";
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomChars(10)}`;
}
export const ID_PATTERN = /^[cpk]_[a-z2-7]{10}$/;
export function newAppId(): string {
  return `a_${randomChars(12)}`;
}

// ---- Slugs (section 4.2) ----

export const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
/** Page slugs that would shadow builder routes (`/build/<slug>/versions`, `/build/<slug>/settings`). */
export const RESERVED_PAGE_SLUGS = new Set(["versions", "settings", "manifest.webmanifest", "sw.js", "icon"]);

/** The slug the "New app" sheet suggests for a name: lowercase letters, digits and hyphens. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Why a slug is refused, or null. Uniqueness is checked by the caller. */
export function slugProblem(slug: unknown): string | null {
  if (typeof slug !== "string" || slug.length === 0) return "Give the app a URL name.";
  if (slug.length > 40) return "The URL name can be at most 40 characters.";
  if (!SLUG_PATTERN.test(slug)) return "Use only lowercase letters, digits and hyphens.";
  return null;
}

// ---- Unmapped data sources (gauntlet w2-r1 item 2) ----

/**
 * A data source whose integration was skipped when a template was used or an app file imported keeps
 * its place in the document with this placeholder instead of an integration id, so bindings still name
 * a real source and components show "No data: connect <package>" instead of a binding error. The
 * stream never reads it; the review lists one warning for it; mapping it is a normal source.set.
 */
export const UNMAPPED_PREFIX = "$unmapped:";
export function unmappedIntegrationId(packageId: string): string {
  return `${UNMAPPED_PREFIX}${packageId}`;
}
/** The package a placeholder names, or null when the source has a real integration id. */
export function unmappedPackage(integrationId: string): string | null {
  return integrationId.startsWith(UNMAPPED_PREFIX) ? integrationId.slice(UNMAPPED_PREFIX.length) || "unknown" : null;
}

// ---- Bindings ----

export function isBinding(v: unknown): v is Binding {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bind?: unknown }).$bind === "string" && Object.keys(v as object).length === 1;
}

// ---- Trees ----

export type Located = { node: ComponentNode; parent: ComponentNode | null; index: number; page: PageDoc; path: ComponentNode[] };

/** Every node of a page, depth first, with its parent. */
export function* walk(page: PageDoc): Generator<Located> {
  function* rec(node: ComponentNode, parent: ComponentNode | null, index: number, path: ComponentNode[]): Generator<Located> {
    yield { node, parent, index, page, path };
    const kids = node.children ?? [];
    for (let i = 0; i < kids.length; i++) yield* rec(kids[i]!, node, i, [...path, node]);
  }
  yield* rec(page.root, null, 0, []);
}

export function findNode(doc: AppDocument, nodeId: string): Located | null {
  for (const page of doc.pages) for (const l of walk(page)) if (l.node.id === nodeId) return l;
  return null;
}

export function findPage(doc: AppDocument, pageId: string): PageDoc | undefined {
  return doc.pages.find((p) => p.id === pageId);
}

export function pageBySlug(doc: AppDocument, slug: string | undefined): PageDoc | undefined {
  if (!slug) return findPage(doc, doc.app.homePage) ?? orderedPages(doc)[0];
  return doc.pages.find((p) => p.slug === slug);
}

export function orderedPages(doc: AppDocument): PageDoc[] {
  const byId = new Map(doc.pages.map((p) => [p.id, p]));
  const out: PageDoc[] = [];
  for (const id of doc.app.pageOrder) {
    const p = byId.get(id);
    if (p) {
      out.push(p);
      byId.delete(id);
    }
  }
  return [...out, ...byId.values()];
}

export function allNodes(doc: AppDocument): Located[] {
  const out: Located[] = [];
  for (const page of doc.pages) for (const l of walk(page)) out.push(l);
  return out;
}

export function subtreeIds(node: ComponentNode): string[] {
  const out = [node.id];
  for (const c of node.children ?? []) out.push(...subtreeIds(c));
  return out;
}

/** The control a node runs: `control` on button, toggle, slider and select; `controls` on html. */
export function controlsOfNode(node: ComponentNode): string[] {
  if (node.type === "html") {
    const list = node.props.controls;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  }
  if (["button", "toggle", "slider", "select"].includes(node.type)) {
    const c = node.props.control;
    return typeof c === "string" && c ? [c] : [];
  }
  return [];
}

export function nodeLabel(node: ComponentNode): string {
  const name = node.name?.trim();
  const base = node.type.startsWith("lib:") ? "library component" : node.type.startsWith("pkg:") ? node.type.slice(4) : node.type;
  if (name) return `${base} ${name}`;
  if (node.title?.trim()) return `${base} ${node.title.trim().slice(0, 40)}`; // A8.5
  const label = node.props.label ?? node.props.text ?? node.props.title;
  return typeof label === "string" && label.trim() ? `${base} ${label.trim().slice(0, 40)}` : base;
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** JSON Merge Patch (RFC 7386): null removes a key, objects merge, everything else replaces. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || isBinding(patch)) return clone(patch) as T;
  const base: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) && !isBinding(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base as T;
}

/** Stable JSON: sorted keys, 2-space indent (architecture 4.10). */
export function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    return x;
  };
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a ?? null) === stableJson(b ?? null);
}

/** A props bag with no bindings, for places that need literal values only. */
export function literal(v: PropValue | undefined): unknown {
  return isBinding(v) ? undefined : v;
}

export function controlById(doc: AppDocument, id: string): ControlDef | undefined {
  return doc.controls.find((c) => c.id === id);
}

/** A fresh empty page: a 12 column grid root. */
export function emptyPage(title: string, slug: string): PageDoc {
  return { id: newId("p"), slug, title, inNav: true, root: { id: newId("c"), type: "grid", props: {}, children: [] } };
}

/** A blank document, Control Room theme, one Home page. */
export function blankDocument(name: string): AppDocument {
  const home = emptyPage("Home", "home");
  return {
    format: "atrium-app",
    formatVersion: 1,
    app: { name, homePage: home.id, pageOrder: [home.id] },
    theme: { themeId: "control-room" },
    chrome: { layout: "topbar", title: name },
    dataSources: [],
    controls: [],
    pages: [home],
  };
}

/** Rewrites every node, page and control id (templates and imports), keeping references consistent. */
export function rekeyDocument(doc: AppDocument): AppDocument {
  const d = clone(doc);
  const pageIds = new Map<string, string>();
  const controlIds = new Map<string, string>();
  for (const p of d.pages) pageIds.set(p.id, newId("p"));
  for (const c of d.controls) controlIds.set(c.id, newId("k"));
  const rekeyNode = (n: ComponentNode): void => {
    n.id = newId("c");
    if (typeof n.props.control === "string" && controlIds.has(n.props.control)) n.props.control = controlIds.get(n.props.control)!;
    if (n.type === "html" && Array.isArray(n.props.controls)) n.props.controls = n.props.controls.map((x) => (typeof x === "string" && controlIds.has(x) ? controlIds.get(x)! : x));
    for (const c of n.children ?? []) rekeyNode(c);
  };
  for (const p of d.pages) {
    p.id = pageIds.get(p.id)!;
    rekeyNode(p.root);
  }
  for (const c of d.controls) c.id = controlIds.get(c.id)!;
  d.app.homePage = pageIds.get(d.app.homePage) ?? d.pages[0]?.id ?? d.app.homePage;
  d.app.pageOrder = d.app.pageOrder.map((id) => pageIds.get(id)).filter((x): x is string => !!x);
  return d;
}
