// Pure helpers for the Wave 2.9 components (A10.7): the service tile's status badge and stats, the
// bookmark's letters and domain, the resource bar's search address, and icon references. Isomorphic.
import type { ShapedData, ValueFormat } from "@/core/contracts";
import { text as textOf } from "../bindings";
import { formatParts, isValueFormat } from "./format";
import { formatNumber } from "./states";
import { ICON_PATHS } from "./icons";

export type BadgeTone = "ok" | "warn" | "bad" | "unknown";
export type Badge = { word: string; tone: BadgeTone; state: "up" | "down" | "warn" | "unknown" | "unchecked"; detail?: string; /** Read aloud: "Up, 12 ms". */ spoken: string };

/**
 * Round 2 item 7: the reason a reachability check gives when Atrium refuses to check an address (its own
 * server, loopback, link-local; integrations/host/reach.ts REACH_REFUSED, matched by its opening words
 * because that module is server only). Such an item was never checked, so it is not an outage.
 */
export const NOT_CHECKED_DETAIL = /^\s*Atrium does not check addresses\b/i;
/** True when a status detail says the address was not checked (not that it failed). */
export function isNotChecked(detail: unknown): boolean {
  return typeof detail === "string" && NOT_CHECKED_DETAIL.test(detail);
}

const WORDS: Record<string, { word: string; tone: BadgeTone }> = {
  running: { word: "Running", tone: "ok" },
  healthy: { word: "Healthy", tone: "ok" },
  up: { word: "Up", tone: "ok" },
  online: { word: "Online", tone: "ok" },
  ok: { word: "Healthy", tone: "ok" },
  stopped: { word: "Stopped", tone: "bad" },
  exited: { word: "Stopped", tone: "bad" },
  down: { word: "Down", tone: "bad" },
  offline: { word: "Down", tone: "bad" },
  unhealthy: { word: "Unhealthy", tone: "bad" },
  error: { word: "Down", tone: "bad" },
  paused: { word: "Paused", tone: "warn" },
  degraded: { word: "Degraded", tone: "warn" },
  starting: { word: "Starting", tone: "warn" },
  restarting: { word: "Restarting", tone: "warn" },
  warn: { word: "Warning", tone: "warn" },
  warning: { word: "Warning", tone: "warn" },
};
const STATE_WORD: Record<Badge["state"], { word: string; tone: BadgeTone }> = { up: { word: "Up", tone: "ok" }, down: { word: "Down", tone: "bad" }, warn: { word: "Warning", tone: "warn" }, unknown: { word: "Unknown", tone: "unknown" }, unchecked: { word: "Not checked", tone: "unknown" } };
const MS = /^\s*(\d+(?:\.\d+)?)\s*ms\s*$/i;

/**
 * The badge a service tile draws from its bound status (A10.7): the first item's state and detail.
 * A response time ("12 ms") on an up item is shown as the badge itself; a known word (running, healthy,
 * stopped) names it; otherwise the state's own word. A down item always reads Down (or Stopped).
 * Also takes a plain word ("running") or a stat. Null when there is nothing to show.
 */
export function statusBadge(data: unknown): Badge | null {
  if (data === undefined || data === null || data === "") return null;
  let state: Badge["state"] = "unknown";
  let detail = "";
  let word = "";
  if (typeof data === "string") word = data;
  else if (typeof data === "boolean") state = data ? "up" : "down";
  else if (typeof data === "object" && (data as { kind?: unknown }).kind === "status") {
    const first = (data as Extract<ShapedData, { kind: "status" }>).items[0];
    if (!first) return null;
    state = first.state === "up" || first.state === "down" || first.state === "warn" ? first.state : "unknown";
    detail = textOf(first.detail ?? "").trim();
  } else if (typeof data === "object" && (data as { kind?: unknown }).kind === "stat") {
    word = textOf((data as { value?: unknown }).value);
  } else return null;
  if (isNotChecked(detail)) return { word: "Not checked", tone: "unknown", state: "unchecked", detail, spoken: `Not checked, ${detail}` };
  const known = WORDS[(word || detail).trim().toLowerCase()];
  if (word && !known) {
    // A free word: up when it reads like one, else as it is.
    return { word: word.slice(0, 24), tone: "unknown", state, spoken: word };
  }
  if (known && state === "unknown") state = known.tone === "ok" ? "up" : known.tone === "bad" ? "down" : known.tone === "warn" ? "warn" : "unknown";
  const ms = MS.exec(detail);
  if (state === "up" && ms) return { word: `${formatNumber(Number(ms[1]), 0)} ms`, tone: "ok", state, detail, spoken: `Up, ${ms[1]} ms` };
  if (state === "down") {
    const w = known && known.tone === "bad" ? known.word : "Down";
    return { word: w, tone: "bad", state, ...(detail ? { detail } : {}), spoken: detail ? `${w}, ${detail}` : w };
  }
  const pick = known && known.tone === STATE_WORD[state].tone ? known : STATE_WORD[state];
  return { word: pick.word, tone: pick.tone, state, ...(detail && !known ? { detail } : {}), spoken: detail && !known ? `${pick.word}, ${detail}` : pick.word };
}

