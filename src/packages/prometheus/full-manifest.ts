// The Prometheus manifest as the registry sees it: manifest.json (config, secrets and the special
// reads) with one endpoint per built-in recipe read, recipes first (architecture section 3, A8.1).
// Wave 2.8 (A9.1): the ready-made reads live in built-in recipe files under recipes/, each read
// carrying its Wave 2.7 record, so ids, words and results are unchanged.
import type { PackageManifest } from "@/core/contracts";
import { promRecordOf, validateRecipe, type RecipeFile } from "@/features/recipes/schema";
import base from "./manifest.json";
import { endpointOf, hasHistory, historyEndpointOf, HISTORY_PREFIX, type Recipe } from "./recipe";
import type { EndpointDef, Measure } from "@/core/contracts";
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

/** A10.4: what each built-in read measures, and the service's main reads (ranked first). */
const MEASURE_OF: Record<string, Measure> = {
  "machine-cpu": "cpu", "machine-memory": "memory", "machine-memory-bytes": "memory", "machine-disk": "disk", "machine-network": "network", "machine-load": "cpu",
  "machine-uptime": "uptime", "machine-temperature": "temperature", "machine-updates": "count", "machine-up": "status", "machines-up": "status",
  "container-cpu": "cpu", "container-memory": "memory", "containers-count": "count", "containers": "status",
  "pve-guests": "status", "pve-guest": "status", "pve-nodes": "status", "pve-storage": "disk", "pve-not-backed-up": "status",
};
const HEADLINE = new Set(["machine-cpu", "machine-memory", "machine-disk", "machine-network", "machines-up"]);
const SPECIAL: Record<string, Partial<EndpointDef>> = {
  targets: { measure: "status" }, alerts: { measure: "status" }, "alerts-count": { measure: "status", headline: true },
  "disk-health": { measure: "disk" }, "disks-smart": { measure: "disk" },
  "explore-value": { history: { endpointId: "explore-history" } }, query: { history: { endpointId: "range" } },
  metrics: { measure: "other" }, "metric-labels": { measure: "other" }, "metric-label-values": { measure: "other" },
};

/** A10.3: every instant built-in read points at its h:<id> history read (the same query over time). */
// History reads go after every Wave 2.8 endpoint, so the familiar order is unchanged.
const builtinEndpoints: EndpointDef[] = [];
const historyEndpoints: EndpointDef[] = [];
for (const r of RECIPES) {
  const e: EndpointDef = { ...endpointOf(r), ...(MEASURE_OF[r.id] ? { measure: MEASURE_OF[r.id] } : {}), ...(HEADLINE.has(r.id) ? { headline: true } : {}) };
  if (!hasHistory(r)) { builtinEndpoints.push(e); continue; }
  const h = historyEndpointOf(r);
  builtinEndpoints.push({ ...e, history: { endpointId: h.id } });
  historyEndpoints.push({ ...h, ...(e.measure ? { measure: e.measure } : {}) });
}

export const HISTORY_READS: Map<string, Recipe> = new Map(RECIPES.filter(hasHistory).map((r) => [`${HISTORY_PREFIX}${r.id}`, r]));

/** A10.5: monitoring, with machines up and down and firing alerts (the reads live in the built-in recipes). */
const SERVICE: PackageManifest["service"] = {"kind": "monitoring", "headline": [{"label": "Machines up", "endpointId": "machines-up", "value": "items | filter(\"state\", \"up\") | count", "format": "number"}, {"label": "Down", "endpointId": "machines-up", "value": "items | filter(\"state\", \"down\") | count", "format": "number"}, {"label": "Alerts", "endpointId": "alerts-count", "value": "value", "format": "number"}]};

export const prometheusManifest: PackageManifest = { ...json, service: SERVICE, endpoints: [...builtinEndpoints, ...json.endpoints.map((e) => ({ ...e, ...(SPECIAL[e.id] ?? {}) })), ...historyEndpoints] };
export default prometheusManifest;
