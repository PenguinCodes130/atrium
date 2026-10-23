// The single low-level request engine behind host.fetch, detection, Try it and docs lookup.
// Every hop is resolved and checked against the address rules, the connection is pinned to
// the checked address, redirects are followed by hand (at most 3) and one 10 s deadline
// covers the whole exchange including the body.
import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, request } from "undici";
import { checkAddress, isPrivateAddress } from "./address";
import { PRIVATE_SAFE_HEADERS } from "./outbound";
import { BLOCKED_ADDRESS_MESSAGE, HostError, hostError, toAdapterError } from "./errors";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type RedirectPolicy =
  /** host.fetch reads and any request carrying a credential: redirects only within the same origin. */
  | { mode: "same-host"; message?: string }
  /**
   * Detection, docs lookup and Try it without credentials: any host, every hop re-checked against
   * the address rules. Credential-like headers are dropped on a hop to another origin.
   */
  | { mode: "checked" };

export type WriteMethod = "PUT" | "PATCH" | "DELETE";
export type SafeRequest = {
  url: string;
  method?: "GET" | "POST" | WriteMethod;
  /** v3 (section 3.1): PUT, PATCH and DELETE leave the server only when this is set, which only host.command() does. */
  commandWrite?: boolean;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  verifyTls?: boolean;
  redirect: RedirectPolicy;
  /** Docker raw socket only; the URL host is then only used for the Host header. */
  socketPath?: string;
  /** When set, any other origin (scheme, host and port) is refused, on every hop (reads). */
  allowedOrigins?: string[];
  maxBytes?: number;
  /**
   * Set for requests a person shaped (Try it, custom and declarative endpoints). To a loopback or
   * private address such a request may only be a plain GET with standard headers, plus the
   * credential headers Atrium attached itself (`trustedHeaders`). Anything else is refused.
   */
  userShaped?: { trustedHeaders: string[] };
};

export const PRIVATE_WRITE_MESSAGE = "Requests you shape can only read from addresses on your network";

export type RawResponse = { status: number; headers: Record<string, string>; body: Buffer; url: string; redirects: number };

/** Resolves a host name and refuses it when any address is blocked. Exported for tests. Returns every address. */
export async function resolveChecked(hostname: string): Promise<LookupAddress[]> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    const v = checkAddress(bare);
    if (v.blocked) throw hostError("permission", BLOCKED_ADDRESS_MESSAGE, `Blocked: ${v.reason}.`);
    return [{ address: bare, family: isIP(bare) }];
  }
  const addrs = await new Promise<LookupAddress[]>((resolve, reject) =>
    dnsLookup(bare, { all: true }, (err, a) => (err ? reject(err) : resolve(a))),
  );
  for (const a of addrs) {
    const v = checkAddress(a.address);
    if (v.blocked) throw hostError("permission", BLOCKED_ADDRESS_MESSAGE, `Blocked: ${v.reason}.`);
  }
  return addrs;
}

/** A net lookup function that refuses blocked addresses, so the socket can only open to a checked address. */
export const checkedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return (callback as (e: Error | null, a: LookupAddress[]) => void)(err, []);
    for (const a of addrs) {
      if (checkAddress(a.address).blocked) {
        const e = Object.assign(new Error(BLOCKED_ADDRESS_MESSAGE), { code: "ATRIUM_BLOCKED" });
        return (callback as (e: Error | null, a: LookupAddress[]) => void)(e, []);
      }
    }
    if (options.all) return (callback as (e: Error | null, a: LookupAddress[]) => void)(null, addrs);
    const first = addrs[0];
    if (!first) return (callback as (e: Error | null, a: string, f: number) => void)(new Error("no address"), "", 0);
    (callback as (e: Error | null, a: string, f: number) => void)(null, first.address, first.family);
  });
};

/** Like checkedLookup, but also refuses private and loopback addresses (DNS rebinding guard for writes). */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  checkedLookup(hostname, { ...options, all: true }, (err: NodeJS.ErrnoException | null, addrs: string | LookupAddress[]) => {
    const list = Array.isArray(addrs) ? addrs : [];
    if (!err && list.some((a) => isPrivateAddress(a.address))) err = Object.assign(new Error(PRIVATE_WRITE_MESSAGE), { code: "ATRIUM_PRIVATE" });
    if (err) return (callback as (e: Error | null, a: LookupAddress[]) => void)(err, []);
    if (options.all) return (callback as (e: Error | null, a: LookupAddress[]) => void)(null, list);
    const first = list[0]!;
    (callback as (e: Error | null, a: string, f: number) => void)(null, first.address, first.family);
  });
};

