import { recipeRoute } from "@/features/recipes/api";
import { exportRecipe } from "@/features/recipes/service";

export const dynamic = "force-dynamic";

// Download one recipe as <id>.atrium-recipe.json (sorted keys, 2-space indent). Needs edit access.
export function GET(req: Request) {
  return recipeRoute(req, (p) => {
    const { fileName, text } = exportRecipe(p, new URL(req.url).searchParams.get("id") ?? "");
    return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${fileName}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  });
}
