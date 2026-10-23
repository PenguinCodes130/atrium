// App CRUD, the shared draft and access changes (architecture v3 sections 4.2, 4.9, 5.1, 7; amendments
// A1.1, A4.1, A4.3). Every function takes the acting principal and checks it here, whatever the caller.
import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type { App, AppDocument, AuditEvent, DraftOp, LibraryComponent, Principal, UserSet } from "@/core/contracts";
import { db, transaction } from "@/core/db";
import { Forbidden, NotFound } from "@/core/errors";
import { logger } from "@/core/log";
import { audit } from "@/features/audit/write";
import { auditLog } from "@/db/schema/audit";
import { revokeAppGuestLinks, revokeCreatorGuestLinks } from "@/features/auth/guest/store";
import { canCreate, canDelete, canEdit, canOpen, isSessionPerson, SESSION_ONLY_MESSAGE } from "./access";
import { opChecks } from "./checks";
import { detachInstance } from "./deps";
import { allNodes, blankDocument, clone, slugProblem } from "./doc";
import { DraftConflict, FieldError, Invalid } from "./errors";
import { layoutAutoApply } from "./hooks";
import { applyOpsToDoc, isLayoutOnly, summarize } from "./ops";
import * as repo from "./repo";
import { templateDocument, type TemplateId } from "./templates";

const log = logger("apps");
export const DRAFT_AUDIT_WINDOW_MS = 10 * 60 * 1000;
export const NOTHING_PUBLISHED = "Nothing published to go back to. Delete the app instead.";

function account(p: Principal): Exclude<Principal, { kind: "guest" }> {
  if (p.kind === "guest") throw new Forbidden("Guests can only view their app.");
  return p;
}

/** The app for an editor, or a not-found error that does not reveal whether it exists. */
export function appForEditor(p: Principal, appId: string): App {
  const app = repo.getApp(appId);
  if (!app || !canOpen(app, p)) throw new NotFound("This app does not exist.");
  if (!canEdit(app, p)) throw new Forbidden("You can view this app but not change it.");
  return app;
}

export function appForViewer(p: Principal, appId: string): App {
  const app = repo.getApp(appId);
  if (!app || !canOpen(app, p)) throw new NotFound("This app does not exist.");
  return app;
}

// ---- Create ----

export type CreateInput = { name: string; slug?: string; template?: TemplateId; mappings?: Record<string, string | null> };

