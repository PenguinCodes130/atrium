import { z } from "zod";
import { handle, send } from "@/features/settings/api";
import { duplicateTheme } from "@/features/themes/store";

export const dynamic = "force-dynamic";

export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, "member", async (s) => {
    const { id } = await params;
    const t = duplicateTheme(s.principal, id);
    return send(z.object({ id: z.string(), name: z.string(), rev: z.number() }), t, { status: 201 });
  });
}
