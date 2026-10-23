import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detect } from "../detect";
import { cutUtf8, DOCS_MAX_BYTES, htmlToText, lookupDocs } from "../docs";
import { OFFICIAL_PACKAGES } from "../official";
import { buildRegistry, galleryOrder } from "../registry";
import { runTry } from "../try-it";
import { httpServer, json, redirect } from "../host/__tests__/servers";

const packages = galleryOrder(buildRegistry(OFFICIAL_PACKAGES, [], { record: () => false, resolveOthers: () => {} }, () => {}));
const SPEC = {
  openapi: "3.0.0", info: { title: "Home API" },
  paths: {
    "/api/status": { get: { summary: "Current status", responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { load: { type: "number" } } } } } } } } },
    "/api/disks": { get: { summary: "Disks", parameters: [{ name: "pool", in: "query", schema: { type: "string" } }], responses: { "200": { content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { name: { type: "string" }, used: { type: "number" } } } } } } } } } },
    "/api/reboot": { post: { summary: "Reboot" } },
  },
};
const TOKEN = "atr-test-FAKE-bearer-9f8e7d6c5b4a";
let fakeProm: Awaited<ReturnType<typeof httpServer>>;
let api: Awaited<ReturnType<typeof httpServer>>;
let plain: Awaited<ReturnType<typeof httpServer>>;
let fakeHa: Awaited<ReturnType<typeof httpServer>>;
let notHa: Awaited<ReturnType<typeof httpServer>>;

