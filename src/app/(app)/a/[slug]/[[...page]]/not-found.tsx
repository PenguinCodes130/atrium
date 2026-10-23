// Not found for the app viewer (app-builder; gauntlet w2-r3 item 1, security). A guest whose link ended
// gets the friendly "link has ended" screen, now with status 404 instead of 200, so the app's worker
// forgets its offline copy; the page forgets it too (AccessEnded). Everyone else gets Atrium's own
// not-found room. Next renders this boundary into every viewer page's payload, so it carries nothing
// about the person asking.
import RootNotFound from "@/app/not-found";
import { GuestExpiredScreen } from "@/features/auth/ui/guest-screens";
import { guestAccessEnded } from "@/features/apps/guest-access";
import { AccessEnded } from "@/features/pwa/access-ended";

export const metadata = { title: "Not found" };

export default async function ViewerNotFound() {
  if (await guestAccessEnded()) {
    return (
      <>
        <GuestExpiredScreen />
        <AccessEnded />
      </>
    );
  }
  return <RootNotFound />;
}
