// The app picker behind "Use on an app" (settings gauntlet w2-r2 item 4): the apps the caller may edit.
import { z } from "zod";
import { handle, send } from "@/features/settings/api";
import { appsForThemeUse } from "@/features/themes/use-on-app";

export const dynamic = "force-dynamic";

const out = z.object({
  apps: z.array(z.object({ appId: z.string(), slug: z.string(), name: z.string(), currentThemeId: z.string().nullable(), currentThemeName: z.string().nullable(), published: z.boolean() })),
});

export function GET(req: Request) {
  return handle(req, "member", async (s) => send(out, { apps: await appsForThemeUse(s.principal) }));
}
