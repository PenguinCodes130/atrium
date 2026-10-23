// Field picks, shape proposal and shaping for custom and declarative endpoints.
// Pure functions shared by the generic runner (server) and the by-example UI (client).
import type { ComponentType, CustomEndpoint, DataShapeKind, ShapedData } from "@/core/contracts";

export type FieldPick = CustomEndpoint["fields"][number];
export type Role = FieldPick["role"];
type Seg = { key: string } | { index: number } | { all: true };

export function parsePath(path: string): Seg[] {
  if (!path.startsWith("$")) throw new Error("path must start with $");
  const segs: Seg[] = [];
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[\*\]|\["((?:[^"\\]|\\.)*)"\]/gy;
  re.lastIndex = 1;
  while (re.lastIndex < path.length) {
    const start = re.lastIndex;
    const m = re.exec(path);
    if (!m || m.index !== start) throw new Error(`bad path at ${start}`);
    if (m[1] !== undefined) segs.push({ key: m[1] });
    else if (m[2] !== undefined) segs.push({ index: Number(m[2]) });
    else if (m[3] !== undefined) segs.push({ key: JSON.parse(`"${m[3]}"`) as string });
    else segs.push({ all: true });
  }
  return segs;
}

export function formatPath(segs: Seg[]): string {
  return "$" + segs.map((s) => ("all" in s ? "[*]" : "index" in s ? `[${s.index}]` : /^[A-Za-z_$][\w$-]*$/.test(s.key) ? `.${s.key}` : `[${JSON.stringify(s.key)}]`)).join("");
}

/** Appends a child key or index to a path; used by the response tree. */
export function childPath(parent: string, key: string | number): string {
  return formatPath([...parsePath(parent), typeof key === "number" ? { index: key } : { key }]);
}

function walk(value: unknown, segs: Seg[]): unknown[] {
  let current: unknown[] = [value];
  for (const s of segs) {
    const next: unknown[] = [];
    for (const v of current) {
      if ("all" in s) { if (Array.isArray(v)) next.push(...v); }
      else if ("index" in s) { if (Array.isArray(v) && s.index < v.length) next.push(v[s.index]); }
      else if (v && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, s.key)) next.push((v as Record<string, unknown>)[s.key]);
    }
    current = next;
  }
  return current;
}

export function evaluate(value: unknown, path: string): unknown[] {
  return walk(value, parsePath(path));
}

/** Splits a path at its first [*]: the array prefix and the path relative to one item. */
function splitAtAll(path: string): { prefix: Seg[]; rest: Seg[] } | null {
  const segs = parsePath(path);
  const i = segs.findIndex((s) => "all" in s);
  if (i < 0) return null;
  return { prefix: segs.slice(0, i + 1), rest: segs.slice(i + 1) };
}

function inArray(path: string): boolean {
  return parsePath(path).some((s) => "index" in s || "all" in s);
}

/** Turns the first concrete array index of a path into [*]. */
export function generalize(path: string): string {
  const segs = parsePath(path);
  const i = segs.findIndex((s) => "index" in s);
  if (i < 0) return path;
  segs[i] = { all: true };
  return formatPath(segs);
}

/** Proposes a shape from the picks (spec 3.5.4), returning the picks with array indexes generalized when needed. */
export function proposeShape(picks: FieldPick[]): { shape: DataShapeKind; fields: FieldPick[] } {
  if (picks.length === 0) return { shape: "stat", fields: [] };
  const roles = new Set(picks.map((p) => p.role));
  const arrayish = picks.filter((p) => inArray(p.path));
  const listy = roles.has("time") || roles.has("column") || roles.has("status") || arrayish.length > 1;
  const fields = listy ? picks.map((p) => (inArray(p.path) && !p.path.includes("[*]") ? { ...p, path: generalize(p.path) } : p)) : picks;
  if (roles.has("status")) return { shape: "status", fields };
  if (roles.has("time") && roles.has("value") && fields.some((f) => f.path.includes("[*]"))) return { shape: "series", fields };
  if (listy && fields.some((f) => f.path.includes("[*]"))) return { shape: "table", fields };
  return { shape: "stat", fields: picks };
}

/** The data components a shape can be drawn with (architecture v3 section 4.4). */
export type DataComponentType = Extract<ComponentType, "stat" | "chart" | "table" | "list" | "status">;

