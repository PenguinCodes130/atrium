// Prometheus read recipes (Wave 2.7, data ease spec 3.3; lead request from the integration scaling
// research): each ready-made read is one plain, JSON-serialisable record in recipes.json, run by the
// one interpreter below. A later "recipe file" format can load the same shape through `recipeSchema`.
//
// Query placeholders (values a person picks only ever enter a query as escaped string literals):
//   {{machine}}            `instance="<machine>",` or nothing for "every" (A8.2 value "*")
//   {{match:<p>:<label>}}  `<label>="<param p>",` or nothing when p is "*" or empty
//   {{lit:<p>}}            param p (or its default) as a quoted, escaped literal
//   {{int:<p>}}            param p as a whole number between 1 and 100
//   {{NIC}} {{FS}}         the physical network card and real filesystem matchers, each with a trailing comma
//   {{measure}}            the measure's query (see `measure`), filtered to the machine; {{measure:<key>}} names one
//   {{mount}}              the `mount` param as a literal, "/" when there is none
// A trailing comma inside { } is valid PromQL, so `node_load5{ {{machine}} }` works both ways.
//
// Text templates (row names, details, column values): {machine} (the friendly machine name of the
// sample's instance), {label:<l>}, {col:<column key>}, {value}, {measure}.
import { z } from "zod";
import type { AdapterContext, EndpointDef, ShapedData, ValueFormat } from "@/core/contracts";
import { fail, num } from "../lib";
import { machines, matrix, nameMap, vector, type Sample } from "./api";
import { EVERY, FS, MEASURES, NIC, lit, rangeFor, round, seriesKey, type Measure, type MeasureKey } from "./promql";

const FORMATS = ["percent", "bytes", "bytesPerSec", "seconds", "celsius", "number"] as const;
const plainFormat = z.union([z.enum(FORMATS), z.literal("measure")]);
/** A value, or one value per choice of a param ("cpu" or "memory"). */
const byParam = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.object({ param: z.string(), cases: z.record(z.string(), t) })]);
const format = byParam(plainFormat);
const query = byParam(z.string().min(1));

const column = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "number", "time", "status", "link"]).optional(),
  format: plainFormat.optional(),
  /** A text template over the row sample, or a query joined to the row by the recipe's key labels. */
  value: z.union([z.string(), z.object({ query: z.string().min(1) })]),
  /** Maps the value's text to words ("qemu" to "VM"); "" is the key for a missing value. */
  map: z.record(z.string(), z.string()).optional(),
  /** This column is a row's main field (preselected for "A card for each"). */
  main: z.boolean().optional(),
});
export type RecipeColumn = z.infer<typeof column>;

const measureRef = z.union([z.object({ fixed: z.string() }), z.object({ param: z.string(), map: z.record(z.string(), z.string()).optional() })]);

const base = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),
  label: z.string().min(1),
  description: z.string().min(1),
  group: z.string().min(1),
  advanced: z.boolean().optional(),
  /** Shown only when one of these metrics exists, with `text` saying what the server lacks. */
  needs: z.object({ anyMetric: z.array(z.string().min(1)).min(1), text: z.string().min(1) }).optional(),
  refresh: z.tuple([z.number().positive(), z.number().positive()]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  measure: measureRef.optional(),
};

const every = z.object({ param: z.string(), key: z.string(), name: z.string() });

export const recipeSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("stat"), query, format: format.optional(), statLabel: z.string().optional(), every: every.optional(), empty: z.string().optional() }),
  z.object({ ...base, kind: z.literal("table"), rows: z.string().min(1), key: z.array(z.string().min(1)).min(1), columns: z.array(column).min(1), sort: z.object({ by: z.string(), desc: z.boolean().optional() }).optional(), machinesOnly: z.boolean().optional() }),
  z.object({ ...base, kind: z.literal("status"), query, name: z.string(), state: z.enum(["value", "zeroUp", "down", "warn"]), detail: z.string().optional(), machinesOnly: z.boolean().optional() }),
  z.object({ ...base, kind: z.literal("series"), query, format: format.optional(), name: z.string() }),
]);
export type Recipe = z.infer<typeof recipeSchema>;

