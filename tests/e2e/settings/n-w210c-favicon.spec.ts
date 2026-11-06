// Wave 2.10c, builder S: N4 server half (operator-tryout-spec.md section 5 N4, criterion 23; architecture
// A11.6). POST /api/settings/uploads/favicon fetches a website's icon ON THE SERVER through the
// integration egress engine and stores it as an image upload. Every website here is a FAKE stand-in
// served by this test on loopback (allowed, as for integrations); link-local and metadata addresses are
// refused before any socket opens, so nothing here leaves this machine. The browser's network log
// proves the browser itself never asks the website for anything. Test-only values; none are real.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MEMBER, OWNER, ORIGIN, VIEWER, addUser, captureTraffic, context, db, ev, shot } from "./helpers";

test.setTimeout(120_000);

const ROUTE = "/api/settings/uploads/favicon";
const RUN = Date.now() % 100000;

/** A solid-colour RGBA PNG of `w` x `h` (the colour carries the run number, so each run's bytes are new). */
function png(w: number, h: number, seed: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) row.set([(seed >> 8) & 0xff, seed & 0xff, (x * 7) & 0xff, 255], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A one-entry ICO holding a 16 x 16, 32 bpp BMP (the classic favicon.ico shape). */
function ico32(seed: number): Buffer {
  const w = 16;
  const dib = Buffer.alloc(40 + w * w * 4 + w * 4);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(w, 4);
  dib.writeInt32LE(w * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  for (let i = 0; i < w * w; i++) dib.set([seed & 0xff, (seed >> 8) & 0xff, 200, 255], 40 + i * 4);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = w;
  head[7] = w;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(dib.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, dib]);
}

type Hit = { path: string; ua: string };
type StandIn = { url: string; hits: Hit[]; close: () => Promise<void> };

/** One FAKE website on loopback. `routes` maps a path to its answer. */
async function standIn(routes: Record<string, (res: ServerResponse) => void>): Promise<StandIn> {
  const hits: Hit[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const p = (req.url ?? "/").split("?")[0]!;
    hits.push({ path: p, ua: String(req.headers["user-agent"] ?? "") });
    const r = routes[p];
    if (r) return r(res);
    res.writeHead(404, { "content-type": "text/plain" }).end("not here");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((ok) => server.close(() => ok())) };
}

const html = (body: string) => (res: ServerResponse) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>FAKE e2e site</title>${body}</head><body>FAKE</body></html>`);
const bytes = (type: string, b: Buffer) => (res: ServerResponse) => res.writeHead(200, { "content-type": type, "content-length": String(b.length) }).end(b);
const redirect = (to: string) => (res: ServerResponse) => res.writeHead(302, { location: to }).end();

async function post(req: APIRequestContext, url: string) {
  const r = await req.post(ROUTE, { data: { url }, headers: { origin: ORIGIN } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status(), body, source: r.headers()["x-atrium-favicon"] };
}

/** The upload row for a /uploads/ path, read straight from the slot's database. */
function uploadRow(p: string): { file: string; mime: string; kind: string; size: number } | undefined {
  const d = db();
  try {
    return d.prepare("SELECT file, mime, kind, size FROM upload WHERE file = ?").get(p.replace("/uploads/", "")) as never;
  } finally {
    d.close();
  }
}

function save(name: string, data: unknown) {
  writeFileSync(ev("pass", `${name}.json`), JSON.stringify(data, null, 2));
}

/** Every request the browser itself makes that leaves this Atrium. */
function foreignRequests(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) out.push(u);
  });
  return out;
}

test.describe("N4 favicon fetch (server half)", () => {
  test.beforeAll(async () => {
    await addUser(MEMBER.email, "member", MEMBER.password);
    await addUser(VIEWER.email, "viewer", VIEWER.password);
  });

  test("N4: From website stores the stand-in's icon as an upload and shows it; the browser never asks the site", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "once");
    const icon180 = png(180, 180, RUN);
    const site = await standIn({
      "/": html(`<link rel="mask-icon" href="/mask.svg" color="#000"><link rel="icon" href="/icons/small-16.png" sizes="16x16"><link rel="apple-touch-icon" href="/icons/apple-180.png"><link rel="icon" href="/icons/huge-512.png" sizes="512x512">`),
      "/icons/small-16.png": bytes("image/png", png(16, 16, RUN)),
      "/icons/apple-180.png": bytes("image/png", icon180),
      "/icons/huge-512.png": bytes("image/png", png(512, 512, RUN)),
    });
    const ctx = await context(browser, OWNER);
    const page = await ctx.newPage();
    const foreign = foreignRequests(page);
    captureTraffic(page, "n4-favicon");
    try {
      await page.goto("/settings/appearance");
      await page.waitForLoadState("networkidle");
      const answer = await page.evaluate(async ([route, url]) => {
        const r = await fetch(route!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
        return { status: r.status, body: await r.json(), source: r.headers.get("x-atrium-favicon") };
      }, [ROUTE, site.url]);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(Object.keys(answer.body).sort()).toEqual(["name", "path"]);
      expect(answer.body.path).toMatch(/^\/uploads\/[a-z0-9]{20}\.png$/);
      expect(answer.body.name).toBe("127.0.0.1 icon");
      expect(answer.source).toBe("fetched");
      // Stored as an image upload, with exactly the 180 px icon's bytes (the best raster at most 256 px).
      const row = uploadRow(answer.body.path);
      expect(row).toMatchObject({ mime: "image/png", kind: "image", size: icon180.length });
      // The server, not the browser, read the site: the page and the chosen icon, as Atrium.
      const paths = site.hits.map((h) => h.path);
      expect(paths).toContain("/");
      expect(paths).toContain("/icons/apple-180.png");
      expect(paths).not.toContain("/mask.svg");
      expect(site.hits.every((h) => h.ua.startsWith("Atrium/"))).toBe(true);
      // Shown before Use: the stored path draws from this Atrium.
      const drawn = await page.evaluate(async (src) => {
        const img = document.createElement("img");
        img.alt = "Fetched website icon";
        img.style.cssText = "position:fixed;top:16px;right:16px;width:96px;height:96px;z-index:9999;border:1px solid #888;background:#fff";
        img.src = src;
        document.body.appendChild(img);
        await img.decode();
        return { w: img.naturalWidth, h: img.naturalHeight };
      }, answer.body.path as string);
      expect(drawn).toEqual({ w: 180, h: 180 });
      await shot(page, "n4-fetched-icon-shown");
      // The same origin within 7 days answers the stored path without fetching.
      const before = site.hits.length;
      const again = await page.evaluate(async ([route, url]) => {
        const r = await fetch(route!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `${url}/some/other/page` }) });
        return { status: r.status, body: await r.json(), source: r.headers.get("x-atrium-favicon") };
      }, [ROUTE, site.url]);
      expect(again).toEqual({ status: 200, body: answer.body, source: "cached" });
      expect(site.hits.length).toBe(before);
      // Network log: nothing the browser asked for left this Atrium.
      expect(foreign).toEqual([]);
      save("n4-stored", { answer, again, row, siteHits: site.hits, browserForeignRequests: foreign });
    } finally {
      await ctx.close();
      await site.close();
    }
  });

  test("N4: link-local and metadata addresses are refused with a sentence, at every hop", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "once");
    const REFUSED = "Atrium will not fetch from that address. It is, or redirects to, a link-local or cloud metadata address.";
    const bounce = await standIn({ "/": redirect("http://169.254.169.254/latest/meta-data/") });
    const iconHop = await standIn({ "/": html(`<link rel="icon" href="http://169.254.169.254/favicon.png">`) });
    const ctx = await context(browser, OWNER);
    const page = await ctx.newPage();
    try {
      await page.goto("/settings/appearance");
      await page.waitForLoadState("networkidle");
      const results: Record<string, unknown> = {};
      for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[::ffff:169.254.169.254]/", "http://[fe80::1]/", "http://[fd00:ec2::254]/", bounce.url, iconHop.url]) {
        const r = await post(page.request, url);
        results[url] = r;
        expect(r.status, `${url}: ${JSON.stringify(r.body)}`).toBe(403);
        expect(r.body.error).toEqual({ code: "favicon_refused", message: REFUSED });
      }
      // The redirecting stand-in was asked once; nothing was sent onward.
      expect(bounce.hits.map((h) => h.path)).toEqual(["/"]);
      save("n4-refused", results);
    } finally {
      await ctx.close();
      await bounce.close();
      await iconHop.close();
    }
  });

  test("N4: viewers and signed-out callers are refused on the server; members may fetch", async ({ browser, playwright }, info) => {
    test.skip(info.project.name !== "desktop", "once");
    const site = await standIn({ "/": html(`<link rel="icon" href="/i.png">`), "/i.png": bytes("image/png", png(32, 32, RUN + 1)) });
    const out: Record<string, unknown> = {};
    try {
      const anon = await playwright.request.newContext({ baseURL: ORIGIN });
      const a = await post(anon, site.url);
      await anon.dispose();
      expect(a.status).toBe(401);
      out.signedOut = a;
      const vctx = await context(browser, VIEWER);
      const v = await post(vctx.request, site.url);
      await vctx.close();
      expect(v.status).toBe(403);
      expect(v.body.error.message).toBe("Only owners and members can fetch website icons. An agent also needs the atrium:edit scope.");
      out.viewer = v;
      // Neither refused caller made the server touch the site.
      expect(site.hits).toEqual([]);
      const mctx = await context(browser, MEMBER);
      const m = await post(mctx.request, site.url);
      await mctx.close();
      expect(m.status, JSON.stringify(m.body)).toBe(200);
      out.member = m;
      save("n4-access", out);
    } finally {
      await site.close();
    }
  });

  test("N4: an SVG icon is stored sanitised, an ICO becomes a PNG, and size caps answer in words", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "once");
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10" fill="#${(RUN % 0xffffff).toString(16).padStart(6, "0")}"/><image href="http://169.254.169.254/x.png"/></svg>`;
    const svgSite = await standIn({ "/": html(`<link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="icon" href="/x.png" sizes="32x32">`), "/icon.svg": bytes("image/svg+xml", Buffer.from(evil)) });
    const icoSite = await standIn({ "/": html(""), "/favicon.ico": bytes("image/x-icon", ico32(RUN)) });
    const bigSite = await standIn({ "/": html(`<link rel="icon" href="/big.png">`), "/big.png": bytes("image/png", Buffer.concat([png(64, 64, RUN), Buffer.alloc(1_200_000, 7)])) });
    const hugeOnly = await standIn({ "/": html(`<link rel="icon" href="/i512.png" sizes="512x512">`), "/i512.png": bytes("image/png", png(512, 512, RUN + 2)) });
    const noIcon = await standIn({ "/": html("") });
    const ctx = await context(browser, OWNER);
    const page = await ctx.newPage();
    const out: Record<string, unknown> = {};
    try {
      await page.goto("/settings/appearance");
      await page.waitForLoadState("networkidle");
      const s = await post(page.request, svgSite.url);
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body.path).toMatch(/\.svg$/);
      const served = await (await page.request.get(s.body.path)).text();
      expect(served).not.toMatch(/<script|onload|169\.254/i);
      expect(served).toContain("<rect");
      out.svg = { ...s, served };
      const i = await post(page.request, icoSite.url);
      expect(i.status, JSON.stringify(i.body)).toBe(200);
      expect(i.body.path).toMatch(/\.png$/);
      expect(uploadRow(i.body.path)).toMatchObject({ mime: "image/png", kind: "image" });
      out.ico = i;
      const b = await post(page.request, bigSite.url);
      expect(b.status).toBe(422);
      expect(b.body.error.message).toBe("That website's icon is larger than 1 MB. Pick one from the grid, or upload one.");
      out.big = b;
      const h = await post(page.request, hugeOnly.url);
      expect(h.status).toBe(422);
      expect(h.body.error.message).toBe("That website's icons are all larger than 256 px. Pick one from the grid, or upload one.");
      out.huge = h;
      const n = await post(page.request, noIcon.url);
      expect(n.status).toBe(422);
      expect(n.body.error.message).toBe("That website has no icon Atrium can use. Pick one from the grid, or upload one.");
      out.none = n;
      const bad = await post(page.request, "ftp://example.invalid/");
      expect(bad.body.error?.message).toBe("Only http and https addresses can be used.");
      out.badScheme = bad;
      save("n4-kinds-and-caps", out);
    } finally {
      await ctx.close();
      for (const x of [svgSite, icoSite, bigSite, hugeOnly, noIcon]) await x.close();
    }
  });
});
