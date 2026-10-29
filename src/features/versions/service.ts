// Publish, restore and versions (architecture v3 section 4.9; spec section 3 "Publish", "Versions").
// Publishing and restoring are session-only; every refusal names its reason.
import "server-only";
import type { App, AppDocument, DraftChange, Principal, Problem, ThemeRef } from "@/core/contracts";
import { transaction } from "@/core/db";
import { Forbidden, NotFound } from "@/core/errors";
import { audit } from "@/features/audit/write";
import { isSessionPerson, SESSION_ONLY_MESSAGE } from "@/features/apps/access";
import { controlLines, cssWarnings, dataReviewWarnings, guestWarnings, validateDocument, type ControlLine } from "@/features/apps/checks";
import { snapshotTheme } from "@/features/apps/deps";
import { clone, findNode, sameJson } from "@/features/apps/doc";
import { DraftConflict, FieldError, Invalid } from "@/features/apps/errors";
import { versionRetention } from "@/features/apps/hooks";
import { readableDocument } from "@/features/apps/view";
import * as repo from "@/features/apps/repo";
import { appForEditor, appForViewer, syncIdentity } from "@/features/apps/service";
import { diffDocuments, readableDiff, type DiffGroup } from "./diff";
import { versionsToPrune } from "./retention";
export { versionsToPrune };

export const DRAFT_CHANGED = "The draft changed; review again";

export type ChangeAuthor = { kind: "person" | "agent"; name: string; count: number };
export type ReviewChange = { rev: number; at: string; by: string; agent: boolean; summary: string; nodes: string[] };

export type Review = {
  appId: string;
  rev: number;
  against: number | null; // the live version number, or null when nothing is published
  groups: DiffGroup[];
  changes: ReviewChange[];
  authors: ChangeAuthor[];
  controls: ControlLine[];
  problems: Problem[];
  canPublish: boolean;
  restoring?: number;
  discardsDraftChanges?: boolean;
  /** Round 2 item 8: saved themes changed since the live version (only on the draft review). */
  themeChanges?: ThemeChange[];
};

function principalName(p: Principal, names: Map<string, string>): { name: string; agent: boolean } {
  if (p.kind === "agent") return { name: p.agentName, agent: true };
  if (p.kind === "builtin-agent") return { name: "Setup agent", agent: true };
  if (p.kind === "guest") return { name: p.label, agent: false };
  return { name: names.get(p.userId) ?? "Someone", agent: false };
}

export function describeChanges(changes: DraftChange[]): { changes: ReviewChange[]; authors: ChangeAuthor[] } {
  const ids = changes.flatMap((c) => (c.by.kind === "guest" ? [] : [c.by.userId]));
  const names = repo.userNames(ids);
  const counts = new Map<string, ChangeAuthor>();
  const out: ReviewChange[] = changes.map((c) => {
    const who = principalName(c.by, names);
    const key = `${who.agent ? "a" : "p"}:${who.name}`;
    const a = counts.get(key) ?? { kind: who.agent ? "agent" : "person", name: who.name, count: 0 };
    a.count++;
    counts.set(key, a);
    const nodes = c.ops.flatMap((op) => (op.op === "node.add" ? [op.node.id] : []));
    return { rev: c.rev, at: c.at, by: who.name, agent: who.agent, summary: c.summary, nodes };
  });
  return { changes: out, authors: [...counts.values()] };
}

/** Node ids added by agents since the last publish: the builder's Layers `agent` tag. */
export function agentNodeIds(appId: string): string[] {
  const out = new Set<string>();
  for (const c of repo.pendingChanges(appId)) {
    if (c.by.kind !== "agent" && c.by.kind !== "builtin-agent") continue;
    for (const op of c.ops) if (op.op === "node.add") for (const id of [op.node.id]) out.add(id);
  }
  return [...out];
}

function liveDoc(app: App): AppDocument | null {
  return app.publishedVersion != null ? repo.getVersion(app.id, app.publishedVersion)?.doc ?? null : null;
}

