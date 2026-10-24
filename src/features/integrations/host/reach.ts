// A10.6 reachability: is an address answering, and how fast. One GET, no redirects followed, no
// credentials, 5 s. Egress rules: LAN addresses are allowed; loopback, unspecified, link-local and
// cloud metadata addresses are refused, on the name lookup the socket itself uses (so a name that
// changes to a refused address while connecting is refused too). Server side only.
import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, request } from "undici";
import { checkAddress, expandIpv6 } from "./address";

export const REACH_TIMEOUT_MS = 5000;
export const REACH_REFUSED = "Atrium does not check addresses on this server itself or link-local addresses.";

export type ReachResult = { up: boolean; ms: number; status?: number; reason?: string };

/** Loopback (127.0.0.0/8, ::1), unspecified (0.0.0.0, ::) and their IPv4-mapped forms. */
export function isLoopback(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const fam = isIP(bare);
  if (fam === 4) return bare.startsWith("127.") || bare.startsWith("0.");
  if (fam === 6) {
    const g = expandIpv6(bare);
    if (!g) return true;
    if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isLoopback(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
    return false;
  }
  return true;
}

/** Why this address may not be checked, or null. */
export function reachRefusal(ip: string): string | null {
  if (isLoopback(ip)) return REACH_REFUSED;
  if (checkAddress(ip).blocked) return REACH_REFUSED;
  return null;
}

type Cb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A lookup that refuses loopback, link-local and metadata addresses. */
export const reachLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as unknown as Cb;
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, []);
    for (const a of addrs) {
      if (reachRefusal(a.address)) return cb(Object.assign(new Error(REACH_REFUSED), { code: "ATRIUM_REACH_REFUSED" }), []);
    }
    if (options.all) return cb(null, addrs);
    const first = addrs[0];
    if (!first) return cb(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "", 0);
    cb(null, first.address, first.family);
  });
};

let agent: Agent | undefined;
function reachAgent(): Agent {
  // Reachability sends nothing secret, so a self-signed certificate (common on a LAN) still counts as answering.
  agent ??= new Agent({ connect: { lookup: reachLookup, rejectUnauthorized: false, timeout: REACH_TIMEOUT_MS }, keepAliveTimeout: 1_000 });
  return agent;
}

/** Parses a person's address: http or https only, no credentials. Throws a sentence. */
export function reachUrl(raw: unknown): URL {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new ReachInputError("Enter the address to check, for example http://10.0.0.5:8096.");
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    throw new ReachInputError("That is not a valid address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ReachInputError("Only http and https addresses can be checked.");
  if (u.username || u.password) throw new ReachInputError("Leave credentials out of the address.");
  return u;
}

export class ReachInputError extends Error {}

/**
 * Checks one address: `up` when it answers with a status below 500 within 5 s. A refused address
 * is never contacted and answers `{ up: false, reason }`.
 */
export async function probeReach(raw: unknown, opts: { timeoutMs?: number; signal?: AbortSignal; dispatcher?: Agent } = {}): Promise<ReachResult> {
  const u = reachUrl(raw);
  const bare = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) && reachRefusal(bare)) return { up: false, ms: 0, reason: REACH_REFUSED };
  if (bare.toLowerCase() === "localhost" || bare.toLowerCase().endsWith(".localhost")) return { up: false, ms: 0, reason: REACH_REFUSED };
  const timeoutMs = opts.timeoutMs ?? REACH_TIMEOUT_MS;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(opts.signal ? [opts.signal] : [])]);
  const start = performance.now();
  try {
    // The abort signal does not stop a connection attempt in progress, so the deadline races it.
    const timedOut = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { code: "ATRIUM_REACH_TIMEOUT" })), { once: true }));
    const res = await Promise.race([request(u, { method: "GET", headers: { "user-agent": "Atrium/0.1 reachability", accept: "*/*" }, dispatcher: opts.dispatcher ?? reachAgent(), signal }), timedOut]);
    const ms = Math.max(1, Math.round(performance.now() - start));
    res.body.dump().catch(() => undefined);
    return res.statusCode < 500 ? { up: true, ms, status: res.statusCode } : { up: false, ms, status: res.statusCode, reason: `It answered with an error (HTTP ${res.statusCode}).` };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "ATRIUM_REACH_REFUSED") return { up: false, ms: 0, reason: REACH_REFUSED };
    if (signal.aborted || code === "ATRIUM_REACH_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return { up: false, ms, reason: `No answer within ${Math.round(timeoutMs / 1000)} s.` };
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { up: false, ms, reason: "That name does not resolve to an address." };
    if (code === "ECONNREFUSED") return { up: false, ms, reason: "Nothing is listening at that address." };
    return { up: false, ms, reason: "It did not answer." };
  }
}
