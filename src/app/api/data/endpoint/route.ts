import { z } from "zod";
import { NotFound } from "@/core/errors";
import { handle, send, widgetDataOut } from "@/features/integrations/api";
import { readThrough } from "@/features/data";
import { readableIntegration } from "@/features/integrations/service";
import { endpointsOf } from "@/features/integrations/runtime";

export const dynamic = "force-dynamic";
const q = z.object({ integration: z.string().min(1), endpoint: z.string().min(1), params: z.string().max(4096).optional(), refresh: z.coerce.number().int().positive().optional(), cached: z.enum(["1"]).optional() });

// One endpoint's value through the shared cache (endpoint previews on the Integrations page).
// Signed-in sessions only (handle -> requireUser: no guests, no bearer tokens). Round 5 addendum: only
// the owner, the integration's creator, or anyone when it is Shared; otherwise the same 404 as an
// unknown endpoint, so ids cannot be probed.
export function GET(req: Request) {
  return handle(req, undefined, async (s) => {
    const p = q.parse(Object.fromEntries(new URL(req.url).searchParams));
    const row = readableIntegration(s.principal, p.integration);
    const ep = endpointsOf(row).find((e) => e.id === p.endpoint);
    if (!ep) throw new NotFound("That endpoint does not exist.");
    let params: unknown = undefined;
    if (p.params) { try { params = JSON.parse(p.params); } catch { throw new NotFound("Those parameters are not valid JSON."); } }
    const refresh = Math.max(p.refresh ?? ep.defaultRefreshSec, ep.minRefreshSec);
    return send(widgetDataOut, await readThrough({ integrationId: row.id, endpointId: ep.id, params }, refresh, { cachedOnly: p.cached === "1" }));
  });
}
