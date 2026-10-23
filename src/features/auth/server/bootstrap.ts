import "server-only";
import { randomUUID } from "node:crypto";
import { count } from "drizzle-orm";
import { db, transaction } from "@/core/db";
import { env } from "@/core/env";
import { logger } from "@/core/log";
import { users, accounts, allowlistEntries } from "@/db/schema/auth";
import { vaultStatus } from "@/features/vault";
import { hashPassword } from "./password-hash";
import { checkPassword, isValidEmail, normalizeEmail } from "./policy";
import { installPeerStamp } from "./peer";
import { applyOwnerResetFromEnv, RESET_VAR } from "./recovery";

// First run (architecture section 5): the owner comes only from the server environment.

const log = logger("auth");

export const SETUP_MESSAGES = {
  missing: "Set ATRIUM_OWNER_EMAIL and restart",
  invalid: "ATRIUM_OWNER_EMAIL is not a valid email address",
  weakPassword: "ATRIUM_OWNER_PASSWORD must be at least 12 characters and not a common password",
} as const;

export type SetupState =
  | { state: "ready"; ownerPasswordVarSet: boolean; resetVarSet?: boolean }
  | { state: "setup-required"; reason: keyof typeof SETUP_MESSAGES; message: string };

// Shared on globalThis: the proxy and the route bundles each load this module (see vault/key.ts).
const g = globalThis as typeof globalThis & { __atriumBootstrap?: Promise<SetupState> };

function userCount(): number {
  return db().select({ n: count() }).from(users).get()?.n ?? 0;
}

async function run(): Promise<SetupState> {
  const state = await setup();
  // Check the master key at boot: a missing or wrong key locks secrets and raises the critical alert,
  // and Atrium keeps starting (architecture section 11).
  if (state.state === "ready") vaultStatus();
  return state;
}

async function setup(): Promise<SetupState> {
  const e = env();
  const passwordVarSet = !!e.ATRIUM_OWNER_PASSWORD;
  const resetVarSet = !!process.env[RESET_VAR];
  if (userCount() > 0) {
    // Both variables are ignored once an owner exists. Suggest removing the password variable.
    if (passwordVarSet) log.warn("ATRIUM_OWNER_PASSWORD is still set but is ignored now that the owner exists. Remove it from the server environment.");
    // Owner recovery: a one-shot new password from the environment (recovery.ts).
    if (resetVarSet) await applyOwnerResetFromEnv();
    return { state: "ready", ownerPasswordVarSet: passwordVarSet, resetVarSet };
  }
  if (resetVarSet) log.warn(`${RESET_VAR} is ignored: there is no owner yet. Use ATRIUM_OWNER_PASSWORD for the first start.`);
  const raw = e.ATRIUM_OWNER_EMAIL?.trim();
  if (!raw) return { state: "setup-required", reason: "missing", message: SETUP_MESSAGES.missing };
  if (!isValidEmail(raw)) return { state: "setup-required", reason: "invalid", message: SETUP_MESSAGES.invalid };
  const password = e.ATRIUM_OWNER_PASSWORD;
  if (password && checkPassword(password)) return { state: "setup-required", reason: "weakPassword", message: SETUP_MESSAGES.weakPassword };

  const email = normalizeEmail(raw);
  const passwordHash = password ? await hashPassword(password) : null;
  const now = new Date();
  const created = transaction((tx) => {
    // Re-checked inside the transaction so two first requests can never create two owners.
    if ((tx.select({ n: count() }).from(users).get()?.n ?? 0) > 0) return false;
    const id = randomUUID();
    tx.insert(users)
      .values({ id, name: email.split("@")[0]!, email, emailVerified: true, role: "owner", twoFactorEnabled: false, createdAt: now, updatedAt: now })
      .run();
    if (passwordHash) {
      tx.insert(accounts).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: passwordHash, createdAt: now, updatedAt: now }).run();
    }
    tx.insert(allowlistEntries).values({ id: randomUUID(), pattern: email, role: "owner", createdAt: now }).onConflictDoNothing().run();
    return true;
  });
  if (created) log.info("Created the owner from ATRIUM_OWNER_EMAIL", { signIn: passwordHash ? "email and password" : "provider only" });
  return { state: "ready", ownerPasswordVarSet: false };
}

/** Runs the first-run bootstrap once per process and returns the setup state. */
export function ensureBootstrapped(): Promise<SetupState> {
  // At boot (instrumentation.ts calls this first): learn each request's socket peer for rate limits.
  installPeerStamp();
  if (!g.__atriumBootstrap) g.__atriumBootstrap = run().catch((err) => {
    g.__atriumBootstrap = undefined;
    throw err;
  });
  return g.__atriumBootstrap;
}

// Tests only.
export function resetBootstrapForTests() {
  g.__atriumBootstrap = undefined;
}
