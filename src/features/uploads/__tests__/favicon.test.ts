// Wave 2.10c builder S, N4 (A11.6): the favicon fetch's parser, image handling, size caps, refusal
// sentences and 7 day store. Websites are FAKE: a scripted request function, or a stand-in http server
// on loopback for the real egress engine. Link-local and metadata addresses are refused before any
// socket opens, so nothing here leaves this machine.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawResponse, SafeRequest } from "@/features/integrations/host/request";
import { MEMBER, OWNER, VIEWER, freshDataDir, useInstance } from "@/features/settings/test/harness";
import { decodeDataUrl, decodeDib, encodePng, icoToPng, imageSize } from "../favicon/image";
import { FAVICON_MESSAGES as M } from "../favicon/messages";
import { fallbackIcon, parseManifest, parsePage, parseSizes, rankIcons } from "../favicon/parse";

// ---- FAKE images ----

function png(w: number, h: number, seed = 1): Buffer {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([seed & 0xff, (seed >> 8) & 0xff, i & 0xff, 255], i * 4);
  return encodePng(w, h, px);
}
const gif = (w: number, h: number) => { const b = Buffer.alloc(32); b.write("GIF89a", 0, "ascii"); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
function jpeg(w: number, h: number): Buffer {
  // SOI, an APP0 segment, then SOF0 with the frame size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function webpLossless(w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(24, 4); b.write("WEBP", 8, "ascii"); b.write("VP8L", 12, "ascii");
  b[20] = 0x2f;
  const bits = (w - 1) | ((h - 1) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}
/** An ICO with the given entries: { png } for an embedded PNG, or { w, bpp } for a BMP entry. */
function ico(entries: ({ png: Buffer; w: number } | { w: number; bpp: 32 | 24 | 8 | 1; colour?: number[] })[]): Buffer {
  const datas = entries.map((e) => ("png" in e ? e.png : dib(e.w, e.bpp, e.colour ?? [10, 20, 30])));
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, k) => {
    const at = 6 + k * 16;
    head[at] = e.w >= 256 ? 0 : e.w;
    head[at + 1] = e.w >= 256 ? 0 : e.w;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE("png" in e ? 32 : e.bpp, at + 6);
    head.writeUInt32LE(datas[k]!.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += datas[k]!.length;
  });
  return Buffer.concat([head, ...datas]);
}
function dib(w: number, bpp: number, rgb: number[]): Buffer {
  const stride = ((w * bpp + 31) >> 5) * 4;
  const maskStride = ((w + 31) >> 5) * 4;
  const colours = bpp <= 8 ? 1 << bpp : 0;
  const b = Buffer.alloc(40 + colours * 4 + stride * w + maskStride * w);
  b.writeUInt32LE(40, 0); b.writeInt32LE(w, 4); b.writeInt32LE(w * 2, 8); b.writeUInt16LE(1, 12); b.writeUInt16LE(bpp, 14);
  if (colours) b.set([rgb[2]!, rgb[1]!, rgb[0]!, 0], 40 + 4); // palette entry 1
  const px = 40 + colours * 4;
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const o = px + y * stride;
      if (bpp === 32) b.set([rgb[2]!, rgb[1]!, rgb[0]!, 255], o + x * 4);
      else if (bpp === 24) b.set([rgb[2]!, rgb[1]!, rgb[0]!], o + x * 3);
      else if (bpp === 8) b[o + x] = 1;
      else b[o + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  // AND mask: the first pixel of the bottom row is transparent.
  b[px + stride * w] = 0x80;
  return b;
}

// ---- Parser ----

describe("parsePage: link rel icons, apple-touch-icon, manifest and base", () => {
  it("finds icon and apple-touch-icon links, resolves them, decodes entities and skips mask-icon", () => {
    const html = `<!doctype html><html><head>
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <LINK REL="Shortcut Icon" HREF="/favicon.ico?v=1&amp;x=2">
      <link rel=apple-touch-icon href=/apple.png>
      <link rel="icon" type="image/png" sizes="16x16 32x32" href='/i32.png'>
      <link rel="icon" href="/big.png" sizes="512x512">
      <link rel="manifest" href="/site.webmanifest">
      <link rel="stylesheet" href="/x.css"></head><body><link rel="icon" href="/late.png"></body></html>`;
    const r = parsePage(html, "https://fake.example/app/");
    expect(r.icons.map((c) => c.url)).toEqual([
      "https://fake.example/favicon.ico?v=1&x=2",
      "https://fake.example/apple.png",
      "https://fake.example/i32.png",
      "https://fake.example/big.png",
      "https://fake.example/late.png",
    ]);
    expect(r.icons[1]).toMatchObject({ from: "apple-touch", px: 180 });
    expect(r.icons[2]!.px).toBe(32);
    expect(r.icons[3]).toMatchObject({ px: 0, oversized: true });
    expect(r.manifest).toBe("https://fake.example/site.webmanifest");
  });

  it("ignores links inside comments, scripts and templates, and follows <base href>", () => {
    const html = `<head><!-- <link rel="icon" href="/commented.png"> --><script>var s = '<link rel="icon" href="/in-script.png">';</script>
      <template><link rel="icon" href="/in-template.png"></template><base href="https://cdn.fake.example/assets/"><link rel="icon" href="logo.svg"></head>`;
    const r = parsePage(html, "https://fake.example/");
    expect(r.icons).toEqual([{ url: "https://cdn.fake.example/assets/logo.svg", from: "link", px: 0, oversized: false, svg: true }]);
  });

  it("keeps only http(s) and data:image addresses", () => {
    const html = `<link rel="icon" href="javascript:alert(1)"><link rel="icon" href="file:///etc/passwd"><link rel="icon" href="data:text/html,hi"><link rel="icon" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">`;
    expect(parsePage(html, "http://fake.example/").icons.map((c) => c.url)).toEqual(["data:image/svg+xml,%3Csvg%3E%3C/svg%3E"]);
  });

  it("scans a hostile 512 KB page in linear time", () => {
    for (const filler of ["<".repeat(512 * 1024), "<!--".repeat(128 * 1024), '<a x="'.repeat(80 * 1024), "<script>".repeat(64 * 1024)]) {
      const t0 = performance.now();
      parsePage(filler, "http://fake.example/");
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });

  it("reads manifest icons, leaving out monochrome-only ones", () => {
    const m = JSON.stringify({ icons: [{ src: "/m-192.png", sizes: "192x192", type: "image/png" }, { src: "m-512.png", sizes: "512x512" }, { src: "/mono.svg", purpose: "monochrome" }, { src: "/mask.png", sizes: "96x96", purpose: "maskable" }, { nope: 1 }] });
    expect(parseManifest(m, "https://fake.example/static/site.webmanifest").map((c) => [c.url, c.px, c.oversized])).toEqual([
      ["https://fake.example/m-192.png", 192, false],
      ["https://fake.example/static/m-512.png", 0, true],
      ["https://fake.example/mask.png", 96, false],
    ]);
    expect(parseManifest("not json", "https://fake.example/")).toEqual([]);
  });

  it("ranks SVG first, then the largest declared raster at most 256 px, then apple-touch, then /favicon.ico", () => {
    const base = "https://fake.example/";
    const list = parsePage(`<link rel="icon" href="/16.png" sizes="16x16"><link rel="icon" href="/unknown.png"><link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/192.png" sizes="192x192"><link rel="icon" href="/huge.png" sizes="1024x1024"><link rel="icon" href="/logo.svg" sizes="any">`, base).icons;
    expect(rankIcons([...list, fallbackIcon(base)]).map((c) => new URL(c.url).pathname)).toEqual(["/logo.svg", "/192.png", "/apple.png", "/16.png", "/unknown.png", "/favicon.ico"]);
  });

  it("parseSizes reads lists and 'any'", () => {
    expect(parseSizes("16x16 32x32 300x300")).toEqual({ px: 32, oversized: false, any: false });
    expect(parseSizes("512x512")).toEqual({ px: 0, oversized: true, any: false });
    expect(parseSizes("any")).toEqual({ px: 0, oversized: false, any: true });
    expect(parseSizes(undefined)).toEqual({ px: 0, oversized: false, any: false });
  });
});

// ---- Images ----

describe("image sizes, ICO and data: URLs", () => {
  it("reads the pixel size of PNG, GIF, JPEG and WebP", () => {
    expect(imageSize(png(180, 90))).toEqual({ w: 180, h: 90 });
    expect(imageSize(gif(48, 48))).toEqual({ w: 48, h: 48 });
    expect(imageSize(jpeg(300, 200))).toEqual({ w: 300, h: 200 });
    expect(imageSize(webpLossless(64, 32))).toEqual({ w: 64, h: 32 });
    expect(imageSize(Buffer.from("<svg/>"))).toBeNull();
  });

  it("an ICO gives its largest entry at most 256 px: an embedded PNG as it is", () => {
    const p48 = png(48, 48, 7);
    // The 300 px PNG entry (its header says 255) is skipped as too large; the 16 px BMP is smaller.
    const r = icoToPng(ico([{ w: 16, bpp: 32 as const }, { png: p48, w: 48 }, { png: png(300, 300), w: 255 }]));
    expect(r && "png" in r && r.png.equals(p48)).toBe(true);
  });

  it("an ICO's BMP entries (32, 24, 8 and 1 bpp) become RGBA PNGs with the AND mask as transparency", () => {
    for (const bpp of [32, 24, 8, 1] as const) {
      const r = icoToPng(ico([{ w: 16, bpp, colour: [200, 100, 50] }]));
      expect(r && "png" in r, `bpp ${bpp}`).toBe(true);
      const out = r as { png: Buffer; size: { w: number; h: number } };
      expect(out.size).toEqual({ w: 16, h: 16 });
      expect(imageSize(out.png)).toEqual({ w: 16, h: 16 });
      const px = decodeDib(dib(16, bpp, [200, 100, 50]))!.pixels;
      expect([...px.subarray(0, 4)]).toEqual([200, 100, 50, 255]);
      // Bottom row, first pixel (the last row in the output): masked.
      if (bpp !== 32) expect(px[(15 * 16) * 4 + 3]).toBe(0);
    }
  });

  it("an ICO whose entries are all larger than 256 px says so; a broken one gives null", () => {
    // The header cannot say more than 256 (0 means 256), so a larger entry is a PNG whose own size is larger.
    expect(icoToPng(ico([{ png: png(300, 300), w: 255 }]))).toEqual({ tooLarge: true });
    expect(icoToPng(Buffer.from([0, 0, 1, 0, 1, 0, 1, 2, 3]))).toBeNull();
    expect(icoToPng(Buffer.from("not an ico at all, really not"))).toBeNull();
  });

  it("decodes data:image URLs up to the cap and refuses other types", () => {
    const p = png(8, 8);
    expect(decodeDataUrl(`data:image/png;base64,${p.toString("base64")}`, 1024)!.equals(p)).toBe(true);
    expect(decodeDataUrl("data:image/svg+xml,%3Csvg%20xmlns%3D%22x%22%2F%3E", 1024)!.toString()).toBe('<svg xmlns="x"/>');
    expect(decodeDataUrl("data:text/html,<script>", 1024)).toBeNull();
    expect(decodeDataUrl(`data:image/png;base64,${Buffer.alloc(2048).toString("base64")}`, 1024)).toBeNull();
  });
});

// ---- The fetch, with a scripted website ----

type Site = Record<string, { status?: number; type?: string; body: Buffer | string; location?: string }>;
const HTML = (head: string) => `<!doctype html><html><head><title>FAKE</title>${head}</head><body>FAKE</body></html>`;

async function boot() {
  vi.resetModules();
  useInstance(freshDataDir());
  const fetchMod = await import("../favicon/fetch");
  const req = await import("@/features/integrations/host/request");
  const errors = await import("@/features/integrations/host/errors");
  const core = await import("@/core/db");
  return { ...fetchMod, req, errors, core };
}

/** A scripted website: every call is recorded; redirects are not followed here (safeRequest does that). */
function scripted(site: Site) {
  const calls: SafeRequest[] = [];
  const request = async (r: SafeRequest): Promise<RawResponse> => {
    calls.push(r);
    const u = new URL(r.url);
    const page = site[u.pathname + u.search] ?? site[u.pathname];
    if (!page) return { status: 404, headers: { "content-type": "text/plain" }, body: Buffer.from("no"), url: r.url, redirects: 0 };
    const body = typeof page.body === "string" ? Buffer.from(page.body) : page.body;
    if (r.maxBytes !== undefined && body.length > r.maxBytes) {
      const { hostError } = await import("@/features/integrations/host/errors");
      throw hostError("bad_response", "The response was too large.");
    }
    return { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html" }, body, url: r.url, redirects: 0 };
  };
  return { calls, request };
}
const publicDns = async () => [{ address: "203.0.113.10" }];
const lanDns = async () => [{ address: "10.77.0.5" }];

describe("fetchFavicon: picks, caps and stores", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
    m.resetFaviconLimits();
  });

  it("stores the best raster at most 256 px as an image upload and names it after the host", async () => {
    const icon = png(180, 180, 3);
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="/16.png" sizes="16x16"><link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/512.png" sizes="512x512">`) }, "/16.png": { type: "image/png", body: png(16, 16) }, "/apple.png": { type: "image/png", body: icon }, "/512.png": { type: "image/png", body: png(512, 512) } });
    const r = await m.fetchFavicon(OWNER, "https://plex.fake.example", { request: s.request, resolve: publicDns });
    expect(r.path).toMatch(/^\/uploads\/[a-z0-9]{20}\.png$/);
    expect(r.name).toBe("plex.fake.example icon");
    expect(r.cached).toBe(false);
    const store = await import("../store");
    expect(store.readUpload(r.path.slice(9))!.bytes.equals(icon)).toBe(true);
    // The apple-touch icon (180 px by convention) beats the 16 px one; the 512 px one is never fetched.
    expect(s.calls.map((c) => new URL(c.url).pathname)).toEqual(["/", "/apple.png"]);
  });

  it("caps: the page at 512 KB, each icon at 1 MB, one 5 s deadline across the whole fetch", async () => {
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: png(32, 32) } });
    await m.fetchFavicon(OWNER, "https://caps.fake.example/", { request: s.request, resolve: publicDns });
    expect(s.calls[0]!.maxBytes).toBe(512 * 1024);
    expect(s.calls[1]!.maxBytes).toBe(1024 * 1024);
    for (const c of s.calls) {
      expect(c.timeoutMs).toBeLessThanOrEqual(5000);
      expect(c.redirect).toEqual({ mode: "checked" });
      expect(c.method).toBe("GET");
      expect(c.body).toBeUndefined();
    }
  });

  it("a page over 512 KB is not parsed; /favicon.ico is tried instead", async () => {
    const s = scripted({ "/": { body: "x".repeat(600 * 1024) }, "/favicon.ico": { type: "image/x-icon", body: ico([{ w: 32, bpp: 32 }]) } });
    const r = await m.fetchFavicon(OWNER, "https://bigpage.fake.example/", { request: s.request, resolve: publicDns });
    expect(r.path).toMatch(/\.png$/);
    expect(s.calls.map((c) => new URL(c.url).pathname)).toEqual(["/", "/favicon.ico"]);
  });

  it("an icon over 1 MB, or only icons over 256 px, answer in words", async () => {
    const big = scripted({ "/": { body: HTML(`<link rel="icon" href="/big.png">`) }, "/big.png": { type: "image/png", body: Buffer.concat([png(32, 32), Buffer.alloc(1024 * 1024)]) } });
    await expect(m.fetchFavicon(OWNER, "https://big.fake.example/", { request: big.request, resolve: publicDns })).rejects.toMatchObject({ message: M.tooLarge, status: 422 });
    const huge = scripted({ "/": { body: HTML(`<link rel="icon" href="/u.png">`) }, "/u.png": { type: "image/png", body: png(300, 300) } });
    await expect(m.fetchFavicon(OWNER, "https://huge.fake.example/", { request: huge.request, resolve: publicDns })).rejects.toMatchObject({ message: M.tooManyPx, status: 422 });
    const declared = scripted({ "/": { body: HTML(`<link rel="icon" href="/d.png" sizes="512x512">`) } });
    await expect(m.fetchFavicon(OWNER, "https://declared.fake.example/", { request: declared.request, resolve: publicDns })).rejects.toMatchObject({ message: M.tooManyPx });
    // The 512 px declared icon is never even fetched.
    expect(declared.calls.map((c) => new URL(c.url).pathname)).toEqual(["/", "/favicon.ico"]);
    const none = scripted({ "/": { body: HTML("") }, "/favicon.ico": { type: "text/html", body: "<html>nope</html>" } });
    await expect(m.fetchFavicon(OWNER, "https://none.fake.example/", { request: none.request, resolve: publicDns })).rejects.toMatchObject({ message: M.none, code: "favicon_none" });
  });

  it("an SVG icon is stored sanitised; the manifest is read only when the links give nothing good", async () => {
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="4" height="4"/><image href="http://169.254.169.254/x"/></svg>`;
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="/i.svg"><link rel="manifest" href="/m.json">`) }, "/i.svg": { type: "image/svg+xml", body: evil } });
    const r = await m.fetchFavicon(OWNER, "https://svg.fake.example/", { request: s.request, resolve: publicDns });
    const store = await import("../store");
    const saved = store.readUpload(r.path.slice(9))!.bytes.toString();
    expect(saved).toContain("<rect");
    expect(saved).not.toMatch(/script|onload|169\.254/);
    expect(s.calls.map((c) => new URL(c.url).pathname)).toEqual(["/", "/i.svg"]);
    const man = scripted({ "/": { body: HTML(`<link rel="manifest" href="/m.json">`) }, "/m.json": { type: "application/json", body: JSON.stringify({ icons: [{ src: "/192.png", sizes: "192x192" }] }) }, "/192.png": { type: "image/png", body: png(192, 192, 9) } });
    const r2 = await m.fetchFavicon(OWNER, "https://manifest.fake.example/", { request: man.request, resolve: publicDns });
    expect(r2.path).toMatch(/\.png$/);
    expect(man.calls.map((c) => new URL(c.url).pathname)).toEqual(["/", "/m.json", "/192.png"]);
  });

  it("the address itself may be the icon", async () => {
    const s = scripted({ "/logo.png": { type: "image/png", body: png(64, 64, 11) } });
    const r = await m.fetchFavicon(OWNER, "https://direct.fake.example/logo.png", { request: s.request, resolve: publicDns });
    expect(r.path).toMatch(/\.png$/);
    expect(s.calls).toHaveLength(1);
  });

  it("deduplicates by content hash: two sites with the same icon share one upload", async () => {
    const icon = png(32, 32, 77);
    const site = { "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: icon } };
    const a = await m.fetchFavicon(OWNER, "https://a.fake.example/", { request: scripted(site).request, resolve: publicDns });
    const b = await m.fetchFavicon(MEMBER, "https://b.fake.example/", { request: scripted(site).request, resolve: publicDns });
    expect(b.path).toBe(a.path);
    const { uploads } = await import("@/db/schema/uploads");
    expect(m.core.db().select().from(uploads).all()).toHaveLength(1);
  });
});

