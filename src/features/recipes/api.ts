// Route helpers for /api/recipes/* (A9.1, A9.2). Every handler resolves the caller through auth
// (a session or an agent token); signed-out callers, guests and viewers get the same not found as
// an unknown integration. Output goes through Zod schemas that strip anything else: no recipe
// response carries a secret value or integration config (criterion 14).
import "server-only";
import { z } from "zod";
import type { Principal } from "@/core/contracts";
import { AtriumError, errorResponse, NotFound } from "@/core/errors";
import { getPrincipal } from "@/features/auth";
import { InvalidRecipe, RecipeExists } from "./service";

export async function recipeRoute(req: Request, fn: (p: Principal) => Promise<Response> | Response): Promise<Response> {
  try {
    const p = await getPrincipal(req).catch(() => null);
    if (!p) throw new NotFound("Those recipes do not exist.");
    return await fn(p);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const i = err.issues[0];
      return Response.json({ error: { code: "bad_request", message: i ? `${i.path.join(".") || "The request"}: ${i.message}` : "That request is not valid." } }, { status: 400, headers: NO_STORE });
    }
    if (err instanceof RecipeExists) return Response.json({ error: { code: err.code, message: err.message }, existing: err.existing, incoming: err.incoming }, { status: 409, headers: NO_STORE });
    if (err instanceof InvalidRecipe) return Response.json({ error: { code: err.code, message: err.message, field: err.field } }, { status: 400, headers: NO_STORE });
    return errorResponse(err);
  }
}

export const NO_STORE = { "cache-control": "no-store" };

export async function jsonBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new AtriumError("The request body must be JSON.", 400, "bad_request"); }
  return schema.parse(raw);
}

export function send<T>(schema: z.ZodType<T>, data: unknown, status = 200): Response {
  return Response.json(schema.parse(data), { status, headers: NO_STORE });
}

const check = z.object({ status: z.enum(["ok", "empty", "failed", "odd"]), reason: z.string().optional(), at: z.string() });
const skipped = z.object({ title: z.string(), reason: z.string() });
export const progressOut = z.object({ running: z.boolean(), total: z.number(), done: z.number(), startedAt: z.string().optional(), finishedAt: z.string().optional() });
export const recipesOut = z.object({
  integrationId: z.string(), packageId: z.string(), migrated: z.boolean(), canChange: z.boolean(), canImport: z.boolean(), grafana: z.boolean(),
  progress: progressOut,
  recipes: z.array(z.object({
    id: z.string(), name: z.string(), version: z.string(), author: z.string(), description: z.string(), source: z.string(), tag: z.string(),
    status: z.enum(["draft", "active"]), builtin: z.boolean(), problem: z.string().optional(),
    reads: z.number(), checked: z.number(), works: z.number(), lastCheckedAt: z.string().optional(), stale: z.boolean(),
    skipped: z.array(skipped),
    readList: z.array(z.object({ endpointId: z.string(), label: z.string(), group: z.string().optional(), check: check.optional() })),
  })),
});
export const importOut = z.object({ id: z.string(), name: z.string(), reads: z.number(), status: z.enum(["draft", "active"]), skipped: z.array(skipped), checking: z.boolean() });
export const okOut = z.object({ ok: z.literal(true) });

export const importIn = z.object({
  text: z.string().max(2 * 1024 * 1024 + 1024).optional(),
  url: z.string().max(2048).optional(),
  integrationId: z.string().max(100).optional(),
  onConflict: z.enum(["replace", "keep-both"]).optional(),
});
export const grafanaIn = z.object({
  integrationId: z.string().min(1).max(100),
  dashboardId: z.string().max(200).optional(),
  json: z.string().max(10 * 1024 * 1024 + 1024).optional(),
  onConflict: z.enum(["replace", "keep-both"]).optional(),
});
export const statusIn = z.object({ id: z.string().min(1).max(120), status: z.enum(["draft", "active"]), integrationId: z.string().max(100).optional() });
export const idIn = z.object({ id: z.string().min(1).max(120) });
export const integrationIn = z.object({ integrationId: z.string().min(1).max(100) });
