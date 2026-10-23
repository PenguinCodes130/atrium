// /settings (settings spec 3.1): inside the Atrium shell, with the shared screen header and boxed
// sub-tabs. Members and viewers do not see General, Users or Backups. The owner sees the
// secrets-locked and owner-password banners on every settings screen while their condition holds.
// Guests and bearer tokens are signed out here (the proxy sends them to sign-in; requireUser again).
import type { ReactNode } from "react";
import { AuthBanners } from "@/features/auth/banners";
import { Screen } from "@/features/shell";
import "@/features/settings/register";
import { getUserPrefs } from "@/features/settings/store";
import { settingsSession } from "@/features/settings/page-auth";
import { PrefsSync } from "@/features/settings/ui/prefs-sync";
import { SettingsHeader, type SettingsTab } from "@/features/settings/ui/settings-header";

export const dynamic = "force-dynamic";

const OWNER_TABS = ["general", "users", "backups"];
const ALL: SettingsTab[] = [
  { key: "general", label: "General" },
  { key: "appearance", label: "Appearance" },
  { key: "themes", label: "Themes" },
  { key: "users", label: "Users" },
  { key: "security", label: "Security" },
  { key: "backups", label: "Backups" },
  { key: "notifications", label: "Notifications" },
  { key: "agents", label: "Agents" },
];

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const s = await settingsSession();
  const owner = s.user.role === "owner";
  const tabs = ALL.filter((t) => owner || !OWNER_TABS.includes(t.key));
  return (
    <Screen data-settings-screen>
      <SettingsHeader tabs={tabs} lead={owner ? "This Atrium, your account, and how apps can look." : "Your account, your shell, and how apps can look."} />
      {owner ? <AuthBanners /> : null}
      <PrefsSync prefs={getUserPrefs(s.user.id)} />
      {children}
    </Screen>
  );
}
