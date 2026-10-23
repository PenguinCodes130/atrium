import { z } from "zod";
import { requireStepUp } from "@/features/auth";
import { body, handle } from "@/features/settings/api";
import { assertSecretsExportable, exportBackup } from "@/features/backup/export";

export const dynamic = "force-dynamic";

const input = z.object({
  includeSecrets: z.boolean().default(false),
  password: z.string().max(1024).optional(),
  passwordAgain: z.string().max(1024).optional(),
  includeAudit: z.boolean().default(true),
});

// Owner only, after a step-up (Amendment 4 A4.4). The password travels once in the request and is
// never stored, logged or returned.
export function POST(req: Request) {
  return handle(req, "owner", async (s) => {
    const opts = await body(req, input);
    // A locked instance refuses an export with secrets at once (409, the cause named), before the
    // step-up sheet, so the owner is not asked to confirm an export that cannot happen.
    if (opts.includeSecrets) assertSecretsExportable();
    await requireStepUp(req);
    const { fileName, bytes } = await exportBackup(s.principal, opts);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${fileName}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  });
}
