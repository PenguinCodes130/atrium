// Database access for saved credentials (Amendment 2). Values never pass through here: they are
// sealed in the vault under owner type "credential".
import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { CredentialKind } from "@/core/contracts";
import { db, sqlite } from "@/core/db";
import { credentials, integrationCredentials, integrations } from "@/db/schema/integrations";

export type CredentialRow = typeof credentials.$inferSelect;
export type RefRow = typeof integrationCredentials.$inferSelect;

// Until the lead generates the migration for these tables, a database made from migrations alone
// has no credential tables. Reads then answer "none" instead of failing every integrations screen.
let tablesKnown: boolean | undefined;
export function credentialTablesExist(): boolean {
  if (tablesKnown) return true;
  const row = sqlite().prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('credential', 'integration_credential')").get() as { n: number };
  tablesKnown = row.n === 2 ? true : undefined;
  return row.n === 2;
}

export function insertCredential(v: { name: string; kind: CredentialKind; lockedOrigins: string[]; createdById: string }): CredentialRow {
  const now = new Date();
  const row: CredentialRow = { id: randomUUID(), name: v.name, nameKey: v.name.toLowerCase(), kind: v.kind, lockedOrigins: v.lockedOrigins, createdById: v.createdById, createdAt: now, updatedAt: now, lastUsedAt: null };
  db().insert(credentials).values(row).run();
  return row;
}

export function getCredentialRow(id: string): CredentialRow | undefined {
  if (!credentialTablesExist()) return undefined;
  return db().select().from(credentials).where(eq(credentials.id, id)).get();
}

export function listCredentialRows(): CredentialRow[] {
  if (!credentialTablesExist()) return [];
  return db().select().from(credentials).all();
}

export function nameTaken(createdById: string, name: string, exceptId?: string): boolean {
  if (!credentialTablesExist()) return false;
  const hit = db().select({ id: credentials.id }).from(credentials).where(and(eq(credentials.createdById, createdById), eq(credentials.nameKey, name.toLowerCase()))).get();
  return !!hit && hit.id !== exceptId;
}

export function touchCredential(id: string, patch: Partial<Pick<CredentialRow, "lockedOrigins" | "updatedAt" | "lastUsedAt" | "name" | "nameKey">>): void {
  db().update(credentials).set(patch).where(eq(credentials.id, id)).run();
}

export function deleteCredentialRow(id: string): void {
  db().delete(credentials).where(eq(credentials.id, id)).run();
}

// ---- References from integrations ----
export function refsOfIntegration(integrationId: string): RefRow[] {
  if (!credentialTablesExist()) return [];
  return db().select().from(integrationCredentials).where(eq(integrationCredentials.integrationId, integrationId)).all();
}

export function refsOfCredential(credentialId: string): RefRow[] {
  if (!credentialTablesExist()) return [];
  return db().select().from(integrationCredentials).where(eq(integrationCredentials.credentialId, credentialId)).all();
}

export function allRefs(): RefRow[] {
  if (!credentialTablesExist()) return [];
  return db().select().from(integrationCredentials).all();
}

export function setRef(integrationId: string, secretKey: string, credentialId: string): void {
  db()
    .insert(integrationCredentials)
    .values({ integrationId, secretKey, credentialId, createdAt: new Date() })
    .onConflictDoUpdate({ target: [integrationCredentials.integrationId, integrationCredentials.secretKey], set: { credentialId } })
    .run();
}

export function removeRef(integrationId: string, secretKey: string): void {
  if (!credentialTablesExist()) return;
  db().delete(integrationCredentials).where(and(eq(integrationCredentials.integrationId, integrationId), eq(integrationCredentials.secretKey, secretKey))).run();
}

/** Integration ids and names that use a credential, drafts and disabled ones included. */
export function usersOf(credentialId: string): { integrationId: string; name: string }[] {
  const refs = refsOfCredential(credentialId);
  if (!refs.length) return [];
  const ids = [...new Set(refs.map((r) => r.integrationId))];
  return db().select({ integrationId: integrations.id, name: integrations.name }).from(integrations).where(inArray(integrations.id, ids)).all();
}
