// POST /api/apps/<id>/ops { rev, ops }: one draft batch, all or nothing (architecture 4.9).
import "@/features/apps/register";
import type { DraftOp } from "@/core/contracts";
import { AtriumError } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { handle, jsonBody } from "@/features/apps/http";
import { applyDraftOps } from "@/features/apps/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const b = await jsonBody(req);
    if (!Array.isArray(b.ops)) throw new AtriumError("Send a list of draft operations.", 400, "bad_request");
    const rev = typeof b.rev === "number" ? b.rev : undefined;
    const r = applyDraftOps({ appId: id, ops: b.ops as DraftOp[], by: principal, ...(rev !== undefined ? { expectRev: rev } : {}) });
    return Response.json(r);
  });
}
