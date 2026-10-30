// The data picker's rules (Wave 2.5 spec, stages/02-subsystem-spec/output/data-picking-spec.md): source
// names, parameter fields from an endpoint's JSON Schema, the template a click in the sample writes, the
// words that describe a template, what fits a component, renames and who uses a source. Pure: no DOM.
import type { AppDocument, ComponentNode, DataShapeKind, DataSourceDef, DraftOp, PropValue, ShapedData, ValueFormat } from "@/core/contracts";
import { SOURCE_NAME } from "@/features/apps/ops";
import { isBinding, sourcesInTemplate, templatesIn } from "@/features/components/bindings";
import { META } from "@/features/components/catalogue/meta";
import { nodeLabel } from "@/features/apps/doc";

// ---- Names ----

/** A data source name made from an endpoint's label ("Lights and their states" to "lights_and_their"), unique in the app. */
export function sourceNameFor(label: string, taken: readonly string[]): string {
  const words = label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let base = "";
  for (const w of words) {
    const next = base ? `${base}_${w}` : w;
    if (next.length > 20) break;
    base = next;
  }
  if (!/^[a-z]/.test(base)) base = `data${base ? `_${base}` : ""}`;
  base = base.slice(0, 28);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

export const isSourceName = (s: string) => SOURCE_NAME.test(s);

// ---- Kinds in words ----

export const SHAPE_WORDS: Record<DataShapeKind, string> = { stat: "one number", series: "values over time", table: "a list of rows", status: "things that are up or down" };

// ---- Parameter fields (spec 3.4) ----

export type ParamField = { key: string; label: string; kind: "text" | "number" | "choice" | "switch" | "thing"; options?: string[]; /** A8.3: words per option value. */ optionLabels?: Record<string, string>; /** A8.2: "which thing", from a live list. */ choices?: ChoicesSpec; required: boolean; help?: string; default?: string | number | boolean };

/** Form fields for an endpoint's parameter JSON Schema (an object schema); unknown kinds become text. */
export function paramFields(schema: Record<string, unknown> | undefined): ParamField[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as string[]) : []);
  return Object.entries(props).map(([key, p]) => {
    const t = Array.isArray(p.type) ? (p.type as string[]).find((x) => x !== "null") : (p.type as string | undefined);
    const options = Array.isArray(p.enum) ? (p.enum as unknown[]).map(String) : undefined;
    const live = choiceParams({ properties: { [key]: p } })[0]?.spec;
    const kind: ParamField["kind"] = live ? "thing" : options ? "choice" : t === "boolean" ? "switch" : t === "number" || t === "integer" ? "number" : "text";
    const def = p.default as ParamField["default"];
    const optionLabels = options && p["x-atrium-labels"] ? Object.fromEntries(options.map((o) => [o, choiceLabel(p, o)])) : undefined;
    return { key, label: typeof p.title === "string" ? p.title : key.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()), kind, ...(options ? { options } : {}), ...(optionLabels ? { optionLabels } : {}), ...(live ? { choices: live } : {}), required: required.has(key), ...(typeof p.description === "string" ? { help: p.description } : Array.isArray(p.examples) && p.examples.length ? { help: `For example: ${(p.examples as unknown[]).map(String).join(", ")}` } : {}), ...(def !== undefined ? { default: def } : {}) };
  });
}

/** The default values of the fields that have one. */
export function paramDefaults(fields: ParamField[]): Record<string, string | number | boolean> {
  return Object.fromEntries(fields.flatMap((f) => (f.default !== undefined ? [[f.key, f.default]] : [])));
}

/** The required fields left empty, by label (the sample does not load until they are filled). */
export function missingParams(fields: ParamField[], values: Record<string, unknown>): string[] {
  return fields.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === "")).map((f) => f.label);
}

// ---- Picks and templates (spec 3.6) ----

