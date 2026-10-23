import { z } from "zod";
import { NotFound } from "@/core/errors";
import { contrastReport } from "@/features/shell";
import { body, handle, send } from "@/features/settings/api";
import { deleteTheme, themeById, getSavedTheme, themeUsage, updateTheme } from "@/features/themes/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const out = z.object({
  id: z.string(), name: z.string(), rev: z.number(), builtIn: z.boolean(), invalid: z.number(), theme: z.record(z.string(), z.unknown()),
  contrast: z.record(z.string(), z.unknown()), usedBy: z.array(z.object({ appId: z.string(), slug: z.string(), name: z.string(), draft: z.boolean(), published: z.boolean() })),
});

export function GET(req: Request, { params }: Ctx) {
  return handle(req, undefined, async () => {
    const { id } = await params;
    const t = themeById(id);
    if (!t) throw new NotFound("That theme does not exist.");
    const saved = t.builtIn ? null : getSavedTheme(id);
    return send(out, { id, name: t.theme.name, rev: saved?.rev ?? 0, builtIn: t.builtIn, invalid: t.invalid, theme: t.theme, contrast: contrastReport(t.theme), usedBy: await themeUsage(id) });
  });
}

const putIn = z.object({ theme: z.record(z.string(), z.unknown()), rev: z.number().int() });

export function PUT(req: Request, { params }: Ctx) {
  return handle(req, "member", async (s) => {
    const { id } = await params;
    const { theme, rev } = await body(req, putIn);
    const saved = updateTheme(s.principal, id, theme, rev);
    const usedBy = await themeUsage(id);
    return send(out, { id, name: saved.name, rev: saved.rev, builtIn: false, invalid: saved.invalid, theme: saved.theme, contrast: contrastReport(saved.theme), usedBy });
  });
}

export function DELETE(req: Request, { params }: Ctx) {
  return handle(req, "member", async (s) => {
    const { id } = await params;
    await deleteTheme(s.principal, id);
    return send(z.object({ ok: z.literal(true) }), { ok: true });
  });
}
