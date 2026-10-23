// Small helpers over an OpenAPI 3 or Swagger 2 document's schemas: local $ref resolution with
// allOf merged and cycles guarded, and the property list of an object schema. Pure.
import type { SpecDoc } from "./load";

export type S = Record<string, unknown>;

function lookupRef(doc: SpecDoc, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as S)[part];
  }
  return cur;
}

/** Follows $ref (local only) and merges allOf, at most 8 levels deep. */
export function resolve(doc: SpecDoc, v: unknown, depth = 0): S | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v) || depth > 8) return undefined;
  let s = v as S;
  if (typeof s.$ref === "string") return resolve(doc, lookupRef(doc, s.$ref), depth + 1);
  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map((p) => resolve(doc, p, depth + 1)).filter((p): p is S => !!p);
    const properties: S = {};
    const required: string[] = [];
    let type: unknown;
    for (const p of [...parts, s]) {
      if (p.properties && typeof p.properties === "object") Object.assign(properties, p.properties);
      if (Array.isArray(p.required)) required.push(...(p.required as string[]));
      if (p.type) type = p.type;
    }
    const { allOf: _drop, ...rest } = s;
    void _drop;
    s = { ...rest, type: type ?? "object", properties, required };
  }
  // A one-of or any-of with a single real choice (nullable wrappers) is that choice.
  for (const k of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(s[k])) {
      const real = (s[k] as unknown[]).map((p) => resolve(doc, p, depth + 1)).filter((p): p is S => !!p && p.type !== "null");
      if (real.length === 1) return { ...real[0], ...(s.description ? { description: s.description } : {}) };
    }
  }
  return s;
}

/** A schema's type, with OpenAPI 3.1 type lists ("string", "null") reduced to the first real one. */
export function typeOf(s: S | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.type;
  if (Array.isArray(t)) return t.find((x) => x !== "null") as string | undefined;
  if (typeof t === "string") return t;
  if (s.properties) return "object";
  if (s.items) return "array";
  return undefined;
}

/** An object schema's properties, each resolved. */
export function propsOf(doc: SpecDoc, s: S | undefined): [string, S][] {
  if (!s || !s.properties || typeof s.properties !== "object") return [];
  return Object.entries(s.properties as S).flatMap(([k, v]) => {
    const r = resolve(doc, v);
    return r ? [[k, r] as [string, S]] : [];
  });
}

export function isScalar(t: string | undefined): boolean {
  return t === "string" || t === "integer" || t === "number" || t === "boolean";
}
