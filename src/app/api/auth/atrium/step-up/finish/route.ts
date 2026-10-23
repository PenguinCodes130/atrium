// The provider sent the user back: give the new session its step-up and return to where they were.
import { cookies } from "next/headers";
import { AtriumError } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { STEP_UP_COOKIE, finishProviderStepUp } from "@/features/auth/server/step-up";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const jar = await cookies();
  const ticket = jar.get(STEP_UP_COOKIE)?.value;
  jar.delete({ name: STEP_UP_COOKIE, path: "/api/auth/atrium/step-up" });
  try {
    await requireUser(req);
    const next = await finishProviderStepUp(req.headers, ticket);
    return Response.redirect(new URL(next, req.url), 303);
  } catch (err) {
    const code = err instanceof AtriumError && err.status === 401 ? "signed_out" : "failed";
    return Response.redirect(new URL(`/step-up?error=${code}`, req.url), 303);
  }
}
