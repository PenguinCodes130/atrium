// A8.1: which reads have data on each integration's service, cached 5 minutes per integration (and
// per saved change, so a new address is checked again). The bindable listing waits at most `waitMs`;
// a slow service answers "unknown" and the check keeps running for the next listing.
import "server-only";
import { readAvailability } from "./runtime";

export const AVAILABILITY_TTL_MS = 5 * 60_000;
type Entry = { at: number; version: string; value: Record<string, boolean> | null };

const g = globalThis as unknown as { __atriumAvailability?: Map<string, Entry>; __atriumAvailabilityInflight?: Map<string, Promise<Entry>> };
const cache = (g.__atriumAvailability ??= new Map());
const inflight = (g.__atriumAvailabilityInflight ??= new Map());

/** The cached answer, refreshed when older than 5 minutes. `version` is the row's updatedAt. */
export async function availabilityOf(integrationId: string, version: string, waitMs = 3000, now = Date.now()): Promise<{ known: boolean; value: Record<string, boolean> }> {
  const hit = cache.get(integrationId);
  if (hit && hit.version === version && now - hit.at < AVAILABILITY_TTL_MS) return { known: hit.value !== null, value: hit.value ?? {} };
  let p = inflight.get(integrationId);
  if (!p) {
    p = readAvailability(integrationId)
      .then((value) => {
        const e: Entry = { at: Date.now(), version, value };
        cache.set(integrationId, e);
        return e;
      })
      .finally(() => inflight.delete(integrationId));
    inflight.set(integrationId, p);
  }
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), waitMs).unref?.());
  const e = await Promise.race([p, timeout]);
  if (e) return { known: e.value !== null, value: e.value ?? {} };
  // Still running: the last answer for this integration (if any) is better than none.
  return hit?.value ? { known: true, value: hit.value } : { known: false, value: {} };
}

export function forgetAvailability(integrationId?: string): void {
  if (integrationId) cache.delete(integrationId);
  else cache.clear();
}
