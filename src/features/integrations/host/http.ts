// host.fetch: the HostHttp every adapter receives (architecture v2 section 3). Resolves paths
// against the configured base URL, enforces network permissions, attaches secrets by name and
// returns a response the adapter can parse. Adapters never see a secret value.
import "server-only";
import type { HostHttp, HostResponse, PackageManifest } from "@/core/contracts";
import { DOCKER_SOCKET_MESSAGE, hostError, HostError } from "./errors";
import { attachSecret, checkUserHeaders, scrubSecrets } from "./outbound";
import { DEFAULT_TIMEOUT_MS, safeRequest } from "./request";
import { splitSecret, type SecretResolver } from "./secrets";
import { endpointPathProblem } from "../manifest";

export type Transport = { kind: "http"; baseUrl: URL } | { kind: "unix"; socketPath: string };

export type RequestRecord = { method: string; url: string };

export type HostHttpOptions = {
  manifest: PackageManifest;
  config: Record<string, unknown>;
  secrets: SecretResolver;
  signal?: AbortSignal;
  allowDockerSocket?: boolean;
  /** Test hook: sees every request after the checks pass, before it is sent. Never sees headers. */
  onRequest?: (r: RequestRecord) => void;
  /**
   * True when the requests come from records a person wrote (Custom API and declarative packages)
   * rather than reviewed adapter code: they may only send plain GETs to private addresses.
   */
  userShaped?: boolean;
  /**
   * v3 (section 3.1): "command" only while host.command() runs a declared command. Then PUT,
   * PATCH and DELETE may be sent, and a person-shaped command (Custom API, declarative) may write
   * to a private address, because its owner or creator declared and published it. Reads and health
   * checks always run in "read" mode.
   */
  mode?: "read" | "command";
};

/**
 * The fetch request the built-in generic adapter may send: the frozen HostHttp request plus the
 * non-secret headers of a CustomEndpoint (architecture v2 section 3 amendment). Only the
 * host's own adapters use the extra field.
 */
export type GenericFetchRequest = Parameters<HostHttp["fetch"]>[0] & { headers?: Record<string, string> };

/** Where a transport's requests go, as the resolver's `destination`: an origin or unix:<path>. */
export function destinationOf(t: Transport): string {
  return t.kind === "http" ? t.baseUrl.origin : `unix:${t.socketPath}`;
}

/** The origin an integration's secrets are pinned to: its saved address. Undefined when the address is not valid. */
export function pinOriginFor(manifest: PackageManifest, config: Record<string, unknown>): string | undefined {
  try {
    return destinationOf(transportFor(manifest, config, true));
  } catch {
    return undefined;
  }
}

/** Docker's endpoint: tcp://host:port (recommended, a read-only socket proxy) or unix:///path (refused unless allowed). */
export function dockerTransport(endpoint: unknown, allowSocket: boolean): Transport {
  const raw = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!raw) throw hostError("config", "Set the Docker endpoint, for example tcp://127.0.0.1:2375.");
  if (raw.startsWith("unix://")) {
    if (!allowSocket) throw hostError("permission", DOCKER_SOCKET_MESSAGE, "Run a read-only Docker socket proxy and point Atrium at tcp://host:port.");
    const socketPath = raw.slice("unix://".length);
    if (!socketPath.startsWith("/")) throw hostError("config", "A socket endpoint must be an absolute path, for example unix:///var/run/docker.sock.");
    return { kind: "unix", socketPath };
  }
  const m = /^(?:tcp|http):\/\/([^/]+)\/?$/.exec(raw);
  if (raw.startsWith("https://")) return { kind: "http", baseUrl: new URL(raw) };
  if (!m) throw hostError("config", "The Docker endpoint must look like tcp://host:port or unix:///var/run/docker.sock.");
  return { kind: "http", baseUrl: new URL(`http://${m[1]}/`) };
}