/** A stat's (or bar item's) value as text and unit: a literal, a number with its format, or a bound stat source. */
export function statText(v: unknown, format?: ValueFormat | null): { text: string; unit: string; number: number | null } {
  let value: unknown = v;
  let fmt: ValueFormat | null | undefined = format;
  let unit = "";
  if (v && typeof v === "object" && !Array.isArray(v) && (v as { kind?: unknown }).kind === "stat") {
    const s = v as Extract<ShapedData, { kind: "stat" }>;
    value = s.value;
    fmt = format ?? s.format ?? null;
    unit = s.unit ?? "";
  } else if (v && typeof v === "object" && !Array.isArray(v) && (v as { kind?: unknown }).kind === "status") {
    const b = statusBadge(v);
    return { text: b?.word ?? "", unit: "", number: null };
  } else if (Array.isArray(v)) {
    return { text: formatNumber(v.length), unit: "", number: v.length };
  }
  const n = typeof value === "number" && Number.isFinite(value) ? value : null;
  if (n === null) return { text: value === undefined || value === null ? "" : textOf(value), unit, number: null };
  if (fmt && fmt !== "number" && isValueFormat(fmt)) {
    const p = formatParts(n, fmt);
    return { text: p.text, unit: unit && fmt !== "percent" ? unit : p.unit, number: n };
  }
  return { text: formatNumber(n), unit, number: n };
}

/** A 0 to 100 bar fraction from a resolved percent (a number or a stat source), or null. */
export function percentOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : v && typeof v === "object" && (v as { kind?: unknown }).kind === "stat" ? (v as { value?: unknown }).value : typeof v === "string" && v.trim() !== "" ? Number(v) : null;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

/** Two letters for a bookmark without an icon: the first letters of the first two words, or the first two. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return words[0]!.slice(0, 2).toUpperCase();
}

export const SAFE_HREF = /^https?:\/\/[^\s]+$/i;

/** The domain a bookmark shows: the host without "www.", or "" for an address that is not http or https. */
export function domainOf(href: string): string {
  if (!SAFE_HREF.test(href.trim())) return "";
  try {
    return new URL(href.trim()).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** The search address for typed words: https only, {q} replaced by the encoded words; null when refused. */
export function searchHref(template: string, q: string): string | null {
  const t = template.trim();
  if (!/^https:\/\/[^\s]*\{q\}[^\s]*$/i.test(t) || !q.trim()) return null;
  const out = t.split("{q}").join(encodeURIComponent(q.trim()));
  try {
    return new URL(out).protocol === "https:" ? out : null;
  } catch {
    return null;
  }
}

export type IconRefKind = { kind: "builtin"; name: string } | { kind: "upload"; path: string } | { kind: "unknown"; ref: string };

/** What an icon reference names (A10.7): a built-in icon (pkg:<id> names a package's own glyph), an upload, or nothing known. */
export function iconRefKind(ref: string): IconRefKind {
  const r = ref.trim();
  if (/^\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(r) && !r.includes("..")) return { kind: "upload", path: r };
  const name = r.startsWith("pkg:") ? r.slice(4).split("/")[0]! : r;
  if (Object.prototype.hasOwnProperty.call(ICON_PATHS, name)) return { kind: "builtin", name };
  return { kind: "unknown", ref: r };
}
