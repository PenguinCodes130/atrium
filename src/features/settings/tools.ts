// settings' agent tools (architecture 9b.1; settings spec 3.8): themes.list and themes.get (read),
// themes.create and themes.update (edit, theme draft) and themes.apply (edit, app draft through
// app-builder's applyOps). No tool deletes a theme or publishes a theme draft. The registry imports
// `settingsTools` through src/features/registry/manifest.ts (shared file request to command-palette).
import "server-only";
import { z } from "zod";
import type { DraftOp, Principal, ToolDef } from "@/core/contracts";
import { appAccess } from "@/core/hooks";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { contrastReport } from "@/features/shell";
import { appPort } from "./app-port";
import { proposeThemeDraft } from "@/features/themes/drafts";
import { builtInThemes, listSavedThemes, themeById } from "@/features/themes/store";

const read = { scope: "atrium:read" as const, effect: "none" as const, surfaces: ["palette", "builtin-agent", "mcp"] as ("palette" | "builtin-agent" | "mcp")[], minRole: "viewer" as const };
const edit = { scope: "atrium:edit" as const, surfaces: ["builtin-agent", "mcp"] as ("palette" | "builtin-agent" | "mcp")[], minRole: "member" as const };

const summary = z.object({ id: z.string(), name: z.string(), mode: z.enum(["light", "dark", "auto"]), builtIn: z.boolean(), author: z.string() });
const draftOut = z.object({ draftId: z.string(), name: z.string(), invalidValues: z.number(), contrastWarnings: z.array(z.object({ field: z.string(), ratio: z.number(), scheme: z.string() })), message: z.string() });

export class ToolConflict extends AtriumError {
  constructor(readonly rev: number) {
    super(`conflict: the draft is at rev ${rev}`, 409, "conflict");
  }
}

async function requireAppEdit(p: Principal, appId: string) {
  const access = appAccess();
  const port = appPort();
  if (!access || !port) throw new AtriumError("Apps are not available yet.", 503, "not_available");
  if (!(await access.canEditApp(p, appId))) throw new Forbidden("You cannot edit that app.");
  const app = await port.getApp(appId);
  if (!app) throw new NotFound("That app does not exist.");
  return { port, app };
}

/** The ops themes.apply sends: the app theme, or one page's theme. */
export function applyThemeOps(themeId: string, pageId?: string): DraftOp[] {
  return pageId ? [{ op: "page.update", pageId, patch: { theme: { themeId } } }] : [{ op: "theme.set", theme: { themeId } }];
}

/** themes.apply: through app-builder's applyOps, so conflict and validation are the same as every draft edit. */
export async function applyTheme(p: Principal, input: { appId: string; pageId?: string; themeId: string; expectRev?: number }): Promise<{ rev: number; changed: string[] }> {
  if (!themeById(input.themeId)) throw new NotFound("That theme does not exist.");
  const { port, app } = await requireAppEdit(p, input.appId);
  if (input.pageId && !app.draft.pages.some((pg) => pg.id === input.pageId)) throw new NotFound("That page does not exist in the app draft.");
  const rev = input.expectRev ?? app.draftRev;
  if (input.expectRev !== undefined && input.expectRev !== app.draftRev) throw new ToolConflict(app.draftRev);
  const r = await port.applyOps(input.appId, rev, applyThemeOps(input.themeId, input.pageId), p);
  return { rev: r.rev, changed: [input.pageId ? `pages.${input.pageId}.theme` : "theme"] };
}

const draftResult = (v: ReturnType<typeof proposeThemeDraft>) => ({
  draftId: v.id,
  name: v.theme.name,
  invalidValues: v.invalid,
  contrastWarnings: v.contrast.warnings.map((w) => ({ field: w.field, ratio: w.ratio, scheme: w.scheme })),
  message: "Saved as a theme draft. A person must publish it on the Themes screen before any app can use it.",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const settingsTools: ToolDef<any, any>[] = [
  {
    name: "themes.list", title: "List themes", ...read,
    description: "Lists the four built-in themes (control-room, dusk, solid, daylight) and this Atrium's saved themes, with id, name, mode and author.",
    input: z.object({}), output: z.object({ themes: z.array(summary) }),
    async handler() {
      return { themes: [...builtInThemes().map((t) => ({ id: t.id, name: t.name, mode: t.mode, builtIn: true, author: t.author })), ...listSavedThemes().map((s) => ({ id: s.id, name: s.name, mode: s.theme.mode, builtIn: false, author: s.theme.author }))] };
    },
  },
  {
    name: "themes.get", title: "Get a theme", ...read,
    description: "Returns one theme's full token set (design v4 Theme), its contrast report and, for a saved theme, how many stored values were invalid and replaced.",
    input: z.object({ id: z.string().max(80) }),
    output: z.object({ theme: z.record(z.string(), z.unknown()), builtIn: z.boolean(), invalidValues: z.number(), contrast: z.record(z.string(), z.unknown()) }),
    async handler(_ctx, i: { id: string }) {
      const t = themeById(i.id);
      if (!t) throw new NotFound("That theme does not exist.");
      return { theme: t.theme as unknown as Record<string, unknown>, builtIn: t.builtIn, invalidValues: t.invalid, contrast: contrastReport(t.theme) as unknown as Record<string, unknown> };
    },
  },
  {
    name: "themes.create", title: "Propose a new theme", ...edit, effect: "draft",
    description: "Proposes a new theme as a theme draft (full design v4 Theme: name, mode, tokens, optional dark set and customCss). Values outside the design ranges are clamped or replaced by Control Room's. A person publishes or discards the draft; until then no app uses it.",
    input: z.object({ theme: z.record(z.string(), z.unknown()), note: z.string().max(500).optional() }),
    output: draftOut,
    async handler({ principal }, i: { theme: Record<string, unknown>; note?: string }) {
      return draftResult(proposeThemeDraft(principal, { patch: i.theme, ...(i.note ? { note: i.note } : {}) }));
    },
  },
  {
    name: "themes.update", title: "Propose a theme change", ...edit, effect: "draft",
    description: "Proposes a change to a saved theme as a theme draft: a JSON Merge Patch over the theme (for example { tokens: { color: { accent: \"#2F6FB0\" } } }). Built-in themes cannot be changed; duplicate them first. A person publishes or discards the draft.",
    input: z.object({ id: z.string().max(80), patch: z.record(z.string(), z.unknown()), note: z.string().max(500).optional() }),
    output: draftOut,
    async handler({ principal }, i: { id: string; patch: Record<string, unknown>; note?: string }) {
      return draftResult(proposeThemeDraft(principal, { targetId: i.id, patch: i.patch, ...(i.note ? { note: i.note } : {}) }));
    },
  },
  {
    name: "themes.apply", title: "Apply a theme to an app or page", ...edit, effect: "draft",
    description: "Sets an app's theme, or one page's own theme, on the app draft (a theme.set or page.update draft op). Returns the new draft rev. Fails with conflict (and the current rev) when expectRev is stale. The published app changes only when a person publishes.",
    input: z.object({ appId: z.string(), pageId: z.string().optional(), themeId: z.string().max(80), expectRev: z.number().int().optional() }),
    output: z.object({ rev: z.number(), changed: z.array(z.string()) }),
    async handler({ principal }, i: { appId: string; pageId?: string; themeId: string; expectRev?: number }) {
      return applyTheme(principal, i);
    },
  },
];