const SHAPE = { stat: "stat", table: "table", status: "status", series: "series" } as const;

/** The manifest endpoint a recipe declares (A8.1 group, advanced, needs). */
export function endpointOf(r: Recipe): EndpointDef {
  const [def, min] = r.refresh ?? [30, 15];
  return {
    id: r.id, label: r.label, description: r.description, shape: SHAPE[r.kind], defaultRefreshSec: def, minRefreshSec: min, group: r.group,
    ...(r.params ? { params: r.params } : {}), ...(r.advanced ? { advanced: true } : {}), ...(r.needs ? { needs: r.needs.text } : {}),
  };
}

// ---- Params ----

type Props = Record<string, { default?: unknown; enum?: unknown[]; type?: string; title?: string }>;

function props(r: Recipe): Props {
  return ((r.params as { properties?: Props } | undefined)?.properties ?? {}) as Props;
}

function required(r: Recipe): string[] {
  return ((r.params as { required?: string[] } | undefined)?.required ?? []) as string[];
}

/** A param's value as text: the given value, else the schema default. Enum params are checked. */
function textParam(r: Recipe, params: Record<string, unknown>, key: string): string {
  const p = props(r)[key];
  const raw = params[key] ?? p?.default;
  const v = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  if (!v && required(r).includes(key)) fail("config", `Pick ${(p?.title ?? key).toLowerCase()} first.`, `The "${key}" setting is required for this read.`);
  if (v && Array.isArray(p?.enum) && !p.enum.map(String).includes(v)) fail("config", `"${v.slice(0, 40)}" is not one of the choices for ${p?.title ?? key}.`);
  return v;
}

function measureOf(r: Recipe, params: Record<string, unknown>): Measure | undefined {
  if (!r.measure) return undefined;
  const key = "fixed" in r.measure ? r.measure.fixed : (r.measure.map?.[textParam(r, params, r.measure.param)] ?? textParam(r, params, r.measure.param));
  const m = MEASURES[key as MeasureKey];
  if (!m) fail("config", `"${key}" is not a measure Atrium knows.`);
  return m;
}

/** Fills the query placeholders. Unknown placeholders are a recipe bug and fail loudly. */
export function fillQuery(r: Recipe, template: string, params: Record<string, unknown>, depth = 0): string {
  const match = (p: string, label: string) => {
    const v = textParam(r, params, p);
    return !v || v === EVERY ? "" : `${label}=${lit(v)},`;
  };
  return template.replace(/\{\{([^}]+)\}\}/g, (_, token: string) => {
    const [kind, a, b] = token.trim().split(":");
    switch (kind) {
      case "machine": return match("machine", "instance");
      case "match": return match(a!, b!);
      case "lit": return lit(textParam(r, params, a!));
      case "int": {
        const n = Math.round(num(textParam(r, params, a!)) ?? NaN);
        if (!Number.isFinite(n) || n < 1 || n > 100) fail("config", `"${a}" must be a whole number from 1 to 100.`);
        return String(n);
      }
      case "NIC": return `${NIC},`;
      case "FS": return `${FS},`;
      case "mount": return lit((props(r).mount ? textParam(r, params, "mount") : "") || "/");
      case "measure": {
        const m = a ? MEASURES[a as MeasureKey] : measureOf(r, params);
        if (!m) throw new Error(`recipe ${r.id} uses {{${token}}} without a known measure`);
        if (depth > 0) throw new Error(`recipe ${r.id}: a measure cannot hold a measure`);
        return fillQuery(r, m.query, params, depth + 1);
      }
      default: throw new Error(`recipe ${r.id} has an unknown placeholder {{${token}}}`);
    }
  });
}

