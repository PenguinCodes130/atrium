// GET /api/apps: the launcher's tiles. POST /api/apps: create an app (owners and members, signed in).
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle, jsonBody } from "@/features/apps/http";
import { createApp, launcherTiles } from "@/features/apps/service";
import { isTemplateId } from "@/features/apps/templates";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { principal } = await requireUser(req);
    return Response.json({ tiles: launcherTiles(principal) });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { principal } = await requireUser(req);
    const b = await jsonBody(req, 64 * 1024);
    const mappings = b.mappings && typeof b.mappings === "object" && !Array.isArray(b.mappings) ? (b.mappings as Record<string, string | null>) : {};
    const template = isTemplateId(b.template) ? b.template : undefined;
    const { app, rev } = createApp(principal, { name: String(b.name ?? ""), slug: String(b.slug ?? ""), ...(template ? { template } : {}), mappings });
    return Response.json({ app: { id: app.id, slug: app.slug, name: app.name }, rev }, { status: 201 });
  });
}
