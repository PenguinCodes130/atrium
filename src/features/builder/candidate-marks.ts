// Wave 2.10b F2 (operator try-out spec 4, criterion 10): what a data choice would really show, judged
// before it is used. Each candidate in "What should this show?" carries a marker in words (and a shape,
// drawn by the picker) when its live value is Empty, Zero, an Error (with the reason) or Stale (with its
// age). Pure, so the picker and its tests share one rule.
import type { CatalogueItem, ShapedData } from "@/core/contracts";

export type MarkerKind = "empty" | "zero" | "error" | "stale";
export type Marker = { kind: MarkerKind; words: string; reason?: string; ageSec?: number };

/** A peek answer as the picker keeps it. `fetchedAt` is read when the server sends one (see the build report). */
export type PeekValue = { data?: ShapedData; error?: string; fetchedAt?: string };

/** "45 s old", "10 min old", "3 h old", "2 days old". */
export function ageWords(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s} s old`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min old`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h old`;
  return `${Math.round(s / 86400)} days old`;
}

const isZero = (v: unknown) => v === 0 || (typeof v === "string" && v.trim() !== "" && Number(v) === 0);

/** The newest point of a series read and the gap between its last two points, in ms. */
function newest(d: Extract<ShapedData, { kind: "series" }>): { at: number; stepMs: number } | null {
  let at = -Infinity;
  let stepMs = 0;
  for (const s of d.series) {
    const pts = s.points.filter((p) => p[1] !== null);
    const last = pts[pts.length - 1];
    if (!last || last[0] <= at) continue;
    at = last[0];
    const prev = pts[pts.length - 2];
    stepMs = prev ? last[0] - prev[0] : 0;
  }
  return Number.isFinite(at) ? { at, stepMs } : null;
}

/**
 * The marker for one candidate, or null when its value is ordinary. `nowMs` is the browser's clock. A value
 * counts as stale when it is older than twice the read's own refresh (and two of its steps, for a series),
 * and at least 2 minutes old, so the normal gap between reads never marks it.
 */
export function candidateMarker(p: PeekValue | undefined, item: Pick<CatalogueItem, "defaultRefreshSec" | "check">, nowMs: number): Marker | null {
  if (!p) return null;
  const d = p.data;
  if (!d) {
    // The read's own live check said it answers with nothing (Prometheus "no value right now"): Empty, not Error.
    if (item.check?.status === "empty") return { kind: "empty", words: "Empty: no value right now" };
    const reason = (p.error ?? "").trim() || "No answer.";
    return { kind: "error", words: `Error: ${reason}`, reason };
  }
  const limitMs = (stepMs = 0) => Math.max(2 * Math.max(item.defaultRefreshSec, 10) * 1000, 2 * stepMs, 120_000);
  const stale = (atMs: number, stepMs = 0): Marker | null => {
    const age = nowMs - atMs;
    return Number.isFinite(age) && age > limitMs(stepMs) ? { kind: "stale", words: `Stale · ${ageWords(age / 1000)}`, ageSec: Math.round(age / 1000) } : null;
  };
  if (d.kind === "stat") {
    if (d.value === null || d.value === undefined || (typeof d.value === "string" && !d.value.trim())) return { kind: "empty", words: "Empty: no value" };
    const s = p.fetchedAt ? stale(Date.parse(p.fetchedAt)) : null;
    if (s) return s;
    return isZero(d.value) ? { kind: "zero", words: "Zero" } : null;
  }
  if (d.kind === "series") {
    const n = newest(d);
    if (!d.series.length || !n) return { kind: "empty", words: "Empty: no points" };
    const s = stale(n.at, n.stepMs) ?? (p.fetchedAt ? stale(Date.parse(p.fetchedAt)) : null);
    if (s) return s;
    const lasts = d.series.map((x) => x.points.filter((q) => q[1] !== null).at(-1)?.[1]).filter((v) => v !== undefined);
    return lasts.length && lasts.every(isZero) ? { kind: "zero", words: "Zero" } : null;
  }
  if (d.kind === "table") {
    if (!d.rows.length) return { kind: "empty", words: "Empty: no rows" };
  } else if (d.kind === "status") {
    if (!d.items.length) return { kind: "empty", words: "Empty: nothing listed" };
  }
  return p.fetchedAt ? stale(Date.parse(p.fetchedAt)) : null;
}
