// GET /api/apps/<id>/versions: the version cards (editors).
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { listVersionCards } from "@/features/versions/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    return Response.json({ versions: listVersionCards(principal, id) });
  });
}
