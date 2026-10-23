// POST /api/apps/<id>/publish { expectRev, note }: session people who can edit; never agents or tokens.
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle, jsonBody } from "@/features/apps/http";
import { publishDraft } from "@/features/versions/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const b = await jsonBody(req, 16 * 1024);
    return Response.json(await publishDraft(principal, id, { expectRev: Number(b.expectRev), ...(typeof b.note === "string" ? { note: b.note } : {}) }));
  });
}
