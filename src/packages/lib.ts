// Helpers shared by the official adapters. Adapters only see HostHttp and never a secret value.
import type { Adapter, AdapterContext, AdapterError, CommandResult, HealthResult, HostResponse, ReadResult, ShapedData } from "@/core/contracts";
import { serviceSaid } from "@/features/integrations/host/errors";

/** An adapter-raised error with a safe AdapterError. Structurally matches the host's HostError. */
export class ReadError extends Error {
  constructor(readonly adapterError: AdapterError) {
    super(adapterError.message);
  }
}

export function fail(code: AdapterError["code"], message: string, hint?: string): never {
  throw new ReadError({ code, message, ...(hint ? { hint } : {}) });
}

function asAdapterError(err: unknown): AdapterError {
  const e = err as { adapterError?: AdapterError };
  if (e && typeof e === "object" && e.adapterError && typeof e.adapterError.code === "string") return e.adapterError;
  return { code: "bad_response", message: "The service's answer could not be read.", hint: "Check the base URL points at the right service." };
}

/** The service's own reason for an error answer (first 200 characters), or undefined. */
export async function saidBy(res: HostResponse): Promise<string | undefined> {
  if (res.status < 400) return undefined;
  try {
    return serviceSaid(await res.text(), res.headers["content-type"] ?? "");
  } catch {
    return undefined;
  }
}

/**
 * Turns an HTTP status into an error. `secretLabel` names the credential field in the message;
 * `said` is the service's own reason, shown as "The service said: ..." (usability r1 finding 4).
 */
export function checkStatus(res: HostResponse, secretLabel?: string, said?: string): void {
  const s = res.status;
  if (s === 401 || s === 403) {
    fail("auth", `The service refused ${secretLabel ? `the "${secretLabel}" field` : "the request"} (HTTP ${s}).`, secretLabel ? `Check ${secretLabel} is correct, not expired, and allowed to read.` : "Check the service's access settings.");
  }
  if (s === 429) {
    const retry = Number(res.headers["retry-after"]);
    throw new ReadError({ code: "rate_limited", message: "The service is limiting requests right now.", hint: "Atrium backs off and tries again.", ...(retry > 0 ? { retryAfterSec: retry } : {}) });
  }
  if (s === 404) fail("bad_response", "The service answered, but that path does not exist (HTTP 404).", "Check the base URL, including any path prefix.");
  if (s >= 400) fail("bad_response", `The service answered with an error (HTTP ${s}).`, said ? `The service said: "${said}"` : s >= 500 ? "Check the service's own logs." : "Check the address and its parameters.");
}

export async function getJson(ctx: AdapterContext, path: string, opts: { query?: Record<string, string>; auth?: string; secretLabel?: string } = {}): Promise<unknown> {
  const res = await ctx.http.fetch({ path, ...(opts.query ? { query: opts.query } : {}), ...(opts.auth ? { auth: opts.auth } : {}) });
  checkStatus(res, opts.secretLabel, await saidBy(res));
  return res.json();
}

export function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("bad_response", `The service's ${what} was not in the expected format.`, "Check the base URL and the product version.");
  return v as Record<string, unknown>;
}

export function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) fail("bad_response", `The service's ${what} was not a list.`, "Check the base URL and the product version.");
  return v;
}

export type ReadFn = (ctx: AdapterContext, params: Record<string, unknown>) => Promise<{ data: ShapedData; sourceTimestamp?: string }>;
/** v3 (section 3.1): runs one declared command. Params are already validated by the host. */
export type CommandFn = (ctx: AdapterContext, params: Record<string, unknown>) => Promise<{ message?: string } | void>;

/** Sends one command request and checks its status. Returns the response for an optional message. */
export async function sendCommand(ctx: AdapterContext, req: { path: string; method?: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; query?: Record<string, string>; auth?: string; secretLabel?: string }): Promise<HostResponse> {
  const res = await ctx.http.fetch({ path: req.path, method: req.method ?? "POST", ...(req.body !== undefined ? { body: req.body } : {}), ...(req.query ? { query: req.query } : {}), ...(req.auth ? { auth: req.auth } : {}) });
  checkStatus(res, req.secretLabel, await saidBy(res));
  return res;
}

/** Builds an Adapter that times health checks and turns thrown errors into ReadResult failures. */
export function defineAdapter(spec: { health: (ctx: AdapterContext) => Promise<{ status?: HealthResult["status"]; version?: string; message?: string }>; reads: Record<string, ReadFn>; commands?: Record<string, CommandFn> }): Adapter {
  const commands = spec.commands;
  return {
    ...(commands
      ? {
          async command(ctx: AdapterContext, commandId: string, params: unknown): Promise<CommandResult> {
            const fn = Object.prototype.hasOwnProperty.call(commands, commandId) ? commands[commandId] : undefined;
            if (!fn) return { ok: false, error: { code: "permission", message: `This package has no command "${commandId}".` }, at: ctx.now().toISOString() };
            try {
              const p = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
              const r = await fn(ctx, p);
              return { ok: true, ...(r && r.message ? { message: r.message } : {}), at: ctx.now().toISOString() };
            } catch (err) {
              return { ok: false, error: asAdapterError(err), at: ctx.now().toISOString() };
            }
          },
        }
      : {}),
    async health(ctx) {
      const start = performance.now();
      try {
        const r = await spec.health(ctx);
        return { status: r.status ?? "ok", latencyMs: Math.round(performance.now() - start), ...(r.version ? { version: r.version } : {}), ...(r.message ? { message: r.message } : {}) };
      } catch (err) {
        const e = asAdapterError(err);
        throw new ReadError(e);
      }
    },
    async read(ctx, endpointId, params) {
      const fetchedAt = ctx.now().toISOString();
      const fn = spec.reads[endpointId];
      if (!fn) return { ok: false, error: { code: "config", message: `This package has no endpoint "${endpointId}".` }, fetchedAt };
      try {
        const p = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
        const { data, sourceTimestamp } = await fn(ctx, p);
        return { ok: true, data, sourceTimestamp: sourceTimestamp ?? fetchedAt, fetchedAt } satisfies ReadResult;
      } catch (err) {
        return { ok: false, error: asAdapterError(err), fetchedAt };
      }
    },
  };
}

export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : v === undefined || v === null ? fallback : String(v);
}

export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function param(params: Record<string, unknown>, key: string, required = true): string {
  const v = params[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) fail("config", `The "${key}" parameter is required for this endpoint.`);
  return "";
}
