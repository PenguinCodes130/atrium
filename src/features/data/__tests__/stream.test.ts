import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TRAFFIC = path.resolve(__dirname, "../../../../evidence/integrations/r6/traffic/data-stream.sse.txt");
mkdirSync(path.dirname(TRAFFIC), { recursive: true });
writeFileSync(TRAFFIC, "");
import type { ReadResult } from "@/core/contracts";
import { MemoryBacking, ReadCache } from "../cache";
import { PageDataClient, type PageDataDeps } from "../client";
import { Scheduler } from "../scheduler";
import { dataState } from "../state";
import { createPageStream, type StreamSource } from "../stream";
import type { WidgetData } from "../types";

const good = (v: number, at = Date.now()): ReadResult => ({ ok: true, data: { kind: "stat", value: v, label: "x" }, sourceTimestamp: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString() });

async function readEvents(stream: ReadableStream<Uint8Array>, count: number) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: { event: string; data: unknown }[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value);
    appendFileSync(TRAFFIC, chunk);
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
    }
  }
  reader.releaseLock();
  return { events, cancel: () => stream.cancel() };
}

describe("page data stream", () => {
  it("delivers every widget's cached value before any new remote fetch completes, then pushes updates", async () => {
    const cache = new ReadCache(new MemoryBacking());
    const srcA = { integrationId: "i1", endpointId: "a" };
    cache.record(srcA, good(41, Date.now() - 50_000));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetched: string[] = [];
    const scheduler = new Scheduler({ cache, minRefreshSec: () => 5, fetcher: async (s) => { await gate; fetched.push(s.endpointId); return good(42); } });
    const sources: StreamSource[] = [
      { key: "cpu", ...srcA, refreshSec: 10 },
      { key: "cpu_slow", ...srcA, refreshSec: 30 },
      { key: "never", integrationId: "i1", endpointId: "never", refreshSec: 10 },
    ];
    const stream = createPageStream(sources, { scheduler, cache });
    const first = await readEvents(stream, 1);
    expect(fetched).toEqual([]);
    expect(first.events[0]!.event).toBe("snapshot");
    const snap = first.events[0]!.data as { sources: Record<string, WidgetData> };
    // v3: keyed by data source name, not by widget id.
    expect(Object.keys(snap.sources).sort()).toEqual(["cpu", "cpu_slow", "never"]);
    expect(snap.sources.cpu).toMatchObject({ state: "stale", data: { value: 41 } });
    expect(snap.sources.cpu_slow).toMatchObject({ state: "fresh", data: { value: 41 } });
    expect(snap.sources.never).toMatchObject({ state: "empty" });
    scheduler.tick();
    release();
    const next = await readEvents(stream, 3);
    expect(next.events.map((e) => e.event)).toEqual(["update", "update", "update"]);
    expect(next.events.find((e) => (e.data as { key: string }).key === "cpu")!.data).toMatchObject({ state: "fresh", data: { value: 42 } });
    expect(fetched.filter((e) => e === "a")).toHaveLength(1); // cpu and cpu_slow share one fetch
    await next.cancel();
  });

  it("unsubscribes when the page closes, so the key starts its 10 minute linger", async () => {
    const cache = new ReadCache(new MemoryBacking());
    const scheduler = new Scheduler({ cache, minRefreshSec: () => 5, fetcher: async () => good(1) });
    const stream = createPageStream([{ key: "w", integrationId: "i", endpointId: "e", refreshSec: 10 }], { scheduler, cache });
    const r = await readEvents(stream, 1);
    await r.cancel();
    const key = [...(scheduler as unknown as { keys: Map<string, unknown> }).keys.keys()][0]!;
    expect(scheduler.debugKey(key)?.subscribers).toBe(0);
  });
});

describe("states", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  it("is stale only past 2x the refresh interval, failed when the last attempt failed, empty with no success", () => {
    const now = 1_000_000;
    const g = { ok: true as const, data: { kind: "stat" as const, value: 1, label: "" }, fetchedAt: at(now - 20_000), sourceTimestamp: at(now) };
    expect(dataState({ lastGood: g, lastAttempt: g }, 10, now)).toBe("fresh");
    expect(dataState({ lastGood: { ...g, fetchedAt: at(now - 20_001) }, lastAttempt: g }, 10, now)).toBe("stale");
    expect(dataState({ lastGood: g, lastAttempt: { ok: false, error: { code: "timeout", message: "m" }, fetchedAt: at(now) } }, 10, now)).toBe("failed");
    expect(dataState({ lastGood: null, lastAttempt: { ok: false, error: { code: "timeout", message: "m" }, fetchedAt: at(now) } }, 10, now)).toBe("empty");
    expect(dataState(undefined, 10, now)).toBe("empty");
  });
});

describe("browser client fallback", () => {
  class FakeES {
    static last: FakeES;
    onopen: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readyState = 0;
    listeners = new Map<string, (e: { data: string }) => void>();
    constructor(readonly url: string) { FakeES.last = this; }
    addEventListener(t: string, fn: (e: { data: string }) => void) { this.listeners.set(t, fn); }
    close() { this.readyState = 2; }
    emit(t: string, data: unknown) { this.listeners.get(t)?.({ data: JSON.stringify(data) }); }
  }

  it("polls each data source at its refresh interval while the stream is cut, and stops on reconnect", async () => {
    const intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const fetched: string[] = [];
    const deps: PageDataDeps = {
      EventSource: FakeES as never,
      fetch: async (url) => { fetched.push(url); return { ok: true, json: async () => ({ state: "fresh", refreshSec: 15, data: { kind: "stat", value: 7, label: "x" } }) }; },
      setInterval: (fn, ms) => { const h = { fn, ms, cleared: false }; intervals.push(h); return h; },
      clearInterval: (h) => { (h as { cleared: boolean }).cleared = true; },
      setTimeout: () => 0,
    };
    const got: [string, WidgetData][] = [];
    const c = new PageDataClient({ appId: "a1", pageId: "p1" }, [{ key: "cpu", refreshSec: 15 }, { key: "load", refreshSec: 60 }], (id, d) => got.push([id, d]), deps);
    c.start();
    expect(FakeES.last.url).toBe("/api/data/stream?app=a1&page=p1");
    FakeES.last.emit("snapshot", { sources: { cpu: { state: "fresh", refreshSec: 15 } } });
    expect(c.mode).toBe("stream");
    FakeES.last.onerror?.({});
    expect(c.mode).toBe("polling");
    expect(intervals.map((i) => i.ms)).toEqual([15_000, 60_000]);
    intervals[0]!.fn();
    await new Promise((r) => setImmediate(r));
    expect(fetched).toEqual(["/api/data/widget/a1%3Acpu?page=p1"]);
    expect(got.at(-1)).toEqual(["cpu", expect.objectContaining({ data: expect.objectContaining({ value: 7 }) })]);
    FakeES.last.onopen?.({});
    expect(c.mode).toBe("stream");
    expect(intervals.every((i) => i.cleared)).toBe(true);
    c.stop();
  });
});
