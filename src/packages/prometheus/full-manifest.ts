// The Prometheus manifest as the registry sees it: manifest.json (config, secrets and the special
// reads) with one endpoint per built-in recipe read, recipes first (architecture section 3, A8.1).
// Wave 2.8 (A9.1): the ready-made reads live in built-in recipe files under recipes/, each read
// carrying its Wave 2.7 record, so ids, words and results are unchanged.
import type { PackageManifest } from "@/core/contracts";
import { promRecordOf, validateRecipe, type RecipeFile } from "@/features/recipes/schema";
import base from "./manifest.json";
import { endpointOf, type Recipe } from "./recipe";
import nodeExporter from "./recipes/node-exporter.atrium-recipe.json";
import cadvisor from "./recipes/cadvisor.atrium-recipe.json";
import proxmox from "./recipes/proxmox.atrium-recipe.json";

function load(raw: unknown): RecipeFile {
  const v = validateRecipe(raw);
  if (!v.ok) throw new Error(`built-in recipe is invalid: ${v.problem.field} ${v.problem.message}`);
  if (v.recipe.source !== "builtin") throw new Error(`built-in recipe ${v.recipe.id} must have source "builtin"`);
  return v.recipe;
}

/** The built-in Prometheus recipes, in picker order. */
export const BUILTIN_RECIPES: RecipeFile[] = [nodeExporter, cadvisor, proxmox].map(load);

/** Every built-in read as its Wave 2.7 record, in order (run by recipe.ts). */
export const RECIPES: Recipe[] = BUILTIN_RECIPES.flatMap((r) => r.reads.map((x) => promRecordOf(x)!));

/** Which built-in recipe each built-in read id belongs to. */
export const BUILTIN_READ_RECIPE: Map<string, string> = new Map(BUILTIN_RECIPES.flatMap((r) => r.reads.map((x) => [x.id, r.id] as const)));

const ids = new Set<string>();
for (const r of RECIPES) {
  if (ids.has(r.id)) throw new Error(`recipe id ${r.id} is used twice`);
  ids.add(r.id);
}
const json = base as unknown as PackageManifest;
for (const e of json.endpoints) if (ids.has(e.id)) throw new Error(`Prometheus endpoint ${e.id} is both a recipe and a special read`);

export const prometheusManifest: PackageManifest = { ...json, endpoints: [...RECIPES.map(endpointOf), ...json.endpoints] };
export default prometheusManifest;
