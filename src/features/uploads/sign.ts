// External images (architecture 13 "External images"; A4.2 "Bound external images"; A5.1; settings
// gauntlet w2-r1 items 3 and 4). Images from other hosts reach a page only as a signed `/api/img` path,
// signed by the server for URLs it sent itself, so the proxy is never an open fetcher.
// SERVER ONLY: the key never leaves the server.
//
// A signature (v2) covers five things, and /api/img checks every one:
//   u  the image URL
//   a  the app it was signed for: the caller must be able to open that app (a guest only its own app)
//   v  who may use it: "g" guest-safe (signed from a published document or a guest's resolved values),
//      "v" signed-in people who can open the app (raw integration data), "e" editors of the app only
//      (an editor's draft, A5.1). A guest never gets more than "g"; a viewer never "e".
//   n  the network rule for the fetch: "d" a URL a person typed into a document (detection's rules:
//      link-local and metadata refused, LAN allowed, as before); "h" a URL from integration data on
//      that integration's own configured origin: scheme, host and port, with the scheme's default port
//      (settings gauntlet w2-r2 item 1: the host name alone let a feed reach every other port on that
//      machine). LAN allowed for that origin only, and redirects stay on it;
//      "p" any other URL from integration data: public addresses only, at every hop (no loopback,
//      private, link-local, CGNAT, unique-local or other non-public address, also after DNS).
//   e  an expiry (unix seconds). Signatures last SIGNATURE_TTL_SEC, rounded up to the hour so the same
//      URL keeps the same path for an hour (browser and proxy caches still hit).
// Calling signImageUrl without a scope signs nothing (fail closed): every caller names its app.
import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { devSecret } from "@/core/env";
import { checkAddress, expandIpv6, isPrivateAddress } from "@/features/integrations/host/address";

export const MAX_IMAGE_URL = 2048;
/** How long a signed image path works (24 hours, plus up to one hour of rounding). */
export const SIGNATURE_TTL_SEC = 24 * 60 * 60;
const BUCKET_SEC = 60 * 60;
let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) cachedKey = Buffer.from(hkdfSync("sha256", devSecret("BETTER_AUTH_SECRET"), "atrium", "atrium image proxy v2", 32));
  return cachedKey;
}

/** For tests. */
export function resetImageKey(): void {
  cachedKey = null;
}

/** Who may use a signed path: guest-safe, signed-in people who can open the app, or its editors. */
export type ImageAccess = "guest" | "viewer" | "editor";
/** The fetch's network rule: typed document URL, the integration's own host, or public only. */
export type ImageNet = "document" | "host" | "public";
export type ImageScope = { appId: string; access: ImageAccess };

const ACCESS_CODE: Record<ImageAccess, string> = { guest: "g", viewer: "v", editor: "e" };
const NET_CODE: Record<ImageNet, string> = { document: "d", host: "h", public: "p" };
const ACCESS_OF: Record<string, ImageAccess> = { g: "guest", v: "viewer", e: "editor" };
const NET_OF: Record<string, ImageNet> = { d: "document", h: "host", p: "public" };
const APP_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function mac(url: string, appId: string, access: string, net: string, exp: number): string {
  return createHmac("sha256", key()).update(`atrium-img-v2\n${appId}\n${access}\n${net}\n${exp}\n${url}`, "utf8").digest("base64url");
}

/** A URL host without IPv6 brackets or a trailing root dot ("localhost." is localhost), lower case. */
function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * The origin key of an http(s) URL: scheme, bare host and port, with the scheme's default port written
 * out, so http://cam and http://cam:80 match and http://cam:8080 or https://cam do not. Null otherwise.
 */
