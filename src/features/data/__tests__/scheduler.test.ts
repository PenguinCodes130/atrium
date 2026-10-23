import { describe, expect, it } from "vitest";
import type { ReadResult } from "@/core/contracts";
import { MemoryBacking, ReadCache } from "../cache";
import { cacheKey, type SourceRef } from "../keys";
import { LINGER_MS, MAX_BACKOFF_MS, Scheduler } from "../scheduler";

const ok = (at: number): ReadResult => ({ ok: true, data: { kind: "stat", value: 1, label: "x" }, sourceTimestamp: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString() });
const bad = (at: number): ReadResult => ({ ok: false, error: { code: "unreachable", message: "down" }, fetchedAt: new Date(at).toISOString() });
const flush = () => new Promise((r) => setImmediate(r));

function harness(opts: { min?: number; fail?: boolean; hold?: boolean } = {}) {
  let now = 1_000_000;
  const calls: { s: SourceRef; at: number }[] = [];
  const pending: (() => void)[] = [];
  const cache = new ReadCache(new MemoryBacking());
  const sched = new Scheduler({
    cache,
    now: () => now,
    random: () => 0,
    minRefreshSec: () => opts.min ?? 10,
    fetcher: (s) => {
      calls.push({ s, at: now });
      if (opts.hold) return new Promise((r) => pending.push(() => r(opts.fail ? bad(now) : ok(now))));
      return Promise.resolve(opts.fail ? bad(now) : ok(now));
    },
  });
  const advance = async (ms: number, step = 1000) => {
    for (let t = 0; t < ms; t += step) { now += step; sched.tick(); await flush(); }
  };
  return { sched, cache, calls, pending, advance, get now() { return now; } };
}

describe("refresh interval", () => {
  it("uses the smallest subscriber refresh, floored by the endpoint minimum and 5 s", () => {
    expect(Scheduler.interval([30, 15], 10)).toBe(15_000);
    expect(Scheduler.interval([3], 0)).toBe(5_000);
    expect(Scheduler.interval([3], 1)).toBe(5_000);
    expect(Scheduler.interval([3], 10)).toBe(10_000);
  });

  it("fetches every 15 s with subscribers at 30 and 15 on a 10 s minimum", async () => {
    const h = harness({ min: 10 });
    const src = { integrationId: "i", endpointId: "e" };
    h.sched.subscribe(src, 30);
    h.sched.subscribe(src, 15);
    h.sched.tick(); await flush();
    await h.advance(60_000);
    const gaps = h.calls.slice(1).map((c, i) => c.at - h.calls[i]!.at);
    expect(gaps.every((g) => g === 15_000)).toBe(true);
    expect(h.calls.length).toBe(5);
  });

  it("a 3 s subscriber with no higher minimum gives every 5 s", async () => {
    const h = harness({ min: 0 });
    h.sched.subscribe({ integrationId: "i", endpointId: "e" }, 3);
    h.sched.tick(); await flush();
    await h.advance(30_000);
    const gaps = h.calls.slice(1).map((c, i) => c.at - h.calls[i]!.at);
    expect(new Set(gaps)).toEqual(new Set([5_000]));
  });
});

describe("dedupe", () => {
  it("two widgets reading the same endpoint and params cause one fetch per interval", async () => {
    const h = harness({ min: 10 });
    const a = { integrationId: "i", endpointId: "e", params: { q: "up", n: 1 } };
    const b = { integrationId: "i", endpointId: "e", params: { n: 1, q: "up" } };
    const seenA: number[] = [];
    const seenB: number[] = [];
    h.sched.subscribe(a, 10, () => seenA.push(h.now));
    h.sched.subscribe(b, 10, () => seenB.push(h.now));
    expect(cacheKey(a)).toBe(cacheKey(b));
    h.sched.tick(); await flush();
    await h.advance(50_000);
    expect(h.calls.length).toBe(6); // t=0,10,20,30,40,50
    expect(seenA).toEqual(seenB);
  });
});

