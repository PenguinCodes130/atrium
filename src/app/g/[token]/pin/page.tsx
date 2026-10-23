// The guest PIN step (auth-spec-v2 "Opening a link"). Owned by auth. Re-checks the link on every load:
// a dead link goes to the expired screen, a signed-in user goes on as themself.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { inspectGuestLink } from "@/features/auth/guest/service";
import { GuestPinForm } from "@/features/auth/ui/guest-pin";
import { GuestScreen } from "@/features/auth/ui/guest-screens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Guest link", referrer: "no-referrer" as const, robots: { index: false } };

export default async function GuestPinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await inspectGuestLink(token, new Headers(await headers()));
  if (r.kind === "expired") redirect("/g/expired");
  if (r.kind === "user") redirect(`/a/${encodeURIComponent(r.slug)}`);
  if (r.kind === "no_pin") redirect(`/g/${encodeURIComponent(token)}`);
  return (
    <GuestScreen title="atrium / guest link · pin" live>
      <GuestPinForm token={token} initialLockedMinutes={r.minutesLocked} />
    </GuestScreen>
  );
}
