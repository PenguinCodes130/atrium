// Secrets lifted out of a pasted curl command, held in server memory until the integration is
// saved (then sealed) or 30 minutes pass. The browser only ever holds the opaque id.
import "server-only";
import { randomBytes } from "node:crypto";
import type { AuthPlacement } from "@/core/contracts";
import { seal } from "@/features/vault";

export type PendingField = { key: string; label: string; hint: string; auth: AuthPlacement };
type Pending = { userId: string; origin: string; fields: PendingField[]; values: Record<string, string>; expiresAt: number };

const TTL_MS = 30 * 60_000;
const g = globalThis as unknown as { __atriumPendingSecrets?: Map<string, Pending> };
const store = (g.__atriumPendingSecrets ??= new Map());

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt < now) store.delete(k);
}

/** `origin` is the scheme, host and port the command was for; the values are only sent there. */
export function holdSecrets(userId: string, origin: string, secrets: (PendingField & { value: string })[]): string {
  sweep();
  const id = `ps_${randomBytes(18).toString("base64url")}`;
  store.set(id, {
    userId,
    origin,
    fields: secrets.map(({ key, label, hint, auth }) => ({ key, label, hint, auth })),
    values: Object.fromEntries(secrets.map((s) => [s.key, s.value])),
    expiresAt: Date.now() + TTL_MS,
  });
  return id;
}

function get(id: string | undefined, userId: string): Pending | undefined {
  if (!id) return undefined;
  sweep();
  const p = store.get(id);
  return p && p.userId === userId ? p : undefined;
}

export function pendingFields(id: string | undefined, userId: string): PendingField[] | undefined {
  return get(id, userId)?.fields;
}

export function pendingOrigin(id: string | undefined, userId: string): string | undefined {
  return get(id, userId)?.origin;
}

/** Internal to host/: the values, for attaching to a Try it request. */
export function pendingValues(id: string | undefined, userId: string): Record<string, string> {
  return get(id, userId)?.values ?? {};
}

/** Seals held secrets onto a saved integration and forgets them. Returns the fields that were sealed. */
export function sealPending(id: string | undefined, userId: string, integrationId: string): PendingField[] {
  const p = get(id, userId);
  if (!p || !id) return [];
  for (const f of p.fields) seal({ ownerType: "integration", ownerId: integrationId, key: f.key }, p.values[f.key]);
  store.delete(id);
  return p.fields;
}
