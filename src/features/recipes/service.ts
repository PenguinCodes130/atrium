// Recipes for people and agents (spec 3.1 to 3.4, A9.1): who may list, import, turn on, export and
// delete them, the import paths (file, https link, Grafana id or JSON), and the Recipes view of one
// integration. Viewers and guests get not found from all of it; agents may list, and with
// atrium:edit may import drafts, but never turn a recipe on.
import "server-only";
import type { Principal, ReadCheck } from "@/core/contracts";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { logger } from "@/core/log";
import { safeRequest } from "@/features/integrations/host/request";
import { HostError } from "@/features/integrations/host/errors";
import { canBindReads } from "@/features/integrations/commands";
import { getIntegrationRow, listIntegrationRows } from "@/features/integrations/repo";
import { endpointsOf } from "@/features/integrations/runtime";
import { canEdit, isOwnerOrCreator } from "@/features/integrations/service";
import { checkProgress, checkReads, recipeReadIds, type CheckProgress } from "./check";
import { mapDashboard, type Skipped } from "./grafana";
import * as repo from "./repo";
import { exportFileName, exportText, parseRecipeText, recipeEndpointId, validateRecipe, type RecipeFile } from "./schema";
import { appliesTo, catalog, forgetCatalog, fromTag, getEntry, recipesFor, type CatalogEntry } from "./store";

const log = logger("recipes");
export const GRAFANA_MAX_BYTES = 10 * 1024 * 1024;
export const STALE_MS = 24 * 60 * 60_000;
const NOT_FOUND = "Those recipes do not exist.";

/** A recipe file or field that is not valid, named for the person (spec 4 Error). */
export class InvalidRecipe extends AtriumError {
  constructor(readonly field: string, problem: string) {
    super(`${field} ${problem}.`.replace(/\.\.$/, "."), 400, "invalid_recipe");
  }
}

/** Importing an id that is already here: replace it (a newer version) or keep both (spec 3.1). */
export class RecipeExists extends AtriumError {
  constructor(readonly existing: { id: string; name: string; version: string }, readonly incoming: { name: string; version: string }) {
    super(`A recipe "${existing.name}" (version ${existing.version}) is already here.`, 409, "recipe_exists");
  }
}

// ---- Permissions ----
type Account = Exclude<Principal, { kind: "guest" }>;
/** Owners, members and agents may list recipes; viewers and guests may not (spec 4). */
function mayList(p: Principal): p is Account {
  return p.kind !== "guest" && p.role !== "viewer";
}
function requireList(p: Principal): asserts p is Account {
  if (!mayList(p)) throw new NotFound(NOT_FOUND);
}
/** Importing and exporting: owners, members, and agents with atrium:edit. */
function requireEdit(p: Principal): asserts p is Account {
  requireList(p);
  if (!canEdit(p)) throw new Forbidden("Importing and exporting recipes needs edit access.");
}
/** Turning recipes on or off and deleting them: a signed-in owner or member, never an agent. */
function requirePerson(p: Principal): asserts p is Extract<Principal, { kind: "user" }> {
  requireEdit(p);
  if (p.kind !== "user") throw new Forbidden("Only a signed-in person can turn a recipe on or off.");
}

function visibleIntegration(p: Account, integrationId: string) {
  const row = getIntegrationRow(integrationId);
  if (!row || !(canBindReads(p, row) || isOwnerOrCreator(p, row))) throw new NotFound(NOT_FOUND);
  return row;
}

// ---- Saving ----
export type SaveOptions = {
  status: "draft" | "active";
  /** A spec recipe made from this Custom API integration applies to it (A9.3). */
  integrationId?: string;
  /** Grafana panels that could not become reads. */
  skipped?: Skipped[];
  /** When the id is already here: replace it or keep both. Spec recipes replace by default. */
  onConflict?: "replace" | "keep-both";
};