export type Agg = "count" | "sum" | "avg" | "min" | "max" | "list";
export type Pick =
  | { kind: "whole" }
  | { kind: "cell"; col: string; colLabel: string; keyCol: string; keyLabel: string; keyValue: string | number; index: number; unique: boolean }
  | { kind: "column"; col: string; colLabel: string; agg: Agg }
  | { kind: "series"; name: string }
  | { kind: "status"; label: string; field: "state" | "detail" }
  | { kind: "stat"; field: "value" | "unit" | "label" };

const q = (v: string | number) => (typeof v === "number" ? String(v) : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

/** The template a pick writes for a source. */
export function templateFor(src: string, pick: Pick): string {
  switch (pick.kind) {
    case "whole": return `{{ ${src} }}`;
    case "cell": return pick.unique ? `{{ ${src}.find(${q(pick.keyCol)}, ${q(pick.keyValue)}).${pick.col} }}` : `{{ ${src}.rows[${pick.index}].${pick.col} }}`;
    case "column": return pick.agg === "count" ? `{{ ${src}.rows | count }}` : pick.agg === "list" ? `{{ ${src}.rows | map(${q(pick.col)}) | join(", ") }}` : `{{ ${src}.rows | map(${q(pick.col)}) | ${pick.agg} }}`;
    case "series": {
      const s = `${src}.find("name", ${q(pick.name)}).points`;
      return `{{ ${s}[${s}.length - 1][1] }}`;
    }
    case "status": return `{{ ${src}.find("label", ${q(pick.label)}).${pick.field} }}`;
    case "stat": return `{{ ${src}.${pick.field} }}`;
  }
}

const AGG_WORDS: Record<Agg, string> = { count: "Number of rows", sum: "Sum of", avg: "Average of", min: "Lowest", max: "Highest", list: "List of" };

/** The words for a pick ("Value of the row where Name is alpha"). */
export function wordsFor(src: string, pick: Pick): string {
  switch (pick.kind) {
    case "whole": return `All of ${src}`;
    case "cell": return pick.unique ? `${pick.colLabel} of the row where ${pick.keyLabel} is ${pick.keyValue}` : `${pick.colLabel} of row ${pick.index + 1}`;
    case "column": return pick.agg === "count" ? `Number of rows in ${src}` : `${AGG_WORDS[pick.agg]} ${pick.colLabel}`;
    case "series": return `Latest value of ${pick.name}`;
    case "status": return pick.field === "state" ? `State of ${pick.label}` : `Detail of ${pick.label}`;
    case "stat": return `The ${pick.field} of ${src}`;
  }
}

const str = String.raw`"((?:[^"\\]|\\.)*)"`;
const unq = (s: string) => s.replace(/\\(.)/g, "$1");
const NAME = String.raw`([a-z][a-z0-9_]*)`;
const PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [new RegExp(String.raw`^\{\{ ${NAME} \}\}$`), (m) => `All of ${m[1]}`],
  [new RegExp(String.raw`^\{\{ ${NAME}\.find\(${str}, (?:${str}|(-?[\d.]+))\)\.([A-Za-z0-9_$]+) \}\}$`), (m) => (m[2] === "label" ? `${m[5] === "state" ? "State" : m[5] === "detail" ? "Detail" : m[5]} of ${unq(m[3] ?? m[4]!)}` : `${m[5]} of the row where ${unq(m[2]!)} is ${m[3] !== undefined ? unq(m[3]) : m[4]}`)],
  [new RegExp(String.raw`^\{\{ ${NAME}\.rows\[(\d+)\]\.([A-Za-z0-9_$]+) \}\}$`), (m) => `${m[3]} of row ${Number(m[2]) + 1}`],
  [new RegExp(String.raw`^\{\{ ${NAME}\.rows \| count \}\}$`), (m) => `Number of rows in ${m[1]}`],
  [new RegExp(String.raw`^\{\{ ${NAME}\.rows \| map\(${str}\) \| join\(", "\) \}\}$`), (m) => `List of ${unq(m[2]!)}`],
  [new RegExp(String.raw`^\{\{ ${NAME}\.rows \| map\(${str}\) \| (sum|avg|min|max) \}\}$`), (m) => `${AGG_WORDS[m[3] as Agg]} ${unq(m[2]!)}`],
  [new RegExp(String.raw`^\{\{ ${NAME}\.find\("name", ${str}\)\.points\[\1\.find\("name", "\2"\)\.points\.length - 1\]\[1\] \}\}$`), (m) => `Latest value of ${unq(m[2]!)}`],
  [new RegExp(String.raw`^\{\{ ${NAME}\.(value|unit|label) \}\}$`), (m) => `The ${m[2]} of ${m[1]}`],
];

