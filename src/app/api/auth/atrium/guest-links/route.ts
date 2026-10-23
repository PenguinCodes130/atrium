// Guest links API (architecture v3 5.1). Owned by auth. Session users only: an agent's bearer token is
// refused ("Agents cannot create guest links"), a guest cookie counts as signed out.
//   GET  ?appId=<id>                         the app's links (no token, no hash, no PIN)
//   POST {appId, label, expiresAt?, pin?}    create; the response is the only one that holds the link
import { env } from "@/core/env";
import { errorResponse, Unauthorized } from "@/core/errors";
import { getPrincipal } from "@/features/auth";
import { GuestFieldError, createGuestLink, listGuestLinks } from "@/features/auth/guest/service";
import { clientAddress } from "@/features/auth/server/rate-limit";
import { hasBearer } from "@/features/auth/server/security";

export const dynamic = "force-dynamic";

/** The caller: a bearer always resolves as an agent (or nobody); otherwise the session user. */
async function caller(req: Request) {
  const p = await getPrincipal(req);
  if (!p && hasBearer(req.headers)) throw new Unauthorized("A valid access token is required.");
  return p;
}

function failure(err: unknown): Response {
  if (err instanceof GuestFieldError) {
    return Response.json({ error: { code: err.code, field: err.problem.field, message: err.message } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  return errorResponse(err);
}

export async function GET(req: Request) {
  try {
    const appId = new URL(req.url).searchParams.get("appId") ?? "";
    return Response.json(await listGuestLinks(await caller(req), appId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(req: Request) {
  try {
    const p = await caller(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const created = await createGuestLink(p, body ?? {}, { ip: clientAddress(req.headers, env().ATRIUM_TRUSTED_PROXIES) ?? undefined });
    return Response.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}
