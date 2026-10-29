// diffDocuments (architecture v3 section 4.9): matches pages, nodes, sources and controls by id, and the
// readable lines the versions screen and the publish review show ("Added toggle Bedroom lamp to Guest
// room"). Pure and isomorphic.
import type { AppDocument, ComponentNode, PageDoc, ThemeRef, VersionDiff } from "@/core/contracts";
import { nodeLabel, sameJson, walk } from "@/features/apps/doc";

type NodeInfo = { node: ComponentNode; page: PageDoc; parentId: string | null; index: number };

function nodesOf(doc: AppDocument): Map<string, NodeInfo> {
  const out = new Map<string, NodeInfo>();
  for (const page of doc.pages) for (const l of walk(page)) out.set(l.node.id, { node: l.node, page, parentId: l.parent?.id ?? null, index: l.index });
  return out;
}

const PROP_KEYS = ["type", "name", "props", "visibleWhen", "libraryRef"] as const;
const STYLE_KEYS = ["style", "overrideTheme"] as const;

function pick(n: ComponentNode, keys: readonly string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) o[k] = (n as Record<string, unknown>)[k];
  return o;
}

/**
 * Whether two theme references name the same theme. A published version holds an inline snapshot of
 * the theme the draft names by id (4.9), so a snapshot and a reference with the same theme id are the
 * same theme here; two inline copies (or two references) compare whole. Without this, every review
 * after a first publish listed a phantom "Changed the theme" (gauntlet w2-r1 item 8).
 */
export function sameTheme(a: ThemeRef | undefined | null, b: ThemeRef | undefined | null): boolean {
  if (!a || !b) return !a && !b;
  const inlineA = "inline" in a;
  const inlineB = "inline" in b;
  if (inlineA === inlineB) return sameJson(a, b);
  const idOf = (r: ThemeRef) => ("inline" in r ? r.inline?.id : r.themeId);
  return idOf(a) === idOf(b);
}

export function emptyDiff(): VersionDiff {
  return { app: [], theme: false, chrome: [], pages: { added: [], removed: [], changed: [], moved: [] }, nodes: { added: [], removed: [], moved: [], props: [], style: [], code: [] }, sources: { added: [], removed: [], changed: [] }, controls: { added: [], removed: [], changed: [] } };
}

