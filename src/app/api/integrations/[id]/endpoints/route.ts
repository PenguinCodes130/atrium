import { body, endpointsOut, handle, send } from "@/features/integrations/api";
import { customEndpointSchema } from "@/features/integrations/manifest";
import { addEndpoint, listEndpoints } from "@/features/integrations/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, undefined, (s) => send(endpointsOut, { endpoints: listEndpoints(s.principal, id) }));
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return handle(req, "member", async (s) => send(endpointsOut, { endpoints: addEndpoint(s.principal, id, await body(req, customEndpointSchema)) }, { status: 201 }));
}
