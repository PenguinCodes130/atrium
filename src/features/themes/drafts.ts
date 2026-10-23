// Theme drafts (architecture 9b.3; settings spec 3.3 "Agent drafts"). A theme created or changed by an
// agent arrives as a draft: shown on the Themes screen and in the Drafts tray with its preview, its
// contrast report and "Proposed by <agent>". Only a signed-in person publishes or discards it (both
// audited); no tool can. Until it is published it affects no app.
import "server-only";
import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Principal, Theme } from "@/core/contracts";
import { db } from "@/core/db";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { write as audit } from "@/features/audit/write";
import { contrastReport, type ContrastReport } from "@/features/shell";
import { themeDrafts } from "@/db/schema/themes";
import { revalidateTheme } from "./revalidate";
import { canEditThemes, createTheme, getSavedTheme, updateTheme, type SavedTheme } from "./store";

export type ThemeDraftView = {
  id: string;
  targetId: string | null;
  /** The theme as it would be after publishing (revalidated). */
  theme: Theme;
  invalid: number;
  contrast: ContrastReport;
  proposedBy: string;
  createdAt: string;
  status: "open" | "published" | "discarded";
  note: string | null;
};

/** JSON Merge Patch (RFC 7396). */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base;
}

function agentName(p: Principal): string {
  if (p.kind === "agent") return p.agentName;
  if (p.kind === "builtin-agent") return "setup agent";
  return "a person";
}

type Row = typeof themeDrafts.$inferSelect;

function proposed(r: Row): { theme: Theme; invalid: number } {
  if (!r.targetId) return (({ theme, replaced }) => ({ theme, invalid: replaced }))(revalidateTheme(r.patch, { id: `draft-${r.id.slice(0, 10)}` }));
  const target = getSavedTheme(r.targetId);
  const merged = mergePatch(target?.theme ?? {}, r.patch);
  const { theme, replaced } = revalidateTheme(merged, { id: r.targetId });
  return { theme, invalid: replaced };
}

function view(r: Row): ThemeDraftView {
  const { theme, invalid } = proposed(r);
  return { id: r.id, targetId: r.targetId, theme, invalid, contrast: contrastReport(theme), proposedBy: r.agentName ?? "an agent", createdAt: r.createdAt.toISOString(), status: r.status, note: r.note };
}

export function listThemeDrafts(status: "open" | "all" = "open"): ThemeDraftView[] {
  const rows = db().select().from(themeDrafts).orderBy(desc(themeDrafts.createdAt)).all();
  return rows.filter((r) => status === "all" || r.status === "open").map(view);
}

export function getThemeDraft(id: string): ThemeDraftView | null {
  const r = db().select().from(themeDrafts).where(eq(themeDrafts.id, id)).get();
  return r ? view(r) : null;
}

/** themes.create / themes.update: record a draft. The patch is revalidated on every read, never trusted. */
export function proposeThemeDraft(p: Principal, input: { targetId?: string; patch: unknown; note?: string }): ThemeDraftView {
  if (!canEditThemes(p) || p.kind === "guest") throw new Forbidden("Only owners and members can propose themes.");
  if (input.targetId && !getSavedTheme(input.targetId)) throw new NotFound("That theme does not exist, or it is a built-in (duplicate it first).");
  const id = randomBytes(12).toString("hex");
  const now = new Date();
  db()
    .insert(themeDrafts)
    .values({ id, targetId: input.targetId ?? null, patch: input.patch ?? {}, createdBy: p as unknown as Record<string, unknown>, agentName: agentName(p), createdAt: now, status: "open", note: input.note?.slice(0, 500) ?? null })
    .run();
  const v = getThemeDraft(id)!;
  audit({ actor: p, event: "draft.created", target: { type: "theme_draft", id, label: v.theme.name }, result: "ok", detail: { kind: "theme", targetId: input.targetId ?? null } });
  return v;
}

function decide(p: Principal, id: string) {
  if (p.kind !== "user") throw new Forbidden("Only a signed-in person can publish or discard a draft.");
  if (!canEditThemes(p)) throw new Forbidden("Only owners and members can publish theme drafts.");
  const r = db().select().from(themeDrafts).where(eq(themeDrafts.id, id)).get();
  if (!r) throw new NotFound("That draft does not exist.");
  if (r.status !== "open") throw new AtriumError("That draft was already handled.", 409, "draft_closed");
  return { r, by: p };
}

/** Session only. Creates the theme, or applies the patch to its target (which must not have moved on). */
export function publishThemeDraft(p: Principal, id: string): SavedTheme {
  const { r, by } = decide(p, id);
  const { theme } = proposed(r);
  const saved = r.targetId ? updateTheme(p, r.targetId, theme, getSavedTheme(r.targetId)!.rev) : createTheme(p, theme, { rename: true });
  db().update(themeDrafts).set({ status: "published", decidedById: by.userId, decidedAt: new Date() }).where(eq(themeDrafts.id, id)).run();
  audit({ actor: p, event: "draft.published", target: { type: "theme_draft", id, label: saved.name }, result: "ok", detail: { kind: "theme", themeId: saved.id } });
  return saved;
}

export function discardThemeDraft(p: Principal, id: string): void {
  const { by } = decide(p, id);
  db().update(themeDrafts).set({ status: "discarded", decidedById: by.userId, decidedAt: new Date() }).where(eq(themeDrafts.id, id)).run();
  audit({ actor: p, event: "draft.discarded", target: { type: "theme_draft", id }, result: "ok", detail: { kind: "theme" } });
}
