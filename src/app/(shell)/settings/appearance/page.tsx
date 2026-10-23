import { Window } from "@/features/shell";
import { settingsSession } from "@/features/settings/page-auth";
import { AppearancePanel } from "@/features/settings/ui/appearance-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Appearance" };

export default async function AppearancePage() {
  await settingsSession("/settings/appearance");
  return (
    <Window title="settings / appearance" data-settings-tab="appearance">
      <AppearancePanel />
    </Window>
  );
}
