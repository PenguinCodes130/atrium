import { z } from "zod";
import { body, handleLocks, integrationOut, send } from "@/features/integrations/api";
import { saveSecrets } from "@/features/integrations/service";

export const dynamic = "force-dynamic";
const input = z.object({
  secrets: z.record(z.string(), z.string().max(8192)).default({}),
  // Amendment 2: a saved credential per field, or null to switch the field back to its own value.
  credentials: z.record(z.string(), z.string().max(100).nullable()).optional(),
  confirmOrigins: z.boolean().optional(),
});

// Write-only: values go in, only { key, set, updatedAt } comes back.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleLocks(req, "member", async (s, lock) => {
    const b = await body(req, input);
    return send(integrationOut, saveSecrets(s.principal, id, b.secrets, { credentials: b.credentials, confirmOrigins: b.confirmOrigins }, lock));
  });
}
