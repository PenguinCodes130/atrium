// GET /api/apps/<id>/review[?restore=N]: the publish review (or the restore review for version N).
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { reviewDraft, reviewRestore } from "@/features/versions/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const restore = Number(new URL(req.url).searchParams.get("restore"));
    return Response.json(Number.isInteger(restore) && restore > 0 ? reviewRestore(principal, id, restore) : reviewDraft(principal, id));
  });
}
