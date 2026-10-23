import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { Principal, Role } from "@/core/contracts";
import { db, transaction } from "@/core/db";
import { AtriumError, NotFound } from "@/core/errors";
import { logger } from "@/core/log";
import { users, sessions, allowlistEntries } from "@/db/schema/auth";
import { normalizeEmail, roleAtLeast } from "./policy";
import { revokeCreatorGuestLinks } from "../guest/store";

// User management (architecture section 5). Callers check that the actor is the owner first
// (see actions.ts); these functions enforce the invariants: exactly one owner, and demoting or
// removing a user cuts all of their sessions and agent tokens at once.

const log = logger("auth");

export type ManagedUser = { id: string; email: string; name: string; role: Role; twoFactorEnabled: boolean; createdAt: string };

export type AccessCutReason = "demoted" | "removed" | "password_reset";
type RevokeListener = (info: { userId: string; reason: AccessCutReason }) => void | Promise<void>;
const revokeListeners = new Set<RevokeListener>();

/** agent-api subscribes here to mark the user's agent_token rows revoked. Auth already refuses them. */
export function onUserAccessRevoked(fn: RevokeListener): () => void {
  revokeListeners.add(fn);
  return () => revokeListeners.delete(fn);
}

export function listUsers(): ManagedUser[] {
  return db()
    .select()
    .from(users)
    .all()
    .map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, twoFactorEnabled: !!u.twoFactorEnabled, createdAt: u.createdAt.toISOString() }))
    .sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : a.email.localeCompare(b.email)));
}

function getUser(id: string) {
  const u = db().select().from(users).where(eq(users.id, id)).get();
  if (!u) throw new NotFound("That user no longer exists.");
  return u;
}

function cutAccess(tx: Parameters<Parameters<typeof transaction>[0]>[0], userId: string, now: Date) {
  tx.delete(sessions).where(eq(sessions.userId, userId)).run();
  tx.update(users).set({ accessRevokedAt: now, updatedAt: now }).where(eq(users.id, userId)).run();
}

function notify(userId: string, reason: AccessCutReason) {
  for (const fn of revokeListeners) Promise.resolve(fn({ userId, reason })).catch(() => log.warn("An access-revoked listener failed"));
}

/** A reset link was used (Amendment 3): agent-api marks the user's agent tokens revoked. Auth already refuses them. */
export function notifyAccessCut(userId: string, reason: AccessCutReason): void {
  notify(userId, reason);
}

/** `by` is the owner making the change; it is the audit actor for any guest links this revokes. */
export function setUserRole(userId: string, role: Role, by: Principal | null = null): ManagedUser {
  const u = getUser(userId);
  if (u.role === "owner") throw new AtriumError("The owner cannot be demoted. Transfer ownership to another user first.", 400, "owner_protected");
  if (role === "owner") throw new AtriumError("Use Transfer ownership to make someone the owner.", 400, "use_transfer");
  if (u.role === role) return listUsers().find((x) => x.id === userId)!;
  const demoted = !roleAtLeast(role, u.role);
  const now = new Date();
  transaction((tx) => {
    tx.update(users).set({ role, updatedAt: now }).where(eq(users.id, userId)).run();
    if (demoted) cutAccess(tx, userId, now);
  });
  if (demoted) notify(userId, "demoted");
  // Architecture v3 5.1: a creator demoted to viewer loses every guest link they made, on every app.
  if (role === "viewer") revokeCreatorGuestLinks(userId, "creator_demoted", by, undefined, now);
  log.info("User role changed", { userId, role });
  return listUsers().find((x) => x.id === userId)!;
}

export function removeUser(userId: string, by: Principal | null = null): void {
  const u = getUser(userId);
  if (u.role === "owner") throw new AtriumError("The owner cannot be removed. Transfer ownership to another user first.", 400, "owner_protected");
  transaction((tx) => {
    tx.delete(sessions).where(eq(sessions.userId, userId)).run();
    tx.delete(users).where(eq(users.id, userId)).run();
  });
  notify(userId, "removed");
  revokeCreatorGuestLinks(userId, "creator_removed", by);
  log.info("User removed", { userId });
}

/** Moves ownership. The caller must have completed step-up. The previous owner becomes a member. */
export function transferOwnership(fromUserId: string, toUserId: string): void {
  const from = getUser(fromUserId);
  const to = getUser(toUserId);
  if (from.role !== "owner") throw new AtriumError("Only the owner can transfer ownership.", 403, "forbidden");
  if (from.id === to.id) throw new AtriumError("Pick another user to transfer ownership to.", 400, "same_user");
  const now = new Date();
  transaction((tx) => {
    tx.update(users).set({ role: "owner", updatedAt: now }).where(eq(users.id, to.id)).run();
    tx.update(users).set({ role: "member", updatedAt: now }).where(eq(users.id, from.id)).run();
    // The previous owner was demoted, so their sessions and tokens end too.
    cutAccess(tx, from.id, now);
    // Keep the allowlist in step: the owner's own entry follows the owner.
    tx.update(allowlistEntries).set({ role: "member" }).where(and(eq(allowlistEntries.role, "owner"), ne(allowlistEntries.pattern, normalizeEmail(to.email)))).run();
    tx.insert(allowlistEntries)
      .values({ id: randomUUID(), pattern: normalizeEmail(to.email), role: "owner", createdAt: now })
      .onConflictDoUpdate({ target: allowlistEntries.pattern, set: { role: "owner" } })
      .run();
    const owners = tx.select({ id: users.id }).from(users).where(eq(users.role, "owner")).all();
    if (owners.length !== 1) throw new AtriumError("Ownership transfer failed. Nothing was changed.", 500, "owner_invariant");
  });
  notify(from.id, "demoted");
  log.info("Ownership transferred", { fromUserId: from.id, toUserId: to.id });
}
