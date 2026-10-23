// Invite and reset link screens (Amendment 3). Owned by auth. Signed-out screens on the app-shell
// tokens only, the same frame as sign-in; the front gate lets /invite/* through (default deny, section 5).
import type { ReactNode } from "react";

export const metadata = { referrer: "no-referrer" as const, robots: { index: false } };

export default function InviteLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-bg pt-safe pb-safe" data-auth-screen>
      {children}
    </main>
  );
}
