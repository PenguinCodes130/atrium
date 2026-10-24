// Route handlers for GET /api/data/catalogue and POST /api/data/peek (A10.4), kept here so they can
// be tested without Next. A signed-out caller gets 401; anyone else who may not use the catalogue
// (viewers, guests, agents without atrium:edit) gets the same 404 as an unknown route.
import "server-only";
import { z } from "zod";
import { AtriumError, errorResponse, NotFound } from "@/core/errors";
import { getPrincipal } from "@/features/auth";
import { catalogueOut, peekIn, peekOut } from "@/features/integrations/api";
import { MEASURES } from "@/features/integrations/manifest";
import { logger } from "@/core/log";
import { buildCatalogue, mayUseCatalogue, peek } from "./catalogue";

const log = logger("data.catalogue");
const NOT_FOUND = "The data catalogue is not available.";

const query = z.object({
  q: z.string().max(200).optional(),
  fits: z.string().max(60).optional(),
  integrationId: z.string().max(100).optional(),
  measure: z.enum(MEASURES).optional(),
  all: z.enum(["1", "true"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const noStore = { headers: { "cache-control": "no-store" } };

export async function handleCatalogue(req: Request): Promise<Response> {
  try {
    const p = await getPrincipal(req).catch(() => null);
    if (!p) throw new AtriumError("Sign in to continue.", 401, "unauthorized");
    if (!mayUseCatalogue(p)) throw new NotFound(NOT_FOUND);
    const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) throw new AtriumError(q.error.issues[0]?.message ?? "That search is not valid.", 400, "bad_request");
    const start = Date.now();
    const r = await buildCatalogue(p, { ...q.data, all: !!q.data.all });
    log.info("catalogue", { ms: Date.now() - start, items: r.items.length, pending: r.pending.length });
    return Response.json(catalogueOut.parse(r), noStore);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handlePeek(req: Request): Promise<Response> {
  try {
    const p = await getPrincipal(req).catch(() => null);
    if (!p) throw new AtriumError("Sign in to continue.", 401, "unauthorized");
    if (!mayUseCatalogue(p)) throw new NotFound(NOT_FOUND);
    let raw: unknown;
    try { raw = await req.json(); } catch { throw new AtriumError("The request body must be JSON.", 400, "bad_request"); }
    const input = peekIn.safeParse(raw);
    if (!input.success) throw new AtriumError(input.error.issues[0]?.message ?? "Name between 1 and 20 reads.", 400, "bad_request");
    return Response.json(peekOut.parse(await peek(p, input.data.items)), noStore);
  } catch (err) {
    return errorResponse(err);
  }
}
