// GET /api/library/<id>/export: the component file (<name>.atrium-component), without its creator.
import { errorResponse } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { getLibrary, toComponentFile, COMPONENT_FILE_EXT } from "@/features/library/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { principal } = await requireUser(req, "member");
    const { id } = await params;
    const { component } = getLibrary(principal, id);
    const name = component.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "component";
    return new Response(toComponentFile(component), {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}${COMPONENT_FILE_EXT}"`, "cache-control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
