// Binding evaluation (architecture v3 section 4.5, amendment A4.2): walks the tree from parse.ts
// against a BindingScope. No code execution of any kind, own properties only, prototype paths
// refused, a 10,000-step budget. The same input gives the same output on the server and in the
// browser (no clocks or time zones are read unless the scope provides them).
import type { BindingScope } from "@/core/contracts";
import { BindingError, FORBIDDEN_SEGMENTS, parseTemplate, type Node } from "./parse";

export const MAX_STEPS = 10_000;

export type BindingFailure = { code: string; message: string; position?: number };
export type BindingResult = { ok: true; value: unknown } | { ok: false; error: BindingFailure };

/** Per-source metadata the scope may carry (the page stream's state and timestamps). */
export type SourceMeta = { state?: string; updatedAt?: string };

type Ctx = { scope: BindingScope; steps: number };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function step(ctx: Ctx, n = 1) {
  ctx.steps += n;
  if (ctx.steps > MAX_STEPS) throw new BindingError("This binding took more than 10,000 steps and was stopped.", "binding.too_many_steps");
}

function isSourceName(scope: BindingScope, name: string): boolean {
  const data = scope.$data ?? {};
  const sources = (scope as { $sources?: Record<string, unknown> }).$sources ?? {};
  return own(data, name) || own(sources, name);
}

function sourceMeta(scope: BindingScope, name: string): SourceMeta {
  const s = (scope as { $sources?: Record<string, { state?: string; sourceTimestamp?: string; fetchedAt?: string } | undefined> }).$sources?.[name];
  const d = scope.$data?.[name] as { $state?: string; $updatedAt?: string } | undefined;
  return { state: s?.state ?? d?.$state, updatedAt: s?.sourceTimestamp ?? s?.fetchedAt ?? d?.$updatedAt };
}

function root(ctx: Ctx, name: string, p: number): unknown {
  const s = ctx.scope as Record<string, unknown> & BindingScope;
  if (name.startsWith("$")) {
    if (name === "$viewer") return s.$viewer ?? s.$user;
    if (name === "$now") return typeof s.$now === "number" ? s.$now : Date.now();
    if (name === "$param") {
      if (!own(s, "$param") || s.$param === undefined) throw new BindingError("$param works only inside a library component.", "binding.param_outside", p);
      return s.$param;
    }
    if (name === "$item" || name === "$index") {
      if (!own(s, name)) throw new BindingError(`${name} works only inside a repeat.`, "binding.repeat_only", p);
      return s[name];
    }
    if (name === "$input") {
      if (!own(s, "$input")) throw new BindingError("$input works only inside control parameters.", "binding.input_only", p);
      return s.$input;
    }
    if (own(s, name)) return s[name];
    throw new BindingError(`"${name}" is not a binding root. Roots are your data sources, $item, $index, $input, $page, $app, $viewer, $now and $param.`, "binding.unknown_root", p);
  }
  if (!isSourceName(s, name)) throw new BindingError(`No data source named "${name}" yet.`, "binding.unknown_source", p);
  return s.$data?.[name];
}

function getProp(obj: unknown, key: string, p: number): unknown {
  if (FORBIDDEN_SEGMENTS.has(key)) throw new BindingError(`"${key}" cannot be used in a binding path.`, "binding.forbidden", p);
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj === "string") return key === "length" ? obj.length : undefined;
  if (Array.isArray(obj)) {
    if (key === "length") return obj.length;
    if (key === "first") return obj[0];
    if (/^\d+$/.test(key)) return obj[Number(key)];
    return undefined;
  }
  if (typeof obj === "object") {
    if (own(obj, key)) return (obj as Record<string, unknown>)[key];
    if (key === "first") {
      const o = obj as { rows?: unknown[]; items?: unknown[]; series?: unknown[] };
      return (Array.isArray(o.rows) ? o.rows : Array.isArray(o.items) ? o.items : Array.isArray(o.series) ? o.series : [])[0];
    }
    return undefined;
  }
  return undefined;
}

function listOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const o = v as { rows?: unknown; items?: unknown; series?: unknown };
    if (Array.isArray(o.rows)) return o.rows;
    if (Array.isArray(o.items)) return o.items;
    if (Array.isArray(o.series)) return o.series;
  }
  return null;
}

const loose = (a: unknown, b: unknown) => (a === null || a === undefined ? b === null || b === undefined : typeof a === typeof b ? a === b : String(a) === String(b));

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}
const finite = (n: number) => (Number.isFinite(n) ? n : null);

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

