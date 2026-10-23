// Not found inside the shell (app-shell; components gauntlet w2-r2 Fix 8): notFound() thrown by any page
// under the (shell) layout lands here, so the shell frame is drawn once. The root not-found
// (src/app/not-found.tsx) stays for unknown addresses that match no route, where no layout has drawn it.
import { NotFoundScreen } from "@/features/shell/system-screens";

export const metadata = { title: "Not found" };

export default function ShellNotFound() {
  return (
    <div className="flex flex-1 flex-col" data-not-found-in-shell>
      <NotFoundScreen />
    </div>
  );
}
