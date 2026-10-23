import { body, credentialOut, handle, handleLocks, send } from "@/features/integrations/api";
import { deleteCredential, rotateCredential, rotateCredentialInput, toCredential, updateCredential, updateCredentialInput, usableCredential } from "@/features/integrations/credentials/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ credentialId: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { credentialId } = await params;
  return handle(req, undefined, (s) => send(credentialOut, toCredential(usableCredential(s.principal, credentialId))));
}

// Rotate: new values for some fields (blank keeps); every integration using it switches at once.
export async function PUT(req: Request, { params }: Ctx) {
  const { credentialId } = await params;
  return handle(req, undefined, async (s) => send(credentialOut, rotateCredential(s.principal, credentialId, await body(req, rotateCredentialInput))));
}

// Rename, or remove servers from the lock list (Fix List r2 item 4). Removing a server from a
// credential in use needs a fresh step-up: auth's 403 step_up_required, so the prompt can retry.
export async function PATCH(req: Request, { params }: Ctx) {
  const { credentialId } = await params;
  return handleLocks(req, undefined, async (s, lock) => send(credentialOut, updateCredential(s.principal, credentialId, await body(req, updateCredentialInput), lock)));
}

// Refused with the list of integrations while any uses it.
export async function DELETE(req: Request, { params }: Ctx) {
  const { credentialId } = await params;
  return handleLocks(req, undefined, (s) => {
    deleteCredential(s.principal, credentialId);
    return new Response(null, { status: 204 });
  });
}
