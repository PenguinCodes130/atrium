import "server-only";
import { sqlite } from "@/core/db";
import { RateLimited } from "@/core/errors";
import { normalizeAddress, verifiedPeer } from "./peer";

// Atrium's own fixed-window limiter on SQLite (architecture section 5). Checked before the request
// is evaluated, so a limited sign-in never reaches the password check.

export const LIMITS = {
  signInIp: { limit: 5, windowMs: 60_000 },
  signInAccount: { limit: 10, windowMs: 60 * 60_000 },
  totp: { limit: 5, windowMs: 5 * 60_000 },
  mcpToken: { limit: 120, windowMs: 60_000 },
  // Floor when the client address is unknown (no socket peer stamp): every such caller shares it.
  signInGlobal: { limit: 10, windowMs: 60_000 },
  // Dynamic client registration is open to MCP clients before sign-in, so it is capped per address.
  oauthRegister: { limit: 20, windowMs: 60 * 60_000 },
  // Guest links (architecture v3 5.1, amendment A1.3): opening /g/<token> per IP, and guest page and
  // stream requests per guest session.
  guestOpenIp: { limit: 30, windowMs: 60_000 },
  guestRequest: { limit: 120, windowMs: 60_000 },
  // Invite and reset links (Amendment 3): opening /invite/* per IP.
  accountLinkIp: { limit: 30, windowMs: 60_000 },
} as const;

export type LimitName = keyof typeof LIMITS;

/** Counts one attempt against `name:subject`. Throws RateLimited (429, Retry-After) once over the limit. */
export function hit(name: LimitName, subject: string, now: number = Date.now()): void {
  const { limit, windowMs } = LIMITS[name];
  const key = `${name}:${subject}`;
  const db = sqlite();
  const row = db
    .prepare(
      `INSERT INTO auth_rate_limit (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
       RETURNING count, window_start`,
    )
    .get(key, now, now, windowMs, now, windowMs, now) as { count: number; window_start: number };
  if (row.count > limit) {
    throw new RateLimited(Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000)));
  }
}

/** Throws RateLimited without counting, when the subject is already over the limit. */
export function peek(name: LimitName, subject: string, now: number = Date.now()): void {
  const { limit, windowMs } = LIMITS[name];
  const row = sqlite().prepare(`SELECT count, window_start FROM auth_rate_limit WHERE key = ?`).get(`${name}:${subject}`) as
    | { count: number; window_start: number }
    | undefined;
  if (row && now - row.window_start < windowMs && row.count >= limit) {
    throw new RateLimited(Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000)));
  }
}

/** True when `address` matches one entry of ATRIUM_TRUSTED_PROXIES (exact address or IPv4 CIDR). */
export function isTrustedProxy(address: string, trustedProxies: string | undefined): boolean {
  const a = normalizeAddress(address);
  for (const raw of (trustedProxies ?? "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes("/")) {
      const [net, bitsRaw] = entry.split("/");
      const bits = Number(bitsRaw);
      const n = ipv4ToInt(normalizeAddress(net!));
      const x = ipv4ToInt(a);
      if (n === null || x === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if (((n & mask) >>> 0) === ((x & mask) >>> 0)) return true;
    } else if (normalizeAddress(entry) === a) return true;
  }
  return false;
}

function ipv4ToInt(a: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/**
 * The client address for rate limiting (auth gauntlet r1, fix 2), or null when it cannot be known.
 * The starting point is the socket peer stamped on the request (peer.ts). X-Forwarded-For is read only
 * when that peer is in ATRIUM_TRUSTED_PROXIES, walking from the right past trusted hops. A direct
 * client therefore cannot change its address by sending the header.
 */
export function clientAddress(headers: Headers, trustedProxies: string | undefined): string | null {
  const peer = verifiedPeer(headers);
  if (!peer) return null;
  if (!isTrustedProxy(peer, trustedProxies)) return peer;
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => normalizeAddress(s))
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(chain[i]!, trustedProxies)) return chain[i]!;
  }
  return peer;
}

/**
 * The per-IP sign-in limit, or the global floor when the address is unknown (no peer stamp): all
 * callers then share one bucket, so header rotation still cannot escape it.
 */
export function hitSignInAddress(address: string | null, now: number = Date.now()): void {
  if (address) hit("signInIp", address, now);
  else hit("signInGlobal", "unknown-peer", now);
}