describe("concurrency", () => {
  it("with 40 keys due runs at most 4 per integration and 16 in total", async () => {
    const h = harness({ hold: true });
    for (let i = 0; i < 40; i++) h.sched.subscribe({ integrationId: `int${i % 8}`, endpointId: `e${i}` }, 10);
    h.sched.tick(); await flush();
    expect(h.calls.length).toBe(16);
    const per = new Map<string, number>();
    for (const c of h.calls) per.set(c.s.integrationId, (per.get(c.s.integrationId) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(4);
    // Finish some; the next tick fills the free slots without going over.
    for (const p of h.pending.splice(0, 6)) p();
    await flush();
    h.sched.tick(); await flush();
    expect(h.sched.peakTotal).toBe(16);
    expect(Math.max(...h.sched.peakPerIntegration.values())).toBeLessThanOrEqual(4);
  });

  it("one integration with 40 due keys runs 4 at once", async () => {
    const h = harness({ hold: true });
    for (let i = 0; i < 40; i++) h.sched.subscribe({ integrationId: "one", endpointId: `e${i}` }, 10);
    h.sched.tick(); await flush();
    h.sched.tick(); await flush();
    expect(h.calls.length).toBe(4);
  });
});

describe("backoff", () => {
  it("doubles the gap after each failure and never exceeds 10 minutes", async () => {
    const h = harness({ fail: true, min: 10 });
    h.sched.subscribe({ integrationId: "i", endpointId: "e" }, 10);
    h.sched.tick(); await flush();
    await h.advance(60 * 60_000, 1000);
    const gaps = h.calls.slice(1).map((c, i) => c.at - h.calls[i]!.at);
    expect(gaps.slice(0, 5)).toEqual([20_000, 40_000, 80_000, 160_000, 320_000]);
    expect(gaps.every((g) => g <= MAX_BACKOFF_MS)).toBe(true);
    expect(gaps.at(-1)).toBe(MAX_BACKOFF_MS);
  });

  it("jitter only shortens the wait, by at most 10%", () => {
    expect(Scheduler.backoff(10_000, 1, 1)).toBe(18_000);
    expect(Scheduler.backoff(10_000, 30, 0)).toBe(MAX_BACKOFF_MS);
    expect(Scheduler.backoff(10_000, 1, 0, 90)).toBe(90_000);
  });
});

describe("linger", () => {
  it("keeps refreshing for 10 minutes after the last subscriber leaves, then stops", async () => {
    const h = harness({ min: 10 });
    const sub = h.sched.subscribe({ integrationId: "i", endpointId: "e" }, 60);
    h.sched.tick(); await flush();
    sub.unsubscribe();
    const leftAt = h.now;
    await h.advance(LINGER_MS + 120_000, 1000);
    const last = h.calls.at(-1)!.at;
    expect(last - leftAt).toBeLessThanOrEqual(LINGER_MS);
    expect(last - leftAt).toBeGreaterThanOrEqual(LINGER_MS - 60_000);
    expect(h.sched.isActive(sub.key)).toBe(false);
    const n = h.calls.length;
    await h.advance(300_000, 1000);
    expect(h.calls.length).toBe(n);
  });
});

describe("cache", () => {
  it("keeps the last good value when an attempt fails", () => {
    const cache = new ReadCache(new MemoryBacking());
    const s = { integrationId: "i", endpointId: "e" };
    cache.record(s, ok(1000));
    const e = cache.record(s, bad(2000));
    expect(e.lastGood?.fetchedAt).toBe(new Date(1000).toISOString());
    expect(e.lastAttempt?.ok).toBe(false);
  });

  it("holds at most 500 entries in memory", () => {
    const cache = new ReadCache(new MemoryBacking(), 500);
    for (let i = 0; i < 600; i++) cache.record({ integrationId: "i", endpointId: `e${i}` }, ok(i));
    expect(cache.size()).toBe(500);
    expect(cache.getFor({ integrationId: "i", endpointId: "e0" })).toBeDefined(); // reloaded from the table
  });
});
