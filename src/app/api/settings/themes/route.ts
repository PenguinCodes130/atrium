import { z } from "zod";
import type { Theme } from "@/core/contracts";
import { canvasThemeCss } from "@/features/themes/resolve";
import { contrastReport } from "@/features/shell";
import { body, handle, send } from "@/features/settings/api";
import { listThemeDrafts } from "@/features/themes/drafts";
import { builtInThemes, canEditThemes, createTheme, listSavedThemes, usageMap } from "@/features/themes/store";
import { themeSwatch } from "@/features/themes/swatch";

export const dynamic = "force-dynamic";

const use = z.object({ appId: z.string(), slug: z.string(), name: z.string(), draft: z.boolean(), published: z.boolean() });
const item = z.object({
  id: z.string(), name: z.string(), author: z.string(), mode: z.enum(["light", "dark", "auto"]), builtIn: z.boolean(), rev: z.number(), invalid: z.number(),
  theme: z.record(z.string(), z.unknown()), usedBy: z.array(use), warnings: z.number(), sampleCss: z.string().optional(),
});
const option = z.object({ id: z.string(), name: z.string(), mode: z.enum(["light", "dark", "auto"]), builtIn: z.boolean(), swatch: z.object({ wallpaper: z.string(), surface: z.string(), accent: z.string(), text: z.string() }) });
const draft = z.object({ id: z.string(), targetId: z.string().nullable(), proposedBy: z.string(), createdAt: z.string(), invalid: z.number(), theme: z.record(z.string(), z.unknown()), warnings: z.array(z.object({ field: z.string(), ratio: z.number(), scheme: z.string() })), sampleCss: z.string().optional() });
const listOut = z.object({ themes: z.array(item), drafts: z.array(draft), canEdit: z.boolean() });

// Every signed-in user sees the list (viewers read only). `?picker=1` returns the small option list.
export function GET(req: Request) {
  return handle(req, undefined, async (s) => {
    const saved = listSavedThemes();
    const builtIns = builtInThemes();
    if (new URL(req.url).searchParams.get("picker") === "1") {
      const options = [...builtIns.map((t) => ({ id: t.id, name: t.name, mode: t.mode, builtIn: true, swatch: themeSwatch(t) })), ...saved.map((t) => ({ id: t.id, name: t.name, mode: t.theme.mode, builtIn: false, swatch: themeSwatch(t.theme) }))];
      return send(z.object({ options: z.array(option) }), { options });
    }
    const usage = await usageMap();
    const samples = new URL(req.url).searchParams.get("samples") === "1";
    // Each sample canvas gets only its own theme CSS, scoped by the server (never in the browser).
    const css = (t: Theme, scope: string) => (samples && t.customCss ? { sampleCss: canvasThemeCss(t, { scope }) as string } : {});
    const sid = (id: string) => `s${id.replace(/[^a-z0-9]/g, "")}`;
    const themes = [
      ...builtIns.map((t) => ({ id: t.id, name: t.name, author: t.author, mode: t.mode, builtIn: true, rev: 0, invalid: 0, theme: t, usedBy: usage[t.id] ?? [], warnings: contrastReport(t).warnings.length, ...css(t, sid(t.id)) })),
      ...saved.map((t) => ({ id: t.id, name: t.name, author: t.theme.author, mode: t.theme.mode, builtIn: false, rev: t.rev, invalid: t.invalid, theme: t.theme, usedBy: usage[t.id] ?? [], warnings: contrastReport(t.theme).warnings.length, ...css(t.theme, sid(t.id)) })),
    ];
    const drafts = listThemeDrafts().map((d) => ({ id: d.id, targetId: d.targetId, proposedBy: d.proposedBy, createdAt: d.createdAt, invalid: d.invalid, theme: d.theme, warnings: d.contrast.warnings.map((w) => ({ field: w.field, ratio: w.ratio, scheme: w.scheme })), ...css(d.theme, `d${d.id.slice(0, 12)}`) }));
    return send(listOut, { themes, drafts, canEdit: canEditThemes(s.principal) });
  });
}

const createIn = z.object({ theme: z.record(z.string(), z.unknown()) });
const savedOut = z.object({ id: z.string(), name: z.string(), rev: z.number(), theme: z.record(z.string(), z.unknown()) });

export function POST(req: Request) {
  return handle(req, "member", async (s) => {
    const { theme } = await body(req, createIn);
    const t = createTheme(s.principal, theme);
    return send(savedOut, t, { status: 201 });
  });
}
