// Whether this request is a guest whose link has ended (gauntlet w2-r3 item 1, security): no session,
// a guest cookie, but the guest session, its link or the app no longer passes (revoked, expired, guests
// turned off). The viewer answers it with notFound(), so the status is 404 and the app's worker forgets
// the app; the viewer's not-found boundary then shows the friendly "link has ended" screen.
import "server-only";
import { headers } from "next/headers";
import { getGuestViewer, getSession } from "@/features/auth";
import { hasGuestCookie } from "@/features/auth/guest/service";

export async function guestAccessEnded(): Promise<boolean> {
  const h = new Headers(await headers());
  if (!hasGuestCookie(h)) return false;
  if (await getSession().catch(() => null)) return false;
  return (await getGuestViewer().catch(() => null)) === null;
}
