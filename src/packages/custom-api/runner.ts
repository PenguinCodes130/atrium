// The Custom API runner (architecture A9.3): runs an integration's CustomEndpoint records with
// settings. `{{ params.x }}` placeholders in the path and query are filled only after the settings
// are checked against the endpoint's own schema, and each value is URL-encoded, so a setting can
// never add a path segment, a query key or reach another host. A query entry whose setting is left
// empty is not sent. Formats (A8.4) from the record are put on the shaped answer.
import type { Adapter, AdapterContext, CustomEndpoint, JsonSchema, ShapedData, ValueFormat } from "@/core/contracts";
import type { GenericFetchRequest } from "@/features/integrations/host/http";
import { validateParams } from "@/features/integrations/params";
import { evaluate, shapeFromFields, toState } from "@/features/integrations/shape";
import { checkStatus, defineAdapter, fail, saidBy, type ReadFn } from "../lib";

type GenericHttp = { fetch(req: GenericFetchRequest): ReturnType<AdapterContext["http"]["fetch"]> };
type Prop = { type?: string; default?: unknown; title?: string };

const ONE = /^\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const ANY = /\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const TICKS_PER_SECOND = 10_000_000;

function propsOf(schema: JsonSchema | undefined): Record<string, Prop> {
  return ((schema as { properties?: Record<string, Prop> } | undefined)?.properties ?? {}) as Record<string, Prop>;
}

/** Settings arrive as text from dropdowns and boxes: numbers and booleans are read back to their type; defaults fill gaps. */
export function coerceParams(schema: JsonSchema | undefined, input: unknown): Record<string, unknown> {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(propsOf(schema))) {
    let v = raw[k];
    if (v === "" || v === null) v = undefined;
    if (v === undefined && p.default !== undefined) v = p.default;
    if (v === undefined) continue;
    if ((p.type === "integer" || p.type === "number") && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
    else if (p.type === "boolean" && typeof v === "string") v = v === "true" ? true : v === "false" ? false : v;
    else if (p.type === "string" && (typeof v === "number" || typeof v === "boolean")) v = String(v);
    out[k] = v;
  }
  // Unknown keys stay so the check names them instead of silently dropping them.
  for (const [k, v] of Object.entries(raw)) if (!(k in out) && v !== undefined && v !== "" && v !== null && !Object.prototype.hasOwnProperty.call(propsOf(schema), k)) out[k] = v;
  return out;
}

const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/** Fills a path's placeholders with URL-encoded values. A missing value is an error naming the setting. */
export function fillPath(path: string, params: Record<string, unknown>, schema: JsonSchema | undefined): string {
  return path.replace(ANY, (_, n: string) => {
    const v = text(params[n]);
    if (!v) fail("config", `Pick ${(propsOf(schema)[n]?.title ?? n).toLowerCase()} first: this read needs it.`, "Set it in the read's settings.");
    return encodeURIComponent(v);
  });
}

/** Fills query values. An entry that is only a placeholder with no value is left out. Values are encoded by the host. */
export function fillQuery(query: Record<string, string> | undefined, params: Record<string, unknown>): Record<string, string> | undefined {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(query)) {
    const whole = ONE.exec(raw);
    if (whole) {
      const v = text(params[whole[1]!]);
      if (v) out[k] = v;
      continue;
    }
    out[k] = raw.replace(ANY, (_, n: string) => text(params[n]));
  }
  return Object.keys(out).length ? out : undefined;
}

function lastKey(path: string): string {
  return /([A-Za-z0-9_]+)\]?$/.exec(path)?.[1] ?? "";
}

/** Status of a single object (A9.3 spec import: an object with a status-like field). */
function singleStatus(json: unknown, e: CustomEndpoint): ShapedData {
  const st = e.fields.find((f) => f.role === "status") ?? e.fields[0]!;
  const lb = e.fields.find((f) => f.role === "label");
  const raw = evaluate(json, st.path)[0];
  if (raw === undefined) throw new Error(`field ${st.path} is not in the response`);
  const label = lb ? text(evaluate(json, lb.path)[0]) : "";
  return { kind: "status", items: [{ label: label || e.label, state: toState(raw), detail: String(raw) }] };
}

