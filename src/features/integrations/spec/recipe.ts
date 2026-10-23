// A spec import as a shareable recipe (A9.1 source "spec", A9.3): the same reads, words, settings,
// groups and formats, keyed to the spec's title so it applies to any Custom API made from that
// spec. Holds no secrets, no address and no auth placement. Pure.
import type { Recipe, RecipeRead } from "@/core/contracts";
import type { SpecImport, SpecRead } from "./import";

/** "spec/sonarr", "spec/jellyfin-api": lower-case words, at most 31 characters after "spec/". */
export function specRecipeId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/, "");
  return `spec/${/^[a-z0-9]/.test(slug) ? slug : `api${slug ? `-${slug}` : ""}`.slice(0, 31)}`;
}

export function readOf(r: SpecRead): RecipeRead {
  return {
    id: r.id,
    label: r.label,
    ...(r.description ? { description: r.description } : {}),
    ...(r.group ? { group: r.group } : {}),
    ...(r.advanced ? { advanced: true } : {}),
    ...(r.params ? { params: r.params } : {}),
    request: { kind: "http", path: r.path, ...(r.query ? { query: r.query } : {}) },
    fields: r.fields,
    shape: r.shape,
    ...(r.format ? { format: r.format } : {}),
    ...(r.columnFormats ? { columnFormats: r.columnFormats } : {}),
    refreshSec: r.refreshSec,
  };
}

/** The recipe for the reads that were imported (all of them unless a subset is named). */
export function specRecipe(imp: SpecImport, opts: { author: string; readIds?: Set<string> }): Recipe {
  const reads = imp.reads.filter((r) => !opts.readIds || opts.readIds.has(r.id)).map(readOf);
  return {
    atriumRecipe: "1",
    id: specRecipeId(imp.title),
    name: imp.title,
    version: imp.version || "1",
    author: opts.author.slice(0, 120) || "Atrium",
    description: `Reads from the ${imp.title} API spec (${imp.specVersion}${imp.version ? `, version ${imp.version}` : ""}): ${reads.length} reads, ${imp.totals.headline} shown first.`,
    source: "spec",
    appliesTo: { spec: { title: imp.title } },
    reads,
  };
}
