import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/core/db";
import { AtriumError } from "@/core/errors";
import { secrets } from "@/db/schema/vault";
import { encrypt, type OwnerType, type SecretRef } from "./cipher";
import { CURRENT_KEY_VERSION, SECRETS_LOCKED_MESSAGE, vaultState, onVaultLocked } from "./key";

// The vault (architecture section 11). seal() and the read-only status helpers are open to every
// server module. Unsealing lives only in "@/features/vault/unseal", which lint restricts to the
// integrations host, the notification channel senders and the setup agent's model client.

export type { OwnerType, SecretRef };
export { SECRETS_LOCKED_MESSAGE, onVaultLocked };

export class VaultLocked extends AtriumError {
  constructor() {
    super(SECRETS_LOCKED_MESSAGE, 503, "secrets_locked");
  }
}

export class SecretUnreadable extends AtriumError {
  constructor() {
    super("This secret cannot be opened. Save it again.", 500, "secret_unreadable");
  }
}

export type SecretStatus = { key: string; set: boolean; updatedAt?: string };

/** Whether secrets can be sealed and opened. "locked" when sealed secrets exist and the key is missing or wrong. */
export function vaultStatus(): { state: "ready" } | { state: "locked"; reason: "missing" | "wrong"; message: string } {
  const s = vaultState();
  return s.state === "ready" ? { state: "ready" } : { state: "locked", reason: s.reason, message: SECRETS_LOCKED_MESSAGE };
}

/**
 * Seal a secret value. A blank or missing value keeps the stored one (write-only fields:
 * "leaving a field blank keeps the old value"). Returns the field's status, never the value.
 */
export function seal(ref: SecretRef, value: string | null | undefined): SecretStatus {
  if (value === undefined || value === null || value === "") return secretStatus(ref.ownerType, ref.ownerId, [ref.key])[0]!;
  const state = vaultState();
  if (state.state !== "ready") throw new VaultLocked();
  const sealed = encrypt(state.key, ref, value);
  const now = new Date();
  db()
    .insert(secrets)
    .values({ id: randomUUID(), ...ref, ...sealed, keyVersion: CURRENT_KEY_VERSION, updatedAt: now })
    .onConflictDoUpdate({
      target: [secrets.ownerType, secrets.ownerId, secrets.key],
      set: { ...sealed, keyVersion: CURRENT_KEY_VERSION, updatedAt: now },
    })
    .run();
  return { key: ref.key, set: true, updatedAt: now.toISOString() };
}

/** Status of an owner's secret fields: whether each is set and when it was updated. Never the value. */
export function secretStatus(ownerType: OwnerType, ownerId: string, keys?: string[]): SecretStatus[] {
  const rows = db()
    .select({ key: secrets.key, updatedAt: secrets.updatedAt })
    .from(secrets)
    .where(and(eq(secrets.ownerType, ownerType), eq(secrets.ownerId, ownerId)))
    .all();
  const byKey = new Map(rows.map((r) => [r.key, r.updatedAt]));
  const wanted = keys ?? [...byKey.keys()];
  return wanted.map((key) => {
    const at = byKey.get(key);
    return at ? { key, set: true, updatedAt: at.toISOString() } : { key, set: false };
  });
}

/** Remove one secret field, or every secret of an owner when no key is given. */
export function removeSecrets(ownerType: OwnerType, ownerId: string, key?: string): void {
  const where = key
    ? and(eq(secrets.ownerType, ownerType), eq(secrets.ownerId, ownerId), eq(secrets.key, key))
    : and(eq(secrets.ownerType, ownerType), eq(secrets.ownerId, ownerId));
  db().delete(secrets).where(where).run();
}