describe("fetchFavicon: the 7 day same-origin store", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
    m.resetFaviconLimits();
  });

  it("the same origin within 7 days answers the stored path without any request; after 7 days it fetches again", async () => {
    let now = Date.UTC(2026, 10, 6, 12);
    const clock = () => now;
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: png(32, 32, 5) } });
    const first = await m.fetchFavicon(OWNER, "https://cache.fake.example/", { request: s.request, resolve: publicDns, now: clock });
    expect(s.calls).toHaveLength(2);
    now += 6 * 24 * 3600 * 1000;
    const again = await m.fetchFavicon(MEMBER, "https://cache.fake.example/another/page?x=1", { request: s.request, resolve: publicDns, now: clock });
    expect(again).toEqual({ ...first, cached: true });
    expect(s.calls).toHaveLength(2);
    // Another origin (other scheme or port) is its own entry.
    await m.fetchFavicon(OWNER, "https://cache.fake.example:8443/", { request: s.request, resolve: publicDns, now: clock });
    expect(s.calls).toHaveLength(4);
    now += 1 * 24 * 3600 * 1000 + 1;
    const later = await m.fetchFavicon(OWNER, "https://cache.fake.example/", { request: s.request, resolve: publicDns, now: clock });
    expect(later.cached).toBe(false);
    expect(s.calls).toHaveLength(6);
  });

  it("a stored entry whose upload is gone is ignored", async () => {
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: png(32, 32, 6) } });
    await m.fetchFavicon(OWNER, "https://gone.fake.example/", { request: s.request, resolve: publicDns });
    const { uploads } = await import("@/db/schema/uploads");
    m.core.db().delete(uploads).run();
    const r = await m.fetchFavicon(OWNER, "https://gone.fake.example/", { request: s.request, resolve: publicDns });
    expect(r.cached).toBe(false);
    expect(s.calls).toHaveLength(4);
  });
});

