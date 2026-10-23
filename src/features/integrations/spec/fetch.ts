// Finding and downloading a spec (research 2.2 "Find the spec"): the probe list, JSON and YAML, a
// pasted spec URL, all through the host's address rules (section 13) with a 10 MB limit for spec
// fetches only (A9.3). No credentials are ever sent with a spec fetch.
import "server-only";
import { HostError, statusError } from "../host/errors";
import { safeRequest, type RawResponse } from "../host/request";
import { OPENAPI_PATHS } from "../openapi";
import { isSpec, looksLikeJson, parseSpecText, SPEC_MAX_BYTES, SpecError, type SpecDoc } from "./load";

/** Where services publish their spec (shared with detection). */
export const SPEC_PATHS = OPENAPI_PATHS;

/** Services whose spec lives only in their source repository (research 2.2), found by a pasted URL instead. */
export const KNOWN_SPEC_URLS: { name: string; url: string }[] = [
  { name: "Sonarr", url: "https://raw.githubusercontent.com/Sonarr/Sonarr/develop/src/Sonarr.Api.V3/openapi.json" },
  { name: "Radarr", url: "https://raw.githubusercontent.com/Radarr/Radarr/develop/src/Radarr.Api.V3/openapi.json" },
  { name: "Lidarr", url: "https://raw.githubusercontent.com/Lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json" },
  { name: "Prowlarr", url: "https://raw.githubusercontent.com/Prowlarr/Prowlarr/develop/src/Prowlarr.Api.V1/openapi.json" },
  { name: "Immich", url: "https://raw.githubusercontent.com/immich-app/immich/main/open-api/immich-openapi-specs.json" },
];

const ACCEPT = "application/json, application/yaml;q=0.9, application/x-yaml;q=0.9, text/yaml;q=0.8, */*;q=0.5";

/** The URLs a probe path means for an address with a path: under the address, then at its root. */
export function probeUrls(base: URL, path: string): URL[] {
  const dir = new URL(base);
  if (!dir.pathname.endsWith("/")) dir.pathname += "/";
  const rel = new URL(path.replace(/^\//, ""), dir);
  const abs = new URL(path, base.origin);
  return rel.toString() === abs.toString() ? [abs] : [rel, abs];
}

export async function getSpecBody(url: URL, signal?: AbortSignal, verifyTls = true): Promise<RawResponse> {
  return safeRequest({ url: url.toString(), method: "GET", headers: { accept: ACCEPT }, redirect: { mode: "checked" }, verifyTls, ...(signal ? { signal } : {}), maxBytes: SPEC_MAX_BYTES, timeoutMs: 15_000 });
}

/** A spec from a response, or undefined when it is not one. YAML is tried only when it does not look like JSON or HTML. */
export function specFrom(r: RawResponse): SpecDoc | undefined {
  if (r.status >= 400) return undefined;
  const text = r.body.toString("utf8");
  if (/^\s*</.test(text)) return undefined;
  if (!looksLikeJson(text) && !/^\s*(openapi|swagger)\s*:/m.test(text.slice(0, 4096))) return undefined;
  try {
    const d = parseSpecText(text);
    return isSpec(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

/** Downloads and parses a spec at a URL a person pasted (already checked by normalizeUrl). Errors are SpecError or HostError. */
export async function fetchSpec(u: URL, opts: { signal?: AbortSignal; sameOriginAs?: string } = {}): Promise<{ doc: SpecDoc; url: string }> {
  // A spec served by the service itself may use its self-signed certificate, like detection does.
  const own = !!opts.sameOriginAs && (() => { try { return new URL(opts.sameOriginAs!).origin === u.origin; } catch { return false; } })();
  let r: RawResponse;
  try {
    r = await getSpecBody(u, opts.signal, !own);
  } catch (err) {
    if (err instanceof HostError && err.adapterError.message === "The response was too large.") throw new SpecError("This spec is larger than 10 MB, the most Atrium reads.");
    throw err;
  }
  const err = statusError(r.status);
  if (err) throw new HostError(err);
  return { doc: parseSpecText(r.body.toString("utf8")), url: r.url };
}

/** Probes the address for a spec at every known path. Returns the first that parses. */
export async function findSpec(base: URL, signal?: AbortSignal): Promise<{ doc: SpecDoc; url: string } | undefined> {
  const urls = SPEC_PATHS.flatMap((p) => probeUrls(base, p));
  const deadline = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
  const results = await Promise.all(urls.map(async (u) => {
    try { return { u, r: await getSpecBody(u, deadline, false) }; } catch (e) {
      if (e instanceof HostError && e.adapterError.code === "permission") throw e;
      return { u, r: undefined };
    }
  }));
  for (const { r } of results) {
    if (!r) continue;
    const doc = specFrom(r);
    if (doc) return { doc, url: r.url };
  }
  return undefined;
}
