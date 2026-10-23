// Auth's two settings panels (architecture v3 Amendment 4, A4.4). auth owns them; settings mounts them
// unchanged, each inside its own window or section:
//
//   import { UsersSettingsPanel, SecuritySettingsPanel } from "@/features/auth/settings-panels";
//   /settings/users     -> <UsersSettingsPanel />     people, allowlist, invite and reset links (owner only)
//   /settings/security  -> <SecuritySettingsPanel />  password, authenticator app, backup codes, sessions
//
// Both are async server components with no props: each reads the signed-in user itself and the server
// actions behind them check the role again on every change. A signed-out visitor is sent to sign-in and
// brought back. A member or viewer who opens /settings/users sees one sentence saying the owner manages
// it, never the data. The owner banners (owner password variable still set, secrets locked) are not part
// of either panel: settings shows them in its own banner row with <AuthBanners /> from
// "@/features/auth/banners" (or the raw list from getAuthBanners()).
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Unauthorized } from "@/core/errors";
import { requireUser } from "./index";
import { loadUsersPage, hasPasswordAccount } from "./server/manage";
import { UsersManager } from "./ui/users-manager";
import { PasswordPanel, SessionsPanel, TwoFactorPanel } from "./ui/account-security";

export const USERS_SETTINGS_PATH = "/settings/users";
export const SECURITY_SETTINGS_PATH = "/settings/security";

async function signedIn(back: string) {
  try {
    return await requireUser();
  } catch (err) {
    if (err instanceof Unauthorized) redirect(`/sign-in?next=${back}`);
    throw err;
  }
}

/** /settings/users: the people who can sign in, the allowlist, and invite and reset links. Owner only. */
export async function UsersSettingsPanel() {
  const s = await signedIn(USERS_SETTINGS_PATH);
  if (s.user.role !== "owner") {
    return (
      <p className="type-body text-fg" data-users-settings-panel="not-owner">
        Only the owner decides who can sign in to this Atrium. You are a {s.user.role}.
      </p>
    );
  }
  const data = await loadUsersPage(new Headers(await headers()));
  return (
    <div className="flex flex-col gap-8" data-users-settings-panel>
      <UsersManager initial={data} />
    </div>
  );
}

/** /settings/security: the signed-in person's own password, authenticator app, backup codes and sessions. */
export async function SecuritySettingsPanel() {
  const s = await signedIn(SECURITY_SETTINGS_PATH);
  const hasPassword = hasPasswordAccount(s.user.id);
  return (
    <div className="flex flex-col gap-10" data-security-settings-panel>
      <PasswordPanel hasPassword={hasPassword} />
      <TwoFactorPanel enabled={s.user.twoFactorEnabled} hasPassword={hasPassword} />
      <SessionsPanel />
    </div>
  );
}
