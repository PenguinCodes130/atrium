import { body, commandsOut, handle, send } from "@/features/integrations/api";
import { addCommand, commandsView, discardCommands } from "@/features/integrations/commands";
import { z } from "zod";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

// The integration's Commands list (architecture v3 section 3.1): published and pending.
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, undefined, (s) => send(commandsOut, commandsView(s.principal, id)));
}

// Adds or changes a Custom API command. Owner or creator only; it lands as a draft.
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, "member", async (s) => send(commandsOut, addCommand(s.principal, id, await body(req, z.unknown()))));
}

// Discards the pending command changes.
export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, "member", (s) => send(commandsOut, discardCommands(s.principal, id)));
}
