// The recipe catalog (A9.1): built-in recipes from the repo plus the ones stored in this instance,
// which integrations each applies to, and the endpoints their reads add. An invalid stored recipe is
// listed with its problem and the rest still load.
import "server-only";
import type { EndpointDef, RecipeRead } from "@/core/contracts";
import { CUSTOM_MIN_REFRESH_SEC } from "@/features/integrations/manifest";
import { BUILTIN_RECIPES, BUILTIN_READ_RECIPE } from "@/packages/prometheus/full-manifest";
import type { Recipe as PromRecord } from "@/packages/prometheus/recipe";
import { registerExtraNeeds } from "@/packages/prometheus/adapter";
import { promRecordOf, recipeEndpointId, rewriteChoices, validateRecipe, type RecipeFile } from "./schema";
import * as repo from "./repo";

export type RecipeSource = RecipeFile["source"];
export type CatalogEntry = {
  id: string;
  recipe: RecipeFile | null; // null when a stored file no longer validates
  problem?: string;
  status: "draft" | "active";
  source: RecipeSource;
  builtin: boolean;
  skipped: { title: string; reason: string }[];
  originIntegrationId?: string;
  createdById?: string;
  importedAt?: string;
  updatedAt?: string;
};

type IntegrationLike = { id: string; packageId: string; config: Record<string, unknown> };

const g = globalThis as unknown as { __atriumRecipeCatalog?: { sig: string; entries: CatalogEntry[] } };

