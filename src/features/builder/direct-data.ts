// Direct data (Wave 2.9, direct-data-spec.md 3.1 to 3.5; Amendment 10): what a catalogue pick writes into
// the draft. A pick finds or creates the managed source for its read (A10.1) and binds the component's
// prop to it, in one batch; chart lines bind series reads or a value read's history (A10.2, A10.3); a
// service tile gets its status and headline stats as managed sources (A10.5, A10.7). Pure: no DOM, no I/O.
import type { AppDocument, CatalogueItem, ComponentNode, DataShapeKind, DraftOp, HeadlineStat, PropValue, ValueFormat } from "@/core/contracts";
import { findNode } from "@/features/apps/doc";
import { ensureManaged, type ManagedWant } from "@/features/apps/managed";
import { META } from "@/features/components/catalogue/meta";
import { propsToShow, wholeProp } from "./data-pick";

/** What a catalogue pick needs from an item (CatalogueItem, or a "Pick another" variant of it). */
export type PickItem = Pick<CatalogueItem, "integrationId" | "endpointId" | "label" | "params" | "shape" | "defaultRefreshSec" | "minRefreshSec"> & Partial<Pick<CatalogueItem, "thing" | "format" | "history" | "integrationName" | "key" | "measure">>;

/** "CPU in use, pve1": the read and its thing in words (the managed source's label). */
export function itemWords(item: Pick<PickItem, "label" | "thing">): string {
  return item.thing ? `${item.label}, ${item.thing.label}` : item.label;
}

/** What a prop takes: the whole source, a list of rows, one value, a status badge, or a chart line. */
export type PropKind = "whole" | "items" | "value" | "status" | "line" | "gauge";

/** The kind of a prop path on a node type ("data", "value", "stats.1.value", "lines.0.data", "status"). */
export function propKind(type: string, prop: string): PropKind {
  if (/^lines\.\d+\.data$/.test(prop) || prop === "lines") return "line";
  if (prop === "status") return "status";
  if (prop === "items" && (type === "list" || type === "repeat")) return "items";
  if (prop === "data" && (type === "gauge" || type === "progress")) return "gauge";
  if (prop === "data" && wholeProp(type) === "data") return "whole";
  return "value";
}

/** The component type the catalogue's `fits` should rank for a prop (A10.4). */
export function fitsFor(type: string, prop: string): string {
  const k = propKind(type, prop);
  if (k === "line") return "chart";
  if (k === "status") return "status";
  if (k === "value" || k === "gauge") return "stat";
  return type;
}

/** Whether an item fits a prop of a node type without switching the component. */
export function itemFits(type: string, prop: string, item: Pick<PickItem, "shape" | "history">): boolean {
  const k = propKind(type, prop);
  if (k === "line") return item.shape === "series" || !!item.history;
  if (k === "status") return item.shape === "status";
  if (k === "items") return item.shape === "table" || item.shape === "status";
  if (k === "value" || k === "gauge") return item.shape === "stat" || item.shape === "table" || item.shape === "status";
  const accepts = META[type as keyof typeof META]?.accepts ?? [];
  if (accepts.includes(item.shape)) return true;
  // A stat (or gauge, progress) can show how many rows or items a list has.
  return accepts.includes("stat") && (item.shape === "table" || item.shape === "status");
}

/** The template a prop of this kind binds for a source of this shape. */
export function templateFor(kind: PropKind, name: string, shape: DataShapeKind, accepts: readonly DataShapeKind[] = []): string {
  if (kind === "line" || kind === "status") return `{{ ${name} }}`;
  if (kind === "items") return shape === "status" ? `{{ ${name}.items }}` : `{{ ${name}.rows }}`;
  // A component that shows this kind of data takes it whole (a table its rows, a chart its series).
  if (kind === "whole" && accepts.includes(shape)) return `{{ ${name} }}`;
  if (shape === "table") return `{{ ${name}.rows | count }}`;
  if (shape === "status") return `{{ ${name}.items | filter("state", "up") | count }}`;
  if (kind === "whole") return `{{ ${name} }}`;
  return `{{ ${name}.value }}`;
}

/** The read a chart line binds for an item: itself when it is a series, else its history (A10.3). */
export function lineRead(item: PickItem): PickItem | null {
  if (item.shape === "series") return item;
  if (!item.history) return null;
  return { ...item, endpointId: item.history.endpointId, params: { ...item.params, ...item.history.params }, shape: "series" };
}

