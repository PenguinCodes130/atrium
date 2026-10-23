import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { desc, eq, lt } from "drizzle-orm";
import type { App, Principal } from "@/core/contracts";
import { db, transaction } from "@/core/db";
import { env } from "@/core/env";
import { AtriumError, Forbidden, NotFound, Unauthorized } from "@/core/errors";
import { appAccess } from "@/core/hooks";
import { logger } from "@/core/log";
import { audit } from "@/features/audit/write";
import { users } from "@/db/schema/auth";
import { guestLinks, guestSessions } from "@/db/schema/guests";
import { hashPassword, verifyPassword } from "../server/password-hash";
import { isAccountPrincipal, type AccountPrincipal } from "../server/policy";
import { sessionFromHeaders } from "../server/session";
import {
  CREATOR_CAUSES,
  GUEST_COOKIE,
  GUEST_SESSION_PATTERN,
  GUEST_SESSION_PREFIX,
  GUEST_TOKEN_PATTERN,
  GUEST_TOKEN_PREFIX,
  MESSAGES,
  afterWrongPin,
  checkCreateInput,
  guestSessionExpiry,
  linkStatus,
  pinLockMinutes,
  type CreateInput,
  type FieldProblem,
  type LinkStatus,
  type RevokeCause,
} from "./policy";
import { revokeAppGuestLinks, revokeCreatorGuestLinks, revokeLinks, type GuestLinkRow } from "./store";

// Guest links (architecture v3 section 5.1, amendments A1.1 to A1.3, auth-spec-v2). Creating, listing
// and revoking links; opening a link (with its PIN); and resolving the guest cookie into the guest
// principal. Before app-builder registers the app access hook every lookup answers "not available".

const log = logger("auth.guest");
const TOUCH_EVERY_MS = 60_000;

export type GuestPrincipal = Extract<Principal, { kind: "guest" }>;

export class GuestFieldError extends AtriumError {
  constructor(readonly problem: FieldProblem) {
    super(problem.message, 400, "invalid_input");
  }
}

export function hashGuestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function publicBase(): string {
  return env().ATRIUM_PUBLIC_URL.replace(/\/+$/, "");
}

function guestPrincipalOf(row: GuestLinkRow): GuestPrincipal {
  return { kind: "guest", guestLinkId: row.id, appId: row.appId, label: row.label, via: "guest-link" };
}

/** Who may create, list and revoke: a session user (never an agent and never a guest). */
function requireSessionUser(principal: Principal | null, agentMessage: string): Extract<Principal, { kind: "user" }> {
  if (!principal || principal.kind === "guest") throw new Unauthorized();
  if (principal.kind !== "user") throw new AtriumError(agentMessage, 403, "agents_refused");
  return principal;
}

function resolver() {
  const r = appAccess();
  if (!r) throw new AtriumError(MESSAGES.notAvailable, 403, "not_available");
  return r;
}

async function canManage(p: Extract<Principal, { kind: "user" }>, appId: string): Promise<boolean> {
  if (p.role === "owner") return true;
  if (p.role === "viewer") return false;
  return resolver().canEditApp(p, appId);
}

// ---- Views ---------------------------------------------------------------------------------------

export type GuestLinkView = {
  id: string;
  appId: string;
  label: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedCause: RevokeCause | null;
  status: LinkStatus;
  requiresCode: boolean;
  canRevoke: boolean;
};

function view(r: GuestLinkRow, canRevoke: boolean, now: number): GuestLinkView {
  return {
    id: r.id,
    appId: r.appId,
    label: r.label,
    createdBy: { id: r.createdBy, name: r.createdByName },
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    revokedCause: (r.revokedCause as RevokeCause | null) ?? null,
    status: linkStatus({ revokedAt: r.revokedAt?.getTime() ?? null, expiresAt: r.expiresAt.getTime(), pinLockedUntil: r.pinLockedUntil?.getTime() ?? null }, now),
    requiresCode: !!r.pinHash,
    canRevoke: canRevoke && !r.revokedAt && r.expiresAt.getTime() > now,
  };
}

