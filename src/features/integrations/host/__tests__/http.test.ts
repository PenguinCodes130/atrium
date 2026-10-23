import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackageManifest } from "@/core/contracts";
import dockerManifest from "@/packages/docker/manifest.json";
import docker from "@/packages/docker/adapter";
import { createHostHttp, dockerTransport, type RequestRecord } from "../http";
import { DOCKER_SOCKET_MESSAGE } from "../errors";
import { httpServer, json, unixServer } from "./servers";

const DOCKER = dockerManifest as unknown as PackageManifest;
const CONTAINERS = [
  { Id: "a1", Names: ["/prometheus"], Image: "prom/prometheus:v3", State: "running", Status: "Up 3 days" },
  { Id: "b2", Names: ["/grafana"], Image: "grafana/grafana", State: "exited", Status: "Exited (0) 2 hours ago" },
];
const dockerHandler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  if (req.method !== "GET") return json(res, 405, { message: "read-only proxy" });
  if (req.url?.startsWith("/containers/json")) return json(res, 200, CONTAINERS);
  if (req.url === "/version") return json(res, 200, { Version: "29.7.2", ApiVersion: "1.55" });
  json(res, 404, {});
};
const noSecrets = async () => null;
const ctx = (http: ReturnType<typeof createHostHttp>) => ({ config: {}, http, log: { debug() {}, info() {}, warn() {}, error() {} }, signal: new AbortController().signal, now: () => new Date() });

let proxy: Awaited<ReturnType<typeof httpServer>>;
beforeAll(async () => { proxy = await httpServer(dockerHandler); });
afterAll(async () => { await proxy.close(); });

describe("Docker transport", () => {
  it("refuses the raw socket with the root-access message unless allowed", () => {
    expect(() => dockerTransport("unix:///var/run/docker.sock", false)).toThrow(DOCKER_SOCKET_MESSAGE);
    expect(dockerTransport("unix:///var/run/docker.sock", true)).toEqual({ kind: "unix", socketPath: "/var/run/docker.sock" });
    expect(dockerTransport("tcp://127.0.0.1:2375", false)).toMatchObject({ kind: "http" });
  });

  it("lists containers through a TCP socket proxy with name, image, state and status", async () => {
    const http = createHostHttp({ manifest: DOCKER, config: { endpoint: proxy.url.replace("http://", "tcp://") }, secrets: noSecrets });
    const r = await docker.read({ ...ctx(http), config: {} }, "containers", {});
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === "table") {
      expect(r.data.columns.map((c) => c.key)).toEqual(["name", "image", "state", "status", "health", "detail"]);
      expect(r.data.rows[1]).toEqual({ name: "prometheus", image: "prom/prometheus:v3", state: "running", status: "Up 3 days", health: "", detail: "prom/prometheus:v3 · running" });
    }
    const running = await docker.read(ctx(http), "running", {});
    expect(running).toMatchObject({ ok: true, data: { kind: "stat", value: 1 } });
  });

  it("sends only GET for Docker, whatever endpoint is configured, and refuses a POST before sending it", async () => {
    const sent: RequestRecord[] = [];
    const http = createHostHttp({ manifest: DOCKER, config: { endpoint: proxy.url.replace("http://", "tcp://") }, secrets: noSecrets, onRequest: (r) => sent.push(r) });
    const before = proxy.seen.length;
    await expect(http.fetch({ path: "containers/create", method: "POST", body: { Image: "x" } })).rejects.toMatchObject({ adapterError: { code: "permission", message: expect.stringContaining("only send GET") } });
    expect(proxy.seen.length).toBe(before);
    expect(sent).toHaveLength(0);
    await docker.health(ctx(http));
    await docker.read(ctx(http), "containers", {});
    expect(sent.every((r) => r.method === "GET")).toBe(true);
    expect(proxy.seen.slice(before).every((s) => s.method === "GET")).toBe(true);
  });

  it("reads over a unix socket only when the allow-socket switch is on, still GET only", async () => {
    const sock = await unixServer(dockerHandler);
    const cfg = { endpoint: `unix://${sock.socketPath}` };
    const refused = createHostHttp({ manifest: DOCKER, config: cfg, secrets: noSecrets, allowDockerSocket: false });
    const r = await docker.read(ctx(refused), "containers", {});
    expect(r).toMatchObject({ ok: false, error: { code: "permission", message: DOCKER_SOCKET_MESSAGE } });
    expect(sock.seen).toHaveLength(0);
    const allowed = createHostHttp({ manifest: DOCKER, config: cfg, secrets: noSecrets, allowDockerSocket: true });
    const ok = await docker.read(ctx(allowed), "containers", {});
    expect(ok.ok).toBe(true);
    await expect(allowed.fetch({ path: "containers/x/kill", method: "POST" })).rejects.toMatchObject({ adapterError: { code: "permission" } });
    expect(sock.seen.every((s) => s.method === "GET")).toBe(true);
    await sock.close();
  });
});

