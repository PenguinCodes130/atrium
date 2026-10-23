// GET /api/apps/<id>/versions/<n>[?render=1]: one version's document (anyone who can open the app);
// with render=1 (editors), also its home page's theme and scoped CSS for the side-by-side preview.
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { renderPage } from "@/features/apps/load";
import { pageBySlug } from "@/features/apps/doc";
import { appForEditor } from "@/features/apps/service";
import { getVersionDoc } from "@/features/versions/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; version: string }> }) {
  return handle(async () => {
    const { id, version } = await params;
    const { principal } = await requireUser(req);
    const doc = getVersionDoc(principal, id, Number(version));
    if (new URL(req.url).searchParams.get("render") !== "1") return Response.json({ doc });
    const app = appForEditor(principal, id);
    const page = pageBySlug(doc, undefined) ?? null;
    const r = await renderPage(app, doc, page, "editor", { connectLinks: true });
    return Response.json({ doc, pageId: page?.id ?? null, theme: r.theme, canvasCss: r.canvasCss, chromeCss: r.chromeCss, nodeCss: r.nodeCss });
  });
}
