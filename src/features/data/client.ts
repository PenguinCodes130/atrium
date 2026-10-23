// Browser side of the page data stream (architecture v3 section 10). Opens the SSE stream for one
// app page; values are keyed by data source name. When the stream drops, each data source polls
// GET /api/data/widget/<appId>:<name>?page=<pageId> at its refresh interval until it reconnects.
// Guests receive only resolved values ("nodeId:prop"), delivered through onValues.
import type { SourceData } from "./types";

type ES = { onopen: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; addEventListener(t: string, fn: (e: { data: string }) => void): void; close(): void; readyState: number };
export type PageDataDeps = {
  EventSource: new (url: string) => ES;
  fetch: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
};

/** One data source the page uses: its name and refresh interval. */
export type PageDataSource = { key: string; refreshSec: number };

export type PageDataTarget = { appId: string; pageId: string; draft?: boolean };

export class PageDataClient {
  private es: ES | undefined;
  private polls = new Map<string, unknown>();
  private reconnect: unknown;
  private stopped = false;
  mode: "connecting" | "stream" | "polling" = "connecting";

  constructor(
    private target: PageDataTarget,
    private sources: PageDataSource[],
    private onData: (key: string, data: SourceData) => void,
    private deps: PageDataDeps,
    private onValues?: (values: Record<string, unknown>) => void,
    /** A4.2: the signed proxy paths for absolute image URLs the server sent (merged by the caller). */
    private onSigned?: (signedUrls: Record<string, string>) => void,
  ) {}

  private signed(body: { signedUrls?: unknown }) {
    const m = body.signedUrls;
    if (m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).length) this.onSigned?.(m as Record<string, string>);
  }

  private query(): string {
    const q = new URLSearchParams({ app: this.target.appId, page: this.target.pageId });
    if (this.target.draft) q.set("draft", "1");
    return q.toString();
  }

  start() {
    this.stopped = false;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    const es = new this.deps.EventSource(`/api/data/stream?${this.query()}`);
    this.es = es;
    es.onopen = () => {
      this.mode = "stream";
      this.stopPolling();
    };
    es.addEventListener("snapshot", (e) => {
      this.mode = "stream";
      this.stopPolling();
      const body = JSON.parse(e.data) as { sources: Record<string, SourceData>; signedUrls?: Record<string, string> };
      this.signed(body);
      for (const [key, d] of Object.entries(body.sources)) this.onData(key, d);
    });
    es.addEventListener("update", (e) => {
      const { key, signedUrls, ...d } = JSON.parse(e.data) as SourceData & { key: string; signedUrls?: Record<string, string> };
      this.signed({ signedUrls });
      this.onData(key, d);
    });
    es.addEventListener("values", (e) => {
      this.mode = "stream";
      this.stopPolling();
      const body = JSON.parse(e.data) as { values: Record<string, unknown>; signedUrls?: Record<string, string> };
      this.signed(body);
      this.onValues?.(body.values);
    });
    es.onerror = () => {
      this.startPolling();
      // readyState 2 = CLOSED: the browser will not retry by itself, so reconnect by hand.
      if (es.readyState === 2) {
        es.close();
        this.reconnect = this.deps.setTimeout(() => this.open(), 5000);
      }
    };
  }

  private startPolling() {
    if (this.stopped || this.polls.size) return;
    this.mode = "polling";
    const page = new URLSearchParams({ page: this.target.pageId, ...(this.target.draft ? { draft: "1" } : {}) }).toString();
    for (const s of this.sources) {
      const poll = async () => {
        try {
          const res = await this.deps.fetch(`/api/data/widget/${encodeURIComponent(`${this.target.appId}:${s.key}`)}?${page}`);
          if (!res.ok || this.mode !== "polling") return;
          const body = (await res.json()) as ((SourceData & { key?: string }) | { values: Record<string, unknown> }) & { signedUrls?: Record<string, string> };
          this.signed(body);
          if ("values" in body) this.onValues?.(body.values);
          else { const { key: _key, signedUrls: _signed, ...d } = body; void _key; void _signed; this.onData(s.key, d as SourceData); }
        } catch { /* keep polling */ }
      };
      this.polls.set(s.key, this.deps.setInterval(poll, Math.max(s.refreshSec, 5) * 1000));
    }
  }

  private stopPolling() {
    for (const h of this.polls.values()) this.deps.clearInterval(h);
    this.polls.clear();
  }

  stop() {
    this.stopped = true;
    this.stopPolling();
    this.es?.close();
  }
}
