// What the Backups screen shows before any action: the last export and import from the audit log.
import "server-only";
import { desc, eq, or } from "drizzle-orm";
import { db } from "@/core/db";
import { auditLog } from "@/db/schema/audit";

export type BackupHistory = { at: string; event: "backup.exported" | "backup.imported"; withSealedValues: boolean }[];

export function backupHistory(limit = 5): BackupHistory {
  return db()
    .select({ at: auditLog.at, event: auditLog.event, detail: auditLog.detail })
    .from(auditLog)
    .where(or(eq(auditLog.event, "backup.exported"), eq(auditLog.event, "backup.imported")))
    .orderBy(desc(auditLog.at))
    .limit(limit)
    .all()
    .map((r) => ({ at: r.at.toISOString(), event: r.event as BackupHistory[number]["event"], withSealedValues: !!(r.detail as { withSealedValues?: boolean } | null)?.withSealedValues }));
}
