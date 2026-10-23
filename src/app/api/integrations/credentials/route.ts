import { body, credentialListOut, credentialOut, handle, send } from "@/features/integrations/api";
import { createCredential, createCredentialInput, listCredentials } from "@/features/integrations/credentials/service";

export const dynamic = "force-dynamic";

// Saved credentials (Amendment 2). Lists only the caller's own (all of them for the owner); never values.
export function GET(req: Request) {
  return handle(req, undefined, (s) => send(credentialListOut, { credentials: listCredentials(s.principal) }));
}

// Values go in once, write-only; only names, kinds, servers and usage come back.
export function POST(req: Request) {
  return handle(req, undefined, async (s) => send(credentialOut, createCredential(s.principal, await body(req, createCredentialInput)), { status: 201 }));
}
