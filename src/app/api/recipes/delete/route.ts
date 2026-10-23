import { idIn, jsonBody, okOut, recipeRoute, send } from "@/features/recipes/api";
import { deleteRecipe } from "@/features/recipes/service";

export const dynamic = "force-dynamic";

// Delete an imported recipe (built-in ones can only be turned off). Signed-in owners and members only.
export function POST(req: Request) {
  return recipeRoute(req, async (p) => {
    deleteRecipe(p, (await jsonBody(req, idIn)).id);
    return send(okOut, { ok: true });
  });
}
