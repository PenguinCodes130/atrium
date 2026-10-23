import { body, handle, handleLocks, integrationOut, send } from "@/features/integrations/api";
import { deleteIntegration, getIntegration, updateInput, updateIntegration } from "@/features/integrations/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, undefined, (s) => send(integrationOut, getIntegration(s.principal, id)));
}

// Moving an integration that uses a saved credential to a new server follows the lock rules (Amendment 2).
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handleLocks(req, "member", async (s, lock) => send(integrationOut, updateIntegration(s.principal, id, await body(req, updateInput), lock)));
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, "member", (s) => {
    deleteIntegration(s.principal, id);
    return new Response(null, { status: 204 });
  });
}
