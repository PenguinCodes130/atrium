// A9.2 live check classification. Pure: a read's result becomes works, empty, failed (with the
// reason) or looks odd (bytes under 1 KB, percent over 100, a date in 1970).
import type { ReadCheck, ReadResult, ShapedData, ValueFormat } from "@/core/contracts";
import { RECIPES } from "@/packages/prometheus/full-manifest";
import { NO_VALUE } from "@/packages/prometheus/generic";

/** Answers that mean "nothing here" rather than "broken": the built-in reads' own empty texts. */
const EMPTY_MESSAGES = new Set([NO_VALUE, ...RECIPES.flatMap((r) => ("empty" in r && r.empty && r.empty !== "zero" ? [r.empty] : []))]);

const YEAR_SEC = 365.25 * 24 * 3600;

/** Why one number looks odd for its format, or null. */
export function oddValue(v: unknown, format: ValueFormat | undefined, type?: string): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (format === "bytes" && v > 0 && v < 1024) return `Looks odd: ${v} bytes is under 1 KB`;
  if (format === "percent" && (v > 100.5 || v < -0.5)) return `Looks odd: ${Math.round(v * 10) / 10} % is over 100 %`;
  if (format === "seconds" && v > 40 * YEAR_SEC) return "Looks odd: the time counts from 1970 (the value is missing on the server)";
  if (type === "time" && v > 0 && new Date(v).getUTCFullYear() === 1970) return "Looks odd: a date in 1970"; // time columns are epoch ms
  return null;
}

function oddIn(data: ShapedData): string | null {
  if (data.kind === "stat") return oddValue(data.value, data.format);
  if (data.kind === "series") {
    for (const s of data.series) for (const [, v] of s.points.slice(-20)) { const o = oddValue(v, data.format); if (o) return o; }
    return null;
  }
  if (data.kind === "table") {
    for (const row of data.rows.slice(0, 20)) for (const c of data.columns) { const o = oddValue(row[c.key], c.format, c.type); if (o) return `${o} (${c.label})`; }
  }
  return null;
}

function emptyIn(data: ShapedData): string | null {
  if (data.kind === "table" && data.rows.length === 0) return "Answered with no rows on this server";
  if (data.kind === "status" && data.items.length === 0) return "Answered with nothing to list on this server";
  if (data.kind === "series" && (data.series.length === 0 || data.series.every((s) => s.points.every(([, v]) => v === null)))) return "Answered with no data over time on this server";
  if (data.kind === "stat" && (data.value === "" || data.value === null)) return "Answered with no value on this server";
  return null;
}

export function classify(r: ReadResult, at: string): ReadCheck {
  if (!r.ok) {
    if (EMPTY_MESSAGES.has(r.error.message)) return { status: "empty", reason: r.error.message, at };
    return { status: "failed", reason: r.error.message.slice(0, 300), at };
  }
  const empty = emptyIn(r.data);
  if (empty) return { status: "empty", reason: empty, at };
  const odd = oddIn(r.data);
  if (odd) return { status: "odd", reason: odd, at };
  return { status: "ok", at };
}
