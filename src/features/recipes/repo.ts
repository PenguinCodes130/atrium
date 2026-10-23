// Database access for recipes and live check results (A9.1, A9.2). Nothing secret is stored here.
// Until the lead's migration for these tables is applied, reads answer "nothing stored" (built-in
// recipes still work) and writes fail with a plain message instead of breaking every page.
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { ReadCheck } from "@/core/contracts";
import { AtriumError } from "@/core/errors";
import { db } from "@/core/db";
import { readChecks, recipes } from "@/db/schema/recipes";

export type RecipeRow = typeof recipes.$inferSelect;
export type CheckRow = typeof readChecks.$inferSelect;

const missing = (e: unknown) => /no such table/i.test((e as Error)?.message ?? "");
export const NOT_MIGRATED = "Recipes need a database update that has not been applied yet. Restart Atrium after updating it.";

function read<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    if (missing(e)) return fallback;
    throw e;
  }
}

function write<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (missing(e)) throw new AtriumError(NOT_MIGRATED, 503, "not_migrated");
    throw e;
  }
}

export function listRecipeRows(): RecipeRow[] {
  return read(() => db().select().from(recipes).all(), []);
}

export function getRecipeRow(id: string): RecipeRow | undefined {
  return read(() => db().select().from(recipes).where(eq(recipes.id, id)).get(), undefined);
}

export function upsertRecipeRow(row: RecipeRow): void {
  write(() =>
    db()
      .insert(recipes)
      .values(row)
      .onConflictDoUpdate({ target: recipes.id, set: { record: row.record, source: row.source, status: row.status, problem: row.problem, skipped: row.skipped, originIntegrationId: row.originIntegrationId, createdById: row.createdById, importedAt: row.importedAt, updatedAt: row.updatedAt } })
      .run(),
  );
}

export function setRecipeStatus(id: string, status: "draft" | "active"): void {
  write(() => db().update(recipes).set({ status, updatedAt: new Date() }).where(eq(recipes.id, id)).run());
}

export function deleteRecipeRow(id: string): void {
  write(() => db().delete(recipes).where(eq(recipes.id, id)).run());
}

export function listChecks(integrationId: string): CheckRow[] {
  return read(() => db().select().from(readChecks).where(eq(readChecks.integrationId, integrationId)).all(), []);
}

export function checksMap(integrationId: string): Map<string, ReadCheck & { previous?: ReadCheck["status"] }> {
  return new Map(listChecks(integrationId).map((c) => [c.endpointId, { status: c.status, ...(c.reason ? { reason: c.reason } : {}), at: c.at.toISOString(), ...(c.previous ? { previous: c.previous } : {}) }]));
}

/** Stores one result, keeping the status before it (for "used to work, now fails"). */
export function saveCheck(integrationId: string, endpointId: string, c: ReadCheck): void {
  write(() => {
    const prev = db().select().from(readChecks).where(and(eq(readChecks.integrationId, integrationId), eq(readChecks.endpointId, endpointId))).get();
    // A read that keeps failing keeps the status it had before it first failed.
    const previous = prev ? (prev.status === "failed" && c.status === "failed" ? prev.previous : prev.status) : null;
    const row = { integrationId, endpointId, status: c.status, reason: c.reason ?? null, previous, at: new Date(c.at) };
    db().insert(readChecks).values(row).onConflictDoUpdate({ target: [readChecks.integrationId, readChecks.endpointId], set: { status: row.status, reason: row.reason, previous: row.previous, at: row.at } }).run();
  });
}

export function deleteChecks(integrationId: string, endpointIds: string[]): void {
  if (!endpointIds.length) return;
  write(() => db().delete(readChecks).where(and(eq(readChecks.integrationId, integrationId), inArray(readChecks.endpointId, endpointIds))).run());
}

/** Whether the recipe tables exist (for the Recipes section's notice). */
export function recipesMigrated(): boolean {
  return read(() => { db().select({ id: recipes.id }).from(recipes).limit(1).all(); return true; }, false);
}
