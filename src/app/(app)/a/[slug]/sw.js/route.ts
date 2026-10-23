// The app's own offline worker, scoped to /a/<slug> (spec "Install", criterion 47; gauntlet w2-r1 item 4).
import "@/features/apps/register";
import { getGuestViewer, getSession } from "@/features/auth";
import { canOpen } from "@/features/apps/access";
import * as repo from "@/features/apps/repo";
import { appBase, appWorker } from "@/features/pwa/manifest";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(req).catch(() => null);
  const principal = session?.principal ?? (await getGuestViewer(req).catch(() => null))?.principal ?? null;
  const app = /^[a-z0-9-]{1,40}$/.test(slug) ? repo.getAppBySlug(slug) : null;
  if (!app || !principal || !canOpen(app, principal)) return new Response("Not found.", { status: 404 });
  return new Response(appWorker(app.slug, String(app.publishedVersion ?? 0)), {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": appBase(app.slug) },
  });
}