// ---- Create, list, revoke --------------------------------------------------------------------------

export type CreatedGuestLink = { link: GuestLinkView; url: string };

/** Creates a link. The URL is in this one response only; the store keeps hashes. */
export async function createGuestLink(
  principal: Principal | null,
  input: CreateInput & { appId?: unknown },
  opts: { now?: number; ip?: string } = {},
): Promise<CreatedGuestLink> {
  const p = requireSessionUser(principal, MESSAGES.agents);
  const r = resolver();
  const appId = typeof input.appId === "string" ? input.appId : "";
  const app = appId ? await r.appById(appId) : null;
  if (!app) throw new NotFound(MESSAGES.appMissing);
  if (!app.access.guests) throw new AtriumError(MESSAGES.guestsOff, 403, "guests_off");
  if (!(await canManage(p, app.id))) throw new Forbidden(MESSAGES.notEditor);
  const now = opts.now ?? Date.now();
  const checked = checkCreateInput(input, now);
  if (!checked.ok) throw new GuestFieldError(checked.problem);
  const { label, expiresAt, pin } = checked.value;

  const token = newToken(GUEST_TOKEN_PREFIX);
  const pinHash = pin ? await hashPassword(pin) : null;
  const creator = db().select({ name: users.name, email: users.email }).from(users).where(eq(users.id, p.userId)).get();
  const row: GuestLinkRow = {
    id: randomUUID(),
    appId: app.id,
    label,
    tokenHash: hashGuestToken(token),
    pinHash,
    createdBy: p.userId,
    createdByName: creator?.name || creator?.email || "Unknown",
    createdAt: new Date(now),
    expiresAt,
    revokedAt: null,
    revokedCause: null,
    revokedBy: null,
    lastUsedAt: null,
    pinFailCount: 0,
    pinFailWindowStart: null,
    pinLockedUntil: null,
  };
  db().insert(guestLinks).values(row).run();
  audit.write({
    actor: p,
    ip: opts.ip,
    event: "guest_link.created",
    target: { type: "guest_link", id: row.id, label },
    result: "ok",
    detail: { appId: app.id, label, expiresAt: expiresAt.toISOString(), requiresCode: !!pinHash },
    at: new Date(now),
  });
  log.info("Guest link created", { linkId: row.id, appId: app.id });
  return { link: view(row, true, now), url: `${publicBase()}/g/${token}` };
}

export type GuestLinkList = { guestsOn: boolean; canCreate: boolean; links: GuestLinkView[] };

/** Every link of the app, for the owner and the app's editors. Never a token, hash or PIN. */
export async function listGuestLinks(principal: Principal | null, appId: string, now: number = Date.now()): Promise<GuestLinkList> {
  const p = requireSessionUser(principal, MESSAGES.agents);
  const r = resolver();
  const app = await r.appById(appId);
  if (!app) throw new NotFound(MESSAGES.appMissing);
  if (!(await canManage(p, app.id))) throw new Forbidden(MESSAGES.notEditor);
  const rows = db().select().from(guestLinks).where(eq(guestLinks.appId, app.id)).orderBy(desc(guestLinks.createdAt)).all();
  const creatorFirst = (x: GuestLinkRow) => (p.role === "owner" && x.revokedCause && CREATOR_CAUSES.has(x.revokedCause as RevokeCause) ? 0 : 1);
  rows.sort((a, b) => creatorFirst(a) - creatorFirst(b));
  return { guestsOn: app.access.guests, canCreate: app.access.guests, links: rows.map((x) => view(x, true, now)) };
}

