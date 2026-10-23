// Command parameter validation (architecture v3 section 3.1): a small, strict JSON Schema subset.
// Every command's params are checked here before an adapter or the generic runner sees them, and
// a failure names the parameter. Pure, no I/O.
import type { JsonSchema } from "@/core/contracts";

export type ParamCheck = { ok: true; value: Record<string, unknown> } | { ok: false; param: string; message: string };

type S = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  items?: S;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, S>;
  required?: string[];
  additionalProperties?: boolean;
};

const MAX_STRING = 4096;
const MAX_DEPTH = 4;

function check(s: S, v: unknown, name: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return `"${name}" is nested too deeply.`;
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === v)) return `"${name}" must be one of: ${s.enum.map(String).join(", ")}.`;
  switch (s.type) {
    case "string": {
      if (typeof v !== "string") return `"${name}" must be text.`;
      if (v.length > (s.maxLength ?? MAX_STRING)) return `"${name}" is longer than ${s.maxLength ?? MAX_STRING} characters.`;
      if (s.minLength !== undefined && v.length < s.minLength) return `"${name}" must be at least ${s.minLength} characters.`;
      if (s.pattern && !new RegExp(s.pattern, "u").test(v)) return `"${name}" is not in the expected form.`;
      return null;
    }
    case "number":
    case "integer": {
      if (typeof v !== "number" || !Number.isFinite(v)) return `"${name}" must be a number.`;
      if (s.type === "integer" && !Number.isInteger(v)) return `"${name}" must be a whole number.`;
      if (s.minimum !== undefined && v < s.minimum) return `"${name}" must be at least ${s.minimum}.`;
      if (s.maximum !== undefined && v > s.maximum) return `"${name}" must be at most ${s.maximum}.`;
      if (s.multipleOf !== undefined && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) return `"${name}" must be a multiple of ${s.multipleOf}.`;
      return null;
    }
    case "boolean":
      return typeof v === "boolean" ? null : `"${name}" must be true or false.`;
    case "array": {
      if (!Array.isArray(v)) return `"${name}" must be a list.`;
      if (s.minItems !== undefined && v.length < s.minItems) return `"${name}" needs at least ${s.minItems} items.`;
      if (v.length > (s.maxItems ?? 100)) return `"${name}" has more than ${s.maxItems ?? 100} items.`;
      if (s.items) for (let i = 0; i < v.length; i++) { const e = check(s.items, v[i], `${name}[${i}]`, depth + 1); if (e) return e; }
      return null;
    }
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return `"${name}" must be an object.`;
      return checkObject(s, v as Record<string, unknown>, `${name}.`, depth + 1).error;
    }
    default:
      // A schema with no type accepts only plain values, never objects (no surprise structure).
      return v === null || ["string", "number", "boolean"].includes(typeof v) ? null : `"${name}" must be a plain value.`;
  }
}

function checkObject(s: S, v: Record<string, unknown>, prefix: string, depth: number): { error: string | null; param?: string } {
  const props = s.properties ?? {};
  for (const r of s.required ?? []) if (v[r] === undefined || v[r] === null) return { error: `"${prefix}${r}" is required.`, param: `${prefix}${r}` };
  for (const [k, x] of Object.entries(v)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return { error: `"${prefix}${k}" is not allowed.`, param: `${prefix}${k}` };
    const ps = props[k];
    if (!ps) {
      // Unknown parameters are refused unless the schema says otherwise: nothing unchecked reaches a request.
      if (s.additionalProperties === true) continue;
      return { error: `"${prefix}${k}" is not a parameter of this command.`, param: `${prefix}${k}` };
    }
    if (x === undefined) continue;
    const e = check(ps, x, `${prefix}${k}`, depth);
    if (e) return { error: e, param: `${prefix}${k}` };
  }
  return { error: null };
}

/** Validates command params. Returns a copy holding only declared, checked values. */
export function validateParams(schema: JsonSchema | undefined, input: unknown): ParamCheck {
  const s = (schema ?? { type: "object", properties: {} }) as S;
  const value = input === undefined || input === null ? {} : input;
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, param: "(params)", message: "The parameters must be an object." };
  const r = checkObject(s, value as Record<string, unknown>, "", 0);
  if (r.error) return { ok: false, param: r.param ?? "(params)", message: r.error };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(value as Record<string, unknown>)) if (x !== undefined) out[k] = x;
  return { ok: true, value: out };
}

/** The property schema of one parameter, if declared. */
export function paramSchema(schema: JsonSchema | undefined, name: string): JsonSchema | undefined {
  return ((schema as S | undefined)?.properties?.[name] as JsonSchema | undefined) ?? undefined;
}

/** A params schema with some properties removed (target fields an html block may never fill). */
export function withoutParams(schema: JsonSchema | undefined, names: string[]): JsonSchema {
  const s = (schema ?? { type: "object", properties: {} }) as S;
  const properties = Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => !names.includes(k)));
  return { ...s, type: "object", properties, required: (s.required ?? []).filter((r) => !names.includes(r)), additionalProperties: false } as JsonSchema;
}

/**
 * Fills "{{ params.<name> }}" placeholders in a custom command body, after validation only.
 * A string that is exactly one placeholder takes the parameter's raw value (number, boolean, list);
 * placeholders inside longer strings are replaced by the value as text. Unknown names become empty.
 */
export function fillPlaceholders(body: unknown, params: Record<string, unknown>, depth = 0): unknown {
  if (depth > 8) return body;
  const re = /\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  if (typeof body === "string") {
    const whole = /^\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(body);
    if (whole) return params[whole[1]!] ?? null;
    return body.replace(re, (_, n: string) => {
      const v = params[n];
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(body)) return body.map((b) => fillPlaceholders(b, params, depth + 1));
  if (body && typeof body === "object") return Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, fillPlaceholders(v, params, depth + 1)]));
  return body;
}

/** Placeholder names used in a body, for validation at save time. */
export function placeholderNames(body: unknown): string[] {
  const names = new Set<string>();
  const text = JSON.stringify(body ?? null);
  for (const m of text.matchAll(/\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) names.add(m[1]!);
  return [...names];
}
