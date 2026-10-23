// Invite and reset link screens (Amendment 3, auth-spec-v3): the signed-out frame (sky band, lit mark)
// and one window, the same as sign-in. The dead-link screen has one sentence and nothing to click, the
// same for every cause; the signed-in screen only points back to Atrium.
import type { ReactNode } from "react";
import { AuthShell, Button, Window } from "@/features/shell";
import { DEAD_TEXT, SIGNED_IN_TEXT } from "../account-links/policy";

export function AccountLinkScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AuthShell>
      <Window title={title} className="mx-auto w-full max-w-[400px]" data-account-link-screen>
        {children}
      </Window>
    </AuthShell>
  );
}

export function AccountLinkDeadScreen() {
  return (
    <AccountLinkScreen title="atrium / invite link">
      <p className="type-body-lg text-fg" data-account-link-dead>
        {DEAD_TEXT}
      </p>
    </AccountLinkScreen>
  );
}

export function AccountLinkSignedInScreen() {
  return (
    <AccountLinkScreen title="atrium / invite link">
      <div className="flex flex-col gap-5" data-account-link-signed-in>
        <h1 className="type-title-2 text-fg">{SIGNED_IN_TEXT}</h1>
        <p className="type-body text-fg-2">This link is for someone who is not signed in. Nothing was used up: it still works for the person it was made for.</p>
        <Button href="/" variant="primary" className="h-11! self-start">
          Back to Atrium
        </Button>
      </div>
    </AccountLinkScreen>
  );
}
