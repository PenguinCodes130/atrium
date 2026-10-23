// Binding engine public surface (architecture v3 section 4.5). Isomorphic.
import type { Binding, BindingScope, PropValue } from "@/core/contracts";
import { evaluateTemplate, type BindingFailure } from "./evaluate";
import { rootsOf } from "./parse";

export { evaluateBinding, evaluateTemplate, text, MAX_STEPS, FILTERS } from "./evaluate";
export type { BindingResult, BindingFailure } from "./evaluate";
export { MAX_TEMPLATE_BYTES, parseTemplate, rootsOf, pathsOf, BindingError, byteLength } from "./parse";

export function isBinding(v: unknown): v is Binding {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bind?: unknown }).$bind === "string" && Object.keys(v).length === 1;
}

export type PropError = { prop: string; error: BindingFailure };

/** Resolves a prop value: bindings are evaluated, arrays and objects are resolved inside. */
export function resolveValue(v: PropValue | undefined, scope: BindingScope, path: string, errors: PropError[]): unknown {
  if (isBinding(v)) {
    const r = evaluateTemplate(v.$bind, scope);
    if (!r.ok) {
      errors.push({ prop: path, error: r.error });
      return undefined;
    }
    return r.value;
  }
  if (Array.isArray(v)) return v.map((x, i) => resolveValue(x, scope, `${path}[${i}]`, errors));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveValue(x as PropValue, scope, `${path}.${k}`, errors);
    return out;
  }
  return v;
}

/** Every binding template inside a prop value, with its path. */
export function templatesIn(v: PropValue | undefined, path: string, out: { path: string; template: string }[] = []): { path: string; template: string }[] {
  if (isBinding(v)) out.push({ path, template: v.$bind });
  else if (Array.isArray(v)) v.forEach((x, i) => templatesIn(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) templatesIn(x as PropValue, `${path}.${k}`, out);
  return out;
}

/** Data source names a template reads (roots that are not $roots). */
export function sourcesInTemplate(template: string): string[] {
  return rootsOf(template).filter((r) => !r.startsWith("$"));
}

/** True when the template reads $now (the clock root ticks only on pages that use it). */
export function usesNow(template: string): boolean {
  return rootsOf(template).includes("$now");
}
