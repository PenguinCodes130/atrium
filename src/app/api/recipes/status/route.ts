import { jsonBody, okOut, recipeRoute, send, statusIn } from "@/features/recipes/api";
import { setStatus } from "@/features/recipes/service";

export const dynamic = "force-dynamic";

// Turn a recipe on (active) or off (draft). Signed-in owners and members only; turning on runs the live check.
export function POST(req: Request) {
  return recipeRoute(req, async (p) => {
    const b = await jsonBody(req, statusIn);
    setStatus(p, b.id, b.status, b.integrationId);
    return send(okOut, { ok: true });
  });
}
