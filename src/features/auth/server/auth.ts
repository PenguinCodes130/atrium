import "server-only";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db } from "@/core/db";
import { devSecret, env } from "@/core/env";
import { logger } from "@/core/log";
import {
  users,
  sessions,
  accounts,
  verifications,
  twoFactors,
  oauthClients,
  oauthResources,
  oauthClientResources,
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthConsents,
  oauthClientAssertions,
} from "@/db/schema/auth";
import { PASSWORD_MAX, PASSWORD_MIN } from "./policy";
import { lookupAllowlist } from "./allowlist";
import { providerConfig } from "./providers";
import { oauthPlugin } from "./oauth";
import { hashPassword, verifyPassword } from "./password-hash";

// Better Auth (architecture sections 1 and 5): email and password with argon2id, TOTP with backup
// codes, Google and generic OIDC, database sessions in SQLite through Drizzle. Built lazily on first
// use so `next build` never needs the runtime secret.

const log = logger("auth");

export { hashPassword, verifyPassword };

export const SESSION_COOKIE = "atrium.session";
export const SESSION_DAYS = 30;

export const AUTH_ERRORS = {
  NOT_ALLOWLISTED: "not_allowlisted",
  EMAIL_NOT_VERIFIED: "email_not_verified",
} as const;

function build() {
  const e = env();
  const publicUrl = new URL(e.ATRIUM_PUBLIC_URL);
  const https = publicUrl.protocol === "https:";
  const providers = providerConfig();

  return betterAuth({
    appName: "Atrium",
    baseURL: publicUrl.origin,
    basePath: "/api/auth",
    secret: devSecret("BETTER_AUTH_SECRET"),
    trustedOrigins: [publicUrl.origin],
    telemetry: { enabled: false },
    database: drizzleAdapter(db(), {
      provider: "sqlite",
      // better-sqlite3 transactions are synchronous, so Better Auth's async ones are turned off.
      transaction: false,
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
        oauthClient: oauthClients,
        oauthResource: oauthResources,
        oauthClientResource: oauthClientResources,
        oauthRefreshToken: oauthRefreshTokens,
        oauthAccessToken: oauthAccessTokens,
        oauthConsent: oauthConsents,
        oauthClientAssertion: oauthClientAssertions,
      },
    }),
    user: {
      additionalFields: {
        role: { type: "string", required: false, input: false, defaultValue: "viewer" },
      },
      // Runs for every OAuth or OIDC sign-in, link and first sign-in: verified and allowlisted only.
      validateUserInfo: async ({ user, source }) => {
        if (source.method === "email-password") return;
        if (user.emailVerified !== true) return { error: AUTH_ERRORS.EMAIL_NOT_VERIFIED, errorDescription: "Your provider has not verified this email address." };
        if (!user.email || !lookupAllowlist(String(user.email))) return { error: AUTH_ERRORS.NOT_ALLOWLISTED, errorDescription: "This email is not on the allowlist." };
      },
    },
    session: {
      expiresIn: SESSION_DAYS * 24 * 60 * 60,
      updateAge: 60 * 60, // rolling: any use more than an hour after the last refresh extends it to 30 days
      freshAge: 0,
      additionalFields: {
        stepUpAt: { type: "date", required: false, input: false },
      },
    },
    account: {
      accountLinking: { enabled: true, trustedProviders: [], allowDifferentEmails: false },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    socialProviders: providers.google ? { google: { ...providers.google, prompt: "select_account" } } : {},
    plugins: [
      twoFactor({
        issuer: "Atrium",
        backupCodeOptions: { amount: 10, length: 10 },
        allowPasswordless: true,
      }),
      genericOAuth({ config: providers.oidc ? [providers.oidc] : [] }),
      // MCP OAuth (architecture section 9b): authorization code + PKCE, dynamic client registration,
      // Atrium's consent screen at /consent. Atrium's own checks run first (oauth-guard.ts).
      oauthPlugin(),
    ],
    // Atrium's own SQLite limiter runs in front of Better Auth (see handler.ts), with the exact limits.
    rateLimit: { enabled: false },
    // Sign-up never exists. list-sessions is off because it returns session tokens to the browser;
    // Atrium lists sessions without tokens (manage.ts).
    disabledPaths: ["/sign-up/email", "/link-social", "/request-password-reset", "/reset-password", "/delete-user", "/change-email", "/update-user", "/list-sessions", "/revoke-session"],
    onAPIError: { errorURL: "/sign-in" },
    advanced: {
      useSecureCookies: false, // keeps the name exactly "atrium.session"; Secure is set below over HTTPS
      cookiePrefix: "atrium",
      cookies: { session_token: { name: SESSION_COOKIE, attributes: { secure: https, httpOnly: true, sameSite: "lax" } } },
      defaultCookieAttributes: { secure: https, httpOnly: true, sameSite: "lax" },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    logger: {
      level: "warn",
      // Better Auth's messages can carry request details: log only the message text, never extra arguments.
      log: (level, message) => (level === "error" ? log.error(message) : log.warn(message)),
    },
    databaseHooks: {
      user: {
        create: {
          // Only OAuth or OIDC reaches here (sign-up is disabled; the owner is created by bootstrap).
          before: async (user) => {
            const match = lookupAllowlist(user.email);
            if (!match) throw new APIError("FORBIDDEN", { message: "This email is not on the allowlist.", code: AUTH_ERRORS.NOT_ALLOWLISTED });
            if (!user.emailVerified) throw new APIError("FORBIDDEN", { message: "Your provider has not verified this email address.", code: AUTH_ERRORS.EMAIL_NOT_VERIFIED });
            // A pattern's role applies at first sign-in only. Ownership is never granted this way.
            return { data: { ...user, role: match.role === "owner" ? "member" : match.role } };
          },
        },
      },
      session: {
        create: {
          // The allowlist applies to every sign-in method, including MCP OAuth: no session without a match.
          before: async (session) => {
            const u = db().select({ email: users.email }).from(users).where(eq(users.id, session.userId)).get();
            if (!u || !lookupAllowlist(u.email)) {
              throw new APIError("FORBIDDEN", { message: "This email is not on the allowlist.", code: AUTH_ERRORS.NOT_ALLOWLISTED });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof build>;
let instance: Auth | undefined;

export function getAuth(): Auth {
  if (!instance) instance = build();
  return instance;
}

// Tests only: rebuild with a changed environment.
export function resetAuthForTests() {
  instance = undefined;
}
