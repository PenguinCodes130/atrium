import { handle, send, sharingOut } from "@/features/integrations/api";
import { sharingView } from "@/features/integrations/service";

export const dynamic = "force-dynamic";

// The Shared setting and the apps that would stop showing this integration if it were switched off (A1.1).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, undefined, async (s) => send(sharingOut, await sharingView(s.principal, id)));
}
