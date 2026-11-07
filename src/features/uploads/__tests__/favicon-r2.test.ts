// Wave 2.10c round 2, builder S: the favicon fetch's gauntlet r1 fixes (Fix List 6a, 6b, 16).
// 6a: a typed host whose DNS answer mixes public and private addresses can no longer turn the public-only
// guard off (a stub resolver stands in for DNS, which a test cannot control). 6b: the 7 day store is keyed
// by the exact address, so one page's icon is never answered for another page or the bare origin, and
// `refresh` fetches again. 16: icons declared at any path are found, also on a page larger than 512 KB
// (read in part). Websites are FAKE: a scripted request function; nothing here leaves this machine.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawResponse, SafeRequest } from "@/features/integrations/host/request";
import { OWNER, MEMBER, freshDataDir, useInstance } from "@/features/settings/test/harness";
import { encodePng } from "../favicon/image";
import { FAVICON_MESSAGES as M } from "../favicon/messages";

function png(w: number, h: number, seed = 1): Buffer {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([seed & 0xff, (seed >> 8) & 0xff, i & 0xff, 255], i * 4);
  return encodePng(w, h, px);
}

/** A BMP entry for an ICO: `w` x `w`, 8 or 32 bpp, one colour. */
function dib(w: number, bpp: 8 | 32): Buffer {
  const stride = ((w * bpp + 31) >> 5) * 4;
  const maskStride = ((w + 31) >> 5) * 4;
  const colours = bpp === 8 ? 256 : 0;
  const b = Buffer.alloc(40 + colours * 4 + stride * w + maskStride * w);
  b.writeUInt32LE(40, 0); b.writeInt32LE(w, 4); b.writeInt32LE(w * 2, 8); b.writeUInt16LE(1, 12); b.writeUInt16LE(bpp, 14);
  if (colours) b.set([30, 20, 170, 0], 40 + 4);
  const px = 40 + colours * 4;
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const o = px + y * stride;
      if (bpp === 32) b.set([30, 20, 170, 255], o + x * 4);
      else b[o + x] = 1;
    }
  return b;
}
/** The shape of a typical project site's /images/favicon.ico: 16 px at 8 bpp, 32 px and 16 px at 32 bpp. */
function siteIco(): Buffer {
  const entries = [{ w: 16, bpp: 8 as const }, { w: 32, bpp: 32 as const }, { w: 16, bpp: 32 as const }];
  const datas = entries.map((e) => dib(e.w, e.bpp));
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, k) => {
    const at = 6 + k * 16;
    head[at] = e.w;
    head[at + 1] = e.w;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(e.bpp, at + 6);
    head.writeUInt32LE(datas[k]!.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += datas[k]!.length;
  });
  return Buffer.concat([head, ...datas]);
}

type Page = { status?: number; type?: string; body: Buffer | string; ignoresRange?: boolean };
type Site = Record<string, Page>;
const HTML = (head: string, filler = "") => `<!doctype html><html><head><title>FAKE</title>${head}</head><body>FAKE${filler}</body></html>`;

/** A scripted website. Answers a Range header with 206 and the asked-for start, as most servers do. */
function scripted(site: Site) {
  const calls: SafeRequest[] = [];
  const request = async (r: SafeRequest): Promise<RawResponse> => {
    calls.push(r);
    const u = new URL(r.url);
    const page = site[u.host + u.pathname + u.search] ?? site[u.pathname + u.search] ?? site[u.pathname];
    if (!page) return { status: 404, headers: { "content-type": "text/plain" }, body: Buffer.from("no"), url: r.url, redirects: 0 };
    let body = typeof page.body === "string" ? Buffer.from(page.body) : page.body;
    let status = page.status ?? 200;
    const range = /^bytes=0-(\d+)$/.exec(r.headers?.range ?? "");
    if (range && !page.ignoresRange) {
      body = body.subarray(0, Number(range[1]) + 1);
      status = 206;
    }
    if (r.maxBytes !== undefined && body.length > r.maxBytes) {
      const { hostError } = await import("@/features/integrations/host/errors");
      throw hostError("bad_response", "The response was too large.");
    }
    return { status, headers: { "content-type": page.type ?? "text/html" }, body, url: r.url, redirects: 0 };
  };
  return { calls, request };
}

async function boot() {
  vi.resetModules();
  useInstance(freshDataDir());
  const m = await import("../favicon/fetch");
  m.resetFaviconLimits();
  return m;
}

