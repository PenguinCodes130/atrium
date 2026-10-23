// Saved themes (settings spec 3.3): create, read, update, duplicate and delete, with the stale check,
// the built-in ids kept out, the delete refusal when app drafts reference a theme, and the audit entry
// (Amendment 4 A4.4: settings.updated with target type "theme").
import "server-only";
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Principal, Theme } from "@/core/contracts";
import { db } from "@/core/db";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { write as audit } from "@/features/audit/write";
import { BUILT_IN_THEMES } from "@/features/shell";
import { themes as themeTable } from "@/db/schema/themes";
import { appPort } from "@/features/settings/app-port";
import { strictThemeIssues, type FieldIssue } from "./fields";
import { BUILT_IN_THEME_IDS, isBuiltInId, revalidateTheme, type BuiltInId } from "./revalidate";

export const STALE_MESSAGE = "This theme changed since you opened it";
export const MISSING_NOTICE = "Theme missing, showing Control Room";

const BUILT_INS: Record<BuiltInId, Theme> = Object.fromEntries(Object.values(BUILT_IN_THEMES).map((t) => [t.id, t])) as Record<BuiltInId, Theme>;

export function builtInTheme(id: string): Theme | null {
  return isBuiltInId(id) ? BUILT_INS[id] : null;
}

export function builtInThemes(): Theme[] {
  return BUILT_IN_THEME_IDS.map((id) => BUILT_INS[id]);
}

export class ThemeInvalid extends AtriumError {
  constructor(readonly issues: FieldIssue[]) {
    super(issues[0]?.message ?? "That theme is not valid.", 400, "invalid_theme");
  }
}
export class ThemeStale extends AtriumError {
  constructor(readonly rev: number) {
    super(STALE_MESSAGE, 409, "stale");
  }
}
export class ThemeInUse extends AtriumError {
  constructor(readonly apps: { appId: string; name: string }[]) {
    super(`This theme is used by ${apps.map((a) => a.name).join(", ")}. Choose another theme for ${apps.length === 1 ? "that app" : "those apps"} first.`, 409, "theme_in_use");
  }
}

export type SavedTheme = {
  id: string;
  name: string;
  rev: number;
  theme: Theme;
  /** How many stored values were invalid and replaced on this read (settings spec 3.5). */
  invalid: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};

type Row = typeof themeTable.$inferSelect;

