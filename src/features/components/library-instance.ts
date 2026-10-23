// Library components as data (architecture v3 section 4.8, amendment A4.2, spec 3.6): turning a
// subtree into parameters, expanding and detaching instances, and the readable diff behind
// "Update to vN". Pure and isomorphic; storage lives in src/features/library/.
import type { AppDocument, Binding, ComponentNode, LibraryComponent, LibraryParam, PropValue } from "@/core/contracts";
import { isBinding } from "./bindings";
import { rewriteRoots, rootsOf } from "./bindings/parse";
import { newId } from "./ids";
import { instanceTree } from "./render/resolve";

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const CONTROL_ID = /^k_[a-z2-7]{10}$/;
const CONTROL_PROP_TYPES = new Set(["button", "toggle", "slider", "select"]);
const paramBind = (name: string): Binding => ({ $bind: `{{ $param.${name} }}` });

export type Promotion = { nodeId: string; prop: string; name: string; label?: string; kind: "text" | "number" | "color" | "boolean" };

function mapProps(v: PropValue, fn: (b: Binding) => PropValue): PropValue {
  if (isBinding(v)) return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapProps(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapProps(x as PropValue, fn)]));
  return v;
}

function mapTree(n: ComponentNode, fn: (n: ComponentNode) => ComponentNode): ComponentNode {
  const m = fn(n);
  return m.children ? { ...m, children: m.children.map((c) => mapTree(c, fn)) } : m;
}

/**
 * Saving to the library: data source names become data parameters (`{{ cpu.value }}` turns into
 * `{{ $param.cpu.value }}`) and control ids become control parameters. Promoted props become text,
 * number, colour or boolean parameters with their current value as the default.
 */
export function parameterize(subtree: ComponentNode, doc: Pick<AppDocument, "dataSources" | "controls">, promote: Promotion[] = []): { node: ComponentNode; params: LibraryParam[] } {
  const sources = new Set(doc.dataSources.map((d) => d.name));
  const controlLabels = new Map(doc.controls.map((c) => [c.id, c.label]));
  const params: LibraryParam[] = [];
  const dataParams = new Set<string>();
  const controlParams = new Map<string, string>();
  const controlParam = (id: string) => {
    let name = controlParams.get(id);
    if (!name) {
      name = `control${controlParams.size + 1}`;
      controlParams.set(id, name);
      params.push({ name, label: controlLabels.get(id) ?? id, kind: "control", default: id });
    }
    return name;
  };
  const rewrite = (t: string) =>
    rewriteRoots(t, (name) => {
      if (name.startsWith("$") || !sources.has(name)) return null;
      if (!dataParams.has(name)) {
        dataParams.add(name);
        params.push({ name, label: name, kind: "data", default: name });
      }
      return { text: `$param.${name}` };
    });
  const node = mapTree(structuredClone(subtree), (n) => {
    let props = mapProps(n.props as PropValue, (b) => ({ $bind: rewrite(b.$bind) })) as Record<string, PropValue>;
    if (CONTROL_PROP_TYPES.has(n.type) && typeof props.control === "string" && CONTROL_ID.test(props.control)) props = { ...props, control: paramBind(controlParam(props.control)) };
    if (n.type === "html" && Array.isArray(props.controls)) props = { ...props, controls: props.controls.map((c) => (typeof c === "string" && CONTROL_ID.test(c) ? paramBind(controlParam(c)) : c)) };
    const visibleWhen = n.visibleWhen && isBinding(n.visibleWhen) ? { $bind: rewrite(n.visibleWhen.$bind) } : n.visibleWhen;
    const mobile = n.responsive?.mobile?.props ? (mapProps(n.responsive.mobile.props as PropValue, (b) => ({ $bind: rewrite(b.$bind) })) as Record<string, PropValue>) : undefined;
    for (const p of promote.filter((x) => x.nodeId === n.id && PARAM_NAME.test(x.name))) {
      if (params.some((q) => q.name === p.name)) continue;
      params.push({ name: p.name, label: p.label ?? p.name, kind: p.kind, ...(props[p.prop] !== undefined && !isBinding(props[p.prop]) ? { default: props[p.prop] } : {}) });
      props = { ...props, [p.prop]: paramBind(p.name) };
    }
    const libraryRef = undefined;
    return { ...n, props, ...(visibleWhen ? { visibleWhen } : {}), ...(mobile ? { responsive: { ...n.responsive, mobile: { ...n.responsive!.mobile, props: mobile } } } : {}), libraryRef };
  });
  return { node: stripUndefined(node), params };
}

function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function containsCode(node: ComponentNode): boolean {
  return node.type === "html" || (node.children ?? []).some(containsCode);
}

/** A fresh instance node of a library component, pinned to its current version, params at their defaults. */
export function instanceNodeFor(c: Pick<LibraryComponent, "id" | "name" | "version" | "params">): ComponentNode {
  const props: Record<string, PropValue> = {};
  for (const p of c.params) if (p.default !== undefined) props[p.name] = p.default;
  return { id: newId("c"), type: `lib:${c.id}`, name: c.name, props, libraryRef: { componentId: c.id, version: c.version } };
}

/** What an instance renders: the saved subtree with derived ids and control parameters filled with real control ids. */
export function expandInstance(instance: ComponentNode, lib: LibraryComponent): ComponentNode {
  const controls = new Map<string, string>();
  for (const p of lib.params) if (p.kind === "control") {
    const v = Object.prototype.hasOwnProperty.call(instance.props, p.name) ? instance.props[p.name] : p.default;
    if (typeof v === "string") controls.set(p.name, v);
  }
  const fill = (v: PropValue): PropValue => {
    if (isBinding(v)) {
      const m = /^\{\{\s*\$param\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(v.$bind);
      if (m && controls.has(m[1]!)) return controls.get(m[1]!)!;
      return v;
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x as PropValue)]));
    return v;
  };
  return mapTree(instanceTree(instance.id, lib.node), (n) => ({ ...n, props: fill(n.props as PropValue) as Record<string, PropValue> }));
}

