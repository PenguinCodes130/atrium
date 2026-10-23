// Grafana dashboard import (spec 3.4, research 5.1, A9.4): a dashboard's panels become a draft
// Prometheus recipe. Pure, no I/O: the download lives in service.ts.
//
//   panel title, description, row title    -> read label, description, group
//   stat, gauge, bar gauge / time series / table -> stat / series / table
//   fieldConfig unit                       -> format (percentunit times 100, bits per second / 8)
//   legendFormat {{device}}                -> series names
//   label_values(metric, label) variables  -> "which machine" dropdowns (a label-values read)
//   $__rate_interval, $__interval          -> 5m; $__range -> the read's hours
// Panels Atrium cannot map (transformations, non-Prometheus data, unknown panel types, Grafana
// placeholders it cannot fill) are listed as skipped with the reason.
import type { JsonSchema, RecipeRead, ValueFormat } from "@/core/contracts";
import type { RecipeFile } from "./schema";

export type Skipped = { title: string; reason: string };
export type GrafanaMapping = { recipe: RecipeFile; skipped: Skipped[]; panels: number };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

const FRIENDLY_LABELS = ["nodename", "hostname", "host", "name", "alias", "instance_name"];
const STAT_TYPES = new Set(["stat", "gauge", "bargauge", "singlestat"]);
const SERIES_TYPES = new Set(["timeseries", "graph"]);
const PANEL_WORDS: Record<string, string> = { text: "text", heatmap: "heat map", piechart: "pie chart", "state-timeline": "state timeline", "status-history": "status history", logs: "logs", news: "news", dashlist: "dashboard list", alertlist: "alert list", nodeGraph: "node graph", histogram: "histogram", xychart: "XY chart", canvas: "canvas", geomap: "map", barchart: "bar chart", trend: "trend", candlestick: "candlestick", flamegraph: "flame graph", traces: "traces" };

/** A unit to an A8.4 format, and how the query must change for it. */
export function unitFormat(unit: string): { format?: ValueFormat; scale?: string } {
  switch (unit) {
    case "bytes": case "decbytes": return { format: "bytes" };
    case "kbytes": case "deckbytes": return { format: "bytes", scale: "* 1024" };
    case "mbytes": case "decmbytes": return { format: "bytes", scale: "* 1048576" };
    case "gbytes": case "decgbytes": return { format: "bytes", scale: "* 1073741824" };
    case "bits": case "decbits": return { format: "bytes", scale: "/ 8" };
    case "percent": return { format: "percent" };
    case "percentunit": return { format: "percent", scale: "* 100" };
    case "s": case "dtdurations": return { format: "seconds" };
    case "ms": return { format: "seconds", scale: "/ 1000" };
    case "m": return { format: "seconds", scale: "* 60" };
    case "h": return { format: "seconds", scale: "* 3600" };
    case "d": return { format: "seconds", scale: "* 86400" };
    case "Bps": case "binBps": case "decBps": return { format: "bytesPerSec" };
    case "KBs": case "KiBs": return { format: "bytesPerSec", scale: "* 1024" };
    case "MBs": case "MiBs": return { format: "bytesPerSec", scale: "* 1048576" };
    case "bps": case "binbps": case "decbps": return { format: "bytesPerSec", scale: "/ 8" };
    case "celsius": return { format: "celsius" };
    case "short": case "none": case "": case "number": return { format: "number" };
    default: return {};
  }
}

type Variable =
  | { kind: "query"; name: string; title: string; metric: string; label: string; selector: string; refs: string[] }
  | { kind: "custom"; name: string; title: string; options: { value: string; label: string }[]; current?: string }
  | { kind: "constant" | "interval"; name: string; value: string }
  | { kind: "textbox"; name: string; title: string; current?: string }
  | { kind: "unsupported"; name: string; why: string };

const VAR_REF = (names: string[]) => new RegExp(`\\$\\{(${names.join("|")})(?::[A-Za-z]+)?\\}|\\$(${names.join("|")})\\b|\\[\\[(${names.join("|")})(?::[A-Za-z]+)?\\]\\]`, "g");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const paramName = (n: string) => (n.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([0-9])/, "_$1") || "value").slice(0, 60);

