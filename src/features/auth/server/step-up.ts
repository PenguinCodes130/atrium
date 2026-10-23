import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/core/db";
import { AtriumError, Forbidden } from "@/core/errors";
import { devSecret } from "@/core/env";
import { logger } from "@/core/log";
import { accounts, sessions } from "@/db/schema/auth";
import { getAuth, verifyPassword } from "./auth";
import { OIDC_PROVIDER_ID } from "./providers";
import { safeNext } from "../safe-next";
import { hit } from "./rate-limit";
import { requireUserFrom, stepUpMethodFor, type AtriumSession } from "./session";

// Step-up (architecture section 5): a TOTP code, the password, or a forced fresh provider sign-in.
// A completed step-up covers that session for 10 minutes (policy.STEP_UP_WINDOW_MS).

const log = logger("auth");
export const STEP_UP_COOKIE = "atrium.step_up";
const PROVIDER_WINDOW_MS = 5 * 60 * 1000;

export function markStepUp(sessionId: string, at: Date = new Date()): void {
  db().update(sessions).set({ stepUpAt: at }).where(eq(sessions.id, sessionId)).run();
}

const invalidCode = () => new AtriumError("That code is not right. Check your authenticator app and try again.", 400, "invalid_code");

export async function stepUpWithTotp(headers: Headers, code: string): Promise<AtriumSession> {
  const s = await requireUserFrom(headers);
  if (stepUpMethodFor(s.user.id) !== "totp") throw new Forbidden("This account has no authenticator app enrolled.");
  hit("totp", s.user.id); // 5 per 5 minutes, before the code is checked
  if (!/^\d{6}$/.test(code.trim())) throw invalidCode();
  try {
    await getAuth().api.verifyTOTP({ headers, body: { code: code.trim() } });
  } catch {
    throw invalidCode();
  }
  markStepUp(s.session.id);
  log.info("Step-up completed", { userId: s.user.id, method: "totp" });
  return s;
}

export async function stepUpWithPassword(headers: Headers, password: string): Promise<AtriumSession> {
  const s = await requireUserFrom(headers);
  if (stepUpMethodFor(s.user.id) !== "password") throw new Forbidden("Use your authenticator app or your sign-in provider to confirm.");
  hit("signInAccount", s.user.email);
  const acct = db()
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, s.user.id), eq(accounts.providerId, "credential")))
    .get();
  if (!acct?.password || !(await verifyPassword(acct.password, password))) {
    throw new AtriumError("That password is not right. Try again.", 400, "invalid_password");
  }
  markStepUp(s.session.id);
  log.info("Step-up completed", { userId: s.user.id, method: "password" });
  return s;
}

// ---- Provider step-up -----------------------------------------------------------------------------

function sign(payload: string): string {
  return createHmac("sha256", devSecret("BETTER_AUTH_SECRET")).update(`step-up:${payload}`).digest("base64url");
}

function encodeTicket(t: { sid: string; uid: string; exp: number; next: string; n: string }): string {
  const body = Buffer.from(JSON.stringify(t)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decodeTicket(raw: string | undefined): { sid: string; uid: string; exp: number; next: string } | null {
  if (!raw) return null;
  const [body, mac] = raw.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof t.sid === "string" && typeof t.uid === "string" && typeof t.exp === "number" ? t : null;
  } catch {
    return null;
  }
}

// The one redirect check (auth gauntlet r3, fix 1), shared with the client forms.
export { safeNext };

/** Starts a forced fresh provider sign-in. Returns the provider URL and the cookies to set. */
export async function startProviderStepUp(headers: Headers, next: string): Promise<{ url: string; setCookies: string[] }> {
  const s = await requireUserFrom(headers);
  const providerId = db()
    .select({ providerId: accounts.providerId })
    .from(accounts)
    .where(and(eq(accounts.userId, s.user.id), ne(accounts.providerId, "credential")))
    .get()?.providerId;
  if (!providerId) throw new Forbidden("This account has no sign-in provider.");
  const callbackURL = "/api/auth/atrium/step-up/finish";
  const errorCallbackURL = `/step-up?error=cancelled&next=${encodeURIComponent(safeNext(next))}`;
  const auth = getAuth();
  // Google and generic OIDC providers both go through Better Auth's social sign-in endpoint.
  const result = await auth.api.signInSocial({
    headers,
    body: { provider: providerId as "google", callbackURL, errorCallbackURL, disableRedirect: true },
    returnHeaders: true,
  });
  const url = new URL((result.response as { url: string }).url);
  // Force a fresh login at the provider (OIDC max_age=0 and prompt=login).
  url.searchParams.set("max_age", "0");
  url.searchParams.set("prompt", providerId === OIDC_PROVIDER_ID ? "login" : "select_account");
  const ticket = encodeTicket({ sid: s.session.id, uid: s.user.id, exp: Date.now() + PROVIDER_WINDOW_MS, next: safeNext(next), n: randomBytes(8).toString("hex") });
  const secure = new URL(auth.options.baseURL as string).protocol === "https:";
  const setCookies = [
    ...((result.headers as Headers).getSetCookie?.() ?? []),
    `${STEP_UP_COOKIE}=${ticket}; Path=/api/auth/atrium/step-up; HttpOnly; SameSite=Lax; Max-Age=${PROVIDER_WINDOW_MS / 1000}${secure ? "; Secure" : ""}`,
  ];
  return { url: url.toString(), setCookies };
}

/** Called when the provider returns: the new session gets the step-up and replaces the old one. */
export async function finishProviderStepUp(headers: Headers, ticketRaw: string | undefined): Promise<string> {
  const t = decodeTicket(ticketRaw);
  const s = await requireUserFrom(headers);
  if (!t || t.exp < Date.now() || t.uid !== s.user.id || Date.now() - s.session.createdAt.getTime() > PROVIDER_WINDOW_MS) {
    throw new Forbidden("The confirmation did not complete. Try again.");
  }
  markStepUp(s.session.id);
  if (t.sid !== s.session.id) db().delete(sessions).where(and(eq(sessions.id, t.sid), eq(sessions.userId, s.user.id))).run();
  log.info("Step-up completed", { userId: s.user.id, method: "provider" });
  return safeNext(t.next);
}