describe("secret attachment", () => {
  const manifest = (auth: PackageManifest["secrets"][number]["auth"]): PackageManifest => ({
    atriumApi: "1", kind: "code", id: "t", name: "T", version: "1.0.0", author: "a", description: "d", icon: "i",
    permissions: [{ kind: "network", hosts: "configured" }, { kind: "secret", key: "k" }],
    config: {}, secrets: [{ key: "k", label: "Key", hint: "h", auth }, { key: "undeclared", label: "U", hint: "h", auth: { as: "bearer" } }], endpoints: [],
  });
  const secret = async (key: string) => (key === "k" ? "s3cr3t-value" : "other");

  it.each([
    [{ as: "bearer" } as const, (s: { headers: Record<string, unknown>; url: string }) => s.headers.authorization === "Bearer s3cr3t-value"],
    [{ as: "header", name: "X-API-Key" } as const, (s: { headers: Record<string, unknown> }) => s.headers["x-api-key"] === "s3cr3t-value"],
    [{ as: "query", name: "apikey" } as const, (s: { url: string }) => s.url.includes("apikey=s3cr3t-value")],
    [{ as: "proxmox-token" } as const, (s: { headers: Record<string, unknown> }) => s.headers.authorization === "PVEAPIToken=s3cr3t-value"],
    [{ as: "basic", userKey: "user" } as const, (s: { headers: Record<string, unknown> }) => s.headers.authorization === `Basic ${Buffer.from("bob:s3cr3t-value").toString("base64")}`],
  ])("attaches %o", async (auth, check) => {
    const s = await httpServer((_q, res) => json(res, 200, { ok: true }));
    const http = createHostHttp({ manifest: manifest(auth), config: { baseUrl: s.url, user: "bob" }, secrets: secret });
    await http.fetch({ path: "api", auth: "k" });
    expect(check(s.seen[0] as never)).toBe(true);
    await s.close();
  });

  it("refuses a secret the manifest has no permission for", async () => {
    const http = createHostHttp({ manifest: manifest({ as: "bearer" }), config: { baseUrl: "http://127.0.0.1:1" }, secrets: secret });
    await expect(http.fetch({ path: "x", auth: "undeclared" })).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });

  it("scrubs the secret value out of a response that echoes it", async () => {
    const s = await httpServer((req, res) => json(res, 200, { echoed: req.headers.authorization }));
    const http = createHostHttp({ manifest: manifest({ as: "bearer" }), config: { baseUrl: s.url }, secrets: secret });
    const text = await (await http.fetch({ path: "", auth: "k" })).text();
    expect(text).not.toContain("s3cr3t-value");
    await s.close();
  });

  it("refuses absolute URLs and other hosts from adapters", async () => {
    const http = createHostHttp({ manifest: manifest({ as: "bearer" }), config: { baseUrl: "http://10.77.99.7:9090" }, secrets: secret });
    await expect(http.fetch({ path: "http://evil.example/" })).rejects.toMatchObject({ adapterError: { code: "permission" } });
    await expect(http.fetch({ path: "//evil.example/x" })).rejects.toMatchObject({ adapterError: { code: "permission" } });
  });

  it("allows a 10.x LAN address and 127.0.0.1 as configured hosts", async () => {
    const s = await httpServer((_q, res) => json(res, 200, { ok: 1 }));
    const http = createHostHttp({ manifest: manifest({ as: "bearer" }), config: { baseUrl: s.url }, secrets: secret });
    expect((await http.fetch({ path: "" })).status).toBe(200);
    await s.close();
  });
});