function parseLabelValues(q: string): { metric: string; label: string; selector: string } | null {
  const m = /^\s*label_values\(\s*(?:([A-Za-z_:][A-Za-z0-9_:]*)\s*(\{[^}]*\})?\s*,\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$/.exec(q);
  if (!m || !m[1]) return null; // label_values(label) without a metric cannot be read safely
  return { metric: m[1], selector: m[2] ?? "", label: m[3]! };
}

function variables(d: Obj): Variable[] {
  const list = isObj(d.templating) && Array.isArray(d.templating.list) ? (d.templating.list as unknown[]) : [];
  const out: Variable[] = [];
  for (const v of list) {
    if (!isObj(v)) continue;
    const name = str(v.name);
    if (!name) continue;
    const title = str(v.label) || name;
    const type = str(v.type);
    const current = isObj(v.current) ? (Array.isArray(v.current.value) ? str(v.current.value[0]) : str(v.current.value)) : "";
    if (type === "datasource" || type === "adhoc") continue;
    if (type === "query") {
      const q = typeof v.query === "string" ? v.query : isObj(v.query) ? str(v.query.query) : "";
      const lv = parseLabelValues(q || str(v.definition));
      if (!lv) { out.push({ kind: "unsupported", name, why: `the dashboard setting $${name} comes from a query Atrium cannot list (${(q || "no query").slice(0, 60)})` }); continue; }
      out.push({ kind: "query", name, title, ...lv, refs: [] });
    } else if (type === "custom") {
      const options = str(v.query).split(/,(?![^{]*\})/).map((x) => x.trim()).filter(Boolean).map((x) => {
        const kv = /^(.*?)\s:\s(.*)$/.exec(x);
        return kv ? { label: kv[1]!.trim(), value: kv[2]!.trim() } : { label: x, value: x };
      });
      out.push({ kind: "custom", name, title, options, ...(current ? { current } : {}) });
    } else if (type === "constant") out.push({ kind: "constant", name, value: str(v.query) || current });
    else if (type === "interval") out.push({ kind: "interval", name, value: "5m" });
    else if (type === "textbox") out.push({ kind: "textbox", name, title, ...(current || str(v.query) ? { current: current || str(v.query) } : {}) });
    else out.push({ kind: "unsupported", name, why: `the dashboard setting $${name} is a ${type || "kind of"} setting Atrium does not know` });
  }
  const names = out.map((v) => v.name);
  for (const v of out) if (v.kind === "query") v.refs = [...v.selector.matchAll(VAR_REF(names.map(escapeRe)))].map((m) => m[1] ?? m[2] ?? m[3]!).filter((n) => n !== v.name);
  return out;
}

function hoursOf(d: Obj): number {
  const from = isObj(d.time) ? str(d.time.from) : "";
  const m = /^now-(\d+)([mhdw])$/.exec(from);
  if (!m) return 6;
  const n = Number(m[1]);
  const h = m[2] === "m" ? n / 60 : m[2] === "h" ? n : m[2] === "d" ? n * 24 : n * 24 * 7;
  return Math.min(Math.max(h, 0.25), 24 * 30);
}

/** Converts one PromQL expression, or says why it cannot be used. */
export function convertExpr(exprIn: string, vars: Variable[], leaves: Set<string>, hours: number): { expr: string; used: string[] } | { skip: string } {
  let expr = exprIn
    .replace(/\$\{?__rate_interval\b\}?|\$\{?__interval\b\}?/g, "5m")
    .replace(/\$\{?__range_s\b\}?/g, String(Math.round(hours * 3600)))
    .replace(/\$\{?__range_ms\b\}?/g, String(Math.round(hours * 3_600_000)))
    .replace(/\$\{?__range\b\}?/g, `${Math.round(hours * 60)}m`);
  const grafanaLeft = /\$\{?(__[A-Za-z_]+)/.exec(expr);
  if (grafanaLeft) return { skip: `uses Grafana's $${grafanaLeft[1]}, which Atrium cannot fill` };
  const byName = new Map(vars.map((v) => [v.name, v]));
  const names = vars.map((v) => escapeRe(v.name));
  const used = new Set<string>();
  let problem: string | null = null;
  if (names.length) {
    // A matcher whose whole value is one dashboard setting: label="$node"
    const matcher = new RegExp(`([A-Za-z_][A-Za-z0-9_]*)\\s*(=~|!~|!=|=)\\s*"(?:\\$\\{(${names.join("|")})(?::[A-Za-z]+)?\\}|\\$(${names.join("|")})|\\[\\[(${names.join("|")})(?::[A-Za-z]+)?\\]\\])"`, "g");
    expr = expr.replace(matcher, (all, label: string, op: string, a?: string, b?: string, c?: string) => {
      const v = byName.get((a ?? b ?? c)!)!;
      if (v.kind === "unsupported") { problem ??= `uses ${v.why}`; return all; }
      if (v.kind === "constant" || v.kind === "interval") return `${label}${op}${JSON.stringify(v.value)}`;
      if (v.kind === "query" && !leaves.has(v.name)) {
        if (op === "=" || op === "=~") return `${label}=~".*"`;
        problem ??= `filters out the dashboard setting $${v.name}, which Atrium does not ask for`;
        return all;
      }
      used.add(paramName(v.name));
      return `${label}${op}{{ params.${paramName(v.name)} }}`;
    });
    // Anything left that names a dashboard setting outside a whole label value.
    expr = expr.replace(VAR_REF(names), (all, a?: string, b?: string, c?: string) => {
      const v = byName.get((a ?? b ?? c)!)!;
      if (v.kind === "constant" || v.kind === "interval") return v.value;
      problem ??= v.kind === "unsupported" ? `uses ${v.why}` : `uses the dashboard setting $${v.name} outside a label value`;
      return all;
    });
  }
  if (problem) return { skip: problem };
  return { expr: expr.trim(), used: [...used] };
}

function slugId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "panel";
}

function clean(s: string, max: number): string {
  return s.replace(/<[^>]*>/g, " ").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

type Panel = Obj & { type?: string; title?: string };

/** Panels in order, with the title of the row each sits under (collapsed rows hold their own). */
function panelsWithRows(d: Obj): { panel: Panel; row: string }[] {
  const out: { panel: Panel; row: string }[] = [];
  let row = "";
  for (const p of Array.isArray(d.panels) ? (d.panels as unknown[]) : []) {
    if (!isObj(p)) continue;
    if (p.type === "row") {
      row = clean(str(p.title), 60);
      for (const q of Array.isArray(p.panels) ? (p.panels as unknown[]) : []) if (isObj(q)) out.push({ panel: q as Panel, row });
      continue;
    }
    out.push({ panel: p as Panel, row });
  }
  return out;
}

const dsType = (ds: unknown) => (isObj(ds) ? str(ds.type) : typeof ds === "string" ? ds : "");
const okDatasource = (t: string) => !t || t === "prometheus" || t === "datasource" || t.startsWith("$") || t === "-- Mixed --" || /^\$\{.*\}$/.test(t) || t === "default";

/** Maps a Grafana dashboard JSON (the dashboard, or { dashboard }) to a draft recipe. */
export function mapDashboard(input: unknown): GrafanaMapping {
  const d = isObj(input) && isObj(input.dashboard) ? input.dashboard : input;
  if (!isObj(d) || (!Array.isArray(d.panels) && !Array.isArray(d.rows))) throw new Error("This is not a Grafana dashboard: it has no panels.");
  if (Array.isArray(d.rows) && !Array.isArray(d.panels)) throw new Error("This dashboard uses Grafana's old rows format. Open it in a current Grafana and export it again.");
  const title = clean(str(d.title), 120) || "Grafana dashboard";
  const gnet = typeof d.gnetId === "number" || typeof d.gnetId === "string" ? String(d.gnetId) : "";
  const id = `grafana/${gnet && /^\d+$/.test(gnet) ? gnet : slugId(str(d.uid) || title)}`;
  const hours = hoursOf(d);
  const vars = variables(d);
  const queryVars = vars.filter((v): v is Extract<Variable, { kind: "query" }> => v.kind === "query");
  const referenced = new Set(queryVars.flatMap((v) => v.refs));
  const leaves = new Set(queryVars.filter((v) => !referenced.has(v.name)).map((v) => v.name));
  const reads: RecipeRead[] = [];
  const skipped: Skipped[] = [];
  const ids = new Set<string>();
  const uniqueId = (base: string) => {
    let s = base.slice(0, 40);
    for (let i = 2; ids.has(s); i++) s = `${base.slice(0, 36)}-${i}`;
    ids.add(s);
    return s;
  };

  // "Which machine" lists: one label-values read per setting a person picks.
  const paramProps: Record<string, Obj> = {};
  for (const v of vars) {
    if (v.kind === "query" && leaves.has(v.name)) {
      const listId = uniqueId(`list-${slugId(v.name)}`);
      const friendly = queryVars.find((o) => v.refs.includes(o.name) && FRIENDLY_LABELS.includes(o.label))?.label;
      reads.push({ id: listId, label: `${clean(v.title, 80)} list`, description: `The choices for ${clean(v.title, 80).toLowerCase()} on this server.`, group: "Lists", advanced: true, request: { kind: "label-values", metric: v.metric, label: v.label, ...(friendly ? { display: friendly } : {}) }, shape: "table", refreshSec: 300 });
      paramProps[paramName(v.name)] = { type: "string", title: clean(v.title, 60), description: `Pick ${clean(v.title, 60).toLowerCase()}.`, "x-atrium-choices": { endpointId: listId, value: "value", label: "label", detail: "detail" } };
    } else if (v.kind === "custom") {
      paramProps[paramName(v.name)] = { type: "string", title: clean(v.title, 60), enum: v.options.map((o) => o.value), "x-atrium-labels": v.options.map((o) => o.label), ...(v.current && v.options.some((o) => o.value === v.current) ? { default: v.current } : v.options[0] ? { default: v.options[0].value } : {}) };
    } else if (v.kind === "textbox") {
      paramProps[paramName(v.name)] = { type: "string", title: clean(v.title, 60), ...(v.current ? { default: v.current } : {}) };
    }
  }

  const all = panelsWithRows(d);
  for (const { panel: p, row } of all) {
    const ptitle = clean(str(p.title), 100) || `Panel ${String(p.id ?? "")}`.trim();
    const type = str(p.type);
    if (isObj(p.libraryPanel)) { skipped.push({ title: ptitle, reason: "is a library panel, which the file does not include" }); continue; }
    const shape = STAT_TYPES.has(type) ? "stat" : SERIES_TYPES.has(type) ? "series" : type === "table" ? "table" : null;
    if (!shape) { skipped.push({ title: ptitle, reason: `is a ${PANEL_WORDS[type] ?? type ?? "kind of"} panel, which Atrium has no shape for` }); continue; }
    if (!okDatasource(dsType(p.datasource))) { skipped.push({ title: ptitle, reason: `reads from a ${dsType(p.datasource)} data source, not Prometheus` }); continue; }
    if (Array.isArray(p.transformations) && p.transformations.length) { skipped.push({ title: ptitle, reason: "uses Grafana transformations, which Atrium does not run" }); continue; }
    const targets = (Array.isArray(p.targets) ? (p.targets as unknown[]) : []).filter((t): t is Obj => isObj(t) && !t.hide);
    const proms = targets.filter((t) => okDatasource(dsType(t.datasource)) && str(t.expr).trim());
    if (!proms.length) { skipped.push({ title: ptitle, reason: targets.length ? "has no Prometheus query" : "has no query" }); continue; }
    const defaults = isObj(p.fieldConfig) && isObj(p.fieldConfig.defaults) ? p.fieldConfig.defaults : {};
    const unit = str(defaults.unit) || str((p.yaxes as Obj[] | undefined)?.[0]?.format);
    const { format, scale } = unitFormat(unit);
    const description = clean(str(p.description), 1000);
    for (const t of proms) {
      const conv = convertExpr(str(t.expr), vars, leaves, hours);
      const legend = str(t.legendFormat).trim();
      const words = legend && legend !== "__auto" ? clean(legend.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, " ").replace(/\s*-\s*$/, "").replace(/^\s*-\s*/, ""), 50) : "";
      const label = proms.length > 1 ? `${ptitle}: ${words || str(t.refId) || String(proms.indexOf(t) + 1)}` : ptitle;
      if ("skip" in conv) { skipped.push({ title: label, reason: conv.skip }); continue; }
      const expr = scale ? `(${conv.expr}) ${scale}` : conv.expr;
      const props = Object.fromEntries(conv.used.map((n) => [n, paramProps[n]!]).filter(([, v]) => v));
      const params: JsonSchema | undefined = Object.keys(props).length ? { type: "object", properties: props, required: Object.keys(props).filter((k) => !("default" in (props[k] as Obj))) } : undefined;
      const tableFormat = shape === "table" || str(t.format) === "table";
      reads.push({
        id: uniqueId(slugId(proms.length > 1 ? `${ptitle}-${words || str(t.refId)}` : ptitle)),
        label: label.slice(0, 120),
        ...(description ? { description } : {}),
        group: row || "Overview",
        ...(params ? { params } : {}),
        request: { kind: "promql", expr, ...(shape === "series" ? { range: { hours, stepSec: Math.max(30, Math.ceil((hours * 3600) / 240)) } } : {}) },
        shape: tableFormat && shape !== "series" ? "table" : shape,
        ...(format && !(tableFormat && shape !== "series") ? { format } : {}),
        ...(format && tableFormat && shape !== "series" ? { columnFormats: { value: format } } : {}),
        ...(legend && legend !== "__auto" ? { seriesName: legend.slice(0, 300) } : {}),
        refreshSec: 60,
      });
    }
  }
  if (!reads.some((r) => r.request.kind === "promql")) throw new Error("No panel of this dashboard could become a read.");
  const metrics = [...new Set(queryVars.filter((v) => leaves.has(v.name)).map((v) => v.metric))];
  const recipe: RecipeFile = {
    atriumRecipe: "1",
    id,
    name: title,
    version: String(d.version ?? "1"),
    author: "Grafana dashboard",
    description: clean(str(d.description), 2000) || `Imported from the Grafana dashboard "${title}"${gnet ? ` (grafana.com ${gnet})` : ""}.`,
    source: "grafana",
    appliesTo: metrics.length ? { metrics } : { package: "prometheus" },
    reads,
  };
  return { recipe, skipped, panels: all.length };
}
