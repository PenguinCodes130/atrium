// GET /api/data/choices (architecture A8.2): the live choices of one endpoint parameter, for the
// builder's picker. Editors only: a viewer, a guest, a signed-out caller and an agent without
// atrium:edit all get the same 404 as an unknown integration, so nothing can be probed. The choices
// come from the rows of another endpoint of the same integration, read live within 3 s and cached
// 30 s in the shared endpoint cache (falling back to its last good value). Only value, label and
// detail leave; never config or secrets.
//
//   ?integrationId=<id>&endpointId=<endpoint whose param it is>&param=<param key>
//   [&params=<JSON of the endpoint's current values, for lists that depend on another setting>]
//   [&q=<search words>]
//   200 { choices: [{ value, label, detail? }], every, total, stale? }
//   400 { error } a setting it depends on is not picked yet, 404 { error } refused or unknown,
//   502 { error: { code, message, hint? } } the service could not answer (the picker keeps "Type it in")
import "server-only";
import { z } from "zod";
import type { Principal, ReadResult } from "@/core/contracts";
import { AtriumError, errorResponse, NotFound } from "@/core/errors";
import { getPrincipal } from "@/features/auth";
import { choicesOut } from "@/features/integrations/api";
import { choicesFrom, choicesSpecs } from "@/features/integrations/choices";
import { canBindReads } from "@/features/integrations/commands";
import { getIntegrationRow } from "@/features/integrations/repo";
import { endpointsOf, readEndpoint } from "@/features/integrations/runtime";
import { canEdit } from "@/features/integrations/service";
import { cacheKey, type SourceRef } from "./keys";
import { dataRuntime } from "./runtime";

export const CHOICES_TIMEOUT_MS = 3000;
export const CHOICES_CACHE_MS = 30_000;

const query = z.object({
  integrationId: z.string().min(1).max(100),
  endpointId: z.string().min(1).max(100),
  param: z.string().min(1).max(100),
  params: z.string().max(4096).optional(),
  q: z.string().max(200).optional(),
});

const NOT_FOUND = "Those choices do not exist.";

/** Who may read choices: editors who may bind this integration's reads. */
export function mayReadChoices(p: Principal | null, row: Parameters<typeof canBindReads>[1] | undefined): boolean {
  return !!p && !!row && canEdit(p) && canBindReads(p, row);
}

const inflight = new Map<string, Promise<ReadResult>>();

/** The choice endpoint's rows: cached when younger than 30 s, else read live within 3 s, else the last good value. */
async function rowsFor(src: SourceRef): Promise<{ data?: ReadResult; stale: boolean }> {
  const { cache } = dataRuntime();
  const key = cacheKey(src);
  const entry = cache.get(key);
  const fresh = entry?.lastGood && entry.fetchedAt && Date.now() - Date.parse(entry.fetchedAt) < CHOICES_CACHE_MS;
  if (fresh) return { data: entry!.lastGood!, stale: false };
  let p = inflight.get(key);
  if (!p) {
    p = readEndpoint(src.integrationId, src.endpointId, src.params, AbortSignal.timeout(CHOICES_TIMEOUT_MS))
      .then((r) => { cache.record(src, r); return r; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const timeout = new Promise<null>((r) => { const t = setTimeout(() => r(null), CHOICES_TIMEOUT_MS + 250); t.unref?.(); });
  const r = await Promise.race([p, timeout]);
  if (r?.ok) return { data: r, stale: false };
  if (entry?.lastGood) return { data: entry.lastGood, stale: true };
  return { ...(r ? { data: r } : {}), stale: false };
}

export async function handleChoices(req: Request): Promise<Response> {
  try {
    const parsed = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    const p = await getPrincipal(req).catch(() => null);
    const row = parsed.success ? getIntegrationRow(parsed.data.integrationId) : undefined;
    if (!mayReadChoices(p, row) || row!.status !== "active") throw new NotFound(NOT_FOUND);
    if (!parsed.success) throw new AtriumError("Name an integration, an endpoint and a parameter.", 400, "bad_request");
    const q = parsed.data;
    const eps = endpointsOf(row!);
    const ep = eps.find((e) => e.id === q.endpointId);
    const spec = ep ? choicesSpecs(ep.params)[q.param] : undefined;
    if (!ep || !spec || !eps.some((e) => e.id === spec.endpointId)) throw new NotFound(NOT_FOUND);
    let current: Record<string, unknown> = {};
    if (q.params) {
      try {
        const v = JSON.parse(q.params) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) current = v as Record<string, unknown>;
      } catch {
        throw new AtriumError("The current settings are not valid JSON.", 400, "bad_request");
      }
    }
    // Only the settings the descriptor names travel on to the choice endpoint.
    const params: Record<string, string> = {};
    for (const [target, from] of Object.entries(spec.params ?? {})) {
      const v = current[from];
      if (typeof v !== "string" || !v.trim() || v === "*") throw new AtriumError(`Pick ${from} first.`, 400, "needs_param");
      params[target] = v.slice(0, 512);
    }
    const src: SourceRef = { integrationId: row!.id, endpointId: spec.endpointId, ...(Object.keys(params).length ? { params } : {}) };
    const { data, stale } = await rowsFor(src);
    if (!data) return Response.json({ error: { code: "timeout", message: "The service did not answer within 3 seconds.", hint: "Type the value in, or try again." } }, { status: 502, headers: { "cache-control": "no-store" } });
    if (!data.ok) return Response.json({ error: { code: data.error.code, message: data.error.message, ...(data.error.hint ? { hint: data.error.hint } : {}) } }, { status: 502, headers: { "cache-control": "no-store" } });
    const { choices, total } = choicesFrom(data.data, spec, q.q);
    return Response.json(choicesOut.parse({ choices, every: spec.every, total, ...(stale ? { stale: true } : {}) }), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
