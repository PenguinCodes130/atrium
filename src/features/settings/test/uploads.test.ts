// settings round 1: uploads (type from bytes, SVG sanitising, limits, guest access) and the image proxy.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER, OWNER, VIEWER, doc, fakePort, freshDataDir, useInstance } from "./harness";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d3b5f00000000049454e44ae426082", "hex");
const woff2 = (size: number) => { const b = Buffer.alloc(size, 1); b.write("wOF2", 0, "ascii"); return b; };
const SVG_EVIL = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)" viewBox="0 0 10 10">
<script>alert(2)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
<image href="https://evil.example/x.png"/><use xlink:href="other.svg#a"/><use href="#ok"/>
<rect id="ok" width="10" height="10" fill="url(https://evil.example/p)" onclick="x()"/><circle r="2" fill="url(#g)" style="fill:red"/><a href="javascript:alert(3)"><text>t</text></a></svg>`;

async function boot() {
  vi.resetModules();
  useInstance(freshDataDir());
  return {
    store: await import("@/features/uploads/store"),
    sign: await import("@/features/uploads/sign"),
    proxy: await import("@/features/uploads/proxy"),
    port: await import("@/features/settings/app-port"),
  };
}

describe("type checks and SVG sanitising (AC 32, 33)", () => {
  it("knows rasters, woff2 and SVG from the bytes and refuses HTML, even named .png", async () => {
    const { sniff } = await import("@/features/uploads/sniff");
    expect(sniff(PNG)?.mime).toBe("image/png");
    expect(sniff(woff2(100))?.mime).toBe("font/woff2");
    expect(sniff(woff2(100), "image")).toBeNull();
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.mime).toBe("image/svg+xml");
    expect(sniff(Buffer.from("<!doctype html><html><body>hi</body></html>"))).toBeNull();
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><html><body>x</body></html></foreignObject></svg>'))).toBeNull();
    expect(sniff(Buffer.from("GIF89a......"))?.mime).toBe("image/gif");
    expect(sniff(Buffer.from("just text"))).toBeNull();
  });
  it("removes scripts, handlers, foreignObject and external references", async () => {
    const { sanitiseSvg } = await import("@/features/uploads/svg");
    const r = sanitiseSvg(SVG_EVIL)!;
    expect(r.svg).not.toMatch(/script|onload|onclick|foreignObject|evil\.example|other\.svg|javascript|ENTITY|boom/i);
    expect(r.svg).toContain('<use href="#ok"/>');
    expect(r.svg).toContain('fill="url(#g)"');
    expect(r.removed.scripts).toBe(1);
    expect(r.removed.handlers).toBe(2);
    expect(r.removed.foreignObjects).toBe(1);
    expect(r.removed.externalRefs).toBeGreaterThanOrEqual(2);
    expect(sanitiseSvg("<svg><rect")).toBeNull();
  });
});

describe("upload store (AC 16, 32, 34)", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });
  it("refuses a 3 MB woff2, a font that is not woff2, HTML named .png, and viewers", () => {
    expect(() => m.store.saveUpload(OWNER, woff2(3 * 1024 * 1024), "big.woff2", "font")).toThrow(/Fonts can be at most 2 MB/);
    expect(() => m.store.saveUpload(OWNER, PNG, "x.woff2", "font")).toThrow(/not a woff2 font/);
    expect(() => m.store.saveUpload(OWNER, Buffer.from("<html><body>x</body></html>"), "x.png", "image")).toThrow("This file type is not allowed");
    expect(() => m.store.saveUpload(VIEWER, PNG, "x.png", "image")).toThrow(/owners and members/);
    expect(() => m.store.saveUpload(OWNER, Buffer.alloc(11 * 1024 * 1024, 0x89).fill(PNG, 0, PNG.length), "big.png", "image")).toThrow(/at most 10 MB/);
  });
  it("stores a sanitised SVG and a PNG, served from /uploads/", () => {
    const s = m.store.saveUpload(MEMBER, Buffer.from(SVG_EVIL), "logo.svg", "image");
    expect(s.path).toMatch(/^\/uploads\/[a-z0-9]{20}\.svg$/);
    expect(s.svgRemoved).toBeGreaterThan(3);
    const back = m.store.readUpload(s.path.slice(9))!;
    expect(back.bytes.toString()).not.toMatch(/script|onload/);
    const p = m.store.saveUpload(OWNER, PNG, "dot.png", "image");
    expect(m.store.readUpload(p.path.slice(9))!.mime).toBe("image/png");
    expect(m.store.readUpload("../atrium.db")).toBeNull();
  });
  it("a guest may open only files the app's published version references", async () => {
    const a = m.store.saveUpload(OWNER, PNG, "a.png", "image");
    const b = m.store.saveUpload(OWNER, Buffer.concat([PNG, Buffer.from([0])]), "b.png", "image");
    const pub = doc({ themeId: "control-room" });
    pub.app.icon = a.path;
    const draft = doc({ themeId: "control-room" });
    draft.app.icon = b.path;
    m.port.registerAppPort(fakePort([{ appId: "a1", name: "Guest room", draft, published: pub }, { appId: "a2", name: "Other", draft: doc({ themeId: "dusk" }), published: draft }]).port);
    expect(await m.store.guestMayOpen("a1", a.path.slice(9))).toBe(true);
    expect(await m.store.guestMayOpen("a1", b.path.slice(9))).toBe(false); // only the draft or another app
  });
});

describe("image proxy (AC 35)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/ok.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); }
      else if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); }
      else if (req.url === "/lie.png") { res.writeHead(200, { "content-type": "image/png" }); res.end("<html></html>"); }
      else if (req.url === "/big.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)])); }
      else if (req.url === "/meta") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }); res.end(); }
      else if (req.url === "/x.svg") { res.writeHead(200, { "content-type": "image/svg+xml" }); res.end(SVG_EVIL); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  let m: Awaited<ReturnType<typeof boot>>;
  beforeEach(async () => {
    m = await boot();
  });

  it("signs only allowed addresses and verifies in constant time", () => {
    // r2: a scope is required (item 3); without one nothing is signed.
    expect(m.sign.signImageUrl(`${base}/ok.png`)).toBeNull();
    const scope = { appId: "app1", access: "guest" } as const;
    const s = m.sign.signImageUrl(`${base}/ok.png`, scope)!;
    expect(s).toMatch(/^\/api\/img\?u=.+&a=app1&v=g&n=d&e=\d+&s=[A-Za-z0-9_-]{43}$/);
    expect(m.sign.verifyImageSignature(s)).toBe(true);
    expect(m.sign.verifyImageSignature(s.replace(encodeURIComponent(`${base}/ok.png`), encodeURIComponent(`${base}/other.png`)))).toBe(false);
    const sig = new URLSearchParams(s.split("?")[1]).get("s")!;
    expect(m.sign.verifyImageSignature(s.replace(sig, `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`))).toBe(false);
    expect(m.sign.verifyImageSignature(null)).toBe(false);
    expect(m.sign.signImageUrl("http://169.254.169.254/latest", scope)).toBeNull();
    expect(m.sign.signImageUrl("http://[fe80::1]/x.png", scope)).toBeNull();
    expect(m.sign.signImageUrl("javascript:alert(1)", scope)).toBeNull();
    expect(m.sign.signImageUrl("http://user:pw@example.com/x.png", scope)).toBeNull();
  });
  it("fetches an image, refuses non-images, lies, 6 MB, and link-local at every hop; sanitises SVG; caches", async () => {
    const ok = await m.proxy.fetchImage(`${base}/ok.png`);
    expect(ok.mime).toBe("image/png");
    expect((await m.proxy.fetchImage(`${base}/ok.png`)).cached).toBe(true);
    await expect(m.proxy.fetchImage(`${base}/page`)).rejects.toThrow(/did not answer with an image/);
    await expect(m.proxy.fetchImage(`${base}/lie.png`)).rejects.toThrow(/did not answer with an image/);
    await expect(m.proxy.fetchImage(`${base}/big.png`)).rejects.toThrow(/larger than 5 MB/);
    await expect(m.proxy.fetchImage(`${base}/meta`)).rejects.toThrow(/not allowed/);
    await expect(m.proxy.fetchImage("http://169.254.169.254/latest")).rejects.toThrow(/not allowed/);
    const svg = await m.proxy.fetchImage(`${base}/x.svg`);
    expect(svg.bytes.toString()).not.toMatch(/script|onload|evil/);
  });
});
