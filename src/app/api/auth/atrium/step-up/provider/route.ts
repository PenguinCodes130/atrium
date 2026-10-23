// Starts a forced fresh sign-in at the user's provider, for Google-only or OIDC-only users.
import { errorResponse } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { startProviderStepUp } from "@/features/auth/server/step-up";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { next?: unknown };
    const { url, setCookies } = await startProviderStepUp(req.headers, typeof body.next === "string" ? body.next : "/");
    const res = Response.json({ url });
    for (const c of setCookies) res.headers.append("Set-Cookie", c);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
