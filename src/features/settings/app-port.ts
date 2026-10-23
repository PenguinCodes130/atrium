// The one place settings reaches into apps (architecture v3 section 4.9; settings spec 3.3, 3.8, 3.9).
//
// settings needs four things that app-builder owns: the list of apps with their draft and published
// documents (theme "Used by", delete refusal, "Update apps using this theme", guest upload checks)
// and `applyOps()` (themes.apply and "Update apps using this theme" go through the app draft like every
// other edit). app-builder is built in parallel, so settings never imports it: app-builder (or the
// lead, after the wave) calls registerAppPort() once at start-up with its implementation. Until then
// every caller gets `null` and answers "not available"; nothing is faked in shipped code.
import "server-only";
import type { AppDocument, DraftOp, Principal } from "@/core/contracts";

export type PortApp = {
  appId: string;
  slug: string;
  name: string;
  draftRev: number;
  draft: AppDocument;
  /** The live published version, when there is one. */
  published?: { version: number; doc: AppDocument };
};

export type AppPort = {
  /** Every app with its draft and live published document. */
  listApps(): Promise<PortApp[]>;
  /** One app, or null. */
  getApp(appId: string): Promise<PortApp | null>;
  /** app-builder's applyOps (wave-2-lead-prep): validated, atomic, bumps rev; a stale rev throws its conflict error. */
  applyOps(appId: string, rev: number, ops: DraftOp[], by: Principal): Promise<{ rev: number }>;
};

const g = globalThis as unknown as { __atriumSettingsAppPort?: AppPort };

export function registerAppPort(port: AppPort): void {
  g.__atriumSettingsAppPort = port;
}

export function appPort(): AppPort | null {
  return g.__atriumSettingsAppPort ?? null;
}

/** For tests: back to unregistered. */
export function resetAppPort(): void {
  g.__atriumSettingsAppPort = undefined;
}
