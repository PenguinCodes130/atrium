// A command control's parameters (architecture v3 section 6.2; gauntlet w2-r2 item 2). Pure and
// client-safe: the builder's control form and the server's publish checks share these rules.
//
// Target params (the command's target, such as entityId) are picked from the target list and are never
// listed here. Every other param gets a source: the control's own value (`$input`: the toggle's on or
// off, the slider's number, the menu's choice), a fixed value, or the viewer's name. A command with one
// such param whose type fits the component's value is mapped to `$input` automatically.
import type { CommandDef, PropValue } from "@/core/contracts";

export type ParamType = "boolean" | "number" | "integer" | "string" | "other";
export type ParamRow = { name: string; title: string; type: ParamType; required: boolean; options?: (string | number | boolean)[] };
export type ParamSource = "input" | "fixed" | "viewer" | "none";

type Schema = { properties?: Record<string, { type?: string; title?: string; enum?: unknown[] }>; required?: string[] };

export const INPUT_BINDING = "{{ $input }}";
export const VIEWER_BINDING = "{{ $viewer.name }}";

const isBinding = (v: unknown): v is { $bind: string } => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bind?: unknown }).$bind === "string";

/** The command's target param names, in both spellings the params may use. */
export function targetNames(def: Pick<CommandDef, "params" | "target">): string[] {
  if (!def.target) return [];
  const camel = def.target.field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const props = Object.keys((def.params as Schema).properties ?? {});
  return [...new Set([def.target.field, camel].filter((n) => props.includes(n)))];
}

/** The params a control maps itself (every param but the target), in schema order. */
export function paramRows(def: Pick<CommandDef, "params" | "target">): ParamRow[] {
  const s = def.params as Schema;
  const targets = targetNames(def);
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {})
    .filter(([name]) => !targets.includes(name))
    .map(([name, p]) => {
      const t = p?.type;
      const type: ParamType = t === "boolean" || t === "number" || t === "integer" || t === "string" ? t : "other";
      const options = Array.isArray(p?.enum) ? p.enum.filter((x): x is string | number | boolean => ["string", "number", "boolean"].includes(typeof x)) : undefined;
      return { name, title: p?.title?.trim() || name, type, required: required.has(name), ...(options?.length ? { options } : {}) };
    });
}

/** The param types each component's value fits. */
function fits(nodeType: string, t: ParamType): boolean {
  if (nodeType === "toggle") return t === "boolean";
  if (nodeType === "slider") return t === "number" || t === "integer";
  if (nodeType === "select") return t === "string" || t === "number" || t === "integer" || t === "boolean";
  return false;
}

/**
 * The automatic mapping for a new control: when the command has exactly one param (besides the
 * target) and the component's value fits its type, that param takes the control's value.
 */
export function autoParams(def: Pick<CommandDef, "params" | "target">, nodeType: string): Record<string, PropValue> {
  const rows = paramRows(def);
  const only = rows.length === 1 ? rows[0]! : rows.filter((r) => r.required).length === 1 ? rows.find((r) => r.required)! : null;
  return only && fits(nodeType, only.type) ? { [only.name]: { $bind: INPUT_BINDING } } : {};
}

/** Where a param's value comes from today. */
export function sourceOf(v: PropValue | undefined): ParamSource {
  if (v === undefined || v === null || v === "") return "none";
  if (isBinding(v)) {
    const t = v.$bind.replace(/\s+/g, "");
    if (t === "{{$input}}") return "input";
    if (t === "{{$viewer.name}}") return "viewer";
    return "fixed";
  }
  return "fixed";
}

/** A fixed value typed in the form, as the param's type. */
export function fixedValue(row: Pick<ParamRow, "type">, text: string): PropValue {
  if (row.type === "boolean") return text === "true";
  if (row.type === "number" || row.type === "integer") {
    const n = Number(text);
    return text.trim() !== "" && Number.isFinite(n) ? n : text;
  }
  if (row.type === "other") {
    // Lists and objects (an RGB colour like [255, 180, 0]) are typed as JSON; anything else stays text.
    try {
      return JSON.parse(text) as PropValue;
    } catch {
      return text;
    }
  }
  return text;
}

/** Required params (besides the target) that have no value in the control: each run would fail. */
export function missingParams(def: Pick<CommandDef, "params" | "target">, params: Record<string, PropValue> | undefined): ParamRow[] {
  return paramRows(def).filter((r) => r.required && sourceOf(params?.[r.name]) === "none");
}

/** `{{ params.<name> }}` placeholders a Custom API or declarative command's body fills (integrations' rule). */
export function sentParamNames(body: unknown): string[] {
  const names = new Set<string>();
  const text = JSON.stringify(body ?? null) ?? "";
  for (const m of text.matchAll(/\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) names.add(m[1]!);
  return [...names];
}

/**
 * Gauntlet w2-r3 item 3: params the control gives a value that the command never sends. Only a record
 * command (Custom API or declarative, `record` given) can drop one: its path and query are literal and
 * only its body's `{{ params.<name> }}` placeholders carry values. A code package's command receives
 * every param.
 */
export function unsentParams(def: Pick<CommandDef, "params" | "target">, record: { body?: unknown } | undefined, params: Record<string, PropValue> | undefined): ParamRow[] {
  if (!record) return [];
  const sent = new Set(sentParamNames(record.body));
  return paramRows(def).filter((r) => sourceOf(params?.[r.name]) !== "none" && !sent.has(r.name));
}
