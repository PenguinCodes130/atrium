import "server-only";
// Account links (architecture v3 Amendment 3, auth-spec-v3): the owner creates a one-time invite for a
// new person, or a reset for a member or viewer; the person opens `/invite/<token>` and sets their own
// password. The token is in one response only; the store keeps its SHA-256 hash. Every dead link
// (unknown, malformed, expired, used, revoked, or no longer fitting its person) gives one answer.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Principal } from "@/core/contracts";
import { db, transaction } from "@/core/db";
import { env } from "@/core/env";
import { AtriumError, Forbidden, NotFound, Unauthorized } from "@/core/errors";
import { logger } from "@/core/log";
import { audit } from "@/features/audit/write";
import { accountLinks, accounts, allowlistEntries, sessions, users } from "@/db/schema/auth";
import { getAuth } from "../server/auth";
import { hashPassword } from "../server/password-hash";
import { checkPassword, isValidEmail, normalizeEmail } from "../server/policy";
import { sessionFromHeaders } from "../server/session";
import { notifyAccessCut } from "../server/users";
import {
  ACCOUNT_LINK_PREFIX,
  LINK_MESSAGES,
  checkDays,
  expiryFor,
  linkStatus,
  looksLikeAccountLinkToken,
  type FieldProblem,
  type LinkKind,
  type LinkRole,
  type LinkStatus,
  type RevokeCause,
} from "./policy";
import { revokeAccountLinks, waitingLinks, type AccountLinkRow } from "./store";

const log = logger("auth.links");

export class LinkFieldError extends AtriumError {
  constructor(readonly problem: FieldProblem) {
    super(problem.message, 400, "invalid_input");
  }
}

export function hashAccountLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function publicBase(): string {
  return env().ATRIUM_PUBLIC_URL.replace(/\/+$/, "");
}

type OwnerPrincipal = Extract<Principal, { kind: "user" }>;

/** Only the owner, signed in with a session. Agents and guests are refused, members and viewers too. */
function requireOwner(principal: Principal | null): OwnerPrincipal {
  if (!principal || principal.kind === "guest") throw new Unauthorized();
  if (principal.kind !== "user") throw new AtriumError(LINK_MESSAGES.agents, 403, "agents_refused");
  if (principal.role !== "owner") throw new Forbidden(LINK_MESSAGES.notOwner(principal.role));
  return principal;
}

// ---- Views ---------------------------------------------------------------------------------------

export type AccountLinkView = {
  id: string;
  kind: LinkKind;
  email: string;
  role: LinkRole | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  revokedCause: RevokeCause | null;
  status: LinkStatus;
};

function view(r: AccountLinkRow, names: Map<string, string>, now: number): AccountLinkView {
  return {
    id: r.id,
    kind: r.kind,
    email: r.email,
    role: r.role ?? null,
    createdBy: names.get(r.createdBy) ?? "Unknown",
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    usedAt: r.usedAt ? r.usedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    revokedCause: (r.revokedCause as RevokeCause | null) ?? null,
    status: linkStatus({ usedAt: r.usedAt?.getTime() ?? null, revokedAt: r.revokedAt?.getTime() ?? null, expiresAt: r.expiresAt.getTime() }, now),
  };
}

function userNames(): Map<string, string> {
  return new Map(db().select({ id: users.id, email: users.email }).from(users).all().map((u) => [u.id, u.email]));
}

export type CreatedAccountLink = { link: AccountLinkView; url: string };

