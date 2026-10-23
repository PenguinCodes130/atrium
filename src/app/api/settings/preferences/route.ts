import { z } from "zod";
import { body, handle, send } from "@/features/settings/api";
import { getUserPrefs, updateUserPrefs, userPrefsSchema } from "@/features/settings/store";

export const dynamic = "force-dynamic";

// Every signed-in user, for their own shell only.
export function GET(req: Request) {
  return handle(req, undefined, (s) => send(userPrefsSchema, getUserPrefs(s.user.id)));
}

export function PUT(req: Request) {
  return handle(req, undefined, async (s) => send(userPrefsSchema, updateUserPrefs(s.principal, await body(req, z.record(z.string(), z.unknown())))));
}
