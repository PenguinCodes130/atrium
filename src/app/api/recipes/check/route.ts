import { integrationIn, jsonBody, progressOut, recipeRoute, send } from "@/features/recipes/api";
import { progressOf, startIntegrationCheck } from "@/features/recipes/service";

export const dynamic = "force-dynamic";

// The live check of one integration's recipe reads: GET its progress ("Checked 37 of 120"), POST to run it again.
export function GET(req: Request) {
  return recipeRoute(req, (p) => send(progressOut, progressOf(p, new URL(req.url).searchParams.get("integrationId") ?? "")));
}

export function POST(req: Request) {
  return recipeRoute(req, async (p) => send(progressOut, startIntegrationCheck(p, (await jsonBody(req, integrationIn)).integrationId), 202));
}