/** The case of a by-param value for these params. */
function byCase<T>(r: Recipe, v: T | { param: string; cases: Record<string, T> } | undefined, params: Record<string, unknown>): T | undefined {
  if (v && typeof v === "object" && "cases" in (v as object)) {
    const c = v as { param: string; cases: Record<string, T> };
    const key = textParam(r, params, c.param);
    if (!(key in c.cases)) fail("config", `"${key.slice(0, 40)}" is not one of the choices for ${c.param}.`);
    return c.cases[key];
  }
  return v as T | undefined;
}

// ---- Text templates ----

type Env = { names: Map<string, string>; measure?: Measure; cols?: Record<string, unknown> };

function text(template: string, s: Sample | undefined, env: Env): string {
  return template.replace(/\{([a-z]+)(?::([^}]+))?\}/g, (_, kind: string, arg?: string) => {
    if (kind === "machine") {
      const inst = s?.metric.instance ?? "";
      return env.names.get(inst) ?? s?.metric.host ?? inst.replace(/:\d+$/, "");
    }
    if (kind === "label") return s?.metric[arg ?? ""] ?? "";
    if (kind === "col") { const v = env.cols?.[arg ?? ""]; return v === null || v === undefined ? "" : String(v); }
    if (kind === "value") return s?.value === null || s?.value === undefined ? "" : String(round(s.value));
    if (kind === "measure") return env.measure?.label ?? "";
    return "";
  }).replace(/\s+·\s*$/, "").trim();
}

const usesMachine = (...t: (string | undefined)[]) => t.some((x) => x?.includes("{machine}"));

function formatOf(f: ValueFormat | "measure" | undefined, m?: Measure): ValueFormat | undefined {
  return f === "measure" ? m?.format : f;
}

type AnyFormat = ValueFormat | "measure" | { param: string; cases: Record<string, ValueFormat | "measure"> } | undefined;

const keyOf = (s: Sample, key: string[]) => key.map((k) => s.metric[k] ?? "").join("\u0000");

// ---- The interpreter ----

