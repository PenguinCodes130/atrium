import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/core/db";
import { secrets } from "@/db/schema/vault";
import { decrypt, type SecretRef } from "./cipher";
import { vaultState } from "./key";
import { SecretUnreadable, VaultLocked } from "./index";

// Unseal (architecture section 11). Importable only from src/features/integrations/host/,
// src/features/notifications/channels/ and src/features/setup-agent/model/ (eslint no-restricted-imports).

/** Returns the plaintext, or null when the field was never set. Throws VaultLocked when the key is missing or wrong. */
export function unseal(ref: SecretRef): string | null {
  const row = db()
    .select()
    .from(secrets)
    .where(and(eq(secrets.ownerType, ref.ownerType), eq(secrets.ownerId, ref.ownerId), eq(secrets.key, ref.key)))
    .get();
  if (!row) return null;
  const state = vaultState();
  if (state.state !== "ready") throw new VaultLocked();
  try {
    // The AAD comes from the caller's ref, not the row, so a row copied to another owner or field fails here.
    return decrypt(state.key, ref, row);
  } catch {
    // The key opened other secrets at boot, so this row was altered or moved: refuse it.
    throw new SecretUnreadable();
  }
}
