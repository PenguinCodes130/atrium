// The only place in integrations that opens sealed secrets (architecture v2 section 11).
// Every secret is pinned to the address it was saved for: the resolver is told where the request
// is going and refuses to hand a stored or held value to any other origin (gauntlet r1 finding 1).
import "server-only";
import { unseal } from "@/features/vault/unseal";
import { seal, VaultLocked, vaultStatus } from "@/features/vault";
import { HostError, hostError, SECRETS_LOCKED_MESSAGE } from "./errors";
import { pendingOrigin, pendingValues } from "./pending";
import { refsOfIntegration } from "../credentials/repo";
import { resolveCredential, type ResolvedSecret } from "./credentials";

export type { ResolvedSecret };

/**
 * `destination` is the origin the request goes to (scheme, host and port), or `unix:<path>`.
 * A plain string is the value; a saved username and password credential also carries its username.
 */
export type SecretResolver = (key: string, destination: string) => Promise<string | ResolvedSecret | null>;

/** Splits a resolver answer into the value and, for Basic auth, the username that goes with it. */
export function splitSecret(got: string | ResolvedSecret | null): { value: string | null; user?: string } {
  if (got === null || typeof got === "string") return { value: got };
  return { value: got.value, ...(got.user !== undefined ? { user: got.user } : {}) };
}

export type ResolverOptions = {
  /** A saved integration whose sealed secrets may be used. */
  integrationId?: string | undefined;
  /** The origin those sealed secrets were saved for: the integration's stored address. */
  pinOrigin?: string | undefined;
  /** Values typed on the setup screen for this one request; they win over stored ones. Blank means "keep". */
  transient?: Record<string, string> | undefined;
  /** Secrets held from a pasted curl command, pinned to the origin they came with. */
  pending?: { id: string; userId: string } | undefined;
  /**
   * Amendment 2: saved credentials picked on the setup screen for this one request, by secret key.
   * The service has already checked the caller may use them; the lock list is checked here.
   */
  credentialRefs?: Record<string, string> | undefined;
};

export const PINNED_MESSAGE = "A saved credential is only sent to the address it was saved for";

/**
 * The vault field that records, sealed and bound to this integration, the origin its secrets were
 * saved for. It is written whenever a secret is saved and deleted with them, so the pin does not
 * depend on the integration's config row staying unchanged.
 */
export const PIN_KEY = "__origin";

export function recordPin(integrationId: string, origin: string): void {
  seal({ ownerType: "integration", ownerId: integrationId, key: PIN_KEY }, origin);
}

export function vaultResolver(opts: ResolverOptions = {}): SecretResolver {
  const transient = opts.transient ?? {};
  return async (key, destination) => {
    const t = transient[key];
    if (t) return t;
    const picked = opts.credentialRefs?.[key];
    if (picked) return resolveCredential(picked, destination);
    if (opts.pending) {
      const v = pendingValues(opts.pending.id, opts.pending.userId)[key];
      if (v) {
        if (pendingOrigin(opts.pending.id, opts.pending.userId) !== destination) {
          throw hostError("permission", "Credentials from the pasted command can only be sent to the address they came with.", "Paste a new curl command for the other address.");
        }
        return v;
      }
    }
    if (!opts.integrationId) return null;
    try {
      // A field filled from a saved credential: the integration's pin and the credential's lock both apply.
      const ref = refsOfIntegration(opts.integrationId).find((r) => r.secretKey === key);
      if (ref) {
        const pin = unseal({ ownerType: "integration", ownerId: opts.integrationId, key: PIN_KEY }) ?? opts.pinOrigin ?? null;
        return resolveCredential(ref.credentialId, destination, pin);
      }
      const value = unseal({ ownerType: "integration", ownerId: opts.integrationId, key });
      if (value === null) return null;
      // The recorded pin wins; integrations saved before it existed fall back to their stored address.
      const pin = unseal({ ownerType: "integration", ownerId: opts.integrationId, key: PIN_KEY }) ?? opts.pinOrigin;
      if (!pin || pin !== destination) {
        throw hostError("permission", `${PINNED_MESSAGE}.`, "This address differs from the saved one. Type the credential again to use it here, or save the new address first.");
      }
      return value;
    } catch (err) {
      if (err instanceof HostError) throw err;
      if (err instanceof VaultLocked) throw hostError("config", SECRETS_LOCKED_MESSAGE, "Restore ATRIUM_MASTER_KEY or the master.key file on the server, then restart Atrium.");
      throw hostError("config", "A saved secret could not be opened.", "Save the secret again.");
    }
  };
}

export function secretsLocked(): boolean {
  return vaultStatus().state === "locked";
}
