import "server-only";
// Account link revocation (Amendment 3) that the allowlist and user code call. Only the database and
// the audit writer, so allowlist.ts and users.ts can import it without a cycle.
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AuditEntry, Principal } from "@/core/contracts";
import { db } from "@/core/db";
import { audit } from "@/features/audit/write";
import { accountLinks } from "@/db/schema/auth";
import type { LinkKind, LinkRole, RevokeCause } from "./policy";

export type AccountLinkRow = typeof accountLinks.$inferSelect;

const SYSTEM: AuditEntry["actor"] = { kind: "system" };

/** Waiting (unused, unrevoked, unexpired) links matching the filter. */
export function waitingLinks(filter: { email?: string; userId?: string; kind?: LinkKind }, now: Date = new Date()): AccountLinkRow[] {
  const conds = [isNull(accountLinks.usedAt), isNull(accountLinks.revokedAt), gt(accountLinks.expiresAt, now)];
  if (filter.email) conds.push(eq(accountLinks.email, filter.email));
  if (filter.userId) conds.push(eq(accountLinks.userId, filter.userId));
  if (filter.kind) conds.push(eq(accountLinks.kind, filter.kind));
  return db().select().from(accountLinks).where(and(...conds)).all();
}

/** Revokes the given links, one `account.link_revoked` each. `by` null means the system did it. */
export function revokeAccountLinks(rows: AccountLinkRow[], cause: RevokeCause, by: Principal | null, now: Date = new Date()): number {
  let n = 0;
  for (const r of rows) {
    const res = db()
      .update(accountLinks)
      .set({ revokedAt: now, revokedCause: cause })
      .where(and(eq(accountLinks.id, r.id), isNull(accountLinks.revokedAt), isNull(accountLinks.usedAt)))
      .run();
    if (res.changes !== 1) continue;
    n += 1;
    audit.write({
      actor: by ?? SYSTEM,
      event: "account.link_revoked",
      target: { type: "account_link", id: r.id, label: r.email },
      result: "ok",
      detail: { kind: r.kind, email: r.email, cause },
      at: now,
    });
  }
  return n;
}

/** An allowlist entry was removed: that email's waiting invite ends. */
export function revokeInvitesForEmail(email: string, cause: RevokeCause, by: Principal | null): number {
  return revokeAccountLinks(waitingLinks({ email, kind: "invite" }), cause, by);
}

/** The role control on an allowlist entry also applies to that email's waiting invite. */
export function setWaitingInviteRole(email: string, role: LinkRole): void {
  for (const r of waitingLinks({ email, kind: "invite" })) db().update(accountLinks).set({ role }).where(eq(accountLinks.id, r.id)).run();
}
