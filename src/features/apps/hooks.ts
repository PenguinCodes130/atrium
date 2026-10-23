// Registration points app-builder offers later subsystems (no frozen interface covers them yet; see
// the build report's interface gaps). Until registered, the defaults below apply.
import type { Principal } from "@/core/contracts";

type LayoutAutoApply = (p: Principal) => boolean;
type VersionRetention = () => number | null;

const g = globalThis as unknown as { __atriumLayoutAutoApply?: LayoutAutoApply; __atriumVersionRetention?: VersionRetention };

/** agent-api (Wave 4): whether this agent token has layout auto-apply on. Default: off for everyone. */
export function registerLayoutAutoApply(fn: LayoutAutoApply | undefined): void {
  g.__atriumLayoutAutoApply = fn;
}
export function layoutAutoApply(p: Principal): boolean {
  if (p.kind !== "agent") return false;
  try {
    return g.__atriumLayoutAutoApply?.(p) === true;
  } catch {
    return false;
  }
}

/** settings: "keep the last N" versions (N at least 20), or null to keep every version (the default). */
export function registerVersionRetention(fn: VersionRetention | undefined): void {
  g.__atriumVersionRetention = fn;
}
export function versionRetention(): number | null {
  try {
    const n = g.__atriumVersionRetention?.();
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.max(20, Math.floor(n)) : null;
  } catch {
    return null;
  }
}
