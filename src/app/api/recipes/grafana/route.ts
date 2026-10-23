import { grafanaIn, importOut, jsonBody, recipeRoute, send } from "@/features/recipes/api";
import { importGrafana } from "@/features/recipes/service";

export const dynamic = "force-dynamic";

// Import a Grafana dashboard (grafana.com id or JSON) onto a Prometheus integration as a draft recipe.
export function POST(req: Request) {
  return recipeRoute(req, async (p) => send(importOut, await importGrafana(p, await jsonBody(req, grafanaIn)), 201));
}