export function createApp(p: Principal, input: CreateInput, opts: { doc?: AppDocument; fromImport?: boolean; event?: AuditEvent } = {}): { app: App; rev: number } {
  if (!canCreate(p)) throw new Forbidden("Only owners and members can create apps.");
  const a = account(p);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new FieldError("name", "Give the app a name.");
  if (name.length > 80) throw new FieldError("name", "The app name can be at most 80 characters.");
  const slug = input.slug ?? "";
  const sp = slugProblem(slug);
  if (sp) throw new FieldError("slug", sp);
  if (repo.slugExists(slug)) throw new FieldError("slug", `"${slug}" is already taken. Pick another URL name.`);
  const doc = opts.doc ?? (input.template && input.template !== "blank" ? templateDocument(input.template, name, input.mappings ?? {}, a) : blankDocument(name));
  doc.app.name = name;
  if (doc.chrome.title === undefined || opts.doc === undefined) doc.chrome.title = name;
  const now = new Date().toISOString();
  const app: App = {
    id: `a_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    slug,
    name,
    access: { view: "owner", edit: a.role === "owner" ? "owner" : { userIds: [a.userId] }, guests: false },
    draftRev: 1,
    createdBy: a.userId,
    createdAt: now,
    updatedAt: now,
  };
  transaction((tx) => {
    if (repo.slugExists(slug, tx)) throw new FieldError("slug", `"${slug}" is already taken. Pick another URL name.`);
    repo.insertApp(tx, app, doc, p, !!opts.fromImport);
  });
  audit.write({ actor: p, event: opts.event ?? "app.created", target: { type: "app", id: app.id, label: name }, result: "ok", detail: { slug, template: input.template ?? "blank" } });
  if (p.kind === "agent" || p.kind === "builtin-agent") audit.write({ actor: p, event: "app.draft_changed", target: { type: "app", id: app.id, label: name }, result: "ok", detail: { rev: 1, summary: "Created the app" } });
  log.info("App created", { appId: app.id, slug });
  return { app, rev: 1 };
}

// ---- The draft ----

export type ApplyInput = { appId: string; ops: DraftOp[]; by: Principal; expectRev?: number };

/** Validates and applies one batch in a transaction, bumps rev and records a DraftChange (section 4.9). */
export function applyDraftOps({ appId, ops, by, expectRev }: ApplyInput): { rev: number; changed: string[]; version?: number } {
  const app = appForEditor(by, appId);
  const draft = repo.getDraft(app.id);
  if (!draft) throw new NotFound("This app has no draft.");
  if (expectRev !== undefined && expectRev !== draft.rev) throw new DraftConflict(draft.rev);
  const result = applyOpsToDoc(draft.doc, ops, opChecks(by));
  if (!result.ok) throw new Invalid(result.problems);
  const summary = summarize(draft.doc, ops) || "Changed the draft";
  const rev = draft.rev + 1;
  const at = new Date().toISOString();
  let version: number | undefined;
  transaction((tx) => {
    const current = repo.getDraft(app.id, tx);
    if (!current || current.rev !== draft.rev) throw new DraftConflict(current?.rev ?? draft.rev);
    repo.writeDraft(tx, app.id, rev, result.doc, by);
    repo.insertChange(tx, { id: randomUUID(), appId: app.id, rev, by, at, ops, summary });
    // Until the first publish, the launcher's name and icon follow the draft (then they follow versions).
    if (app.publishedVersion == null) syncIdentity(tx, app, result.doc);
    // Layout auto-apply (section 4.9): moves within the same parent go to the live document too.
    if (layoutAutoApply(by) && app.publishedVersion != null) {
      const live = repo.getVersion(app.id, app.publishedVersion, tx);
      if (live && isLayoutOnly(live.doc, ops)) {
        const applied = applyOpsToDoc(live.doc, ops);
        if (applied.ok) {
          version = repo.latestVersionNumber(app.id, tx) + 1;
          const a = by as Extract<Principal, { kind: "agent" }>;
          repo.insertVersion(tx, { appId: app.id, version, doc: applied.doc, publishedBy: a.userId, publishedByName: a.agentName, publishedAt: at, note: `Layout by ${a.agentName}`, source: "agent-layout" });
          repo.updateApp(tx, app.id, { publishedVersion: version });
        }
      }
    }
  });
  auditDraftChange(by, app, rev, summary);
  if (version !== undefined) audit.write({ actor: by, event: "app.published", target: { type: "app", id: app.id, label: app.name }, result: "ok", detail: { version, source: "agent-layout" } });
  return { rev, changed: result.changed, ...(version !== undefined ? { version } : {}) };
}

/** The App row's name and icon mirror the document a person sees on the launcher. */
export function syncIdentity(tx: Parameters<typeof repo.updateApp>[0], app: App, doc: AppDocument): void {
  const name = doc.app.name?.trim() || app.name;
  const icon = doc.app.icon ?? null;
  if (name !== app.name || icon !== (app.icon ?? null)) repo.updateApp(tx, app.id, { name, icon });
}

/** The agreed export (wave-2-lead-prep.md): apply ops at an expected revision. */
export async function applyOps(appId: string, rev: number, ops: DraftOp[], by: Principal): Promise<{ rev: number }> {
  const r = applyDraftOps({ appId, ops, by, expectRev: rev });
  return { rev: r.rev };
}

/** Section 7: every agent change is audited; a person's at most once per 10 minutes per app. */
function auditDraftChange(by: Principal, app: App, rev: number, summary: string): void {
  if (by.kind === "user") {
    const since = new Date(Date.now() - DRAFT_AUDIT_WINDOW_MS);
    const recent = db()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.event, "app.draft_changed"), eq(auditLog.targetId, app.id), eq(auditLog.actorUserId, by.userId), eq(auditLog.actorKind, "user"), gte(auditLog.at, since)))
      .orderBy(desc(auditLog.at))
      .limit(1)
      .get();
    if (recent) return;
  }
  audit.write({ actor: by, event: "app.draft_changed", target: { type: "app", id: app.id, label: app.name }, result: "ok", detail: { rev, summary } });
}

export function getDraftFor(p: Principal, appId: string) {
  const app = appForEditor(p, appId);
  const draft = repo.getDraft(app.id);
  if (!draft) throw new NotFound("This app has no draft.");
  return { app, draft };
}

// ---- Access (session only) ----

export type AccessInput = { view: UserSet; edit: UserSet; guests: boolean };

function cleanSet(set: unknown, known: Set<string>): UserSet {
  if (set === "owner" || set === "everyone") return set;
  if (set && typeof set === "object" && Array.isArray((set as { userIds?: unknown }).userIds)) {
    const ids = [...new Set((set as { userIds: unknown[] }).userIds.filter((x): x is string => typeof x === "string" && known.has(x)))];
    return ids.length ? { userIds: ids } : "owner";
  }
  throw new FieldError("access", "Choose who can open and who can edit the app.");
}

/** Members who could edit under `set` (owners always can, so they never lose it). */
function editingMembers(set: UserSet, users: repo.UserBrief[]): Set<string> {
  const members = users.filter((u) => u.role === "member").map((u) => u.id);
  if (set === "owner") return new Set();
  if (set === "everyone") return new Set(members);
  return new Set(set.userIds.filter((id) => members.includes(id)));
}

export function updateAccess(p: Principal, appId: string, input: AccessInput): { app: App; revokedLinks: number } {
  if (!isSessionPerson(p)) throw new Forbidden(SESSION_ONLY_MESSAGE.access);
  const app = appForEditor(p, appId);
  const users = repo.allUsers();
  const known = new Set(users.map((u) => u.id));
  const next: AccessInput = { view: cleanSet(input.view, known), edit: cleanSet(input.edit, known), guests: input.guests === true };
  transaction((tx) => repo.updateApp(tx, app.id, { accessView: next.view, accessEdit: next.edit, accessGuests: next.guests }));
  let revokedLinks = 0;
  if (app.access.guests && !next.guests) revokedLinks += revokeAppGuestLinks(app.id, "guests_off", p);
  // A1.1: a member who loses edit access (without being demoted) loses their guest links on this app.
  const before = editingMembers(app.access.edit, users);
  const after = editingMembers(next.edit, users);
  for (const id of before) if (!after.has(id)) revokedLinks += revokeCreatorGuestLinks(id, "creator_lost_edit", p, app.id);
  audit.write({ actor: p, event: "app.access_changed", target: { type: "app", id: app.id, label: app.name }, result: "ok", detail: { before: app.access, after: next, revokedLinks } });
  return { app: repo.getApp(app.id)!, revokedLinks };
}

// ---- Delete (owner or creator, session, after a step-up the route checks) ----

export function deleteApp(p: Principal, appId: string, confirmName: string): void {
  if (!isSessionPerson(p)) throw new Forbidden(SESSION_ONLY_MESSAGE.delete);
  const app = appForViewer(p, appId);
  if (!canDelete(app, p)) throw new Forbidden("Only the owner and the person who created this app can delete it.");
  if (typeof confirmName !== "string" || confirmName.trim() !== app.name) throw new FieldError("confirm", `Type the app's name, ${app.name}, to delete it.`);
  const revoked = revokeAppGuestLinks(app.id, "app_deleted", p);
  transaction((tx) => repo.deleteAppRow(tx, app.id));
  audit.write({ actor: p, event: "app.deleted", target: { type: "app", id: app.id, label: app.name }, result: "ok", detail: { slug: app.slug, revokedLinks: revoked } });
}

// ---- Discard the draft (A4.3) ----

export function discardDraft(p: Principal, appId: string): { rev: number } {
  if (!isSessionPerson(p)) throw new Forbidden(SESSION_ONLY_MESSAGE.discard);
  const app = appForEditor(p, appId);
  if (app.publishedVersion == null) throw new FieldError("draft", NOTHING_PUBLISHED, 409);
  const live = repo.getVersion(app.id, app.publishedVersion);
  const draft = repo.getDraft(app.id);
  if (!live || !draft) throw new NotFound("This app has no published version.");
  const rev = draft.rev + 1;
  transaction((tx) => {
    repo.writeDraft(tx, app.id, rev, clone(live.doc), p, false);
    repo.settleChanges(tx, app.id);
  });
  // A4.3 names the event app.draft_discarded; the frozen AuditEvent list does not have it yet (shared file request).
  audit.write({ actor: p, event: "app.draft_discarded" as AuditEvent, target: { type: "app", id: app.id, label: app.name }, result: "ok", detail: { rev, resetTo: app.publishedVersion } });
  return { rev };
}

// ---- Lists ----

export function appsFor(p: Principal | null): App[] {
  if (!p || p.kind === "guest") return [];
  return repo.listApps().filter((a) => canOpen(a, p));
}

export type LauncherTile = { app: App; pageCount: number; dirty: boolean; canEdit: boolean };

/** Launcher tiles: the apps the user can open, with page count and the draft dot for editors. */
export function launcherTiles(p: Principal): LauncherTile[] {
  return appsFor(p).map((app) => {
    const editable = canEdit(app, p);
    const draft = repo.getDraft(app.id);
    const live = app.publishedVersion != null ? repo.getVersion(app.id, app.publishedVersion) : null;
    const pageCount = (live?.doc ?? draft?.doc)?.pages.length ?? 0;
    const dirty = editable && repo.pendingChanges(app.id).length > 0;
    return { app, pageCount, dirty, canEdit: editable };
  });
}

// ---- Library delete (A4.1, components SFR-6) ----

/**
 * Deleting a library component turns every pinned instance in every app draft into a detached copy
 * (its current params inlined), so no app breaks: one draft change per app, made by the person who
 * deleted it. Published versions keep their pins (the library keeps deleted versions readable).
 * Returns the number of instances detached.
 */
export function detachLibraryInstances(componentId: string, versions: LibraryComponent[], by: Principal): number {
  const byVersion = new Map(versions.map((v) => [v.version, v]));
  let total = 0;
  for (const app of repo.listApps()) {
    // A draft that moves on between the read and the write is read again (at most three tries).
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = detachInDraft(app, componentId, byVersion, by);
      if (r === "retry") continue;
      total += r;
      break;
    }
  }
  return total;
}