export async function runRecipe(r: Recipe, ctx: AdapterContext, params: Record<string, unknown>): Promise<{ data: ShapedData }> {
  const measure = measureOf(r, params);
  switch (r.kind) {
    case "stat": {
      const samples = await vector(ctx, fillQuery(r, byCase(r, r.query, params)!, params));
      const fmt = formatOf(byCase(r, r.format as AnyFormat, params), measure);
      const label = r.statLabel ? text(r.statLabel, undefined, { names: new Map(), ...(measure ? { measure } : {}) }) : r.label;
      const chosen = r.every ? textParam(r, params, r.every.param) : "";
      if (r.every && chosen === EVERY) {
        // A8.2: "every" answers one row per thing instead of one value.
        const names = usesMachine(r.every.name) ? nameMap(await machines(ctx)) : new Map<string, string>();
        const rows = samples.map((s) => ({ name: text(r.every!.name, s, { names }), [r.every!.key]: s.metric[r.every!.key] ?? "", value: round(s.value) }));
        rows.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
        const keyCol = r.every.key === "name" ? [] : [{ key: r.every.key, label: r.every.key === "instance" ? "Address" : "Id", type: "text" as const }];
        return { data: { kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, ...keyCol, { key: "value", label, type: "number", ...(fmt ? { format: fmt } : {}) }], rows, total: rows.length } };
      }
      const pick = r.every && chosen ? (samples.find((s) => s.metric[r.every!.key] === chosen) ?? samples[0]) : samples[0];
      if (!pick || pick.value === null) {
        if (r.empty === "zero") return { data: { kind: "stat", value: 0, label, ...(fmt ? { format: fmt } : {}) } };
        fail("bad_response", r.empty ?? "Prometheus has no value for this right now.", r.empty ? undefined : "Check the machine is up and its exporter is scraped.");
      }
      return { data: { kind: "stat", value: round(pick.value) ?? 0, label, ...(fmt ? { format: fmt } : {}) } };
    }
    case "table": {
      const queries = r.columns.flatMap((c) => (typeof c.value === "object" ? [[c.key, fillQuery(r, c.value.query, params)] as const] : []));
      const needNames = r.machinesOnly || usesMachine(...r.columns.map((c) => (typeof c.value === "string" ? c.value : undefined)));
      const [rowSamples, list, ...cols] = await Promise.all([
        vector(ctx, fillQuery(r, r.rows, params)),
        needNames ? machines(ctx) : Promise.resolve(undefined),
        // A column query that fails (a metric missing on this server) leaves empty cells, never an error.
        ...queries.map(([, q]) => vector(ctx, q).catch(() => [] as Sample[])),
      ]);
      const names = list ? nameMap(list) : new Map<string, string>();
      const joined = new Map(queries.map(([k], i) => {
        const m = new Map<string, number | null>();
        for (const s of cols[i]!) { const key = keyOf(s, r.key); if (!m.has(key)) m.set(key, s.value); }
        return [k, m] as const;
      }));
      const seen = new Set<string>();
      const rows: Record<string, unknown>[] = [];
      for (const s of rowSamples) {
        const key = keyOf(s, r.key);
        if (seen.has(key)) continue;
        if (r.machinesOnly && !names.has(s.metric.instance ?? "")) continue;
        seen.add(key);
        const row: Record<string, unknown> = {};
        for (const c of r.columns) {
          let v: unknown = typeof c.value === "string" ? text(c.value, s, { names, cols: row, ...(measure ? { measure } : {}) }) : round(joined.get(c.key)?.get(key) ?? null);
          if (c.map) v = c.map[v === null || v === undefined ? "" : String(v)] ?? v ?? "";
          row[c.key] = v;
        }
        rows.push(row);
      }
      if (r.sort) {
        const { by, desc } = r.sort;
        rows.sort((a, b) => {
          const x = a[by], y = b[by];
          const c = typeof x === "number" && typeof y === "number" ? x - y : x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : String(x).localeCompare(String(y), "en", { sensitivity: "base", numeric: true });
          return desc ? -c : c;
        });
      }
      const columns = r.columns.map((c) => {
        const fmt = formatOf(c.format, measure);
        return { key: c.key, label: c.label === "{measure}" ? (measure?.label ?? c.key) : c.label, type: c.type ?? (typeof c.value === "object" && !c.map ? "number" : "text"), ...(fmt ? { format: fmt } : {}) };
      });
      return { data: { kind: "table", columns, rows, total: rows.length } };
    }
    case "status": {
      const [samples, list] = await Promise.all([vector(ctx, fillQuery(r, byCase(r, r.query, params)!, params)), r.machinesOnly || usesMachine(r.name, r.detail) ? machines(ctx) : Promise.resolve(undefined)]);
      const names = list ? nameMap(list) : new Map<string, string>();
      const items = samples
        .filter((s) => !r.machinesOnly || names.has(s.metric.instance ?? ""))
        .map((s) => {
          const state: "up" | "down" | "warn" | "unknown" = r.state === "down" ? "down" : r.state === "warn" ? "warn" : r.state === "zeroUp" ? (s.value === 0 ? "up" : "down") : s.value === 1 ? "up" : s.value === 0 ? "down" : "unknown";
          const detail = r.detail ? text(r.detail, s, { names }) : "";
          return { label: text(r.name, s, { names }) || "unknown", state, ...(detail ? { detail } : {}) };
        });
      const rank = { down: 0, warn: 1, unknown: 2, up: 3 } as const;
      items.sort((a, b) => rank[a.state] - rank[b.state] || a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
      return { data: { kind: "status", items } };
    }
    case "series": {
      const range = rangeFor(params.hours, ctx.now().getTime());
      const [{ lines, total }, list] = await Promise.all([matrix(ctx, fillQuery(r, byCase(r, r.query, params)!, params), range), usesMachine(r.name) ? machines(ctx).catch(() => []) : Promise.resolve([])]);
      const names = nameMap(list);
      const fmt = formatOf(byCase(r, r.format as AnyFormat, params), measure);
      const series = lines.map((l) => ({ name: seriesKey(l.metric), display: text(r.name, { metric: l.metric, value: null }, { names, ...(measure ? { measure } : {}) }) || (measure?.label ?? r.label), points: l.points }));
      series.sort((a, b) => a.display.localeCompare(b.display, "en", { sensitivity: "base" }));
      return { data: { kind: "series", series, total, ...(fmt ? { format: fmt } : {}) } };
    }
  }
}

