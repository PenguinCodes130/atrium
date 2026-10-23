// Version history, diff and restore at /build/<slug>/versions (app-builder). Editors only.
import { editorFor } from "@/features/apps/builder-load";
import { listVersionCards } from "@/features/versions/service";
import { VersionsScreen } from "@/features/versions/ui/versions-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Versions" };

export default async function VersionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { app, principal } = await editorFor(slug);
  return <VersionsScreen app={{ id: app.id, slug: app.slug, name: app.name }} versions={listVersionCards(principal, app.id)} principal={principal} />;
}