/** Revokes one link by hand: its creator, anyone who may edit the app, or the owner (amendment A1.1). */
export async function revokeGuestLink(principal: Principal | null, linkId: string, now: number = Date.now()): Promise<GuestLinkView> {
  const p = requireSessionUser(principal, "Agents cannot change guest links");
  const row = db().select().from(guestLinks).where(eq(guestLinks.id, linkId)).get();
  if (!row) throw new NotFound(MESSAGES.linkMissing);
  const allowed = p.role === "owner" || (p.role !== "viewer" && row.createdBy === p.userId) || (p.role !== "viewer" && appAccess() ? await resolver().canEditApp(p, row.appId) : false);
  if (!allowed) throw new Forbidden(MESSAGES.notRevoker);
  revokeLinks([row], "manual", p, new Date(now));
  const after = db().select().from(guestLinks).where(eq(guestLinks.id, linkId)).get()!;
  return view(after, true, now);
}

export { revokeAppGuestLinks, revokeCreatorGuestLinks };

// ---- Is the link still good? ------------------------------------------------------------------------

export type LiveLink = { row: GuestLinkRow; app: App; principal: GuestPrincipal };

/**
 * The link with its app, when every check passes: not revoked, not expired, the hook registered, the app
 * there with guests on, the creator still allowed to make links there, and canOpenApp says yes. A failed
 * app or creator check revokes the link (so turning guests back on never revives it, amendment A1.1).
 */
async function liveLink(row: GuestLinkRow, now: number): Promise<LiveLink | null> {
  if (row.revokedAt || row.expiresAt.getTime() <= now) return null;
  const r = appAccess();
  if (!r) return null;
  const app = await r.appById(row.appId);
  if (!app) {
    revokeAppGuestLinks(row.appId, "app_deleted", null, new Date(now));
    return null;
  }
  if (!app.access.guests) {
    revokeAppGuestLinks(row.appId, "guests_off", null, new Date(now));
    return null;
  }
  const creator = db().select({ id: users.id, role: users.role }).from(users).where(eq(users.id, row.createdBy)).get();
  if (!creator) {
    revokeCreatorGuestLinks(row.createdBy, "creator_removed", null, undefined, new Date(now));
    return null;
  }
  if (creator.role === "viewer") {
    revokeCreatorGuestLinks(row.createdBy, "creator_demoted", null, undefined, new Date(now));
    return null;
  }
  if (creator.role !== "owner" && !(await r.canEditApp({ kind: "user", userId: creator.id, role: creator.role, via: "session" }, app.id))) {
    revokeCreatorGuestLinks(row.createdBy, "creator_lost_edit", null, app.id, new Date(now));
    return null;
  }
  const principal = guestPrincipalOf(row);
  if (!(await r.canOpenApp(principal, app.id))) return null;
  return { row, app, principal };
}

async function liveLinkByToken(token: unknown, now: number): Promise<LiveLink | null> {
  if (typeof token !== "string" || !GUEST_TOKEN_PATTERN.test(token)) return null;
  const row = db().select().from(guestLinks).where(eq(guestLinks.tokenHash, hashGuestToken(token))).get();
  return row ? liveLink(row, now) : null;
}

// ---- Opening a link -----------------------------------------------------------------------------------

export type GuestCookie = { name: typeof GUEST_COOKIE; value: string; expires: Date; secure: boolean };

export type OpenResult =
  | { kind: "expired" }
  | { kind: "user"; slug: string }
  | { kind: "pin"; minutesLocked: number }
  | { kind: "wrong_pin"; triesLeft: number }
  | { kind: "locked"; minutes: number }
  | { kind: "guest"; slug: string; cookie: GuestCookie };

