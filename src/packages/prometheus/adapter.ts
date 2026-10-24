// Prometheus HTTP API v1 adapter. Read-only, GET only (queries use GET with URL parameters).
// Optional login: Basic auth (username in config, password sealed) or a bearer token (sealed).
// Ready-made reads are recipes (recipes.json, run by recipe.ts); the rest are in specials.ts.
import type { AdapterContext } from "@/core/contracts";
import { defineAdapter, obj, str, type ReadFn } from "../lib";
import { api, metricNames } from "./api";
import { HISTORY_READS, RECIPES } from "./full-manifest";
import { runHistory, runRecipe } from "./recipe";
import { SPECIAL_NEEDS, SPECIAL_READS } from "./specials";

export { QUERY_ERROR } from "./api";

const recipeReads: Record<string, ReadFn> = Object.fromEntries(RECIPES.map((r) => [r.id, (ctx: AdapterContext, params: Record<string, unknown>) => runRecipe(r, ctx, params)]));
// A10.3: h:<id> runs a built-in instant read's query over time.
const historyReads: Record<string, ReadFn> = Object.fromEntries([...HISTORY_READS].map(([id, r]) => [id, (ctx: AdapterContext, params: Record<string, unknown>) => runHistory(r, ctx, params)]));

const adapter = defineAdapter({
  async health(ctx) {
    const data = obj(await api(ctx, "api/v1/status/buildinfo"), "build info");
    return { status: "ok", version: str(data.version) || undefined };
  },
  reads: { ...SPECIAL_READS, ...recipeReads, ...historyReads },
});

type NeedsProvider = () => Record<string, string[]>;
const hook = globalThis as unknown as { __atriumPromExtraNeeds?: NeedsProvider };

/**
 * A9.1: imported recipes that apply when given metrics exist register their reads' needs here
 * (endpoint id to metric names), so one metric-name request answers for them too.
 */
export function registerExtraNeeds(fn: NeedsProvider): void {
  hook.__atriumPromExtraNeeds = fn;
}

/**
 * A8.1: which reads have data on this server, from one request for the metric names. A read is
 * available when any metric it needs exists; reads with no needs are always available.
 */
export async function available(ctx: AdapterContext): Promise<Record<string, boolean>> {
  const names = new Set(await metricNames(ctx));
  const out: Record<string, boolean> = {};
  for (const r of RECIPES) if (r.needs) { out[r.id] = r.needs.anyMetric.some((m) => names.has(m)); if (HISTORY_READS.has(`h:${r.id}`)) out[`h:${r.id}`] = out[r.id]!; }
  for (const [id, needs] of Object.entries(SPECIAL_NEEDS)) out[id] = needs.some((m) => names.has(m));
  for (const [id, needs] of Object.entries(hook.__atriumPromExtraNeeds?.() ?? {})) if (needs.length) out[id] = needs.some((m) => names.has(m));
  return out;
}

export default { ...adapter, available };
