// The favicon fetch (architecture A11.6; operator-tryout-spec N4). The SERVER reads a website's icon
// and stores it as an image upload; the browser never asks the website for anything.
//
// Every request goes through integrations' safeRequest: link-local and cloud metadata addresses are
// refused at every hop, after DNS and again when the socket connects (the socket is pinned to the
// checked address), redirects are followed by hand and re-checked (at most 3). Private and loopback
// addresses are allowed as for integrations, with one tightening: when the typed address is a PUBLIC
// website, every later hop and every icon must also be public (the request is marked the way the image
// proxy marks its public-only reads, so safeRequest refuses private addresses and pins public ones). A
// public page can therefore never point Atrium's server at a machine on the LAN. A typed host counts as
// public when ANY of its addresses is public; one whose DNS answer mixes public and private addresses
// is refused before any request (gauntlet w210c-r1 Fix 6a), so a site's DNS cannot switch the rule off.
//
// One 5 s deadline covers the whole fetch. The page is read up to 512 KB; a larger page is asked for
// again with `Range: bytes=0-524287` and its start is parsed (icons are declared in the head; Fix 16),
// and when the server will not send a part only /favicon.ico is tried. The manifest is read up to
// 512 KB, each icon up to 1 MB. The best raster at most 256 px or an SVG (sanitised as uploads are) is
// stored, deduplicated by content hash, and the exact typed address (scheme, host, port, path and query)
// remembers it for 7 days: the next ask for that same address answers the stored path without any
// request. Keyed by the exact address, not the origin (Fix 6b), so one page's icon is never answered for
// another page or the bare site; `refresh` fetches again.
import "server-only";
import { and, eq } from "drizzle-orm";
import type { Principal } from "@/core/contracts";
import { db } from "@/core/db";
import { AtriumError, Forbidden } from "@/core/errors";
import { logger } from "@/core/log";
import { settingValues } from "@/db/schema/settings";
import { uploads } from "@/db/schema/uploads";
import { isPrivateAddress } from "@/features/integrations/host/address";
import { HostError } from "@/features/integrations/host/errors";
import { PRIVATE_ONLY_MESSAGE, PRIVATE_WRITE_MESSAGE, resolveChecked, safeRequest, type RawResponse, type SafeRequest } from "@/features/integrations/host/request";
import { canUpload, checkFile, readUpload, storeChecked, UploadRefused } from "../store";
import { looksLikeHtml, sniffRaster } from "../sniff";
import { decodeDataUrl, icoToPng, imageSize, isIco } from "./image";
import {
  FAVICON_CACHE_MS,
  FAVICON_MAX_ICON_BYTES,
  FAVICON_MAX_PAGE_BYTES,
  FAVICON_MAX_PX,
  FAVICON_MAX_URL,
  FAVICON_MESSAGES as M,
  FAVICON_RATE_PER_MIN,
  FAVICON_TIMEOUT_MS,
  type FaviconMessageKey,
} from "./messages";
import { fallbackIcon, goodEnough, parseManifest, parsePage, rankIcons, type IconCandidate } from "./parse";

export type FaviconResult = { path: string; name: string; cached: boolean };

/** Sent only on public-only fetches. Its presence is what makes safeRequest refuse every private hop. */
export const FAVICON_PUBLIC_HEADER = "x-atrium-favicon";
const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5";
const ICON_ACCEPT = "image/avif,image/webp,image/png,image/svg+xml,image/x-icon,image/*;q=0.8";
const MANIFEST_ACCEPT = "application/manifest+json,application/json;q=0.9,*/*;q=0.5";
/** Icons tried at most, so a page listing hundreds cannot keep the server busy. */
const MAX_ICON_TRIES = 6;
const CACHE_SCOPE = "favicon-cache";

