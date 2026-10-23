// POST /api/integrations/spec/import: import a previewed spec into a new or existing Custom API
// integration (reads with settings, opted-in commands, a spec recipe, the live check). Owners and
// members (agents with atrium:edit, drafts only); everyone else gets not found.
import { body, handleLocks, send } from "@/features/integrations/api";
import { importIn, importOut } from "@/features/integrations/spec/api";
import { importHeldSpec } from "@/features/integrations/spec/service";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleLocks(req, undefined, async (s, lock) => {
    const input = await body(req, importIn);
    return send(importOut, await importHeldSpec(s.principal, input, lock));
  });
}
