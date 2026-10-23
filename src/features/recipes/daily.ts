// A9.2: the daily live check, on a timer inside the server process (no new process). Once an hour it
// looks for integrations in use (read by a page in the last two days) whose recipe reads were last
// checked more than a day ago, and checks them one integration at a time.
import "server-only";
import { gt } from "drizzle-orm";
import { db } from "@/core/db";
import { logger } from "@/core/log";
import { endpointCache } from "@/db/schema/cache";
import { getIntegrationRow } from "@/features/integrations/repo";
import { endpointsOf } from "@/features/integrations/runtime";
import { checkReads, recipeReadIds } from "./check";
import * as repo from "./repo";

export const DAY_MS = 24 * 60 * 60_000;
const TICK_MS = 60 * 60_000;
const log = logger("recipes.daily");
const g = globalThis as unknown as { __atriumRecipeDaily?: ReturnType<typeof setInterval> };

/** Integrations read by a page in the last two days. */
export function integrationsInUse(now = Date.now()): string[] {
  try {
    const rows = db().selectDistinct({ id: endpointCache.integrationId }).from(endpointCache).where(gt(endpointCache.updatedAt, new Date(now - 2 * DAY_MS))).all();
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/** Which in-use integrations are due: some recipe read never checked, or checked over a day ago. */
export function dueIntegrations(now = Date.now()): string[] {
  const out: string[] = [];
  for (const id of integrationsInUse(now)) {
    const row = getIntegrationRow(id);
    if (!row || row.status !== "active") continue;
    const ids = recipeReadIds(endpointsOf(row, { includeDrafts: false }), row.packageId);
    if (!ids.length) continue;
    const checks = repo.checksMap(id);
    if (ids.some((e) => { const c = checks.get(e); return !c || now - Date.parse(c.at) > DAY_MS; })) out.push(id);
  }
  return out;
}

export async function runDailyChecks(now = Date.now()): Promise<number> {
  const due = dueIntegrations(now);
  for (const id of due) {
    try { await checkReads(id); } catch (e) { log.warn("daily check failed", { integrationId: id, error: (e as Error).message }); }
  }
  return due.length;
}

/** Starts the hourly timer once per process (idempotent). The first look is 5 minutes after start. */
export function ensureDailyChecks(): void {
  if (g.__atriumRecipeDaily || process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const first = setTimeout(() => void runDailyChecks().catch(() => undefined), 5 * 60_000);
  first.unref?.();
  g.__atriumRecipeDaily = setInterval(() => void runDailyChecks().catch(() => undefined), TICK_MS);
  g.__atriumRecipeDaily.unref?.();
}