/** Structural diff from `a` (older, may be null for "nothing published") to `b`. */
export function diffDocuments(a: AppDocument | null, b: AppDocument): VersionDiff {
  const d = emptyDiff();
  if (!a) {
    d.pages.added = b.pages.map((p) => p.id);
    for (const [id] of nodesOf(b)) d.nodes.added.push(id);
    d.sources.added = b.dataSources.map((s) => s.name);
    d.controls.added = b.controls.map((c) => c.id);
    d.theme = true;
    return d;
  }
  for (const k of ["name", "icon", "homePage", "pageOrder"] as const) if (!sameJson(a.app[k], b.app[k])) d.app.push(k);
  d.theme = !sameTheme(a.theme, b.theme);
  for (const k of new Set([...Object.keys(a.chrome), ...Object.keys(b.chrome)])) if (!sameJson((a.chrome as Record<string, unknown>)[k], (b.chrome as Record<string, unknown>)[k])) d.chrome.push(k);

  const pa = new Map(a.pages.map((p) => [p.id, p]));
  const pb = new Map(b.pages.map((p) => [p.id, p]));
  for (const [id, p] of pb) {
    const old = pa.get(id);
    if (!old) { d.pages.added.push(id); continue; }
    const strip = (x: PageDoc) => ({ slug: x.slug, title: x.title, icon: x.icon, inNav: x.inNav });
    if (!sameJson(strip(old), strip(p)) || !sameTheme(old.theme, p.theme)) d.pages.changed.push(id);
    if (a.app.pageOrder.indexOf(id) !== b.app.pageOrder.indexOf(id)) d.pages.moved.push(id);
  }
  for (const id of pa.keys()) if (!pb.has(id)) d.pages.removed.push(id);

  const na = nodesOf(a);
  const nb = nodesOf(b);
  for (const [id, x] of nb) {
    const old = na.get(id);
    if (!old) { d.nodes.added.push(id); continue; }
    if (old.parentId !== x.parentId || old.index !== x.index || old.page.id !== x.page.id || !sameJson(old.node.slot, x.node.slot) || !sameJson(old.node.responsive, x.node.responsive)) d.nodes.moved.push(id);
    if (!sameJson(pick(old.node, PROP_KEYS), pick(x.node, PROP_KEYS))) d.nodes.props.push(id);
    if (!sameJson(pick(old.node, STYLE_KEYS), pick(x.node, STYLE_KEYS))) d.nodes.style.push(id);
    if (!sameJson(old.node.css, x.node.css) || (x.node.type === "html" && !sameJson([old.node.props.html, old.node.props.css, old.node.props.js], [x.node.props.html, x.node.props.css, x.node.props.js]))) d.nodes.code.push(id);
  }
  for (const id of na.keys()) if (!nb.has(id)) d.nodes.removed.push(id);
  // A moved node whose index changed only because a sibling was added or removed is not a move.
  d.nodes.moved = d.nodes.moved.filter((id) => {
    const o = na.get(id)!;
    const n = nb.get(id)!;
    if (o.parentId !== n.parentId || o.page.id !== n.page.id || !sameJson(o.node.slot, n.node.slot) || !sameJson(o.node.responsive, n.node.responsive)) return true;
    const siblingsBefore = (doc: Map<string, NodeInfo>, info: NodeInfo, other: Map<string, NodeInfo>) => [...doc.values()].filter((v) => v.parentId === info.parentId && other.has(v.node.id) && v.index < info.index).length;
    return siblingsBefore(na, o, nb) !== siblingsBefore(nb, n, na);
  });

  const sa = new Map(a.dataSources.map((s) => [s.name, s]));
  const sb = new Map(b.dataSources.map((s) => [s.name, s]));
  for (const [k, s] of sb) { const o = sa.get(k); if (!o) d.sources.added.push(k); else if (!sameJson(o, s)) d.sources.changed.push(k); }
  for (const k of sa.keys()) if (!sb.has(k)) d.sources.removed.push(k);

  const ca = new Map(a.controls.map((c) => [c.id, c]));
  const cb = new Map(b.controls.map((c) => [c.id, c]));
  for (const [k, c] of cb) { const o = ca.get(k); if (!o) d.controls.added.push(k); else if (!sameJson(o, c)) d.controls.changed.push(k); }
  for (const k of ca.keys()) if (!cb.has(k)) d.controls.removed.push(k);
  return d;
}

export function isEmptyDiff(d: VersionDiff): boolean {
  return !d.theme && d.app.length + d.chrome.length + Object.values(d.pages).flat().length + Object.values(d.nodes).flat().length + Object.values(d.sources).flat().length + Object.values(d.controls).flat().length === 0;
}

export type DiffLine = { kind: "added" | "removed" | "changed"; text: string };
export type DiffGroup = { pageId: string | null; title: string; lines: DiffLine[] };

