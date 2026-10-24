// Database access for integrations. Secret values are never read or written here.
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { CustomEndpoint, HealthResult, Integration, PackageProblem, Principal } from "@/core/contracts";
import { db } from "@/core/db";
import { credentialLinks, customCommands, customEndpoints, declarativePackages, integrations, packageProblems } from "@/db/schema/integrations";
import { users } from "@/db/schema/auth";
import { endpointCache } from "@/db/schema/cache";
import type { CacheBacking } from "@/features/data/cache";
import type { CacheEntry } from "@/features/data/types";
import type { DeclarativeRow, ProblemSink } from "./registry";

export type IntegrationRow = typeof integrations.$inferSelect;
/** Principals with an account (everyone but guests): the only ones that create or change integrations. */
export type AccountPrincipal = Exclude<Principal, { kind: "guest" }>;
export type SecretFieldMeta = IntegrationRow["secretFields"][number];

export function listIntegrationRows(): IntegrationRow[] {
  return db().select().from(integrations).all();
}

export function getIntegrationRow(id: string): IntegrationRow | undefined {
  return db().select().from(integrations).where(eq(integrations.id, id)).get();
}

export function insertIntegration(v: { packageId: string; name: string; config: Record<string, unknown>; secretFields?: SecretFieldMeta[]; status: Integration["status"]; lastHealth?: (HealthResult & { checkedAt: string }) | null; principal: AccountPrincipal }): IntegrationRow {
  const now = new Date();
  const row = {
    id: randomUUID(),
    packageId: v.packageId,
    name: v.name,
    config: v.config,
    secretFields: v.secretFields ?? [],
    status: v.status,
    shared: false, // v3: a new integration is never shared (spec v2 criterion 12)
    lastHealth: v.lastHealth ?? null,
    createdBy: v.principal.kind,
    createdById: v.principal.userId,
    createdAt: now,
    updatedAt: now,
  };
  db().insert(integrations).values(row).run();
  return row;
}

/** A10.6: the built-in system integration's fixed id. */
export const SYSTEM_INTEGRATION_ID = "atrium";

/** A10.6: creates the built-in `atrium` integration (shared, no config, no secrets) when it is missing. */
export function ensureSystemIntegration(): void {
  if (db().select({ id: integrations.id }).from(integrations).where(eq(integrations.id, SYSTEM_INTEGRATION_ID)).get()) return;
  const now = new Date();
  db().insert(integrations).values({
    id: SYSTEM_INTEGRATION_ID, packageId: "atrium/system", name: "Atrium", config: {}, secretFields: [], status: "active", shared: true,
    lastHealth: { status: "ok", latencyMs: 0, checkedAt: now.toISOString() }, createdBy: "user", createdById: "system", createdAt: now, updatedAt: now,
  }).onConflictDoNothing().run();
}

export function updateIntegration(id: string, patch: Partial<Pick<IntegrationRow, "name" | "config" | "status" | "lastHealth" | "secretFields" | "shared">>): void {
  db().update(integrations).set({ ...patch, updatedAt: new Date() }).where(eq(integrations.id, id)).run();
}

export function deleteIntegrationRow(id: string): void {
  db().delete(integrations).where(eq(integrations.id, id)).run();
}

export function listCustomEndpoints(integrationId: string): CustomEndpoint[] {
  return db().select().from(customEndpoints).where(eq(customEndpoints.integrationId, integrationId)).all().map((r) => r.record as unknown as CustomEndpoint);
}

export function upsertCustomEndpoint(integrationId: string, e: CustomEndpoint): void {
  db()
    .insert(customEndpoints)
    .values({ id: randomUUID(), integrationId, endpointId: e.id, record: e as unknown as Record<string, unknown>, createdAt: new Date() })
    .onConflictDoUpdate({ target: [customEndpoints.integrationId, customEndpoints.endpointId], set: { record: e as unknown as Record<string, unknown> } })
    .run();
}

export function deleteCustomEndpoint(integrationId: string, endpointId: string): void {
  db().delete(customEndpoints).where(and(eq(customEndpoints.integrationId, integrationId), eq(customEndpoints.endpointId, endpointId))).run();
}

// ---- Declarative packages ----
export function listDeclarativeRows(): DeclarativeRow[] {
  return db().select().from(declarativePackages).all().map((r) => ({ id: r.id, manifest: r.manifest, endpoints: r.endpoints, commands: r.commands ?? [], status: r.status }));
}

export function getDeclarativeRow(id: string) {
  return db().select().from(declarativePackages).where(eq(declarativePackages.id, id)).get();
}

export function saveDeclarative(v: { id: string; manifest: Record<string, unknown>; endpoints: unknown[]; status: "draft" | "active"; principal: AccountPrincipal; commands?: unknown[]; draftCommands?: unknown[] | null }): void {
  const now = new Date();
  const cmds = { ...(v.commands !== undefined ? { commands: v.commands } : {}), ...(v.draftCommands !== undefined ? { draftCommands: v.draftCommands } : {}) };
  db()
    .insert(declarativePackages)
    .values({ id: v.id, manifest: v.manifest, endpoints: v.endpoints, status: v.status, createdBy: v.principal.kind, createdById: v.principal.userId, createdAt: now, updatedAt: now, ...cmds })
    .onConflictDoUpdate({ target: declarativePackages.id, set: { manifest: v.manifest, endpoints: v.endpoints, status: v.status, updatedAt: now, ...cmds } })
    .run();
}

export function setDeclarativeCommands(id: string, patch: { commands?: unknown[]; draftCommands?: unknown[] | null; manifest?: Record<string, unknown> }): void {
  db().update(declarativePackages).set({ ...patch, updatedAt: new Date() }).where(eq(declarativePackages.id, id)).run();
}

