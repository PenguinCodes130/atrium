// Shell layout (app-shell): the fixed frame around every signed-in screen. Auth's proxy decides who
// reaches it. The account menu shows the signed-in user's name and email (nothing else leaves the
// server); the clock shows the instance name; the Approvals badge shows the pending-proposal count
// once actions registers its hook (architecture v3 amendment A1.2; hidden while unregistered).
import type { ReactNode } from "react";
import { getPrincipal, getSession } from "@/features/auth";
import { ShellFrame } from "@/features/shell/shell-frame";
import { instanceName, pendingApprovals } from "@/features/shell/server";
// Settings SFR 3: the clock readout reads the instance name from the settings store on every screen.
import "@/features/settings/register";
// Settings r2 SFR (gauntlet w2-r1 item 8): the instance logo. The accent is mounted by the root layout
// (settings r3 SFR, w2-r2 item 5).
import { brandLogoUrl } from "@/features/settings/branding-head";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const session = await getSession().catch(() => null);
  const principal = session ? await getPrincipal().catch(() => null) : null;
  const user = session ? { name: session.user.name, email: session.user.email } : undefined;
  const approvalsCount = await pendingApprovals(principal);
  const brandLogo = brandLogoUrl();
  return (
    <ShellFrame initial={{ ...(user ? { user } : {}), instanceName: instanceName(), approvalsCount, ...(brandLogo ? { brandLogo } : {}) }}>{children}</ShellFrame>
  );
}
