// The app launcher at / (app-builder; replaces app-shell's interim home). Signed-in users only.
import "@/features/apps/register";
import { requireUser } from "@/features/auth";
import { instanceName } from "@/features/shell/server";
import { audienceTag, canCreate } from "@/features/apps/access";
import { resolveTheme } from "@/features/apps/deps";
import * as repo from "@/features/apps/repo";
import { launcherTiles } from "@/features/apps/service";
import { TEMPLATES } from "@/features/apps/templates";
import { canBindReads } from "@/features/integrations/commands";
import { listIntegrationRows } from "@/features/integrations/repo";
import { Launcher, type Tile } from "@/features/apps/ui/launcher";

export const dynamic = "force-dynamic";
export const metadata = { title: "Apps" };

export default async function LauncherPage() {
  const { user, principal } = await requireUser();
  const tiles: Tile[] = [];
  for (const t of launcherTiles(principal)) {
    const live = t.app.publishedVersion != null ? repo.getVersion(t.app.id, t.app.publishedVersion)?.doc : repo.getDraft(t.app.id)?.doc;
    const theme = live ? (await resolveTheme(live)).theme : null;
    const wp = theme?.tokens.wallpaper;
    const canvas = wp && (wp.kind === "color" || wp.kind === "gradient") && wp.value ? wp.value : theme?.tokens.color.surface ?? "#F3EFE4";
    tiles.push({ id: t.app.id, slug: t.app.slug, name: t.app.name, ...(t.app.icon ? { icon: t.app.icon } : {}), tag: audienceTag(t.app), pageCount: t.pageCount, version: t.app.publishedVersion ?? null, dirty: t.dirty, canEdit: t.canEdit, canvas, accent: theme?.tokens.color.accent ?? "#E9B949" });
  }
  const integrations = canCreate(principal) ? listIntegrationRows().filter((r) => r.status === "active" && canBindReads(principal, r)).map((r) => ({ id: r.id, name: r.name, packageId: r.packageId })) : [];
  return (
    <Launcher
      firstName={user.name.trim().split(/\s+/)[0] || user.name}
      instance={instanceName()}
      tiles={tiles}
      canCreate={canCreate(principal)}
      templates={TEMPLATES.map((t) => ({ id: t.id, title: t.title, description: t.description, integrations: t.integrations }))}
      integrations={integrations}
    />
  );
}