function startGuestSession(live: LiveLink, now: number, ip?: string): GuestCookie {
  const value = newToken(GUEST_SESSION_PREFIX);
  const expiresAt = guestSessionExpiry(now, live.row.expiresAt.getTime());
  transaction((tx) => {
    tx.insert(guestSessions)
      .values({ id: randomUUID(), tokenHash: hashGuestToken(value), linkId: live.row.id, createdAt: new Date(now), lastUsedAt: new Date(now), expiresAt: new Date(expiresAt) })
      .run();
    tx.update(guestLinks).set({ lastUsedAt: new Date(now) }).where(eq(guestLinks.id, live.row.id)).run();
  });
  audit.write({
    actor: live.principal,
    ip,
    event: "guest.opened",
    target: { type: "app", id: live.app.id, label: live.app.name },
    result: "ok",
    detail: { label: live.row.label },
    at: new Date(now),
  });
  log.info("Guest session started", { linkId: live.row.id, appId: live.app.id });
  // The cookie lives as long as the link; the server ends the session after 7 days without use.
  return { name: GUEST_COOKIE, value, expires: live.row.expiresAt, secure: new URL(env().ATRIUM_PUBLIC_URL).protocol === "https:" };
}

/** GET /g/<token>. A signed-in user is sent on as themself; no guest session starts for them. */
export async function openGuestLink(token: unknown, headers: Headers, opts: { now?: number; ip?: string } = {}): Promise<OpenResult> {
  const now = opts.now ?? Date.now();
  const live = await liveLinkByToken(token, now);
  if (!live) return { kind: "expired" };
  if (await sessionFromHeaders(headers)) return { kind: "user", slug: live.app.slug };
  if (live.row.pinHash) return { kind: "pin", minutesLocked: pinLockMinutes(pinState(live.row), now) };
  return { kind: "guest", slug: live.app.slug, cookie: startGuestSession(live, now, opts.ip) };
}

/** For the PIN page: what opening the link would do, without starting a guest session. */
export async function inspectGuestLink(
  token: unknown,
  headers: Headers,
  now: number = Date.now(),
): Promise<{ kind: "expired" } | { kind: "user"; slug: string } | { kind: "pin"; minutesLocked: number } | { kind: "no_pin" }> {
  const live = await liveLinkByToken(token, now);
  if (!live) return { kind: "expired" };
  if (await sessionFromHeaders(headers)) return { kind: "user", slug: live.app.slug };
  if (!live.row.pinHash) return { kind: "no_pin" };
  return { kind: "pin", minutesLocked: pinLockMinutes(pinState(live.row), now) };
}

function pinState(r: GuestLinkRow) {
  return { failCount: r.pinFailCount, windowStart: r.pinFailWindowStart?.getTime() ?? null, lockedUntil: r.pinLockedUntil?.getTime() ?? null };
}

// PIN checks on one link run one at a time, so parallel tries cannot slip past the lock.
const pinQueues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pinQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  pinQueues.set(
    key,
    next.catch(() => undefined).finally(() => {
      if (pinQueues.get(key) === next) pinQueues.delete(key);
    }),
  );
  return next;
}

/** The PIN step. Locked links refuse every PIN without checking it, the correct one too. */
export async function submitGuestPin(token: unknown, pin: unknown, headers: Headers, opts: { now?: number; ip?: string } = {}): Promise<OpenResult> {
  const first = await liveLinkByToken(token, opts.now ?? Date.now());
  if (!first) return { kind: "expired" };
  if (await sessionFromHeaders(headers)) return { kind: "user", slug: first.app.slug };
  return serial(first.row.id, async () => {
    const now = opts.now ?? Date.now();
    const live = await liveLinkByToken(token, now);
    if (!live) return { kind: "expired" } as const;
    if (!live.row.pinHash) return { kind: "guest", slug: live.app.slug, cookie: startGuestSession(live, now, opts.ip) } as const;
    const minutes = pinLockMinutes(pinState(live.row), now);
    if (minutes > 0) return { kind: "locked", minutes } as const;
    const ok = typeof pin === "string" && pin.length <= 16 && (await verifyPassword(live.row.pinHash, pin));
    if (ok) return { kind: "guest", slug: live.app.slug, cookie: startGuestSession(live, now, opts.ip) } as const;
    const fresh = db().select().from(guestLinks).where(eq(guestLinks.id, live.row.id)).get() ?? live.row;
    const next = afterWrongPin(pinState(fresh), now);
    db()
      .update(guestLinks)
      .set({
        pinFailCount: next.failCount,
        pinFailWindowStart: next.windowStart === null ? null : new Date(next.windowStart),
        pinLockedUntil: next.lockedUntil === null ? null : new Date(next.lockedUntil),
      })
      .where(eq(guestLinks.id, live.row.id))
      .run();
    audit.write({
      actor: { kind: "guest", guestLinkId: live.row.id, guestLabel: live.row.label, ip: opts.ip },
      event: "guest.pin_failed",
      target: { type: "guest_link", id: live.row.id, label: live.row.label },
      result: "error",
      detail: { triesLeft: next.triesLeft, lockedNow: next.locked },
      at: new Date(now),
    });
    log.warn("Wrong guest PIN", { linkId: live.row.id, triesLeft: next.triesLeft });
    return next.locked ? ({ kind: "locked", minutes: pinLockMinutes(next, now) } as const) : ({ kind: "wrong_pin", triesLeft: next.triesLeft } as const);
  });
}