export function originKey(raw: string | URL): string | null {
  let u: URL;
  try {
    u = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = bare(u.hostname);
  if (!host) return null;
  return `${u.protocol}//${host.includes(":") ? `[${host}]` : host}:${u.port || DEFAULT_PORT[u.protocol]}`;
}

/**
 * True for a non-public IP literal: isPrivateAddress, plus the IPv4 inside 6to4 (2002::/16) and Teredo
 * (2001:0::/32, the client address stored inverted) when that IPv4 is not public (security note, w2-r2).
 */
export function isNonPublicIp(ip: string): boolean {
  if (isPrivateAddress(ip)) return true;
  if (isIP(ip) !== 6) return false;
  const g = expandIpv6(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (g[0] === 0x2002) return isPrivateAddress(v4(g[1]!, g[2]!));
  if (g[0] === 0x2001 && g[1] === 0) return isPrivateAddress(v4(~g[6]! & 0xffff, ~g[7]! & 0xffff)) || isPrivateAddress(v4(g[2]!, g[3]!));
  return false;
}

/** The address rules any URL must pass before it is signed or fetched (detection's rules). */
export function imageUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http and https images";
  if (u.username || u.password) return "credentials in the address";
  if (url.length > MAX_IMAGE_URL) return "address too long";
  const host = bare(u.hostname);
  if (isIP(host) && checkAddress(host).blocked) return "link-local or metadata address";
  return null;
}

/** Host names that always mean this machine or the local network, whatever DNS says. */
const LOCAL_NAMES = /(^|\.)(localhost|local|lan|home|internal|intranet|corp|private|home\.arpa)$/i;

/**
 * The network rule for a URL that came from integration data (gauntlet w2-r1 item 4, w2-r2 item 1):
 * - "host" when its origin (scheme, host and port, default ports written out) is one of the
 *   integration's own configured origins (`ownOrigins`, from integrationOriginsFrom): a Proxmox or camera
 *   integration whose images live on its own LAN address keeps working, but another port or scheme on
 *   that machine is not the integration, so it is treated like any other address;
 * - "public" when it names a public address or a host name that is not a local name (the proxy then
 *   refuses any non-public address it resolves to, at every hop);
 * - null (not signed) for a loopback, private, link-local or other non-public IP literal (6to4 and
 *   Teredo unwrapped), or a local name such as localhost or *.lan, on any other origin.
 */
export function dataUrlNet(url: string, ownOrigins: readonly string[]): ImageNet | null {
  if (imageUrlProblem(url)) return null;
  const u = new URL(url);
  const key = originKey(u);
  if (key && ownOrigins.some((o) => originKey(o) === key)) return "host";
  const host = bare(u.hostname);
  if (isIP(host)) return isNonPublicIp(host) ? null : "public";
  if (!host.includes(".") || LOCAL_NAMES.test(host)) return null;
  return "public";
}

function expiry(now: number): number {
  return Math.ceil((Math.floor(now / 1000) + SIGNATURE_TTL_SEC) / BUCKET_SEC) * BUCKET_SEC;
}

function signWith(url: string, scope: ImageScope, net: ImageNet, now: number): string | null {
  if (!APP_ID_RE.test(scope.appId) || !(scope.access in ACCESS_CODE)) return null;
  const a = ACCESS_CODE[scope.access];
  const n = NET_CODE[net];
  const e = expiry(now);
  return `/api/img?u=${encodeURIComponent(url)}&a=${encodeURIComponent(scope.appId)}&v=${a}&n=${n}&e=${e}&s=${mac(url, scope.appId, a, n, e)}`;
}

/**
 * The signed `/api/img` path for an absolute http(s) image URL a person typed into a document (a
 * published version, or an editor's draft with access "editor"), or null when the address rules refuse
 * it. Without a scope nothing is signed.
 */
export function signImageUrl(url: string, scope?: ImageScope, now = Date.now()): string | null {
  if (typeof url !== "string" || !scope || imageUrlProblem(url)) return null;
  return signWith(url, scope, "document", now);
}

/**
 * The signed path for an absolute URL that came from integration data (an RSS item, a calendar entry,
 * an API response): signed only for public addresses or the integration's own configured origin
 * (`ownOrigins`, from integrationOriginsFrom()). Null when refused.
 */
export function signDataImageUrl(url: string, scope: ImageScope & { ownOrigins: readonly string[] }, now = Date.now()): string | null {
  if (typeof url !== "string") return null;
  const net = dataUrlNet(url, scope.ownOrigins);
  return net ? signWith(url, scope, net, now) : null;
}

/** A one-argument signer for document URLs (the UrlSigner shape the data module and app loader use). */
export function documentImageSigner(scope: ImageScope): (url: string) => string | null {
  return (url) => signImageUrl(url, scope);
}

/** A one-argument signer for integration data URLs. */
export function dataImageSigner(scope: ImageScope & { ownOrigins: readonly string[] }): (url: string) => string | null {
  return (url) => signDataImageUrl(url, scope);
}

/**
 * The origins an integration was configured with: its base URL's scheme, host and port (default port
 * written out), plus the same scheme and host on any port its package declares for images
 * (`extraPorts`, see IMAGE_PORTS_BY_PACKAGE in data-sign.ts). Integrations with no http base URL
 * (Docker over a socket) have none.
 */
export function integrationOriginsFrom(config: Record<string, unknown> | null | undefined, extraPorts: readonly number[] = []): string[] {
  const raw = typeof config?.baseUrl === "string" ? config.baseUrl.trim() : "";
  if (!raw) return [];
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return [];
  }
  const own = originKey(u);
  if (!own) return [];
  const out = [own];
  for (const port of extraPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const extra = new URL(u.toString());
    extra.port = String(port);
    const k = originKey(extra);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

export type VerifiedImage = { url: string; appId: string; access: ImageAccess; net: ImageNet; exp: number };

/** Why a signed path is refused, for /api/img. */
export type SignatureProblem = "bad_signature" | "expired";

/**
 * Checks a signed path's query (u, a, v, n, e, s). Constant time on the MAC. Returns the verified
 * scope, or the reason it is refused. Expired paths and paths dated too far ahead are refused.
 */
export function verifyImageQuery(q: URLSearchParams, now = Date.now()): VerifiedImage | { problem: SignatureProblem } {
  const url = q.get("u");
  const appId = q.get("a");
  const a = q.get("v");
  const n = q.get("n");
  const eRaw = q.get("e");
  const s = q.get("s");
  if (!url || !appId || !a || !n || !eRaw || !s || s.length > 64) return { problem: "bad_signature" };
  if (!APP_ID_RE.test(appId) || !(a in ACCESS_OF) || !(n in NET_OF) || !/^\d{1,12}$/.test(eRaw)) return { problem: "bad_signature" };
  const exp = Number(eRaw);
  const want = Buffer.from(mac(url, appId, a, n, exp));
  const got = Buffer.from(s);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { problem: "bad_signature" };
  const nowSec = Math.floor(now / 1000);
  if (exp <= nowSec) return { problem: "expired" };
  if (exp > nowSec + SIGNATURE_TTL_SEC + BUCKET_SEC) return { problem: "bad_signature" };
  return { url, appId, access: ACCESS_OF[a]!, net: NET_OF[n]!, exp };
}

/** True when `path` is a signature for `url` that verifies now (tests and callers that only need yes or no). */
export function verifyImageSignature(path: string | null, now = Date.now()): boolean {
  if (!path) return false;
  const i = path.indexOf("?");
  if (i < 0) return false;
  return !("problem" in verifyImageQuery(new URLSearchParams(path.slice(i + 1)), now));
}
