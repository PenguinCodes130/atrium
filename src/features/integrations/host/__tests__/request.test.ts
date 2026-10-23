import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeRequest } from "../request";
import { blackhole, httpServer, json, redirect, selfSignedHttps } from "./servers";

let a: Awaited<ReturnType<typeof httpServer>>;
let b: Awaited<ReturnType<typeof httpServer>>;

beforeAll(async () => {
  b = await httpServer((req, res) => json(res, 200, { from: "b", path: req.url }));
  a = await httpServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const hops = Number(u.searchParams.get("hops") ?? 0);
    if (u.pathname === "/chain") return hops > 0 ? redirect(res, `/chain?hops=${hops - 1}`) : json(res, 200, { done: true });
    if (u.pathname === "/to-b") return redirect(res, `${b.url}/landed`);
    if (u.pathname === "/to-meta") return redirect(res, "http://169.254.169.254/latest/meta-data/");
    if (u.pathname === "/to-fe80") return redirect(res, "http://[fe80::1]/");
    if (u.pathname === "/to-ec2") return redirect(res, "http://[fd00:ec2::254]/");
    if (u.pathname === "/to-b-to-meta") return redirect(res, `${b.url}/x`);
    if (u.pathname === "/big") { res.writeHead(200); res.end("x".repeat(3 * 1024 * 1024)); return; }
    json(res, 200, { ok: true });
  });
});
afterAll(async () => { await a.close(); await b.close(); });

describe("safeRequest redirects", () => {
  it("follows up to 3 redirects within the same host for reads", async () => {
    const r = await safeRequest({ url: `${a.url}/chain?hops=3`, redirect: { mode: "same-host" } });
    expect(r.status).toBe(200);
    expect(r.redirects).toBe(3);
  });

  it("refuses a 4th redirect (reads and detection)", async () => {
    await expect(safeRequest({ url: `${a.url}/chain?hops=4`, redirect: { mode: "same-host" } })).rejects.toMatchObject({ adapterError: { code: "bad_response", message: expect.stringContaining("too many") } });
    await expect(safeRequest({ url: `${a.url}/chain?hops=4`, redirect: { mode: "checked" } })).rejects.toMatchObject({ adapterError: { message: expect.stringContaining("too many") } });
  });

  it("refuses a read redirected to a different host", async () => {
    await expect(safeRequest({ url: `${a.url}/to-b`, redirect: { mode: "same-host" } })).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });

  it("lets detection follow a redirect to another allowed host", async () => {
    const r = await safeRequest({ url: `${a.url}/to-b`, redirect: { mode: "checked" } });
    expect(JSON.parse(r.body.toString())).toMatchObject({ from: "b" });
  });

  it.each(["/to-meta", "/to-fe80", "/to-ec2"])("refuses a redirect hop to a blocked address (%s)", async (p) => {
    await expect(safeRequest({ url: `${a.url}${p}`, redirect: { mode: "checked" } })).rejects.toMatchObject({ adapterError: { code: "permission", message: "This integration is not allowed to reach that address" } });
  });

  it.each(["http://169.254.169.254/", "http://[fe80::1]/", "http://[fd00:ec2::254]/", "http://[::ffff:169.254.169.254]/"])("refuses a direct request to %s without connecting", async (url) => {
    await expect(safeRequest({ url, redirect: { mode: "checked" } })).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });

  it("refuses hosts outside the allow list", async () => {
    await expect(safeRequest({ url: `${a.url}/`, redirect: { mode: "same-host" }, allowedOrigins: ["http://10.77.99.7"] })).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });

  it("caps the body size", async () => {
    await expect(safeRequest({ url: `${a.url}/big`, redirect: { mode: "same-host" }, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ adapterError: { message: expect.stringContaining("too large") } });
  });
});

describe("safeRequest failures", () => {
  it("times out a host that never answers", async () => {
    const h = await blackhole();
    const start = Date.now();
    await expect(safeRequest({ url: h.url, redirect: { mode: "same-host" }, timeoutMs: 400 })).rejects.toMatchObject({ adapterError: { code: "timeout" } });
    expect(Date.now() - start).toBeLessThan(2000);
    await h.close();
  });

  it("uses a 10 second default timeout", async () => {
    const h = await blackhole();
    const start = Date.now();
    await expect(safeRequest({ url: h.url, redirect: { mode: "same-host" } })).rejects.toMatchObject({ adapterError: { code: "timeout", message: expect.stringContaining("10 seconds") } });
    const took = Date.now() - start;
    expect(took).toBeGreaterThanOrEqual(9_000);
    expect(took).toBeLessThanOrEqual(11_000);
    await h.close();
  }, 15_000);

  it("reports a refused port as unreachable", async () => {
    const h = await httpServer((_q, r) => r.end());
    const url = h.url;
    await h.close();
    await expect(safeRequest({ url, redirect: { mode: "same-host" } })).rejects.toMatchObject({ adapterError: { code: "unreachable" } });
  });

  it("reports a self-signed certificate as a certificate problem when verify TLS is on, and accepts it when off", async () => {
    const s = await selfSignedHttps((_q, res) => json(res, 200, { tls: true }));
    await expect(safeRequest({ url: s.url, redirect: { mode: "same-host" }, verifyTls: true })).rejects.toMatchObject({ adapterError: { code: "tls" } });
    const ok = await safeRequest({ url: s.url, redirect: { mode: "same-host" }, verifyTls: false });
    expect(ok.status).toBe(200);
    await s.close();
  });
});