function want(item: PickItem): ManagedWant {
  return { integrationId: item.integrationId, endpointId: item.endpointId, params: item.params, label: itemWords(item), defaultRefreshSec: item.defaultRefreshSec, minRefreshSec: item.minRefreshSec };
}

/** Sets a value at a dotted prop path inside a props object ("stats.1.value"), copying what it passes through. */
export function setAtPath(props: Record<string, PropValue>, path: string, value: PropValue): Record<string, PropValue> {
  const keys = path.split(".");
  const root: Record<string, PropValue> = { ...props };
  let cur: Record<string, PropValue> | PropValue[] = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const nextIsIndex = /^\d+$/.test(keys[i + 1]!);
    const existing: PropValue | undefined = (cur as Record<string, PropValue>)[k];
    const copy: Record<string, PropValue> | PropValue[] = Array.isArray(existing) ? [...existing] : existing && typeof existing === "object" ? { ...(existing as Record<string, PropValue>) } : nextIsIndex ? [] : {};
    (cur as Record<string, PropValue>)[k] = copy as PropValue;
    cur = copy;
  }
  (cur as Record<string, PropValue>)[keys.at(-1)!] = value;
  return root;
}

/** The value at a dotted prop path, or undefined. */
export function getAtPath(props: Record<string, PropValue>, path: string): PropValue | undefined {
  let cur: unknown = props;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur as PropValue | undefined;
}

export type BindResult = { ops: DraftOp[]; name: string; template: string; words: string };

/**
 * Binds one prop of a node to a catalogue item (spec 3.2): the managed source (found or created) and the
 * node's new props, in one batch. A whole-data prop on a component that cannot show the item switches the
 * component to `switchTo` when given. A pick on a stat inserted through the picker also names its title.
 */
export function bindItemOps(doc: AppDocument, nodeId: string, prop: string, item: PickItem, opts: { random?: () => number; switchTo?: string; title?: boolean } = {}): BindResult | null {
  const at = findNode(doc, nodeId);
  if (!at) return null;
  const node = at.node;
  const kind = propKind(node.type, prop);
  const read = kind === "line" ? lineRead(item) : item;
  if (!read) return null;
  const m = ensureManaged(doc, want(read), opts.random ? { random: opts.random } : {});
  const words = itemWords(item);
  const titled = opts.title && !node.title && node.type !== "repeat" ? { title: words.slice(0, 120) } : {};
  if (opts.switchTo && opts.switchTo !== node.type) {
    const props = propsToShow(opts.switchTo as "stat", m.name, node.props);
    const cleared = Object.fromEntries(Object.keys(node.props).filter((k) => !(k in props)).map((k) => [k, null]));
    return { ops: [...m.ops, { op: "node.update", nodeId, patch: { type: opts.switchTo, props: { ...cleared, ...props }, ...titled } } as DraftOp], name: m.name, template: `{{ ${m.name} }}`, words };
  }
  const template = templateFor(kind, m.name, read.shape, META[node.type as keyof typeof META]?.accepts ?? []);
  const props = kind === "gauge" ? setAtPath({ ...node.props, data: null }, "value", { $bind: `{{ ${m.name}.value }}` }) : setAtPath(node.props, prop, { $bind: template });
  return { ops: [...m.ops, { op: "node.update", nodeId, patch: { props, ...titled } } as DraftOp], name: m.name, template, words };
}

/** The lines a chart has now: its `lines`, or its single `data` binding as one line (A10.2). */
export function chartLines(node: ComponentNode): { data: { $bind: string }; label?: string; color?: string; hidden?: boolean }[] {
  const lines = node.props.lines;
  if (Array.isArray(lines) && lines.length) return lines as never;
  const d = node.props.data;
  return d && typeof d === "object" && !Array.isArray(d) && typeof (d as { $bind?: unknown }).$bind === "string" ? [{ data: d as { $bind: string } }] : [];
}

export const MAX_LINES = 12;

