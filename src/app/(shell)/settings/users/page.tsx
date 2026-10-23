import { UsersSettingsPanel } from "@/features/auth/settings-panels";
import { Window } from "@/features/shell";
import { OwnerOnly, settingsSession } from "@/features/settings/page-auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

// auth's panel, mounted unchanged (A4.4): people, allowlist, invite and reset links. Owner only.
export default async function UsersPage() {
  const s = await settingsSession("/settings/users");
  if (s.user.role !== "owner") return <OwnerOnly what="Users" />;
  return (
    <Window title="settings / users" data-settings-tab="users">
      <UsersSettingsPanel />
    </Window>
  );
}
