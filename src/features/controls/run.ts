// runControl() (architecture v3 section 6.2, amendment A1.4): the server side of every click on a
// published control. In order: who is asking, the app-access hook, the published (or confirmed
// draft) control, the input against its node, limits, parameter resolution, the command or
// workflow runner, then one control run record and one control.run audit entry. Every refusal is
// audited, except rate-limit refusals after the first per principal per minute. Gauntlet r2
// security finding 2: refusals have their own per principal limit, checked before the entry is
// written, and a refused run's entry records a bounded summary of the input, never the input.
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CommandDef, CommandResult, ControlDef, ControlRunResponse, Principal } from "@/core/contracts";
import { appAccess } from "@/core/hooks";
import { audit } from "@/features/audit/write";
import { bindingAllowedInApp, commandCatalog, NOT_SHARED_MESSAGE } from "@/features/integrations/commands";
import { hostCommand } from "@/features/integrations/host/command";
import { getIntegrationRow } from "@/features/integrations/repo";
import { checkInput, nodeRunsControl, resolveParams, type Viewer } from "./input";
import { controlLimits, cooldownOf } from "./limits";
import { insertControlRun } from "./repo";
import { controlRunner, WORKFLOW_NOT_AVAILABLE } from "./runners";

export const runRequestSchema = z.object({
  appId: z.string().min(1).max(100),
  nodeId: z.string().min(1).max(100),
  controlId: z.string().min(1).max(100),
  input: z.unknown().optional(),
  draft: z.boolean().optional(),
  confirmed: z.boolean().optional(),
}).strict();

export type RunOutcome = { status: number; body: ControlRunResponse; retryAfterSec?: number };

export const MESSAGES = {
  signIn: "Sign in to use this control.",
  agents: "Agents, access tokens and previews can never run a control.",
  notAvailable: "Controls arrive with apps. This Atrium has no apps yet.",
  cannotOpen: "You cannot open this app.",
  draftEditors: "Only people who can edit this app can run its draft controls.",
  draftConfirm: "Confirm the draft preview run first.",
  missing: "This control is not on the published app any more.",
  rateLimited: "Too many runs. Wait a moment and try again.",
  cooldown: "That control was just used. Try again in a moment.",
  busy: "That control is still busy. Try again in a moment.",
} as const;

const MAX_INPUT_BYTES = 16 * 1024;

type Ctx = { principal: Principal | null; ip?: string; signal?: AbortSignal };

function principalKey(p: Principal): string {
  return p.kind === "guest" ? `g:${p.guestLinkId}` : `${p.kind}:${p.userId}`;
}

const SUMMARY_KEYS = 20;
const SUMMARY_KEY_CHARS = 64;
const ID_CHARS = 100;

/** What a refused run's audit entry keeps of the input: its size, type and first keys, cut short. */
export function inputSummary(input: unknown): { bytes: number; type: string; keys?: string[]; keyCount?: number } {
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8"); } catch { bytes = -1; }
  const type = input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
  if (type !== "object") return { bytes, type };
  const keys = Object.keys(input as object);
  return { bytes, type, keys: keys.slice(0, SUMMARY_KEYS).map((k) => k.slice(0, SUMMARY_KEY_CHARS)), keyCount: keys.length };
}

/** A refused run's audit detail: ids cut to their schema size, the input as a summary only. */
function boundedDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (k === "input") out.input = inputSummary(v);
    else out[k] = typeof v === "string" ? v.slice(0, ID_CHARS) : v;
  }
  return out;
}

