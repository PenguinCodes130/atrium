import { recipeRoute, recipesOut, send } from "@/features/recipes/api";
import { recipesView } from "@/features/recipes/service";
import { ensureDailyChecks } from "@/features/recipes/daily";

export const dynamic = "force-dynamic";

// The Recipes section of one integration: the recipes that apply, their source, reads and live check results (editors and agents).
export function GET(req: Request) {
  return recipeRoute(req, (p) => {
    ensureDailyChecks();
    return send(recipesOut, recipesView(p, new URL(req.url).searchParams.get("integrationId") ?? ""));
  });
}
