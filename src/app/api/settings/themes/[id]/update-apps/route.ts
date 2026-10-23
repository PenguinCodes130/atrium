import { z } from "zod";
import { body, handle, send } from "@/features/settings/api";
import { updateAppsUsingTheme } from "@/features/themes/store";

export const dynamic = "force-dynamic";

export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, "member", async (s) => {
    const { id } = await params;
    const { appIds } = await body(req, z.object({ appIds: z.array(z.string()).max(500).optional() }));
    const r = await updateAppsUsingTheme(s.principal, id, appIds);
    return send(z.object({ updated: z.array(z.object({ appId: z.string(), name: z.string(), rev: z.number() })) }), r);
  });
}
