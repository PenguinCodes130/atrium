import { body, handle, send, tryOut } from "@/features/integrations/api";
import { ERROR_HEADINGS } from "@/features/integrations/host/errors";
import { integrationAuthFor, runTry, tryInput } from "@/features/integrations/try-it";

export const dynamic = "force-dynamic";

// Try it: one request on the server, never cached. Credentials stay on the server. A saved
// integration's sealed ones (or its saved credentials) are only attached for its own saved origin,
// and only for a caller who may manage that integration and use those credentials.
export function POST(req: Request) {
  return handle(req, "member", async (s) => {
    const input = await body(req, tryInput);
    const auth = input.auth && "integrationId" in input.auth ? integrationAuthFor(s.principal, input.auth.integrationId) : undefined;
    const r = await runTry(input, s.user.id, auth);
    return send(tryOut, r.ok ? r : { ...r, heading: ERROR_HEADINGS[r.error.code] });
  });
}
