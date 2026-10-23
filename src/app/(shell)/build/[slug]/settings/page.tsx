// App settings at /build/<slug>/settings (app-builder): audience, guest links, export, delete. Editors only.
import { listGuestLinks } from "@/features/auth";
import { canDelete } from "@/features/apps/access";
import { editorFor } from "@/features/apps/builder-load";
import * as repo from "@/features/apps/repo";
import { SettingsScreen } from "@/features/apps/ui/settings-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "App settings" };

export default async function AppSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { app, principal } = await editorFor(slug);
  const links = await listGuestLinks(principal, app.id).catch(() => null);
  const liveLinks = (links?.links ?? []).filter((l) => l.status === "active" || l.status === "locked").length;
  return (
    <SettingsScreen
      app={{ id: app.id, slug: app.slug, name: app.name, ...(app.icon ? { icon: app.icon } : {}), publishedVersion: app.publishedVersion ?? null, createdBy: app.createdBy }}
      access={app.access}
      people={repo.allUsers().map((u) => ({ id: u.id, name: u.name, role: u.role }))}
      liveLinks={liveLinks}
      canDelete={canDelete(app, principal)}
      rev={app.draftRev}
      {...(links ? { guestPanel: links as never } : {})}
    />
  );
}
