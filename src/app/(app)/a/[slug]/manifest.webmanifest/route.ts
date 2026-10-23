// The app's own web manifest (spec "Install", criterion 47). Anyone who can open the app, guests included.
import "@/features/apps/register";
import { getGuestViewer, getSession } from "@/features/auth";
import { canOpen } from "@/features/apps/access";
import { resolveTheme } from "@/features/apps/deps";
import * as repo from "@/features/apps/repo";
import { appManifest } from "@/features/pwa/manifest";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSession(req).catch(() => null);
  const principal = session?.principal ?? (await getGuestViewer(req).catch(() => null))?.principal ?? null;
  const app = /^[a-z0-9-]{1,40}$/.test(slug) ? repo.getAppBySlug(slug) : null;
  if (!app || !principal || !canOpen(app, principal) || app.publishedVersion == null) return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  const live = repo.getVersion(app.id, app.publishedVersion);
  const theme = live ? (await resolveTheme(live.doc)).theme : undefined;
  return new Response(JSON.stringify(appManifest(app, theme)), { headers: { "content-type": "application/manifest+json", "cache-control": "no-store" } });
}
