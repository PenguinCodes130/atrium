// A signed-in visitor opened an invite or reset link (Amendment 3): nothing was consumed. Owned by auth.
import { AccountLinkSignedInScreen } from "@/features/auth/ui/account-link-screens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invite link", robots: { index: false } };

export default function AccountLinkSignedInPage() {
  return <AccountLinkSignedInScreen />;
}