const STATUS: Record<FaviconMessageKey, [number, string]> = {
  typeAddress: [400, "bad_request"],
  tooLong: [400, "bad_request"],
  scheme: [400, "bad_request"],
  credentials: [400, "bad_request"],
  forbidden: [403, "forbidden"],
  refused: [403, "favicon_refused"],
  privateFromPublic: [403, "favicon_refused"],
  publicFromPrivate: [403, "favicon_refused"],
  mixedAnswer: [403, "favicon_refused"],
  none: [422, "favicon_none"],
  tooLarge: [422, "favicon_none"],
  tooManyPx: [422, "favicon_none"],
  pageTooLarge: [422, "favicon_none"],
  rateLimited: [429, "rate_limited"],
  unreachable: [502, "favicon_unreachable"],
  redirects: [502, "favicon_unreachable"],
  certificate: [502, "favicon_unreachable"],
  timeout: [504, "favicon_timeout"],
};

export class FaviconRefused extends AtriumError {
  constructor(readonly reason: FaviconMessageKey) {
    super(M[reason], STATUS[reason][0], STATUS[reason][1]);
  }
}

// ---- The typed address ------------------------------------------------------------------------------

/** The addresses to try for what the person typed: one, or https then http when no scheme was given. */
export function addressesFor(raw: unknown): URL[] {
  if (typeof raw !== "string" || !raw.trim()) throw new FaviconRefused("typeAddress");
  const s = raw.trim();
  if (s.length > FAVICON_MAX_URL) throw new FaviconRefused("tooLong");
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+(\/|$)/.test(s);
  const tries = hasScheme ? [s] : [`https://${s}`, `http://${s}`];
  const out: URL[] = [];
  for (const t of tries) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      throw new FaviconRefused("typeAddress");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new FaviconRefused("scheme");
    if (u.username || u.password) throw new FaviconRefused("credentials");
    if (!u.hostname) throw new FaviconRefused("typeAddress");
    u.hash = "";
    out.push(u);
  }
  return out;
}

// ---- The 7 day store (settings rows: scope "favicon-cache", key = the exact normalised address) ----------

/** The store's key for an address: scheme, host, port, path and query, without the fragment. */
export function cacheKey(u: URL): string {
  return `${u.origin}${u.pathname || "/"}${u.search}`;
}

type CacheValue = { file: string; at: number };

export function cachedIcon(key: string, now: number): { path: string; name: string } | null {
  const row = db().select().from(settingValues).where(and(eq(settingValues.scope, CACHE_SCOPE), eq(settingValues.key, key))).get();
  const v = row?.value as Partial<CacheValue> | undefined;
  if (!v || typeof v.file !== "string" || typeof v.at !== "number") return null;
  if (now - v.at >= FAVICON_CACHE_MS || v.at > now + 60_000) return null;
  // Only an upload that is still stored and still serves as an image.
  const up = db().select({ name: uploads.name, kind: uploads.kind }).from(uploads).where(eq(uploads.file, v.file)).get();
  if (!up || up.kind !== "image" || !readUpload(v.file)) return null;
  return { path: `/uploads/${v.file}`, name: up.name };
}

function remember(key: string, file: string, now: number, by: string) {
  const value: CacheValue = { file, at: now };
  db()
    .insert(settingValues)
    .values({ scope: CACHE_SCOPE, key, value, updatedAt: new Date(now), updatedBy: by })
    .onConflictDoUpdate({ target: [settingValues.scope, settingValues.key], set: { value, updatedAt: new Date(now), updatedBy: by } })
    .run();
}

// ---- Rate limit (per person, fetches only; cache answers are free) --------------------------------------

const g = globalThis as { __atriumFaviconHits?: Map<string, number[]> };
function countFetch(userId: string, now: number) {
  const hits = (g.__atriumFaviconHits ??= new Map<string, number[]>());
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= FAVICON_RATE_PER_MIN) throw new FaviconRefused("rateLimited");
  recent.push(now);
  hits.set(userId, recent);
}

export function resetFaviconLimits() {
  g.__atriumFaviconHits = new Map();
}

// ---- Fetching ------------------------------------------------------------------------------------------

