// Amendment 10 (A10.4): the data catalogue and peek, for the builder's "What should this show?"
// picker and the data.search and data.peek agent tools.
//
// GET /api/data/catalogue?q=&fits=<ComponentType>&integrationId=&measure=&all=1&limit=
//   Every read of every integration the caller may bind (A6.1 sharing rule), one item per thing: the
//   endpoint's first A8.2 choices param is expanded from its choices read (one read per choices
//   endpoint per integration, through the 30 s choices cache), plus "Every ..." when the descriptor
//   allows it. Things that do not arrive within the 3 s budget leave that integration's reads listed
//   without things, and its id in `pending`. Ranked: fitting items first, advanced last, then text
//   match (every word of q must match the label, thing, service, group or measure), headline before
//   others. Reads whose live check failed, or that the service does not have, are left out unless all=1.
// POST /api/data/peek { items: [{ integrationId, endpointId, params }] } (at most 20)
//   Each read's value through the shared endpoint cache within 3 s: { values: [{ key, data?, error? }] }.
//
// Readers: owners and members within the sharing rule, agents with atrium:edit. Everyone else gets
// the same 404, so nothing can be probed. Nothing here carries config or secrets.
import "server-only";
import type { CatalogueItem, CatalogueResponse, CatalogueService, ComponentType, DataShapeKind, Measure, PeekResponse, Principal, PropValue, ReadCheck, ShapedData } from "@/core/contracts";
import { META, type ComponentMeta } from "@/features/components/catalogue/meta";
import { availabilityOf } from "@/features/integrations/availability";
import { choicesFrom, choicesSpecs, type Choice } from "@/features/integrations/choices";
import { canBindReads } from "@/features/integrations/commands";
import { listIntegrationRows, getIntegrationRow, SYSTEM_INTEGRATION_ID, type IntegrationRow } from "@/features/integrations/repo";
import { endpointsOf, getPackage, integrationLocked, getRegistry, type ListedEndpoint } from "@/features/integrations/runtime";
import { canEdit } from "@/features/integrations/service";
import { serviceInfoOf, serviceRows } from "@/features/integrations/service-info";
import { checksMap } from "@/features/recipes/repo";
import { builtinFrom, fromTag } from "@/features/recipes/store";
import { catalogueKey, canonicalParams } from "./catalogue-key";
import { rowsFor } from "./choices";
import { MEASURE_WORDS, measureOf } from "./measure";
import { dataRuntime, readThrough } from "./runtime";
import { cacheKey } from "./keys";

export const CATALOGUE_BUDGET_MS = 3000;
export const PEEK_BUDGET_MS = 3000;
export const MAX_THINGS = 200;

export type CatalogueQuery = { q?: string; fits?: string; integrationId?: string; measure?: Measure; all?: boolean; limit?: number };

/** Who may search the catalogue: editors (members and owners, agents with atrium:edit). */
export function mayUseCatalogue(p: Principal | null): p is Exclude<Principal, { kind: "guest" }> {
  return !!p && canEdit(p);
}

/** Whether a component type takes this read: by its `accepts`, or (a chart) by the read's history. Unknown types take nothing. */
export function fitsType(type: string | undefined, item: Pick<CatalogueItem, "shape" | "history">): boolean {
  if (!type) return false;
  const meta = (META as Record<string, ComponentMeta | undefined>)[type as ComponentType];
  if (!meta?.accepts) return false;
  if (meta.accepts.includes(item.shape)) return true;
  return type === "chart" && !!item.history;
}

const words = (q: string | undefined) => (q ?? "").toLowerCase().split(/[\s,]+/).map((w) => w.trim()).filter(Boolean).slice(0, 12);

