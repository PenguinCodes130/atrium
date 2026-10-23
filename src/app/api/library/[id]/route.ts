// GET /api/library/<id>?version=N: one component at a version, plus its latest. DELETE: hide it and
// detach its instances (creator or owner).
import { errorResponse } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { deleteLibrary, getLibrary } from "@/features/library/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { principal } = await requireUser(req, "member");
    const { id } = await params;
    const v = Number(new URL(req.url).searchParams.get("version") ?? "");
    return Response.json(getLibrary(principal, id, Number.isInteger(v) && v > 0 ? v : undefined));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { principal } = await requireUser(req, "member");
    const { id } = await params;
    return Response.json(await deleteLibrary(principal, id));
  } catch (err) {
    return errorResponse(err);
  }
}