function insertLink(owner: OwnerPrincipal, input: { kind: LinkKind; email: string; role: LinkRole | null; userId: string | null; days: number }, now: number, ip?: string): CreatedAccountLink {
  const token = `${ACCOUNT_LINK_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row: AccountLinkRow = {
    id: randomUUID(),
    kind: input.kind,
    email: input.email,
    role: input.role,
    userId: input.userId,
    tokenHash: hashAccountLinkToken(token),
    createdBy: owner.userId,
    createdAt: new Date(now),
    expiresAt: expiryFor(input.days, now),
    usedAt: null,
    revokedAt: null,
    revokedCause: null,
  };
  db().insert(accountLinks).values(row).run();
  audit.write({
    actor: owner,
    ip,
    event: input.kind === "invite" ? "account.invite_created" : "account.reset_created",
    target: { type: "account_link", id: row.id, label: input.email },
    result: "ok",
    detail: { kind: input.kind, email: input.email, ...(input.role ? { role: input.role } : {}), expiresAt: row.expiresAt.toISOString() },
    at: new Date(now),
  });
  log.info("Account link created", { linkId: row.id, kind: input.kind });
  return { link: view(row, userNames(), now), url: `${publicBase()}/invite/${token}` };
}

// ---- Create, list, revoke ------------------------------------------------------------------------

/** Creates an invite for a person who has no account yet (adds their exact email to the allowlist). */
export function createInvite(principal: Principal | null, input: { email?: unknown; role?: unknown; days?: unknown }, opts: { now?: number; ip?: string } = {}): CreatedAccountLink {
  const owner = requireOwner(principal);
  const now = opts.now ?? Date.now();
  const raw = typeof input.email === "string" ? input.email.trim() : "";
  if (!raw) throw new LinkFieldError({ field: "email", message: LINK_MESSAGES.enterEmail });
  if (raw.includes("*") || !isValidEmail(raw)) throw new LinkFieldError({ field: "email", message: LINK_MESSAGES.exactEmail });
  if (input.role === "owner") throw new LinkFieldError({ field: "role", message: LINK_MESSAGES.ownerRole });
  if (input.role !== "member" && input.role !== "viewer") throw new LinkFieldError({ field: "role", message: LINK_MESSAGES.pickRole });
  const role: LinkRole = input.role;
  const days = checkDays(input.days);
  if (!days.ok) throw new LinkFieldError(days.problem);
  const email = normalizeEmail(raw);
  if (db().select({ id: users.id }).from(users).where(eq(users.email, email)).get()) {
    throw new LinkFieldError({ field: "email", message: LINK_MESSAGES.hasAccount(email) });
  }
  const entry = db().select().from(allowlistEntries).where(eq(allowlistEntries.pattern, email)).get();
  if (entry && entry.role !== role) throw new LinkFieldError({ field: "role", message: LINK_MESSAGES.roleDiffers(entry.role) });
  if (!entry) db().insert(allowlistEntries).values({ id: randomUUID(), pattern: email, role, createdAt: new Date(now) }).run();
  revokeAccountLinks(waitingLinks({ email, kind: "invite" }, new Date(now)), "replaced", owner, new Date(now));
  return insertLink(owner, { kind: "invite", email, role, userId: null, days: days.days }, now, opts.ip);
}

/** Creates a reset for a member or viewer. The owner's own reset stays on the server. */
export function createReset(principal: Principal | null, userId: unknown, input: { days?: unknown } = {}, opts: { now?: number; ip?: string } = {}): CreatedAccountLink {
  const owner = requireOwner(principal);
  const now = opts.now ?? Date.now();
  const u = typeof userId === "string" ? db().select().from(users).where(eq(users.id, userId)).get() : undefined;
  if (!u) throw new NotFound(LINK_MESSAGES.userMissing);
  if (u.role === "owner") throw new AtriumError(LINK_MESSAGES.ownerReset, 400, "owner_reset");
  const days = checkDays(input.days);
  if (!days.ok) throw new LinkFieldError(days.problem);
  revokeAccountLinks(waitingLinks({ userId: u.id, kind: "reset" }, new Date(now)), "replaced", owner, new Date(now));
  return insertLink(owner, { kind: "reset", email: u.email, role: null, userId: u.id, days: days.days }, now, opts.ip);
}

/** Every link, newest first, waiting ones on top. Never a token or hash. */
export function listAccountLinks(principal: Principal | null, now: number = Date.now()): AccountLinkView[] {
  requireOwner(principal);
  const names = userNames();
  const rows = db().select().from(accountLinks).orderBy(desc(accountLinks.createdAt)).all().map((r) => view(r, names, now));
  return rows.sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting"));
}

export function revokeAccountLink(principal: Principal | null, id: unknown, now: number = Date.now()): AccountLinkView {
  const owner = requireOwner(principal);
  const row = typeof id === "string" ? db().select().from(accountLinks).where(eq(accountLinks.id, id)).get() : undefined;
  if (!row) throw new NotFound(LINK_MESSAGES.linkMissing);
  revokeAccountLinks([row], "manual", owner, new Date(now));
  const after = db().select().from(accountLinks).where(eq(accountLinks.id, row.id)).get()!;
  return view(after, userNames(), now);
}

// ---- Opening a link ------------------------------------------------------------------------------

export type Inspected =
  | { kind: "signed_in" }
  | { kind: "dead" }
  | { kind: "invite"; email: string; role: LinkRole; expiresAt: string }
  | { kind: "reset"; email: string; expiresAt: string };

/** The live link for a token, or null. A link that no longer fits its person is revoked here. */
function liveLink(token: unknown, now: number): AccountLinkRow | null {
  if (!looksLikeAccountLinkToken(token)) return null;
  const row = db().select().from(accountLinks).where(eq(accountLinks.tokenHash, hashAccountLinkToken(token))).get();
  if (!row || row.usedAt || row.revokedAt || row.expiresAt.getTime() <= now) return null;
  if (row.kind === "invite") {
    if (!row.role) return null;
    if (db().select({ id: users.id }).from(users).where(eq(users.email, row.email)).get()) {
      revokeAccountLinks([row], "user_exists", null, new Date(now));
      return null;
    }
    return row;
  }
  const u = row.userId ? db().select({ email: users.email, role: users.role }).from(users).where(eq(users.id, row.userId)).get() : undefined;
  if (!u || u.role === "owner" || normalizeEmail(u.email) !== normalizeEmail(row.email)) {
    revokeAccountLinks([row], "user_removed", null, new Date(now));
    return null;
  }
  return row;
}

/** What `/invite/<token>` shows. A signed-in visitor is told so, whatever the token; nothing is consumed. */
export async function inspectAccountLink(token: unknown, headers: Headers, now: number = Date.now()): Promise<Inspected> {
  if (await sessionFromHeaders(headers)) return { kind: "signed_in" };
  const row = liveLink(token, now);
  if (!row) return { kind: "dead" };
  if (row.kind === "invite") return { kind: "invite", email: row.email, role: row.role!, expiresAt: row.expiresAt.toISOString() };
  return { kind: "reset", email: row.email, expiresAt: row.expiresAt.toISOString() };
}

export type UseResult =
  | { kind: "signed_in" }
  | { kind: "dead" }
  | { kind: "invalid"; problem: FieldProblem }
  | { kind: "invite_done"; setCookies: string[] }
  | { kind: "reset_done"; email: string };

/** Sets the person's password from a live link. Exactly one submit of a link can succeed. */
export async function redeemAccountLink(token: unknown, headers: Headers, input: { password?: unknown; confirm?: unknown }, opts: { now?: number; ip?: string } = {}): Promise<UseResult> {
  const now = opts.now ?? Date.now();
  if (await sessionFromHeaders(headers)) return { kind: "signed_in" };
  const first = liveLink(token, now);
  if (!first) return { kind: "dead" };
  const password = typeof input.password === "string" ? input.password : "";
  if (!password) return { kind: "invalid", problem: { field: "password", message: LINK_MESSAGES.enterPassword } };
  const weak = checkPassword(password);
  if (weak) return { kind: "invalid", problem: { field: "password", message: weak.message } };
  if (input.confirm !== password) return { kind: "invalid", problem: { field: "confirm", message: LINK_MESSAGES.passwordMismatch } };

  const hash = await hashPassword(password);
  const at = new Date(now);
  const tokenHash = first.tokenHash;

  if (first.kind === "invite") {
    let created: { id: string; role: LinkRole } | null;
    try {
      created = transaction((tx) => {
      // Re-checked inside the transaction: two submits of one link can never make two users.
      const claim = tx
        .update(accountLinks)
        .set({ usedAt: at })
        .where(and(eq(accountLinks.tokenHash, tokenHash), isNull(accountLinks.usedAt), isNull(accountLinks.revokedAt)))
        .run();
      if (claim.changes !== 1) return null;
      if (tx.select({ id: users.id }).from(users).where(eq(users.email, first.email)).get()) throw new LinkGone();
      const id = randomUUID();
      tx.insert(users)
        .values({ id, name: first.email.split("@")[0]!, email: first.email, emailVerified: true, role: first.role!, twoFactorEnabled: false, createdAt: at, updatedAt: at })
        .run();
      tx.insert(accounts).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: at, updatedAt: at }).run();
      tx.insert(allowlistEntries).values({ id: randomUUID(), pattern: first.email, role: first.role!, createdAt: at }).onConflictDoNothing().run();
      return { id, role: first.role! };
      });
    } catch (err) {
      if (!(err instanceof LinkGone)) throw err;
      created = null; // the email gained an account meanwhile: the claim rolled back, the link stays dead
    }
    if (!created) return { kind: "dead" };
    audit.write({
      actor: { kind: "user", userId: created.id, role: created.role, via: "session" },
      ip: opts.ip,
      event: "account.invite_used",
      target: { type: "user", id: created.id, label: first.email },
      result: "ok",
      detail: { linkId: first.id, role: created.role },
      at,
    });
    log.info("Invite used", { linkId: first.id, userId: created.id });
    // The new person is signed in through the normal path (session hooks, cookie attributes).
    const res = await getAuth().api.signInEmail({ body: { email: first.email, password, rememberMe: true }, headers: stripCookies(headers), returnHeaders: true });
    const setCookies = (res.headers as Headers).getSetCookie?.() ?? [];
    return { kind: "invite_done", setCookies };
  }

  const userId = first.userId!;
  const done = transaction((tx) => {
    const claim = tx
      .update(accountLinks)
      .set({ usedAt: at })
      .where(and(eq(accountLinks.tokenHash, tokenHash), isNull(accountLinks.usedAt), isNull(accountLinks.revokedAt)))
      .run();
    if (claim.changes !== 1) return false;
    const cred = tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential"))).get();
    if (cred) tx.update(accounts).set({ password: hash, updatedAt: at }).where(eq(accounts.id, cred.id)).run();
    else tx.insert(accounts).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: hash, createdAt: at, updatedAt: at }).run();
    // Every device that knew the old password, and every agent token issued before now, stops working.
    tx.delete(sessions).where(eq(sessions.userId, userId)).run();
    tx.update(users).set({ accessRevokedAt: at, updatedAt: at }).where(eq(users.id, userId)).run();
    return true;
  });
  if (!done) return { kind: "dead" };
  notifyAccessCut(userId, "password_reset");
  audit.write({
    actor: { kind: "user", userId, ip: opts.ip },
    event: "account.reset_used",
    target: { type: "user", id: userId, label: first.email },
    result: "ok",
    detail: { linkId: first.id },
    at,
  });
  log.info("Reset used", { linkId: first.id, userId });
  return { kind: "reset_done", email: first.email };
}

class LinkGone extends Error {}

/** The sign-in call must not carry the visitor's other cookies (a stale session, a guest cookie). */
function stripCookies(headers: Headers): Headers {
  const h = new Headers(headers);
  h.delete("cookie");
  h.delete("authorization");
  return h;
}
