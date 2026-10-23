import { z } from "zod";
import { body, handle, send } from "@/features/settings/api";
import { discardThemeDraft, publishThemeDraft } from "@/features/themes/drafts";

export const dynamic = "force-dynamic";

// Publishing or discarding a theme draft is a session-only operation (architecture 9b.3).
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, "member", async (s) => {
    const { id } = await params;
    const { action } = await body(req, z.object({ action: z.enum(["publish", "discard"]) }));
    if (action === "discard") {
      discardThemeDraft(s.principal, id);
      return send(z.object({ ok: z.literal(true) }), { ok: true });
    }
    const t = publishThemeDraft(s.principal, id);
    return send(z.object({ ok: z.literal(true), id: z.string(), name: z.string() }), { ok: true, id: t.id, name: t.name });
  });
}
