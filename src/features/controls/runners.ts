// Control runners (architecture v3 section 6.2): integrations runs "command" controls itself;
// actions registers the "workflow" runner in Wave 3 with registerControlRunner("workflow", fn).
import type { ControlDef, Principal } from "@/core/contracts";

export type WorkflowRunContext = {
  principal: Principal;
  appId: string;
  version: number;
  control: ControlDef & { run: Extract<ControlDef["run"], { kind: "workflow" }> };
  input: Record<string, unknown>;
  controlRunId: string;
  signal: AbortSignal;
};
export type ControlRunner = (ctx: WorkflowRunContext) => Promise<{ ok: boolean; message?: string }>;

export const WORKFLOW_NOT_AVAILABLE = "Workflow controls arrive with actions";

const g = globalThis as unknown as { __atriumControlRunners?: Map<string, ControlRunner> };
const runners = (g.__atriumControlRunners ??= new Map());

export function registerControlRunner(kind: "workflow", fn: ControlRunner): void {
  runners.set(kind, fn);
}

export function controlRunner(kind: "workflow"): ControlRunner | undefined {
  return runners.get(kind);
}

/** For tests: forget every registered runner. */
export function resetControlRunners(): void {
  runners.clear();
}
