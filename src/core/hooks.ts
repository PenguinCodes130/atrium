// Skeleton (architecture v3 section 2): registration points that let an earlier wave call a later one.
// app-builder registers the app access resolver in Wave 2. Until then callers get null and answer not_available.
import type { AppAccessResolver, Principal } from "@/core/contracts";

const g = globalThis as unknown as { __atriumAppAccess?: AppAccessResolver };

export function registerAppAccess(resolver: AppAccessResolver): void {
  g.__atriumAppAccess = resolver;
}

export function appAccess(): AppAccessResolver | undefined {
  return g.__atriumAppAccess;
}

/** For tests: put the hook back to its unregistered state. */
export function resetAppAccess(): void {
  g.__atriumAppAccess = undefined;
}

// Amendment A1.2: actions (Wave 3) feeds the shell's Approvals badge; hidden while unregistered.
type ApprovalsCount = (principal: Principal) => Promise<number>;
const h = globalThis as unknown as { __atriumApprovalsCount?: ApprovalsCount };

export function registerApprovalsCount(fn: ApprovalsCount): void {
  h.__atriumApprovalsCount = fn;
}

export function approvalsCount(): ApprovalsCount | undefined {
  return h.__atriumApprovalsCount;
}
