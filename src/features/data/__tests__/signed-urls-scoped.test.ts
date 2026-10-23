// Settings r2 shared file request (gauntlet w2-r1 items 3 and 4): the stream and the polling fallback
// sign each data source's URLs with that source's own signer, so a URL is signed only by the rules of
// the source it came from (public, or that integration's own host).
import { describe, expect, it } from "vitest";
import type { ReadResult, ShapedData } from "@/core/contracts";
import { MemoryBacking, ReadCache } from "../cache";
import { Scheduler } from "../scheduler";
import { signedUrlsBySource, signedUrlsForValuesBySource } from "../signed-urls";
import { createPageStream } from "../stream";

const PUBLIC = "https://img.example.net/cover.png";
const CAM = "http://10.0.0.9/snapshot.jpg";
// A stand-in signer per source: "news" (a public feed) signs public URLs only; "cam" signs its own host.
const signerFor = (key: string) =>
  key === "news" ? (u: string) => (u.startsWith("https://") ? `/api/img?u=${encodeURIComponent(u)}&src=news` : null)
  : key === "cam" ? (u: string) => (u.startsWith("http://10.0.0.9/") ? `/api/img?u=${encodeURIComponent(u)}&src=cam` : null)
  : null;
const news = { kind: "list", items: [{ id: "1", label: "a", meta: PUBLIC }, { id: "2", label: "b", meta: CAM }] } as unknown as ShapedData;
const cam = { kind: "stat", value: 1, meta: CAM } as unknown as ShapedData;
const good = (data: ShapedData): ReadResult => ({ ok: true, data, sourceTimestamp: new Date().toISOString(), fetchedAt: new Date().toISOString() });

describe("per-source signing", () => {
  it("signs a URL only with the signer of a source that holds it", () => {
    expect(signedUrlsBySource({ news }, signerFor)).toEqual({ [PUBLIC]: `/api/img?u=${encodeURIComponent(PUBLIC)}&src=news` });
    expect(signedUrlsBySource({ news, cam }, signerFor)).toEqual({ [PUBLIC]: `/api/img?u=${encodeURIComponent(PUBLIC)}&src=news`, [CAM]: `/api/img?u=${encodeURIComponent(CAM)}&src=cam` });
    expect(signedUrlsBySource({ other: news }, signerFor)).toEqual({});
    expect(signedUrlsForValuesBySource({ "n:src": CAM, "n:img": PUBLIC }, { news }, signerFor)).toEqual({ [PUBLIC]: `/api/img?u=${encodeURIComponent(PUBLIC)}&src=news` });
  });

  it("the stream's snapshot uses signFor per source", async () => {
    const cache = new ReadCache(new MemoryBacking());
    const a = { integrationId: "rss", endpointId: "feed" };
    const b = { integrationId: "cam", endpointId: "snap" };
    cache.record(a, good(news));
    cache.record(b, good(cam));
    const scheduler = new Scheduler({ cache, minRefreshSec: () => 5, fetcher: async () => good(news) });
    const stream = createPageStream([{ key: "news", ...a, refreshSec: 60 }, { key: "cam", ...b, refreshSec: 60 }], { scheduler, cache }, undefined, { signFor: signerFor });
    const reader = stream.getReader();
    let buf = "";
    for (;;) {
      const { value } = await reader.read();
      buf += new TextDecoder().decode(value);
      if (/event: snapshot\ndata: .+\n\n/.test(buf)) break;
    }
    reader.releaseLock();
    await stream.cancel();
    const data = JSON.parse(/event: snapshot\ndata: (.+)\n\n/.exec(buf)![1]!) as { signedUrls: Record<string, string> };
    expect(data.signedUrls[PUBLIC]).toContain("src=news");
    expect(data.signedUrls[CAM]).toContain("src=cam");
  });
});
