// GET /api/apps/<id>/export[?draft=1]: the Atrium app file (anyone who can open the app).
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { exportAppFile } from "@/features/apps/appfile";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const out = await exportAppFile(principal, id, { draft: new URL(req.url).searchParams.get("draft") === "1" });
    return new Response(new Uint8Array(out.bytes), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store" } });
  });
}
