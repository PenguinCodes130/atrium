import { endpointsOut, handle, send } from "@/features/integrations/api";
import { removeEndpoint } from "@/features/integrations/service";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; endpointId: string }> }) {
  const { id, endpointId } = await params;
  return handle(req, "member", (s) => send(endpointsOut, { endpoints: removeEndpoint(s.principal, id, endpointId) }));
}
