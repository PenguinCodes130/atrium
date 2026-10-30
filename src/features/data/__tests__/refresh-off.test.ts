// Wave 2.10b F5 Off (architecture A11.8): a source whose every binding component is Off (refreshSec 0) is
// read once per page open and never again until the page is reloaded. The scheduler, the page stream, the
// widget state and the browser's polling fallback each have a read-once path; these tests pin them.
import { describe, expect, it } from "vitest";
import type { ReadResult } from "@/core/contracts";
import { MemoryBacking, ReadCache } from "../cache";
import { PageDataClient, type PageDataDeps } from "../client";
import { cacheKey, type SourceRef } from "../keys";
import { Scheduler } from "../scheduler";
import { dataState } from "../state";
import { createPageStream, type StreamSource } from "../stream";

const ok = (at: number, v = 1): ReadResult => ({ ok: true, data: { kind: "stat", value: v, label: "x" }, sourceTimestamp: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString() });
const bad = (at: number): ReadResult => ({ ok: false, error: { code: "unreachable", message: "down" }, fetchedAt: new Date(at).toISOString() });
const flush = () => new Promise((r) => setImmediate(r));
const SRC: SourceRef = { integrationId: "i", endpointId: "cpu" };

function harness(opts: { min?: number; fail?: boolean } = {}) {
  let now = 5_000_000;
  const calls: number[] = [];
  const cache = new ReadCache(new MemoryBacking());
  const sched = new Scheduler({ cache, now: () => now, random: () => 0, minRefreshSec: () => opts.min ?? 10, fetcher: async () => { calls.push(now); return opts.fail ? bad(now) : ok(now, calls.length); } });
  const advance = async (ms: number) => { for (let t = 0; t < ms; t += 1000) { now += 1000; sched.tick(); await flush(); } };
  return { sched, cache, calls, advance, get now() { return now; } };
}

