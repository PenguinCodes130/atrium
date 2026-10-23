// Input checks and parameter resolution for control runs (architecture v3 section 6.2). Input is
// checked against the node in the document that was loaded for this run, never trusted from the
// client. Target fields (the command's target param, such as entityId) come only from the
// control's literal params; input can never reach them. Pure, no I/O.
import type { CommandDef, ComponentNode, ControlDef, PropValue } from "@/core/contracts";
import { validateParams, withoutParams } from "@/features/integrations/params";

export type Check = { ok: true } | { ok: false; message: string };

const isBinding = (v: unknown): v is { $bind: string } => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bind?: unknown }).$bind === "string";
const lit = (v: PropValue | undefined): unknown => (isBinding(v) ? undefined : v);
const numOr = (v: PropValue | undefined, d: number) => (typeof lit(v) === "number" && Number.isFinite(lit(v) as number) ? (lit(v) as number) : d);

/** The component types that may run a control, and how each names its control. */
export function nodeRunsControl(node: ComponentNode, controlId: string): boolean {
  if (node.type === "html") {
    const list = lit(node.props.controls);
    return Array.isArray(list) && list.includes(controlId);
  }
  if (["button", "toggle", "slider", "select"].includes(node.type)) return lit(node.props.control) === controlId;
  return false;
}

function optionValues(options: PropValue | undefined): unknown[] {
  const list = lit(options);
  if (!Array.isArray(list)) return [];
  return list.map((o) => (o && typeof o === "object" && !Array.isArray(o) && !isBinding(o) ? (o as Record<string, unknown>).value : o)).filter((v) => v !== undefined && !isBinding(v));
}

/** The target params of a command: they must be literals and input may never set them. */
export function targetParams(def: CommandDef | undefined): string[] {
  if (!def?.target) return [];
  // The command's params name the target with a camelCase param (entityId for entity_id); the
  // target field itself names the endpoint row field. Both spellings are protected.
  const camel = def.target.field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const props = Object.keys(((def.params as { properties?: Record<string, unknown> }).properties ?? {}) as object);
  return [...new Set([def.target.field, camel].filter((n) => props.includes(n)))];
}

/** Checks the click's input against the node: the only input each component can send. */
export function checkInput(node: ComponentNode, input: unknown, def: CommandDef | undefined): Check {
  switch (node.type) {
    case "toggle":
      return typeof input === "boolean" ? { ok: true } : { ok: false, message: "A toggle sends only true or false." };
    case "button":
      return input === undefined || input === null ? { ok: true } : { ok: false, message: "A button sends no input." };
    case "slider": {
      const min = numOr(node.props.min, 0);
      const max = numOr(node.props.max, 100);
      const step = numOr(node.props.step, 1);
      if (typeof input !== "number" || !Number.isFinite(input)) return { ok: false, message: "A slider sends only a number." };
      if (input < min || input > max) return { ok: false, message: `The value must be between ${min} and ${max}.` };
      if (step > 0) {
        const n = (input - min) / step;
        if (Math.abs(n - Math.round(n)) > 1e-9) return { ok: false, message: `The value must be a step of ${step} from ${min}.` };
      }
      return { ok: true };
    }
    case "select": {
      const values = optionValues(node.props.options);
      return values.some((v) => v === input) ? { ok: true } : { ok: false, message: "That is not one of this menu's options." };
    }
    case "html": {
      if (input === undefined || input === null) return { ok: true };
      if (typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "An HTML block sends its input as an object." };
      if (!def) return Object.keys(input as object).length === 0 ? { ok: true } : { ok: false, message: "This control takes no input from an HTML block." };
      // The control's parameter schema, with every target field removed: a block can never pick the target.
      const r = validateParams(withoutParams(def.params, targetParams(def)), input);
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    }
    default:
      return { ok: false, message: "This component cannot run controls." };
  }
}

export type Viewer = { kind: "user" | "guest"; name: string };

const INPUT = /^\{\{\s*\$input\s*\}\}$/;
const INPUT_KEY = /^\{\{\s*\$input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const VIEWER = /^\{\{\s*\$viewer\.(name|kind)\s*\}\}$/;

type Resolved = { ok: true; params: Record<string, unknown> } | { ok: false; message: string };

function resolveValue(v: PropValue, input: unknown, viewer: Viewer, depth: number): { ok: true; value: unknown } | { ok: false; message: string } {
  if (depth > 6) return { ok: false, message: "This control's parameters are nested too deeply." };
  if (isBinding(v)) {
    const t = v.$bind.trim();
    if (INPUT.test(t)) return { ok: true, value: input };
    const k = INPUT_KEY.exec(t);
    if (k) return { ok: true, value: input && typeof input === "object" && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, k[1]!) ? (input as Record<string, unknown>)[k[1]!] : undefined };
    const w = VIEWER.exec(t);
    if (w) return { ok: true, value: viewer[w[1] as "name" | "kind"] };
    // Anything else would need data the server does not evaluate for a run; refuse rather than guess.
    return { ok: false, message: "This control's parameters use a binding that runs cannot fill. Use $input, $viewer or a fixed value." };
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) { const r = resolveValue(x, input, viewer, depth + 1); if (!r.ok) return r; out.push(r.value); }
    return { ok: true, value: out };
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, x] of Object.entries(v)) { const r = resolveValue(x as PropValue, input, viewer, depth + 1); if (!r.ok) return r; if (r.value !== undefined) out[key] = r.value; }
    return { ok: true, value: out };
  }
  return { ok: true, value: v };
}

/**
 * Fills a command control's params from its literal values, $input and $viewer. Target params must
 * be literal strings in the control: a binding there (even $input) is refused, and input is never
 * consulted for them.
 */
export function resolveParams(control: ControlDef, def: CommandDef | undefined, input: unknown, viewer: Viewer): Resolved {
  if (control.run.kind !== "command") return { ok: true, params: {} };
  const raw = control.run.params ?? {};
  const targets = targetParams(def);
  for (const t of targets) {
    const v = raw[t];
    if (typeof v !== "string" || !v) return { ok: false, message: `This control's ${t} must be a fixed value set in the builder.` };
  }
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (targets.includes(k)) { params[k] = v; continue; }
    const r = resolveValue(v, input, viewer, 0);
    if (!r.ok) return r;
    if (r.value !== undefined) params[k] = r.value;
  }
  return { ok: true, params };
}
