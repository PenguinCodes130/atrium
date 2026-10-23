// "Use on an app" (settings gauntlet w2-r2 item 4): points one app's draft at this theme through
// app-builder's applyOps. Members and owners who can edit that app; nothing is published.
import { z } from "zod";
import { body, handle, send } from "@/features/settings/api";
import { useThemeOnApp } from "@/features/themes/use-on-app";

export const dynamic = "force-dynamic";

const out = z.object({ appId: z.string(), slug: z.string(), name: z.string(), rev: z.number(), reviewHref: z.string(), lookHref: z.string() });

export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, "member", async (s) => {
    const { id } = await params;
    const { appId } = await body(req, z.object({ appId: z.string().min(1).max(100) }));
    return send(out, await useThemeOnApp(s.principal, id, appId));
  });
}