/** How well an item matches: null when a word is missing; higher when words hit the label and thing. */
export function matchScore(item: Pick<CatalogueItem, "label" | "thing" | "integrationName" | "group" | "measure" | "from">, ws: string[], extra = ""): number | null {
  if (!ws.length) return 0;
  const label = item.label.toLowerCase();
  const thing = `${item.thing?.label ?? ""} ${item.thing?.detail ?? ""}`.toLowerCase();
  const rest = `${item.integrationName} ${item.group ?? ""} ${item.measure} ${MEASURE_WORDS[item.measure]} ${extra}`.toLowerCase();
  let score = 0;
  for (const w of ws) {
    const inLabel = label.includes(w), inThing = thing.includes(w), inRest = rest.includes(w);
    if (!inLabel && !inThing && !inRest) return null;
    score += (inLabel ? (new RegExp(`(^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label) ? 4 : 3) : 0) + (inThing ? 2 : 0) + (inRest ? 1 : 0);
  }
  return score;
}

type Ranked = { item: CatalogueItem; fits: boolean; score: number; advanced: boolean; order: number };

/** The A10.4 order: fitting first, advanced last, then text match, headline, then listing order. */
export function rank(list: Ranked[]): Ranked[] {
  return [...list].sort((a, b) =>
    Number(b.fits) - Number(a.fits) ||
    Number(a.advanced) - Number(b.advanced) ||
    b.score - a.score ||
    Number(!!b.item.headline) - Number(!!a.item.headline) ||
    a.order - b.order);
}

/** "Every machine" from a param titled "Machine". */
export function everyLabel(title: string | undefined, param: string): string {
  const noun = (title ?? param).trim().toLowerCase().replace(/^(a|an|the)\s+/, "") || "one";
  return `Every ${noun}`;
}

type Props = Record<string, { title?: string; default?: unknown; enum?: unknown[]; "x-atrium-choices"?: unknown }>;
const propsOf = (schema: unknown): Props => (((schema as { properties?: Props } | undefined)?.properties ?? {}) as Props);
const requiredOf = (schema: unknown): string[] => (((schema as { required?: string[] } | undefined)?.required ?? []) as string[]);

/** Required settings other than `except` that have neither a default nor live choices. */
function needsOther(schema: unknown, except?: string): boolean {
  const props = propsOf(schema);
  return requiredOf(schema).some((k) => k !== except && props[k]?.default === undefined && !(props[k]?.["x-atrium-choices"]));
}

/** The first choices param of an endpoint that does not depend on another setting. */
function firstChoices(ep: ListedEndpoint) {
  const specs = Object.entries(choicesSpecs(ep.params));
  const first = specs[0];
  if (!first) return undefined;
  const [param, spec] = first;
  return { param, spec, title: propsOf(ep.params)[param]?.title, dependent: !!spec.params };
}

/** A10.6: the services one person may pick for `atrium/health`, as choices. */
function bindableIntegrationChoices(p: Principal): Choice[] {
  return listIntegrationRows()
    .filter((r) => r.id !== SYSTEM_INTEGRATION_ID && r.status === "active" && canBindReads(p, r))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }))
    .map((r) => ({ value: r.id, label: r.name, detail: getPackage(r.packageId)?.manifest.name ?? r.packageId }));
}

/** The rows the catalogue lists for one person: active integrations they may bind. */
function bindableRows(p: Principal, integrationId?: string): IntegrationRow[] {
  return listIntegrationRows()
    .filter((r) => r.status === "active" && canBindReads(p, r) && (!integrationId || r.id === integrationId))
    .sort((a, b) => (a.id === SYSTEM_INTEGRATION_ID ? 1 : b.id === SYSTEM_INTEGRATION_ID ? -1 : a.createdAt.getTime() - b.createdAt.getTime()));
}

type Built = { items: { item: CatalogueItem; advanced: boolean }[]; late: boolean; service: CatalogueService };

async function buildFor(p: Principal, row: IntegrationRow, deadline: number, all: boolean, stored: ReturnType<typeof serviceRows>): Promise<Built> {
  const pkg = getPackage(row.packageId);
  const info = serviceInfoOf(row, pkg?.manifest, stored.get(row.id));
  const service: CatalogueService = {
    integrationId: row.id, name: row.name, packageId: row.packageId, icon: row.packageId, kind: info.kind,
    ...(info.openUrl ? { openUrl: info.openUrl } : {}), headline: info.headline,
    ...(row.lastHealth ? { health: row.lastHealth.status } : {}),
  };
  const locked = integrationLocked(row);
  const eps = endpointsOf(row);
  const left = () => Math.max(0, deadline - Date.now());
  const availP = locked || all ? Promise.resolve({ known: false, value: {} as Record<string, boolean> }) : availabilityOf(row.id, row.updatedAt.toISOString(), left());
  const checks = checksMap(row.id) as Map<string, ReadCheck>;
  // Things: one choices read per choices endpoint, all at once, within what is left of the budget.
  const choiceEndpoints = new Set<string>();
  for (const ep of eps) { const f = firstChoices(ep); if (f && !f.dependent) choiceEndpoints.add(f.spec.endpointId); }
  const things = new Map<string, { data?: ShapedData; list?: Choice[] } | null>();
  let late = false;
  await Promise.all([...choiceEndpoints].map(async (endpointId) => {
    if (row.id === SYSTEM_INTEGRATION_ID && endpointId === "integrations") { things.set(endpointId, { list: bindableIntegrationChoices(p) }); return; }
    if (locked) { things.set(endpointId, null); return; }
    const r = await rowsFor({ integrationId: row.id, endpointId }, left());
    // A read that did not answer in time (still running, or timed out) leaves this service pending.
    // (An aborted read can fail with another code, so a failure that took the whole budget counts too.)
    if ((r.late && !r.data) || (r.data && !r.data.ok && (r.data.error.code === "timeout" || left() <= 100))) late = true;
    things.set(endpointId, r.data?.ok ? { data: r.data.data } : null);
  }));
  const avail = await availP;
  const headlineIds = new Set(info.headlineFrom === "integration" ? info.headline.map((h) => h.endpointId) : []);
  const items: Built["items"] = [];
  for (const ep of eps) {
    if (ep.id.startsWith("h:")) continue; // history reads are offered through their value read
    const check = checks.get(ep.id);
    if (!all && (check?.status === "failed" || avail.value[ep.id] === false)) continue;
    const from = ep.recipe ? fromTag(ep.recipe.name, ep.recipe.source) : builtinFrom(row.packageId, ep.id).from;
    const base = {
      integrationId: row.id, integrationName: row.name, packageId: row.packageId, serviceIcon: row.packageId,
      endpointId: ep.id, label: ep.label, ...(ep.group ? { group: ep.group } : {}),
      ...(ep.headline || headlineIds.has(ep.id) ? { headline: true } : {}),
      ...(check ? { check: { status: check.status, at: check.at, ...(check.reason ? { reason: check.reason } : {}) } } : {}),
      ...(from ? { from } : {}),
      defaultRefreshSec: ep.defaultRefreshSec, minRefreshSec: ep.minRefreshSec,
    };
    const history = (params: Record<string, PropValue>) => (ep.history ? { history: { endpointId: ep.history.endpointId, params: { ...params, ...(ep.history.params ?? {}) } } } : {});
    const own = measureOf({ measure: ep.measure, label: ep.label, group: ep.group, shape: ep.shape });
    const push = (params: Record<string, PropValue>, extra: Partial<CatalogueItem>, shape: DataShapeKind = ep.shape) => {
      const thingMeasure = own === "other" && extra.thing ? measureOf({ label: extra.thing.label }) : own;
      const clean = canonicalParams(params, ep.params);
      items.push({ advanced: !!ep.advanced, item: { ...base, key: catalogueKey(row.id, ep.id, params, ep.params), params: clean, shape, measure: thingMeasure, ...history(clean), ...extra } as CatalogueItem });
    };
    const f = firstChoices(ep);
    if (!f) { push({}, needsOther(ep.params) ? { needsSettings: true } : {}); continue; }
    const got = f.dependent ? null : (things.get(f.spec.endpointId) ?? null);
    const list = !got ? null : got.list ?? choicesFrom(got.data, f.spec).choices;
    const other = needsOther(ep.params, f.param);
    if (!list) { push({}, { needsSettings: true }); continue; }
    for (const c of list.slice(0, MAX_THINGS)) push({ [f.param]: c.value }, { thing: { param: f.param, value: c.value, label: c.label, ...(c.detail ? { detail: c.detail } : {}) }, ...(other ? { needsSettings: true } : {}) });
    // A8.2 "every": one row per thing, so a value read answers a table (its history, one line per thing).
    if (f.spec.every) push({ [f.param]: "*" }, { thing: { param: f.param, value: "*", label: everyLabel(f.title, f.param) }, ...(other ? { needsSettings: true } : {}) }, ep.shape === "stat" ? "table" : ep.shape);
  }
  return { items, late, service };
}

/** The catalogue for one person (callers check mayUseCatalogue first). */
export async function buildCatalogue(p: Principal, q: CatalogueQuery, opts: { budgetMs?: number } = {}): Promise<CatalogueResponse> {
  getRegistry(); // creates the built-in Atrium integration on first use
  const deadline = Date.now() + (opts.budgetMs ?? CATALOGUE_BUDGET_MS);
  const rows = bindableRows(p, q.integrationId);
  const stored = serviceRows();
  const built = await Promise.all(rows.map((r) => buildFor(p, r, deadline, !!q.all, stored)));
  const ws = words(q.q);
  const ranked: Ranked[] = [];
  let order = 0;
  for (const b of built) {
    for (const { item, advanced } of b.items) {
      order++;
      if (q.measure && item.measure !== q.measure) continue;
      const pkgName = getPackage(item.packageId)?.manifest.name ?? "";
      const score = matchScore(item, ws, `${pkgName} ${item.from ?? ""}`);
      if (score === null) continue;
      ranked.push({ item, fits: fitsType(q.fits, item), score, advanced, order });
    }
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const top = rank(ranked).slice(0, limit);
  return {
    items: top.map((r) => r.item),
    fits: top.map((r) => r.fits),
    services: built.map((b) => b.service),
    pending: built.flatMap((b, i) => (b.late ? [rows[i]!.id] : [])),
  };
}

/** A10.4 peek: each read's current value through the shared cache within 3 s. Refused items say "not found". */
export async function peek(p: Principal, items: { integrationId: string; endpointId: string; params: Record<string, unknown> }[], opts: { budgetMs?: number } = {}): Promise<PeekResponse> {
  getRegistry();
  const budget = opts.budgetMs ?? PEEK_BUDGET_MS;
  const values = await Promise.all(items.slice(0, 20).map(async (it): Promise<PeekResponse["values"][number]> => {
    const row = getIntegrationRow(it.integrationId);
    const ep = row && row.status === "active" && canBindReads(p, row) ? endpointsOf(row).find((e) => e.id === it.endpointId) : undefined;
    const key = catalogueKey(it.integrationId, it.endpointId, it.params, ep?.params);
    if (!row || !ep) return { key, error: "That read does not exist." };
    const params = canonicalParams(it.params, ep.params);
    // A10.6: a person may only see the health of services they may bind.
    if (row.id === SYSTEM_INTEGRATION_ID && ep.id === "health") {
      const target = typeof params.integrationId === "string" ? getIntegrationRow(params.integrationId) : undefined;
      if (!target || !canBindReads(p, target)) return { key, error: "That service does not exist." };
    }
    const src = { integrationId: row.id, endpointId: ep.id, ...(Object.keys(params).length ? { params } : {}) };
    const read = readThrough(src, ep.defaultRefreshSec);
    const timeout = new Promise<null>((r) => { const t = setTimeout(() => r(null), budget); t.unref?.(); });
    const d = await Promise.race([read.catch(() => null), timeout]);
    if (!d) {
      const last = dataRuntime().cache.get(cacheKey(src))?.lastGood?.data as ShapedData | undefined;
      return last ? { key, data: last } : { key, error: "No answer within 3 seconds." };
    }
    if (d.data) return { key, data: d.data as ShapedData };
    return { key, error: d.error?.message ?? "No answer." };
  }));
  return { values };
}
