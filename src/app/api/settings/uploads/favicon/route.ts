import { z } from "zod";
import { AtriumError, Forbidden, errorResponse } from "@/core/errors";
import { requireScope } from "@/features/auth";
import { NO_STORE } from "@/features/settings/api";
import { FAVICON_MESSAGES } from "@/features/uploads/favicon/messages";
import { fetchFavicon } from "@/features/uploads/favicon/fetch";

export const dynamic = "force-dynamic";

const OUT = z.object({ path: z.string().regex(/^\/uploads\/[a-z0-9]{20}\.(png|jpg|gif|webp|avif|svg)$/), name: z.string() });

// The favicon fetch (architecture A11.6; operator-tryout-spec N4): { url, refresh? } in, { path, name } out, or
// { error: { code, message } } with a plain sentence. Owners and members with a session, and agents
// with atrium:edit; viewers and guests are refused before anything leaves the server. The website is
// read by this server only, through integrations' egress engine (see features/uploads/favicon/fetch.ts).
export async function POST(req: Request) {
  try {
    const p = await requireScope("atrium:edit", { req, minRole: "member" }).catch((err: unknown) => {
      if (err instanceof Forbidden) throw new Forbidden(FAVICON_MESSAGES.forbidden);
      throw err;
    });
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new AtriumError("The request body must be JSON.");
    }
    const body = raw && typeof raw === "object" ? (raw as { url?: unknown; refresh?: unknown }) : {};
    // `refresh: true` skips the 7 day store and fetches again (gauntlet w210c-r1 Fix 6b).
    const r = await fetchFavicon(p, body.url, { refresh: body.refresh === true });
    return Response.json(OUT.parse({ path: r.path, name: r.name }), { headers: { ...NO_STORE, "x-atrium-favicon": r.cached ? "cached" : "fetched" } });
  } catch (err) {
    if (!(err instanceof AtriumError)) console.error("[uploads] favicon route error", err instanceof Error ? err.message : "unknown");
    return errorResponse(err);
  }
}
