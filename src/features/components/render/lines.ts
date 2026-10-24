// Chart lines (architecture Amendment 10, A10.2): a chart's list of lines, each its own read, turned into
// the series it draws. Naming: a line holding one series is named by its label, else the series display,
// else its name; a line holding several draws each, as "<label> · <display>" when the label is set.
// Axes: lines group by (format, unit); the first group uses the left axis, the second the right, a third
// is refused. At most 20 series are drawn, the highest latest value first, with "20 of N". Pure.
import type { ShapedData, ValueFormat } from "@/core/contracts";
import { SERIES_COLORS } from "../catalogue/schemas";

export const MAX_LINE_SERIES = 20;
export type LineInput = { data?: unknown; label?: unknown; color?: unknown; hidden?: unknown };
export type AxisGroup = { format?: ValueFormat; unit?: string; key: string };
export type DrawnSeries = {
  key: string;
  /** The line it came from (index in `lines`). */
  line: number;
  name: string;
  stroke: string;
  dash: string;
  axis: 0 | 1;
  points: [number, number | null][];
  latest: number | null;
};
export type LinesPlan = {
  /** What is drawn: at most 20, in line order (or highest latest first when more than 20 were offered). */
  series: DrawnSeries[];
  /** Every series offered by the visible lines on the two axes. */
  total: number;
  axes: AxisGroup[];
  /** Lines whose unit is a third one: not drawn. */
  refused: number[];
  /** Lines with no series data yet (loading, failed or the wrong shape). */
  waiting: number[];
};

type Series = Extract<ShapedData, { kind: "series" }>;
const isSeries = (v: unknown): v is Series => !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "series" && Array.isArray((v as { series?: unknown }).series);

/** The CSS colour of "series1" to "series8" (theme tokens, components.css) or a hex colour; null for anything else. */
export function lineStroke(color: unknown): string | null {
  if (typeof color !== "string") return null;
  const i = (SERIES_COLORS as readonly string[]).indexOf(color);
  if (i >= 0) return `var(--atr-series-${i + 1})`;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}
/** The nth automatic colour: the eight theme series colours, then again with dashes. */
export function autoStroke(n: number): { stroke: string; dash: string } {
  const dashes = ["", "6 3", "2 3", "8 3 2 3"];
  return { stroke: `var(--atr-series-${(n % 8) + 1})`, dash: dashes[Math.floor(n / 8) % dashes.length]! };
}

/** The axis key of a series source: its format and unit. */
export function axisKey(d: { format?: ValueFormat; unit?: string }): string {
  return `${d.format ?? ""}|${d.unit ?? ""}`;
}

/** The series' name for a line (A10.2 naming rules). */
export function lineSeriesName(label: string, s: { name: string; display?: string }, many: boolean): string {
  const own = s.display?.trim() || s.name;
  if (!many) return label || own;
  return label ? `${label} · ${own}` : own;
}

function latestOf(points: [number, number | null][]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i]![1];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

export function planLines(lines: readonly LineInput[], max = MAX_LINE_SERIES): LinesPlan {
  const axes: AxisGroup[] = [];
  const refused: number[] = [];
  const waiting: number[] = [];
  const all: DrawnSeries[] = [];
  let auto = 0;
  lines.forEach((ln, li) => {
    if (!ln || ln.hidden === true) return;
    const d = ln.data;
    if (!isSeries(d)) {
      waiting.push(li);
      return;
    }
    const key = axisKey(d);
    let axis = axes.findIndex((a) => a.key === key);
    if (axis < 0) {
      if (axes.length >= 2) {
        refused.push(li);
        return;
      }
      axes.push({ key, ...(d.format ? { format: d.format } : {}), ...(d.unit ? { unit: d.unit } : {}) });
      axis = axes.length - 1;
    }
    const label = typeof ln.label === "string" ? ln.label.trim() : "";
    const own = lineStroke(ln.color);
    const many = d.series.length > 1;
    d.series.forEach((s, si) => {
      const a = own ? { stroke: own, dash: si === 0 ? "" : autoStroke(si * 8).dash } : autoStroke(auto++);
      all.push({ key: `${li}:${s.name}`, line: li, name: lineSeriesName(label, s, many), stroke: a.stroke, dash: a.dash, axis: axis as 0 | 1, points: s.points, latest: latestOf(s.points) });
    });
  });
  let series = all;
  if (all.length > max) {
    series = [...all].sort((a, b) => (b.latest ?? -Infinity) - (a.latest ?? -Infinity)).slice(0, max);
  }
  return { series, total: all.length, axes, refused, waiting };
}

/** The one-sentence refusal for a third unit (A10.2 and spec 3.4). */
export function thirdUnitSentence(canPercent: boolean): string {
  return `A chart shows at most two units, and this line would be a third: put it on a new chart${canPercent ? ", or show all as percent" : ""}.`;
}

/** The legend's count line for lines: "N series", or "20 of N series" past the cap. */
export function linesCountText(drawn: number, total: number): string {
  return total > drawn ? `${drawn} of ${total} series` : `${total} series`;
}
