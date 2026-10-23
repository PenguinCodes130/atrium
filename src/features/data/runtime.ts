// The process-wide cache and scheduler (one Node process, architecture v2 section 1).
import "server-only";
import { dbCacheBacking } from "@/features/integrations/repo";
import { minRefreshFor, readEndpoint } from "@/features/integrations/runtime";
import { ReadCache } from "./cache";
import { cacheKey, type SourceRef } from "./keys";
import { Scheduler } from "./scheduler";
import { widgetData } from "./state";
import type { WidgetData } from "./types";

const g = globalThis as unknown as { __atriumData?: { cache: ReadCache; scheduler: Scheduler } };

export function dataRuntime(): { cache: ReadCache; scheduler: Scheduler } {
  if (!g.__atriumData) {
    const cache = new ReadCache(dbCacheBacking, 500);
    const scheduler = new Scheduler({
      cache,
      fetcher: (s, signal) => readEndpoint(s.integrationId, s.endpointId, s.params, signal),
      minRefreshSec: (s) => minRefreshFor(s.integrationId, s.endpointId),
    });
    scheduler.start();
    g.__atriumData = { cache, scheduler };
  }
  return g.__atriumData;
}

/** The cached value for one source, as a widget sees it. */
export function cachedWidgetData(s: SourceRef, refreshSec: number): WidgetData {
  return widgetData(dataRuntime().cache.get(cacheKey(s)), refreshSec, Date.now());
}

/**
 * Reads through the cache: returns the cached value when it is younger than the interval,
 * otherwise fetches once (concurrent callers share the same fetch) and records it.
 */
const inflight = new Map<string, Promise<unknown>>();
const gi = globalThis as unknown as { __atriumInvalidated?: Map<string, number> };
const invalidated = (gi.__atriumInvalidated ??= new Map());

export async function readThrough(s: SourceRef, refreshSec: number, opts: { cachedOnly?: boolean } = {}): Promise<WidgetData> {
  const { cache } = dataRuntime();
  const key = cacheKey(s);
  const entry = cache.get(key);
  const interval = Math.max(refreshSec, minRefreshFor(s.integrationId, s.endpointId), 5) * 1000;
  const last = entry?.lastAttempt ? Date.parse(entry.lastAttempt.fetchedAt) : 0;
  // A command run invalidates every cached value of its integration (section 3.1).
  const stale = last < (invalidated.get(s.integrationId) ?? 0);
  if (!opts.cachedOnly && (stale || Date.now() - last >= interval)) {
    let p = inflight.get(key);
    if (!p) {
      p = readEndpoint(s.integrationId, s.endpointId, s.params).then((r) => cache.record(s, r)).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    await p;
  }
  return widgetData(cache.get(key), refreshSec, Date.now());
}

/**
 * After a command run (architecture v3 sections 3.1 and 10): the integration's cached values count
 * as out of date, and its active keys are fetched again at once, so every open page (other viewers
 * and guests included) gets the new state. The last good values stay visible until then.
 */
export function refreshIntegrationNow(integrationId: string): number {
  invalidated.set(integrationId, Date.now());
  return dataRuntime().scheduler.refreshNow(integrationId);
}

export function forgetIntegration(integrationId: string): void {
  const rt = dataRuntime();
  rt.cache.removeIntegration(integrationId);
  rt.scheduler.dropIntegration(integrationId);
}