const jsonLiteral = (v: unknown) => (typeof v === "string" ? `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : typeof v === "number" || typeof v === "boolean" || v === null ? String(v) : "null");

/** "Detach": the instance becomes a plain subtree with fresh ids and no library reference; parameters are inlined. */
export function detachInstance(instance: ComponentNode, lib: LibraryComponent): ComponentNode {
  const values = new Map<string, { kind: LibraryParam["kind"]; value: unknown }>();
  for (const p of lib.params) values.set(p.name, { kind: p.kind, value: Object.prototype.hasOwnProperty.call(instance.props, p.name) ? instance.props[p.name] : p.default });
  const inline = (t: string): PropValue => {
    const whole = /^\{\{\s*\$param\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(t);
    if (whole) {
      const v = values.get(whole[1]!);
      if (v && v.kind !== "data") return (v.value ?? null) as PropValue;
    }
    const out = rewriteRoots(t, (name, next) => {
      if (name !== "$param" || !next) return null;
      const v = values.get(next);
      if (!v) return null;
      if (v.kind === "data") return typeof v.value === "string" && v.value ? { text: v.value, consumeNext: true } : null;
      return { text: jsonLiteral(v.value), consumeNext: true };
    });
    return { $bind: out };
  };
  const expanded = expandInstance(instance, lib);
  const fresh = new Map<string, string>();
  return mapTree(expanded, (n) => {
    const props = mapProps(n.props as PropValue, (b) => inline(b.$bind)) as Record<string, PropValue>;
    const visibleWhen = n.visibleWhen && isBinding(n.visibleWhen) ? (inline(n.visibleWhen.$bind) as Binding) : n.visibleWhen;
    if (!fresh.has(n.id)) fresh.set(n.id, newId("c"));
    const { libraryRef: _drop, ...rest } = n;
    void _drop;
    return { ...rest, id: fresh.get(n.id)!, props, ...(visibleWhen && isBinding(visibleWhen) ? { visibleWhen } : {}) };
  });
}

/** Inner node lookup across library instances (app-builder's publishedControl and the guest resolver). */
export function findNodeDeep(root: ComponentNode, nodeId: string, library: Record<string, LibraryComponent>): ComponentNode | undefined {
  if (root.id === nodeId) return root;
  if (root.libraryRef) {
    const lib = library[`${root.libraryRef.componentId}@${root.libraryRef.version}`];
    if (lib) {
      const hit = findNodeDeep(expandInstance(root, lib), nodeId, library);
      if (hit) return hit;
    }
  }
  for (const c of root.children ?? []) {
    const hit = findNodeDeep(c, nodeId, library);
    if (hit) return hit;
  }
  return undefined;
}

// ---------- the "Update to vN" diff ----------

function flatten(n: ComponentNode, out = new Map<string, ComponentNode>()): Map<string, ComponentNode> {
  out.set(n.id, n);
  for (const c of n.children ?? []) flatten(c, out);
  return out;
}
const label = (n: ComponentNode) => `${n.name ?? n.type}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Readable lines describing what changes between two versions of a library component. */
export function libraryDiff(from: Pick<LibraryComponent, "node" | "params">, to: Pick<LibraryComponent, "node" | "params">): string[] {
  const lines: string[] = [];
  const a = flatten(from.node), b = flatten(to.node);
  for (const [id, n] of b) if (!a.has(id)) lines.push(`Adds ${n.type} ${label(n)}`);
  for (const [id, n] of a) if (!b.has(id)) lines.push(`Removes ${n.type} ${label(n)}`);
  for (const [id, n] of b) {
    const o = a.get(id);
    if (!o) continue;
    if (n.type === "html" && (!same(o.props.html, n.props.html) || !same(o.props.css, n.props.css) || !same(o.props.js, n.props.js))) lines.push(`Changes the code of ${label(n)}`);
    const changed = Object.keys({ ...o.props, ...n.props }).filter((k) => !["html", "css", "js"].includes(k) && !same(o.props[k], n.props[k]));
    if (changed.length) lines.push(`Changes ${changed.join(", ")} of ${label(n)}`);
    if (!same(o.style, n.style) || !same(o.overrideTheme, n.overrideTheme)) lines.push(`Changes the style of ${label(n)}`);
    if (!same(o.css, n.css)) lines.push(`Changes the CSS of ${label(n)}`);
    if (!same(o.visibleWhen, n.visibleWhen)) lines.push(`Changes when ${label(n)} is shown`);
  }
  const pa = new Map(from.params.map((p) => [p.name, p])), pb = new Map(to.params.map((p) => [p.name, p]));
  for (const [k, p] of pb) if (!pa.has(k)) lines.push(`Adds the ${p.kind} parameter ${p.label}`);
  for (const [k, p] of pa) if (!pb.has(k)) lines.push(`Removes the ${p.kind} parameter ${p.label}`);
  return lines.length ? lines : ["No visible changes"];
}

/** Data sources a saved subtree reads before parameterizing (used to warn about unknown sources). */
export function subtreeSources(node: ComponentNode): string[] {
  const out = new Set<string>();
  const walk = (n: ComponentNode) => {
    const scan = (v: PropValue) => {
      if (isBinding(v)) {
        for (const r of rootsOf(v.$bind)) if (!r.startsWith("$")) out.add(r);
      } else if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === "object") Object.values(v).forEach((x) => scan(x as PropValue));
    };
    scan(n.props as PropValue);
    n.children?.forEach(walk);
  };
  walk(node);
  return [...out];
}
