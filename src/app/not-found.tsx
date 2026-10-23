// Not found (app-shell): any unknown address, and notFound() thrown by any page.
// Signed in, the room renders inside the shell frame so the navigation stays. Signed out (only public
// paths reach here: auth's proxy sends the rest to sign-in), it renders with the sky band and mark.
// Gauntlet w2-r3 item 2 (security, app-builder final r4 SFR): Next renders this boundary into every
// page's payload, the app viewer's stored offline snapshot included, so it never carries the person's
// name or email; the shell frame's account menu fetches them on the client (NotFoundAccount).
import { getSession } from "@/features/auth";
import { NotFoundScreen } from "@/features/shell/system-screens";
import { ShellFrame } from "@/features/shell/shell-frame";
import { SkyBand } from "@/features/shell/sky-band";
import { NotFoundAccount } from "@/features/shell/not-found-account";
import { instanceName } from "@/features/shell/server";

export const metadata = { title: "Not found" };

export default async function NotFound() {
  const session = await getSession().catch(() => null);
  if (session) {
    return (
      <ShellFrame initial={{ instanceName: instanceName() }}>
        <NotFoundAccount />
        <div className="flex flex-1 flex-col" data-not-found-in-shell>
          <NotFoundScreen />
        </div>
      </ShellFrame>
    );
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <SkyBand />
      <main id="main" className="flex flex-1 flex-col">
        <NotFoundScreen />
      </main>
    </div>
  );
}
