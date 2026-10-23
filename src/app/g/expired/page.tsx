// The one screen for every dead guest link (criterion 10) and every ended guest session on /a/<slug>
// (amendment A1.3, the proxy rewrites there). Owned by auth. No detail, nothing to click.
import { GuestExpiredScreen } from "@/features/auth/ui/guest-screens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Guest link", robots: { index: false } };

export default function GuestExpiredPage() {
  return <GuestExpiredScreen />;
}