function freeId(id: string): string {
  const taken = new Set(catalog().map((e) => e.id));
  for (let i = 2; i < 1000; i++) {
    const base = id.slice(0, 60);
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new AtriumError("Too many copies of this recipe.");
}

/**
 * Validates and stores a recipe (A9.1). Agents always store a draft. Built-in recipes cannot be
 * replaced; importing one keeps both. Returns the stored id (which differs when both are kept).
 */
export async function saveRecipe(principal: Principal, recipe: unknown, opts: SaveOptions): Promise<{ id: string }> {
  requireEdit(principal);
  const v = validateRecipe(recipe);
  if (!v.ok) throw new InvalidRecipe(v.problem.field, v.problem.message);
  let r: RecipeFile = v.recipe.source === "builtin" ? { ...v.recipe, source: "file" } : v.recipe;
  const status = principal.kind === "user" ? opts.status : "draft";
  const existing = getEntry(r.id);
  const onConflict = opts.onConflict ?? (r.source === "spec" ? "replace" : undefined);
  if (existing) {
    if (!onConflict) throw new RecipeExists({ id: existing.id, name: existing.recipe?.name ?? existing.id, version: existing.recipe?.version ?? "?" }, { name: r.name, version: r.version });
    if (onConflict === "keep-both" || existing.builtin) r = { ...r, id: freeId(r.id) };
  }
  const now = new Date();
  repo.upsertRecipeRow({
    id: r.id, record: r as unknown as Record<string, unknown>, source: r.source, status, problem: null, skipped: opts.skipped ?? [],
    originIntegrationId: opts.integrationId ?? null, createdById: principal.userId, importedAt: now, updatedAt: now,
  });
  forgetCatalog();
  log.info("recipe saved", { id: r.id, source: r.source, status, reads: r.reads.length });
  return { id: r.id };
}

// ---- Imports ----
async function fetchText(url: string, maxBytes: number, what: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InvalidRecipe("The link", "is not a valid address");
  }
  if (u.protocol !== "https:") throw new InvalidRecipe("The link", "must start with https://");
  try {
    const res = await safeRequest({ url: u.toString(), redirect: { mode: "checked" }, maxBytes, timeoutMs: 15_000, headers: { accept: "application/json" } });
    if (res.status === 404) throw new AtriumError(`${what} was not found (HTTP 404).`, 400, "not_found_remote");
    if (res.status >= 400) throw new AtriumError(`${what} could not be downloaded (HTTP ${res.status}).`, 400, "unreachable");
    return res.body.toString("utf8");
  } catch (e) {
    if (e instanceof AtriumError) throw e;
    if (e instanceof HostError) {
      const m = e.adapterError.message;
      throw new AtriumError(/larger|too large|bytes/i.test(m) ? `${what} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.` : `${what} could not be reached: ${m}`, 400, "unreachable");
    }
    throw new AtriumError(`${what} could not be reached.`, 400, "unreachable");
  }
}

export type ImportResult = { id: string; name: string; reads: number; status: "draft" | "active"; skipped: Skipped[]; checking: boolean };

/** Starts the live check of a recipe's reads on one integration (A9.2), without waiting for it. */
function startCheck(integrationId: string | undefined, recipeId: string): boolean {
  if (!integrationId) return false;
  const row = getIntegrationRow(integrationId);
  const entry = getEntry(recipeId);
  if (!row || !entry || !appliesTo(entry, row)) return false;
  const ids = entry.recipe!.reads.map((r) => (entry.builtin ? r.id : recipeEndpointId(entry.id, r.id)));
  void checkReads(integrationId, ids).catch((e) => log.warn("live check failed", { error: (e as Error).message }));
  return true;
}