export type FaviconDeps = {
  request?: (r: SafeRequest) => Promise<RawResponse>;
  resolve?: (host: string) => Promise<{ address: string }[]>;
  now?: () => number;
  /** Skip the 7 day store and fetch again (the result replaces the stored one). */
  refresh?: boolean;
};

/** Why a safeRequest failed, in the favicon's own words. */
export function reasonOf(err: unknown): FaviconMessageKey {
  if (err instanceof FaviconRefused) return err.reason;
  if (!(err instanceof HostError)) return "unreachable";
  const { code, message } = err.adapterError;
  // w210c r3 (item 12 note): a LAN run refused for leaving the network has its own sentence.
  if (code === "permission") return message.startsWith(PRIVATE_WRITE_MESSAGE) ? "privateFromPublic" : message.startsWith(PRIVATE_ONLY_MESSAGE) ? "publicFromPrivate" : "refused";
  if (code === "timeout") return "timeout";
  if (code === "tls") return "certificate";
  if (code === "config") return /http and https/.test(message) ? "scheme" : /credentials/i.test(message) ? "credentials" : "typeAddress";
  if (code === "bad_response" && /too many/i.test(message)) return "redirects";
  if (code === "bad_response" && /too large/i.test(message)) return "tooLarge";
  return "unreachable";
}

/** Failure reasons, most important first: a refusal always wins, so a blocked address is never hidden. */
const PRIORITY: FaviconMessageKey[] = ["refused", "mixedAnswer", "privateFromPublic", "publicFromPrivate", "timeout", "tooLarge", "tooManyPx", "pageTooLarge", "none"];

type Run = {
  deadline: number;
  publicOnly: boolean;
  /** The typed LAN host, once its self-signed certificate was met: only it is read without the check. */
  insecureHost?: string;
  request: (r: SafeRequest) => Promise<RawResponse>;
  now: () => number;
};

async function get(run: Run, url: string, maxBytes: number, accept: string, extra: Record<string, string> = {}): Promise<RawResponse> {
  const remaining = run.deadline - run.now();
  if (remaining <= 50) throw new FaviconRefused("timeout");
  return run.request({
    url,
    method: "GET",
    redirect: { mode: "checked" },
    maxBytes,
    timeoutMs: remaining,
    verifyTls: !(run.insecureHost && new URL(url).hostname === run.insecureHost),
    headers: { accept, ...extra, ...(run.publicOnly ? { [FAVICON_PUBLIC_HEADER]: "public-only" } : {}) },
    // A run that began on your network stays there on every hop and socket (w210c r2, SFR 2).
    ...(run.publicOnly ? { userShaped: { trustedHeaders: [] } } : { privateOnly: true }),
  });
}

/**
 * Whether the typed host is a public website (then every hop must be public), from its addresses. Refused
 * here first when any address is link-local or metadata, and when the answer mixes public and private
 * addresses: such a host is neither a plain LAN machine nor a plain website, and treating it as either
 * would let its DNS steer the server (gauntlet w210c-r1 Fix 6a).
 */
async function hostIsPublic(run: Run, resolve: (h: string) => Promise<{ address: string }[]>, host: string): Promise<boolean> {
  const remaining = run.deadline - run.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addrs = await Promise.race([
    resolve(host),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FaviconRefused("timeout")), Math.max(1, remaining));
    }),
  ]).finally(() => clearTimeout(timer));
  // The engine refuses 169.254.0.0/16, fe80::/10 and fd00:ec2::/64 at every hop. Alibaba Cloud's metadata
  // address sits in the carrier NAT range the engine allows, so the typed host is refused here too
  // (later hops: shared file request to integrations, see the N4 build report).
  if (addrs.some((a) => EXTRA_METADATA.has(a.address.replace(/^::ffff:/i, "")))) throw new FaviconRefused("refused");
  const pub = addrs.filter((a) => !isPrivateAddress(a.address)).length;
  if (pub > 0 && pub < addrs.length) throw new FaviconRefused("mixedAnswer");
  return pub > 0;
}

const EXTRA_METADATA = new Set(["100.100.100.200"]);

