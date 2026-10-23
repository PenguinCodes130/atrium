// Detection on "Add integration" (architecture v2 section 3): each package's detect rule, then the
// spec probe list (JSON and YAML, Wave 2.8 spec import v2; spec fetches may read 10 MB). Every hop
// is checked against the address rules (section 13).
import "server-only";
import type { AdapterError, EndpointSummary } from "@/core/contracts";
import { HostError, hostError } from "./host/errors";
import { safeRequest, type RawResponse } from "./host/request";
import { OPENAPI_PATHS, parseOpenApi } from "./openapi";
import { getSpecBody, specFrom } from "./spec/fetch";
import type { LoadedPackage } from "./registry";

export type DetectResult = { url: string; matches: string[]; openapi?: EndpointSummary[]; openapiUrl?: string; error?: AdapterError };

export function normalizeUrl(input: string): URL {
  const raw = input.trim();
  if (!raw) throw hostError("config", "Paste the address of the service.");
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    if (u.username || u.password) throw hostError("config", "Put credentials in a secret field, not in the address.");
    return u;
  } catch (err) {
    if (err instanceof HostError) throw err;
    throw hostError("config", "That address is not a valid URL.", "Use a full address such as http://10.0.0.5:8080.");
  }
}

async function get(url: URL, signal: AbortSignal): Promise<RawResponse> {
  return safeRequest({ url: url.toString(), method: "GET", redirect: { mode: "checked" }, verifyTls: false, signal, maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 });
}

function probeUrls(base: URL, path: string): URL[] {
  if (path === "/") return [base];
  const dir = new URL(base);
  if (!dir.pathname.endsWith("/")) dir.pathname += "/";
  const rel = new URL(path.replace(/^\//, ""), dir);
  const abs = new URL(path, base.origin);
  return rel.toString() === abs.toString() ? [abs] : [rel, abs];
}

/**
 * Extra checks some packages need beyond their manifest rule. Home Assistant (architecture v3
 * section 3.2): the /manifest.json probe must name it AND GET <base>/api/ must answer 401 without
 * a token, so a page that only mentions Home Assistant is not offered.
 */
const EXTRA_CHECKS: Record<string, (base: URL, fetchOnce: (u: URL) => Promise<RawResponse | HostError>) => Promise<boolean>> = {
  "home-assistant": async (base, fetchOnce) => {
    for (const u of probeUrls(base, "/api/")) {
      const r = await fetchOnce(u);
      if (!(r instanceof HostError) && r.status === 401) return true;
    }
    return false;
  },
};

export async function detect(input: string, packages: LoadedPackage[], signal?: AbortSignal): Promise<DetectResult> {
  const base = normalizeUrl(input);
  const deadline = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  const cache = new Map<string, Promise<RawResponse | HostError>>();
  const fetchOnce = (u: URL) => {
    const k = u.toString();
    let p = cache.get(k);
    if (!p) {
      p = get(u, deadline).catch((e: unknown) => (e instanceof HostError ? e : new HostError({ code: "unreachable", message: "The service could not be reached." })));
      cache.set(k, p);
    }
    return p;
  };
  const first = await fetchOnce(base);
  // A blocked address is refused outright, never probed further.
  if (first instanceof HostError && first.adapterError.code === "permission") throw first;
  const matches: string[] = [];
  await Promise.all(
    packages.map(async (pkg) => {
      const d = pkg.manifest.detect;
      if (!d) return;
      if (d.serverHeader && !(first instanceof HostError)) {
        const server = first.headers.server ?? "";
        if (new RegExp(d.serverHeader, "i").test(server)) { matches.push(pkg.manifest.id); return; }
      }
      if (d.probe) {
        const re = new RegExp(d.probe.match, "i");
        for (const u of probeUrls(base, d.probe.path)) {
          const r = await fetchOnce(u);
          if (!(r instanceof HostError) && r.status < 400 && re.test(r.body.toString("utf8").slice(0, 512 * 1024))) {
            const extra = EXTRA_CHECKS[pkg.manifest.id];
            if (extra && !(await extra(base, fetchOnce))) return;
            matches.push(pkg.manifest.id);
            return;
          }
        }
      }
    }),
  );
  const order = new Map(packages.map((p, i) => [p.manifest.id, i]));
  matches.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  let openapi: EndpointSummary[] | undefined;
  let openapiUrl: string | undefined;
  const specUrls = OPENAPI_PATHS.flatMap((p) => probeUrls(base, p));
  // Spec probes read up to 10 MB each (A9.3); a probe already fetched by a package rule is reused.
  const specs = await Promise.all(specUrls.map(async (u) => {
    const seen = cache.get(u.toString());
    const r = seen ? await seen : await getSpecBody(u, deadline, false).catch((e: unknown) => (e instanceof HostError ? e : new HostError({ code: "unreachable", message: "The service could not be reached." })));
    return { u, r };
  }));
  for (const { u, r } of specs) {
    if (r instanceof HostError) continue;
    const doc = specFrom(r);
    if (doc) { openapi = parseOpenApi(doc); openapiUrl = u.toString(); break; }
  }
  const out: DetectResult = { url: base.toString(), matches };
  if (openapi) { out.openapi = openapi; out.openapiUrl = openapiUrl; }
  if (first instanceof HostError && matches.length === 0 && !openapi) out.error = first.adapterError;
  return out;
}
