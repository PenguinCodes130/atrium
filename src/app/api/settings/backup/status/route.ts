import { z } from "zod";
import { handle, send } from "@/features/settings/api";
import { existingData } from "@/features/backup/import";
import { backupHistory } from "@/features/backup/status";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(req, "owner", (s) =>
    send(z.object({ history: z.array(z.object({ at: z.string(), event: z.string(), withSealedValues: z.boolean() })), existing: z.record(z.string(), z.number()) }), { history: backupHistory(), existing: existingData(s.user.id) }),
  );
}
