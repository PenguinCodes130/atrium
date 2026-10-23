// "Use on an app" from the Themes screen and the theme editor (settings gauntlet w2-r2 item 4, the
// Settings half of app-builder's round 1 item 7). The picker lists only the apps the caller may edit
// (app-builder's canEditApp); choosing one points that app's DRAFT at the theme through app-builder's
// applyOps (themes.apply), so validation, conflicts and audit are the same as every draft edit and
// nothing goes live until the app is published.
import "server-only";
import type { Principal } from "@/core/contracts";
import { appAccess } from "@/core/hooks";
import { AtriumError, Forbidden } from "@/core/errors";
import { appPort } from "@/features/settings/app-port";
import { applyTheme } from "@/features/settings/tools";
import { canEditThemes, themeById } from "./store";

export type ThemeAppChoice = { appId: string; slug: string; name: string; currentThemeId: string | null; currentThemeName: string | null; published: boolean };

function themeRefId(ref: unknown): string | null {
  if (!ref || typeof ref !== "object") return null;
  if ("themeId" in ref && typeof (ref as { themeId: unknown }).themeId === "string") return (ref as { themeId: string }).themeId;
  if ("inline" in ref) return null;
  return null;
}

/** The apps the caller may edit, with the theme each draft uses now. */
export async function appsForThemeUse(p: Principal): Promise<ThemeAppChoice[]> {
  if (!canEditThemes(p)) throw new Forbidden("Only owners and members can put a theme on an app.");
  const access = appAccess();
  const port = appPort();
  if (!access || !port) throw new AtriumError("Apps are not available yet.", 503, "not_available");
  const out: ThemeAppChoice[] = [];
  for (const a of await port.listApps()) {
    if (!(await access.canEditApp(p, a.appId))) continue;
    const ref = a.draft.theme as unknown;
    const currentThemeId = themeRefId(ref);
    const inlineName = ref && typeof ref === "object" && "inline" in ref ? ((ref as { inline?: { name?: unknown } }).inline?.name ?? null) : null;
    out.push({
      appId: a.appId,
      slug: a.slug,
      name: a.name,
      currentThemeId,
      currentThemeName: currentThemeId ? (themeById(currentThemeId)?.theme.name ?? null) : typeof inlineName === "string" ? `${inlineName} (customised)` : null,
      published: !!a.published,
    });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** Points one app's draft at the theme. Returns where to review and publish it. */
export async function useThemeOnApp(p: Principal, themeId: string, appId: string): Promise<{ appId: string; slug: string; name: string; rev: number; reviewHref: string; lookHref: string }> {
  if (!canEditThemes(p)) throw new Forbidden("Only owners and members can put a theme on an app.");
  const r = await applyTheme(p, { appId, themeId });
  const app = await appPort()!.getApp(appId);
  const slug = app?.slug ?? "";
  return { appId, slug, name: app?.name ?? "", rev: r.rev, reviewHref: `/build/${encodeURIComponent(slug)}?review=1`, lookHref: `/build/${encodeURIComponent(slug)}?look=1` };
}
