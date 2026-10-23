import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AuditEntry, Principal } from "@/core/contracts";
import { db, transaction } from "@/core/db";
import { logger } from "@/core/log";
import { audit } from "@/features/audit/write";
import { guestLinks, guestSessions } from "@/db/schema/guests";
import type { RevokeCause } from "./policy";

// Guest link revocation (architecture v3 5.1 and amendment A1.1). Kept apart from the open and
// create flows so user management (users.ts) can call it without loading Better Auth.
// Revoking ends every guest session of the link at once: the sessions are deleted, and every guest
// request re-checks the link anyway.

const log = logger("auth.guest");

export type GuestLinkRow = typeof guestLinks.$inferSelect;

// The audit actor for a revocation nobody asked for (the app was found deleted, guests found off).
const SYSTEM_ACTOR: AuditEntry["actor"] = { kind: "system" };

/** Revokes the given links (those not already revoked) with one `guest_link.revoked` entry each. */
export function revokeLinks(rows: GuestLinkRow[], cause: RevokeCause, by: Principal | null, now: Date = new Date()): number {
  const live = rows.filter((r) => !r.revokedAt);
  if (live.length === 0) return 0;
  const ids = live.map((r) => r.id);
  const byId = by && by.kind !== "guest" ? by.userId : null;
  const changed = transaction((tx) => {
    const res = tx
      .update(guestLinks)
      .set({ revokedAt: now, revokedCause: cause, revokedBy: byId })
      .where(and(inArray(guestLinks.id, ids), isNull(guestLinks.revokedAt)))
      .run();
    tx.delete(guestSessions).where(inArray(guestSessions.linkId, ids)).run();
    return res.changes;
  });
  for (const r of live) {
    audit.write({
      actor: by ?? SYSTEM_ACTOR,
      event: "guest_link.revoked",
      target: { type: "guest_link", id: r.id, label: r.label },
      result: "ok",
      detail: { cause, appId: r.appId, by: by ? "person" : "system" },
      at: now,
    });
  }
  log.info("Guest links revoked", { count: changed, cause });
  return changed;
}

/** Every link of an app: for app-builder when `access.guests` is turned off or the app is deleted. */
export function revokeAppGuestLinks(appId: string, cause: "guests_off" | "app_deleted", by: Principal | null = null, now: Date = new Date()): number {
  const rows = db().select().from(guestLinks).where(and(eq(guestLinks.appId, appId), isNull(guestLinks.revokedAt))).all();
  return revokeLinks(rows, cause, by, now);
}

/**
 * Every link a user created, on every app (demoted to viewer, or removed), or on one app (lost edit
 * access to it, amendment A1.1: app-builder passes `appId`).
 */
export function revokeCreatorGuestLinks(
  userId: string,
  cause: "creator_demoted" | "creator_removed" | "creator_lost_edit",
  by: Principal | null = null,
  appId?: string,
  now: Date = new Date(),
): number {
  const where = appId
    ? and(eq(guestLinks.createdBy, userId), eq(guestLinks.appId, appId), isNull(guestLinks.revokedAt))
    : and(eq(guestLinks.createdBy, userId), isNull(guestLinks.revokedAt));
  return revokeLinks(db().select().from(guestLinks).where(where).all(), cause, by, now);
}