function ev(n: Node, ctx: Ctx): unknown {
  step(ctx);
  switch (n.k) {
    case "num":
    case "str":
    case "lit":
      return n.v;
    case "id":
      return root(ctx, n.name, n.p);
    case "get": {
      if ((n.key === "$state" || n.key === "$updatedAt") && n.obj.k === "id" && !n.obj.name.startsWith("$") && isSourceName(ctx.scope, n.obj.name)) {
        const m = sourceMeta(ctx.scope, n.obj.name);
        return n.key === "$state" ? (m.state ?? (ctx.scope.$data?.[n.obj.name] ? "fresh" : "empty")) : m.updatedAt;
      }
      return getProp(ev(n.obj, ctx), n.key, n.p);
    }
    case "idx": {
      const o = ev(n.obj, ctx);
      const k = ev(n.key, ctx);
      if (typeof k !== "string" && typeof k !== "number") return undefined;
      return getProp(o, String(k), n.key.p);
    }
    case "call": {
      if (n.method !== "find") throw new BindingError(`Only find(...) can be called in a binding; "${n.method}" cannot.`, "binding.call", n.p);
      const list = listOf(ev(n.obj, ctx));
      const [key, value] = n.args.map((a) => ev(a, ctx));
      if (typeof key !== "string") throw new BindingError(`find needs a column name in quotes, like find("name", "web").`, "binding.args", n.p);
      if (!list) return undefined;
      for (const el of list) {
        step(ctx);
        if (el && typeof el === "object" && own(el, key) && loose((el as Record<string, unknown>)[key], value)) return el;
      }
      return undefined;
    }
    case "un": {
      const v = ev(n.e, ctx);
      if (n.op === "!") return !truthy(v);
      const x = num(v);
      return x === null ? null : -x;
    }
    case "bin": {
      if (n.op === "&&") {
        const a = ev(n.a, ctx);
        return truthy(a) ? ev(n.b, ctx) : a;
      }
      if (n.op === "||") {
        const a = ev(n.a, ctx);
        return truthy(a) ? a : ev(n.b, ctx);
      }
      const a = ev(n.a, ctx);
      const b = ev(n.b, ctx);
      switch (n.op) {
        case "==":
          return loose(a, b);
        case "!=":
          return !loose(a, b);
        case "+": {
          if (typeof a === "string" || typeof b === "string") return `${text(a)}${text(b)}`;
          const x = num(a), y = num(b);
          return x === null || y === null ? null : finite(x + y);
        }
        case "<": case "<=": case ">": case ">=": {
          let x: number | string | null = num(a), y: number | string | null = num(b);
          if (x === null || y === null) {
            if (typeof a !== "string" || typeof b !== "string") return false;
            x = a;
            y = b;
          }
          return n.op === "<" ? x < y : n.op === "<=" ? x <= y : n.op === ">" ? x > y : x >= y;
        }
        default: {
          const x = num(a), y = num(b);
          if (x === null || y === null) return null;
          if (n.op === "-") return finite(x - y);
          if (n.op === "*") return finite(x * y);
          if (n.op === "/") return y === 0 ? null : finite(x / y);
          return y === 0 ? null : finite(x % y);
        }
      }
    }
    case "tern":
      return truthy(ev(n.c, ctx)) ? ev(n.a, ctx) : ev(n.b, ctx);
    case "pipe": {
      const v = ev(n.e, ctx);
      const args = n.args.map((a) => ev(a, ctx));
      return applyFilter(n.name, v, args, ctx, n.p);
    }
  }
}

/** How a value reads inside text ("CPU {{ x }}"): empty for nothing, JSON for objects. */
export function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) return v.map(text).join(", ");
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

// ---------- filters ----------

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
const trimNum = (n: number, d: number) => String(Number(n.toFixed(d)));

function roundTo(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round((x + Math.sign(x) * Number.EPSILON) * f) / f;
}

function epoch(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v; // seconds or ms
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(ms: number, fmt: string, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000);
  const map: Record<string, string> = {
    YYYY: String(d.getUTCFullYear()),
    MMM: MONTHS[d.getUTCMonth()]!,
    MM: pad(d.getUTCMonth() + 1),
    DD: pad(d.getUTCDate()),
    D: String(d.getUTCDate()),
    HH: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
  };
  return fmt.replace(/YYYY|MMM|MM|DD|D|HH|mm|ss/g, (t) => map[t]!);
}

function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return r ? `${m}m ${r}s` : `${m}m`;
  return `${r}s`;
}

function keyed(el: unknown, key: unknown): unknown {
  if (key === undefined) return el;
  if (typeof key !== "string" || FORBIDDEN_SEGMENTS.has(key)) return undefined;
  return el && typeof el === "object" && own(el, key) ? (el as Record<string, unknown>)[key] : undefined;
}

export const FILTERS = ["round", "percent", "bytes", "duration", "date", "ago", "default", "upper", "lower", "truncate", "join", "count", "sum", "avg", "min", "max", "sort", "filter", "map"] as const;