function refuse(ctx: Ctx, status: number, code: Exclude<ControlRunResponse, { ok: true }>["code"], message: string, detail: Record<string, unknown>, opts: { retryAfterSec?: number; audited?: boolean } = {}): RunOutcome {
  const p = ctx.principal;
  let audited = !!p && opts.audited !== false;
  if (p && opts.audited === undefined) {
    // The refusal limit comes before the audit entry, so cheap refusals cannot grow the log. The
    // run limit's own refusals are already audited once a minute, so they are not counted again.
    const lim = controlLimits().refusal(principalKey(p));
    if (!lim.ok) {
      status = 429;
      code = "rate_limited";
      message = MESSAGES.rateLimited;
      opts = { ...opts, retryAfterSec: Math.max(opts.retryAfterSec ?? 0, lim.retryAfterSec) };
      audited = lim.audit;
    }
  }
  if (p && audited) {
    audit.write({
      actor: p,
      event: "control.run",
      target: { type: "control", id: String(detail.controlId ?? "unknown").slice(0, ID_CHARS) },
      result: "error",
      detail: { ...boundedDetail(detail), refused: code, error: message },
      ...(ctx.ip ? { ip: ctx.ip } : {}),
    });
  }
  return { status, body: { ok: false, code, message }, ...(opts.retryAfterSec ? { retryAfterSec: opts.retryAfterSec } : {}) };
}

function errorMessage(r: CommandResult): string {
  if (r.ok) return r.message ?? "Done";
  return r.error.hint ? `${r.error.message} ${r.error.hint}` : r.error.message;
}