export type IconBytes = { bytes: Buffer; ext: string };

/**
 * One fetched icon's bytes as something uploads store: an ICO becomes its best PNG entry, a raster
 * must be at most 256 px, an SVG is sanitised by checkFile. Throws FaviconRefused naming why not.
 */
export function iconFromBytes(raw: Buffer) {
  if (raw.length === 0) throw new FaviconRefused("none");
  if (raw.length > FAVICON_MAX_ICON_BYTES) throw new FaviconRefused("tooLarge");
  let bytes = raw;
  if (isIco(raw)) {
    const r = icoToPng(raw);
    if (!r) throw new FaviconRefused("none");
    if ("tooLarge" in r) throw new FaviconRefused("tooManyPx");
    bytes = r.png;
  } else if (sniffRaster(raw)) {
    const s = imageSize(raw);
    if (!s || s.w <= 0 || s.h <= 0) throw new FaviconRefused("none");
    if (s.w > FAVICON_MAX_PX || s.h > FAVICON_MAX_PX) throw new FaviconRefused("tooManyPx");
  }
  try {
    return checkFile(bytes, "image", { maxBytes: FAVICON_MAX_ICON_BYTES });
  } catch (err) {
    if (err instanceof UploadRefused && err.status === 413) throw new FaviconRefused("tooLarge");
    throw new FaviconRefused("none");
  }
}

async function tryIcon(run: Run, c: IconCandidate) {
  if (c.url.startsWith("data:")) {
    const b = decodeDataUrl(c.url, FAVICON_MAX_ICON_BYTES);
    if (!b) throw new FaviconRefused("none");
    return iconFromBytes(b);
  }
  const res = await get(run, c.url, FAVICON_MAX_ICON_BYTES, ICON_ACCEPT);
  if (res.status < 200 || res.status >= 300) throw new FaviconRefused("none");
  return iconFromBytes(res.body);
}

/**
 * The page: the whole response; for a page over 512 KB, its first 512 KB asked for with a Range header
 * (icons are declared in the head); or `null` when the server would not send a part (then only
 * /favicon.ico is tried).
 */
async function readPage(run: Run, url: string): Promise<RawResponse | null> {
  try {
    return await get(run, url, FAVICON_MAX_PAGE_BYTES, PAGE_ACCEPT);
  } catch (err) {
    if (reasonOf(err) !== "tooLarge") throw err;
  }
  try {
    const part = await get(run, url, FAVICON_MAX_PAGE_BYTES, PAGE_ACCEPT, { range: `bytes=0-${FAVICON_MAX_PAGE_BYTES - 1}` });
    return part.status === 206 ? { ...part, status: 200 } : part;
  } catch (err) {
    if (reasonOf(err) === "tooLarge") return null;
    throw err;
  }
}

