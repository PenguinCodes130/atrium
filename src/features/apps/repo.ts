// Database access for apps, drafts, draft changes and versions (src/db/schema/apps.ts).
import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { App, AppDocument, AppDraft, AppVersion, DraftChange, DraftOp, Principal } from "@/core/contracts";
import { db, type Db } from "@/core/db";
import { appDraftChanges, appDrafts, apps, appVersions } from "@/db/schema/apps";
import { users } from "@/db/schema/auth";

export type AppRow = typeof apps.$inferSelect;

export function toApp(r: AppRow): App {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    ...(r.icon ? { icon: r.icon } : {}),
    access: { view: r.accessView, edit: r.accessEdit, guests: r.accessGuests },
    ...(r.publishedVersion != null ? { publishedVersion: r.publishedVersion } : {}),
    draftRev: r.draftRev,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function getApp(id: string, tx: Db = db()): App | null {
  const r = tx.select().from(apps).where(eq(apps.id, id)).get();
  return r ? toApp(r) : null;
}

export function getAppBySlug(slug: string, tx: Db = db()): App | null {
  const r = tx.select().from(apps).where(eq(apps.slug, slug)).get();
  return r ? toApp(r) : null;
}

export function listApps(tx: Db = db()): App[] {
  return tx.select().from(apps).orderBy(asc(apps.createdAt)).all().map(toApp);
}

export function slugExists(slug: string, tx: Db = db()): boolean {
  return !!tx.select({ id: apps.id }).from(apps).where(eq(apps.slug, slug)).get();
}

export function insertApp(tx: Db, app: App, doc: AppDocument, by: Principal, fromImport = false): void {
  const now = new Date(app.createdAt);
  tx.insert(apps)
    .values({
      id: app.id,
      slug: app.slug,
      name: app.name,
      icon: app.icon ?? null,
      accessView: app.access.view,
      accessEdit: app.access.edit,
      accessGuests: app.access.guests,
      publishedVersion: null,
      draftRev: app.draftRev,
      createdBy: app.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  tx.insert(appDrafts).values({ appId: app.id, rev: app.draftRev, doc, updatedAt: now, updatedBy: by, fromImport }).run();
}

export function updateApp(tx: Db, id: string, patch: Partial<Pick<AppRow, "name" | "icon" | "accessView" | "accessEdit" | "accessGuests" | "publishedVersion" | "draftRev">>): void {
  tx.update(apps).set({ ...patch, updatedAt: new Date() }).where(eq(apps.id, id)).run();
}

export function deleteAppRow(tx: Db, id: string): void {
  tx.delete(apps).where(eq(apps.id, id)).run();
}

export type DraftRow = AppDraft & { fromImport: boolean };

export function getDraft(appId: string, tx: Db = db()): DraftRow | null {
  const r = tx.select().from(appDrafts).where(eq(appDrafts.appId, appId)).get();
  if (!r) return null;
  return { appId: r.appId, rev: r.rev, doc: r.doc, updatedAt: r.updatedAt.toISOString(), updatedBy: r.updatedBy, fromImport: r.fromImport };
}

export function writeDraft(tx: Db, appId: string, rev: number, doc: AppDocument, by: Principal, fromImport?: boolean): void {
  tx.update(appDrafts)
    .set({ rev, doc, updatedAt: new Date(), updatedBy: by, ...(fromImport !== undefined ? { fromImport } : {}) })
    .where(eq(appDrafts.appId, appId))
    .run();
  tx.update(apps).set({ draftRev: rev, updatedAt: new Date() }).where(eq(apps.id, appId)).run();
}

export function insertChange(tx: Db, c: DraftChange): void {
  tx.insert(appDraftChanges).values({ id: c.id, appId: c.appId, rev: c.rev, by: c.by, at: new Date(c.at), ops: c.ops, summary: c.summary, settled: false }).run();
}

function toChange(r: typeof appDraftChanges.$inferSelect): DraftChange {
  return { id: r.id, appId: r.appId, rev: r.rev, by: r.by, at: r.at.toISOString(), ops: r.ops as DraftOp[], summary: r.summary };
}

/** Draft changes since the last publish (or restore, or discard), oldest first. */
export function pendingChanges(appId: string, tx: Db = db()): DraftChange[] {
  return tx.select().from(appDraftChanges).where(and(eq(appDraftChanges.appId, appId), eq(appDraftChanges.settled, false))).orderBy(asc(appDraftChanges.rev)).all().map(toChange);
}

export function settleChanges(tx: Db, appId: string): void {
  tx.update(appDraftChanges).set({ settled: true }).where(and(eq(appDraftChanges.appId, appId), eq(appDraftChanges.settled, false))).run();
}

export type VersionRow = AppVersion & { publishedByName: string };

function toVersion(r: typeof appVersions.$inferSelect): VersionRow {
  return {
    appId: r.appId,
    version: r.version,
    doc: r.doc,
    publishedBy: r.publishedBy,
    publishedByName: r.publishedByName,
    publishedAt: r.publishedAt.toISOString(),
    ...(r.note ? { note: r.note } : {}),
    source: r.source,
    ...(r.restoredFrom != null ? { restoredFrom: r.restoredFrom } : {}),
  };
}

export function getVersion(appId: string, version: number, tx: Db = db()): VersionRow | null {
  const r = tx.select().from(appVersions).where(and(eq(appVersions.appId, appId), eq(appVersions.version, version))).get();
  return r ? toVersion(r) : null;
}

export function listVersions(appId: string, tx: Db = db()): VersionRow[] {
  return tx.select().from(appVersions).where(eq(appVersions.appId, appId)).orderBy(desc(appVersions.version)).all().map(toVersion);
}

export function latestVersionNumber(appId: string, tx: Db = db()): number {
  const r = tx.select({ v: appVersions.version }).from(appVersions).where(eq(appVersions.appId, appId)).orderBy(desc(appVersions.version)).limit(1).get();
  return r?.v ?? 0;
}

export function insertVersion(tx: Db, v: VersionRow): void {
  tx.insert(appVersions)
    .values({
      appId: v.appId,
      version: v.version,
      doc: v.doc,
      publishedBy: v.publishedBy,
      publishedByName: v.publishedByName,
      publishedAt: new Date(v.publishedAt),
      note: v.note ?? null,
      source: v.source,
      restoredFrom: v.restoredFrom ?? null,
    })
    .run();
}

export function deleteVersions(tx: Db, appId: string, versions: number[]): void {
  if (versions.length === 0) return;
  tx.delete(appVersions).where(and(eq(appVersions.appId, appId), inArray(appVersions.version, versions))).run();
}

/** Display names for user ids (read only from auth's user table). */
export function userNames(ids: string[], tx: Db = db()): Map<string, string> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  return new Map(tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique)).all().map((r) => [r.id, r.name]));
}

export type UserBrief = { id: string; name: string; email: string; role: "owner" | "member" | "viewer" };
export function allUsers(tx: Db = db()): UserBrief[] {
  return tx.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).orderBy(asc(users.createdAt)).all();
}

export function userRole(id: string, tx: Db = db()): "owner" | "member" | "viewer" | null {
  return tx.select({ role: users.role }).from(users).where(eq(users.id, id)).get()?.role ?? null;
}