function buildReview(p: Principal, app: App, next: AppDocument, rev: number, changes: DraftChange[], extra: Partial<Review> = {}): Review {
  const live = liveDoc(app);
  const diff = diffDocuments(live, next);
  const { changes: list, authors } = describeChanges(changes);
  const problems = [...validateDocument(next, p), ...guestWarnings(next, app.access.guests), ...cssWarnings(next), ...dataReviewWarnings(next)];
  return {
    appId: app.id,
    rev,
    against: app.publishedVersion ?? null,
    groups: readableDiff(live, next, diff),
    changes: list,
    authors,
    controls: controlLines(live, next),
    problems,
    canPublish: isSessionPerson(p) && !problems.some((x) => x.severity === "error"),
    ...extra,
  };
}

/**
 * Round 2 item 8 (design v4 Note 3, "Theme after publish"): published apps keep their theme snapshot (4.9),
 * so a saved theme edited since the last publish is a change the app has not shown yet. One entry per
 * theme the draft names by id whose saved copy now differs from the live version's snapshot of it.
 */
export type ThemeChange = { themeId: string; name: string; pageId: string | null; version: number };

export async function themeChangesSincePublish(app: App, draftDoc?: AppDocument): Promise<ThemeChange[]> {
  if (app.publishedVersion == null) return [];
  const live = repo.getVersion(app.id, app.publishedVersion)?.doc;
  const doc = draftDoc ?? repo.getDraft(app.id)?.doc;
  if (!live || !doc) return [];
  const version = app.publishedVersion;
  const pairs: { ref: ThemeRef | undefined; old: ThemeRef | undefined; pageId: string | null }[] = [
    { ref: doc.theme, old: live.theme, pageId: null },
    ...doc.pages.map((pg) => ({ ref: pg.theme, old: live.pages.find((x) => x.id === pg.id)?.theme, pageId: pg.id })),
  ];
  const out: ThemeChange[] = [];
  const seen = new Set<string>();
  for (const { ref, old, pageId } of pairs) {
    if (!ref || !old || "inline" in ref || !("inline" in old) || old.inline?.id !== ref.themeId) continue;
    const key = `${ref.themeId}|${pageId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const now = await snapshotTheme(ref);
    if (now.id === ref.themeId && !sameJson(now, old.inline)) out.push({ themeId: ref.themeId, name: now.name, pageId, version });
  }
  return out;
}

/** The review's line for a theme changed since the live version (Note 3). */
export function themeChangeLine(c: ThemeChange): string {
  return `Theme ${c.name} changed since v${c.version}: publish to show it to viewers`;
}

/** The publish review with the theme changes since the live version added to the App group (Note 3). */
export async function reviewDraftWithThemes(p: Principal, appId: string): Promise<Review> {
  const review = reviewDraft(p, appId);
  const app = appForEditor(p, appId);
  const changes = await themeChangesSincePublish(app);
  if (!changes.length) return { ...review, themeChanges: changes };
  const lines = changes.map((c) => ({ kind: "changed" as const, text: themeChangeLine(c) }));
  const groups = review.groups[0]?.pageId === null ? [{ ...review.groups[0], lines: [...review.groups[0].lines, ...lines] }, ...review.groups.slice(1)] : [{ pageId: null, title: "App", lines }, ...review.groups];
  return { ...review, groups, themeChanges: changes };
}

/**
 * For settings (Note 3, "Used by N published apps"): the published apps that show an older copy of this
 * saved theme than the one saved now, each with the address of its publish review. Pass the apps the
 * person may edit; nothing here checks access.
 */
export async function publishedAppsBehindTheme(themeId: string, apps: readonly App[]): Promise<{ appId: string; slug: string; name: string; version: number; reviewHref: string }[]> {
  const out: { appId: string; slug: string; name: string; version: number; reviewHref: string }[] = [];
  for (const app of apps) {
    const changes = await themeChangesSincePublish(app);
    if (changes.some((c) => c.themeId === themeId)) out.push({ appId: app.id, slug: app.slug, name: app.name, version: app.publishedVersion!, reviewHref: `/build/${app.slug}?review=1` });
  }
  return out;
}

/** The publish review sheet for the draft. Anyone who can edit may read it; only a person may publish. */
export function reviewDraft(p: Principal, appId: string): Review {
  const app = appForEditor(p, appId);
  const draft = repo.getDraft(app.id);
  if (!draft) throw new NotFound("This app has no draft.");
  return buildReview(p, app, draft.doc, draft.rev, repo.pendingChanges(app.id));
}

/** The review for restoring a version: diff against the live version, controls it would bring back. */
export function reviewRestore(p: Principal, appId: string, version: number): Review {
  const app = appForEditor(p, appId);
  const v = repo.getVersion(app.id, version);
  if (!v) throw new NotFound(`Version ${version} does not exist.`);
  const draft = repo.getDraft(app.id)!;
  const pending = repo.pendingChanges(app.id);
  return buildReview(p, app, v.doc, draft.rev, [], { restoring: version, discardsDraftChanges: pending.length > 0 });
}

async function snapshotRef(ref: ThemeRef): Promise<ThemeRef> {
  if ("inline" in ref) return ref;
  return { inline: await snapshotTheme(ref) };
}

/** Every theme reference becomes an inline copy, so later theme edits never change the version (4.9). */
export async function snapshotThemes(doc: AppDocument): Promise<AppDocument> {
  const out = clone(doc);
  out.theme = await snapshotRef(out.theme);
  for (const page of out.pages) if (page.theme) page.theme = await snapshotRef(page.theme);
  return out;
}

function personName(p: Extract<Principal, { kind: "user" }>): string {
  return repo.userNames([p.userId]).get(p.userId) ?? "";
}

function prune(appId: string, published: number): number[] {
  const all = repo.listVersions(appId).map((v) => v.version);
  const gone = versionsToPrune(all, published, versionRetention());
  if (gone.length) transaction((tx) => repo.deleteVersions(tx, appId, gone));
  return gone;
}

export type PublishInput = { expectRev: number; note?: string };

/** Publishes the draft as version N+1 (session only, editors). Refused when the draft moved since the review. */
export async function publishDraft(p: Principal, appId: string, input: PublishInput): Promise<{ version: number; pruned: number[] }> {
  if (!isSessionPerson(p)) throw new Forbidden(SESSION_ONLY_MESSAGE.publish);
  const app = appForEditor(p, appId);
  const draft = repo.getDraft(app.id);
  if (!draft) throw new NotFound("This app has no draft.");
  if (!Number.isInteger(input.expectRev) || input.expectRev !== draft.rev) throw new DraftConflict(draft.rev, DRAFT_CHANGED);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
  const problems = validateDocument(draft.doc, p).filter((x) => x.severity === "error");
  if (problems.length) throw new Invalid(problems, `This version has ${problems.length} problem${problems.length === 1 ? "" : "s"} to fix before it can be published.`);
  const doc = await snapshotThemes(draft.doc);
  const at = new Date().toISOString();
  let version = 0;
  transaction((tx) => {
    const current = repo.getDraft(app.id, tx);
    if (!current || current.rev !== input.expectRev) throw new DraftConflict(current?.rev ?? draft.rev, DRAFT_CHANGED);
    version = repo.latestVersionNumber(app.id, tx) + 1;
    repo.insertVersion(tx, { appId: app.id, version, doc, publishedBy: p.userId, publishedByName: personName(p), publishedAt: at, ...(note ? { note } : {}), source: current.fromImport ? "import" : "publish" });
    repo.updateApp(tx, app.id, { publishedVersion: version });
    repo.settleChanges(tx, app.id);
    if (current.fromImport) repo.writeDraft(tx, app.id, current.rev, current.doc, current.updatedBy, false);
    syncIdentity(tx, app, doc);
  });
  audit.write({ actor: p, event: "app.published", target: { type: "app", id: app.id, label: app.name }, result: "ok", detail: { version, rev: draft.rev, note: note || null } });
  return { version, pruned: prune(app.id, version) };
}

/** Restores a version through the same review: publishes a copy tagged restore and resets the draft to it. */
export async function restoreVersion(p: Principal, appId: string, version: number, input: PublishInput): Promise<{ version: number; rev: number; pruned: number[] }> {
  if (!isSessionPerson(p)) throw new Forbidden(SESSION_ONLY_MESSAGE.restore);
  const app = appForEditor(p, appId);
  const v = repo.getVersion(app.id, version);
  if (!v) throw new NotFound(`Version ${version} does not exist.`);
  const draft = repo.getDraft(app.id)!;
  if (!Number.isInteger(input.expectRev) || input.expectRev !== draft.rev) throw new DraftConflict(draft.rev, DRAFT_CHANGED);
  const problems = validateDocument(v.doc, p).filter((x) => x.severity === "error");
  if (problems.length) throw new Invalid(problems, `Version ${version} has ${problems.length} problem${problems.length === 1 ? "" : "s"} today, so it cannot be restored as it is.`);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : `Restored v${version}`;
  const at = new Date().toISOString();
  let next = 0;
  const rev = draft.rev + 1;
  transaction((tx) => {
    const current = repo.getDraft(app.id, tx);
    if (!current || current.rev !== input.expectRev) throw new DraftConflict(current?.rev ?? draft.rev, DRAFT_CHANGED);
    next = repo.latestVersionNumber(app.id, tx) + 1;
    repo.insertVersion(tx, { appId: app.id, version: next, doc: clone(v.doc), publishedBy: p.userId, publishedByName: personName(p), publishedAt: at, note, source: "restore", restoredFrom: version });
    repo.updateApp(tx, app.id, { publishedVersion: next });
    repo.writeDraft(tx, app.id, rev, clone(v.doc), p, false);
    repo.settleChanges(tx, app.id);
    syncIdentity(tx, app, v.doc);
  });
  audit.write({ actor: p, event: "app.restored", target: { type: "app", id: app.id, label: app.name }, result: "ok", detail: { version: next, restoredFrom: version } });
  return { version: next, rev, pruned: prune(app.id, next) };
}

export type VersionCard = { version: number; by: string; at: string; note?: string; source: string; restoredFrom?: number; live: boolean };

export function listVersionCards(p: Principal, appId: string): VersionCard[] {
  const app = appForEditor(p, appId);
  return repo.listVersions(app.id).map((v) => ({ version: v.version, by: v.publishedByName || "Someone", at: v.publishedAt, ...(v.note ? { note: v.note } : {}), source: v.source, ...(v.restoredFrom != null ? { restoredFrom: v.restoredFrom } : {}), live: v.version === app.publishedVersion }));
}

/**
 * One version's document, for anyone who can open the app (versions.get; read). Non-editors get the
 * same filtered document the viewer page sends them (`readableDocument`): no control run details.
 */
export function getVersionDoc(p: Principal, appId: string, version: number): AppDocument {
  const app = appForViewer(p, appId);
  const v = repo.getVersion(app.id, version);
  if (!v) throw new NotFound(`Version ${version} does not exist.`);
  return readableDocument(app, p, v.doc);
}

/** Readable diff between two versions (or a version and the draft, `b === "draft"`). */
export function diffVersions(p: Principal, appId: string, a: number | null, b: number | "draft"): { groups: DiffGroup[] } {
  const app = appForEditor(p, appId);
  const docA = a == null ? null : repo.getVersion(app.id, a)?.doc ?? null;
  if (a != null && !docA) throw new NotFound(`Version ${a} does not exist.`);
  const docB = b === "draft" ? repo.getDraft(app.id)!.doc : repo.getVersion(app.id, b)?.doc;
  if (!docB) throw new NotFound(`Version ${b} does not exist.`);
  return { groups: readableDiff(docA, docB) };
}

export function nodeExists(doc: AppDocument, id: string): boolean {
  return !!findNode(doc, id);
}

export { FieldError };
