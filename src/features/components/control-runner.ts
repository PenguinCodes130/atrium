// A ready RenderContext.runControl for app-builder (architecture 6.2, amendments A1.4 and A4.2).
// It posts to POST /api/controls/run and owns the confirm rules, so every component and the html
// block bridge behave the same:
//  - agent-render and edit never run (refused, nothing is sent);
//  - draft-preview always opens the host confirm "Draft preview: run <label> for real?" first
//    (labelled "Not published yet" for draft-only controls), and only then sends draft and confirmed;
//  - elsewhere, a control with confirm text opens the host confirm with that text first.
// The html block bridge calls runControl like any component, so it can never set `confirmed` itself.
import type { ControlRunResponse, RenderMode } from "@/core/contracts";
import type { ControlInfo } from "./render/resolve";

export type ControlRunnerDeps = {
  appId: string;
  mode: RenderMode;
  controls: Record<string, ControlInfo>;
  /** The shell's ControlConfirm (top layer). Resolves true when the person chose to run. */
  confirm(text: string): Promise<boolean>;
  fetch?: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
};

export const NOT_RUN_MESSAGE = "Not run.";

export function draftConfirmText(label: string, draftOnly?: boolean): string {
  return `Draft preview: run ${label} for real?${draftOnly ? " Not published yet." : ""}`;
}

export function createControlRunner(deps: ControlRunnerDeps): (nodeId: string, controlId: string, input?: unknown) => Promise<ControlRunResponse> {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  return async (nodeId, controlId, input) => {
    if (deps.mode === "agent-render" || deps.mode === "edit") return { ok: false, code: "forbidden", message: "Controls do not run here." };
    const info = deps.controls[controlId];
    const label = info?.label ?? "this control";
    const draft = deps.mode === "draft-preview";
    if (draft) {
      if (!(await deps.confirm(draftConfirmText(label, info?.draftOnly)))) return { ok: false, code: "forbidden", message: NOT_RUN_MESSAGE };
    } else if (info?.confirm) {
      if (!(await deps.confirm(info.confirm))) return { ok: false, code: "forbidden", message: NOT_RUN_MESSAGE };
    }
    const body = { appId: deps.appId, nodeId, controlId, ...(input !== undefined ? { input } : {}), ...(draft ? { draft: true, confirmed: true } : {}) };
    try {
      const res = await doFetch("/api/controls/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as Partial<ControlRunResponse> & { error?: { code?: string; message?: string }; code?: string; message?: string };
      if (res.status === 200 && json.ok) return { ok: true, ...(json.message ? { message: json.message } : {}) };
      const code = (json.code ?? json.error?.code ?? "forbidden") as Extract<ControlRunResponse, { ok: false }>["code"];
      const message = json.message ?? json.error?.message ?? (res.status === 429 ? "Too many runs; try again in a moment." : "The control did not run.");
      return { ok: false, code: ["forbidden", "not_available", "not_shared", "invalid_input", "rate_limited", "busy"].includes(code) ? code : "forbidden", message };
    } catch {
      return { ok: false, code: "not_available", message: "Atrium could not be reached." };
    }
  };
}