/** Fetch, pick and store one origin's icon. `start` is one of addressesFor()'s URLs. */
async function fetchOne(p: Principal, start: URL, run: Run, resolve: (h: string) => Promise<{ address: string }[]>): Promise<FaviconResult> {
  const host = start.hostname.replace(/^\[|\]$/g, "");
  try {
    run.publicOnly = await hostIsPublic(run, resolve, host);
  } catch (err) {
    throw new FaviconRefused(reasonOf(err));
  }
  let page: RawResponse | null;
  try {
    page = await readPage(run, start.toString());
  } catch (err) {
    const why = reasonOf(err);
    // A self-signed certificate is normal on a homelab: for an address on this network only, read again
    // without checking it (no credential is ever sent, and what comes back must still be an image).
    if (why === "certificate" && !run.publicOnly) {
      run.insecureHost = start.hostname;
      try {
        page = await readPage(run, start.toString());
      } catch (e2) {
        throw new FaviconRefused(reasonOf(e2));
      }
    } else throw new FaviconRefused(why);
  }
  const reasons = new Set<FaviconMessageKey>();
  const finalUrl = page?.url ?? start.toString();
  let ranked: IconCandidate[];
  let direct: Buffer | null = null;
  if (page && page.status >= 200 && page.status < 300 && (isIco(page.body) || sniffRaster(page.body))) {
    // The address is the icon itself.
    direct = page.body;
    ranked = [];
  } else {
    const text = page ? page.body.toString("utf8") : "";
    const parsed = page && looksLikeHtml(text) ? parsePage(text, finalUrl) : { icons: [], manifest: null };
    let list = parsed.icons;
    if (parsed.manifest && !goodEnough(list)) {
      try {
        const mres = await get(run, parsed.manifest, FAVICON_MAX_PAGE_BYTES, MANIFEST_ACCEPT);
        if (mres.status >= 200 && mres.status < 300) list = [...list, ...parseManifest(mres.body.toString("utf8"), mres.url)];
      } catch (err) {
        const why = reasonOf(err);
        if (why === "refused" || why === "privateFromPublic" || why === "publicFromPrivate" || why === "timeout") reasons.add(why);
      }
    }
    if (list.some((c) => c.oversized)) reasons.add("tooManyPx");
    if (!page) reasons.add("pageTooLarge");
    ranked = rankIcons([...list, fallbackIcon(finalUrl)]);
  }
  let checked: ReturnType<typeof iconFromBytes> | null = null;
  if (direct) {
    try {
      checked = iconFromBytes(direct);
    } catch (err) {
      reasons.add(reasonOf(err));
    }
  }
  for (const c of ranked.slice(0, MAX_ICON_TRIES)) {
    if (checked) break;
    try {
      checked = await tryIcon(run, c);
    } catch (err) {
      const why = reasonOf(err);
      reasons.add(why === "unreachable" || why === "certificate" || why === "redirects" || why === "typeAddress" || why === "scheme" || why === "credentials" ? "none" : why);
      if (why === "timeout") break;
    }
  }
  if (!checked) throw new FaviconRefused(PRIORITY.find((r) => reasons.has(r)) ?? "none");
  const stored = storeChecked(p, checked, `${host} icon`);
  return { path: stored.path, name: stored.name, cached: false };
}

/**
 * The icon for what the person typed: from the 7 day store when that exact address has one (unless
 * `deps.refresh`), else fetched on
 * the server and stored as an image upload. Owners and members only (agents with atrium:edit are
 * owners or members). Throws FaviconRefused with the sentence to show.
 */
export async function fetchFavicon(p: Principal, raw: unknown, deps: FaviconDeps = {}): Promise<FaviconResult> {
  if (!canUpload(p)) throw new Forbidden(M.forbidden);
  const now = deps.now ?? Date.now;
  const tries = addressesFor(raw);
  if (!deps.refresh) {
    for (const u of tries) {
      const hit = cachedIcon(cacheKey(u), now());
      if (hit) return { ...hit, cached: true };
    }
  }
  const by = p.kind === "guest" ? "" : p.userId;
  countFetch(by, now());
  const run: Run = { deadline: now() + FAVICON_TIMEOUT_MS, publicOnly: false, request: deps.request ?? safeRequest, now };
  const resolve = deps.resolve ?? resolveChecked;
  const log = logger("uploads");
  const t0 = now();
  let last: FaviconRefused | null = null;
  for (const [n, u] of tries.entries()) {
    try {
      const r = await fetchOne(p, u, run, resolve);
      remember(cacheKey(u), r.path.slice("/uploads/".length), now(), by);
      log.info("favicon_stored", { ms: now() - t0, scheme: u.protocol.replace(":", "") });
      return r;
    } catch (err) {
      if (!(err instanceof FaviconRefused)) throw err;
      last = err;
      // With no scheme typed, http is tried only when https could not connect at all.
      const retry = n + 1 < tries.length && (err.reason === "unreachable" || err.reason === "certificate");
      if (!retry) break;
      run.insecureHost = undefined;
    }
  }
  log.info("favicon_refused", { ms: now() - t0, reason: last?.reason ?? "none" });
  throw last ?? new FaviconRefused("none");
}