/**
 * Words for a template the picker could have written, or null for anything else ("Custom template").
 * Column keys stand in for their labels here, since a hand-edited template carries no labels.
 */
export function describeTemplate(template: string): string | null {
  const t = template.trim();
  for (const [re, words] of PATTERNS) {
    const m = t.match(re);
    if (m) return words(m);
  }
  return null;
}

// ---- What fits a component (spec 3.6) ----

/** The prop that takes a whole source on this component type, or null when it has none. */
export function wholeProp(type: string): "data" | "items" | null {
  if (type === "list" || type === "repeat") return "items";
  return META[type as keyof typeof META]?.accepts ? "data" : null;
}

export type WholeFit = { ok: true; prop: "data" | "items"; template: string } | { ok: false; why: string; offers: { label: string; template: string }[]; fits: string[] };

/** Whether "Use this data" can bind a source of this kind to the component, and what to offer when not. */
export function wholeFit(type: string, src: string, shape: DataShapeKind, numberCols: { key: string; label: string }[] = []): WholeFit {
  const meta = META[type as keyof typeof META];
  const prop = wholeProp(type);
  const accepts = meta?.accepts ?? [];
  if (prop && accepts.includes(shape)) return { ok: true, prop, template: prop === "items" && shape === "table" ? `{{ ${src}.rows }}` : prop === "items" && shape === "status" ? `{{ ${src}.items }}` : `{{ ${src} }}` };
  const fits = Object.values(META).filter((m) => m.category === "data" && m.accepts?.includes(shape)).map((m) => m.title);
  const title = meta?.title ?? type;
  const why = `A ${title.toLowerCase()} shows ${accepts.map((a) => SHAPE_WORDS[a]).join(" or ") || "no data source"}, and ${src} is ${SHAPE_WORDS[shape]}.`;
  const offers: { label: string; template: string }[] = [];
  if (accepts.includes("stat") && (shape === "table" || shape === "status")) {
    offers.push({ label: shape === "table" ? "Number of rows" : "Number of items", template: shape === "table" ? `{{ ${src}.rows | count }}` : `{{ ${src}.items | count }}` });
    for (const c of numberCols) for (const agg of ["sum", "avg"] as const) offers.push({ label: `${AGG_WORDS[agg]} ${c.label}`, template: templateFor(src, { kind: "column", col: c.key, colLabel: c.label, agg }) });
  }
  return { ok: false, why, offers, fits };
}

// ---- Who uses a source, renames (spec 3.5, 3.8) ----

function eachNode(n: ComponentNode, f: (n: ComponentNode) => void) {
  f(n);
  for (const k of n.children ?? []) eachNode(k, f);
}

/** Every component in the app whose props, phone props or visibility read the source. */
export function usersOf(doc: AppDocument, name: string): { nodeId: string; pageId: string; label: string }[] {
  const out: { nodeId: string; pageId: string; label: string }[] = [];
  for (const p of doc.pages) eachNode(p.root, (n) => {
    const temps = [...templatesIn(n.props as PropValue, "props"), ...(n.responsive?.mobile?.props ? templatesIn(n.responsive.mobile.props as PropValue, "props") : []), ...(isBinding(n.visibleWhen) ? [{ path: "visibleWhen", template: n.visibleWhen.$bind }] : [])];
    const lib = n.type.startsWith("lib:") && Object.values(n.props).some((v) => v === name);
    if (lib || temps.some((t) => sourcesInTemplate(t.template).includes(name))) out.push({ nodeId: n.id, pageId: p.id, label: nodeLabel(n) });
  });
  return out;
}

