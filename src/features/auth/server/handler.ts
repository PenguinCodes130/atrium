import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/core/db";
import { env } from "@/core/env";
import { AtriumError, errorResponse } from "@/core/errors";
import { logger } from "@/core/log";
import { accounts, users, verifications } from "@/db/schema/auth";
import { configuredProviders } from "./providers";
import { getAuth, SESSION_COOKIE } from "./auth";
import { lookupAllowlist } from "./allowlist";
import { ensureBootstrapped } from "./bootstrap";
import { checkPassword, normalizeEmail } from "./policy";
import { clientAddress, hit, hitSignInAddress } from "./rate-limit";
import { oauthGuard } from "./oauth-guard";
import { sessionFromHeaders } from "./session";

// The front of /api/auth/*: Atrium's own checks run here, before Better Auth sees the request.
// Rate limits are counted first, so a limited request is never evaluated (no password or code check).

const log = logger("auth");
const BASE = "/api/auth";
const TWO_FACTOR_COOKIE = "atrium.two_factor";

const SIGN_IN_PATHS = new Set(["/sign-in/email"]);
const TOTP_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]);
const NEW_PASSWORD_PATHS = new Set(["/change-password"]);
// Every other Better Auth endpoint that checks the signed-in user's password (auth gauntlet r1,
// fix 3). Each counts against the same per-account limit as sign-in before the password is read.
export const PASSWORD_CHECK_PATHS = new Set([
  "/verify-password",
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
]);

function cookie(headers: Headers, name: string): string | undefined {
  const raw = headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// The user waiting on a two-factor challenge, from Better Auth's signed challenge cookie.
function challengeUser(headers: Headers): string | undefined {
  const v = cookie(headers, TWO_FACTOR_COOKIE);
  if (!v) return undefined;
  const identifier = v.slice(0, v.lastIndexOf(".") > 0 ? v.lastIndexOf(".") : undefined);
  return db().select({ value: verifications.value }).from(verifications).where(eq(verifications.identifier, identifier)).get()?.value;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.clone().json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function withBody(req: Request, body: unknown): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return new Request(req.url, { method: req.method, headers, body: JSON.stringify(body) });
}

async function guard(req: Request, path: string): Promise<Request> {
  const setup = await ensureBootstrapped();
  if (setup.state !== "ready") throw new AtriumError(setup.message, 401, "setup_required");

  await oauthGuard(req, path);
  if (req.method !== "POST") return req;
  const ip = clientAddress(req.headers, env().ATRIUM_TRUSTED_PROXIES);

  if (SIGN_IN_PATHS.has(path)) {
    hitSignInAddress(ip);
    const body = await readJson(req);
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    // An empty email is a form mistake, not a refusal: say so instead of blaming the allowlist.
    if (!email) throw new AtriumError("Enter your email.", 400, "missing_email");
    hit("signInAccount", email);
    if (!lookupAllowlist(email)) {
      log.info("Sign-in refused: not on the allowlist");
      throw new AtriumError("This email is not on the allowlist. Ask the owner of this Atrium to add it.", 403, "not_allowlisted");
    }
    // Allowed but no password (auth gauntlet r3, usability): say how this person gets in instead of
    // "do not match". Counted against the same limits above, so it is no faster way to probe.
    const noPassword = noPasswordMessage(email);
    if (noPassword) throw new AtriumError(noPassword, 400, "no_password");
    return req;
  }

  if (TOTP_PATHS.has(path)) {
    const subject = challengeUser(req.headers) ?? (cookie(req.headers, SESSION_COOKIE) ? `session:${cookie(req.headers, SESSION_COOKIE)!.split(".")[0]}` : `ip:${ip ?? "unknown-peer"}`);
    hit("totp", subject);
    return req;
  }

  if (path === "/oauth2/register") {
    hit("oauthRegister", ip ?? "unknown-peer");
    return req;
  }

  if (PASSWORD_CHECK_PATHS.has(path)) {
    // Signed-in only: without a session Better Auth answers 401 before reading any password.
    const s = await sessionFromHeaders(req.headers);
    if (s) hit("signInAccount", s.user.email);
  }

  if (NEW_PASSWORD_PATHS.has(path)) {
    const body = await readJson(req);
    const problem = typeof body.newPassword === "string" ? checkPassword(body.newPassword) : { message: "Enter a new password." };
    if (problem) throw new AtriumError(problem.message, 400, "weak_password");
    // A password change always ends every earlier session of the user (architecture section 5).
    return withBody(req, { ...body, revokeOtherSessions: true });
  }
  return req;
}

/** The message for an allowlisted email that has no password yet, or null when it has one. */
export function noPasswordMessage(email: string): string | null {
  const u = db().select({ id: users.id, role: users.role }).from(users).where(eq(users.email, email)).get();
  if (u && db().select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, u.id), eq(accounts.providerId, "credential"))).get()) return null;
  const names = configuredProviders().map((p) => p.name);
  const alt = names.length ? ` Or use Continue with ${names.join(" or ")}.` : "";
  if (u?.role === "owner") return `This account has no password. Set one on the server with pnpm atrium:reset-owner.${alt}`;
  return `This email has no password yet. Ask the owner of this Atrium for an invite link.${alt}`;
}

/**
 * What a browser must forget when its session ends (app-builder gauntlet w2-r2 item 1, security): the
 * per-app offline caches and service workers and the last values pages saved, so the next person on a
 * shared device never sees the previous person's pages offline. Browsers honour it on secure origins
 * (HTTPS, and localhost); app-shell's sign-out also clears the same stores in the page first.
 */
export const SIGN_OUT_CLEAR_SITE_DATA = '"cache", "storage"';

/** Adds Clear-Site-Data to a successful sign-out response, keeping its status, cookies and body. */
export function withSignOutClear(path: string, res: Response): Response {
  if (path !== "/sign-out" || !res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set("Clear-Site-Data", SIGN_OUT_CLEAR_SITE_DATA);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Route handler for /api/auth/[...all]. */
export async function handleAuthRequest(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice(BASE.length) || "/";
  try {
    const checked = await guard(req, path);
    return withSignOutClear(path, await getAuth().handler(checked));
  } catch (err) {
    if (!(err instanceof AtriumError)) log.error("Auth request failed", { path });
    return errorResponse(err);
  }
}
