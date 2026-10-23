import { bindableOut, handle, send } from "@/features/integrations/api";
import { listBindableEndpoints } from "@/features/integrations/commands";

export const dynamic = "force-dynamic";

// The integrations whose reads the signed-in user may bind into an app (section 3.1: Shared, or owner and creator).
export function GET(req: Request) {
  return handle(req, undefined, async (s) => send(bindableOut, { integrations: await listBindableEndpoints(s.principal) }));
}