/** A template with one source renamed: only a root name inside {{ }}, never a path segment or string text. */
export function renameInTemplate(template: string, from: string, to: string): string {
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (whole, expr: string) => {
    let out = "";
    let i = 0;
    while (i < expr.length) {
      const c = expr[i]!;
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < expr.length && expr[j] !== c) j += expr[j] === "\\" ? 2 : 1;
        out += expr.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(expr.slice(i));
      if (m) {
        const prev = out.trimEnd().slice(-1);
        out += m[0] === from && prev !== "." ? to : m[0];
        i += m[0].length;
        continue;
      }
      out += c;
      i++;
    }
    return `{{${out}}}`;
  });
}

function renameValue(v: PropValue, from: string, to: string): PropValue {
  if (isBinding(v)) return { ...v, $bind: renameInTemplate(v.$bind, from, to) };
  if (Array.isArray(v)) return v.map((x) => renameValue(x as PropValue, from, to)) as PropValue;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renameValue(x as PropValue, from, to)])) as PropValue;
  return v;
}

/** The ops that rename a source and every binding that reads it, as one batch. */
export function renameOps(doc: AppDocument, from: string, to: string): DraftOp[] {
  const def = doc.dataSources.find((d) => d.name === from);
  if (!def) return [];
  const ops: DraftOp[] = [{ op: "source.set", source: { ...def, name: to } }];
  for (const p of doc.pages) eachNode(p.root, (n) => {
    const users = usersOf({ ...doc, pages: [{ ...p, root: n, }] } as AppDocument, from).some((u) => u.nodeId === n.id);
    if (!users) return;
    const props = renameValue(n.props as PropValue, from, to) as ComponentNode["props"];
    const lib = n.type.startsWith("lib:") ? Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v === from ? to : v])) : props;
    const patch: Record<string, unknown> = { props: lib };
    if (isBinding(n.visibleWhen)) patch.visibleWhen = { $bind: renameInTemplate(n.visibleWhen.$bind, from, to) };
    if (n.responsive?.mobile?.props) patch.responsive = { mobile: { props: renameValue(n.responsive.mobile.props as PropValue, from, to) } };
    ops.push({ op: "node.update", nodeId: n.id, patch } as DraftOp);
  });
  ops.push({ op: "source.remove", name: from });
  return ops;
}

// ======== Wave 2.7 data ease (spec data-ease-spec.md 3.1, 3.2; Amendment 8) ========

// ---- Live choices and choice labels (A8.2, A8.3) ----

/** A parameter whose choices are the rows of another read (A8.2). */
export type ChoicesSpec = { endpointId: string; value: string; label: string; detail?: string; every?: boolean };
/** The stored value meaning "every one" (A8.2): the read then returns rows. */
export const EVERY = "*";

/** The `x-atrium-choices` of each parameter that has one, by key. */
export function choiceParams(schema: Record<string, unknown> | undefined): { key: string; title: string; spec: ChoicesSpec; required: boolean }[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as string[]) : []);
  return Object.entries(props).flatMap(([key, p]) => {
    const c = p["x-atrium-choices"] as Partial<ChoicesSpec> | undefined;
    if (!c || typeof c !== "object" || typeof c.endpointId !== "string") return [];
    const title = typeof p.title === "string" ? p.title : key.replace(/[_-]+/g, " ").replace(/^./, (x) => x.toUpperCase());
    return [{ key, title, spec: { endpointId: c.endpointId, value: String(c.value ?? "value"), label: String(c.label ?? "label"), ...(c.detail ? { detail: String(c.detail) } : {}), ...(c.every ? { every: true } : {}) }, required: required.has(key) }];
  });
}

/** Words for an enum value (A8.3): `x-atrium-labels` as an object by value or an array in enum order. */
export function choiceLabel(p: Record<string, unknown> | undefined, value: string): string {
  const labels = p?.["x-atrium-labels"];
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    const l = (labels as Record<string, unknown>)[value];
    if (typeof l === "string") return l;
  }
  if (Array.isArray(labels) && Array.isArray(p?.enum)) {
    const i = (p!.enum as unknown[]).map(String).indexOf(value);
    if (i >= 0 && typeof labels[i] === "string") return labels[i] as string;
  }
  return value;
}

