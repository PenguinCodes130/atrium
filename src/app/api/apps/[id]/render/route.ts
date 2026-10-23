// GET /api/apps/<id>/render?page=<pageId>: the builder canvas's theme and scoped CSS for one draft page
// (editors), so a page or theme switch in the builder renders exactly like the viewer. `signedUrls`
// signs the draft's literal external image URLs for the editor (A5.1).
import "@/features/apps/register";
import { NotFound } from "@/core/errors";
import { requireUser } from "@/features/auth";
import { handle } from "@/features/apps/http";
import { renderPage } from "@/features/apps/load";
import { getDraftFor } from "@/features/apps/service";
import { findPage } from "@/features/apps/doc";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const { principal } = await requireUser(req);
    const { app, draft } = getDraftFor(principal, id);
    const page = findPage(draft.doc, new URL(req.url).searchParams.get("page") ?? draft.doc.app.homePage);
    if (!page) throw new NotFound("That page does not exist.");
    const r = await renderPage(app, draft.doc, page, "editor", { connectLinks: true });
    return Response.json({ rev: draft.rev, theme: r.theme, themeNotice: r.themeNotice ?? null, canvasCss: r.canvasCss, chromeCss: r.chromeCss, chromeRemoved: r.chromeRemoved, nodeCss: r.nodeCss, sources: r.sources, unmapped: r.unmapped, library: r.library, signedUrls: r.signedUrls });
  });
}
