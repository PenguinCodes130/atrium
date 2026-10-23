// app-shell server-only exports. Import from "@/features/shell/server" in server components and
// route handlers only (custom CSS is untrusted and is scoped on the server, never in the browser).
import "server-only";
import { env } from "@/core/env";
import { DEFAULT_INSTANCE_NAME, readableHost } from "./instance-name";

export { pendingApprovals, switcherData } from "./switcher-data";
export type { SwitcherData } from "./switcher-data";

export { scopeCustomCss, scopeCustomCssWithReport, rootSelector, CANVAS_ROOT } from "./custom-css";
export type { ScopedCss, ScopeResult, DroppedItem, ScopeOptions, ScopeRoot } from "./custom-css";
export { readableHost, DEFAULT_INSTANCE_NAME } from "./instance-name";

/**
 * The clock readout's instance name (architecture v3 A1.7): the settings value "Instance name" once
 * settings registers it, otherwise the host name of ATRIUM_PUBLIC_URL.
 */
let instanceNameSource: (() => string | null) | null = null;
export function registerInstanceName(fn: () => string | null): void {
  instanceNameSource = fn;
}
export function instanceName(): string {
  const fromSettings = instanceNameSource?.();
  if (fromSettings && fromSettings.trim()) return fromSettings.trim().slice(0, 40);
  try {
    return readableHost(new URL(env().ATRIUM_PUBLIC_URL).hostname);
  } catch {
    return DEFAULT_INSTANCE_NAME;
  }
}


export { AppSwitcherSlot } from "./app-switcher-slot";
