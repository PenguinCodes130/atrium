// The recipes subsystem's entry points this import uses (A9.1 save, A9.2 live check), behind one
// seam so tests can stand in for them.
import "server-only";
import type { Principal, ReadCheck, Recipe } from "@/core/contracts";
import { checkReads, saveRecipe } from "@/features/recipes";

export type RecipeHooks = {
  saveRecipe: (p: Principal, recipe: Recipe, opts: { status: "draft" | "active"; integrationId?: string }) => Promise<{ id: string }>;
  checkReads: (integrationId: string, endpointIds?: string[]) => Promise<Record<string, ReadCheck>>;
};

export async function recipeHooks(): Promise<RecipeHooks> {
  return { saveRecipe, checkReads };
}
