// POST /api/integrations/spec: read an API spec (pasted text or file, a spec URL, or found at the
// service's address) and preview what importing it gives. Owners and members (agents with
// atrium:edit); everyone else gets not found. Spec import v2, recipes spec 3.3.
import { body, handle, send } from "@/features/integrations/api";
import { previewIn, previewOut } from "@/features/integrations/spec/api";
import { previewSpec } from "@/features/integrations/spec/service";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(req, undefined, async (s) => {
    const input = await body(req, previewIn);
    return send(previewOut, await previewSpec(s.principal, input, req.signal));
  });
}
