import { body, handle, handleLocks, integrationListOut, integrationOut, send } from "@/features/integrations/api";
import { createInput, createIntegration, listIntegrations } from "@/features/integrations/service";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(req, undefined, (s) => send(integrationListOut, { integrations: listIntegrations(s.principal) }));
}

// Saving may lock a picked saved credential to this server, or ask to confirm a new one (Amendment 2).
export function POST(req: Request) {
  return handleLocks(req, "member", async (s, lock) => send(integrationOut, createIntegration(s.principal, await body(req, createInput), lock), { status: 201 }));
}
