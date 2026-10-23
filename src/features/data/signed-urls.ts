// Bound external images (architecture v3 section 13 "External images", amendment A4.2). The server
// marks every absolute http(s) URL string it sends with its signed proxy path (`/api/img?u=...&s=...`)
// in a parallel `signedUrls` map. Images show a URL only when they find it in that map (or in the map
// signed from a published document), so a URL a template composes in the browser, which the server
// never sent, gets no signature and the proxy is never an open fetcher. Pure: the signer is passed in
// (settings' `signImageUrl`, server only).

/** Signs one absolute URL; null when the address rules refuse it. */
export type UrlSigner = (url: string) => string | null;

/** A whole string that is one absolute http(s) URL (no spaces, nothing around it). */
const ABSOLUTE_HTTP = /^https?:\/\/[^\s]+$/i;
const MAX_URLS = 500;
const MAX_DEPTH = 32;

/**
 * Every absolute http(s) URL string inside a JSON-like value. `skipTemplates` leaves out strings that
 * hold a binding template (`{{ ... }}`), for documents: a template is not a URL the server sent.
 */
export function collectUrls(value: unknown, opts: { skipTemplates?: boolean } = {}, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (out.size >= MAX_URLS || depth > MAX_DEPTH) return out;
  if (typeof value === "string") {
    if (ABSOLUTE_HTTP.test(value) && !(opts.skipTemplates && value.includes("{{"))) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, opts, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectUrls(v, opts, out, depth + 1);
  }
  return out;
}

/** The `signedUrls` map for a value: each absolute URL in it, signed (URLs the signer refuses are left out). */
export function signedUrlsFor(value: unknown, sign: UrlSigner, opts: { skipTemplates?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const url of collectUrls(value, opts)) {
    const s = sign(url);
    if (s) out[url] = s;
  }
  return out;
}

/**
 * For a guest's resolved values: only URLs that appear verbatim both in the values sent and in the
 * source data they were resolved from. A URL the published page's template composed on the server is
 * not in the source data, so it is not signed either.
 */
export function signedUrlsForValues(values: Record<string, unknown>, sources: unknown, sign: UrlSigner): Record<string, string> {
  const sent = collectUrls(values);
  if (!sent.size) return {};
  const fromData = collectUrls(sources);
  const out: Record<string, string> = {};
  for (const url of sent) {
    if (!fromData.has(url)) continue;
    const s = sign(url);
    if (s) out[url] = s;
  }
  return out;
}

/**
 * Settings r2 (gauntlet w2-r1 items 3 and 4): one signer per data source, so each source's URLs are
 * signed with that source's own rules (its integration's host, the page's app, the caller's kind).
 * A source with no signer signs nothing.
 */
export type SourceSigner = (sourceKey: string) => UrlSigner | null;

/** The `signedUrls` map for data keyed by source: each source's URLs signed by its own signer. */
export function signedUrlsBySource(bySource: Record<string, unknown>, signerFor: SourceSigner): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bySource)) {
    const sign = signerFor(key);
    if (!sign) continue;
    for (const [url, path] of Object.entries(signedUrlsFor(value, sign))) if (!(url in out)) out[url] = path;
  }
  return out;
}

/**
 * signedUrlsForValues with a signer per source: a URL in the guest's resolved values is signed only
 * when it is verbatim in a source's data, by that source's signer.
 */
export function signedUrlsForValuesBySource(values: Record<string, unknown>, bySource: Record<string, unknown>, signerFor: SourceSigner): Record<string, string> {
  const sent = collectUrls(values);
  if (!sent.size) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bySource)) {
    const sign = signerFor(key);
    if (!sign) continue;
    for (const url of collectUrls(value)) {
      if (!sent.has(url) || url in out) continue;
      const s = sign(url);
      if (s) out[url] = s;
    }
  }
  return out;
}
