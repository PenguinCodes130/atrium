import { z } from "zod";
import { body, handle, packageCardOut, send } from "@/features/integrations/api";
import { deleteDeclarativePackage, exportDeclarativePackage, publishPackageCommands } from "@/features/integrations/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string[] }> };

// Export a declarative package as one JSON file (shared like a theme).
export async function GET(req: Request, { params }: Ctx) {
  const id = (await params).id.map(decodeURIComponent).join("/");
  return handle(req, undefined, () => {
    const file = exportDeclarativePackage(id);
    const name = id.replace(/[^a-z0-9-]+/gi, "-");
    return new Response(JSON.stringify(file, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${name}.atrium-package.json"`, "cache-control": "no-store" } });
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const id = (await params).id.map(decodeURIComponent).join("/");
  return handle(req, "member", (s) => {
    deleteDeclarativePackage(s.principal, id);
    return new Response(null, { status: 204 });
  });
}

// v3 (section 3.1): publishes a declarative package's pending commands.json. Signed-in owner or the package's maker.
export async function POST(req: Request, { params }: Ctx) {
  const id = (await params).id.map(decodeURIComponent).join("/");
  return handle(req, "member", async (s) => {
    await body(req, z.object({ action: z.literal("publish_commands") }));
    return send(packageCardOut, publishPackageCommands(s.principal, id));
  });
}
