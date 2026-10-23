import { galleryOut, handle, packageCardOut, send } from "@/features/integrations/api";
import { gallery, importDeclarativePackage } from "@/features/integrations/service";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(req, undefined, () => send(galleryOut, gallery()));
}

// Import a declarative package file (JSON, no code).
export function POST(req: Request) {
  return handle(req, "member", async (s) => {
    const text = await req.text();
    if (text.length > 512 * 1024) return Response.json({ error: { code: "too_large", message: "That package file is too large." } }, { status: 413 });
    let file: unknown;
    try { file = JSON.parse(text); } catch { return Response.json({ error: { code: "invalid_package", message: "That file is not an Atrium package." } }, { status: 400 }); }
    return send(packageCardOut, importDeclarativePackage(s.principal, file), { status: 201 });
  });
}
