// Value formats (architecture Amendment 8, A8.4): how a number is shown by default when its data says
// what it is. Percent with one decimal, bytes as KB to TB, bytes per second as KB/s to GB/s, seconds as
// "3 d 4 h", degrees Celsius. The author's own unit always wins (the caller checks that). Pure.
import type { ShapedData, ValueFormat } from "@/core/contracts";
import { parseTemplate, rootsOf } from "../bindings/parse";

export const VALUE_FORMATS: readonly ValueFormat[] = ["percent", "bytes", "bytesPerSec", "seconds", "celsius", "number"];
export const isValueFormat = (v: unknown): v is ValueFormat => typeof v === "string" && (VALUE_FORMATS as readonly string[]).includes(v);

const BYTES = ["B", "KB", "MB", "GB", "TB", "PB"];

function trim(n: number, d: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
}

/** "3 d 4 h", "4 h 12 min", "12 min", "42 s": the two largest parts. */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  if (m) return `${m} min`;
  return `${s} s`;
}

/**
 * The number and its unit, formatted: { text: "12.4", unit: "GB" }. `decimals` (the author's) replaces the
 * default number of decimals where the format has one.
 */
export function formatParts(v: number, format: ValueFormat, decimals?: number): { text: string; unit: string } {
  if (!Number.isFinite(v)) return { text: "", unit: "" };
  switch (format) {
    case "percent": return { text: trim(v, decimals ?? 1), unit: "%" };
    case "celsius": return { text: trim(v, decimals ?? 1), unit: "°C" };
    case "seconds": return { text: durationText(v), unit: "" };
    case "bytes":
    case "bytesPerSec": {
      let x = v;
      let i = 0;
      while (Math.abs(x) >= 1000 && i < BYTES.length - 1) { x /= 1024; i++; }
      const unit = `${BYTES[i]}${format === "bytesPerSec" ? "/s" : ""}`;
      return { text: trim(x, decimals ?? (i === 0 ? 0 : 1)), unit };
    }
    default: return { text: trim(v, decimals ?? (Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 1)), unit: "" };
  }
}

/** One string: "12.4 GB", "7.8 %", "3 d 4 h". */
export function formatValue(v: number, format: ValueFormat, decimals?: number): string {
  const p = formatParts(v, format, decimals);
  return p.unit ? `${p.text} ${p.unit}` : p.text;
}

/** The scope key a Repeat sets for its child (A8.4): the format of each column of the rows it repeats over. */
export const ITEM_FORMATS = "$itemFormats";

type Scope = { $data?: Record<string, ShapedData | undefined>; [k: string]: unknown };

/** The format of each column of a table source, by column key. */
export function columnFormats(data: ShapedData | undefined): Record<string, ValueFormat> {
  if (!data || data.kind !== "table") return {};
  return Object.fromEntries(data.columns.flatMap((c) => (c.format ? [[c.key, c.format]] : [])));
}

/**
 * The format of the value a template reads, when its data says (A8.4): a stat source's value, a series'
 * latest point, a table column picked by find, rows[i], or a sum/avg/min/max over a column, or a column of
 * "this row" inside a Repeat. Null for anything else (counts, text, hand-written expressions).
 */
export function templateFormat(template: string, scope: Scope): ValueFormat | null {
  const t = template.trim();
  if (!/^\{\{[\s\S]*\}\}$/.test(t) || /\{\{[\s\S]*\}\}[\s\S]*\{\{/.test(t)) return null;
  try { parseTemplate(t); } catch { return null; }
  if (/\|\s*count\b/.test(t)) return null;
  const roots = rootsOf(t);
  if (roots.length !== 1) return null;
  const root = roots[0]!;
  if (root === "$item") {
    const formats = (scope[ITEM_FORMATS] ?? {}) as Record<string, ValueFormat>;
    const m = /^\{\{\s*\$item\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\}\}$/.exec(t);
    return m ? formats[m[1]!] ?? null : null;
  }
  if (root.startsWith("$")) return null;
  const data = scope.$data?.[root];
  if (!data) return null;
  if (data.kind === "stat") return /^\{\{\s*[a-z][a-z0-9_]*(\.value)?\s*\}\}$/.test(t) ? data.format ?? null : null;
  if (data.kind === "series") return /\.points\b/.test(t) ? data.format ?? null : null;
  if (data.kind === "table") {
    const cols = columnFormats(data);
    const mapped = /\bmap\(\s*"([^"]+)"\s*\)\s*\|\s*(sum|avg|min|max)\b/.exec(t);
    if (mapped) return cols[mapped[1]!] ?? null;
    if (/\bmap\(/.test(t)) return null;
    const last = /\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\}\}$/.exec(t);
    if (last && (/\.find\(/.test(t) || /\.rows\[\d+\]/.test(t))) return cols[last[1]!] ?? null;
  }
  return null;
}