describe("fetchFavicon: refusals and their sentences", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
    m.resetFaviconLimits();
  });

  it("refuses bad addresses before any request", async () => {
    const s = scripted({});
    const cases: [unknown, string][] = [["", M.typeAddress], [42, M.typeAddress], ["   ", M.typeAddress], ["ftp://fake.example/", M.scheme], ["javascript:alert(1)", M.scheme], ["https://user:pw@fake.example/", M.credentials], [`https://fake.example/${"a".repeat(2100)}`, M.tooLong], ["http://", M.typeAddress]];
    for (const [url, msg] of cases) await expect(m.fetchFavicon(OWNER, url, { request: s.request, resolve: publicDns }), String(url)).rejects.toMatchObject({ message: msg, status: 400 });
    expect(s.calls).toHaveLength(0);
  });

  it("viewers and guests are refused; members and agents with edit may fetch", async () => {
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: png(16, 16, 8) } });
    await expect(m.fetchFavicon(VIEWER, "https://v.fake.example/", { request: s.request, resolve: publicDns })).rejects.toMatchObject({ message: M.forbidden, status: 403 });
    await expect(m.fetchFavicon({ kind: "guest", guestLinkId: "g1", appId: "a1", label: "FAKE", via: "guest-link" }, "https://v.fake.example/", { request: s.request, resolve: publicDns })).rejects.toMatchObject({ status: 403 });
    expect(s.calls).toHaveLength(0);
    await expect(m.fetchFavicon(MEMBER, "https://v.fake.example/", { request: s.request, resolve: publicDns })).resolves.toMatchObject({ cached: false });
  });

  it("link-local and metadata addresses are refused with the sentence, before any socket (real egress engine)", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[::ffff:169.254.169.254]/", "http://[fe80::1]/", "http://[fd00:ec2::254]/", "http://169.254.0.1:8080/", "http://[64:ff9b::a9fe:a9fe]/"]) {
      await expect(m.fetchFavicon(OWNER, url), url).rejects.toMatchObject({ message: M.refused, status: 403, code: "favicon_refused" });
    }
  });

  it("refuses Alibaba Cloud's metadata address by name or number", async () => {
    await expect(m.fetchFavicon(OWNER, "http://100.100.100.200/latest/meta-data/")).rejects.toMatchObject({ message: M.refused });
    await expect(m.fetchFavicon(OWNER, "http://meta.fake.example/", { request: scripted({}).request, resolve: async () => [{ address: "100.100.100.200" }] })).rejects.toMatchObject({ message: M.refused });
  });

  it("a self-signed certificate: refused in words for a public site; for a LAN site only that host is read again without the check", async () => {
    const tls = () => m.errors.hostError("tls", "The service's certificate could not be verified.");
    const pubCalls: SafeRequest[] = [];
    await expect(m.fetchFavicon(OWNER, "https://selfsigned.fake.example/", { request: async (r) => { pubCalls.push(r); throw tls(); }, resolve: publicDns })).rejects.toMatchObject({ message: M.certificate });
    expect(pubCalls.every((c) => c.verifyTls === true)).toBe(true);
    const site = scripted({ "/": { body: HTML(`<link rel="icon" href="https://cdn.fake.example/i.png"><link rel="icon" href="/own.png">`) }, "/own.png": { type: "image/png", body: png(16, 16, 14) } });
    const lanCalls: SafeRequest[] = [];
    const request = async (r: SafeRequest) => {
      lanCalls.push(r);
      if (r.verifyTls && new URL(r.url).hostname === "pve.fake.lan") throw tls();
      if (new URL(r.url).hostname === "cdn.fake.example") throw tls();
      return site.request(r);
    };
    const r = await m.fetchFavicon(OWNER, "https://pve.fake.lan:8006/", { request, resolve: lanDns });
    expect(r.cached).toBe(false);
    expect(lanCalls.map((c) => [new URL(c.url).host + new URL(c.url).pathname, c.verifyTls])).toEqual([
      ["pve.fake.lan:8006/", true],
      ["pve.fake.lan:8006/", false],
      ["cdn.fake.example/i.png", true],
      ["pve.fake.lan:8006/own.png", false],
    ]);
  });

  it("maps every egress failure to its sentence", async () => {
    const { hostError, BLOCKED_ADDRESS_MESSAGE } = m.errors;
    const cases: [Error, string][] = [
      [hostError("permission", BLOCKED_ADDRESS_MESSAGE), M.refused],
      [hostError("permission", `${m.req.PRIVATE_WRITE_MESSAGE}.`), M.privateFromPublic],
      [hostError("timeout", "The service did not answer within 5 seconds."), M.timeout],
      [hostError("tls", "The service's certificate could not be verified."), M.certificate],
      [hostError("bad_response", "The service redirected too many times."), M.redirects],
      [hostError("unreachable", "That host name could not be found."), M.unreachable],
    ];
    for (const [err, msg] of cases) {
      const request = async () => {
        throw err;
      };
      await expect(m.fetchFavicon(OWNER, `https://${Math.random().toString(36).slice(2)}.fake.example/`, { request, resolve: publicDns })).rejects.toMatchObject({ message: msg });
    }
  });

  it("an icon address that is refused wins over 'no icon', so a blocked hop is never hidden", async () => {
    const s = scripted({ "/": { body: HTML(`<link rel="icon" href="http://169.254.169.254/i.png">`) } });
    const request = async (r: SafeRequest) => {
      if (new URL(r.url).hostname === "169.254.169.254") throw m.errors.hostError("permission", m.errors.BLOCKED_ADDRESS_MESSAGE);
      return s.request(r);
    };
    await expect(m.fetchFavicon(OWNER, "https://hop.fake.example/", { request, resolve: publicDns })).rejects.toMatchObject({ message: M.refused });
  });

  it("a public website's requests are marked public-only (private hops refused); a LAN address's are not", async () => {
    const site = { "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: png(16, 16, 12) } };
    const pub = scripted(site);
    await m.fetchFavicon(OWNER, "https://public.fake.example/", { request: pub.request, resolve: publicDns });
    for (const c of pub.calls) {
      expect(c.headers?.["x-atrium-favicon"]).toBe("public-only");
      expect(c.userShaped).toEqual({ trustedHeaders: [] });
    }
    const lan = scripted(site);
    await m.fetchFavicon(OWNER, "http://nas.fake.lan/", { request: lan.request, resolve: lanDns });
    for (const c of lan.calls) {
      expect(c.headers?.["x-atrium-favicon"]).toBeUndefined();
      expect(c.userShaped).toBeUndefined();
    }
  });

  it("limits fetches to 30 a minute per person; cache answers do not count", async () => {
    const s = scripted({ "/": { body: HTML("") } });
    for (let i = 0; i < 30; i++) await m.fetchFavicon(OWNER, `https://r${i}.fake.example/`, { request: s.request, resolve: publicDns }).catch(() => undefined);
    await expect(m.fetchFavicon(OWNER, "https://r31.fake.example/", { request: s.request, resolve: publicDns })).rejects.toMatchObject({ message: M.rateLimited, status: 429 });
    await expect(m.fetchFavicon(MEMBER, "https://r31.fake.example/", { request: s.request, resolve: publicDns })).rejects.toMatchObject({ message: M.none });
  });

  it("with no scheme typed, https is tried first, then http when https cannot connect", async () => {
    const calls: string[] = [];
    const ok = scripted({ "/": { body: HTML(`<link rel="icon" href="/i.png">`) }, "/i.png": { type: "image/png", body: png(16, 16, 13) } });
    const request = async (r: SafeRequest) => {
      calls.push(r.url);
      if (r.url.startsWith("https:")) throw m.errors.hostError("unreachable", "The host refused the connection.");
      return ok.request(r);
    };
    const r = await m.fetchFavicon(OWNER, "nas.fake.lan:5000", { request, resolve: lanDns });
    expect(r.cached).toBe(false);
    expect(calls[0]).toBe("https://nas.fake.lan:5000/");
    expect(calls[1]).toBe("http://nas.fake.lan:5000/");
    // Stored under the origin that worked; asking again with no scheme finds it.
    const again = await m.fetchFavicon(OWNER, "nas.fake.lan:5000", { request, resolve: lanDns });
    expect(again.cached).toBe(true);
  });
});