/** Import a recipe file's text or an https link (2 MB) as a draft (spec 3.1). */
export async function importRecipe(p: Principal, input: { text?: string; url?: string; integrationId?: string; onConflict?: "replace" | "keep-both" }): Promise<ImportResult> {
  requireEdit(p);
  if (input.integrationId) visibleIntegration(p, input.integrationId);
  const fromUrl = !input.text && !!input.url;
  const text = input.text ?? (input.url ? await fetchText(input.url, 2 * 1024 * 1024, "The recipe at that link") : undefined);
  if (text === undefined) throw new AtriumError("Choose a recipe file or paste a link.", 400, "bad_request");
  const parsed = parseRecipeText(text);
  if (!parsed.ok) throw new InvalidRecipe(parsed.problem.field === "the file" ? "The file" : parsed.problem.field, parsed.problem.message);
  const r = parsed.recipe;
  const source = r.source === "grafana" || r.source === "spec" ? r.source : fromUrl ? "url" : "file";
  const saved = await saveRecipe(p, { ...r, source }, { status: "draft", ...(input.onConflict ? { onConflict: input.onConflict } : {}) });
  return { id: saved.id, name: r.name, reads: r.reads.length, status: "draft", skipped: [], checking: startCheck(input.integrationId, saved.id) };
}

/** Import a Grafana dashboard by grafana.com id or JSON onto a Prometheus integration (spec 3.4). */
export async function importGrafana(p: Principal, input: { integrationId: string; dashboardId?: string; json?: string; onConflict?: "replace" | "keep-both" }): Promise<ImportResult> {
  requireEdit(p);
  const row = visibleIntegration(p, input.integrationId);
  if (row.packageId !== "prometheus") throw new AtriumError("Grafana dashboards import onto a Prometheus integration.", 400, "bad_request");
  let text = input.json;
  if (!text) {
    const id = (input.dashboardId ?? "").trim().replace(/^https:\/\/grafana\.com\/grafana\/dashboards\/(\d+).*$/, "$1");
    if (!/^\d{1,9}$/.test(id)) throw new InvalidRecipe("The dashboard id", "must be the number from grafana.com, such as 1860");
    text = await fetchText(`https://grafana.com/api/dashboards/${id}/revisions/latest/download`, GRAFANA_MAX_BYTES, `Grafana dashboard ${id}`);
  }
  if (Buffer.byteLength(text, "utf8") > GRAFANA_MAX_BYTES) throw new InvalidRecipe("The dashboard file", "is larger than 10 MB");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new InvalidRecipe("The dashboard file", "is not valid JSON"); }
  let mapped;
  try { mapped = mapDashboard(raw); } catch (e) { throw new InvalidRecipe("The dashboard", (e as Error).message.replace(/\.$/, "").replace(/^This /, "is not usable: this ")); }
  const saved = await saveRecipe(p, mapped.recipe, { status: "draft", skipped: mapped.skipped, ...(input.onConflict ? { onConflict: input.onConflict } : {}) });
  return { id: saved.id, name: mapped.recipe.name, reads: mapped.recipe.reads.length, status: "draft", skipped: mapped.skipped, checking: startCheck(input.integrationId, saved.id) };
}

// ---- On and off, export, delete ----
/** Turns a recipe on or off (people only). Turning on checks its reads on the integrations it applies to. */
export function setStatus(p: Principal, id: string, status: "draft" | "active", integrationId?: string): void {
  requirePerson(p);
  const e = getEntry(id);
  if (!e) throw new NotFound(NOT_FOUND);
  if (!e.recipe) throw new AtriumError(`This recipe cannot be turned on: ${e.problem ?? "it is not valid"}.`, 409, "invalid_recipe");
  const now = new Date();
  if (e.builtin) repo.upsertRecipeRow({ id, record: null, source: "builtin", status, problem: null, skipped: [], originIntegrationId: null, createdById: p.userId, importedAt: now, updatedAt: now });
  else repo.setRecipeStatus(id, status);
  forgetCatalog();
  if (status === "active") {
    const targets = integrationId ? [integrationId] : listIntegrationRows().filter((r) => r.status === "active" && appliesTo(e, r)).map((r) => r.id);
    for (const t of targets) startCheck(t, id);
  }
}

