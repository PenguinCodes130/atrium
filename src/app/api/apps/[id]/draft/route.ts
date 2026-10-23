// GET /api/apps/<id>/draft: the shared draft with its rev, the agent-made nodes and the pending changes.
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { getDraftFor } from "@/features/apps/service";
import * as repo from "@/features/apps/repo";
import { agentNodeIds, describeChanges } from "@/features/versions/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const { app, draft } = getDraftFor(principal, id);
    const { authors } = describeChanges(repo.pendingChanges(app.id));
    return Response.json({ rev: draft.rev, doc: draft.doc, agentNodes: agentNodeIds(app.id), publishedVersion: app.publishedVersion ?? null, authors, pending: authors.reduce((n, a) => n + a.count, 0) });
  });
}
