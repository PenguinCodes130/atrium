import "server-only";
import { and, eq, ne } from "drizzle-orm";
import type { Role } from "@/core/contracts";
import { db } from "@/core/db";
import { Forbidden } from "@/core/errors";
import { accounts, sessions } from "@/db/schema/auth";
import { addAllowlistPattern, listAllowlist, removeAllowlistPattern, setAllowlistRole, type AllowlistEntry } from "./allowlist";
import { createInvite, createReset, listAccountLinks, revokeAccountLink, type AccountLinkView, type CreatedAccountLink } from "../account-links/service";
import { configuredProviders } from "./providers";
import type { AllowlistPattern } from "./policy";
import { requireStepUpFrom, requireUserFrom } from "./session";
import { listUsers, removeUser, setUserRole, transferOwnership, type ManagedUser } from "./users";

// The users and allowlist page (/settings/users). Only the owner manages users and the allowlist;
// a member or viewer gets 403 naming the missing role. Ownership transfer also needs step-up.

async function requireOwner(headers: Headers) {
  const s = await requireUserFrom(headers);
  if (s.user.role !== "owner") throw new Forbidden(`Only the owner can manage users and the allowlist; you are a ${s.user.role}.`);
  return s;
}

export type UsersPageData = {
  me: { id: string; role: Role };
  users: ManagedUser[];
  allowlist: AllowlistEntry[];
  /** Invite and reset links (Amendment 3); never a token or hash. */
  links: AccountLinkView[];
  /** Names of the sign-in providers configured on this server, for "how added people sign in". */
  providers: string[];
};

export async function loadUsersPage(headers: Headers): Promise<UsersPageData> {
  const s = await requireOwner(headers);
  return {
    me: { id: s.user.id, role: s.user.role },
    users: listUsers(),
    allowlist: listAllowlist(),
    links: listAccountLinks(s.principal),
    providers: configuredProviders().map((p) => p.name),
  };
}

export async function changeRoleAs(headers: Headers, userId: string, role: Role) {
  const s = await requireOwner(headers);
  return setUserRole(userId, role, s.principal);
}

export async function removeUserAs(headers: Headers, userId: string) {
  const s = await requireOwner(headers);
  removeUser(userId, s.principal);
}

export async function transferOwnershipAs(headers: Headers, toUserId: string) {
  const s = await requireOwner(headers);
  await requireStepUpFrom(headers);
  transferOwnership(s.user.id, toUserId);
}

export async function addPatternAs(headers: Headers, pattern: string, role: Role) {
  await requireOwner(headers);
  return addAllowlistPattern(pattern, role);
}

export async function removePatternAs(headers: Headers, id: string): Promise<AllowlistPattern | null> {
  const s = await requireOwner(headers);
  return removeAllowlistPattern(id, s.principal);
}

export async function setPatternRoleAs(headers: Headers, id: string, role: Role) {
  await requireOwner(headers);
  return setAllowlistRole(id, role);
}

// ---- Invite and reset links (Amendment 3). The service checks the owner again on every call. --------

export async function createInviteAs(headers: Headers, input: { email: unknown; role: unknown; days?: unknown }, ip?: string): Promise<CreatedAccountLink> {
  const s = await requireUserFrom(headers);
  return createInvite(s.principal, input, { ip });
}

export async function createResetAs(headers: Headers, userId: string, days?: unknown, ip?: string): Promise<CreatedAccountLink> {
  const s = await requireUserFrom(headers);
  return createReset(s.principal, userId, { days }, { ip });
}

export async function listLinksAs(headers: Headers): Promise<AccountLinkView[]> {
  const s = await requireUserFrom(headers);
  return listAccountLinks(s.principal);
}

export async function revokeLinkAs(headers: Headers, id: string): Promise<AccountLinkView> {
  const s = await requireUserFrom(headers);
  return revokeAccountLink(s.principal, id);
}

// ---- The signed-in user's own sessions (architecture section 5) -------------------------------------
// Session tokens never leave the server: the list carries ids and device details only.

export type MySession = { id: string; createdAt: string; lastUsedAt: string; userAgent: string | null; current: boolean };

export async function listMySessions(headers: Headers): Promise<MySession[]> {
  const s = await requireUserFrom(headers);
  const rows = db().select().from(sessions).where(eq(sessions.userId, s.user.id)).all();
  return rows
    .filter((r) => r.expiresAt.getTime() > Date.now())
    .map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), lastUsedAt: r.updatedAt.toISOString(), userAgent: r.userAgent ?? null, current: r.id === s.session.id }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt.localeCompare(a.lastUsedAt));
}

/** Signs out every other device: only the current session keeps working. */
export async function signOutOtherSessions(headers: Headers): Promise<number> {
  const s = await requireUserFrom(headers);
  const res = db().delete(sessions).where(and(eq(sessions.userId, s.user.id), ne(sessions.id, s.session.id))).run();
  return res.changes;
}

export function hasPasswordAccount(userId: string): boolean {
  return !!db().select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential"))).get();
}