// ---- A10.3: history of an instant read ----

/** The hours a history read offers, and its default. */
export const HISTORY_HOURS = [1, 6, 24, 168] as const;
export const HISTORY_PREFIX = "h:";

/** The `hours` param of a history read: one of 1, 6, 24 or 168 (default 6). */
export function historyHours(v: unknown): number {
  if (v === undefined || v === null || v === "") return 6;
  const n = typeof v === "number" ? v : Number(v);
  if (!(HISTORY_HOURS as readonly number[]).includes(n)) fail("config", `"${String(v).slice(0, 20)}" is not a span Atrium charts.`, "Pick 1, 6, 24 or 168 hours.");
  return n;
}

/** The history read's params schema: the value read's params plus `hours`. */
export function historyParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = (params ?? { type: "object", properties: {} }) as { type?: string; properties?: Record<string, unknown>; required?: string[] };
  return { ...base, type: "object", properties: { ...(base.properties ?? {}), hours: { type: "number", title: "Hours", enum: [...HISTORY_HOURS], default: 6, "x-atrium-labels": { "1": "Last hour", "6": "Last 6 hours", "24": "Last day", "168": "Last week" } } } };
}

/** Whether a built-in read answers one value per sample, so its query can run as a range query. */
export function hasHistory(r: Recipe): boolean {
  return r.kind === "stat" || r.kind === "status";
}

/** The history endpoint of an instant built-in read: h:<id>, the same query over time. */
export function historyEndpointOf(r: Recipe): EndpointDef {
  const e = endpointOf(r);
  return { id: `${HISTORY_PREFIX}${r.id}`, label: `${r.label} over time`, description: `${r.label}, over the last hours.`, shape: "series", defaultRefreshSec: 60, minRefreshSec: 30, ...(e.group ? { group: e.group } : {}), advanced: true, params: historyParams(r.params) };
}

/** Runs a built-in read's query as a range query: one line per sample (per machine for "every"). */
export async function runHistory(r: Recipe, ctx: AdapterContext, params: Record<string, unknown>): Promise<{ data: ShapedData }> {
  if (r.kind !== "stat" && r.kind !== "status") fail("config", "This read has no history.");
  const hours = historyHours(params.hours);
  const measure = measureOf(r, params);
  const range = rangeFor(hours, ctx.now().getTime());
  const template = r.kind === "stat" ? (r.every?.name ?? "{machine}") : r.name;
  const [{ lines, total }, list] = await Promise.all([matrix(ctx, fillQuery(r, byCase(r, r.query, params)!, params), range), usesMachine(template) ? machines(ctx).catch(() => []) : Promise.resolve([])]);
  const names = nameMap(list);
  const fmt = r.kind === "stat" ? formatOf(byCase(r, r.format as AnyFormat, params), measure) : undefined;
  const label = r.kind === "stat" && r.statLabel ? text(r.statLabel, undefined, { names, ...(measure ? { measure } : {}) }) : r.label;
  const series = lines.map((l) => ({ name: seriesKey(l.metric), display: text(template, { metric: l.metric, value: null }, { names, ...(measure ? { measure } : {}) }) || label, points: l.points }));
  series.sort((a, b) => a.display.localeCompare(b.display, "en", { sensitivity: "base" }));
  return { data: { kind: "series", series, total, ...(fmt ? { format: fmt } : {}) } };
}

/** Parses recipes.json; a bad record is a build-time bug, so this throws. */
export function loadRecipes(raw: unknown): Recipe[] {
  const list = z.array(recipeSchema).parse(raw);
  const ids = new Set<string>();
  for (const r of list) {
    if (ids.has(r.id)) throw new Error(`recipe id ${r.id} is used twice`);
    ids.add(r.id);
  }
  return list;
}