const publicDns = async () => [{ address: "203.0.113.10" }];

describe("6a: a mixed public and private DNS answer never switches the public-only guard off", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });

  it("refuses a typed host whose answer holds a public and a private address, before any request", async () => {
    // The page would send Atrium's server to a LAN machine through an icon link and a manifest.
    const s = scripted({
      "/": { body: HTML(`<link rel="icon" href="http://10.0.0.9/admin/icon.png"><link rel="manifest" href="http://192.168.1.1/m.json">`) },
      "10.0.0.9/admin/icon.png": { type: "image/png", body: png(16, 16, 2) },
    });
    for (const answer of [
      [{ address: "203.0.113.5" }, { address: "10.0.0.1" }],
      [{ address: "10.0.0.1" }, { address: "203.0.113.5" }],
      [{ address: "fd12:3456::1" }, { address: "2001:db8::5" }, { address: "198.51.100.7" }],
      [{ address: "127.0.0.1" }, { address: "203.0.113.5" }],
    ]) {
      await expect(m.fetchFavicon(OWNER, "https://mixed.fake.example/", { request: s.request, resolve: async () => answer }), JSON.stringify(answer)).rejects.toMatchObject({ message: M.mixedAnswer, status: 403, code: "favicon_refused" });
    }
    expect(s.calls).toHaveLength(0);
  });

  it("a mixed answer followed by a redirect to a private address: nothing reaches the LAN", async () => {
    // Stand-in for safeRequest following a redirect: the scripted site answers the typed page with an icon
    // that sits on the LAN. Whatever the order of the answer, no request is sent at all.
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="http://10.0.0.9/i.png">`) }, "10.0.0.9/i.png": { type: "image/png", body: png(16, 16, 3) } });
    await expect(m.fetchFavicon(OWNER, "http://mixed2.fake.example/", { request: s.request, resolve: async () => [{ address: "10.0.0.1" }, { address: "203.0.113.5" }] })).rejects.toMatchObject({ message: M.mixedAnswer });
    expect(s.calls.map((c) => c.url)).toEqual([]);
  });

  it("an all-public answer runs public-only and an all-private one runs as a LAN address, as before", async () => {
    const site = { "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: png(16, 16, 4) } };
    const pub = scripted(site);
    await m.fetchFavicon(OWNER, "https://pub.fake.example/", { request: pub.request, resolve: async () => [{ address: "203.0.113.5" }, { address: "2001:db8::5" }] });
    expect(pub.calls.length).toBeGreaterThan(0);
    for (const c of pub.calls) expect(c.headers?.["x-atrium-favicon"]).toBe("public-only");
    const lan = scripted(site);
    await m.fetchFavicon(OWNER, "http://nas.fake.lan/", { request: lan.request, resolve: async () => [{ address: "10.0.0.5" }, { address: "fd12::5" }] });
    for (const c of lan.calls) expect(c.headers?.["x-atrium-favicon"]).toBeUndefined();
  });
});

describe("6b: the 7 day store is keyed by the exact address, and refresh fetches again", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });

  it("one page's icon is never answered for the bare origin or another page", async () => {
    const pinned = png(32, 32, 41);
    const real = png(32, 32, 42);
    const s = scripted({
      "/~member/page": { body: HTML(`<link rel="icon" href="/~member/chosen.png">`) },
      "/~member/chosen.png": { type: "image/png", body: pinned },
      "/": { body: HTML(`<link rel="icon" href="/site.png">`) },
      "/site.png": { type: "image/png", body: real },
      "/other": { body: HTML(`<link rel="icon" href="/site.png">`) },
    });
    const a = await m.fetchFavicon(MEMBER, "https://shared.fake.example/~member/page", { request: s.request, resolve: publicDns });
    const b = await m.fetchFavicon(OWNER, "https://shared.fake.example/", { request: s.request, resolve: publicDns });
    expect(b.cached).toBe(false);
    expect(b.path).not.toBe(a.path);
    const c = await m.fetchFavicon(OWNER, "https://shared.fake.example/other", { request: s.request, resolve: publicDns });
    expect(c.cached).toBe(false);
    const store = await import("../store");
    expect(store.readUpload(b.path.slice(9))!.bytes.equals(real)).toBe(true);
  });

  it("the same address (with or without the trailing slash, any fragment) answers from the store", async () => {
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: png(32, 32, 43) }, "/app": { body: HTML(`<link rel="icon" href="/i.png">`) } });
    const first = await m.fetchFavicon(OWNER, "https://same.fake.example", { request: s.request, resolve: publicDns });
    const n = s.calls.length;
    expect(await m.fetchFavicon(MEMBER, "https://same.fake.example/", { request: s.request, resolve: publicDns })).toEqual({ ...first, cached: true });
    expect(await m.fetchFavicon(MEMBER, "https://same.fake.example/#top", { request: s.request, resolve: publicDns })).toEqual({ ...first, cached: true });
    expect(s.calls.length).toBe(n);
    // Another path, or a query, is its own entry.
    expect((await m.fetchFavicon(MEMBER, "https://same.fake.example/app", { request: s.request, resolve: publicDns })).cached).toBe(false);
    expect((await m.fetchFavicon(MEMBER, "https://same.fake.example/?v=2", { request: s.request, resolve: publicDns })).cached).toBe(false);
  });

  it("refresh skips the store, fetches again and keeps the new icon", async () => {
    let icon = png(32, 32, 44);
    const site: Site = { "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: icon } };
    const s = scripted(site);
    const first = await m.fetchFavicon(OWNER, "https://again.fake.example/", { request: s.request, resolve: publicDns });
    icon = png(32, 32, 45);
    site["/i.png"] = { type: "image/png", body: icon };
    expect((await m.fetchFavicon(OWNER, "https://again.fake.example/", { request: s.request, resolve: publicDns })).cached).toBe(true);
    const fresh = await m.fetchFavicon(OWNER, "https://again.fake.example/", { request: s.request, resolve: publicDns, refresh: true });
    expect(fresh.cached).toBe(false);
    expect(fresh.path).not.toBe(first.path);
    // The store now answers the new icon.
    expect(await m.fetchFavicon(MEMBER, "https://again.fake.example/", { request: s.request, resolve: publicDns })).toEqual({ ...fresh, cached: true });
  });
});

describe("16: icons declared at any path are found, also on a page over 512 KB", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });
  const big = (head: string) => HTML(head, "x".repeat(600 * 1024));

  it("a page over 512 KB that declares /images/favicon.ico (and has no /favicon.ico) gives that icon", async () => {
    const s = scripted({ "/": { body: big(`<link data-rh="true" rel="icon" href="/images/favicon.ico">`) }, "/images/favicon.ico": { type: "image/vnd.microsoft.icon", body: siteIco() } });
    const r = await m.fetchFavicon(OWNER, "https://project.fake.example/", { request: s.request, resolve: publicDns });
    expect(r.path).toMatch(/\.png$/);
    // The page whole (too large), the page's first 512 KB, then the declared icon. Never /favicon.ico.
    expect(s.calls.map((c) => [new URL(c.url).pathname, c.headers?.range ?? null])).toEqual([
      ["/", null],
      ["/", "bytes=0-524287"],
      ["/images/favicon.ico", null],
    ]);
    const { imageSize } = await import("../favicon/image");
    const store = await import("../store");
    expect(imageSize(store.readUpload(r.path.slice(9))!.bytes)).toEqual({ w: 32, h: 32 });
  });

  it("a small page that declares an icon under any folder gives it", async () => {
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="/images/favicon.ico">`) }, "/images/favicon.ico": { type: "image/x-icon", body: siteIco() } });
    const r = await m.fetchFavicon(OWNER, "https://small.fake.example/", { request: s.request, resolve: publicDns });
    expect(r.path).toMatch(/\.png$/);
    expect(s.calls.every((c) => c.headers?.range === undefined)).toBe(true);
  });

  it("a page over 512 KB whose server ignores the Range header says so when /favicon.ico is missing too", async () => {
    const s = scripted({ "/": { body: big(`<link rel="icon" href="/images/favicon.ico">`), ignoresRange: true }, "/images/favicon.ico": { type: "image/x-icon", body: siteIco() } });
    await expect(m.fetchFavicon(OWNER, "https://norange.fake.example/", { request: s.request, resolve: publicDns })).rejects.toMatchObject({ message: M.pageTooLarge, status: 422 });
    expect(s.calls.map((c) => new URL(c.url).pathname)).toEqual(["/", "/", "/favicon.ico"]);
  });
});