/** Adds a line to a chart (spec 3.4): a chart that showed one source keeps it as its first line. */
export function addLineOps(doc: AppDocument, nodeId: string, item: PickItem, opts: { random?: () => number; taken?: string[]; label?: string } = {}): BindResult | null {
  const at = findNode(doc, nodeId);
  if (!at) return null;
  const read = lineRead(item);
  if (!read) return null;
  const lines = chartLines(at.node);
  if (lines.length >= MAX_LINES) return null;
  const m = ensureManaged(doc, want(read), { ...(opts.random ? { random: opts.random } : {}), ...(opts.taken ? { taken: opts.taken } : {}) });
  const words = opts.label ?? itemWords(item);
  const line = { data: { $bind: `{{ ${m.name} }}` }, label: words.slice(0, 80) };
  return { ops: [...m.ops, { op: "node.update", nodeId, patch: { props: { ...at.node.props, data: null, lines: [...lines, line] } } } as DraftOp], name: m.name, template: line.data.$bind, words };
}

// ---- Units and axes (A10.2) ----

export type LineUnit = { format?: ValueFormat | undefined; unit?: string | undefined };
const unitKey = (u: LineUnit) => `${u.format ?? "number"}|${u.unit ?? ""}`;
const FORMAT_WORDS: Record<string, string> = { percent: "percent", bytes: "bytes", bytesPerSec: "bytes per second", seconds: "time", celsius: "temperature", number: "plain numbers" };
export const unitWords = (u: LineUnit) => (u.unit ? u.unit : FORMAT_WORDS[u.format ?? "number"] ?? "plain numbers");

/** Lines group by format and unit: the first group uses the left axis, the second the right (A10.2). */
export function axisGroups(units: LineUnit[]): LineUnit[] {
  const out: LineUnit[] = [];
  for (const u of units) if (!out.some((x) => unitKey(x) === unitKey(u))) out.push(u);
  return out;
}

/** The refusal for a third unit, in one sentence (spec 3.4), or null when the new line fits. */
export function thirdUnitRefusal(existing: LineUnit[], next: LineUnit, nextWords: string): string | null {
  const groups = axisGroups(existing);
  if (groups.length < 2 || groups.some((g) => unitKey(g) === unitKey(next))) return null;
  return `This chart already shows ${unitWords(groups[0]!)} and ${unitWords(groups[1]!)}, so ${nextWords} (${unitWords(next)}) would need a third axis.`;
}

// ---- Service tiles (spec 3.5, A10.5, A10.7) ----

export type TileService = { integrationId: string; name: string; packageId: string; icon?: string; openUrl?: string; headline: HeadlineStat[]; description?: string };
/** What the builder knows about each read, for labels and refresh (from the catalogue or the bindable listing). */
export type ReadInfo = (integrationId: string, endpointId: string) => { label: string; shape: DataShapeKind; defaultRefreshSec: number; minRefreshSec: number } | null;

/** The icon a tile shows: the package's ("pkg:<id>") when its id can be named so, else a server glyph. */
export function tileIcon(packageId: string): string {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(packageId) ? `pkg:${packageId}` : "server";
}

/** A headline stat's template body against its source: "value" reads `.value`, "rows | ..." reads `.rows | ...`. */
export function headlineTemplate(name: string, body: string): string {
  const b = body.trim();
  if (!b) return `{{ ${name} }}`;
  if (b.startsWith("|")) return `{{ ${name} ${b} }}`;
  return `{{ ${name}.${b} }}`;
}

const HEALTH = { integrationId: "atrium", endpointId: "health" };
const REACH = { integrationId: "atrium", endpointId: "reach" };
const STATUS_TIMING = { defaultRefreshSec: 60, minRefreshSec: 30 };

/**
 * A service tile's props and the managed sources they need: status from `atrium/health` for an
 * integration (or `atrium/reach` for a plain link) and up to 4 headline stats (A10.8). `taken` holds names
 * already chosen in this batch, so several tiles in one change never share a generated name by chance.
 */
