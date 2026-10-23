// Plain words from a spec: labels, group names, ids and value formats (research 2.2, rows
// "Friendly labels", "Groups" and "Units and formats"). Pure.
import type { ValueFormat } from "@/core/contracts";

/** "DiskSpace" -> "Disk space", "wanted_missing" -> "Wanted missing", "SystemInfo" -> "System info". */
export function words(s: string): string {
  const w = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.\-/]+/)
    .filter(Boolean)
    .map((x, i) => (i === 0 ? x : /^[A-Z0-9]+$/.test(x) && x.length > 1 ? x : x.toLowerCase()));
  const out = w.join(" ");
  return out ? out[0]!.toUpperCase() + out.slice(1) : "";
}

const VERB = /^(gets?|retrieves?|returns?|fetch(es)?|lists?|reads?|shows?|obtains?|queries|query)\s+(the\s+|a\s+|an\s+|all\s+)?(list\s+of\s+|lists\s+of\s+|collection\s+of\s+)?(all\s+)?/i;

/** The first sentence of a text, without a trailing period and markdown. */
export function firstSentence(text: string): string {
  const t = text.replace(/<[^>]+>/g, " ").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m ? m[1]! : t).replace(/[.!?]$/, "").trim();
}

function tidy(label: string): string {
  let s = label.replace(VERB, "").trim();
  s = s.replace(/\s+/g, " ").replace(/[.:;]$/, "");
  if (!s) return "";
  s = s[0]!.toUpperCase() + s.slice(1);
  return s.length > 80 ? `${s.slice(0, 77).trimEnd()}...` : s;
}

const SKIP_SEGMENT = /^(api|apis|rest|v\d+(\.\d+)?|\{[^}]*\})$/i;

/** Meaningful words of a path: "/api/v3/wanted/missing" -> ["wanted", "missing"]. */
export function pathWords(path: string): string[] {
  return path.split("/").filter((s) => s && !SKIP_SEGMENT.test(s)).map((s) => s.replace(/\.[a-z0-9]+$/i, ""));
}

/** Label rule: summary, else the first sentence of description, else operationId in words, else path words. */
export function labelFor(op: { summary?: unknown; description?: unknown; operationId?: unknown }, path: string, tag?: string): string {
  if (typeof op.summary === "string" && tidy(firstSentence(op.summary))) return tidy(firstSentence(op.summary));
  if (typeof op.description === "string" && tidy(firstSentence(op.description))) return tidy(firstSentence(op.description));
  if (typeof op.operationId === "string" && /[a-z]/i.test(op.operationId) && !/^(get|list)?[_-]?api/i.test(op.operationId)) {
    const t = tidy(words(op.operationId.replace(/^(get|list|fetch|read)(?=[A-Z_])/, "")));
    if (t) return t;
  }
  const w = pathWords(path);
  const detail = /\}\/?$/.test(path);
  const tagKey = (tag ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // "diskspace" under the tag "DiskSpace" reads as "disk space".
  const base = w.slice(-2).map((x) => (tagKey && x.toLowerCase() === tagKey ? words(tag!) : words(x)).toLowerCase()).join(" ") || (tag ? words(tag) : "") || "Root";
  const label = tidy(base) || "Root";
  return detail ? `${label} details` : label;
}

/** A tag in words: "DiskSpace" -> "Disk space". */
export function groupName(tag: string): string {
  return words(tag) || "Other";
}

/** An endpoint id from a path: letters, numbers and dashes, at most 50 long. */
export function idFrom(path: string): string {
  const parts = path.split("/").filter((s) => s && !/^(api|apis|rest|v\d+(\.\d+)?)$/i.test(s)).map((s) => (/^\{.+\}$/.test(s) ? `by-${s.slice(1, -1)}` : s));
  const id = parts.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
  return id || "root";
}

/** The same key the shaper gives a table column (shape.ts slug). */
export function columnKey(label: string, i: number): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `f${i}`;
}

/**
 * A8.4 format from a property name and schema. Bytes: size, bytes, *Bytes, sizeleft, *Space (not
 * pageSize). Percent: percent, percentage. Seconds: seconds, uptime, duration, *Ticks (divided by
 * 10,000,000 when shown). Celsius: temperature, celsius.
 */
export function formatFor(name: string, schema?: { type?: unknown; format?: unknown }): ValueFormat | undefined {
  const t = schema?.type;
  if (t !== undefined && t !== "integer" && t !== "number") return undefined;
  const n = name.toLowerCase();
  if (/page_?size|batch_?size|chunk_?size|size_?limit|max_?size$/.test(n)) return undefined;
  if (/(^|_)?(size|bytes|sizeleft|sizeondisk)$/.test(n) || /bytes/.test(n) || /(free|total|used|available)_?space$/.test(n) || /sizeondisk/.test(n)) return "bytes";
  if (/percent(age)?/.test(n)) return "percent";
  if (/ticks$/.test(n) || /(seconds|secs|uptime|duration)$/.test(n)) return "seconds";
  if (/temperature|celsius/.test(n)) return "celsius";
  return undefined;
}

/** A date-time or date property (shown as a time). */
export function isTimeProp(name: string, schema?: { type?: unknown; format?: unknown }): boolean {
  if (schema?.format === "date-time" || schema?.format === "date") return true;
  return schema?.type === "string" && /(^|_)(date|time|timestamp)$|At$|Date$|Time$/.test(name) && !/zone|format|span/i.test(name);
}

/** "fooBar" -> "Foo bar" for an enum value or a parameter title. */
export function titleOf(v: string): string {
  return words(String(v)) || String(v);
}