/** Puts the record's formats on the shaped answer; *Ticks values become seconds. */
export function withFormats(data: ShapedData, e: CustomEndpoint): ShapedData {
  if (data.kind === "stat") {
    const pick = e.fields.find((f) => f.role === "value") ?? e.fields[0];
    let value = data.value;
    if (e.format === "seconds" && typeof value === "number" && pick && /ticks$/i.test(lastKey(pick.path))) value = value / TICKS_PER_SECOND;
    return { ...data, value, ...(e.format ? { format: e.format } : {}) };
  }
  if (data.kind === "series") return e.format ? { ...data, format: e.format } : data;
  if (data.kind === "table" && e.columnFormats && Object.keys(e.columnFormats).length) {
    const formats = e.columnFormats as Record<string, ValueFormat>;
    const ticks = new Set(data.columns.filter((c, i) => formats[c.key] === "seconds" && /ticks$/i.test(lastKey(e.fields[i]?.path ?? ""))).map((c) => c.key));
    return {
      ...data,
      columns: data.columns.map((c) => (formats[c.key] ? { ...c, format: formats[c.key] } : c)),
      rows: ticks.size ? data.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ticks.has(k) && typeof v === "number" ? v / TICKS_PER_SECOND : v]))) : data.rows,
    };
  }
  return data;
}

async function call(ctx: AdapterContext, e: CustomEndpoint, params: Record<string, unknown>) {
  const http = ctx.http as GenericHttp;
  const query = fillQuery(e.query, params);
  const res = await http.fetch({
    path: fillPath(e.path, params, e.params),
    method: e.method,
    ...(query ? { query } : {}),
    ...(e.auth ? { auth: e.auth } : {}),
    ...(e.headers && Object.keys(e.headers).length ? { headers: e.headers } : {}),
    ...(e.method === "POST" && e.body !== undefined ? { body: e.body } : {}),
  });
  checkStatus(res, e.auth ? "the saved secret" : undefined, await saidBy(res));
  return res.json();
}

function checked(e: CustomEndpoint, input: unknown): Record<string, unknown> {
  if (!e.params) return {};
  const v = validateParams(e.params, coerceParams(e.params, input));
  if (!v.ok) fail("config", v.message, "Check the read's settings.");
  return v.value;
}

function required(e: CustomEndpoint): string[] {
  return ((e.params as { required?: string[] } | undefined)?.required ?? []) as string[];
}

export function createCustomApiAdapter(endpoints: CustomEndpoint[]): Adapter {
  const reads: Record<string, ReadFn> = {};
  for (const e of endpoints) {
    reads[e.id] = async (ctx, input) => {
      const params = checked(e, input);
      const json = await call(ctx, e, params);
      try {
        const single = e.shape === "status" && !e.fields.some((f) => f.path.includes("[*]"));
        const data = single ? singleStatus(json, e) : shapeFromFields(json, e.shape, e.fields, e.label);
        return { data: withFormats(data, e) };
      } catch (err) {
        return fail("bad_response", `The answer no longer matches the picked fields: ${(err as Error).message}.`, "Run Try it again and re-pick the fields.");
      }
    };
  }
  return defineAdapter({
    async health(ctx) {
      // The first read that needs no settings (spec imports put headline reads first).
      const first = endpoints.find((e) => required(e).length === 0);
      if (first) {
        await call(ctx, first, checked(first, {}));
        return { status: "ok" };
      }
      const res = await ctx.http.fetch({ path: "" });
      if (res.status === 401 || res.status === 403) checkStatus(res, "the saved secret");
      if (res.status >= 500) return { status: "degraded", message: `The service answered with HTTP ${res.status}.` };
      return { status: "ok" };
    },
    reads,
  });
}
