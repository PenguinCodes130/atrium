import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { desc } from "drizzle-orm";
import { db } from "@/core/db";
import { dataDir, env } from "@/core/env";
import { logger } from "@/core/log";
import { secrets } from "@/db/schema/vault";
import { decrypt, type OwnerType } from "./cipher";

// Master key handling (architecture section 11). Internal to the vault.

const log = logger("vault");

export const SECRETS_LOCKED_MESSAGE = "Secrets locked: the master key is missing or wrong";
export const CURRENT_KEY_VERSION = 1;

export type VaultState =
  | { state: "ready"; key: Buffer; source: "env" | "file" | "created" }
  | { state: "locked"; reason: "missing" | "wrong" };

type LockListener = (info: { reason: "missing" | "wrong"; at: string }) => void | Promise<void>;
let cached: VaultState | undefined;
// Next bundles the proxy and the routes separately, so module state is duplicated; the alert flag
// lives on globalThis so the critical alert goes out once per process.
const g = globalThis as typeof globalThis & { __atriumVaultAlerted?: boolean; __atriumVaultListeners?: Set<LockListener> };
const lockListeners = (g.__atriumVaultListeners ??= new Set<LockListener>());

export function masterKeyPath(): string {
  return path.join(dataDir(), "master.key");
}

function parseKey(raw: string): Buffer | null {
  const buf = Buffer.from(raw.trim(), "base64");
  return buf.length === 32 ? buf : null;
}

function anySealed(): { ownerType: OwnerType; ownerId: string; key: string; ciphertext: string; iv: string; tag: string } | undefined {
  return db().select().from(secrets).orderBy(desc(secrets.updatedAt)).limit(1).get();
}

function resolve(): VaultState {
  const fromEnv = env().ATRIUM_MASTER_KEY;
  const file = masterKeyPath();
  let key: Buffer | null = null;
  let source: "env" | "file" | "created" = "env";
  if (fromEnv) {
    key = parseKey(fromEnv);
  } else if (existsSync(file)) {
    key = parseKey(readFileSync(file, "utf8"));
    source = "file";
  }
  const sample = anySealed();
  if (!key) {
    // A key was given but is not 32 base64 bytes: wrong. No key while secrets exist: missing.
    // Either way no new key is generated, so the sealed secrets are never orphaned.
    if (fromEnv || existsSync(file)) return { state: "locked", reason: "wrong" };
    if (sample) return { state: "locked", reason: "missing" };
    // First boot with no key and no sealed secrets: create the key file, owner-only permissions.
    const fresh = randomBytes(32);
    writeFileSync(file, fresh.toString("base64"), { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    log.info("Created the master key file", { path: file });
    return { state: "ready", key: fresh, source: "created" };
  }
  if (sample) {
    try {
      decrypt(key, sample, sample);
    } catch {
      return { state: "locked", reason: "wrong" };
    }
  }
  return { state: "ready", key, source };
}

export function vaultState(): VaultState {
  if (!cached) {
    cached = resolve();
    if (cached.state === "locked") announceLocked(cached.reason);
  }
  return cached;
}

function announceLocked(reason: "missing" | "wrong") {
  if (g.__atriumVaultAlerted) return;
  g.__atriumVaultAlerted = true;
  const at = new Date().toISOString();
  // Critical system alert. The notifications subsystem subscribes through onVaultLocked().
  log.error(`critical: ${SECRETS_LOCKED_MESSAGE}`, { reason });
  for (const fn of lockListeners) {
    Promise.resolve(fn({ reason, at })).catch(() => log.warn("A vault lock listener failed"));
  }
}

export function onVaultLocked(fn: LockListener): () => void {
  lockListeners.add(fn);
  if (cached?.state === "locked") Promise.resolve(fn({ reason: cached.reason, at: new Date().toISOString() })).catch(() => {});
  return () => lockListeners.delete(fn);
}

// Tests only: forget the cached key so a changed environment is read again.
export function resetVaultForTests() {
  cached = undefined;
  g.__atriumVaultAlerted = false;
  lockListeners.clear();
}
