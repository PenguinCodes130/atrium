import "server-only";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, transaction } from "@/core/db";
import { AtriumError } from "@/core/errors";
import { dataDir } from "@/core/env";
import { logger } from "@/core/log";
import { accounts, sessions, users } from "@/db/schema/auth";
import { hashPassword, verifyPassword } from "./password-hash";
import { checkPassword } from "./policy";

// Owner recovery (auth gauntlet r1, fix 4). Server-side only: whoever can run a command on the server
// or set its environment can already replace the owner, so this adds no new way in. Two doors:
//   1. CLI:  pnpm exec tsx --conditions=react-server src/features/auth/cli/reset-owner.ts
//   2. Boot: ATRIUM_RESET_OWNER_PASSWORD=<new password>, restart once, then remove the variable.
// Either way the owner gets the new password, every session of every user is signed out, and the
// reset is written to the log and to <data>/audit-auth.jsonl. The variable is applied once: a marker
// file keeps an argon2id hash of the value it applied (salted, so it does not reveal the password and
// does not depend on any other secret), and later restarts with the same value ignore it.

const log = logger("auth");

export const RESET_VAR = "ATRIUM_RESET_OWNER_PASSWORD";
export const AUTH_AUDIT_FILE = "audit-auth.jsonl";
const MARKER_FILE = "owner-reset.json";

export type RecoverySource = "cli" | "env";
export type RecoveryResult = { ownerId: string; ownerEmail: string; sessionsRevoked: number };

/**
 * Audit records for auth events the frozen AuditEvent union has no name for yet. Written as
 * AuditEntry-shaped JSON lines until the actions subsystem's audit.write() exists (interface gap).
 */
export function recordAuthAudit(entry: { event: string; userId: string; target?: { type: string; id: string; label?: string }; detail?: Record<string, unknown> }): void {
  const line = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: { kind: "user", userId: entry.userId },
    event: entry.event,
    target: entry.target,
    result: "ok",
    detail: entry.detail,
  };
  appendFileSync(path.join(dataDir(), AUTH_AUDIT_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Sets a new owner password, signs out every session, and audits it. Throws on a weak password or no owner. */
export async function resetOwnerPassword(newPassword: string, source: RecoverySource): Promise<RecoveryResult> {
  const problem = checkPassword(newPassword);
  if (problem) throw new AtriumError(problem.message, 400, "weak_password");
  const owner = db().select({ id: users.id, email: users.email }).from(users).where(eq(users.role, "owner")).get();
  if (!owner) throw new AtriumError("No owner exists yet. Set ATRIUM_OWNER_EMAIL and start Atrium first.", 409, "no_owner");
  const hash = await hashPassword(newPassword);
  const now = new Date();
  const sessionsRevoked = transaction((tx) => {
    const cred = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, owner.id), eq(accounts.providerId, "credential")))
      .get();
    if (cred) tx.update(accounts).set({ password: hash, updatedAt: now }).where(eq(accounts.id, cred.id)).run();
    else tx.insert(accounts).values({ id: randomUUID(), accountId: owner.id, providerId: "credential", userId: owner.id, password: hash, createdAt: now, updatedAt: now }).run();
    // Every session of every user: whoever had the old password may have signed in anywhere.
    return tx.delete(sessions).run().changes;
  });
  recordAuthAudit({ event: "auth.owner_password_reset", userId: owner.id, target: { type: "user", id: owner.id, label: owner.email }, detail: { source, sessionsRevoked } });
  log.warn("Owner password reset from the server", { source, sessionsRevoked });
  return { ownerId: owner.id, ownerEmail: owner.email, sessionsRevoked };
}

export type EnvResetOutcome = "none" | "applied" | "already-used" | "refused";

/** Boot-time half: applies ATRIUM_RESET_OWNER_PASSWORD once. Called by bootstrap when an owner exists. */
export async function applyOwnerResetFromEnv(value: string | undefined = process.env[RESET_VAR]): Promise<EnvResetOutcome> {
  if (!value) return "none";
  const marker = path.join(dataDir(), MARKER_FILE);
  try {
    const used = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { valueHash?: string }).valueHash : undefined;
    if (used && (await verifyPassword(used, value))) {
      log.warn(`${RESET_VAR} was already applied and is ignored now. Remove it from the server environment.`);
      return "already-used";
    }
  } catch {
    // An unreadable marker is treated as absent.
  }
  try {
    await resetOwnerPassword(value, "env");
  } catch (err) {
    log.error(`${RESET_VAR} was not applied: ${err instanceof AtriumError ? err.message : "the reset failed"}`);
    return "refused";
  }
  writeFileSync(marker, JSON.stringify({ valueHash: await hashPassword(value), usedAt: new Date().toISOString() }), { mode: 0o600 });
  log.warn(`${RESET_VAR} was applied once: the owner has the new password and every session was signed out. Remove the variable and restart.`);
  return "applied";
}
