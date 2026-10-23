import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Principal, Role } from "@/core/contracts";
import { db } from "@/core/db";
import { AtriumError, NotFound } from "@/core/errors";
import { allowlistEntries } from "@/db/schema/auth";
import { matchAllowlist, normalizePattern, type AllowlistPattern } from "./policy";
import { revokeInvitesForEmail, setWaitingInviteRole } from "../account-links/store";

export type AllowlistEntry = AllowlistPattern & { id: string; createdAt: string };

export function listAllowlist(): AllowlistEntry[] {
  return db()
    .select()
    .from(allowlistEntries)
    .all()
    .map((r) => ({ id: r.id, pattern: r.pattern, role: r.role, createdAt: r.createdAt.toISOString() }));
}

export function lookupAllowlist(email: string): AllowlistPattern | null {
  return matchAllowlist(email, listAllowlist());
}

export const ALLOWLIST_MESSAGES = {
  empty: "Enter an email or *@domain.",
  invalid: "Use an exact email such as ana@example.com, or *@example.com for a whole domain.",
  pickRole: "Pick member or viewer. There is only one owner; transfer ownership on the user instead.",
  already: (role: Role) => `Already on the allowlist as ${role}.`,
  ownerEntry: "The owner's entry always stays Owner, and it cannot be removed.",
  missing: "That allowlist entry no longer exists.",
} as const;

/**
 * Adds a pattern (auth gauntlet r3, fix 2). A pattern that is already listed is refused and left as it
 * is: roles change only through setAllowlistRole, and the owner's entry never changes.
 */
export function addAllowlistPattern(raw: string, role: Role): AllowlistEntry {
  if (!raw.trim()) throw new AtriumError(ALLOWLIST_MESSAGES.empty, 400, "missing_pattern");
  const pattern = normalizePattern(raw);
  if (!pattern) throw new AtriumError(ALLOWLIST_MESSAGES.invalid, 400, "invalid_pattern");
  const existing = db().select().from(allowlistEntries).where(eq(allowlistEntries.pattern, pattern)).get();
  if (existing) throw new AtriumError(ALLOWLIST_MESSAGES.already(existing.role), 409, "already_listed");
  if (role === "owner") throw new AtriumError(ALLOWLIST_MESSAGES.pickRole, 400, "invalid_role");
  const row = { id: randomUUID(), pattern, role, createdAt: new Date() };
  db().insert(allowlistEntries).values(row).run();
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** The explicit role control on one entry. Never for the owner's entry, never to owner. */
export function setAllowlistRole(id: string, role: Role): AllowlistEntry {
  const row = db().select().from(allowlistEntries).where(eq(allowlistEntries.id, id)).get();
  if (!row) throw new NotFound(ALLOWLIST_MESSAGES.missing);
  if (row.role === "owner") throw new AtriumError(ALLOWLIST_MESSAGES.ownerEntry, 400, "owner_entry");
  if (role === "owner") throw new AtriumError(ALLOWLIST_MESSAGES.pickRole, 400, "invalid_role");
  db().update(allowlistEntries).set({ role }).where(eq(allowlistEntries.id, id)).run();
  // Editing a pattern never changes existing users (their role lives on the user), but a waiting
  // invite for that exact email follows the entry.
  if (!row.pattern.startsWith("*@")) setWaitingInviteRole(row.pattern, role);
  return { id: row.id, pattern: row.pattern, role, createdAt: row.createdAt.toISOString() };
}

/** Removes a non-owner entry and returns it (for Undo). That email's waiting invite ends too. */
export function removeAllowlistPattern(id: string, by: Principal | null = null): AllowlistPattern | null {
  const row = db().select().from(allowlistEntries).where(eq(allowlistEntries.id, id)).get();
  if (!row) return null;
  if (row.role === "owner") throw new AtriumError(ALLOWLIST_MESSAGES.ownerEntry, 400, "owner_entry");
  db().delete(allowlistEntries).where(eq(allowlistEntries.id, id)).run();
  if (!row.pattern.startsWith("*@")) revokeInvitesForEmail(row.pattern, "entry_removed", by);
  return { pattern: row.pattern, role: row.role };
}
