// Server data for the shell chrome, free of Node-only imports so it is unit-testable with doubles
// for the Wave 1 hooks (architecture v3 amendment A1.2). Re-exported by "@/features/shell/server".
import type { App, Principal } from "@/core/contracts";
import { appAccess, approvalsCount } from "@/core/hooks";
import { logger } from "@/core/log";

const log = logger("shell");

/** The Approvals badge count: 0 (badge hidden) while actions has not registered its hook (A1.2). */
export async function pendingApprovals(principal: Principal | null): Promise<number> {
  const fn = approvalsCount();
  if (!fn || !principal || principal.kind === "guest") return 0;
  try {
    const n = await fn(principal);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch (err) {
    log.warn("shell: approvals count failed", { err: String(err) });
    return 0;
  }
}

/** What the app switcher shows on a viewed app (design v4 "App switcher"; architecture v3 A1.2). */
export type SwitcherData =
  | { show: false }
  | { show: true; current: { slug: string; name: string } | null; apps: { slug: string; name: string }[]; canEdit: boolean };

/**
 * Switcher data for the viewer of `/a/<slug>`. Only signed-in session users get it: guests, agents
 * (render sessions) and signed-out viewers get `show: false` (no
 * switcher). While app-builder has not registered the app access hook (Wave 1), the sheet lists no
 * apps and no "Edit this app": only "Back to Atrium".
 */
export async function switcherData(principal: Principal | null, slug: string): Promise<SwitcherData> {
  if (!principal || principal.kind !== "user") return { show: false };
  const access = appAccess();
  if (!access) return { show: true, current: null, apps: [], canEdit: false };
  let current: App | null = null;
  let apps: App[] = [];
  let canEdit = false;
  try {
    current = await access.appBySlug(slug);
    apps = await access.appsFor(principal);
    canEdit = current ? await access.canEditApp(principal, current.id) : false;
  } catch (err) {
    log.warn("shell: switcher data failed", { err: String(err) });
  }
  return {
    show: true,
    current: current ? { slug: current.slug, name: current.name } : null,
    apps: apps.filter((a) => a.slug !== slug).map((a) => ({ slug: a.slug, name: a.name })),
    canEdit,
  };
}
