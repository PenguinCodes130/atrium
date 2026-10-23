// The invite and reset page (auth-spec-v3 "Opening an invite", "Opening a reset"). Owned by auth.
// Re-checks the link on every load: a dead link goes to the one expired screen, a signed-in visitor to
// the signed-in screen. Nothing is consumed by opening it.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { inspectAccountLink } from "@/features/auth/account-links/service";
import { AccountLinkForm } from "@/features/auth/ui/account-link-form";
import { AccountLinkScreen } from "@/features/auth/ui/account-link-screens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invite link", referrer: "no-referrer" as const, robots: { index: false } };

export default async function AccountLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await inspectAccountLink(token, new Headers(await headers()));
  if (r.kind === "signed_in") redirect("/invite/signed-in");
  if (r.kind === "dead") redirect("/invite/expired");
  return (
    <AccountLinkScreen title={r.kind === "invite" ? "atrium / invite" : "atrium / reset password"}>
      <AccountLinkForm token={token} kind={r.kind} email={r.email} role={r.kind === "invite" ? r.role : undefined} />
    </AccountLinkScreen>
  );
}
