import { z } from "zod";
import { requireStepUp } from "@/features/auth";
import { formFile, handle, send } from "@/features/settings/api";
import { importBackup, MAX_BACKUP_BYTES } from "@/features/backup/import";

export const dynamic = "force-dynamic";

// Owner only, after a fresh step-up (Amendment 4 A4.4, like export; settings gauntlet w2-r1 item 1):
// the step-up is checked after the owner check and before the body is read, parsed or anything is
// written. Multipart: file, password (optional), withoutSecrets ("1"), replace ("1": the explicit
// "Replace everything on this Atrium" confirmation).
// `?check=1` stops right after the step-up check (204, no body read), so the screen can ask for the
// step-up before it sends a large backup file.
export function POST(req: Request) {
  return handle(req, "owner", async (s) => {
    await requireStepUp(req);
    if (new URL(req.url).searchParams.get("check") === "1") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const { file, form } = await formFile(req, MAX_BACKUP_BYTES);
    const password = form.get("password");
    const r = await importBackup(s.principal, Buffer.from(await file.arrayBuffer()), {
      ...(typeof password === "string" && password ? { password } : {}),
      withoutSecrets: form.get("withoutSecrets") === "1",
      replace: form.get("replace") === "1",
    });
    return send(
      z.object({
        tables: z.array(z.object({ name: z.string(), rows: z.number() })),
        secrets: z.number(),
        uploads: z.number(),
        uploadsRefused: z.array(z.object({ file: z.string(), reason: z.string() })),
        withoutSecrets: z.boolean(),
        usersToReset: z.number(),
      }),
      r,
    );
  });
}
