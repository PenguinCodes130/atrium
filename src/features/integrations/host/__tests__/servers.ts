// Local test servers (loopback is allowed by the address rules).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;
export type Seen = { method: string; url: string; headers: IncomingMessage["headers"] };

export async function httpServer(handler: Handler): Promise<{ url: string; port: number; seen: Seen[]; close: () => Promise<void>; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => { seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers }); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, seen, server, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export async function unixServer(handler: Handler): Promise<{ socketPath: string; seen: Seen[]; close: () => Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "atrium-sock-"));
  const socketPath = path.join(dir, "docker.sock");
  const seen: Seen[] = [];
  const server = createServer((req, res) => { seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers }); handler(req, res); });
  await new Promise<void>((r) => server.listen(socketPath, () => r()));
  return { socketPath, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Accepts TCP connections and never answers. */
export async function blackhole(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>();
  const server: TcpServer = createTcp((s) => { sockets.add(s); s.on("error", () => undefined); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

export async function selfSignedHttps(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "atrium-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const server = createHttps({ key: readFileSync(key), cert: readFileSync(cert) }, handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `https://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function redirect(res: ServerResponse, to: string, status = 302) {
  res.writeHead(status, { location: to });
  res.end();
}
