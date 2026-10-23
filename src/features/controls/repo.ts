// Control run records (architecture v3 section 6.2). Append only; secret-looking input keys are
// redacted the same way the audit log redacts them.
import "server-only";
import { desc, eq } from "drizzle-orm";
import type { ControlRun, Principal } from "@/core/contracts";
import { db } from "@/core/db";
import { controlRuns } from "@/db/schema/integrations";
import { redact } from "@/features/audit/write";

export function insertControlRun(run: ControlRun & { nodeId: string }): void {
  const by = run.by;
  db().insert(controlRuns).values({
    id: run.id,
    appId: run.appId,
    version: run.version,
    controlId: run.controlId,
    nodeId: run.nodeId,
    byKind: by.kind,
    byUserId: by.kind === "guest" ? null : by.userId,
    byGuestLinkId: by.kind === "guest" ? by.guestLinkId : null,
    byLabel: by.kind === "guest" ? by.label : null,
    at: new Date(run.at),
    input: run.input === undefined ? null : redact(run.input),
    result: run.result,
    message: run.message ?? null,
    durationMs: run.durationMs,
  }).run();
}

export type ControlRunRow = typeof controlRuns.$inferSelect;

export function listControlRuns(appId: string, limit = 100): ControlRunRow[] {
  return db().select().from(controlRuns).where(eq(controlRuns.appId, appId)).orderBy(desc(controlRuns.at)).limit(limit).all();
}

export function countControlRuns(): number {
  return db().select({ id: controlRuns.id }).from(controlRuns).all().length;
}

export type { Principal };
