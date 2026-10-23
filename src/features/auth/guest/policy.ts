// Pure guest link rules (architecture v3 section 5.1, auth-spec-v2). No I/O, so each rule is unit-tested.

export const GUEST_TOKEN_PREFIX = "atr_g_";
export const GUEST_TOKEN_PATTERN = /^atr_g_[A-Za-z0-9_-]{43}$/;
export const GUEST_SESSION_PREFIX = "atr_gs_";
export const GUEST_SESSION_PATTERN = /^atr_gs_[A-Za-z0-9_-]{43}$/;
export const GUEST_COOKIE = "atrium.guest";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const DEFAULT_EXPIRY_MS = 7 * DAY;
export const MAX_EXPIRY_MS = 90 * DAY;
export const GUEST_IDLE_MS = 7 * DAY;
export const PIN_MAX_FAILS = 5;
export const PIN_WINDOW_MS = 15 * MINUTE;
export const PIN_LOCK_MS = 15 * MINUTE;
export const LABEL_MAX = 80;
// A request built a moment before the server's clock reads "now" may name exactly 90 days.
const EXPIRY_SLACK_MS = MINUTE;

// The one screen every dead link shows (criterion 10): no detail, the same words for every cause.
export const EXPIRED_TEXT = "This link has expired or was turned off";

export const MESSAGES = {
  guestsOff: "Guest links are off for this app",
  notEditor: "Only the owner or an editor of this app can create guest links",
  notRevoker: "Only the link's creator, an editor of this app or the owner can revoke this link",
  agents: "Agents cannot create guest links",
  notAvailable: "Guest links are not available yet",
  appMissing: "That app no longer exists",
  linkMissing: "That guest link no longer exists",
  wrongPin: "Wrong PIN",
} as const;

export type RevokeCause = "manual" | "guests_off" | "app_deleted" | "creator_demoted" | "creator_removed" | "creator_lost_edit";
// Links revoked because of what happened to their creator; the owner's panel lists these first.
export const CREATOR_CAUSES: ReadonlySet<RevokeCause> = new Set(["creator_demoted", "creator_removed", "creator_lost_edit"]);

export type CreateInput = { label?: unknown; expiresAt?: unknown; pin?: unknown };
export type CreateFields = { label: string; expiresAt: Date; pin: string | null };
export type FieldProblem = { field: "label" | "expiresAt" | "pin"; message: string };

/** Checks a create request; the problem names the field to fix. */
export function checkCreateInput(input: CreateInput, now: number = Date.now()): { ok: true; value: CreateFields } | { ok: false; problem: FieldProblem } {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label) return { ok: false, problem: { field: "label", message: 'Add a label, for example "Guest room, Sam".' } };
  if (label.length > LABEL_MAX) return { ok: false, problem: { field: "label", message: `Keep the label under ${LABEL_MAX} characters.` } };

  let expiresAt: Date;
  if (input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === "") {
    expiresAt = new Date(now + DEFAULT_EXPIRY_MS);
  } else {
    const t = typeof input.expiresAt === "string" || typeof input.expiresAt === "number" ? new Date(input.expiresAt).getTime() : NaN;
    if (!Number.isFinite(t)) return { ok: false, problem: { field: "expiresAt", message: "Pick a valid expiry date." } };
    if (t <= now) return { ok: false, problem: { field: "expiresAt", message: "Pick an expiry in the future." } };
    if (t > now + MAX_EXPIRY_MS + EXPIRY_SLACK_MS) return { ok: false, problem: { field: "expiresAt", message: "Pick an expiry at most 90 days from now." } };
    expiresAt = new Date(t);
  }

  let pin: string | null = null;
  if (input.pin !== undefined && input.pin !== null && input.pin !== "") {
    if (typeof input.pin !== "string" || !/^[0-9]{4,8}$/.test(input.pin)) {
      return { ok: false, problem: { field: "pin", message: "The PIN must be 4 to 8 digits." } };
    }
    pin = input.pin;
  }
  return { ok: true, value: { label, expiresAt, pin } };
}

/** When a guest session used at `usedAt` ends: 7 days later, never after the link's expiry. */
export function guestSessionExpiry(usedAt: number, linkExpiresAt: number): number {
  return Math.min(usedAt + GUEST_IDLE_MS, linkExpiresAt);
}

export type PinState = { failCount: number; windowStart: number | null; lockedUntil: number | null };

/** Minutes left on a PIN lock (rounded up), or 0 when the link is not locked. */
export function pinLockMinutes(s: PinState, now: number = Date.now()): number {
  return s.lockedUntil && s.lockedUntil > now ? Math.max(1, Math.ceil((s.lockedUntil - now) / MINUTE)) : 0;
}

/** The PIN state after one wrong PIN: the 5th wrong try within 15 minutes locks the link for 15 minutes. */
export function afterWrongPin(s: PinState, now: number = Date.now()): PinState & { triesLeft: number; locked: boolean } {
  const fresh = s.windowStart === null || now - s.windowStart >= PIN_WINDOW_MS;
  const failCount = fresh ? 1 : s.failCount + 1;
  const windowStart = fresh ? now : s.windowStart;
  if (failCount >= PIN_MAX_FAILS) return { failCount: 0, windowStart: null, lockedUntil: now + PIN_LOCK_MS, triesLeft: 0, locked: true };
  return { failCount, windowStart, lockedUntil: s.lockedUntil, triesLeft: PIN_MAX_FAILS - failCount, locked: false };
}

export type LinkStatus = "active" | "expired" | "revoked" | "locked";

export function linkStatus(l: { revokedAt: number | null; expiresAt: number; pinLockedUntil: number | null }, now: number = Date.now()): LinkStatus {
  if (l.revokedAt) return "revoked";
  if (l.expiresAt <= now) return "expired";
  if (l.pinLockedUntil && l.pinLockedUntil > now) return "locked";
  return "active";
}

// ---- Guest routes (section 5.1) -------------------------------------------------------------------

export type GuestRoute = { kind: "page"; slug: string } | { kind: "stream" } | { kind: "control" } | { kind: "file" };

/**
 * Which guest route this path is, or null for every route a guest may not use. Pages are the app's
 * viewer pages under /a/<slug>/ (its manifest, service worker and icons live there too).
 */
export function guestRouteOf(pathname: string): GuestRoute | null {
  const a = /^\/a\/([a-z0-9-]{1,40})(?:\/.*)?$/.exec(pathname);
  if (a) return { kind: "page", slug: a[1]! };
  if (pathname === "/api/data/stream" || /^\/api\/data\/widget\/[^/]+$/.test(pathname)) return { kind: "stream" };
  if (pathname === "/api/controls/run") return { kind: "control" };
  if (pathname.startsWith("/uploads/") || pathname === "/api/img") return { kind: "file" };
  return null;
}

/** A guest may never open a draft preview: any `draft` query parameter refuses the page. */
export function isDraftRequest(search: string): boolean {
  return new URLSearchParams(search).has("draft");
}
