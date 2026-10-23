import { commandsOut, handle, send } from "@/features/integrations/api";
import { publishCommands } from "@/features/integrations/commands";

export const dynamic = "force-dynamic";

// Publishes "This integration can change". Signed-in owner or creator only (requireUser never accepts a token).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(req, "member", (s) => send(commandsOut, publishCommands(s.principal, id)));
}
