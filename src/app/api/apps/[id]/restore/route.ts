// POST /api/apps/<id>/restore { version, expectRev, note }: through the same review; session only.
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle, jsonBody } from "@/features/apps/http";
import { restoreVersion } from "@/features/versions/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const b = await jsonBody(req, 16 * 1024);
    return Response.json(await restoreVersion(principal, id, Number(b.version), { expectRev: Number(b.expectRev), ...(typeof b.note === "string" ? { note: b.note } : {}) }));
  });
}