const agents = new Map<string, Agent>();
function agentFor(verifyTls: boolean, socketPath?: string, publicOnly = false): Agent {
  const k = `${verifyTls}|${socketPath ?? ""}|${publicOnly}`;
  let a = agents.get(k);
  if (!a) {
    a = new Agent({
      connect: socketPath ? { socketPath } : { lookup: publicOnly ? publicLookup : checkedLookup, rejectUnauthorized: verifyTls },
      keepAliveTimeout: 4_000,
    });
    agents.set(k, a);
  }
  return a;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

function flatHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

/** Headers that carry credentials and must not follow a redirect to another origin. */
const CREDENTIAL_HOP_HEADERS = ["authorization", "proxy-authorization", "cookie"];

/** Why a person-shaped request may not go to a private address, or null when it may. */
function privateWriteReason(method: string, body: string | undefined, headers: Record<string, string>, trusted: Set<string>): string | null {
  if (method !== "GET") return `It uses ${method}, and only GET is allowed there.`;
  if (body !== undefined) return "It has a body, and only a plain GET is allowed there.";
  for (const name of Object.keys(headers)) {
    const n = name.toLowerCase();
    if (!PRIVATE_SAFE_HEADERS.has(n) && !trusted.has(n)) return `It sets the "${name}" header, and only standard headers are allowed there.`;
  }
  return null;
}

export async function safeRequest(req: SafeRequest): Promise<RawResponse> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw hostError("config", "That address is not a valid URL.", "Use a full address such as http://10.0.0.5:8080.");
  }
  const startOrigin = url.origin;
  let method = req.method ?? "GET";
  if ((method === "PUT" || method === "PATCH" || method === "DELETE") && !req.commandWrite) {
    throw hostError("permission", `Atrium only sends ${method} while running a command a package declares.`, "Reads and health checks may only use GET and documented read POSTs.");
  }
  let body = req.body;
  let headers: Record<string, string> = { "user-agent": "Atrium/0.1", accept: "application/json, text/plain, */*" };
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
  const trusted = new Set((req.userShaped?.trustedHeaders ?? []).map((h) => h.toLowerCase()));
  let redirects = 0;
  try {
    for (;;) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw hostError("config", "Only http and https addresses are supported.");
      if (url.username || url.password) throw hostError("config", "Put credentials in a secret field, not in the address.");
      if (req.allowedOrigins && !req.allowedOrigins.includes(url.origin)) {
        throw hostError("permission", BLOCKED_ADDRESS_MESSAGE, "Reads can only reach the configured host and hosts the package lists.");
      }
      let publicOnly = false;
      if (!req.socketPath) {
        const addrs = await resolveChecked(url.hostname);
        if (req.userShaped) {
          const why = privateWriteReason(method, method !== "GET" ? body : undefined, headers, trusted);
          if (why) {
            if (addrs.some((a) => isPrivateAddress(a.address))) throw hostError("permission", `${PRIVATE_WRITE_MESSAGE}.`, `${why} Atrium only reads data, so it will not send this to ${url.hostname}.`);
            publicOnly = true;
          }
        }
      }
      const res = await request(url, {
        method,
        headers,
        body: method !== "GET" ? body : undefined,
        dispatcher: agentFor(req.verifyTls ?? true, req.socketPath, publicOnly),
        signal,
      });
      const resHeaders = flatHeaders(res.headers as Record<string, string | string[] | undefined>);
      if (REDIRECT.has(res.statusCode) && resHeaders.location) {
        await res.body.dump().catch(() => undefined);
        redirects++;
        if (redirects > MAX_REDIRECTS) throw hostError("bad_response", "The service redirected too many times.", `Atrium follows at most ${MAX_REDIRECTS} redirects.`);
        const next = new URL(resHeaders.location!, url);
        if (req.redirect.mode === "same-host" && next.origin !== startOrigin) {
          throw hostError("permission", req.redirect.message ?? "The service redirected to a different host, which reads are not allowed to follow.", "Use the final address as the base URL.");
        }
        if (next.origin !== url.origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HOP_HEADERS.includes(k) && !trusted.has(k)));
        }
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          delete headers["content-type"];
        }
        url = next;
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const max = req.maxBytes ?? MAX_BODY_BYTES;
      for await (const chunk of res.body) {
        size += (chunk as Buffer).length;
        if (size > max) {
          res.body.destroy();
          throw hostError("bad_response", "The response was too large.", `Atrium reads at most ${Math.round(max / 1024 / 1024)} MB per request.`);
        }
        chunks.push(chunk as Buffer);
      }
      return { status: res.statusCode, headers: resHeaders, body: Buffer.concat(chunks), url: url.toString(), redirects };
    }
  } catch (err) {
    if (err instanceof HostError) throw err;
    if ((err as { code?: string })?.code === "ATRIUM_BLOCKED" || (err as { cause?: { code?: string } })?.cause?.code === "ATRIUM_BLOCKED") {
      throw hostError("permission", BLOCKED_ADDRESS_MESSAGE);
    }
    if ((err as { code?: string })?.code === "ATRIUM_PRIVATE" || (err as { cause?: { code?: string } })?.cause?.code === "ATRIUM_PRIVATE") {
      throw hostError("permission", `${PRIVATE_WRITE_MESSAGE}.`, "The address changed to one on your network while connecting, so Atrium stopped.");
    }
    throw new HostError(toAdapterError(err, timeout.aborted, timeoutMs));
  }
}
