"use client";
// A small inline-SVG line chart for series previews (quality-bar r1 finding: the range preview
// was a sentence with a 16-digit float). The widgets subsystem owns the real chart widget; this
// only has to show the shape of the data. Round 5 (quality-bar r2): every series has its own colour
// token and dash, and the legend shows only the labels that differ between series (the full label
// set is the row's title), with each series' latest value.
import type { ShapedData, ValueFormat } from "@/core/contracts";
import { formatValue } from "@/features/components/render/format";

type Series = Extract<ShapedData, { kind: "series" }>;

/** About three significant digits; whole numbers of 1000 and more keep every digit. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toLocaleString();
  if (a === 0) return "0";
  return Number(n.toPrecision(3)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Colour token and dash per series, so lines differ by more than colour. Shell tokens only. */
export const SERIES_STYLES = [
  { stroke: "stroke-accent", swatch: "bg-accent", dash: undefined, width: 2 },
  { stroke: "stroke-sky-ink", swatch: "bg-sky-ink", dash: "6 3", width: 1.75 },
  { stroke: "stroke-fg", swatch: "bg-fg", dash: "1.5 3", width: 1.75 },
  { stroke: "stroke-accent-ink", swatch: "bg-accent-ink", dash: "8 3 2 3", width: 1.75 },
  { stroke: "stroke-fg-3", swatch: "bg-fg-3", dash: "12 4", width: 1.75 },
] as const;

/** Prometheus-style `metric{a="1",b="2"}` into its metric name and labels. */
export function parseSeriesName(name: string): { metric: string; labels: Record<string, string> } {
  const i = name.indexOf("{");
  const metric = i < 0 ? name : name.slice(0, i);
  const labels: Record<string, string> = {};
  if (i >= 0) for (const m of name.slice(i).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) labels[m[1]!] = m[2]!;
  return { metric, labels };
}

/** Legend names: only the labels whose values differ across the series; the metric name when none do. */
export function legendNames(names: string[]): string[] {
  const parsed = names.map(parseSeriesName);
  const keys = [...new Set(parsed.flatMap((p) => Object.keys(p.labels)))];
  const varying = keys.filter((k) => new Set(parsed.map((p) => p.labels[k] ?? "\u0000")).size > 1);
  return parsed.map((p, i) => {
    if (!varying.length) return p.metric || names[i]!;
    return varying.filter((k) => p.labels[k] !== undefined).map((k) => `${k}="${p.labels[k]}"`).join(", ") || p.metric || names[i]!;
  });
}

/** A8.4: a number in its format ("12.4 GB", "3 d 4 h"), else about three significant digits plus the unit. */
export function shownValue(n: number, format?: ValueFormat, unit?: string): string {
  if (unit) return `${formatNumber(n)} ${unit}`;
  return format ? formatValue(n, format) : formatNumber(n);
}

const W = 320;
const H = 96;
const MAX_LINES = 5;
/** Packages send at most this many series (Prometheus range queries are capped at 20). */
const SENT_CAP = 20;

/** Amendment A4.1: "20 of 312 series" when the source's total is known and larger, else "20 series". */
export function seriesCountText(data: Pick<Series, "series" | "total">): string {
  const n = data.series.length;
  const total = typeof data.total === "number" && Number.isFinite(data.total) ? Math.floor(data.total) : null;
  if (total !== null && total > n) return `${n} of ${total} series`;
  return `${n} series`;
}

export function SeriesChart({ data }: { data: Series }) {
  const series = data.series.filter((s) => s.points.some((p) => p[1] !== null)).slice(0, MAX_LINES);
  const pts = series.flatMap((s) => s.points.filter((p): p is [number, number] => p[1] !== null));
  if (pts.length === 0) return <p className="type-body text-glass-muted">No points in this window.</p>;
  let [t0, t1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  let [v0, v1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  if (t1 === t0) { t0 -= 1; t1 += 1; }
  if (v1 === v0) { v0 -= 1; v1 += 1; }
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = (v: number) => H - 4 - ((v - v0) / (v1 - v0)) * (H - 8);
  const pathOf = (s: Series["series"][number]) => {
    let d = "";
    let pen = false;
    for (const [t, v] of s.points) {
      if (v === null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const unit = data.unit ? ` ${data.unit}` : "";
  const show = (n: number) => (data.unit ? `${formatNumber(n)}${unit}` : shownValue(n, data.format));
  // Quality bar r3: the labels that vary are found across every series received, not only the drawn
  // ones, so a legend never hides which host or cpu a line is.
  // A8.4: a series' own friendly name (display) wins over names worked out from raw labels.
  const allNames = legendNames(data.series.map((s) => s.name));
  const names = series.map((s) => s.display || (allNames[data.series.indexOf(s)] ?? s.name));
  const latest = (s: Series["series"][number]) => [...s.points].reverse().find((p) => p[1] !== null)?.[1] ?? null;
  const span = (t1 - t0) / 1000;
  const spanText = span >= 5400 ? `${Math.round(span / 3600)} h` : `${Math.max(1, Math.round(span / 60))} min`;
  return (
    <figure className="flex flex-col gap-2" data-series-chart>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-24 w-full" role="img" aria-label={`Line chart of ${seriesCountText(data)} over the last ${spanText}, from ${show(v0)} to ${show(v1)}`}>
        <line x1="0" x2={W} y1={H - 4} y2={H - 4} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {series.map((s, i) => ({ s, i })).reverse().map(({ s, i }) => {
          const st = SERIES_STYLES[i % SERIES_STYLES.length]!;
          return <path key={s.name} d={pathOf(s)} fill="none" className={st.stroke} strokeWidth={st.width} {...(st.dash ? { strokeDasharray: st.dash } : {})} vectorEffect="non-scaling-stroke" data-series-line={i} />;
        })}
      </svg>
      <p className="type-caption text-glass-muted font-mono" data-series-count>
        {seriesCountText(data)}
      </p>
      <figcaption className="flex justify-between type-caption text-glass-muted">
        <span>{spanText} ago</span>
        <span className="font-mono">{show(v0)} to {show(v1)}</span>
        <span>now</span>
      </figcaption>
      <ul className="flex flex-col gap-1" data-series-legend>
        {series.map((s, i) => {
          const l = latest(s);
          const st = SERIES_STYLES[i % SERIES_STYLES.length]!;
          return (
            <li key={s.name} className="flex min-w-0 items-center gap-2 type-caption text-fg" title={s.display ?? s.name}>
              <svg aria-hidden width="20" height="6" className="shrink-0"><line x1="0" x2="20" y1="3" y2="3" className={st.stroke} strokeWidth="2" {...(st.dash ? { strokeDasharray: st.dash } : {})} /></svg>
              <span className="min-w-0 flex-1 truncate font-mono" data-series-name>{names[i]}</span>
              <span className="font-mono" data-series-latest>{l === null ? "no data" : show(l)}</span>
            </li>
          );
        })}
        {(data.series.length > series.length || (data.total ?? 0) > data.series.length) && (
          <li className="type-caption text-glass-muted" data-series-more>
            {(data.total ?? 0) > data.series.length
              ? <>Drawing {series.length} of them. Too many to read here: try <span className="font-mono">sum by (instance) (...)</span>.</>
              : data.series.length >= SENT_CAP
                ? <>Showing {series.length} of {SENT_CAP} or more series. Too many to read here: try <span className="font-mono">sum by (instance) (...)</span>.</>
                : <>Showing {series.length} of {data.series.length} series.</>}
          </li>
        )}
      </ul>
    </figure>
  );
}
