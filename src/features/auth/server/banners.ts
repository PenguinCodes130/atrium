import "server-only";
import { vaultStatus, SECRETS_LOCKED_MESSAGE } from "@/features/vault";
import { ensureBootstrapped } from "./bootstrap";

// Banners settings shows to the owner (architecture sections 5 and 11).

export type AuthBanner = { id: "owner-password-var" | "owner-reset-var" | "secrets-locked"; tone: "warning" | "critical"; message: string };

export const OWNER_PASSWORD_BANNER =
  "ATRIUM_OWNER_PASSWORD is still set in the server environment. It is ignored now; remove it and restart.";

export const OWNER_RESET_BANNER =
  "ATRIUM_RESET_OWNER_PASSWORD is still set in the server environment. It was used once and is ignored now; remove it and restart.";

export async function getAuthBanners(): Promise<AuthBanner[]> {
  const out: AuthBanner[] = [];
  const setup = await ensureBootstrapped();
  if (setup.state === "ready" && setup.ownerPasswordVarSet) out.push({ id: "owner-password-var", tone: "warning", message: OWNER_PASSWORD_BANNER });
  if (setup.state === "ready" && setup.resetVarSet) out.push({ id: "owner-reset-var", tone: "warning", message: OWNER_RESET_BANNER });
  if (vaultStatus().state === "locked") out.push({ id: "secrets-locked", tone: "critical", message: SECRETS_LOCKED_MESSAGE });
  return out;
}