/** "Every machine" for a parameter titled "Machine". */
export function everyWords(title: string): string {
  return `Every ${title.trim().toLowerCase() || "one"}`;
}

// ---- Friendly names (A8.6, spec 3.1 "Names") ----

/** A source's name in words from what was picked: "CPU in use, ACE", "Machines overview", "CPU in use, every machine". */
export function sourceLabelFor(readLabel: string, picks: readonly string[] = []): string {
  const parts = [readLabel.trim(), ...picks.map((p) => p.trim().replace(/^Every /, "every ")).filter(Boolean)];
  return parts.join(", ").slice(0, 80);
}

/** The template name for a new source, derived from its label (A8.6), unique in the app. */
export function sourceNameFromLabel(label: string, taken: readonly string[]): string {
  return sourceNameFor(label.replace(/,/g, " "), taken);
}

// ---- Reuse (spec 3.1, criterion 6) ----

function normParams(p: DataSourceDef["params"] | undefined): string {
  const clean = Object.fromEntries(Object.entries(p ?? {}).filter(([, v]) => v !== "" && v !== undefined && v !== null).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(clean);
}

/** Two sources read the same thing: same integration, read and settings (the refresh interval may differ). */
type ReadKey = { integrationId: string; endpointId: string; params?: DataSourceDef["params"] };

export function sameRead(a: ReadKey, b: ReadKey): boolean {
  return a.integrationId === b.integrationId && a.endpointId === b.endpointId && normParams(a.params) === normParams(b.params);
}

/** The app's existing source that reads exactly this, so picking it again never makes a copy. */
export function findReusable(doc: { dataSources: DataSourceDef[] }, def: ReadKey, except?: string): DataSourceDef | null {
  return doc.dataSources.find((d) => d.name !== except && sameRead(d, def)) ?? null;
}

// ---- Leave nothing behind (spec 3.1, criterion 10) ----

/** Sources added since `before` that nothing uses now (in this copy or in `also`, the newest saved draft). */
export function unusedAdded(doc: AppDocument, before: readonly string[], also?: AppDocument, keep?: string | null): string[] {
  const had = new Set(before);
  return doc.dataSources.filter((s) => !had.has(s.name) && s.name !== keep && !usersOf(doc, s.name).length && !(also && usersOf(also, s.name).length)).map((s) => s.name);
}

// ---- Shared data (spec 3.1 "Shared data", criterion 8) ----

/** Every other widget that reads the source. */
export function otherUsers(doc: AppDocument, name: string, nodeId: string): { nodeId: string; pageId: string; label: string }[] {
  return usersOf(doc, name).filter((u) => u.nodeId !== nodeId);
}

/** "Make a separate copy for this one": a copy of the source, and this widget's bindings moved onto it. */
export function copyForOne(doc: AppDocument, nodeId: string, name: string): { name: string; ops: DraftOp[] } | null {
  const def = doc.dataSources.find((d) => d.name === name);
  const at = findNodeIn(doc, nodeId);
  if (!def || !at) return null;
  const to = sourceNameFor(name, doc.dataSources.map((d) => d.name));
  const props = renameValue(at.props as PropValue, name, to) as ComponentNode["props"];
  const ops: DraftOp[] = [
    { op: "source.set", source: { ...def, name: to, ...(def.label ? { label: `${def.label} (copy)`.slice(0, 80) } : {}) } },
    { op: "node.update", nodeId, patch: { props } } as DraftOp,
  ];
  return { name: to, ops };
}

function findNodeIn(doc: AppDocument, id: string): ComponentNode | null {
  let hit: ComponentNode | null = null;
  for (const p of doc.pages) eachNode(p.root, (n) => { if (n.id === id) hit = n; });
  return hit;
}

// ---- This row (spec 3.2, criterion 11) ----

/** The nearest Repeat around a node, and the source its rows come from (when they come from one). */
export function repeatAround(doc: AppDocument, nodeId: string): { repeatId: string; source: string | null } | null {
  for (const page of doc.pages) {
    const hit = findPath(page.root, nodeId, []);
    if (!hit) continue;
    for (let i = hit.length - 1; i >= 0; i--) {
      const a = hit[i]!;
      if (a.type !== "repeat") continue;
      const items = a.props.items;
      const src = isBinding(items) ? sourcesInTemplate(items.$bind)[0] ?? null : null;
      return { repeatId: a.id, source: src };
    }
    return null;
  }
  return null;
}

function findPath(n: ComponentNode, id: string, path: ComponentNode[]): ComponentNode[] | null {
  if (n.id === id) return path;
  for (const k of n.children ?? []) {
    const r = findPath(k, id, [...path, n]);
    if (r) return r;
  }
  return null;
}

export type RowField = { key: string; label: string; value: unknown; format?: ValueFormat };

/** The fields of "this row": a table's columns (or a status item's label, state and detail), with the first row's values. */
export function rowFields(data: ShapedData | undefined): RowField[] {
  if (!data) return [];
  if (data.kind === "table") {
    const first = data.rows[0] ?? {};
    return data.columns.map((c) => ({ key: c.key, label: c.label, value: first[c.key], ...(c.format ? { format: c.format } : {}) }));
  }
  if (data.kind === "status") {
    const first = data.items[0];
    return [{ key: "label", label: "Name", value: first?.label }, { key: "state", label: "State", value: first?.state }, { key: "detail", label: "Detail", value: first?.detail }];
  }
  return [];
}

/** The template for one field of "this row". */
export const rowTemplate = (key: string) => `{{ $item.${key} }}`;

// ---- Picking how to show it (spec 3.1 "Pick how to show it") ----

const ONE_VALUE_TYPES = ["stat", "gauge", "progress"] as const;
const ROW_TYPES = ["table", "status"] as const;

export type ShowAs = { type: "stat" | "gauge" | "progress" | "chart" | "table" | "status" | "cards"; label: string };
const SHOW_WORDS: Record<ShowAs["type"], string> = { stat: "Stat", gauge: "Gauge", progress: "Progress bar", chart: "Chart over time", table: "Table", status: "Status", cards: "A card for each" };

/** The widget kinds that fit data of this kind. */
export function showChoices(shape: DataShapeKind): ShowAs[] {
  const list: ShowAs["type"][] = shape === "stat" ? [...ONE_VALUE_TYPES] : shape === "series" ? ["chart"] : shape === "status" ? ["status", "cards"] : [...ROW_TYPES.filter((t) => t === "table"), "cards"];
  return list.map((type) => ({ type, label: SHOW_WORDS[type] }));
}

/** Props for a widget of `type` showing the whole source `src` (the type's defaults underneath). */
export function propsToShow(type: Exclude<ShowAs["type"], "cards">, src: string, keep: Record<string, PropValue> = {}): Record<string, PropValue> {
  const defaults = structuredClone(META[type]?.defaults ?? {}) as Record<string, PropValue>;
  const label: Record<string, PropValue> = typeof keep.label === "string" && keep.label ? { label: keep.label } : {};
  if (type === "gauge" || type === "progress") return { ...defaults, ...label, value: { $bind: `{{ ${src}.value }}` } };
  if (type === "stat") return { ...defaults, ...label, data: { $bind: `{{ ${src} }}` } };
  return { ...defaults, data: { $bind: `{{ ${src} }}` } };
}

/** The one op that turns a widget into another kind showing the source (props rebuilt for the new kind). */
export function switchTypeOp(node: ComponentNode, type: Exclude<ShowAs["type"], "cards">, src: string): DraftOp {
  const props = propsToShow(type, src, node.props);
  // Merge patches keep keys that are not sent: clear the old kind's props explicitly.
  const cleared = Object.fromEntries(Object.keys(node.props).filter((k) => !(k in props)).map((k) => [k, null]));
  return { op: "node.update", nodeId: node.id, patch: { type, props: { ...cleared, ...props } } } as DraftOp;
}

// ---- Several values where one is expected (spec 3.1 "Several values", criterion 9) ----

export type ManyOffer = { label: string; template: string; agg: "sum" | "avg" | "max" | "min" };

/** For a table where one number is wanted: Sum, Average, Highest and Lowest of its main number column. */
export function manyValueOffers(src: string, data: ShapedData): { count: number; column: { key: string; label: string } | null; offers: ManyOffer[] } {
  if (data.kind !== "table") return { count: 0, column: null, offers: [] };
  const nums = data.columns.filter((c) => c.type === "number");
  const col = nums.find((c) => c.format === "percent") ?? nums[0] ?? null;
  const count = data.total ?? data.rows.length;
  if (!col) return { count, column: null, offers: [] };
  const words: Record<ManyOffer["agg"], string> = { sum: "Sum", avg: "Average", max: "Highest", min: "Lowest" };
  return { count, column: { key: col.key, label: col.label }, offers: (["sum", "avg", "max", "min"] as const).map((agg) => ({ agg, label: words[agg], template: templateFor(src, { kind: "column", col: col.key, colLabel: col.label, agg }) })) };
}

// ---- A card for each (spec 3.2, criterion 2) ----

/** The column that names a row: "name", "label", "host", else the first text column. */
export function keyColumn(data: ShapedData): { key: string; label: string } | null {
  if (data.kind === "status") return { key: "label", label: "Name" };
  if (data.kind !== "table") return null;
  const by = (k: string) => data.columns.find((c) => c.key.toLowerCase() === k);
  const c = by("name") ?? by("label") ?? by("host") ?? by("machine") ?? data.columns.find((x) => x.type === "text") ?? data.columns[0];
  return c ? { key: c.key, label: c.label } : null;
}

/** The read's main columns for a card (up to six): every column but the name and plain addresses. */
export function mainColumns(data: ShapedData): string[] {
  if (data.kind === "status") return ["state", "detail"];
  if (data.kind !== "table") return [];
  const key = keyColumn(data)?.key;
  const skip = /^(instance|address|addr|ip|id|job|url|href)$/i;
  const cols = data.columns.filter((c) => c.key !== key && !skip.test(c.key));
  // A read may mark its main columns; else formatted values first (percent, bytes, durations), then states, then numbers.
  const marked = cols.filter((c) => (c as { main?: boolean }).main && c.type !== "status");
  const rank = (c: (typeof cols)[number]) => (c.format && c.format !== "number" ? 0 : c.type === "status" ? 2 : c.type === "number" || c.format ? 1 : 3);
  const ordered = marked.length ? [...marked, ...cols.filter((c) => !marked.includes(c)).sort((a, b) => rank(a) - rank(b))] : [...cols].sort((a, b) => rank(a) - rank(b));
  return ordered.slice(0, 6).map((c) => c.key);
}

const LINE_ROWS = 14; // one stat line in a card: 112px (value and label)
const CARD_HEAD_ROWS = 12; // the card's title bar, padding and title (measured 2026-10-20)

/** Height in 8px rows of one card with `lines` stat lines, two per row. */
export function cardRows(lines: number): number {
  return CARD_HEAD_ROWS + Math.ceil(Math.max(1, lines) / 2) * LINE_ROWS + 2;
}

/**
 * The ops that make `repeat` a card for each row of `src`: its items bound to the rows, columns across,
 * and one ready card (a title bound to the row's name and a stat per picked column, two per row).
 * Replaces the Repeat's current child, if any.
 */
export function cardForEachOps(repeat: ComponentNode, src: string, data: ShapedData, columns: readonly string[], opts: { across?: number; makeId(prefix: "c"): string; rows?: number }): DraftOp[] {
  const across = Math.max(1, Math.min(6, opts.across ?? (typeof repeat.props.columns === "number" && repeat.props.columns > 1 ? repeat.props.columns : 3)));
  const key = keyColumn(data);
  const items = data.kind === "status" ? `{{ ${src}.items }}` : `{{ ${src}.rows }}`;
  const labelOf = (k: string) => (data.kind === "table" ? data.columns.find((c) => c.key === k)?.label : rowFields(data).find((f) => f.key === k)?.label) ?? k;
  const stats: ComponentNode[] = columns.map((k, i) => ({
    id: opts.makeId("c"), type: "stat", props: { value: { $bind: rowTemplate(k) }, label: labelOf(k), decimals: 1 },
    slot: { x: (i % 2) * 6, y: Math.floor(i / 2) * LINE_ROWS, w: 6, h: LINE_ROWS },
  }));
  const grid: ComponentNode = { id: opts.makeId("c"), type: "grid", props: { minRows: 1, gap: 8 }, children: stats };
  const card: ComponentNode = { id: opts.makeId("c"), type: "card", name: "Card for each row", props: { title: key ? { $bind: rowTemplate(key.key) } : "", padded: true }, children: [grid] };
  const count = opts.rows ?? (data.kind === "table" ? data.total ?? data.rows.length : data.kind === "status" ? data.items.length : 1);
  const h = Math.ceil(Math.max(1, count) / across) * (cardRows(columns.length) + 2);
  const ops: DraftOp[] = (repeat.children ?? []).map((c) => ({ op: "node.remove", nodeId: c.id }) as DraftOp);
  ops.push({ op: "node.update", nodeId: repeat.id, patch: { props: { ...repeat.props, items: { $bind: items }, columns: across, gap: typeof repeat.props.gap === "number" ? repeat.props.gap : 12, empty: typeof repeat.props.empty === "string" && repeat.props.empty ? repeat.props.empty : "Nothing reported yet", max: typeof repeat.props.max === "number" ? repeat.props.max : 50 }, ...(repeat.slot ? { slot: { ...repeat.slot, w: Math.max(repeat.slot.w, 12), x: 0, h: Math.max(repeat.slot.h, h) } } : {}) } } as DraftOp);
  ops.push({ op: "node.add", parentId: repeat.id, node: card });
  return ops;
}

// ---- The inspector's one line (spec 3.1 "One line in the inspector") ----

export type ShowsLine = { what: string; detail: string | null; value: string | null; from: string | null };

/** "CPU in use · ACE · 7.8 % · Prometheus, every 30 s": the parts of a widget's Shows line. */
export function showsLine(def: DataSourceDef, template: string, opts: { readLabel?: string; integrationName?: string; value?: string | null }): ShowsLine {
  const what = def.label?.trim() || opts.readLabel || def.name;
  const t = template.trim();
  const whole = new RegExp(String.raw`^\{\{\s*${def.name}(\.(rows|items|value))?\s*\}\}$`).test(t);
  const words = whole ? null : describeTemplate(t);
  const every = def.refreshSec === 0 ? "loads with the page" : `every ${def.refreshSec} s`;
  return { what, detail: whole ? null : words ?? "a custom template", value: opts.value ?? null, from: opts.integrationName ? `${opts.integrationName}, ${every}` : every };
}

// ---- Reads that fail their live check (A9.2, recipes spec 3.2) ----

/** The bits of the bindable listing these rules read (structural, so the picker's types fit). */
type CheckedListing = { integrationId: string; integrationName?: string; endpoints: { id: string; check?: { status: string; reason?: string } }[] }[];

/** Why a source's read is failing on its server (its last live check said failed), or null. */
export function failedReadReason(def: { integrationId: string; endpointId: string }, listing: CheckedListing): string | null {
  const ep = listing.find((b) => b.integrationId === def.integrationId)?.endpoints.find((e) => e.id === def.endpointId);
  return ep?.check?.status === "failed" ? ep.check.reason?.trim() || "This read stopped working." : null;
}

/** Source name to failure reason, for every app source whose read failed its last live check. */
export function failingSources(doc: { dataSources: DataSourceDef[] }, listing: CheckedListing): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of doc.dataSources) {
    const why = failedReadReason(s, listing);
    if (why) out[s.name] = why;
  }
  return out;
}