/** Readable lines grouped by page; app-wide changes (theme, navigation, sources, controls) come first. */
export function readableDiff(a: AppDocument | null, b: AppDocument, diff: VersionDiff = diffDocuments(a, b)): DiffGroup[] {
  const app: DiffGroup = { pageId: null, title: "App", lines: [] };
  const groups = new Map<string, DiffGroup>();
  const group = (page: PageDoc) => {
    let g = groups.get(page.id);
    if (!g) { g = { pageId: page.id, title: page.title, lines: [] }; groups.set(page.id, g); }
    return g;
  };
  const na = a ? nodesOf(a) : new Map<string, NodeInfo>();
  const nb = nodesOf(b);
  const pageOfB = (id: string) => b.pages.find((p) => p.id === id);
  const pageOfA = (id: string) => a?.pages.find((p) => p.id === id);
  if (diff.app.includes("name")) app.lines.push({ kind: "changed", text: `Renamed the app to ${b.app.name}` });
  if (diff.app.includes("homePage")) app.lines.push({ kind: "changed", text: `Made ${pageOfB(b.app.homePage)?.title ?? "another page"} the home page` });
  if (diff.app.includes("icon")) app.lines.push({ kind: "changed", text: "Changed the app icon" });
  if (diff.theme && a) app.lines.push({ kind: "changed", text: "Changed the theme" });
  if (diff.chrome.length) app.lines.push({ kind: "changed", text: diff.chrome.some((k) => k === "css" || k === "style") ? "Changed the style of the app's navigation" : "Changed the app's navigation" });
  // Round 2 item 16: sources read in words. A managed source (A10.1) is named by its read, never by its
  // generated d_... name: "Added data: CPU in use, pve1".
  const src = (doc: AppDocument | null, n: string) => {
    const d = doc?.dataSources.find((s) => s.name === n);
    // Round 3 (recheck item 16): a named source reads by its label too ("Everything about a machine, every
    // machine"), never by a key the picker made for it, such as everything_about_a.
    const label = d?.label?.trim();
    return d?.managed ? `data: ${label || "a read from one of your services"}` : `data source ${label || (/^d_[a-z0-9]{4,}$/i.test(n) ? "a read from one of your services" : n)}`;
  };
  // A managed source comes and goes with its component, whose own line says so (A10.1): no line of its own.
  const managedIn = (doc: AppDocument | null, n: string) => !!doc?.dataSources.find((s) => s.name === n)?.managed;
  for (const n of diff.sources.added) if (!managedIn(b, n)) app.lines.push({ kind: "added", text: `Added ${src(b, n)}` });
  for (const n of diff.sources.removed) if (!managedIn(a, n)) app.lines.push({ kind: "removed", text: `Removed ${src(a, n)}` });
  for (const n of diff.sources.changed) app.lines.push({ kind: "changed", text: `Changed ${src(b, n)}` });
  const ctl = (doc: AppDocument | null, id: string) => doc?.controls.find((c) => c.id === id)?.label ?? id;
  for (const id of diff.controls.added) app.lines.push({ kind: "added", text: `Added control ${ctl(b, id)}` });
  for (const id of diff.controls.removed) app.lines.push({ kind: "removed", text: `Removed control ${ctl(a, id)}` });
  for (const id of diff.controls.changed) app.lines.push({ kind: "changed", text: `Changed control ${ctl(b, id)}` });

  for (const id of diff.pages.added) { const p = pageOfB(id); if (p) group(p).lines.push({ kind: "added", text: `Added page ${p.title}` }); }
  for (const id of diff.pages.removed) { const p = pageOfA(id); if (p) { const g: DiffGroup = groups.get(p.id) ?? { pageId: p.id, title: p.title, lines: [] }; groups.set(p.id, g); g.lines.push({ kind: "removed", text: `Removed page ${p.title}` }); } }
  for (const id of diff.pages.changed) { const p = pageOfB(id); if (p) group(p).lines.push({ kind: "changed", text: `Changed page ${p.title}` }); }
  for (const id of diff.pages.moved) { const p = pageOfB(id); if (p) group(p).lines.push({ kind: "changed", text: `Moved page ${p.title}` }); }
  const addedPages = new Set(diff.pages.added);
  for (const id of diff.nodes.added) {
    const x = nb.get(id)!;
    if (addedPages.has(x.page.id) || x.parentId === null) continue;
    group(x.page).lines.push({ kind: "added", text: `Added ${nodeLabel(x.node)} to ${x.page.title}` });
  }
  const removedPages = new Set(diff.pages.removed);
  for (const id of diff.nodes.removed) {
    const x = na.get(id)!;
    if (removedPages.has(x.page.id) || x.parentId === null) continue;
    const g = groups.get(x.page.id) ?? (() => { const ng: DiffGroup = { pageId: x.page.id, title: x.page.title, lines: [] }; groups.set(x.page.id, ng); return ng; })();
    g.lines.push({ kind: "removed", text: `Removed ${nodeLabel(x.node)} from ${x.page.title}` });
  }
  for (const id of diff.nodes.moved) { const x = nb.get(id)!; group(x.page).lines.push({ kind: "changed", text: `Moved ${nodeLabel(x.node)}` }); }
  for (const id of diff.nodes.props) { const x = nb.get(id)!; group(x.page).lines.push({ kind: "changed", text: `Changed ${nodeLabel(x.node)}` }); }
  for (const id of diff.nodes.style) { const x = nb.get(id)!; group(x.page).lines.push({ kind: "changed", text: `Changed the style of ${nodeLabel(x.node)}` }); }
  for (const id of diff.nodes.code) { const x = nb.get(id)!; group(x.page).lines.push({ kind: "changed", text: `Changed the code of ${nodeLabel(x.node)}` }); }
  const order = b.app.pageOrder;
  const pages = [...groups.values()].sort((x, y) => (order.indexOf(x.pageId ?? "") + 1 || 9999) - (order.indexOf(y.pageId ?? "") + 1 || 9999));
  return [...(app.lines.length ? [app] : []), ...pages.filter((g) => g.lines.length)];
}