/**
 * Architecture v3 section 4.4 suggestion rules. The components subsystem owns suggestComponent();
 * this mirrors it for proposals before components exist.
 */
export function proposeComponent(data: ShapedData | DataShapeKind): DataComponentType {
  const kind = typeof data === "string" ? data : data.kind;
  if (kind === "stat") return "stat";
  if (kind === "series") return "chart";
  if (kind === "table") return typeof data !== "string" && data.kind === "table" && data.columns.length <= 2 ? "list" : "table";
  return typeof data !== "string" && data.kind === "status" && data.items.length === 1 ? "stat" : "status";
}

export function toEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string") {
    if (/^\d+(\.\d+)?$/.test(v)) return toEpochMs(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

export function toState(v: unknown): "up" | "down" | "warn" | "unknown" {
  if (v === true || v === 1) return "up";
  if (v === false || v === 0) return "down";
  const s = String(v ?? "").toLowerCase();
  if (/^(up|ok|true|running|healthy|online|active|pass|passing|success|enabled|1)$/.test(s)) return "up";
  if (/^(down|false|fail|failed|failing|error|exited|dead|offline|critical|stopped|disabled|0)$/.test(s)) return "down";
  if (/^(warn|warning|degraded|pending|paused|restarting|unhealthy|starting)$/.test(s)) return "warn";
  return "unknown";
}

const slug = (s: string, i: number) => (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `f${i}`);

/**
 * A unit printed next to a value by the API itself: a sibling "<parent>_units" object (Open-Meteo:
 * current_units.temperature_2m = "°C"), a "units" object next to the value, or a "<key>_unit"
 * string beside it. Short strings only.
 */
export function unitFor(json: unknown, path: string): string | undefined {
  let segs: Seg[];
  try { segs = parsePath(path); } catch { return undefined; }
  const last = segs.at(-1);
  if (!last || !("key" in last)) return undefined;
  const parent = segs.slice(0, -1);
  const tries: Seg[][] = [[...parent, { key: "units" }, last], [...parent, { key: `${last.key}_unit` }], [...parent, { key: `${last.key}_units` }]];
  const up = parent.at(-1);
  if (up && "key" in up) tries.unshift([...parent.slice(0, -1), { key: `${up.key}_units` }, last], [...parent.slice(0, -1), { key: `${up.key}_unit` }, last]);
  for (const t of tries) {
    const v = walk(json, t)[0];
    if (typeof v === "string" && v.trim() && v.length <= 12) return v.trim();
  }
  return undefined;
}

/** A path as a person reads it: "current > temperature_2m", "each item > login". */
export function readablePath(path: string): string {
  let segs: Seg[];
  try { segs = parsePath(path); } catch { return path; }
  if (segs.length === 0) return "the whole answer";
  return segs.map((s) => ("all" in s ? "each item" : "index" in s ? `item ${s.index + 1}` : s.key)).join(" > ");
}

function rel(item: unknown, rest: Seg[]): unknown {
  return walk(item, rest)[0];
}

/** Shapes a JSON response using field picks. Throws an Error with a safe message when the picks do not match. */
export function shapeFromFields(json: unknown, shape: DataShapeKind, fields: FieldPick[], fallbackLabel: string): ShapedData {
  if (shape === "stat") {
    const valuePick = fields.find((f) => f.role === "value") ?? fields[0];
    if (!valuePick) throw new Error("no value field picked");
    const raw = evaluate(json, valuePick.path)[0];
    if (raw === undefined) throw new Error(`field ${valuePick.path} is not in the response`);
    const labelPick = fields.find((f) => f.role === "label");
    const label = labelPick ? String(evaluate(json, labelPick.path)[0] ?? labelPick.label) : valuePick.label || fallbackLabel;
    const num = toNumber(raw);
    const unit = unitFor(json, valuePick.path);
    return { kind: "stat", value: num ?? (typeof raw === "object" ? JSON.stringify(raw) : String(raw)), label, ...(unit ? { unit } : {}) };
  }
  const splits = fields.map((f) => ({ f, s: splitAtAll(f.path) }));
  const first = splits.find((x) => x.s);
  if (!first?.s) throw new Error("these fields are not inside a list");
  const items = walk(json, first.s.prefix);
  const relOf = (x: (typeof splits)[number]) => (x.s ? x.s.rest : parsePath(x.f.path));
  const absolute = (x: (typeof splits)[number]) => !x.s;
  const valueOf = (x: (typeof splits)[number], item: unknown) => (absolute(x) ? evaluate(json, x.f.path)[0] : rel(item, relOf(x)));
  if (shape === "series") {
    const time = splits.find((x) => x.f.role === "time");
    const values = splits.filter((x) => x.f.role === "value");
    if (!time || values.length === 0) throw new Error("a series needs a time field and a value field");
    return {
      kind: "series",
      series: values.map((v) => ({
        name: v.f.label || fallbackLabel,
        points: items
          .map((it) => [toEpochMs(valueOf(time, it)), toNumber(valueOf(v, it))] as const)
          .filter((p): p is readonly [number, number | null] => p[0] !== null)
          .map(([t, val]) => [t, val] as [number, number | null])
          .sort((a, b) => a[0] - b[0]),
      })),
      // Amendment A4.1: a custom endpoint draws one series per value field and trims none, so the
      // count is known.
      total: values.length,
    };
  }
  if (shape === "status") {
    const label = splits.find((x) => x.f.role === "label") ?? splits.find((x) => x.f.role === "column");
    const status = splits.find((x) => x.f.role === "status");
    if (!status) throw new Error("a status list needs a status field");
    return {
      kind: "status",
      items: items.map((it, i) => {
        const raw = valueOf(status, it);
        return { label: label ? String(valueOf(label, it) ?? `Item ${i + 1}`) : `Item ${i + 1}`, state: toState(raw), detail: raw === undefined ? undefined : String(raw) };
      }),
    };
  }
  const columns = splits.map((x, i) => ({
    key: slug(x.f.label || x.f.path, i),
    label: x.f.label || x.f.path,
    type: (x.f.role === "time" ? "time" : x.f.role === "status" ? "status" : x.f.role === "value" ? "number" : "text") as "time" | "status" | "number" | "text",
  }));
  const rows = items.map((it) =>
    Object.fromEntries(
      splits.map((x, i) => {
        const v = valueOf(x, it);
        const col = columns[i]!;
        const out = col.type === "time" ? toEpochMs(v) : col.type === "number" ? toNumber(v) : v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : v;
        return [col.key, out];
      }),
    ),
  );
  return { kind: "table", columns, rows, total: rows.length };
}

// ---- Response tree (Try it) ----
export const TRUNCATE_BYTES = 2048;
export type TreeNode =
  | { type: "object"; path: string; key?: string | number; children: TreeNode[] }
  | { type: "array"; path: string; key?: string | number; length: number; children: TreeNode[] }
  | { type: "string"; path: string; key?: string | number; value: string; truncated?: boolean }
  | { type: "number" | "boolean" | "null"; path: string; key?: string | number; value: number | boolean | null };

const MAX_ARRAY_CHILDREN = 50;

/** Builds a clickable tree, cutting strings over 2 KB and long arrays. */
export function buildTree(value: unknown, path = "$", key?: string | number, depth = 0): TreeNode {
  const base = key === undefined ? { path } : { path, key };
  if (depth > 12) return { ...base, type: "string", value: "(nested too deep)", truncated: true };
  if (Array.isArray(value)) {
    return { ...base, type: "array", length: value.length, children: value.slice(0, MAX_ARRAY_CHILDREN).map((v, i) => buildTree(v, childPath(path, i), i, depth + 1)) };
  }
  if (value && typeof value === "object") {
    return { ...base, type: "object", children: Object.entries(value as Record<string, unknown>).slice(0, 200).map(([k, v]) => buildTree(v, childPath(path, k), k, depth + 1)) };
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > TRUNCATE_BYTES) return { ...base, type: "string", value: new TextDecoder().decode(bytes.subarray(0, TRUNCATE_BYTES)).replace(/�$/, "") + "...", truncated: true };
    return { ...base, type: "string", value };
  }
  if (typeof value === "number") return { ...base, type: "number", value };
  if (typeof value === "boolean") return { ...base, type: "boolean", value };
  return { ...base, type: "null", value: null };
}