function detachInDraft(app: App, componentId: string, byVersion: Map<number, LibraryComponent>, by: Principal): number | "retry" {
  const draft = repo.getDraft(app.id);
  if (!draft) return 0;
  const ops: DraftOp[] = [];
  let name = "";
  for (const l of allNodes(draft.doc)) {
    const ref = l.node.libraryRef;
    const lib = ref && ref.componentId === componentId ? byVersion.get(ref.version) : undefined;
    if (!lib || !l.parent) continue;
    name = lib.name;
    ops.push({ op: "node.remove", nodeId: l.node.id }, { op: "node.add", parentId: l.parent.id, index: l.index, node: { ...detachInstance(l.node, lib), ...(l.node.slot ? { slot: l.node.slot } : {}) } });
  }
  if (!ops.length) return 0;
  const result = applyOpsToDoc(draft.doc, ops);
  if (!result.ok) {
    log.warn("library instances could not be detached", { appId: app.id, componentId, problem: result.problems[0]?.message });
    return 0;
  }
  const count = ops.length / 2;
  const summary = `Detached ${count === 1 ? "one copy" : `${count} copies`} of ${name} (deleted from the library)`;
  const rev = draft.rev + 1;
  const written = transaction((tx) => {
    const current = repo.getDraft(app.id, tx);
    if (!current || current.rev !== draft.rev) return false;
    repo.writeDraft(tx, app.id, rev, result.doc, by);
    repo.insertChange(tx, { id: randomUUID(), appId: app.id, rev, by, at: new Date().toISOString(), ops, summary });
    return true;
  });
  if (!written) return "retry";
  auditDraftChange(by, app, rev, summary);
  return count;
}