function toSaved(r: Row): SavedTheme {
  const { theme, replaced } = revalidateTheme(r.theme, { id: r.id });
  return { id: r.id, name: theme.name, rev: r.rev, theme, invalid: replaced, createdById: r.createdById, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

export function listSavedThemes(): SavedTheme[] {
  return db().select().from(themeTable).orderBy(asc(themeTable.createdAt)).all().map(toSaved);
}

export function getSavedTheme(id: string): SavedTheme | null {
  const r = db().select().from(themeTable).where(eq(themeTable.id, id)).get();
  return r ? toSaved(r) : null;
}

/** A theme by id: a built-in, a saved theme, or null when it does not exist. */
export function themeById(id: string): { theme: Theme; invalid: number; builtIn: boolean } | null {
  const b = builtInTheme(id);
  if (b) return { theme: b, invalid: 0, builtIn: true };
  const s = getSavedTheme(id);
  return s ? { theme: s.theme, invalid: s.invalid, builtIn: false } : null;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function newThemeId(): string {
  const bytes = randomBytes(10);
  return `t-${[...bytes].map((b) => B32[b % 32]).join("")}`;
}

export function canEditThemes(p: Principal): boolean {
  return (p.kind === "user" || p.kind === "agent" || p.kind === "builtin-agent") && (p.role === "owner" || p.role === "member");
}

function requireEditor(p: Principal): Extract<Principal, { userId: string }> {
  if (!canEditThemes(p) || p.kind === "guest") throw new Forbidden("Only owners and members can change themes.");
  return p;
}

/** A name not used by any saved theme or built-in: "<name>", else "<name> (2)", "(3)"... */
export function uniqueName(name: string, exceptId?: string): string {
  const taken = new Set([...listSavedThemes().filter((t) => t.id !== exceptId).map((t) => t.name.toLowerCase()), ...builtInThemes().map((t) => t.name.toLowerCase())]);
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 1000; i++) {
    const n = `${name.slice(0, 74)} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return `${name.slice(0, 60)} (${Date.now()})`;
}

function auditTheme(p: Principal, action: "created" | "updated" | "deleted" | "imported" | "duplicated", t: { id: string; name: string }, detail: Record<string, unknown> = {}) {
  audit({ actor: p, event: "settings.updated", target: { type: "theme", id: t.id, label: t.name }, result: "ok", detail: { action, ...detail } });
}

/** Save a new theme from a person's input. Values are checked strictly (refused with the range named). */
export function createTheme(p: Principal, input: unknown, opts: { audit?: "created" | "imported" | "duplicated"; rename?: boolean } = {}): SavedTheme {
  const by = requireEditor(p);
  const issues = strictThemeIssues(input);
  if (issues.length) throw new ThemeInvalid(issues);
  const id = newThemeId();
  const { theme } = revalidateTheme(input, { id });
  const name = opts.rename ? uniqueName(theme.name) : theme.name;
  const stored: Theme = { ...theme, id, name };
  const now = new Date();
  db().insert(themeTable).values({ id, name, theme: stored, rev: 1, createdById: by.userId, createdAt: now, updatedAt: now }).run();
  auditTheme(p, opts.audit ?? "created", { id, name });
  return getSavedTheme(id)!;
}

/** Save over an existing theme. `expectRev` is the rev the editor opened; a newer one refuses with STALE_MESSAGE. */
export function updateTheme(p: Principal, id: string, input: unknown, expectRev: number): SavedTheme {
  requireEditor(p);
  if (isBuiltInId(id)) throw new Forbidden("Built-in themes cannot be edited. Duplicate it to make your own.");
  const row = db().select().from(themeTable).where(eq(themeTable.id, id)).get();
  if (!row) throw new NotFound("That theme does not exist.");
  if (row.rev !== expectRev) throw new ThemeStale(row.rev);
  const issues = strictThemeIssues(input);
  if (issues.length) throw new ThemeInvalid(issues);
  const { theme } = revalidateTheme(input, { id });
  const before = revalidateTheme(row.theme, { id }).theme;
  const now = new Date();
  // The rev check and the write are one statement, so two saves of the same rev cannot both win.
  const res = db()
    .update(themeTable)
    .set({ name: theme.name, theme, rev: row.rev + 1, updatedAt: now })
    .where(eq(themeTable.id, id))
    .run();
  if (res.changes !== 1) throw new ThemeStale(row.rev);
  auditTheme(p, "updated", { id, name: theme.name }, { changed: changedPaths(before, theme) });
  return getSavedTheme(id)!;
}

/** Which top-level token groups changed (for the audit detail; never a full dump). */
function changedPaths(a: Theme, b: Theme): string[] {
  const out: string[] = [];
  for (const k of ["name", "author", "mode", "customCss", "fonts", "dark"] as const) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  for (const k of Object.keys(b.tokens) as (keyof Theme["tokens"])[]) if (JSON.stringify(a.tokens[k]) !== JSON.stringify(b.tokens[k])) out.push(`tokens.${k}`);
  return out;
}

export function duplicateTheme(p: Principal, id: string): SavedTheme {
  const src = themeById(id);
  if (!src) throw new NotFound("That theme does not exist.");
  return createTheme(p, { ...src.theme, name: `${src.theme.name} copy`, author: src.builtIn ? "Atrium" : src.theme.author }, { audit: "duplicated", rename: true });
}

export type ThemeUse = { appId: string; slug: string; name: string; draft: boolean; published: boolean };

function refsIn(doc: { theme: unknown; pages: { theme?: unknown }[] }, id: string): boolean {
  const hit = (r: unknown) => !!r && typeof r === "object" && ("themeId" in r ? (r as { themeId: string }).themeId === id : "inline" in r && (r as { inline: { id?: string } }).inline?.id === id);
  return hit(doc.theme) || doc.pages.some((pg) => hit(pg.theme));
}

function draftRefs(doc: { theme: unknown; pages: { theme?: unknown }[] }, id: string): boolean {
  const hit = (r: unknown) => !!r && typeof r === "object" && "themeId" in r && (r as { themeId: string }).themeId === id;
  return hit(doc.theme) || doc.pages.some((pg) => hit(pg.theme));
}

/** Apps whose draft references the theme, or whose published version holds a copy of it. */
export async function themeUsage(id: string): Promise<ThemeUse[]> {
  const port = appPort();
  if (!port) return [];
  const apps = await port.listApps();
  return apps
    .map((a) => ({ appId: a.appId, slug: a.slug, name: a.name, draft: draftRefs(a.draft, id), published: !!a.published && refsIn(a.published.doc, id) }))
    .filter((u) => u.draft || u.published);
}

export async function deleteTheme(p: Principal, id: string): Promise<void> {
  requireEditor(p);
  if (isBuiltInId(id)) throw new Forbidden("Built-in themes cannot be deleted.");
  const row = getSavedTheme(id);
  if (!row) throw new NotFound("That theme does not exist.");
  const inDrafts = (await themeUsage(id)).filter((u) => u.draft);
  if (inDrafts.length) throw new ThemeInUse(inDrafts.map((u) => ({ appId: u.appId, name: u.name })));
  db().delete(themeTable).where(eq(themeTable.id, id)).run();
  auditTheme(p, "deleted", { id, name: row.name });
}

/**
 * "Update apps using this theme" (architecture 4.9): every app whose published version holds a copy of
 * this theme gets its draft pointed at the saved theme, through app-builder's applyOps, so the next
 * publish carries it. Published versions are never touched.
 */
export async function updateAppsUsingTheme(p: Principal, id: string, appIds?: string[]): Promise<{ updated: { appId: string; name: string; rev: number }[] }> {
  requireEditor(p);
  const port = appPort();
  if (!port) throw new AtriumError("Apps are not available yet.", 503, "not_available");
  if (!themeById(id)) throw new NotFound("That theme does not exist.");
  const uses = (await themeUsage(id)).filter((u) => u.published && (!appIds || appIds.includes(u.appId)));
  const updated: { appId: string; name: string; rev: number }[] = [];
  for (const u of uses) {
    const app = await port.getApp(u.appId);
    if (!app) continue;
    const ops = themeOpsFor(app.published!.doc, app.draft, id);
    if (!ops.length) continue;
    const r = await port.applyOps(app.appId, app.draftRev, ops, p);
    updated.push({ appId: app.appId, name: app.name, rev: r.rev });
  }
  return { updated };
}

/** The draft ops that point every place the published doc used this theme at the saved theme. */
export function themeOpsFor(published: { theme: unknown; pages: { id: string; theme?: unknown }[] }, draft: { theme: unknown; pages: { id: string; theme?: unknown }[] }, id: string) {
  const ops: ({ op: "theme.set"; theme: { themeId: string } } | { op: "page.update"; pageId: string; patch: { theme: { themeId: string } } })[] = [];
  const used = (r: unknown) => !!r && typeof r === "object" && "inline" in r && (r as { inline: { id?: string } }).inline?.id === id;
  if (used(published.theme)) ops.push({ op: "theme.set", theme: { themeId: id } });
  for (const pg of published.pages) if (used(pg.theme) && draft.pages.some((d) => d.id === pg.id)) ops.push({ op: "page.update", pageId: pg.id, patch: { theme: { themeId: id } } });
  return ops;
}

/** "Used by" for every theme at once: theme id to the apps whose draft or published version uses it. */
export async function usageMap(): Promise<Record<string, ThemeUse[]>> {
  const port = appPort();
  if (!port) return {};
  const out: Record<string, ThemeUse[]> = {};
  const apps = await port.listApps();
  const ids = new Set<string>();
  const collect = (r: unknown) => {
    if (r && typeof r === "object") {
      if ("themeId" in r && typeof (r as { themeId: unknown }).themeId === "string") ids.add((r as { themeId: string }).themeId);
      if ("inline" in r && typeof (r as { inline?: { id?: unknown } }).inline?.id === "string") ids.add((r as { inline: { id: string } }).inline.id);
    }
  };
  for (const a of apps) for (const d of [a.draft, a.published?.doc]) if (d) [d.theme, ...d.pages.map((p) => p.theme)].forEach(collect);
  for (const id of ids) {
    const uses = apps
      .map((a) => ({ appId: a.appId, slug: a.slug, name: a.name, draft: draftRefs(a.draft, id), published: !!a.published && refsIn(a.published.doc, id) }))
      .filter((u) => u.draft || u.published);
    if (uses.length) out[id] = uses;
  }
  return out;
}
