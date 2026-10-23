// Revoke one guest link (amendment A1.1: its creator, an editor of the app, or the owner). Owned by auth.
import { errorResponse, Unauthorized } from "@/core/errors";
import { getPrincipal } from "@/features/auth";
import { revokeGuestLink } from "@/features/auth/guest/service";
import { hasBearer } from "@/features/auth/server/security";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const p = await getPrincipal(req);
    if (!p && hasBearer(req.headers)) throw new Unauthorized("A valid access token is required.");
    return Response.json({ link: await revokeGuestLink(p, id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
