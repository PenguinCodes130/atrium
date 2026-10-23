import { z } from "zod";
import { body, handleLocks, send, testOut } from "@/features/integrations/api";
import { getIntegration, testConnection } from "@/features/integrations/service";

export const dynamic = "force-dynamic";
const input = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string().max(8192)).default({}),
  credentials: z.record(z.string(), z.string().max(100)).optional(),
  confirmOrigins: z.boolean().optional(),
});

// Tests a saved integration: blank secret fields use the stored values or saved credentials. A newly
// picked credential with no lock yet follows the same confirm and step-up as the test before save.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleLocks(req, "member", async (s, lock) => {
    const i = getIntegration(s.principal, id);
    const b = await body(req, input);
    return send(testOut, await testConnection(s.principal, { packageId: i.packageId, config: b.config ?? i.config, secrets: b.secrets, integrationId: id, ...(b.credentials ? { credentials: b.credentials } : {}), ...(b.confirmOrigins ? { confirmOrigins: true } : {}) }, lock));
  });
}
