// The refresh scheduler (architecture v2 section 10). Every second it starts the reads that are
// due. A key is active while a page stream subscribes to it, and for 10 minutes after the last
// subscriber leaves. One fetch per key per interval, however many widgets read it.
// A11.8 (Wave 2.10b F5 Off): a subscription with refreshSec 0 asks for one read when it starts (unless the
// cache already holds one younger than the read's minimum) and adds nothing to the interval, so a key that
// only Off subscriptions hold is read once per page open and never again.
import type { ReadResult } from "@/core/contracts";
import type { ReadCache } from "./cache";
import { cacheKey, type SourceRef } from "./keys";
import type { CacheEntry } from "./types";

export const ATRIUM_FLOOR_SEC = 5;
export const LINGER_MS = 10 * 60_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
export const MAX_PER_INTEGRATION = 4;
export const MAX_TOTAL = 16;

export type Fetcher = (source: SourceRef, signal: AbortSignal) => Promise<ReadResult>;
export type Listener = (entry: CacheEntry) => void;

type KeyState = {
  key: string;
  source: SourceRef;
  minRefreshSec: number;
  subs: Map<number, number>; // subscription id -> refreshSec
  listeners: Map<number, Listener>;
  lastIntervalMs: number;
  leftAt: number | null;
  nextDueAt: number;
  inFlight: boolean;
  /** Set when a refresh was asked for while a fetch was in flight: run again as soon as it ends. */
  again: boolean;
  failures: number;
  lastStartedAt: number | null;
  /** A11.8: the latest subscription was Off. When the key empties then, it lingers without reading. */
  lastSubOff: boolean;
};

export type SchedulerOptions = {
  fetcher: Fetcher;
  cache: ReadCache;
  /** The endpoint's minRefreshSec (manifest, or 10 for custom and declarative endpoints). */
  minRefreshSec: (s: SourceRef) => number;
  now?: () => number;
  random?: () => number;
  maxPerIntegration?: number;
  maxTotal?: number;
  lingerMs?: number;
};

export class Scheduler {
  private keys = new Map<string, KeyState>();
  private nextSub = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private now: () => number;
  private random: () => number;
  private perIntegration = new Map<string, number>();
  private total = 0;
  /** Every fetch start, for tests and diagnostics: [key, at]. Capped. */
  readonly starts: { key: string; integrationId: string; at: number }[] = [];
  peakTotal = 0;
  peakPerIntegration = new Map<string, number>();

