import { env } from "@/core/env";
import { readableHost } from "@/features/shell/server";
import { OwnerOnly, settingsSession } from "@/features/settings/page-auth";
import { getInstanceSettings } from "@/features/settings/store";
import { GeneralForm } from "@/features/settings/ui/general-form";
import { BrandingForm } from "@/features/settings/ui/branding-form";
import { Window } from "@/features/shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "General settings" };

export default async function GeneralPage() {
  const s = await settingsSession("/settings/general");
  if (s.user.role !== "owner") return <OwnerOnly what="General" />;
  let host = "Atrium";
  try { host = readableHost(new URL(env().ATRIUM_PUBLIC_URL).hostname); } catch { /* default */ }
  const settings = getInstanceSettings();
  return (
    <div className="grid gap-8 xl:grid-cols-2" data-settings-tab="general">
      <Window title="settings / general">
        <GeneralForm initial={settings} defaultName={host} />
      </Window>
      {/* Settings r2 (gauntlet w2-r1 item 8): instance branding within the shell's token ranges. */}
      <Window title="settings / branding" data-branding>
        <BrandingForm initial={{ brandAccent: settings.brandAccent, brandLogo: settings.brandLogo, brandFavicon: settings.brandFavicon, signInWallpaper: settings.signInWallpaper }} />
      </Window>
    </div>
  );
}
