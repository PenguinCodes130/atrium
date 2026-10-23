// Saved credentials at send time (architecture v3 Amendment 2). The only place a credential's
// values are opened. A value is attached only when the request's origin is in the credential's
// lockedOrigins, on top of the integration's own pin (secrets.ts). Callers get a value to write
// straight into the outgoing request, never anything to return.
import "server-only";
import { unseal } from "@/features/vault/unseal";
import { VaultLocked } from "@/features/vault";
import { getCredentialRow, touchCredential } from "../credentials/repo";
import { KIND_FIELDS } from "../credentials/kinds";
import { HostError, hostError, SECRETS_LOCKED_MESSAGE } from "./errors";

/** A value to attach, and for a username and password credential the Basic auth username. */
export type ResolvedSecret = { value: string; user?: string };

export const CREDENTIAL_LOCK_HINT = "A signed-in person can allow it on this server when saving the integration.";

const LAST_USED_EVERY_MS = 60_000;

function origins(list: string[]): string {
  return list.length ? list.join(", ") : "no server yet";
}

/**
 * Opens credential `credentialId` for a request to `destination`. `pin`, when given, is the
 * integration's own pinned origin and must also match. There is no other way out: a server joins the
 * lock list only through applyLocks, after the confirm and a step-up (Fix List r3 item 1; the round
 * 5 "trial" send of an unlocked credential is gone). Throws a HostError (permission or config).
 */
export function resolveCredential(credentialId: string, destination: string, pin?: string | null): ResolvedSecret {
  const c = getCredentialRow(credentialId);
  if (!c) throw hostError("config", "The saved credential for this field was deleted.", "Pick another saved credential or enter a value.");
  if (pin !== undefined && pin !== destination) {
    throw hostError("permission", "A saved credential is only sent to the address it was saved for.", "This address differs from the integration's saved one. Save the new address first.");
  }
  if (!c.lockedOrigins.includes(destination)) {
    const message = c.lockedOrigins.length
      ? `The saved credential "${c.name}" is locked to ${origins(c.lockedOrigins)}, so Atrium did not send it to ${destination}.`
      : `The saved credential "${c.name}" is not locked to any server yet, so Atrium did not send it to ${destination}.`;
    throw hostError("permission", message, c.lockedOrigins.length ? CREDENTIAL_LOCK_HINT : "Test or save the integration to lock it to this server; you confirm it is you first.");
  }
  try {
    const vals: Record<string, string> = {};
    for (const f of KIND_FIELDS[c.kind]) {
      const v = unseal({ ownerType: "credential", ownerId: c.id, key: f.key });
      if (!v) throw hostError("config", `The saved credential "${c.name}" has no ${f.label}.`, "Rotate it and enter every field.");
      vals[f.key] = v;
    }
    const now = Date.now();
    if ((!c.lastUsedAt || now - c.lastUsedAt.getTime() >= LAST_USED_EVERY_MS)) touchCredential(c.id, { lastUsedAt: new Date(now) });
    if (c.kind === "token") return { value: vals.token! };
    if (c.kind === "username-password") return { value: vals.password!, user: vals.username! };
    return { value: `${vals.tokenId}=${vals.secret}` };
  } catch (err) {
    if (err instanceof HostError) throw err;
    if (err instanceof VaultLocked) throw hostError("config", SECRETS_LOCKED_MESSAGE, "Restore ATRIUM_MASTER_KEY or the master.key file on the server, then restart Atrium.");
    throw hostError("config", `The saved credential "${c.name}" could not be opened.`, "Rotate it to save its values again.");
  }
}