export function tileOps(doc: Pick<AppDocument, "dataSources">, svc: TileService | { link: { name: string; href: string } }, info: ReadInfo, opts: { random?: () => number; taken?: string[] } = {}): { props: Record<string, PropValue>; ops: DraftOp[]; sources: string[] } {
  const taken = [...(opts.taken ?? [])];
  const ops: DraftOp[] = [];
  const sources: string[] = [];
  // Sources this batch adds are visible to the next ensureManaged through `pending`.
  const pending = { dataSources: [...doc.dataSources] };
  const managed = (w: ManagedWant) => {
    const m = ensureManaged(pending, w, { ...(opts.random ? { random: opts.random } : {}), taken });
    for (const o of m.ops) if (o.op === "source.set") pending.dataSources.push(o.source);
    taken.push(m.name);
    ops.push(...m.ops);
    sources.push(m.name);
    return m.name;
  };
  if ("link" in svc) {
    const st = managed({ ...REACH, params: { url: svc.link.href }, label: `${svc.link.name} is up`, ...STATUS_TIMING });
    return { props: { icon: "link", name: svc.link.name.slice(0, 80), description: "", href: svc.link.href, newTab: true, status: { $bind: `{{ ${st} }}` }, stats: [] }, ops, sources };
  }
  const st = managed({ ...HEALTH, params: { integrationId: svc.integrationId }, label: `${svc.name} health`, ...STATUS_TIMING });
  const stats: PropValue[] = [];
  for (const h of svc.headline.slice(0, 4)) {
    const r = info(svc.integrationId, h.endpointId);
    const name = managed({ integrationId: svc.integrationId, endpointId: h.endpointId, params: h.params ?? {}, label: `${svc.name}: ${r?.label ?? h.label}`, defaultRefreshSec: r?.defaultRefreshSec ?? 60, minRefreshSec: r?.minRefreshSec ?? 10 });
    stats.push({ label: h.label.slice(0, 40), value: { $bind: headlineTemplate(name, h.value) }, ...(h.format ? { format: h.format } : {}) });
  }
  return {
    props: { icon: svc.icon ?? tileIcon(svc.packageId), name: svc.name.slice(0, 80), description: (svc.description ?? "").slice(0, 160), ...(svc.openUrl ? { href: svc.openUrl } : {}), newTab: true, status: { $bind: `{{ ${st} }}` }, stats, integrationId: svc.integrationId },
    ops,
    sources,
  };
}

// ---- Resource bar (spec 3.6) ----

export const BAR_MEASURES = [
  { measure: "cpu", label: "CPU", icon: "cpu", percent: true },
  { measure: "memory", label: "Memory", icon: "memory", percent: true },
  { measure: "disk", label: "Disk", icon: "disk", percent: true },
  { measure: "uptime", label: "Up", icon: "clock", percent: false },
] as const;

/** An endpoint as the bindable listing gives it (only what the bar needs). */
export type BarEndpoint = { id: string; label: string; shape: string; params?: Record<string, unknown>; group?: string; advanced?: boolean; defaultRefreshSec: number; minRefreshSec: number; measure?: string };

/**
 * The resource bar's readings for one machine (or the Atrium host): CPU, memory, disk and uptime, each the
 * first plain read of that measure taking the machine from a live list (A10.6 `host` for this server).
 */
export function barItemOps(doc: Pick<AppDocument, "dataSources">, integrationId: string, endpoints: BarEndpoint[], machine: { thing: string; label: string } | null, measureOf: (e: BarEndpoint) => string, choiceParam: (e: BarEndpoint) => string | null, opts: { random?: () => number } = {}): { items: PropValue[]; ops: DraftOp[] } {
  const items: PropValue[] = [];
  const ops: DraftOp[] = [];
  const pending = { dataSources: [...doc.dataSources] };
  const taken: string[] = [];
  for (const w of BAR_MEASURES) {
    let ep: BarEndpoint | undefined;
    let params: Record<string, PropValue> = {};
    if (machine) {
      ep = endpoints.find((e) => !e.advanced && !e.id.startsWith("h:") && e.shape === "stat" && measureOf(e) === w.measure && !!choiceParam(e));
      if (ep) params = { [choiceParam(ep)!]: machine.thing };
    } else {
      ep = endpoints.find((e) => e.id === "host");
      params = { measure: w.measure };
    }
    if (!ep) continue;
    const m = ensureManaged(pending, { integrationId, endpointId: ep.id, params, label: `${machine ? ep.label : w.label === "Up" ? "Uptime" : w.label}, ${machine?.label ?? "this server"}`, defaultRefreshSec: ep.defaultRefreshSec, minRefreshSec: ep.minRefreshSec, ...(ep.params ? { schema: ep.params } : {}) }, { ...(opts.random ? { random: opts.random } : {}), taken });
    for (const o of m.ops) if (o.op === "source.set") { pending.dataSources.push(o.source); taken.push(o.source.name); }
    ops.push(...m.ops);
    items.push({ icon: w.icon, label: w.label, value: { $bind: `{{ ${m.name} }}` }, ...(w.percent ? { percent: { $bind: `{{ ${m.name}.value }}` } } : {}) });
  }
  return { items, ops };
}
