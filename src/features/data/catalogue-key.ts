// A10.1 and A10.4: the canonical params of a read (keys sorted, values equal to the schema default
// dropped, empty values dropped) and the catalogue key `<integrationId>|<endpointId>|<canonical JSON>`.
// Pure, no I/O: the catalogue, peek, the builder's managed sources and agent tools share it.
import type { PropValue } from "@/core/contracts";
import { canonicalJson } from "./keys";

type Props = Record<string, { default?: unknown }>;

/** Params with defaults and empty values dropped, keys sorted. */
export function canonicalParams(params: Record<string, unknown> | undefined, schema?: unknown): Record<string, PropValue> {
  const props = (((schema as { properties?: Props } | undefined)?.properties ?? {}) as Props);
  const out: Record<string, PropValue> = {};
  for (const k of Object.keys(params ?? {}).sort()) {
    const v = params![k];
    if (v === undefined || v === null || v === "") continue;
    const d = props[k]?.default;
    if (d !== undefined && canonicalJson(d) === canonicalJson(v)) continue;
    out[k] = v as PropValue;
  }
  return out;
}

/** The catalogue key of one read of one thing. */
export function catalogueKey(integrationId: string, endpointId: string, params: Record<string, unknown> | undefined, schema?: unknown): string {
  return `${integrationId}|${endpointId}|${canonicalJson(canonicalParams(params, schema))}`;
}

/** Splits a catalogue key back into its parts, or null when it is not one. */
export function parseCatalogueKey(key: string): { integrationId: string; endpointId: string; params: Record<string, PropValue> } | null {
  const a = key.indexOf("|");
  const b = a < 0 ? -1 : key.indexOf("|", a + 1);
  if (a <= 0 || b <= a + 1) return null;
  try {
    const params = JSON.parse(key.slice(b + 1)) as unknown;
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    return { integrationId: key.slice(0, a), endpointId: key.slice(a + 1, b), params: params as Record<string, PropValue> };
  } catch {
    return null;
  }
}