/** Runs one control click. `ctx.principal` is null when the request has no session and no guest cookie. */
export async function runControl(ctx: Ctx, raw: unknown): Promise<RunOutcome> {
  const p = ctx.principal;
  const parsed = runRequestSchema.safeParse(raw);
  const base = parsed.success ? { appId: parsed.data.appId, nodeId: parsed.data.nodeId, controlId: parsed.data.controlId } : {};
  // 1. Who: signed-in session users of any role, and guests for their own app. Never agents.
  if (!p) return refuse(ctx, 403, "forbidden", MESSAGES.signIn, base);
  if (p.kind !== "user" && p.kind !== "guest") return refuse(ctx, 403, "forbidden", MESSAGES.agents, base);
  if (!parsed.success) return refuse(ctx, 400, "invalid_input", "That request is not a control run.", base);
  const req = parsed.data;
  if (req.input !== undefined && JSON.stringify(req.input).length > MAX_INPUT_BYTES) return refuse(ctx, 400, "invalid_input", "The input is too large.", base);
  const detail: Record<string, unknown> = { ...base, ...(req.input !== undefined ? { input: req.input } : {}), ...(req.draft ? { draft: true } : {}) };

  // 2. The app-access hook. Before Wave 2 it is unregistered: refuse, run nothing, record no run.
  const hook = appAccess();
  if (!hook) return refuse(ctx, 403, "not_available", MESSAGES.notAvailable, detail);
  if (p.kind === "guest" && p.appId !== req.appId) return refuse(ctx, 403, "forbidden", MESSAGES.cannotOpen, detail);
  if (!(await hook.canOpenApp(p, req.appId))) return refuse(ctx, 403, "forbidden", MESSAGES.cannotOpen, detail);
  if (req.draft) {
    if (p.kind === "guest" || !(await hook.canEditApp(p, req.appId))) return refuse(ctx, 403, "forbidden", MESSAGES.draftEditors, detail);
    // A1.4: only the host-drawn confirm sets `confirmed`; the html block bridge cannot.
    if (req.confirmed !== true) return refuse(ctx, 403, "forbidden", MESSAGES.draftConfirm, detail);
  }
  // Runs always load the current document (published, or the draft for a confirmed editor).
  const found = await hook.publishedControl(req.appId, req.controlId, req.nodeId, { draft: !!req.draft, principal: p });
  if (!found || found.control.id !== req.controlId || found.node.id !== req.nodeId) return refuse(ctx, 403, "forbidden", MESSAGES.missing, detail);
  const { control, node } = found;
  if (!nodeRunsControl(node, control.id)) return refuse(ctx, 403, "forbidden", "That component does not run this control.", detail);
  const app = await hook.appById(req.appId);
  const version = req.draft ? 0 : found.version;
  Object.assign(detail, { label: control.label, version, ...(req.draft && app ? { draftRev: app.draftRev } : {}) });

  // The command this control runs, and whether this app may still use the integration (A1.1).
  let def: CommandDef | undefined;
  if (control.run.kind === "command") {
    const row = getIntegrationRow(control.run.integrationId);
    if (!row) return refuse(ctx, 403, "forbidden", "The integration this control uses no longer exists.", detail);
    if (app && !bindingAllowedInApp(app, row)) return refuse(ctx, 403, "not_shared", NOT_SHARED_MESSAGE, detail);
    def = commandCatalog(row).get(control.run.commandId)?.def;
    if (!def) return refuse(ctx, 403, "forbidden", `This integration cannot run "${control.run.commandId}".`, detail);
  }

  // 3. Input against the node as loaded; target fields only from the control's literal params.
  const input = checkInput(node, req.input, def);
  if (!input.ok) return refuse(ctx, 400, "invalid_input", input.message, detail);
  const viewer: Viewer = p.kind === "guest" ? { kind: "guest", name: p.label } : { kind: "user", name: "" };
  const resolved = resolveParams(control, def, req.input, viewer);
  if (!resolved.ok) return refuse(ctx, 400, "invalid_input", resolved.message, detail);

  // 4. Limits: per principal per app, the control's cooldown, and at most 2 in flight.
  const limits = controlLimits();
  const pk = principalKey(p);
  const rate = limits.rate(pk, req.appId);
  if (!rate.ok) return refuse(ctx, 429, "rate_limited", MESSAGES.rateLimited, detail, { retryAfterSec: rate.retryAfterSec, audited: limits.firstRateRefusal(pk) });
  const controlKey = `${req.appId}|${control.id}`;
  const cool = limits.cooldown(controlKey, cooldownOf(control.cooldownMs));
  if (!cool.ok) return refuse(ctx, 429, "rate_limited", MESSAGES.cooldown, detail, { retryAfterSec: Math.max(1, Math.ceil(cool.retryAfterMs / 1000)) });
  if (!(await limits.acquire(controlKey))) return refuse(ctx, 429, "busy", MESSAGES.busy, detail, { retryAfterSec: 1 });

  // 5. Run, 6. record, 7. answer.
  const runId = randomUUID();
  const started = performance.now();
  const at = new Date().toISOString();
  let ok: boolean;
  let message: string;
  try {
    if (control.run.kind === "command") {
      const r = await hostCommand(control.run.integrationId, control.run.commandId, resolved.params, ctx.signal ? { signal: ctx.signal } : {});
      ok = r.ok;
      message = errorMessage(r);
    } else {
      const runner = controlRunner("workflow");
      if (!runner) {
        ok = false;
        message = WORKFLOW_NOT_AVAILABLE;
      } else {
        const r = await runner({ principal: p, appId: req.appId, version, control: control as ControlDef & { run: Extract<ControlDef["run"], { kind: "workflow" }> }, input: (req.input && typeof req.input === "object" ? req.input : {}) as Record<string, unknown>, controlRunId: runId, signal: ctx.signal ?? new AbortController().signal });
        ok = r.ok;
        message = r.message ?? (r.ok ? "Sent" : "The workflow did not start.");
      }
    }
  } catch {
    ok = false;
    message = "The control failed in an unexpected way.";
  } finally {
    limits.release(controlKey);
  }
  const durationMs = Math.round(performance.now() - started);
  insertControlRun({ id: runId, appId: req.appId, version, controlId: control.id, nodeId: node.id, by: p, at, ...(req.input !== undefined ? { input: req.input } : {}), result: ok ? "ok" : "error", message, durationMs });
  audit.write({
    actor: p,
    event: "control.run",
    target: { type: "control", id: control.id, label: control.label },
    result: ok ? "ok" : "error",
    detail: { controlId: control.id, label: control.label, version, input: req.input ?? null, durationMs, nodeId: node.id, controlRunId: runId, ...(req.draft && app ? { draftRev: app.draftRev } : {}), ...(ok ? {} : { error: message }) },
    ...(ctx.ip ? { ip: ctx.ip } : {}),
  });
  if (!ok && control.run.kind === "workflow" && message === WORKFLOW_NOT_AVAILABLE) return { status: 403, body: { ok: false, code: "not_available", message } };
  if (ok) return { status: 200, body: { ok: true, ...(message && message !== "Done" ? { message } : {}) } };
  // The run reached the device and it failed (unreachable, timed out, wrong credentials...). A1.4
  // has no code for this, so it answers 502 with not_available and the adapter's plain message.
  return { status: 502, body: { ok: false, code: "not_available", message } };
}