// ---- The guest cookie on later requests ----------------------------------------------------------------

/** The value of one cookie on these headers, or null. */
export function cookieValue(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function hasGuestCookie(headers: Headers): boolean {
  return cookieValue(headers, GUEST_COOKIE) !== null;
}

export type GuestViewer = { principal: GuestPrincipal; app: App; sessionId: string };

/**
 * The guest behind the `atrium.guest` cookie when the guest session, its link and the app all still pass,
 * else null. Each use extends the session (7 days, never past the link's expiry).
 */
export async function guestFromHeaders(headers: Headers, now: number = Date.now()): Promise<GuestViewer | null> {
  const value = cookieValue(headers, GUEST_COOKIE);
  if (!value || !GUEST_SESSION_PATTERN.test(value)) return null;
  const s = db().select().from(guestSessions).where(eq(guestSessions.tokenHash, hashGuestToken(value))).get();
  if (!s) return null;
  if (s.expiresAt.getTime() <= now) {
    db().delete(guestSessions).where(eq(guestSessions.id, s.id)).run();
    return null;
  }
  const row = db().select().from(guestLinks).where(eq(guestLinks.id, s.linkId)).get();
  if (!row) return null;
  const live = await liveLink(row, now);
  if (!live) return null;
  if (now - s.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
    transaction((tx) => {
      tx.update(guestSessions)
        .set({ lastUsedAt: new Date(now), expiresAt: new Date(guestSessionExpiry(now, row.expiresAt.getTime())) })
        .where(eq(guestSessions.id, s.id))
        .run();
      tx.update(guestLinks).set({ lastUsedAt: new Date(now) }).where(eq(guestLinks.id, row.id)).run();
    });
  }
  return { principal: live.principal, app: live.app, sessionId: s.id };
}

/** Removes guest sessions that ended (housekeeping; validity never depends on it). */
export function pruneGuestSessions(now: number = Date.now()): number {
  return db().delete(guestSessions).where(lt(guestSessions.expiresAt, new Date(now))).run().changes;
}

// ---- requireViewer() ---------------------------------------------------------------------------------

export type Viewer = Extract<Principal, { kind: "user" }> | GuestPrincipal;

/**
 * Session or guest (architecture v3 5.1). A valid session always wins over a guest cookie. Otherwise the
 * guest principal, only while its session, link and app all pass; with `appId`, only for that app.
 * Agents and bearer tokens never pass. Anything else is signed out (401).
 */
export async function requireViewerFrom(headers: Headers, opts: { appId?: string; now?: number } = {}): Promise<Viewer> {
  const s = await sessionFromHeaders(headers);
  if (s) return s.principal;
  const g = await guestFromHeaders(headers, opts.now);
  if (!g) throw new Unauthorized();
  if (opts.appId !== undefined && g.principal.appId !== opts.appId) throw new Unauthorized();
  return g.principal;
}

export function isGuest(p: Principal): p is GuestPrincipal {
  return !isAccountPrincipal(p);
}

export type { AccountPrincipal };
