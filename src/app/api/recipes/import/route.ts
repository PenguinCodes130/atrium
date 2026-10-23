import { importIn, importOut, jsonBody, recipeRoute, send } from "@/features/recipes/api";
import { importRecipe } from "@/features/recipes/service";

export const dynamic = "force-dynamic";

// Import a recipe file's text or an https link (2 MB) as a draft; 409 recipe_exists offers replace or keep both.
export function POST(req: Request) {
  return recipeRoute(req, async (p) => send(importOut, await importRecipe(p, await jsonBody(req, importIn)), 201));
}
