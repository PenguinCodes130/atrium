// The one screen for every dead invite or reset link (auth-spec-v3 "Dead links"). Owned by auth.
import { AccountLinkDeadScreen } from "@/features/auth/ui/account-link-screens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invite link", robots: { index: false } };

export default function AccountLinkExpiredPage() {
  return <AccountLinkDeadScreen />;
}
