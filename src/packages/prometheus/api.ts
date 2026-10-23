// Prometheus HTTP API v1 calls, GET only. Shared by every read of the package.
import type { AdapterContext } from "@/core/contracts";
import { arr, checkStatus, fail, num, obj, str } from "../lib";
import { friendlyName, round } from "./promql";

/** Which sealed secret to send, from the "Login" setting. */
function login(ctx: AdapterContext): { auth?: string; label?: string } {
  const mode = str(ctx.config.authMode, "none");
  if (mode === "basic") {
    if (!str(ctx.config.username).trim()) fail("config", "Enter the username for Basic auth.", "It is the user name your proxy or Prometheus web config expects.");
    return { auth: "password", label: "Password" };
  }
  if (mode === "bearer") return { auth: "token", label: "Bearer token" };
  return {};
}

export const QUERY_ERROR = "Query error";

export async function api(ctx: AdapterContext, path: string, query?: Record<string, string>): Promise<unknown> {
  const { auth, label } = login(ctx);
  const res = await ctx.http.fetch({ path, ...(query ? { query } : {}), ...(auth ? { auth } : {}) });
  if (res.status === 401 || res.status === 403) checkStatus(res, label);
  // Prometheus answers a bad query with 400 or 422 and {"status":"error","error":"..."}.
  let body: Record<string, unknown> | undefined;
  try {
    const j = JSON.parse(await res.text()) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) body = j as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  if (body?.status === "error") fail("bad_response", `${QUERY_ERROR}: ${str(body.error, "unknown error").slice(0, 200)}`, "Fix the PromQL query. The text above is Prometheus's own message.");
  checkStatus(res, label);
  if (!body) fail("bad_response", "Prometheus did not answer with JSON.", "Check the address points at Prometheus itself.");
  if (body.status !== "success") fail("bad_response", "Prometheus gave an answer Atrium does not understand.", "Check the address and the Prometheus version.");
  return body.data;
}

export type Sample = { metric: Record<string, string>; value: number | null };
export type Line = { metric: Record<string, string>; points: [number, number | null][] };

function labels(v: unknown): Record<string, string> {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, str(x)]));
}

/** An instant query as samples (a scalar comes back as one sample with no labels). */
export async function vector(ctx: AdapterContext, query: string): Promise<Sample[]> {
  const data = obj(await api(ctx, "api/v1/query", { query }), "query result");
  const type = str(data.resultType);
  if (type === "scalar") return [{ metric: {}, value: num(arr(data.result, "result")[1]) }];
  if (type !== "vector") fail("bad_response", `The query returned a ${type || "different result"}, not values.`, "Check the PromQL query.");
  return arr(data.result, "result").map((r) => {
    const s = obj(r, "series");
    return { metric: labels(s.metric), value: num(arr(s.value, "sample")[1]) };
  });
}

/** A range query as lines, at most `cap` of them (with the full count). */
export async function matrix(ctx: AdapterContext, query: string, r: { start: number; end: number; step: number }, cap = 20): Promise<{ lines: Line[]; total: number }> {
  const data = obj(await api(ctx, "api/v1/query_range", { query, start: String(r.start), end: String(r.end), step: String(r.step) }), "range result");
  if (str(data.resultType) !== "matrix") fail("bad_response", "A range query must return a matrix.", "Check the PromQL query.");
  const result = arr(data.result, "result");
  const lines = result.slice(0, cap).map((x) => {
    const s = obj(x, "series");
    return {
      metric: labels(s.metric),
      points: arr(s.values, "values").map((p) => {
        const pair = arr(p, "point");
        return [Math.round((num(pair[0]) ?? 0) * 1000), round(num(pair[1]), 4)] as [number, number | null];
      }),
    };
  });
  return { lines, total: result.length };
}

/** Samples by instance (the first sample of each). */
export function byInstance(samples: Sample[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const s of samples) {
    const k = s.metric.instance;
    if (k !== undefined && !out.has(k)) out.set(k, s.value);
  }
  return out;
}

export type Machine = { instance: string; name: string; nodename: string; job: string; os: string; arch: string; labels: Record<string, string> };

/**
 * Every node-exporter machine seen in the last day, with its friendly name. From an instant query,
 * never from /label/host/values (which keeps stale names). Two machines with the same name get their
 * address added so a person can tell them apart.
 */
export async function machines(ctx: AdapterContext): Promise<Machine[]> {
  const rows = (await vector(ctx, "last_over_time(node_uname_info[1d])")).filter((s) => s.metric.instance);
  const seen = new Map<string, Machine>();
  for (const s of rows) {
    const m = s.metric;
    if (seen.has(m.instance!)) continue;
    seen.set(m.instance!, {
      instance: m.instance!,
      name: friendlyName(m, m.nodename),
      nodename: m.nodename ?? "",
      job: m.job ?? "",
      os: [m.sysname, m.release].filter(Boolean).join(" "),
      arch: m.machine ?? "",
      labels: m,
    });
  }
  const list = [...seen.values()];
  const counts = new Map<string, number>();
  for (const m of list) counts.set(m.name.toLowerCase(), (counts.get(m.name.toLowerCase()) ?? 0) + 1);
  for (const m of list) if ((counts.get(m.name.toLowerCase()) ?? 0) > 1) m.name = `${m.name} (${m.instance})`;
  return list.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export function nameMap(list: Machine[]): Map<string, string> {
  return new Map(list.map((m) => [m.instance, m.name]));
}

/** The names of all known machines, or an empty map when node_uname_info cannot be read. */
export async function machineNames(ctx: AdapterContext): Promise<Map<string, string>> {
  try {
    return nameMap(await machines(ctx));
  } catch {
    return new Map();
  }
}

/** Runs several instant queries in parallel. A failed query gives no samples unless every one failed. */
export async function vectors<K extends string>(ctx: AdapterContext, queries: Record<K, string>): Promise<Record<K, Sample[]>> {
  const keys = Object.keys(queries) as K[];
  const settled = await Promise.allSettled(keys.map((k) => vector(ctx, queries[k])));
  const firstError = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (firstError && settled.every((s) => s.status === "rejected")) throw firstError.reason;
  // An unreachable or refused server fails every query the same way; a query error fails only that one.
  return Object.fromEntries(keys.map((k, i) => [k, settled[i]!.status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<Sample[]>).value : []])) as Record<K, Sample[]>;
}

/** Every metric name the server holds (one request), for available() and the metric browser. */
export async function metricNames(ctx: AdapterContext): Promise<string[]> {
  return arr(await api(ctx, "api/v1/label/__name__/values"), "metric names").map((x) => str(x));
}
