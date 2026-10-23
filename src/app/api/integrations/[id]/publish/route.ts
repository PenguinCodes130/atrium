import { z } from "zod";
import { body, handleLocks, integrationOut, send } from "@/features/integrations/api";
import { publishDraft } from "@/features/integrations/service";

export const dynamic = "force-dynamic";
const input = z.object({
  token: z.string().max(200).optional(),
  secrets: z.record(z.string(), z.string().max(8192)).default({}),
  credentials: z.record(z.string(), z.string().max(100).nullable()).optional(),
  confirmOrigins: z.boolean().optional(),
});

// Session users only (requireUser never accepts an agent token): saves the credentials and publishes.
// Publishing locks the saved credentials it uses to its server (Amendment 2).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleLocks(req, "member", async (s, lock) => {
    const b = await body(req, input);
    return send(integrationOut, publishDraft(s.principal, id, { ...(b.token ? { token: b.token } : {}), secrets: b.secrets, ...(b.credentials ? { credentials: b.credentials } : {}), ...(b.confirmOrigins ? { confirmOrigins: true } : {}) }, lock));
  });
}
