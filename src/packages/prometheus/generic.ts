// A9.4: the Prometheus package's generic recipe read. It runs a recipe's `promql` and `label-values`
// reads through the same query API calls as every other read (GET /api/v1/query and query_range).
// A value a person picks enters PromQL only as an escaped string literal (lit()), never as raw text;
// label and metric names are checked against their name patterns.
import type { AdapterContext, RecipeRead, ShapedData } from "@/core/contracts";
import { fail, num } from "../lib";
import { machineNames, matrix, vector } from "./api";
import { friendlyName, labelName, lit, metricName, rangeFor, round, seriesDisplays, seriesKey } from "./promql";
import { runRecipe, type Recipe as PromRecord } from "./recipe";

/** The answer when a query has no samples; the live check counts it as empty, not failed. */
export const NO_VALUE = "Prometheus has no value for this right now.";

type Props = Record<string, { default?: unknown; title?: string; enum?: unknown[] }>;
const propsOf = (schema: unknown): Props => (((schema as { properties?: Props } | undefined)?.properties ?? {}) as Props);

/** Fills {{ params.x }} in a PromQL template with each value as a quoted, escaped string literal. */
export function fillExpr(expr: string, params: Record<string, unknown>, schema?: unknown): string {
  const props = propsOf(schema);
  return expr.replace(/\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => {
    const raw = params[name] ?? props[name]?.default;
    const v = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
    if (!v) fail("config", `Pick ${(props[name]?.title ?? name).toLowerCase()} first.`, `The "${name}" setting is required for this read.`);
    const p = props[name];
    if (Array.isArray(p?.enum) && !p.enum.map(String).includes(v)) fail("config", `"${v.slice(0, 40)}" is not one of the choices for ${p?.title ?? name}.`);
    return lit(v);
  });
}

/** Grafana legend syntax ({{device}}) over one series' labels. */
export function legendText(template: string, metric: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, l: string) => metric[l] ?? "").replace(/\s+/g, " ").trim();
}

const usableLegend = (t: string | undefined) => !!t && t !== "__auto" && t.trim() !== "";

/** A label-values read: the distinct values of a label, with a friendly name, as a choices table. */
async function labelValues(ctx: AdapterContext, req: Extract<RecipeRead["request"], { kind: "label-values" }>): Promise<ShapedData> {
  const metric = metricName(req.metric);
  const label = labelName(req.label);
  const display = req.display ? labelName(req.display, "display label") : undefined;
  const by = [...new Set([label, ...(display ? [display] : []), "host", "hostname", "alias", "nodename", "job"])];
  const samples = await vector(ctx, `group by (${by.join(", ")}) (${metric})`);
  const seen = new Map<string, { value: string; label: string; detail: string }>();
  for (const s of samples) {
    const value = s.metric[label];
    if (!value || seen.has(value)) continue;
    const shown = label === "instance" ? friendlyName(s.metric, display ? s.metric[display] : s.metric.nodename) : (display && s.metric[display]) || value;
    seen.set(value, { value, label: shown, detail: shown === value ? "" : value });
  }
  const rows = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base", numeric: true }));
  return { kind: "table", columns: [{ key: "value", label: "Value", type: "text" }, { key: "label", label: "Name", type: "text" }, { key: "detail", label: "Detail", type: "text" }], rows, total: rows.length };
}

/** Runs one promql or label-values recipe read. Built-in style reads run their Wave 2.7 record. */
export async function runPromRead(ctx: AdapterContext, read: RecipeRead, params: Record<string, unknown>, record?: PromRecord | null): Promise<{ data: ShapedData }> {
  if (record) return runRecipe(record, ctx, params);
  const req = read.request;
  if (req.kind === "label-values") return { data: await labelValues(ctx, req) };
  if (req.kind !== "promql") fail("config", "This read is not a Prometheus query.");
  const expr = fillExpr(req.expr, params, read.params);
  const fmt = read.format ? { format: read.format } : {};
  if (read.shape === "series") {
    const hoursIn = params.hours ?? req.range?.hours ?? 6;
    const r = rangeFor(hoursIn, ctx.now().getTime());
    const step = req.range && params.hours === undefined ? Math.max(req.range.stepSec, Math.ceil((r.hours * 3600) / 11_000)) : r.step;
    const { lines, total } = await matrix(ctx, expr, { start: r.start, end: r.end, step });
    const names = lines.some((l) => l.metric.instance) ? await machineNames(ctx) : new Map<string, string>();
    const fallback = seriesDisplays(lines.map((l) => l.metric), names);
    const series = lines.map((l, i) => ({ name: seriesKey(l.metric), display: (usableLegend(read.seriesName) ? legendText(read.seriesName!, l.metric) : "") || fallback[i] || read.label, points: l.points }));
    return { data: { kind: "series", series, total, ...fmt } };
  }
  const samples = await vector(ctx, expr);
  if (read.shape === "stat") {
    const pick = samples.find((s) => s.value !== null);
    if (!pick) fail("bad_response", NO_VALUE, "Check the machine is up and its exporter is scraped.");
    return { data: { kind: "stat", value: round(pick.value) ?? 0, label: read.label, ...fmt } };
  }
  if (read.shape === "status") {
    const items = samples.map((s, i) => {
      const v = num(s.value);
      const state: "up" | "down" | "unknown" = v === 1 ? "up" : v === 0 ? "down" : "unknown";
      return { label: (usableLegend(read.seriesName) ? legendText(read.seriesName!, s.metric) : "") || friendlyName(s.metric) || `Item ${i + 1}`, state };
    });
    return { data: { kind: "status", items } };
  }
  // table: one row per sample, the labels that tell rows apart, then the value
  const keys = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.metric)) if (k !== "__name__") keys.add(k);
  const varying = samples.length > 1 ? [...keys].filter((k) => new Set(samples.map((s) => s.metric[k] ?? "")).size > 1) : [...keys];
  const valueFormat = read.columnFormats?.value ?? read.format;
  const columns = [
    ...(usableLegend(read.seriesName) ? [{ key: "name", label: "Name", type: "text" as const }] : []),
    ...varying.map((k) => ({ key: k, label: k, type: "text" as const, ...(read.columnFormats?.[k] ? { format: read.columnFormats[k] } : {}) })),
    { key: "value", label: read.label, type: "number" as const, ...(valueFormat ? { format: valueFormat } : {}) },
  ];
  const rows = samples.map((s) => ({
    ...(usableLegend(read.seriesName) ? { name: legendText(read.seriesName!, s.metric) } : {}),
    ...Object.fromEntries(varying.map((k) => [k, s.metric[k] ?? ""])),
    value: round(s.value, 4),
  }));
  return { data: { kind: "table", columns, rows, total: rows.length } };
}
