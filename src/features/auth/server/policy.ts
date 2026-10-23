// Pure auth rules (architecture section 5): allowlist patterns, password rules, roles and scopes.
// No I/O here, so every rule is unit-tested directly.
import { z } from "zod";
import type { AgentScope, Principal, Role } from "@/core/contracts";
import { COMMON_PASSWORDS } from "./common-passwords";

export const ROLES: readonly Role[] = ["viewer", "member", "owner"];
const RANK: Record<Role, number> = { viewer: 0, member: 1, owner: 2 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

// The least role a scope needs: reading is for everyone, editing and proposing need a member.
export const SCOPE_MIN_ROLE: Record<AgentScope, Role> = {
  "atrium:read": "viewer",
  "atrium:edit": "member",
  "atrium:propose": "member",
};

export const ALL_SCOPES: readonly AgentScope[] = ["atrium:read", "atrium:edit", "atrium:propose"];

export type ScopeDecision = { ok: true } | { ok: false; status: 403; missing: { role?: Role; scope?: AgentScope }; message: string };

/** Every principal that acts as a real account (architecture v3 section 5): all but the guest. */
export type AccountPrincipal = Exclude<Principal, { kind: "guest" }>;

export function isAccountPrincipal(p: Principal): p is AccountPrincipal {
  return p.kind !== "guest";
}

export const NO_PERMISSION = "You do not have permission to do that.";

/** Can this principal use something that needs `scope` and at least `minRole`? Guests never can. */
export function checkScope(principal: Principal, scope: AgentScope, minRole: Role = SCOPE_MIN_ROLE[scope]): ScopeDecision {
  const needRole = RANK[minRole] > RANK[SCOPE_MIN_ROLE[scope]] ? minRole : SCOPE_MIN_ROLE[scope];
  // A guest has no account and no role (section 5.1): refused with the usual permission error.
  if (!isAccountPrincipal(principal)) return { ok: false, status: 403, missing: { role: needRole }, message: NO_PERMISSION };
  if (principal.kind === "agent" && !principal.scopes.includes(scope)) {
    return { ok: false, status: 403, missing: { scope }, message: `This token is missing the ${scope} scope.` };
  }
  if (!roleAtLeast(principal.role, needRole)) {
    return { ok: false, status: 403, missing: { role: needRole }, message: `This needs the ${needRole} role; you are a ${principal.role}.` };
  }
  return { ok: true };
}

// ---- Allowlist -------------------------------------------------------------------------------

const emailSchema = z.email();

export function isValidEmail(value: string): boolean {
  return emailSchema.safeParse(value.trim()).success;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Normalises a pattern, or returns null when it is neither an exact email nor `*@domain`. */
export function normalizePattern(raw: string): string | null {
  const p = raw.trim().toLowerCase();
  if (p.startsWith("*@")) {
    const domain = p.slice(2);
    return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? p : null;
  }
  return isValidEmail(p) ? p : null;
}

export type AllowlistPattern = { pattern: string; role: Role };

/** The pattern that admits this email: an exact email beats a `*@domain`. Null when none does. */
export function matchAllowlist(email: string, entries: readonly AllowlistPattern[]): AllowlistPattern | null {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  const domain = e.slice(at + 1);
  const exact = entries.find((x) => x.pattern === e);
  if (exact) return exact;
  return entries.find((x) => x.pattern === `*@${domain}`) ?? null;
}

// ---- Passwords --------------------------------------------------------------------------------

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const COMMON = new Set(COMMON_PASSWORDS);

export type PasswordProblem = { rule: "length" | "common" | "too_long"; message: string };

/** Checks the password rules; the message says which rule failed and what to do. */
export function checkPassword(password: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN) return { rule: "length", message: `Use at least ${PASSWORD_MIN} characters.` };
  if (password.length > PASSWORD_MAX) return { rule: "too_long", message: `Use at most ${PASSWORD_MAX} characters.` };
  if (COMMON.has(password.toLowerCase())) return { rule: "common", message: "That password is on the list of common passwords. Pick another." };
  return null;
}

export function isCommonPassword(password: string): boolean {
  return COMMON.has(password.toLowerCase());
}

// ---- Step-up ------------------------------------------------------------------------------------

export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export function stepUpValid(stepUpAt: Date | null | undefined, now: number = Date.now()): boolean {
  return !!stepUpAt && now - stepUpAt.getTime() <= STEP_UP_WINDOW_MS && stepUpAt.getTime() <= now + 1000;
}

// ---- Personal access tokens ---------------------------------------------------------------------

export const PAT_PREFIX = "atr_pat_";
export const PAT_PATTERN = /^atr_pat_[A-Za-z0-9_-]{43}$/;
