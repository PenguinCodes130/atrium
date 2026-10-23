import { SecuritySettingsPanel } from "@/features/auth/settings-panels";
import { Window } from "@/features/shell";
import { settingsSession } from "@/features/settings/page-auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Security" };

// auth's panel, mounted unchanged (A4.4): password, authenticator, backup codes and sessions, for every
// signed-in user.
export default async function SecurityPage() {
  await settingsSession("/settings/security");
  return (
    <Window title="settings / security" data-settings-tab="security">
      <SecuritySettingsPanel />
    </Window>
  );
}
