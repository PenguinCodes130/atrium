// The (app) route group (architecture v3 section 2): viewed apps render inside the root layout only,
// never inside the Atrium shell. app-builder owns it.
import type { ReactNode } from "react";

export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return <div data-app-route className="min-h-dvh">{children}</div>;
}