export function exportRecipe(p: Principal, id: string): { fileName: string; text: string } {
  requireEdit(p);
  const e = getEntry(id);
  if (!e) throw new NotFound(NOT_FOUND);
  if (!e.recipe) throw new AtriumError(`This recipe cannot be exported: ${e.problem ?? "it is not valid"}.`, 409, "invalid_recipe");
  return { fileName: exportFileName(e.id), text: exportText(e.recipe) };
}

export function deleteRecipe(p: Principal, id: string): void {
  requirePerson(p);
  const e = getEntry(id);
  if (!e) throw new NotFound(NOT_FOUND);
  if (e.builtin) throw new AtriumError("Built-in recipes cannot be deleted. Turn them off instead.", 400, "builtin");
  repo.deleteRecipeRow(id);
  forgetCatalog();
}

// ---- The Recipes section of one integration ----
export type RecipeReadView = { endpointId: string; label: string; group?: string; check?: ReadCheck };
export type RecipeView = {
  id: string; name: string; version: string; author: string; description: string; source: CatalogEntry["source"]; tag: string;
  status: "draft" | "active"; builtin: boolean; problem?: string; reads: number; checked: number; works: number; lastCheckedAt?: string; stale: boolean;
  skipped: Skipped[]; readList: RecipeReadView[];
};
export type RecipesView = { integrationId: string; packageId: string; recipes: RecipeView[]; progress: CheckProgress; migrated: boolean; canChange: boolean; canImport: boolean; grafana: boolean };

export function recipesView(p: Principal, integrationId: string, now = Date.now()): RecipesView {
  requireList(p);
  const row = visibleIntegration(p, integrationId);
  const checks = repo.checksMap(row.id);
  const recipes: RecipeView[] = recipesFor(row).map((e) => {
    const reads = e.recipe?.reads ?? [];
    const readList = reads.map((r) => {
      const endpointId = e.builtin ? r.id : recipeEndpointId(e.id, r.id);
      const c = checks.get(endpointId);
      return { endpointId, label: r.label, ...(r.group ? { group: r.group } : {}), ...(c ? { check: { status: c.status, at: c.at, ...(c.reason ? { reason: c.reason } : {}) } } : {}) };
    });
    const checked = readList.filter((r) => r.check);
    const last = checked.map((r) => Date.parse(r.check!.at)).sort((a, b) => b - a)[0];
    return {
      id: e.id, name: e.recipe?.name ?? e.id, version: e.recipe?.version ?? "", author: e.recipe?.author ?? "", description: e.recipe?.description ?? "",
      source: e.source, tag: fromTag(e.recipe?.name ?? e.id, e.source), status: e.status, builtin: e.builtin, ...(e.problem ? { problem: e.problem } : {}),
      reads: reads.length, checked: checked.length, works: checked.filter((r) => r.check!.status === "ok").length,
      ...(last ? { lastCheckedAt: new Date(last).toISOString() } : {}), stale: !!last && now - last > STALE_MS,
      skipped: e.skipped, readList,
    };
  });
  return {
    integrationId: row.id, packageId: row.packageId, recipes, progress: checkProgress(row.id), migrated: repo.recipesMigrated(),
    canChange: p.kind === "user" && canEdit(p), canImport: canEdit(p), grafana: row.packageId === "prometheus",
  };
}

/** Runs the live check of every recipe read on one integration now (the Check again button). */
export function startIntegrationCheck(p: Principal, integrationId: string): CheckProgress {
  requireEdit(p);
  const row = visibleIntegration(p, integrationId);
  const ids = recipeReadIds(endpointsOf(row, { includeDrafts: true }), row.packageId);
  void checkReads(row.id, ids).catch((e) => log.warn("live check failed", { error: (e as Error).message }));
  return { ...checkProgress(row.id), running: true, total: ids.length };
}

export function progressOf(p: Principal, integrationId: string): CheckProgress {
  requireList(p);
  visibleIntegration(p, integrationId);
  return checkProgress(integrationId);
}
