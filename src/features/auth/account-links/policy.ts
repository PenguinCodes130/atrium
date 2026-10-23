// Account links (architecture v3 Amendment 3, auth-spec-v3): member invites and password resets.
// Pure rules and texts, shared by the server and the screens. No I/O here.

export const ACCOUNT_LINK_PREFIX = "atr_i_";
export const ACCOUNT_LINK_PATTERN = /^atr_i_[A-Za-z0-9_-]{43}$/;

export const DEFAULT_DAYS = 7;
export const MIN_DAYS = 1;
export const MAX_DAYS = 30;
const DAY_MS = 86_400_000;

export const DEAD_TEXT = "This link has expired or was already used";
export const SIGNED_IN_TEXT = "You are already signed in";

export type LinkKind = "invite" | "reset";
export type LinkRole = "member" | "viewer";
export type LinkStatus = "waiting" | "used" | "expired" | "revoked";
export type RevokeCause = "manual" | "replaced" | "entry_removed" | "user_removed" | "user_exists";

export const LINK_MESSAGES = {
  notOwner: (role: string) => `Only the owner can create invite and reset links; you are a ${role}.`,
  agents: "Agents cannot create, list or revoke invite and reset links.",
  enterEmail: "Enter the email of the person you are inviting.",
  exactEmail: "Invite one person by their exact email, such as ana@example.com.",
  pickRole: "Pick Member or Viewer.",
  ownerRole: "There is only one owner. Invite them as a member, then transfer ownership on their row.",
  days: `Pick between ${MIN_DAYS} and ${MAX_DAYS} days.`,
  hasAccount: (email: string) => `${email} already has an account. Use Reset password on their row instead.`,
  roleDiffers: (role: string) => `Already on the allowlist as ${role}. Change the role on its entry first.`,
  ownerReset: "The owner's password is reset on the server: pnpm atrium:reset-owner.",
  userMissing: "That user no longer exists.",
  linkMissing: "That link no longer exists.",
  passwordMismatch: "The two passwords do not match. Type the same password in both fields.",
  enterPassword: "Enter a new password.",
} as const;

export type FieldProblem = { field: string; message: string };

/** Expiry in days: default 7, whole days from 1 to 30. */
export function checkDays(raw: unknown): { ok: true; days: number } | { ok: false; problem: FieldProblem } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, days: DEFAULT_DAYS };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) return { ok: false, problem: { field: "days", message: LINK_MESSAGES.days } };
  return { ok: true, days: n };
}

export function expiryFor(days: number, now: number): Date {
  return new Date(now + days * DAY_MS);
}

export function linkStatus(row: { usedAt: number | null; revokedAt: number | null; expiresAt: number }, now: number): LinkStatus {
  if (row.usedAt) return "used";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= now) return "expired";
  return "waiting";
}

export function looksLikeAccountLinkToken(token: unknown): token is string {
  return typeof token === "string" && ACCOUNT_LINK_PATTERN.test(token);
}

/** `/invite/<token>` and the screens under it (set, expired, signed-in). */
export function isAccountLinkPath(pathname: string): boolean {
  return pathname === "/invite" || pathname.startsWith("/invite/");
}
