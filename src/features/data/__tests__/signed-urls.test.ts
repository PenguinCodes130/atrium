// A4.2 "Bound external images" (Wave 2 lead wiring): the data stream marks every absolute http(s) URL
// string it sends with its signed proxy path, and images use only that map (or the map signed from a
// published document). A URL a template composes, which the server never sent, gets no signature.
import { describe, expect, it } from "vitest";
import type { BindingScope, ReadResult, ShapedData } from "@/core/contracts";
import { evaluateBinding } from "@/features/components/bindings";
import { imageSrc } from "@/features/components/render/content";
import { MemoryBacking, ReadCache } from "../cache";
import { PageDataClient, type PageDataDeps } from "../client";
import { Scheduler } from "../scheduler";
import { collectUrls, signedUrlsFor, signedUrlsForValues } from "../signed-urls";
import { createPageStream } from "../stream";

const sign = (u: string) => (u.includes("169.254.") ? null : `/api/img?u=${encodeURIComponent(u)}&s=test-signature`);
const PIC = "https://img.example.net/cover.png";
const OTHER = "http://192.168.1.5:8080/thumb.jpg";

const feed: ShapedData = {
  kind: "list",
  items: [
    { id: "1", label: "Cover", meta: PIC },
    { id: "2", label: "Thumb", meta: OTHER },
    { id: "3", label: "Metadata host", meta: "http://169.254.169.254/latest" },
    { id: "4", label: "Relative", meta: "/uploads/aaaaaaaaaaaaaaaaaaaa.png" },
    { id: "5", label: "Sentence", meta: `see ${PIC} for more` },
    { id: "6", label: "Other scheme", meta: "ftp://files.example.net/a.png" },
  ],
} as unknown as ShapedData;

const good = (data: ShapedData): ReadResult => ({ ok: true, data, sourceTimestamp: new Date().toISOString(), fetchedAt: new Date().toISOString() });

async function firstEvent(stream: ReadableStream<Uint8Array>): Promise<{ event: string; data: Record<string, unknown> }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buf += dec.decode(value);
    const m = /event: (.+)\ndata: (.+)\n\n/.exec(buf);
    if (m) {
      reader.releaseLock();
      await stream.cancel();
      return { event: m[1]!, data: JSON.parse(m[2]!) };
    }
  }
}

