import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";

// The socket peer address for rate limiting (auth gauntlet r1, fix 2).
//
// App Router handlers and the proxy only see request headers, and Next copies the socket address
// into X-Forwarded-For only when the client did not send one, so a direct client can forge it.
// To learn the real peer, Atrium wraps the Node HTTP server's "request" event once per process and
// stamps every request with `x-atrium-peer: <socket address>;<HMAC>`, keyed by a random per-process
// secret. Any client-sent copy of the header is overwritten, and readers accept only a value whose
// HMAC verifies, so a client cannot supply its own. If the stamp is not installed (another server,
// a test), the peer is unknown and the limiter falls back to its global floor.
//
// This is a runtime patch of node:http, installed from the boot hook (instrumentation.ts calls
// ensureBootstrapped). The cleaner architecture is a small custom server that sets the header
// before calling Next; see the auth round 2 build report, "Interface gaps".

export const PEER_HEADER = "x-atrium-peer";

// `installed`: node:http is wrapped. `simulated`: tests call handlers in-process (no socket) and stamp
// requests themselves, so stamps are trusted without the wrapper.
type PeerState = { key: Buffer; installed: boolean; simulated: boolean };
const g = globalThis as typeof globalThis & { __atriumPeer?: PeerState };

function state(): PeerState {
  if (!g.__atriumPeer) g.__atriumPeer = { key: randomBytes(32), installed: false, simulated: false };
  return g.__atriumPeer;
}

function mac(address: string): string {
  return createHmac("sha256", state().key).update(address).digest("base64url");
}

/** The stamped header value for a socket address. */
export function stampValue(address: string): string {
  return `${address};${mac(address)}`;
}

/** Strips the IPv4-mapped IPv6 prefix so "::ffff:10.0.0.1" and "10.0.0.1" are one address. */
export function normalizeAddress(address: string): string {
  const a = address.trim().toLowerCase();
  return a.startsWith("::ffff:") && a.includes(".") ? a.slice(7) : a;
}

/** The verified socket peer for these headers, or null when the stamp is missing or forged. */
export function verifiedPeer(headers: Headers): string | null {
  if (!state().installed && !state().simulated) return null;
  const raw = headers.get(PEER_HEADER);
  if (!raw) return null;
  const i = raw.lastIndexOf(";");
  if (i <= 0) return null;
  const address = raw.slice(0, i);
  const want = Buffer.from(mac(address));
  const got = Buffer.from(raw.slice(i + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return normalizeAddress(address);
}

type Emit = (this: http.Server, event: string | symbol, ...args: unknown[]) => boolean;

/** Wraps http(s).Server "request" events so each request carries the stamped peer. Idempotent. */
export function installPeerStamp(): void {
  const s = state();
  if (s.installed) return;
  for (const Server of [http.Server, https.Server] as unknown as { prototype: { emit: Emit } }[]) {
    const original = Server.prototype.emit;
    Server.prototype.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]) {
      if (event === "request") {
        const req = args[0] as http.IncomingMessage | undefined;
        const address = req?.socket?.remoteAddress;
        if (req?.headers) {
          // Overwrite any client-sent value; keep one this process already stamped (a nested hop).
          const existing = req.headers[PEER_HEADER];
          const own = typeof existing === "string" && verifiedPeerRaw(existing);
          if (!own) {
            if (address) req.headers[PEER_HEADER] = stampValue(address);
            else delete req.headers[PEER_HEADER];
          }
        }
      }
      return original.call(this, event, ...args);
    } as Emit;
  }
  s.installed = true;
}

function verifiedPeerRaw(raw: string): boolean {
  const i = raw.lastIndexOf(";");
  if (i <= 0) return false;
  const want = Buffer.from(mac(raw.slice(0, i)));
  const got = Buffer.from(raw.slice(i + 1));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Tests only: trust stamps on in-process requests (no socket), or stop trusting them (false). */
export function markPeerStampInstalledForTests(simulated = true): void {
  state().simulated = simulated;
}
