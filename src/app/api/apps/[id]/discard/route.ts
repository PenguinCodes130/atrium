// POST /api/apps/<id>/discard: reset the draft to the published version (A4.3); session only.
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { discardDraft } from "@/features/apps/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    return Response.json(discardDraft(principal, id));
  });
}
