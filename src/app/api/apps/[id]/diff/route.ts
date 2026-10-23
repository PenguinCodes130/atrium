// GET /api/apps/<id>/diff?a=<n|0>&b=<n|draft>: readable diff lines grouped by page (editors).
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { diffVersions } from "@/features/versions/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const q = new URL(req.url).searchParams;
    const a = Number(q.get("a") ?? 0);
    const b = q.get("b") === "draft" ? "draft" : Number(q.get("b"));
    return Response.json(diffVersions(principal, id, a > 0 ? a : null, b));
  });
}
