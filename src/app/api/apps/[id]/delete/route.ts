// POST /api/apps/<id>/delete { confirm }: the owner or the app's creator, after a fresh step-up (A4.1).
import "@/features/apps/register";
import { Forbidden } from "@/core/errors";
import { requireStepUp, requireUser } from "@/features/auth";
import { handle, jsonBody } from "@/features/apps/http";
import { deleteApp } from "@/features/apps/service";
import { canDelete, isSessionPerson, SESSION_ONLY_MESSAGE } from "@/features/apps/access";
import * as repo from "@/features/apps/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    if (!isSessionPerson(principal)) throw new Forbidden(SESSION_ONLY_MESSAGE.delete);
    const app = repo.getApp(id);
    if (app && !canDelete(app, principal)) throw new Forbidden("Only the owner and the person who created this app can delete it.");
    await requireStepUp(req);
    const b = await jsonBody(req, 4 * 1024);
    deleteApp(principal, id, String(b.confirm ?? ""));
    return Response.json({ ok: true });
  });
}
