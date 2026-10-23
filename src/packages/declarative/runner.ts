// The built-in generic adapter. It runs CustomEndpoint records for the custom API package and
// for declarative packages, which ship no code of their own.
// Saved non-secret headers and a POST body travel through the host's generic fetch extension;
// the host refuses credential-like headers and sends only plain GETs to private addresses.
import type { Adapter, AdapterContext, CommandResult, CustomCommand, CustomEndpoint, ShapedData } from "@/core/contracts";
import type { GenericFetchRequest } from "@/features/integrations/host/http";
import { fillPlaceholders } from "@/features/integrations/params";
import { shapeFromFields } from "@/features/integrations/shape";
import { checkStatus, defineAdapter, fail, ReadError, saidBy, type ReadFn } from "../lib";

type GenericHttp = { fetch(req: GenericFetchRequest): ReturnType<AdapterContext["http"]["fetch"]> };

const PLACEHOLDER = /\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * A9.3: fills {{ params.x }} in a path or query value. Values are URL-encoded (so a value can never
 * add a path segment or a query parameter); "." and ".." are refused, and a missing value is an error
 * naming the setting. Defaults from the params schema apply.
 */
export function fillRequestText(text: string, params: Record<string, unknown>, schema: Record<string, unknown> | undefined, encode = true): string {
  const props = ((schema as { properties?: Record<string, { default?: unknown; title?: string }> } | undefined)?.properties ?? {});
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const raw = params[name] ?? props[name]?.default;
    const v = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : typeof raw === "boolean" ? String(raw) : "";
    if (!v) fail("config", `Pick ${(props[name]?.title ?? name).toLowerCase()} first.`, `The "${name}" setting is required for this read.`);
    if (v === "." || v === ".." || v.length > 512) fail("config", `"${v.slice(0, 40)}" is not a usable value for ${props[name]?.title ?? name}.`);
    return encode ? encodeURIComponent(v) : v;
  });
}

/** The endpoint's path and query with its settings filled in (A9.3). */
export function filledRequest(e: Pick<CustomEndpoint, "path" | "query" | "params">, params: Record<string, unknown>): { path: string; query?: Record<string, string> } {
  const path = fillRequestText(e.path, params, e.params);
  const query = e.query ? Object.fromEntries(Object.entries(e.query).map(([k, v]) => [k, fillRequestText(v, params, e.params, false)])) : undefined;
  return { path, ...(query ? { query } : {}) };
}

/** A8.4 formats from the endpoint (A9.3): `format` on a stat or series, `columnFormats` by column key or label. */
export function withFormats(data: ShapedData, e: Pick<CustomEndpoint, "format" | "columnFormats">): ShapedData {
  if ((data.kind === "stat" || data.kind === "series") && e.format && !data.format) return { ...data, format: e.format };
  if (data.kind === "table" && e.columnFormats) {
    const f = e.columnFormats;
    return { ...data, columns: data.columns.map((c) => { const x = f[c.key] ?? f[c.label]; return x && !c.format ? { ...c, format: x } : c; }) };
  }
  return data;
}

async function call(ctx: AdapterContext, e: CustomEndpoint, params: Record<string, unknown> = {}) {
  const http = ctx.http as GenericHttp;
  const filled = filledRequest(e, params);
  const res = await http.fetch({
    path: filled.path,
    method: e.method,
    ...(filled.query ? { query: filled.query } : {}),
    ...(e.auth ? { auth: e.auth } : {}),
    ...(e.headers && Object.keys(e.headers).length ? { headers: e.headers } : {}),
    ...(e.method === "POST" && e.body !== undefined ? { body: e.body } : {}),
  });
  checkStatus(res, e.auth ? "the saved secret" : undefined, await saidBy(res));
  return res.json();
}

export function createGenericAdapter(endpoints: CustomEndpoint[]): Adapter {
  const reads: Record<string, ReadFn> = {};
  for (const e of endpoints) {
    reads[e.id] = async (ctx, params) => {
      const json = await call(ctx, e, params);
      try {
        return { data: withFormats(shapeFromFields(json, e.shape, e.fields, e.label), e) };
      } catch (err) {
        return fail("bad_response", `The answer no longer matches the picked fields: ${(err as Error).message}.`, "Run Try it again and re-pick the fields.");
      }
    };
  }
  return defineAdapter({
    async health(ctx) {
      // A read that needs a setting cannot be called without one: health uses the first read that needs none.
      const first = endpoints.find((x) => !/\{\{/.test(x.path) && !Object.values(x.query ?? {}).some((v) => v.includes("{{")));
      if (first) {
        await call(ctx, first);
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

/**
 * v3 (section 3.1): runs one CustomCommand record (declarative commands.json or a Custom API
 * integration's own). `params` were validated by host.command() before this is called; only then
 * are the body's "{{ params.<name> }}" placeholders filled. Path and query are literal.
 */
export async function runCustomCommand(ctx: AdapterContext, cmd: CustomCommand, params: Record<string, unknown>): Promise<CommandResult> {
  const http = ctx.http as GenericHttp;
  try {
    const res = await http.fetch({
      path: cmd.path,
      method: cmd.method,
      ...(cmd.query ? { query: cmd.query } : {}),
      ...(cmd.auth ? { auth: cmd.auth } : {}),
      ...(cmd.headers && Object.keys(cmd.headers).length ? { headers: cmd.headers } : {}),
      ...(cmd.body !== undefined ? { body: fillPlaceholders(cmd.body, params) } : {}),
    });
    checkStatus(res, cmd.auth ? "the saved secret" : undefined, await saidBy(res));
    return { ok: true, at: ctx.now().toISOString() };
  } catch (err) {
    const e = (err as { adapterError?: ReadError["adapterError"] }).adapterError;
    return { ok: false, error: e ?? { code: "bad_response", message: "The command failed in an unexpected way." }, at: ctx.now().toISOString() };
  }
}
