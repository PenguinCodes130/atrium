// The app viewer /a/<slug>/<page?> (spec section 3 "App viewer", "Preview", "Guests"). Signed-in users
// and the guest of this app only (requireViewer semantics: a session wins over a guest cookie).
import type { Metadata, Viewport } from "next";
import type { Principal } from "@/core/contracts";
import { notFound } from "next/navigation";
import { getGuestViewer, getSession } from "@/features/auth";
import { AppSwitcherSlot } from "@/features/shell/server";
import { loadView } from "@/features/apps/load";
import { AppView } from "@/features/apps/ui/app-view";
import { NotPublished } from "@/features/apps/ui/not-published";
import * as repo from "@/features/apps/repo";
import { resolveTheme } from "@/features/apps/deps";
import { appIcon, appThemeColors, OFFLINE_SNAPSHOT_MARKER } from "@/features/pwa/manifest";

/** Who the page's saved last values belong to (gauntlet w2-r2 item 1). */
function ownerTag(p: Principal): string {
  return p.kind === "guest" ? `guest:${p.guestLinkId}` : `user:${p.userId}`;
}

/** The principal an offline snapshot renders for: the same kind, with no identity. */
function anonymous(p: Principal, appId: string): Principal {
  return p.kind === "guest" ? { kind: "guest", guestLinkId: "", appId, label: "", via: "guest-link" } : { kind: "user", userId: "", role: "viewer", via: "session" };
}

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string; page?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const app = /^[a-z0-9-]{1,40}$/.test(slug) ? repo.getAppBySlug(slug) : null;
  return {
    title: { absolute: app?.name ?? "Atrium" },
    manifest: null, // the app's own manifest link is rendered below with credentials (criterion 48)
    robots: { index: false },
    appleWebApp: { capable: true, title: app?.name ?? "Atrium" },
    // The manifest's own 192px icon (gauntlet w2-r1 item 12): the app's upload, or the lit Atrium mark.
    icons: { apple: [{ url: appIcon(app ?? {}, 192).src, sizes: "192x192" }] },
  };
}

/** theme-color matches the app manifest's theme surface, with a dark variant (gauntlet w2-r1 item 21). */
export async function generateViewport({ params }: Props): Promise<Viewport> {
  const { slug } = await params;
  const app = /^[a-z0-9-]{1,40}$/.test(slug) ? repo.getAppBySlug(slug) : null;
  const live = app?.publishedVersion != null ? repo.getVersion(app.id, app.publishedVersion) : null;
  const theme = live ? await resolveTheme(live.doc).then((r) => r.theme).catch(() => undefined) : undefined;
  const c = appThemeColors(theme);
  // One colour unless the app really renders a dark set in dark mode (gauntlet w2-r2 item 12).
  if (c.light === c.dark) return { themeColor: c.light };
  return { themeColor: [{ media: "(prefers-color-scheme: light)", color: c.light }, { media: "(prefers-color-scheme: dark)", color: c.dark }] };
}

export default async function ViewerPage({ params, searchParams }: Props) {
  const { slug, page } = await params;
  const sp = await searchParams;
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || (page && page.length > 1)) notFound();
  const session = await getSession().catch(() => null);
  let principal: Principal | null = session?.principal ?? null;
  let viewerName = session?.user.name.split(" ")[0] ?? "";
  if (!principal) {
    const g = await getGuestViewer().catch(() => null);
    if (g) {
      principal = g.principal;
      viewerName = g.principal.label;
    }
  }
  // No principal: a guest whose link ended (revoked, expired, guests turned off) and everyone else get a
  // 404, never a 200 page (gauntlet w2-r3 item 1), so the app's worker forgets the app. The not-found
  // boundary next to this page shows the guest the friendly "link has ended" screen.
  if (!principal) notFound();
  // `?offline=1` is the copy the app's worker keeps for offline use (gauntlet w2-r2 item 1): the guest
  // projection of the published page, with no name, no app switcher and no identity of the person who
  // asked. The worker stores only pages that carry the snapshot marker.
  const snapshot = sp.offline === "1" && sp.draft !== "1" && sp.render !== "1";
  const state = await loadView(slug, page?.[0], principal, { draft: sp.draft === "1", render: sp.render === "1", snapshot });
  if (state.kind === "not-found") notFound();
  if (state.kind === "not-published") return <NotPublished slug={state.app.slug} name={state.app.name} />;
  const r = state.rendered;
  const shown: Principal = snapshot ? anonymous(principal, state.app.id) : principal;
  return (
    <>
      {state.mode === "view" ? <link rel="manifest" href={`/a/${state.app.slug}/manifest.webmanifest`} crossOrigin="use-credentials" /> : null}
      {snapshot ? <div hidden {...{ [OFFLINE_SNAPSHOT_MARKER]: "" }} /> : null}
      <AppView
        app={{ id: state.app.id, slug: state.app.slug, name: state.app.name }}
        doc={r.doc}
        pageId={r.page?.id ?? null}
        mode={state.mode}
        principal={shown}
        viewerName={snapshot ? "" : viewerName}
        owner={snapshot ? null : ownerTag(principal)}
        snapshot={snapshot}
        canEdit={state.editor}
        guestStatus={r.guestStatus}
        theme={r.theme}
        canvasCss={r.canvasCss}
        chromeCss={r.chromeCss}
        nodeCss={r.nodeCss}
        frameId={r.frameId}
        draftRev={state.rev}
        draftOnly={state.draftOnly}
        sources={r.sources}
        unmapped={r.unmapped}
        library={r.library}
        signedUrls={r.signedUrls}
      />
      {principal.kind === "user" && state.mode !== "agent-render" && !snapshot ? <AppSwitcherSlot slug={state.app.slug} /> : null}
    </>
  );
}