function applyFilter(name: string, v: unknown, args: unknown[], ctx: Ctx, p: number): unknown {
  const need = (what: string): never => {
    throw new BindingError(`The ${name} filter needs ${what}.`, "binding.filter_input", p);
  };
  switch (name) {
    case "round": {
      const x = num(v);
      if (x === null) return v === null || v === undefined ? v : null;
      const d = args[0] === undefined ? 0 : num(args[0]);
      if (d === null || d < 0 || d > 10) need("a number of decimals from 0 to 10");
      return roundTo(x, d!);
    }
    case "percent": {
      const x = num(v);
      if (x === null) return null;
      const d = num(args[0]) ?? 0;
      return `${trimNum(x * 100, Math.min(10, Math.max(0, d)))}%`;
    }
    case "bytes": {
      let x = num(v);
      if (x === null) return null;
      let i = 0;
      while (Math.abs(x) >= 1024 && i < BYTE_UNITS.length - 1) {
        x /= 1024;
        i++;
      }
      return `${trimNum(x, i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
    }
    case "duration": {
      const x = num(v);
      return x === null ? null : duration(x);
    }
    case "date": {
      const t = epoch(v);
      if (t === null) return null;
      const fmt = typeof args[0] === "string" ? args[0] : "YYYY-MM-DD HH:mm";
      const tz = num((ctx.scope as { $tzOffsetMin?: unknown }).$tzOffsetMin) ?? 0;
      return formatDate(t, fmt, tz);
    }
    case "ago": {
      const t = epoch(v);
      if (t === null) return null;
      const now = num((ctx.scope as { $now?: unknown }).$now) ?? Date.now();
      const s = Math.round((now - t) / 1000);
      if (s < 0) return "just now";
      if (s < 45) return "just now";
      return `${duration(s).split(" ")[0]} ago`;
    }
    case "default":
      return v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v)) ? args[0] : v;
    case "upper":
      return v === null || v === undefined ? v : text(v).toUpperCase();
    case "lower":
      return v === null || v === undefined ? v : text(v).toLowerCase();
    case "truncate": {
      const n = num(args[0]);
      if (n === null || n < 1) need("a length, like truncate(20)");
      const s = text(v);
      return s.length > n! ? `${s.slice(0, n!)}...` : s;
    }
    case "join": {
      const l = listOf(v);
      if (!l) return v === null || v === undefined ? v : text(v);
      step(ctx, l.length);
      return l.map(text).join(typeof args[0] === "string" ? args[0] : ", ");
    }
    case "count": {
      if (typeof v === "string") return v.length;
      const l = listOf(v);
      if (l) return l.length;
      if (v && typeof v === "object") return Object.keys(v).length;
      return 0;
    }
    case "sum": case "avg": case "min": case "max": {
      const l = listOf(v);
      if (!l) return null;
      step(ctx, l.length);
      const xs = l.map((el) => num(keyed(el, args[0]))).filter((x): x is number => x !== null);
      if (!xs.length) return null;
      if (name === "sum") return finite(xs.reduce((a, b) => a + b, 0));
      if (name === "avg") return finite(xs.reduce((a, b) => a + b, 0) / xs.length);
      return name === "min" ? Math.min(...xs) : Math.max(...xs);
    }
    case "sort": {
      const l = listOf(v);
      if (!l) return v;
      step(ctx, l.length * Math.max(1, Math.ceil(Math.log2(l.length + 1))));
      const desc = args[1] === "desc";
      return [...l].sort((a, b) => {
        const x = keyed(a, args[0]), y = keyed(b, args[0]);
        const nx = num(x), ny = num(y);
        const c = nx !== null && ny !== null ? nx - ny : text(x).localeCompare(text(y), "en");
        return desc ? -c : c;
      });
    }
    case "filter": {
      const l = listOf(v);
      if (!l) return [];
      if (typeof args[0] !== "string") need('a column name, like filter("state", "up")');
      step(ctx, l.length);
      return l.filter((el) => loose(keyed(el, args[0]), args[1]));
    }
    case "map": {
      const l = listOf(v);
      if (!l) return [];
      if (typeof args[0] !== "string") need('a column name, like map("name")');
      step(ctx, l.length);
      return l.map((el) => keyed(el, args[0]));
    }
    default:
      throw new BindingError(`"${name}" is not a filter. Filters: ${FILTERS.join(", ")}.`, "binding.unknown_filter", p);
  }
}

/** Evaluates a template with the reason when it fails. */
export function evaluateTemplate(template: string, scope: BindingScope): BindingResult {
  try {
    const parsed = parseTemplate(template);
    const ctx: Ctx = { scope, steps: 0 };
    if (parsed.whole) {
      const part = parsed.parts.find((x) => "expr" in x) as { expr: Node };
      return { ok: true, value: ev(part.expr, ctx) };
    }
    let out = "";
    for (const part of parsed.parts) out += "expr" in part ? text(ev(part.expr, ctx)) : part.text;
    return { ok: true, value: out };
  } catch (err) {
    if (err instanceof BindingError) return { ok: false, error: { code: err.code, message: err.message, ...(err.position !== undefined ? { position: err.position } : {}) } };
    if (err instanceof RangeError) return { ok: false, error: { code: "binding.too_many_steps", message: "This binding is nested too deeply and was stopped." } };
    return { ok: false, error: { code: "binding.error", message: "This binding could not be evaluated." } };
  }
}

/** The frozen export: the template's value, or undefined when it fails (a failed binding renders empty). */
export function evaluateBinding(template: string, scope: BindingScope): unknown {
  const r = evaluateTemplate(template, scope);
  return r.ok ? r.value : undefined;
}
