import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so equal params give equal keys. */
export function canonicalJson(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export type SourceRef = { integrationId: string; endpointId: string; params?: unknown };

/** Cache key: sha256(integrationId, endpointId, canonicalJson(params)) (architecture v2 section 10). */
export function cacheKey(s: SourceRef): string {
  return createHash("sha256").update(JSON.stringify([s.integrationId, s.endpointId, canonicalJson(s.params ?? null)])).digest("hex");
}