beforeAll(async () => {
  fakeProm = await httpServer((req, res) => (req.url === "/-/healthy" ? (res.writeHead(200), res.end("Prometheus Server is Healthy.\n")) : redirect(res, "/query")));
  api = await httpServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/openapi.json") return json(res, 200, SPEC);
    if (u.pathname === "/echo") return json(res, 200, { auth: req.headers.authorization, nested: { deep: [{ v: 1 }] }, long: "z".repeat(5000) });
    if (u.pathname === "/stats") return json(res, 200, { load: 0.5, points: [{ t: 1, v: 2 }] });
    if (u.pathname === "/meta") return redirect(res, "http://169.254.169.254/latest/meta-data/iam");
    if (u.pathname === "/docs") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<html><head><title>My Docs</title><script>var x=1</script></head><body><h1>API</h1><p>${"word ".repeat(10000)}</p></body></html>`); return; }
    json(res, 404, {});
  });
  plain = await httpServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>my little app</html>"); });
  // Home Assistant: the manifest names it and /api/ answers 401 without a token.
  fakeHa = await httpServer((req, res) => {
    if (req.url === "/manifest.json") return json(res, 200, { name: "Home Assistant", short_name: "Assistant" });
    if (req.url === "/api/") return json(res, 401, { message: "401: Unauthorized" });
    json(res, 404, {});
  });
  // A page that copies the manifest but whose /api/ is open is not offered.
  notHa = await httpServer((req, res) => {
    if (req.url === "/manifest.json") return json(res, 200, { name: "Home Assistant" });
    if (req.url === "/api/") return json(res, 200, { message: "API running." });
    json(res, 404, {});
  });
});
afterAll(async () => { await fakeProm.close(); await api.close(); await plain.close(); await fakeHa.close(); await notHa.close(); });

describe("detection", () => {
  it("matches Prometheus by its probe", async () => {
    const r = await detect(fakeProm.url, packages);
    expect(r.matches).toEqual(["prometheus"]);
  });
  it("shows a found OpenAPI spec as its reads (GET only, headline first) with path and suggested shape", async () => {
    const r = await detect(api.url, packages);
    expect(r.matches).toEqual([]);
    // Wave 2.8 spec import v2: only GET calls become reads; POST /api/reboot is a change, never a read.
    expect(r.openapi).toEqual([
      { method: "GET", path: "/api/status", summary: "Current status", suggestedShape: "stat" },
      { method: "GET", path: "/api/disks", summary: "Disks", params: { type: "object", properties: { pool: { type: "string", title: "Pool" } }, required: [], additionalProperties: false }, suggestedShape: "table" },
    ]);
    expect(r.openapiUrl).toBe(`${api.url}/openapi.json`);
  });
  it("offers Home Assistant when /manifest.json names it and /api/ answers 401", async () => {
    const r = await detect(fakeHa.url, packages);
    expect(r.matches).toEqual(["home-assistant"]);
    expect(fakeHa.seen.some((s) => s.url === "/api/" && !s.headers.authorization)).toBe(true);
  });
  it("does not offer Home Assistant when /api/ does not answer 401", async () => {
    const r = await detect(notHa.url, packages);
    expect(r.matches).toEqual([]);
  });
  it("finds nothing on a plain page", async () => {
    const r = await detect(plain.url, packages);
    expect(r).toMatchObject({ matches: [] });
    expect(r.openapi).toBeUndefined();
  });
  it.each(["http://169.254.169.254/", "http://[fe80::1]:8080/", "http://[fd00:ec2::254]/"])("refuses %s", async (u) => {
    await expect(detect(u, packages)).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });
  it("refuses a URL that redirects to the metadata address", async () => {
    await expect(detect(`${api.url}/meta`, packages)).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });
});

describe("docs lookup", () => {
  it("returns title and text cut to at most 20 KB", async () => {
    const r = await lookupDocs(`${api.url}/docs`);
    expect(r.title).toBe("My Docs");
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(DOCS_MAX_BYTES);
    expect(r.text).not.toContain("var x");
  });
  it("returns endpoints from an OpenAPI URL", async () => {
    const r = await lookupDocs(`${api.url}/openapi.json`);
    expect(r).toMatchObject({ title: "Home API", endpoints: [{ path: "/api/status" }, { path: "/api/disks" }] });
  });
  it.each(["http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "http://[fd00:ec2::254]/"])("refuses %s", async (u) => {
    await expect(lookupDocs(u)).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });
  it("refuses a docs URL that redirects to the metadata address", async () => {
    await expect(lookupDocs(`${api.url}/meta`)).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });
  it("cuts on a UTF-8 boundary", () => {
    expect(new TextEncoder().encode(cutUtf8("é".repeat(20_000), DOCS_MAX_BYTES)).length).toBeLessThanOrEqual(DOCS_MAX_BYTES);
    expect(htmlToText("<p>a&amp;b</p>").text).toBe("a&b");
  });
});

describe("Try it", () => {
  it("parses curl with a bearer token, holds the token server side and never returns it", async () => {
    const r = await runTry({ curl: `curl ${api.url}/echo -H 'Authorization: Bearer ${TOKEN}'` }, "user-1");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    if (r.ok) {
      expect(r.secretFields).toEqual([{ key: "token", label: "Bearer token", hint: expect.any(String), auth: { as: "bearer" } }]);
      expect(r.pendingId).toMatch(/^ps_/);
      expect(r.redactedCurl).toContain("<secret: Bearer token>");
      // The service echoed the header back; it is scrubbed.
      expect(JSON.stringify(r.tree)).toContain("[secret]");
      const long = (r.tree as { children: { key: string; truncated?: boolean }[] }).children.find((c) => c.key === "long");
      expect(long?.truncated).toBe(true);
      // Re-running with the held id sends the token again, still without returning it.
      const again = await runTry({ url: `${api.url}/echo`, auth: { pendingId: r.pendingId! } }, "user-1");
      expect(JSON.stringify(again)).not.toContain(TOKEN);
      expect(again.ok && JSON.stringify(again.tree)).toContain("[secret]");
      // Another user cannot use the held token.
      const other = await runTry({ url: `${api.url}/echo`, auth: { pendingId: r.pendingId! } }, "user-2");
      expect(other.ok && JSON.stringify(other.tree)).not.toContain("[secret]");
    }
  });
  it("refuses to send held credentials to a different host", async () => {
    const r = await runTry({ curl: `curl ${api.url}/echo -H 'Authorization: Bearer ${TOKEN}'` }, "user-3");
    const moved = await runTry({ url: `${plain.url}/`, auth: { pendingId: r.ok ? r.pendingId! : "" } }, "user-3");
    expect(moved).toMatchObject({ ok: false, error: { code: "permission" } });
  });
  it.each(["http://169.254.169.254/", "http://[fe80::1]/", "http://[fd00:ec2::254]/"])("refuses %s", async (u) => {
    expect(await runTry({ url: u }, "u")).toMatchObject({ ok: false, error: { code: "permission", message: "This integration is not allowed to reach that address" } });
  });
  it("refuses a redirect to the metadata address", async () => {
    expect(await runTry({ url: `${api.url}/meta` }, "u")).toMatchObject({ ok: false, error: { code: "permission" } });
  });
  it("gives friendly errors with the request kept", async () => {
    expect(await runTry({ url: `${api.url}/missing` }, "u")).toMatchObject({ ok: false, error: { code: "bad_response" }, request: { url: `${api.url}/missing` } });
    expect(await runTry({ curl: "curl -X DELETE http://a.lan/x" }, "u")).toMatchObject({ ok: false, error: { code: "config" } });
  });
});
