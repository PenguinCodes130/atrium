// Fake services the Atrium server under test reaches on 127.0.0.1 (loopback is allowed). They answer
// in each product's documented format. Test-only tokens; none are real credentials.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { createServer as createTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export const FAKE = {
  npmGood: "atrium-v10-FAKE-npm-token-2f1c9e77a0b4",
  npmWrong: "atrium-v10-FAKE-wrong-npm-token-8d2e",
  curlBearer: "atrium-v10-FAKE-curl-bearer-6b3a91c5d7e2",
  proxmox: "root@pam!atrium=atrium-v10-FAKE-pve-0000-1111",
  ha: "atrium-v10-FAKE-ha-token-1c6f3e0a9b2d",
};
export const ALL_FAKE_SECRETS = Object.values(FAKE);

type H = (req: IncomingMessage, res: ServerResponse) => void;
export type Fake = { url: string; port: number; close: () => Promise<void>; hits: { method: string; url: string }[] };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function serve(h: H): Promise<Fake> {
  const hits: Fake["hits"] = [];
  const s = createServer((req, res) => { hits.push({ method: req.method ?? "", url: req.url ?? "" }); h(req, res); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, hits, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

export const fakeNpm = () =>
  serve((req, res) => {
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><title>Nginx Proxy Manager</title></html>"); }
    if (req.url === "/api/") return json(res, 200, { status: "OK", setup: true, version: { major: 2, minor: 12, revision: 6 } });
    if (req.headers.authorization !== `Bearer ${FAKE.npmGood}`) return json(res, 401, { error: { code: 401, message: "Invalid token" } });
    if (req.url === "/api/users/me") return json(res, 200, { id: 1, email: "admin@example.com" });
    if (req.url === "/api/nginx/proxy-hosts") return json(res, 200, [{ id: 1, domain_names: ["grafana.home.example"], forward_scheme: "http", forward_host: "10.0.0.7", forward_port: 3000, enabled: 1, certificate_id: 2, ssl_forced: 1 }]);
    if (req.url === "/api/nginx/certificates") return json(res, 200, [{ id: 2, nice_name: "home.example", provider: "letsencrypt", domain_names: ["*.home.example"], expires_on: "2026-12-20 08:15:00" }]);
    json(res, 404, {});
  });

export const fakeDocker = () =>
  serve((req, res) => {
    if (req.method !== "GET") return json(res, 405, { message: "read-only proxy" });
    if (req.url === "/version") return json(res, 200, { Version: "29.7.2", ApiVersion: "1.55" });
    if (req.url?.startsWith("/containers/json")) return json(res, 200, [
      { Id: "a", Names: ["/prometheus"], Image: "prom/prometheus:v3.14.0", State: "running", Status: "Up 3 days" },
      { Id: "b", Names: ["/grafana"], Image: "grafana/grafana:12", State: "running", Status: "Up 3 days" },
      { Id: "c", Names: ["/backup"], Image: "restic/restic", State: "exited", Status: "Exited (0) 5 hours ago" },
    ]);
    json(res, 404, {});
  });

export type HomeApi = Fake & { setDown: (down: boolean) => void };
export async function fakeHomeApi(): Promise<HomeApi> {
  let down = false;
  const f = await serve((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (down) return json(res, 503, { error: "maintenance" });
    if (u.pathname === "/openapi.json") {
      return json(res, 200, { openapi: "3.0.0", info: { title: "Home Box" }, paths: { "/api/stats": { get: { summary: "Box stats", responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { load: { type: "number" } } } } } } } } }, "/api/history": { get: { summary: "Load history", responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } } } } } });
    }
    if (u.pathname === "/api/open") return json(res, 200, { load: 0.7, disks: [{ dev: "sda", used: 61 }, { dev: "sdb", used: 18 }] });
    if (u.pathname === "/api/redir") { res.writeHead(302, { location: u.searchParams.get("to") ?? "/" }); return res.end(); }
    if (u.pathname === "/api/bad") return json(res, 400, { error: true, reason: "Latitude must be in range of -90 to 90°. Given: 900.0." });
    if (u.pathname === "/api/stats") {
      if (req.headers.authorization !== `Bearer ${FAKE.curlBearer}`) return json(res, 401, { error: "token required" });
      return json(res, 200, { host: "box", load: 0.42, uptimeSec: 86400, history: [{ t: "2026-10-17T10:00:00Z", v: 0.3 }, { t: "2026-10-17T10:05:00Z", v: 0.5 }, { t: "2026-10-17T10:10:00Z", v: 0.42 }], notes: "n".repeat(3000), seenAuth: req.headers.authorization });
    }
    json(res, 404, { error: "not found" });
  });
  return { ...f, setDown: (d: boolean) => { down = d; } };
}

export async function fakePlain(): Promise<Fake> {
  return serve((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>my little app</body></html>"); });
}

export async function blackhole(): Promise<Fake> {
  const sockets = new Set<Socket>();
  const s = createTcp((c) => { sockets.add(c); c.on("error", () => undefined); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, hits: [], close: () => new Promise((r) => { for (const c of sockets) c.destroy(); s.close(() => r()); }) };
}

export async function selfSigned(): Promise<Fake> {
  const dir = mkdtempSync(path.join(tmpdir(), "atrium-e2e-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const s = createHttps({ key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) }, (_q, res) => json(res, 200, { data: { version: "9.0.10" } }));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `https://127.0.0.1:${port}`, port, hits: [], close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

/** A stand-in attacker host for the security replays: records every request with its headers. */
export type Recorder = Fake & { seen: { method: string; url: string; headers: IncomingMessage["headers"] }[] };
export async function fakeRecorder(): Promise<Recorder> {
  const seen: Recorder["seen"] = [];
  const f = await serve((req, res) => { seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers }); json(res, 200, { server: "B" }); });
  return { ...f, seen };
}

/**
 * A fake Home Assistant (round 3). Never a real one. Answers /api/ with 401 without a token, names
 * itself in /manifest.json, and records every service call; light.lamp flips on toggle.
 */
export type FakeHa = Fake & { services: { method: string; path: string; body: unknown }[]; lamp: { on: boolean } };
export async function fakeHa(): Promise<FakeHa> {
  const services: FakeHa["services"] = [];
  const lamp = { on: false };
  const f = await serve((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/manifest.json") return json(res, 200, { name: "Home Assistant", short_name: "Assistant" });
      if (req.headers.authorization !== `Bearer ${FAKE.ha}`) return json(res, 401, { message: "401: Unauthorized" });
      if (u.pathname === "/api/config") return json(res, 200, { version: "2026.10.1", location_name: "Home" });
      if (u.pathname === "/api/states") return json(res, 200, [
        { entity_id: "light.lamp", state: lamp.on ? "on" : "off", attributes: { friendly_name: "Bedroom lamp" } },
        { entity_id: "switch.fan", state: "off", attributes: { friendly_name: "Fan plug" } },
      ]);
      const m = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(u.pathname);
      if (m && req.method === "POST") {
        const body = raw ? JSON.parse(raw) : null;
        services.push({ method: req.method, path: u.pathname, body });
        if (body?.entity_id === "light.lamp" && m[2] === "toggle") lamp.on = !lamp.on;
        return json(res, 200, []);
      }
      json(res, 404, { message: "not found" });
    });
  });
  return { ...f, services, lamp };
}
