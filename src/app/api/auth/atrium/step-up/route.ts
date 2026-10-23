// Step-up (architecture section 5). GET reports the method and whether this session is covered;
// POST checks a TOTP code or the password and covers the session for 10 minutes.
import { z } from "zod";
import { AtriumError, errorResponse } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { STEP_UP_WINDOW_MS, stepUpValid } from "@/features/auth/server/policy";
import { stepUpMethodFor } from "@/features/auth/server/session";
import { stepUpWithPassword, stepUpWithTotp } from "@/features/auth/server/step-up";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("method", [
  z.object({ method: z.literal("totp"), code: z.string().max(16) }),
  z.object({ method: z.literal("password"), password: z.string().max(256) }),
]);

export async function GET(req: Request) {
  try {
    const s = await requireUser(req);
    const valid = stepUpValid(s.session.stepUpAt);
    return Response.json({
      method: stepUpMethodFor(s.user.id),
      valid,
      until: valid && s.session.stepUpAt ? new Date(s.session.stepUpAt.getTime() + STEP_UP_WINDOW_MS).toISOString() : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AtriumError("Enter the code or password.", 400, "bad_request");
    const b = parsed.data;
    if (b.method === "totp") await stepUpWithTotp(req.headers, b.code);
    else await stepUpWithPassword(req.headers, b.password);
    return Response.json({ ok: true, until: new Date(Date.now() + STEP_UP_WINDOW_MS).toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
}
