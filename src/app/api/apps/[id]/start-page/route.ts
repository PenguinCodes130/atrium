// POST /api/apps/<id>/start-page { integrationIds, links, machine?, plan? } (Amendment 10, A10.8): editors
// of the app. Applies one DraftChange "Start page" and answers { rev, pageId, nodes }. With plan: true it
// answers { ops, pageId, nodes } without applying them, so the builder can apply them as its own one
// undoable edit. Only services the caller may bind are used; nothing answered carries config or secrets.
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle, jsonBody } from "@/features/apps/http";
import { makeStartPage, parseStartInput } from "@/features/apps/start-page-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const b = await jsonBody(req);
    const input = parseStartInput(b);
    const r = makeStartPage(principal, id, input, { plan: b.plan === true, ...(typeof b.rev === "number" ? { expectRev: b.rev } : {}) });
    return Response.json(r);
  });
}
