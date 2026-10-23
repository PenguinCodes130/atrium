import { commandListingOut, handle, send } from "@/features/integrations/api";
import { listCommands } from "@/features/integrations/commands";

export const dynamic = "force-dynamic";

// The read-only command listing (A1.4): every command the signed-in user may bind, with targets. Runs nothing.
export function GET(req: Request) {
  return handle(req, undefined, (s) => send(commandListingOut, { commands: listCommands(s.principal) }));
}
