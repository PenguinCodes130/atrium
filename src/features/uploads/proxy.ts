// The external image proxy behind /api/img (architecture 13): the route checks the signature, then this
// applies the signature's network rule at every hop through integrations' safeRequest, accepts only
// image responses up to 5 MB (checked from the bytes, not the header), re-sanitises SVG and caches for
// 1 hour (keyed by network rule and URL, so a LAN image fetched for a typed document URL is never
// handed to a public-only signature for the same address).
//
// Network rules (sign.ts): "document" and "host" use detection's rules (link-local and metadata refused,
// LAN allowed); "host" also keeps redirects on the same origin (safeRequest's "same-host" mode compares
// scheme, host and port, so a redirect to another port on the integration's machine is refused). "public" refuses every loopback, private
// and other non-public address at every hop, after DNS and again when the socket connects: the request
// is marked as one Atrium did not shape for the LAN (safeRequest's userShaped rule with a non-standard
// header), so safeRequest refuses private addresses and pins the socket to public ones.
import "server-only";
import { AtriumError } from "@/core/errors";
import { safeRequest } from "@/features/integrations/host/request";
import { HostError } from "@/features/integrations/host/errors";
import { imageUrlProblem, type ImageNet } from "./sign";
import { sniff } from "./sniff";
import { sanitiseSvg } from "./svg";

export const MAX_PROXY_BYTES = 5 * 1024 * 1024;
export const PROXY_CACHE_MS = 60 * 60 * 1000;
const CACHE_LIMIT_BYTES = 64 * 1024 * 1024;

type Entry = { at: number; mime: string; bytes: Buffer };
const cache = new Map<string, Entry>();
let cacheBytes = 0;

export function clearImageCache(): void {
  cache.clear();
  cacheBytes = 0;
}

const ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml";
/** Sent only to public hosts. Its presence is what makes safeRequest refuse every non-public hop. */
export const PUBLIC_ONLY_HEADER = "x-atrium-image-proxy";

export class ImageRefused extends AtriumError {
  constructor(message: string, status = 502) {
    super(message, status, "image_refused");
  }
}

function remember(url: string, e: Entry) {
  while (cacheBytes + e.bytes.length > CACHE_LIMIT_BYTES && cache.size) {
    const [k, v] = cache.entries().next().value as [string, Entry];
    cache.delete(k);
    cacheBytes -= v.bytes.length;
  }
  cache.set(url, e);
  cacheBytes += e.bytes.length;
}

/** Fetch one external image (the signature is checked by the caller). Throws ImageRefused naming why. */
export async function fetchImage(url: string, opts: { net?: ImageNet; now?: number } = {}): Promise<{ mime: string; bytes: Buffer; cached: boolean }> {
  const now = opts.now ?? Date.now();
  const net: ImageNet = opts.net ?? "document";
  const cacheKey = `${net}|${url}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < PROXY_CACHE_MS) return { mime: hit.mime, bytes: hit.bytes, cached: true };
  if (hit) {
    cache.delete(cacheKey);
    cacheBytes -= hit.bytes.length;
  }
  const problem = imageUrlProblem(url);
  if (problem) throw new ImageRefused(`This image address is not allowed (${problem}).`, 403);
  let res;
  try {
    res = await safeRequest({
      url,
      method: "GET",
      redirect: net === "host" ? { mode: "same-host", message: "The image redirected to another host." } : { mode: "checked" },
      maxBytes: MAX_PROXY_BYTES,
      headers: { accept: ACCEPT, ...(net === "public" ? { [PUBLIC_ONLY_HEADER]: "public-only" } : {}) },
      ...(net === "public" ? { userShaped: { trustedHeaders: [] } } : {}),
    });
  } catch (err) {
    if (err instanceof HostError) {
      const code = err.adapterError.code;
      if (code === "permission" && net === "public") throw new ImageRefused("This image address is not allowed (it is not a public address, and it came from integration data).", 403);
      if (code === "permission" && net === "host") throw new ImageRefused("This image address is not allowed (it left the integration's own host).", 403);
      if (code === "permission") throw new ImageRefused("This image address is not allowed (link-local or metadata address).", 403);
      if (code === "bad_response" && /too large/i.test(err.adapterError.message)) throw new ImageRefused("The image is larger than 5 MB.", 413);
      throw new ImageRefused("The image could not be loaded.");
    }
    throw new ImageRefused("The image could not be loaded.");
  }
  if (res.status < 200 || res.status >= 300) throw new ImageRefused("The image could not be loaded.");
  const declared = (res.headers["content-type"] ?? "").toLowerCase();
  if (!declared.startsWith("image/")) throw new ImageRefused("That address did not answer with an image.", 415);
  const found = sniff(res.body, "image");
  if (!found) throw new ImageRefused("That address did not answer with an image.", 415);
  let bytes = res.body;
  if (found.mime === "image/svg+xml") {
    const s = sanitiseSvg(bytes.toString("utf8"));
    if (!s) throw new ImageRefused("That SVG could not be read.", 415);
    bytes = Buffer.from(s.svg, "utf8");
  }
  remember(cacheKey, { at: now, mime: found.mime, bytes });
  return { mime: found.mime, bytes, cached: false };
}
