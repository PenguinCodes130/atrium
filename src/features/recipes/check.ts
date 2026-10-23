// A9.2 live check: runs reads once against the integration's own server, read-only (the reads' own
// GET or Prometheus query requests and nothing else), at most 4 at a time and 5 s each. A read that
// needs "which thing" is tried with the first choice from its list. Results are stored server side
// and only ever shown to editors.
import "server-only";
import type { ReadCheck, ReadResult } from "@/core/contracts";
import { logger } from "@/core/log";
import { choicesFrom, choicesSpecs, type ChoicesSpec } from "@/features/integrations/choices";
import { getIntegrationRow } from "@/features/integrations/repo";
import { endpointsOf, integrationLocked, readEndpoint, type ListedEndpoint } from "@/features/integrations/runtime";
import { BUILTIN_READ_RECIPE } from "@/packages/prometheus/full-manifest";
import { classify } from "./classify";
import * as repo from "./repo";
import { parseRecipeEndpointId } from "./schema";

export const CHECK_CONCURRENCY = 4;
export const CHECK_TIMEOUT_MS = 5000;

export type CheckProgress = { running: boolean; total: number; done: number; startedAt?: string; finishedAt?: string };

const g = globalThis as unknown as { __atriumCheckProgress?: Map<string, CheckProgress>; __atriumCheckQueue?: Map<string, Promise<unknown>> };
const progress = (g.__atriumCheckProgress ??= new Map());
const queue = (g.__atriumCheckQueue ??= new Map());
const log = logger("recipes.check");

export function checkProgress(integrationId: string): CheckProgress {
  return progress.get(integrationId) ?? { running: false, total: 0, done: 0 };
}

type Prop = { default?: unknown; enum?: unknown[]; type?: string; title?: string; minimum?: number };
type Run = (endpointId: string, params: Record<string, unknown>) => Promise<ReadResult>;

/** The reads a check covers by default: built-in recipe reads and every recipe read (drafts too). */
export function recipeReadIds(eps: ListedEndpoint[], packageId: string): string[] {
  return eps.filter((e) => parseRecipeEndpointId(e.id) || (packageId === "prometheus" && BUILTIN_READ_RECIPE.has(e.id))).map((e) => e.id);
}

/**
 * The settings to try a read with: the first live choice for "which thing" params (dependent lists
 * after the setting they depend on), else the default, else the first enum value. Returns a note
 * when a required setting cannot be filled, so the read is reported as not checked.
 */
export async function paramsToTry(ep: Pick<ListedEndpoint, "params">, run: Run): Promise<{ params: Record<string, unknown>; note?: string }> {
  const props = ((ep.params as { properties?: Record<string, Prop> } | undefined)?.properties ?? {}) as Record<string, Prop>;
  const required = new Set(((ep.params as { required?: string[] } | undefined)?.required ?? []) as string[]);
  const specs = choicesSpecs(ep.params);
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) {
    if (specs[k]) continue;
    if (p.default !== undefined) out[k] = p.default;
    else if (Array.isArray(p.enum) && p.enum.length) out[k] = p.enum[0];
    else if (required.has(k)) return { params: out, note: `Not checked: needs ${(p.title ?? k).toLowerCase()} typed in` };
  }
  const pending = new Map<string, ChoicesSpec>(Object.entries(specs));
  for (let pass = 0; pending.size && pass < 6; pass++) {
    for (const [k, spec] of [...pending]) {
      const deps = Object.entries(spec.params ?? {});
      if (deps.some(([, from]) => pending.has(from))) continue;
      pending.delete(k);
      const params = Object.fromEntries(deps.map(([target, from]) => [target, out[from]]).filter(([, v]) => typeof v === "string" && v));
      const r = await run(spec.endpointId, params);
      const first = r.ok ? choicesFrom(r.data, spec).choices[0] : undefined;
      if (first) out[k] = first.value;
      else if (props[k]?.default !== undefined) out[k] = props[k]!.default;
      else if (required.has(k)) return { params: out, note: r.ok ? `Not checked: this server has no ${(props[k]?.title ?? k).toLowerCase()} to pick` : `Not checked: the ${(props[k]?.title ?? k).toLowerCase()} list failed (${r.error.message.slice(0, 120)})` };
    }
  }
  return { params: out };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

async function runCheck(integrationId: string, endpointIds?: string[]): Promise<Record<string, ReadCheck>> {
  const row = getIntegrationRow(integrationId);
  if (!row || row.status !== "active" || integrationLocked(row)) return {};
  const eps = endpointsOf(row, { includeDrafts: true });
  const byId = new Map(eps.map((e) => [e.id, e]));
  const ids = (endpointIds ?? recipeReadIds(eps, row.packageId)).filter((id) => byId.has(id));
  const state: CheckProgress = { running: true, total: ids.length, done: 0, startedAt: new Date().toISOString() };
  progress.set(integrationId, state);
  const memo = new Map<string, Promise<ReadResult>>();
  const run: Run = (endpointId, params) => {
    const key = `${endpointId}\u0000${JSON.stringify(params)}`;
    let p = memo.get(key);
    if (!p) {
      p = readEndpoint(integrationId, endpointId, params, AbortSignal.timeout(CHECK_TIMEOUT_MS), { includeDrafts: true });
      memo.set(key, p);
    }
    return p;
  };
  const out: Record<string, ReadCheck> = {};
  try {
    await pool(ids, CHECK_CONCURRENCY, async (id) => {
      const at = new Date().toISOString();
      let c: ReadCheck;
      try {
        const { params, note } = await paramsToTry(byId.get(id)!, run);
        c = note ? { status: "empty", reason: note, at } : classify(await run(id, params), at);
      } catch (e) {
        c = { status: "failed", reason: (e as Error).message.slice(0, 200) || "The check failed.", at };
      }
      out[id] = c;
      try { repo.saveCheck(integrationId, id, c); } catch (e) { log.warn("check not stored", { error: (e as Error).message }); }
      state.done++;
    });
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
  return out;
}

/**
 * A9.2: checks reads of one integration (by default every recipe read it has, drafts included) and
 * stores each result. Runs for the same integration wait for each other. Returns the results by
 * endpoint id; a disabled, draft or locked integration is not checked (empty result).
 */
export function checkReads(integrationId: string, endpointIds?: string[]): Promise<Record<string, ReadCheck>> {
  const prev = queue.get(integrationId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => runCheck(integrationId, endpointIds));
  queue.set(integrationId, next);
  void next.finally(() => { if (queue.get(integrationId) === next) queue.delete(integrationId); }).catch(() => undefined);
  return next;
}

/**
 * Reads that used to work and now fail (A9.2, spec 3.2): for the builder's and the publish review's
 * warnings on widgets bound to them. Editors only (the caller checks).
 */
export function failingReads(integrationId: string): Record<string, { reason: string; at: string }> {
  const out: Record<string, { reason: string; at: string }> = {};
  for (const c of repo.listChecks(integrationId)) {
    if (c.status === "failed" && c.previous && c.previous !== "failed") out[c.endpointId] = { reason: c.reason ?? "This read stopped working.", at: c.at.toISOString() };
  }
  return out;
}