// ---- The real egress engine against a stand-in on loopback ----

describe("fetchFavicon through safeRequest with a loopback stand-in", () => {
  let server: Server;
  let origin = "";
  const hits: string[] = [];
  beforeAll(async () => {
    const icon = png(24, 24, 21);
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(HTML(`<link rel="icon" href="/hop">`));
      if (req.url === "/hop") return res.writeHead(302, { location: "/real.png" }).end();
      if (req.url === "/real.png") return res.writeHead(200, { "content-type": "image/png" }).end(icon);
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/to-metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      if (req.url === "/slow") return; // never answers
      res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  });

  it("refuses a redirect to metadata, stops after 3 redirects, gives up at 5 s, and follows checked redirects to the icon", async () => {
    const m = await boot();
    m.resetFaviconLimits();
    // Failures are never stored, so every call below reaches the stand-in until the last one succeeds.
    await expect(m.fetchFavicon(OWNER, `${origin}/to-metadata`)).rejects.toMatchObject({ message: M.refused });
    await expect(m.fetchFavicon(OWNER, `${origin}/loop`)).rejects.toMatchObject({ message: M.redirects });
    expect(hits.filter((h) => h === "/loop")).toHaveLength(4);
    const t0 = Date.now();
    await expect(m.fetchFavicon(OWNER, `${origin}/slow`)).rejects.toMatchObject({ message: M.timeout, status: 504 });
    expect(Date.now() - t0).toBeLessThan(6_500);
    expect(Date.now() - t0).toBeGreaterThan(4_500);
    hits.length = 0;
    const r = await m.fetchFavicon(OWNER, origin);
    expect(r.path).toMatch(/\.png$/);
    expect(hits).toEqual(["/", "/hop", "/real.png"]);
  }, 20_000);
});

