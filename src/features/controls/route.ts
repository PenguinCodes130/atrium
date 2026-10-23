// The POST /api/controls/run handler, kept here so it can be tested without Next.
import "server-only";
import { audit } from "@/features/audit/write";
import { controlLimits } from "./limits";
import { bearerPrincipal, gate, viewerOf } from "./request";
import { runControl, type RunOutcome } from "./run";

const MAX_BODY_BYTES = 32 * 1024;

function respond(o: RunOutcome): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (o.retryAfterSec) headers["Retry-After"] = String(o.retryAfterSec);
  return Response.json(o.body, { status: o.status, headers });
}

export async function handleControlRun(req: Request): Promise<Response> {
  const refused = gate(req);
  if (refused) {
    // Refusals are audited when the caller can be named (a bearer token that resolves to an agent).
    const agent = refused.reason === "bearer" ? await bearerPrincipal(req) : null;
    // Gauntlet r2 finding 2: these count against the same per principal refusal limit as run refusals.
    const lim = agent ? controlLimits().refusal(agent.kind === "guest" ? `g:${agent.guestLinkId}` : `${agent.kind}:${agent.userId}`) : undefined;
    if (agent && lim && (lim.ok || lim.audit)) audit.write({ actor: agent, event: "control.run", target: { type: "control", id: "unknown" }, result: "error", detail: { refused: "forbidden", reason: refused.reason, error: refused.message } });
    return respond({ status: 403, body: { ok: false, code: "forbidden", message: refused.message } });
  }
  const principal = await viewerOf(req);
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return respond({ status: 400, body: { ok: false, code: "invalid_input", message: "The request is too large." } });
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  return respond(await runControl({ principal, signal: req.signal }, raw));
}