// ---- Custom commands (v3 section 3.1) ----
export type CustomCommandRow = typeof customCommands.$inferSelect;

export function listCustomCommandRows(integrationId: string): CustomCommandRow[] {
  return db().select().from(customCommands).where(eq(customCommands.integrationId, integrationId)).all();
}

export function saveCustomCommandDraft(integrationId: string, commandId: string, draft: Record<string, unknown>, byId: string): void {
  const now = new Date();
  db()
    .insert(customCommands)
    .values({ id: randomUUID(), integrationId, commandId, record: null, draft, updatedById: byId, updatedAt: now })
    .onConflictDoUpdate({ target: [customCommands.integrationId, customCommands.commandId], set: { draft, updatedById: byId, updatedAt: now } })
    .run();
}

/** Publishes every pending command of an integration: the draft becomes the record. Returns the ids. */
export function publishCustomCommands(integrationId: string, byId: string): string[] {
  const rows = listCustomCommandRows(integrationId).filter((r) => r.draft);
  for (const r of rows) db().update(customCommands).set({ record: r.draft, draft: null, updatedById: byId, updatedAt: new Date() }).where(eq(customCommands.id, r.id)).run();
  return rows.map((r) => r.commandId);
}

export function discardCustomCommandDrafts(integrationId: string): void {
  db().delete(customCommands).where(and(eq(customCommands.integrationId, integrationId), isNull(customCommands.record))).run();
  db().update(customCommands).set({ draft: null }).where(eq(customCommands.integrationId, integrationId)).run();
}

// ---- Users (read only: owned by auth; integrations only needs to know who the owners are) ----
export function ownerIds(): Set<string> {
  return new Set(db().select({ id: users.id }).from(users).where(eq(users.role, "owner")).all().map((r) => r.id));
}

export function deleteDeclarative(id: string): void {
  db().delete(declarativePackages).where(eq(declarativePackages.id, id)).run();
}

// ---- Package problems ----
function problemId(p: PackageProblem) {
  return createHash("sha256").update(`${p.source}\n${p.packageId}\n${p.reason}`).digest("hex");
}

export const dbProblemSink: ProblemSink = {
  record(p) {
    const id = problemId(p);
    const at = new Date(p.at);
    const existing = db().select().from(packageProblems).where(eq(packageProblems.id, id)).get();
    if (existing) {
      // Same problem on a later load or restart: no new alert, unless it was fixed and came back.
      const again = existing.alertedAt === null || existing.resolvedAt !== null;
      db().update(packageProblems).set({ lastSeenAt: at, resolvedAt: null, ...(again ? { alertedAt: at } : {}) }).where(eq(packageProblems.id, id)).run();
      return again;
    }
    db().insert(packageProblems).values({ id, packageId: p.packageId, source: p.source, reason: p.reason, firstSeenAt: at, lastSeenAt: at, alertedAt: at }).run();
    return true;
  },
  resolveOthers(seen) {
    const ids = seen.map(problemId);
    const where = ids.length ? and(isNull(packageProblems.resolvedAt), notInArray(packageProblems.id, ids)) : isNull(packageProblems.resolvedAt);
    db().update(packageProblems).set({ resolvedAt: new Date() }).where(where).run();
  },
};

export function firstSeen(p: PackageProblem): string {
  const row = db().select().from(packageProblems).where(eq(packageProblems.id, problemId(p))).get();
  return row ? row.firstSeenAt.toISOString() : p.at;
}

// ---- Credential links ----
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function insertCredentialLink(integrationId: string, token: string, createdById: string, ttlMs: number): { expiresAt: Date } {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  db().insert(credentialLinks).values({ id: hashToken(token), integrationId, createdById, createdAt: now, expiresAt }).run();
  return { expiresAt };
}

export function getCredentialLink(token: string) {
  return db().select().from(credentialLinks).where(eq(credentialLinks.id, hashToken(token))).get();
}

export function markLinksUsed(integrationId: string): void {
  db().update(credentialLinks).set({ usedAt: new Date() }).where(and(eq(credentialLinks.integrationId, integrationId), isNull(credentialLinks.usedAt))).run();
}

// ---- Cache backing ----
export const dbCacheBacking: CacheBacking = {
  load(key) {
    const r = db().select().from(endpointCache).where(eq(endpointCache.key, key)).get();
    if (!r) return undefined;
    return {
      key: r.key,
      integrationId: r.integrationId,
      endpointId: r.endpointId,
      params: r.params,
      lastGood: (r.lastGood as CacheEntry["lastGood"]) ?? null,
      lastAttempt: (r.lastAttempt as CacheEntry["lastAttempt"]) ?? null,
      fetchedAt: r.fetchedAt ? r.fetchedAt.toISOString() : null,
      sourceTimestamp: r.sourceTimestamp,
    };
  },
  save(e) {
    const v = {
      key: e.key,
      integrationId: e.integrationId,
      endpointId: e.endpointId,
      params: e.params,
      lastGood: e.lastGood as unknown as Record<string, unknown> | null,
      lastAttempt: e.lastAttempt as unknown as Record<string, unknown> | null,
      fetchedAt: e.fetchedAt ? new Date(e.fetchedAt) : null,
      sourceTimestamp: e.sourceTimestamp,
      updatedAt: new Date(),
    };
    db().insert(endpointCache).values(v).onConflictDoUpdate({ target: endpointCache.key, set: v }).run();
  },
  removeIntegration(id) {
    db().delete(endpointCache).where(eq(endpointCache.integrationId, id)).run();
  },
};

export function countCacheRows(): number {
  return db().select({ key: endpointCache.key }).from(endpointCache).all().length;
}
