// The page data stream (architecture v3 section 10): Server-Sent Events for one page of an app.
// The cached value of every data source the page binds goes out at once, keyed by data source
// name, then updates are pushed as the scheduler refreshes keys. Guests never receive whole data
// sources: for a guest the server resolves the page's bindings itself (app-builder's guestValues)
// and sends only the resolved values, keyed "nodeId:prop". A source with refresh Off (refreshSec 0, A11.8)
// gets one fresh value when the page opens (when the cache has none younger than the read's minimum) and
// is then left alone: no later refresh of the same key, by this page or any other, reaches it.
import type { DataSourceDef, Principal, ShapedData } from "@/core/contracts";
import type { ReadCache } from "./cache";
import { cacheKey } from "./keys";
import type { Scheduler } from "./scheduler";
import { signedUrlsBySource, signedUrlsFor, signedUrlsForValues, signedUrlsForValuesBySource, type SourceSigner, type UrlSigner } from "./signed-urls";
import { widgetData } from "./state";
import type { SourceData } from "./types";

/** One data source on a page, as the stream subscribes to it. `key` is the data source name. */
export type StreamSource = { key: string; integrationId: string; endpointId: string; params?: unknown; refreshSec: number };

/**
 * Registered by app-builder (Wave 2). `page` returns the data sources used by bindings on that page
 * of the published version (or the draft, for editors when `draft` is true), and null when the
 * principal cannot open the app. A guest gets only its app's published pages.
 */
export type DataSourceResolver = {
  page(appId: string, pageId: string, principal: Principal, draft: boolean): Promise<DataSourceDef[] | null>;
};

const g = globalThis as unknown as { __atriumDataSources?: DataSourceResolver };

export function registerDataSources(resolver: DataSourceResolver): void {
  g.__atriumDataSources = resolver;
}

export function dataSources(): DataSourceResolver | undefined {
  return g.__atriumDataSources;
}

/** For tests: back to unregistered. */
export function resetDataSources(): void {
  g.__atriumDataSources = undefined;
}

export function streamSourceOf(d: DataSourceDef): StreamSource {
  return { key: d.name, integrationId: d.integrationId, endpointId: d.endpointId, ...(d.params !== undefined ? { params: d.params } : {}), refreshSec: d.refreshSec };
}

const enc = new TextEncoder();
export function sseEvent(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export type StreamDeps = { scheduler: Scheduler; cache: ReadCache; now?: () => number; heartbeatMs?: number };

export type StreamOptions = {
  /** Sources the page may not use any more (an unshared integration, A1.1): sent as failed with this message, never fetched. */
  blocked?: Map<string, string>;
  /** Set for guests: resolves the page's bindings on the server. Only its output is ever sent. */
  guest?: (sources: Record<string, ShapedData>) => Promise<Record<string, unknown>>;
  /**
   * A4.2: signs absolute image URLs. When set, a snapshot, update or values event that holds absolute
   * http(s) URL strings carries a `signedUrls` map for them (for guests: only URLs that are in both the
   * resolved values and the source data). Events without any carry no map.
   */
  sign?: UrlSigner;
  /**
   * Settings r2 (gauntlet w2-r1 items 3 and 4): a signer per data source key. When set it replaces
   * `sign`: each source's URLs are signed only by its own signer (public or its integration's host).
   */
  signFor?: SourceSigner;
};

function blockedData(refreshSec: number, message: string): SourceData {
  return { state: "failed", refreshSec, error: { code: "permission", message } };
}

/** Builds the SSE body for one page. The snapshot goes out before any subscription can trigger a fetch result. */
export function createPageStream(sources: StreamSource[], deps: StreamDeps, signal?: AbortSignal, opts: StreamOptions = {}): ReadableStream<Uint8Array> {
  const now = deps.now ?? Date.now;
  const blocked = opts.blocked ?? new Map<string, string>();
  const live = sources.filter((s) => !blocked.has(s.key));
  const unsubs: (() => void)[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const u of unsubs) u();
    if (heartbeat) clearInterval(heartbeat);
  };
  const current = (s: StreamSource) => widgetData(deps.cache.get(cacheKey(s)), s.refreshSec, now());
  const sign = opts.sign;
  const guestSnapshot = async (): Promise<{ values: Record<string, unknown>; signedUrls?: Record<string, string> }> => {
    const data: Record<string, ShapedData> = {};
    for (const s of live) { const d = current(s).data; if (d) data[s.key] = d; }
    let values: Record<string, unknown>;
    try { values = await opts.guest!(data); } catch { values = {}; }
    const signedUrls = opts.signFor ? signedUrlsForValuesBySource(values, data, opts.signFor) : sign ? signedUrlsForValues(values, data, sign) : {};
    return Object.keys(signedUrls).length ? { values, signedUrls } : { values };
  };
  // The map is sent only when it has an entry, so payloads without external URLs are unchanged.
  const withSigned = <T extends object>(body: T, bySource: Record<string, unknown>): T | (T & { signedUrls: Record<string, string> }) => {
    const signedUrls = opts.signFor ? signedUrlsBySource(bySource, opts.signFor) : sign ? signedUrlsFor(Object.values(bySource), sign) : {};
    return Object.keys(signedUrls).length ? { ...body, signedUrls } : body;
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (bytes: Uint8Array) => { if (closed) return; try { controller.enqueue(bytes); } catch { close(); } };
      send(enc.encode("retry: 3000\n\n"));
      if (opts.guest) {
        send(sseEvent("values", await guestSnapshot()));
      } else {
        const snapshot: Record<string, SourceData> = {};
        for (const s of sources) snapshot[s.key] = blocked.has(s.key) ? blockedData(s.refreshSec, blocked.get(s.key)!) : current(s);
        send(sseEvent("snapshot", withSigned({ sources: snapshot }, Object.fromEntries(Object.entries(snapshot).map(([k, d]) => [k, d.data])))));
      }
      let computing = false;
      let dirty = false;
      const pushValues = async () => {
        if (computing) { dirty = true; return; }
        computing = true;
        do { dirty = false; send(sseEvent("values", await guestSnapshot())); } while (dirty && !closed);
        computing = false;
      };
      for (const s of live) {
        const off = !(s.refreshSec > 0);
        let delivered = false;
        const sub = deps.scheduler.subscribe(s, off ? 0 : s.refreshSec, (entry) => {
          if (closed) return;
          if (off) {
            // A11.8: the one page-open value, then this source stops listening.
            if (delivered) return;
            delivered = true;
            sub.unsubscribe();
          }
          if (opts.guest) {
            // One recomputation of the resolved values at a time; a burst ends with one more.
            void pushValues();
            return;
          }
          const d = widgetData(entry, s.refreshSec, now());
          send(sseEvent("update", withSigned({ key: s.key, ...d }, { [s.key]: d.data })));
        });
        unsubs.push(sub.unsubscribe);
        // Off, and the cache already held a value younger than the read's minimum: the snapshot was it.
        if (off && !sub.pending) { delivered = true; sub.unsubscribe(); }
      }
      heartbeat = setInterval(() => send(enc.encode(": ping\n\n")), deps.heartbeatMs ?? 25_000);
      (heartbeat as { unref?: () => void }).unref?.();
      signal?.addEventListener("abort", () => { close(); try { controller.close(); } catch { /* already closed */ } });
    },
    cancel() { close(); },
  });
}
