import { body, handleLocks, send, testOut } from "@/features/integrations/api";
import { testConnection, testInput } from "@/features/integrations/service";

export const dynamic = "force-dynamic";

// Tests a connection before it is saved. Secret values are used for this one check only. A picked
// saved credential not locked to any server yet is locked to this one first, after the confirm and a
// step-up (Fix List r3 item 1): 409 credential_origin_confirm, then auth's 403 step_up_required.
export function POST(req: Request) {
  return handleLocks(req, "member", async (s, lock) => send(testOut, await testConnection(s.principal, await body(req, testInput), lock)));
}