export function transportFor(manifest: PackageManifest, config: Record<string, unknown>, allowSocket: boolean): Transport {
  if (manifest.id === "docker") return dockerTransport(config.endpoint, allowSocket);
  const raw = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  if (!raw) throw hostError("config", "Set the base URL, for example http://10.0.0.5:8080.");
  let u: URL;
  try { u = new URL(raw); } catch { throw hostError("config", "The base URL is not a valid address.", "Use a full address such as http://10.0.0.5:8080."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw hostError("config", "The base URL must start with http:// or https://.");
  return { kind: "http", baseUrl: u };
}

/**
 * The origins (scheme, host and port) a package lists in its network permission. A bare host name
 * stands for its http and https origins on their default ports; "host:port" keeps that port.
 */
function listedOrigins(manifest: PackageManifest): string[] {
  const out: string[] = [];
  for (const p of manifest.permissions) {
    if (p.kind !== "network" || !Array.isArray(p.hosts)) continue;
    for (const h of p.hosts) {
      for (const scheme of ["http", "https"]) {
        try {
          const u = new URL(`${scheme}://${h.toLowerCase()}`);
          if (u.pathname === "/" && !u.username && !u.password && !u.search && !u.hash) out.push(u.origin);
        } catch { /* not a host name: ignored */ }
      }
    }
  }
  return out;
}

function responseOf(status: number, headers: Record<string, string>, body: Buffer): HostResponse {
  return {
    status,
    headers,
    async text() { return body.toString("utf8"); },
    async json() {
      try { return JSON.parse(body.toString("utf8")) as unknown; }
      catch { throw hostError("bad_response", "The service did not answer with JSON.", "Check the base URL points at the API, not a web page."); }
    },
  };
}

export function createHostHttp(opts: HostHttpOptions): HostHttp {
  const { manifest, config } = opts;
  const getOnly = manifest.id === "docker";
  const verifyTls = config.verifyTls === undefined ? true : config.verifyTls !== false;
  const secretFields = new Map(manifest.secrets.map((s) => [s.key, s]));
  const secretPerms = new Set(manifest.permissions.flatMap((p) => (p.kind === "secret" ? [p.key] : [])));
  return {
    async fetch(req: GenericFetchRequest) {
      const method = req.method ?? "GET";
      const command = opts.mode === "command";
      const write = method === "PUT" || method === "PATCH" || method === "DELETE";
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw hostError("permission", `Atrium does not send ${String(method)} requests.`);
      if (write && !command) throw hostError("permission", "Atrium only reads data here, so only GET and POST reads are allowed. PUT, PATCH and DELETE are sent only while a command runs.");
      if (getOnly && method !== "GET") throw hostError("permission", "The Docker package may only send GET requests.", "Docker access in Atrium is read-only.");
      const transport = transportFor(manifest, config, opts.allowDockerSocket ?? false);
      if (/^[a-z][a-z0-9+.-]*:/i.test(req.path) || req.path.startsWith("//")) throw hostError("permission", "Adapters may only request paths on the configured host.");
      // Gauntlet r3 security M1: a backslash or a control character could turn a path into another
      // address (`/\\host:otherport/x`), so the path is refused before it is resolved.
      const pathProblem = endpointPathProblem(req.path);
      if (pathProblem) throw hostError("permission", pathProblem, "Atrium only sends a request to the integration's own address.");
      const base = transport.kind === "http" ? transport.baseUrl : new URL("http://docker/");
      // An empty path is the base URL itself (an RSS feed URL); anything else is relative to it.
      const dir = new URL(base);
      if (!dir.pathname.endsWith("/")) dir.pathname += "/";
      let url: URL;
      try {
        url = req.path === "" ? new URL(base) : new URL(req.path.replace(/^\//, ""), dir);
      } catch {
        throw hostError("permission", "The path is not valid.", "Atrium only sends a request to the integration's own address.");
      }
      // The requested URL must keep the base origin (scheme, host and port), whatever the path held.
      if (url.origin !== base.origin) throw hostError("permission", "The path leads to another address, so Atrium did not send the request.", "Atrium only sends a request to the integration's own address. Put the full address in the base URL.");
      for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
      let headers: Record<string, string> = {};
      if (req.headers) {
        const h = checkUserHeaders(req.headers);
        if (!h.ok) throw hostError("config", h.message, h.hint);
        headers = h.headers;
      }
      let body: string | undefined;
      if (method !== "GET" && req.body !== undefined) {
        if (typeof req.body === "string") body = req.body;
        else if (req.body instanceof URLSearchParams) { body = req.body.toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
        else { body = JSON.stringify(req.body); headers["content-type"] = "application/json"; }
      }
      const used: string[] = [];
      const trusted: string[] = [];
      if (req.auth) {
        const field = secretFields.get(req.auth);
        if (!field || !secretPerms.has(req.auth)) throw hostError("permission", `This package is not allowed to use the secret "${req.auth}".`);
        // The resolver is told the origin actually requested (scheme, host and port) and refuses a
        // value saved or locked for another address.
        const { value, user } = splitSecret(await opts.secrets(req.auth, transport.kind === "http" ? url.origin : destinationOf(transport)));
        if (!value) throw hostError("config", `"${field.label}" is not set.`, `Enter ${field.label} on the integration's setup screen.`);
        // A saved username and password credential brings its own Basic auth username.
        const a = attachSecret(field.auth, value, headers, url, user !== undefined && field.auth.as === "basic" ? { ...config, [field.auth.userKey]: user } : config);
        used.push(...a.forms);
        if (a.header) trusted.push(a.header);
      }
      const allowed = transport.kind === "http" ? [transport.baseUrl.origin, ...listedOrigins(manifest)] : undefined;
      opts.onRequest?.({ method, url: `${url.origin}${url.pathname}` });
      const res = await safeRequest({
        url: url.toString(),
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(opts.signal ? { signal: opts.signal } : {}),
        verifyTls,
        redirect: { mode: "same-host" },
        ...(opts.userShaped && !command ? { userShaped: { trustedHeaders: trusted } } : {}),
        ...(command ? { commandWrite: true } : {}),
        ...(allowed ? { allowedOrigins: allowed } : {}),
        ...(transport.kind === "unix" ? { socketPath: transport.socketPath } : {}),
      });
      return responseOf(res.status, res.headers, scrubSecrets(res.body, used));
    },
  };
}

export { HostError };
