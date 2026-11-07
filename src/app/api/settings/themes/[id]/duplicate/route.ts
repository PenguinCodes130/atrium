// "New theme from this one". POST stores a copy of the theme (Settings > Themes, Duplicate). GET (Wave
// 2.10c r2, gauntlet w210c-r1 Fix 21) answers an unsaved copy, named and authored as POST would, with
// nothing stored: the builder's Theme panel opens it in the editor and it is stored only on Save.
import { z } from "zod";
import { NotFound } from "@/core/errors";
import { handle, send } from "@/features/settings/api";
import { duplicateTheme, themeById, uniqueName } from "@/features/themes/store";

export const dynamic = "force-dynamic";

export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, "member", async (s) => {
    const { id } = await params;
    const t = duplicateTheme(s.principal, id);
    return send(z.object({ id: z.string(), name: z.string(), rev: z.number() }), t, { status: 201 });
  });
}

export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, "member", async () => {
    const { id } = await params;
    const src = themeById(id);
    if (!src) throw new NotFound("That theme does not exist.");
    const name = uniqueName(`${src.theme.name} copy`);
    const theme = { ...src.theme, id: "new", name, author: src.builtIn ? "Atrium" : src.theme.author };
    return send(z.object({ theme: z.record(z.string(), z.unknown()), name: z.string() }), { theme, name });
  });
}
