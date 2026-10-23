import { z } from "zod";
import { formFile, handle, send } from "@/features/settings/api";
import { importTheme, MAX_THEME_FILE_BYTES } from "@/features/themes/share";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(req, "member", async (s) => {
    const { file } = await formFile(req, MAX_THEME_FILE_BYTES);
    const t = importTheme(s.principal, Buffer.from(await file.arrayBuffer()));
    return send(z.object({ id: z.string(), name: z.string(), rev: z.number() }), t, { status: 201 });
  });
}