  constructor(private opts: SchedulerOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  /**
   * Interval for a key: the smallest non-zero subscriber refresh, floored by the endpoint minimum and 5 s.
   * Off subscriptions (0, A11.8) do not count; with none left the key is not read again (Infinity).
   */
  static interval(subscriberSecs: number[], minRefreshSec: number): number {
    const live = subscriberSecs.filter((s) => s > 0);
    const smallest = live.length ? Math.min(...live) : Infinity;
    return Math.max(smallest, minRefreshSec, ATRIUM_FLOOR_SEC) * 1000;
  }

  /** The shortest gap between two reads of a key: the endpoint minimum, never below the 5 s floor. */
  static floorMs(minRefreshSec: number): number {
    return Math.max(minRefreshSec, ATRIUM_FLOOR_SEC) * 1000;
  }

  /** Wait after `failures` consecutive failures: doubling, jittered down by at most 10%, capped at 10 minutes. */
  static backoff(intervalMs: number, failures: number, rand: number, retryAfterSec?: number): number {
    const raw = Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
    const jittered = raw * (1 - 0.1 * rand);
    return Math.min(Math.max(jittered, (retryAfterSec ?? 0) * 1000), MAX_BACKOFF_MS);
  }

  intervalMs(key: string): number | undefined {
    const k = this.keys.get(key);
    if (!k) return undefined;
    return k.subs.size ? Scheduler.interval([...k.subs.values()], k.minRefreshSec) : k.lastIntervalMs;
  }

  isActive(key: string): boolean {
    return this.keys.has(key);
  }

  /**
   * Subscribes to a key at `refreshSec` (0 is Off, A11.8). For an Off subscription `pending` says whether a
   * read was asked for (false when the cache already holds a value younger than the read's minimum): the
   * page stream then knows whether one more value is on its way.
   */
  subscribe(source: SourceRef, refreshSec: number, listener?: Listener): { key: string; unsubscribe: () => void; pending: boolean } {
    const key = cacheKey(source);
    let k = this.keys.get(key);
    const now = this.now();
    const entry = this.opts.cache.get(key);
    const lastOk = entry?.lastAttempt?.ok ? Date.parse(entry.lastAttempt.fetchedAt) : NaN;
    if (!k) {
      const minRefreshSec = this.opts.minRefreshSec(source);
      const interval = Scheduler.interval([refreshSec], minRefreshSec);
      k = {
        key, source, minRefreshSec, subs: new Map(), listeners: new Map(), lastIntervalMs: interval, leftAt: null,
        nextDueAt: Number.isFinite(interval) ? (Number.isFinite(lastOk) ? Math.min(lastOk + interval, now + interval) : now) : Infinity,
        inFlight: false, again: false, failures: 0, lastStartedAt: null, lastSubOff: false,
      };
      this.keys.set(key, k);
    }
    const id = this.nextSub++;
    k.subs.set(id, refreshSec);
    if (listener) k.listeners.set(id, listener);
    k.leftAt = null;
    k.lastSubOff = !(refreshSec > 0);
    const interval = Scheduler.interval([...k.subs.values()], k.minRefreshSec);
    k.lastIntervalMs = interval;
    let pending = false;
    if (refreshSec > 0) {
      // A faster subscriber pulls the next fetch forward; one joining a key nothing reads on a timer starts it.
      if (!k.inFlight && k.failures === 0) {
        if (k.lastStartedAt !== null) k.nextDueAt = Math.min(k.nextDueAt, k.lastStartedAt + interval);
        if (!Number.isFinite(k.nextDueAt)) k.nextDueAt = Number.isFinite(lastOk) ? Math.min(lastOk + interval, now + interval) : now;
      }
    } else if (k.inFlight) {
      pending = true;
    } else {
      // Off: one read on page open, unless the cache already holds one younger than the read's minimum.
      const floor = Scheduler.floorMs(k.minRefreshSec);
      const lastAt = Math.max(Number.isFinite(lastOk) ? lastOk : -Infinity, k.lastStartedAt ?? -Infinity);
      if (!(Number.isFinite(lastOk) && now - lastOk < floor)) {
        pending = true;
        k.nextDueAt = Math.min(k.nextDueAt, Math.max(now, Number.isFinite(lastAt) ? lastAt + floor : now));
      } else if (!Number.isFinite(interval)) {
        // Only Off subscriptions, and the cache's value serves this page open: nothing is due.
        k.nextDueAt = Infinity;
      }
    }
    let done = false;
    return {
      key,
      pending,
      unsubscribe: () => {
        if (done) return;
        done = true;
        const s = this.keys.get(key);
        if (!s) return;
        s.subs.delete(id);
        s.listeners.delete(id);
        if (s.subs.size) s.lastIntervalMs = Scheduler.interval([...s.subs.values()], s.minRefreshSec);
        if (s.subs.size === 0) {
          s.leftAt = this.now();
          // A11.8: the last page to open this key read it Off: it lingers (cached) but is not read again.
          if (s.lastSubOff) {
            s.lastIntervalMs = Infinity;
            if (!s.inFlight) s.nextDueAt = Infinity;
          }
        }
      },
    };
  }

  /** Starts every due fetch within the concurrency limits. Called every second. */
  tick(): void {
    const now = this.now();
    const maxPer = this.opts.maxPerIntegration ?? MAX_PER_INTEGRATION;
    const maxTotal = this.opts.maxTotal ?? MAX_TOTAL;
    const linger = this.opts.lingerMs ?? LINGER_MS;
    const due: KeyState[] = [];
    for (const k of this.keys.values()) {
      if (k.subs.size === 0 && k.leftAt !== null && now - k.leftAt >= linger) {
        if (!k.inFlight) this.keys.delete(k.key);
        continue;
      }
      if (!k.inFlight && now >= k.nextDueAt) due.push(k);
    }
    due.sort((a, b) => a.nextDueAt - b.nextDueAt);
    for (const k of due) {
      if (this.total >= maxTotal) break;
      const id = k.source.integrationId;
      if ((this.perIntegration.get(id) ?? 0) >= maxPer) continue;
      void this.run(k);
    }
  }

  private async run(k: KeyState): Promise<void> {
    const id = k.source.integrationId;
    k.inFlight = true;
    k.lastStartedAt = this.now();
    this.total++;
    this.perIntegration.set(id, (this.perIntegration.get(id) ?? 0) + 1);
    this.peakTotal = Math.max(this.peakTotal, this.total);
    this.peakPerIntegration.set(id, Math.max(this.peakPerIntegration.get(id) ?? 0, this.perIntegration.get(id)!));
    this.starts.push({ key: k.key, integrationId: id, at: k.lastStartedAt });
    if (this.starts.length > 5000) this.starts.splice(0, 1000);
    let result: ReadResult;
    try {
      result = await this.opts.fetcher(k.source, AbortSignal.timeout(30_000));
    } catch {
      result = { ok: false, error: { code: "unreachable", message: "The read failed unexpectedly." }, fetchedAt: new Date(this.now()).toISOString() };
    }
    this.total--;
    this.perIntegration.set(id, (this.perIntegration.get(id) ?? 1) - 1);
    k.inFlight = false;
    const entry = this.opts.cache.record(k.source, result);
    const interval = this.intervalMs(k.key) ?? k.lastIntervalMs;
    if (k.again) {
      // A command changed the remote system while this fetch was running: its answer may be old.
      k.again = false;
      k.failures = 0;
      k.nextDueAt = this.now();
    } else if (result.ok) {
      k.failures = 0;
      k.nextDueAt = k.lastStartedAt + interval;
    } else if (!Number.isFinite(interval)) {
      // Only Off subscriptions (A11.8): a failed page-open read is shown as failed, not retried.
      k.failures++;
      k.nextDueAt = Infinity;
    } else {
      k.failures++;
      k.nextDueAt = this.now() + Scheduler.backoff(interval, k.failures, this.random(), result.error.retryAfterSec);
    }
    for (const l of k.listeners.values()) {
      try { l(entry); } catch { /* a broken listener never stops the scheduler */ }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * v3 (section 10): after a control runs a command, refresh every active key of that integration
   * at once, outside its interval (lingering keys included), and start the fetches now.
   * Returns how many keys were refreshed.
   */
  refreshNow(integrationId: string): number {
    let n = 0;
    for (const k of this.keys.values()) {
      if (k.source.integrationId !== integrationId) continue;
      // A11.8: a key only Off widgets read is never read again until a page opens.
      if (!Number.isFinite(this.intervalMs(k.key) ?? Infinity)) continue;
      n++;
      k.failures = 0;
      if (k.inFlight) k.again = true;
      else k.nextDueAt = this.now();
    }
    if (n) this.tick();
    return n;
  }

  /** Forget every key of an integration (after it is deleted or its config changes). */
  dropIntegration(integrationId: string): void {
    for (const [key, k] of this.keys) if (k.source.integrationId === integrationId) { k.failures = 0; k.nextDueAt = this.now(); if (k.subs.size === 0) this.keys.delete(key); }
  }

  debugKey(key: string) {
    const k = this.keys.get(key);
    return k ? { nextDueAt: k.nextDueAt, failures: k.failures, subscribers: k.subs.size, inFlight: k.inFlight } : undefined;
  }
}