describe("signedUrls (A4.2)", () => {
  it("collects only whole absolute http(s) URL strings, at any depth", () => {
    expect([...collectUrls(feed)].sort()).toEqual(["http://169.254.169.254/latest", OTHER, PIC].sort());
    expect([...collectUrls({ a: [[{ b: PIC }]], n: 3, t: true, z: null })]).toEqual([PIC]);
  });

  it("signs each URL the address rules accept and leaves the rest out", () => {
    const m = signedUrlsFor(feed, sign);
    expect(Object.keys(m).sort()).toEqual([OTHER, PIC].sort());
    expect(m[PIC]).toBe(`/api/img?u=${encodeURIComponent(PIC)}&s=test-signature`);
  });

  it("the stream's snapshot (signed-in viewers) carries the map next to the sources", async () => {
    const cache = new ReadCache(new MemoryBacking());
    const src = { integrationId: "i1", endpointId: "rss" };
    cache.record(src, good(feed));
    const scheduler = new Scheduler({ cache, minRefreshSec: () => 5, fetcher: async () => good(feed) });
    const ev = await firstEvent(createPageStream([{ key: "news", ...src, refreshSec: 60 }], { scheduler, cache }, undefined, { sign }));
    expect(ev.event).toBe("snapshot");
    expect(Object.keys(ev.data.signedUrls as object).sort()).toEqual([OTHER, PIC].sort());
    // Without a signer (older callers, tests) the payload has no map at all.
    const plain = await firstEvent(createPageStream([{ key: "news", ...src, refreshSec: 60 }], { scheduler, cache }));
    expect(plain.data.signedUrls).toBeUndefined();
  });

  it("a guest's values event signs only URLs that are both in the values sent and in the source data", async () => {
    const cache = new ReadCache(new MemoryBacking());
    const src = { integrationId: "i1", endpointId: "rss" };
    cache.record(src, good(feed));
    const scheduler = new Scheduler({ cache, minRefreshSec: () => 5, fetcher: async () => good(feed) });
    // The published page binds the first item's URL as is, and composes another URL from a label.
    const guest = async (data: Record<string, ShapedData>) => {
      const s = { $data: data } as unknown as BindingScope;
      return {
        "c_image:src": evaluateBinding("{{ news.items[0].meta }}", s),
        "c_composed:src": evaluateBinding("https://img.example.net/{{ news.items[1].label }}.png", s),
      };
    };
    const ev = await firstEvent(createPageStream([{ key: "news", ...src, refreshSec: 60 }], { scheduler, cache }, undefined, { sign, guest }));
    expect(ev.event).toBe("values");
    const values = ev.data.values as Record<string, string>;
    expect(values["c_image:src"]).toBe(PIC);
    expect(values["c_composed:src"]).toBe("https://img.example.net/Thumb.png");
    // OTHER is in the data but was not sent to this guest; the composed URL was sent but is not data.
    expect(ev.data.signedUrls).toEqual({ [PIC]: sign(PIC) });
    expect(signedUrlsForValues(values, feed, sign)).toEqual({ [PIC]: sign(PIC) });
  });

  it("a template-composed URL never gets a signature, so the image shows its placeholder", () => {
    const m = signedUrlsFor(feed, sign);
    const s = { $data: { news: feed } } as unknown as BindingScope;
    const bound = evaluateBinding("{{ news.items[0].meta }}", s) as string;
    const composed = evaluateBinding("https://img.example.net/{{ news.items[1].label }}.png", s) as string;
    expect(imageSrc(bound, m)).toBe(sign(PIC));
    expect(composed).toBe("https://img.example.net/Thumb.png");
    expect(m[composed]).toBeUndefined();
    expect(imageSrc(composed, m)).toBeNull();
    // A forged map entry that is not a proxy path is ignored too.
    expect(imageSrc(composed, { [composed]: composed })).toBeNull();
    // Uploads need no signature.
    expect(imageSrc("/uploads/aaaaaaaaaaaaaaaaaaaa.png", {})).toBe("/uploads/aaaaaaaaaaaaaaaaaaaa.png");
  });

  it("documents: a literal URL is signed, a URL template in the document is not", () => {
    const doc = { pages: [{ root: { props: { src: PIC, alt: "x" }, children: [{ props: { src: "https://img.example.net/{{ news.items[0].label }}.png" } }, { props: { src: { $bind: "{{ news.items[0].meta }}" } } }] } }] };
    expect(signedUrlsFor(doc, sign, { skipTemplates: true })).toEqual({ [PIC]: sign(PIC) });
  });

  it("the browser client hands each event's map to its caller (stream and polling)", async () => {
    const listeners = new Map<string, (e: { data: string }) => void>();
    let es: { onopen: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; readyState: number } | undefined;
    const deps: PageDataDeps = {
      EventSource: class {
        onopen: ((e: unknown) => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        readyState = 1;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test needs the instance the client constructs
        constructor() { es = this; }
        addEventListener(t: string, fn: (e: { data: string }) => void) { listeners.set(t, fn); }
        close() {}
      } as unknown as PageDataDeps["EventSource"],
      fetch: async () => ({ ok: true, json: async () => ({ key: "news", state: "fresh", refreshSec: 60, data: feed, signedUrls: { [OTHER]: sign(OTHER) } }) }),
      setInterval: (fn) => { void fn(); return 1; },
      clearInterval: () => {},
      setTimeout: () => 1,
    };
    const signed: Record<string, string>[] = [];
    const data: unknown[] = [];
    const c = new PageDataClient({ appId: "a", pageId: "p" }, [{ key: "news", refreshSec: 60 }], (_k, d) => data.push(d), deps, undefined, (m) => signed.push(m));
    c.start();
    listeners.get("snapshot")!({ data: JSON.stringify({ sources: { news: { state: "fresh", refreshSec: 60, data: feed } }, signedUrls: { [PIC]: sign(PIC) } }) });
    listeners.get("update")!({ data: JSON.stringify({ key: "news", state: "fresh", refreshSec: 60, data: feed, signedUrls: { [PIC]: sign(PIC) } }) });
    expect(signed).toEqual([{ [PIC]: sign(PIC) }, { [PIC]: sign(PIC) }]);
    // The map never leaks into the data source value the page binds.
    expect(data.every((d) => !("signedUrls" in (d as object)))).toBe(true);
    es!.readyState = 0;
    es!.onerror?.({});
    await new Promise((r) => setTimeout(r, 0));
    expect(signed.at(-1)).toEqual({ [OTHER]: sign(OTHER) });
    c.stop();
  });
});
