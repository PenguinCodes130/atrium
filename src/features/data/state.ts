import type { DataState } from "@/core/contracts";
import type { CacheEntry, WidgetData } from "./types";

/** fresh, stale (older than 2x refresh), failed (last attempt failed) or empty (never succeeded). */
export function dataState(entry: Pick<CacheEntry, "lastGood" | "lastAttempt"> | undefined, refreshSec: number, nowMs: number): DataState {
  if (!entry?.lastGood) return "empty";
  const attempt = entry.lastAttempt;
  if (attempt && !attempt.ok && Date.parse(attempt.fetchedAt) >= Date.parse(entry.lastGood.fetchedAt)) return "failed";
  if (nowMs - Date.parse(entry.lastGood.fetchedAt) > 2 * refreshSec * 1000) return "stale";
  return "fresh";
}

export function widgetData(entry: CacheEntry | undefined, refreshSec: number, nowMs: number): WidgetData {
  const state = dataState(entry, refreshSec, nowMs);
  const out: WidgetData = { state, refreshSec };
  if (entry?.lastGood) {
    out.data = entry.lastGood.data;
    out.fetchedAt = entry.lastGood.fetchedAt;
    out.sourceTimestamp = entry.lastGood.sourceTimestamp;
  }
  const a = entry?.lastAttempt;
  if (a && !a.ok && (state === "failed" || state === "empty")) out.error = { code: a.error.code, message: a.error.message, ...(a.error.hint ? { hint: a.error.hint } : {}) };
  return out;
}