describe("scheduler: read once per page open when every subscriber is Off", () => {
  it("one read when the page opens, none in the next ten minutes", async () => {
    const h = harness();
    const seen: number[] = [];
    const sub = h.sched.subscribe(SRC, 0, () => seen.push(h.now));
    expect(sub.pending).toBe(true);
    await h.advance(10 * 60_000);
    expect(h.calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(h.sched.intervalMs(cacheKey(SRC))).toBe(Infinity);
  });
  it("each page open reads once more, but never twice within the read's minimum", async () => {
    const h = harness({ min: 30 });
    const first = h.sched.subscribe(SRC, 0, () => first.unsubscribe());
    await h.advance(1000);
    expect(h.calls).toHaveLength(1);
    // A second page opens 10 s later: the cached value is younger than the 30 s minimum, so it is used.
    await h.advance(9000);
    const again = h.sched.subscribe(SRC, 0);
    expect(again.pending).toBe(false);
    await h.advance(5000);
    expect(h.calls).toHaveLength(1);
    again.unsubscribe();
    // A third page opens a minute later: one fresh read.
    await h.advance(60_000);
    expect(h.calls).toHaveLength(1);
    expect(h.sched.subscribe(SRC, 0).pending).toBe(true);
    await h.advance(2000);
    expect(h.calls).toHaveLength(2);
    await h.advance(5 * 60_000);
    expect(h.calls).toHaveLength(2);
  });
  it("fastest non-zero wins: an Off subscriber beside a 30 s one leaves the key at 30 s", async () => {
    const h = harness();
    h.sched.subscribe(SRC, 0);
    h.sched.subscribe(SRC, 30);
    expect(h.sched.intervalMs(cacheKey(SRC))).toBe(30_000);
    await h.advance(91_000);
    // At open, then every 30 s: 4 reads, not one.
    expect(h.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.calls.length).toBeLessThanOrEqual(4);
    expect(Scheduler.interval([0, 0], 10)).toBe(Infinity);
    expect(Scheduler.interval([0, 60, 30], 10)).toBe(30_000);
  });
  it("a timed subscriber joining a key only Off pages hold starts its timer", async () => {
    const h = harness();
    h.sched.subscribe(SRC, 0);
    await h.advance(1000);
    expect(h.calls).toHaveLength(1);
    h.sched.subscribe(SRC, 10);
    await h.advance(31_000);
    expect(h.calls.length).toBeGreaterThanOrEqual(3);
  });
  it("a key whose latest page read it Off stops reading when that page and an older timed one both leave", async () => {
    const h = harness({ min: 15 });
    const builder = h.sched.subscribe(SRC, 30);
    await h.advance(45_000);
    expect(h.calls).toHaveLength(2);
    // The same page switches to Off (its stream restarts): the new Off stream subscribes before the old one leaves.
    const off = h.sched.subscribe(SRC, 0, () => off.unsubscribe());
    if (!off.pending) off.unsubscribe();
    await h.advance(2000);
    builder.unsubscribe();
    const before = h.calls.length;
    await h.advance(5 * 60_000);
    expect(h.calls.length, "no lingering reads at the old pace").toBe(before);
    // The next page open reads once.
    const viewer = h.sched.subscribe(SRC, 0, () => viewer.unsubscribe());
    expect(viewer.pending).toBe(true);
    await h.advance(60_000);
    expect(h.calls.length).toBe(before + 1);
  });
  it("a failed page-open read is not retried, and a command run does not read Off keys again", async () => {
    const h = harness({ fail: true });
    h.sched.subscribe(SRC, 0);
    await h.advance(20 * 60_000);
    expect(h.calls).toHaveLength(1);
    const ok2 = harness();
    ok2.sched.subscribe(SRC, 0);
    await ok2.advance(1000);
    expect(ok2.sched.refreshNow("i")).toBe(0);
    await ok2.advance(5000);
    expect(ok2.calls).toHaveLength(1);
  });
});

describe("page stream: an Off source gets one value per page open", () => {
  async function events(stream: ReadableStream<Uint8Array>, until: (out: { event: string }[]) => boolean, maxMs = 2000) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const out: { event: string; data: unknown }[] = [];
    const t0 = Date.now();
    const pump = (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        buf += dec.decode(r.value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
        }
      }
    })();
    while (!until(out) && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 5));
    return { out, stop: async () => { await reader.cancel(); await pump.catch(() => {}); } };
  }

  it("snapshot, one fresh value, then nothing more even while another page refreshes the same read", async () => {
    let now = Date.now();
    const cache = new ReadCache(new MemoryBacking());
    let n = 0;
    const sched = new Scheduler({ cache, now: () => now, minRefreshSec: () => 10, fetcher: async () => ok(now, ++n) });
    const off: StreamSource = { key: "cpu", ...SRC, refreshSec: 0 };
    const stream = createPageStream([off], { scheduler: sched, cache, now: () => now });
    const run = events(stream, (out) => out.filter((e) => e.event === "update").length >= 1);
    sched.tick();
    const r = await run;
    expect(r.out[0]!.event).toBe("snapshot");
    expect(r.out.filter((e) => e.event === "update")).toHaveLength(1);
    // Another page reads the same key every 10 s: this stream hears none of it.
    sched.subscribe(SRC, 10);
    for (let i = 0; i < 4; i++) { now += 11_000; sched.tick(); await flush(); }
    await new Promise((r2) => setTimeout(r2, 20));
    expect(n).toBeGreaterThanOrEqual(3);
    expect(r.out.filter((e) => e.event === "update")).toHaveLength(1);
    expect((r.out[1]!.data as { refreshSec: number; state: string }).refreshSec).toBe(0);
    expect((r.out[1]!.data as { state: string }).state).toBe("fresh");
    await r.stop();
  });
  it("a cached value younger than the read's minimum is the page-open value: no read", async () => {
    const now = Date.now();
    const cache = new ReadCache(new MemoryBacking());
    cache.record(SRC, ok(now - 2000, 7));
    let n = 0;
    const sched = new Scheduler({ cache, now: () => now, minRefreshSec: () => 10, fetcher: async () => ok(now, ++n) });
    const stream = createPageStream([{ key: "cpu", ...SRC, refreshSec: 0 }], { scheduler: sched, cache, now: () => now });
    const r = await events(stream, () => false, 100);
    sched.tick();
    await flush();
    expect(n).toBe(0);
    expect(r.out.map((e) => e.event)).toEqual(["snapshot"]);
    await r.stop();
  });
});

describe("widget state and polling fallback", () => {
  it("an Off value never counts as stale", () => {
    const entry = { lastGood: { data: { kind: "stat" as const, value: 1, label: "x" }, fetchedAt: new Date(0).toISOString(), sourceTimestamp: null }, lastAttempt: { ok: true as const, fetchedAt: new Date(0).toISOString() } };
    expect(dataState(entry as never, 0, Date.now())).toBe("fresh");
    expect(dataState(entry as never, 30, Date.now())).toBe("stale");
  });
  it("while the stream is down, an Off source is asked once, never on a timer", async () => {
    const fetched: string[] = [];
    const intervals: number[] = [];
    let onError: ((e: unknown) => void) | null = null;
    const deps: PageDataDeps = {
      EventSource: class { onopen = null; set onerror(f: ((e: unknown) => void) | null) { onError = f; } get onerror() { return onError; } readyState = 0; addEventListener() {} close() {} } as never,
      fetch: async (url: string) => { fetched.push(url); return { ok: true, json: async () => ({ state: "fresh", refreshSec: 0 }) }; },
      setInterval: (_fn: () => void, ms: number) => { intervals.push(ms); return 1; },
      clearInterval: () => {},
      setTimeout: (fn: () => void) => { fn(); return 1; },
    };
    const client = new PageDataClient({ appId: "a", pageId: "p" }, [{ key: "off", refreshSec: 0 }, { key: "on", refreshSec: 30 }], () => {}, deps);
    client.start();
    onError!({});
    await flush();
    expect(intervals).toEqual([30_000]);
    expect(fetched.filter((u) => u.includes("a%3Aoff"))).toHaveLength(1);
    client.stop();
  });
});
