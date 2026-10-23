// Not found under /library (components, gauntlet w2-r2 Fix 8): notFound() from any /library page lands
// here, inside the (shell) layout, so the shell is drawn once.
import { LibraryNotFound } from "@/features/library/ui/not-found";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return <LibraryNotFound />;
}
