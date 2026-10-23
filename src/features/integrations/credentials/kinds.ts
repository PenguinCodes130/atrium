// Saved credential kinds (architecture v3 Amendment 2). Pure and safe for the browser: no values.
import type { AuthPlacement, CredentialKind } from "@/core/contracts";

export const CREDENTIAL_KINDS: CredentialKind[] = ["token", "username-password", "proxmox-token"];

export const KIND_LABELS: Record<CredentialKind, string> = {
  token: "Token",
  "username-password": "Username and password",
  "proxmox-token": "Proxmox API token",
};

export type KindField = { key: string; label: string; hint: string; secret: boolean };

/** The value fields of each kind, in order. Every one is write-only. */
export const KIND_FIELDS: Record<CredentialKind, KindField[]> = {
  token: [{ key: "token", label: "Token", hint: "An API token, API key or long-lived access token.", secret: true }],
  "username-password": [
    { key: "username", label: "Username", hint: "The Basic auth username.", secret: false },
    { key: "password", label: "Password", hint: "The Basic auth password.", secret: true },
  ],
  "proxmox-token": [
    { key: "tokenId", label: "Token ID", hint: "USER@REALM!TOKENID, for example atrium@pve!dashboard.", secret: false },
    { key: "secret", label: "Secret", hint: "The token secret Proxmox showed once when you made the token.", secret: true },
  ],
};

/** Which kind of saved credential a secret field takes (Amendment 2, "Kinds and placement"). */
export function kindForPlacement(auth: AuthPlacement | { as: string }): CredentialKind | null {
  switch (auth.as) {
    case "bearer":
    case "header":
    case "query":
      return "token";
    case "basic":
      return "username-password";
    case "proxmox-token":
      return "proxmox-token";
    default:
      return null;
  }
}

/** The origin of a full http(s) address, or null. A default port written out counts as left out. */
export function normaliseOrigin(address: string): string | null {
  const raw = address.trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || !u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export const NAME_MAX = 80;