/** Every recipe, built-ins first (in order), then stored ones by import time. */
export function catalog(): CatalogEntry[] {
  const rows = repo.listRecipeRows();
  const sig = rows.map((r) => `${r.id}@${r.updatedAt.getTime()}:${r.status}`).sort().join("|");
  if (g.__atriumRecipeCatalog?.sig === sig) return g.__atriumRecipeCatalog.entries;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const entries: CatalogEntry[] = BUILTIN_RECIPES.map((r) => {
    const o = byId.get(r.id);
    return { id: r.id, recipe: r, status: o?.status ?? "active", source: "builtin", builtin: true, skipped: [], ...(o ? { updatedAt: o.updatedAt.toISOString() } : {}) };
  });
  const builtinIds = new Set(BUILTIN_RECIPES.map((r) => r.id));
  for (const row of [...rows].sort((a, b) => a.importedAt.getTime() - b.importedAt.getTime())) {
    if (builtinIds.has(row.id) || !row.record) continue;
    const v = validateRecipe(row.record);
    entries.push({
      id: row.id,
      recipe: v.ok ? v.recipe : null,
      ...(v.ok ? {} : { problem: `${v.problem.field} ${v.problem.message}` }),
      status: row.status,
      source: row.source,
      builtin: false,
      skipped: row.skipped ?? [],
      ...(row.originIntegrationId ? { originIntegrationId: row.originIntegrationId } : {}),
      ...(row.createdById ? { createdById: row.createdById } : {}),
      importedAt: row.importedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  g.__atriumRecipeCatalog = { sig, entries };
  return entries;
}

export function forgetCatalog(): void {
  g.__atriumRecipeCatalog = undefined;
}

export function getEntry(id: string): CatalogEntry | undefined {
  return catalog().find((e) => e.id === id);
}

const norm = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase().replace(/\s+/g, " ") : "");

/** Whether a recipe applies to an integration (A9.1 appliesTo). */
export function appliesTo(e: CatalogEntry, row: IntegrationLike): boolean {
  const a = e.recipe?.appliesTo;
  if (!a) return false;
  if ("package" in a) return a.package === row.packageId;
  if ("metrics" in a) return row.packageId === "prometheus";
  return row.packageId === "custom-api" && (e.originIntegrationId === row.id || (!!norm(row.config.specTitle) && norm(row.config.specTitle) === norm(a.spec.title)));
}

/** The recipes that apply to an integration, built-ins first. */
export function recipesFor(row: IntegrationLike): CatalogEntry[] {
  return catalog().filter((e) => e.recipe ? appliesTo(e, row) : e.originIntegrationId === row.id);
}

/** Built-in read ids whose built-in recipe is turned off (dropped from the endpoint list). */
export function offBuiltinReads(): Set<string> {
  const off = new Set(catalog().filter((e) => e.builtin && e.status !== "active").map((e) => e.id));
  if (!off.size) return new Set();
  return new Set([...BUILTIN_READ_RECIPE].filter(([, rid]) => off.has(rid)).map(([readId]) => readId));
}

export type RecipeEndpoint = EndpointDef & { recipe: { id: string; name: string; source: RecipeSource; status: "draft" | "active" } };

const SOURCE_WORDS: Record<RecipeSource, string> = { builtin: "built in", file: "from a file", url: "from a link", grafana: "from Grafana", spec: "from the spec" };

/** The tag of a built-in recipe read ("Node exporter, built in"), or nothing. */
export function builtinFrom(packageId: string, endpointId: string): { from?: string } {
  if (packageId !== "prometheus") return {};
  const rid = BUILTIN_READ_RECIPE.get(endpointId);
  const r = rid ? BUILTIN_RECIPES.find((x) => x.id === rid) : undefined;
  return r ? { from: fromTag(r.name, "builtin") } : {};
}

/** "Node Exporter Full, from Grafana": the small tag a recipe read carries in the picker. */
export function fromTag(name: string, source: RecipeSource): string {
  return `${name}, ${SOURCE_WORDS[source]}`;
}

function endpointOfRead(e: CatalogEntry, r: RecipeRead, own: Set<string>): RecipeEndpoint {
  const rec = e.recipe!;
  const refresh = Math.max(r.refreshSec ?? 60, CUSTOM_MIN_REFRESH_SEC);
  const params = rewriteChoices(rec.id, r, own);
  return {
    id: recipeEndpointId(rec.id, r.id),
    label: r.label,
    description: r.description ?? fromTag(rec.name, e.source),
    ...(params ? { params } : {}),
    shape: r.shape,
    defaultRefreshSec: refresh,
    minRefreshSec: CUSTOM_MIN_REFRESH_SEC,
    group: r.group ?? rec.name,
    ...(r.advanced ? { advanced: true } : {}),
    ...(r.needs ? { needs: r.needs } : "metrics" in rec.appliesTo ? { needs: `the metrics ${rec.appliesTo.metrics.slice(0, 3).join(", ")}` } : {}),
    recipe: { id: rec.id, name: rec.name, source: e.source, status: e.status },
  };
}

/**
 * The endpoints an integration's applicable, stored recipes add (built-in reads are already package
 * endpoints). Drafts are included only for the live check. A spec recipe never repeats an endpoint
 * its own Custom API integration already has.
 */
export function recipeEndpoints(row: IntegrationLike, opts: { includeDrafts?: boolean; customIds?: Set<string> } = {}): RecipeEndpoint[] {
  const out: RecipeEndpoint[] = [];
  for (const e of recipesFor(row)) {
    if (e.builtin || !e.recipe || (e.status !== "active" && !opts.includeDrafts)) continue;
    const own = new Set(e.recipe.reads.map((r) => r.id));
    for (const r of e.recipe.reads) {
      if (e.source === "spec" && opts.customIds?.has(r.id)) continue;
      out.push(endpointOfRead(e, r, own));
    }
  }
  return out;
}

export type ResolvedRead = { entry: CatalogEntry; read: RecipeRead; record: PromRecord | null };

/** The recipe read behind an r: endpoint id, when its recipe applies to this integration. */
export function resolveRead(row: IntegrationLike, recipeId: string, readId: string, opts: { includeDrafts?: boolean } = {}): ResolvedRead | undefined {
  const entry = getEntry(recipeId);
  if (!entry?.recipe || entry.builtin || !appliesTo(entry, row)) return undefined;
  if (entry.status !== "active" && !opts.includeDrafts) return undefined;
  const read = entry.recipe.reads.find((r) => r.id === readId);
  if (!read) return undefined;
  return { entry, read, record: promRecordOf(read as Parameters<typeof promRecordOf>[0]) };
}

/** A9.1 metrics recipes: their reads are offered only when one of the metrics exists (A8.1). */
export function metricNeeds(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of catalog()) {
    if (!e.recipe || e.builtin || !("metrics" in e.recipe.appliesTo)) continue;
    for (const r of e.recipe.reads) out[recipeEndpointId(e.recipe.id, r.id)] = e.recipe.appliesTo.metrics;
  }
  return out;
}

// Imported metrics recipes answer A8.1 availability through the Prometheus package's one metric-name request.
registerExtraNeeds(metricNeeds);
