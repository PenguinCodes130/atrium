// A8.2 live choices: reading a parameter's `x-atrium-choices` descriptor, and turning an endpoint's
// rows into choices. Pure, no I/O, so the listing, the choices route and tests share it.
//
//   "x-atrium-choices": { "endpointId": "machines", "value": "instance", "label": "name",
//                         "detail"?: "detail", "every"?: true,
//                         "params"?: { "<param of endpointId>": "<sibling param of this endpoint>" } }
//
// `params` (an additive Wave 2.7 extension of A8.2) makes a list depend on another setting: the disks
// of the chosen machine. The picker sends the current values; the route passes only those named here.
import type { JsonSchema, ShapedData } from "@/core/contracts";

export type ChoicesSpec = { endpointId: string; value: string; label: string; detail?: string; every: boolean; params?: Record<string, string> };
export type Choice = { value: string; label: string; detail?: string };

export const MAX_CHOICES = 500;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/;

function spec(v: unknown): ChoicesSpec | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
  const endpointId = s("endpointId"), value = s("value");
  if (!endpointId || !value) return null;
  const params = o.params && typeof o.params === "object" && !Array.isArray(o.params)
    ? Object.fromEntries(Object.entries(o.params as Record<string, unknown>).filter(([k, x]) => KEY.test(k) && typeof x === "string" && KEY.test(x)) as [string, string][])
    : undefined;
  return { endpointId, value, label: s("label") ?? value, ...(s("detail") ? { detail: s("detail")! } : {}), every: o.every === true, ...(params && Object.keys(params).length ? { params } : {}) };
}

/** Every parameter of a params schema that declares live choices. */
export function choicesSpecs(params: JsonSchema | undefined): Record<string, ChoicesSpec> {
  const props = ((params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, ChoicesSpec> = {};
  for (const [k, p] of Object.entries(props)) {
    const sp = p && typeof p === "object" ? spec((p as Record<string, unknown>)["x-atrium-choices"]) : null;
    if (sp) out[k] = sp;
  }
  return out;
}

/** The listing's summary of one endpoint's live-choice params (for the picker). */
export function choicesSummary(params: JsonSchema | undefined): { param: string; endpointId: string; every: boolean; dependsOn?: string[] }[] {
  return Object.entries(choicesSpecs(params)).map(([param, s]) => ({ param, endpointId: s.endpointId, every: s.every, ...(s.params ? { dependsOn: [...new Set(Object.values(s.params))] } : {}) }));
}

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? "" : String(v));

/**
 * Choices from shaped data: table rows (value, label, detail columns) or status items (whose fields
 * are label, state and detail). Only those three fields leave; duplicates and empty values are dropped;
 * `q` filters by words in the label, value or detail; at most 500.
 */
export function choicesFrom(data: ShapedData | undefined, s: ChoicesSpec, q?: string): { choices: Choice[]; total: number } {
  const rows: Record<string, unknown>[] = !data ? [] : data.kind === "table" ? data.rows : data.kind === "status" ? data.items.map((i) => ({ ...i })) : [];
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const out: Choice[] = [];
  let total = 0;
  for (const r of rows) {
    const value = text(r[s.value]).slice(0, 512);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = (text(r[s.label]) || value).slice(0, 200);
    const detail = s.detail ? text(r[s.detail]).slice(0, 300) : "";
    if (words.length) {
      const hay = `${label} ${value} ${detail}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    total++;
    if (out.length < MAX_CHOICES) out.push({ value, label, ...(detail ? { detail } : {}) });
  }
  return { choices: out, total };
}
