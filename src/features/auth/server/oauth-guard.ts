import "server-only";
import { AtriumError } from "@/core/errors";
import { logger } from "@/core/log";
import { lookupAllowlist } from "./allowlist";
import { scopesIn } from "./oauth";
import { requireStepUpFrom, sessionFromHeaders } from "./session";

const log = logger("auth");

// ---- Atrium's checks in front of the provider endpoints (called from handler.ts) -----------------

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.clone().json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Runs before /oauth2/authorize, /oauth2/consent and /oauth2/continue. The allowlist applies to MCP
 * OAuth too: a signed-in user whose email no pattern admits cannot authorize a client. Granting
 * atrium:propose needs a step-up on this session first (403 step_up_required otherwise).
 */
export async function oauthGuard(req: Request, path: string): Promise<void> {
  if (path !== "/oauth2/authorize" && path !== "/oauth2/consent" && path !== "/oauth2/continue") return;
  const s = await sessionFromHeaders(req.headers);
  if (!s) return; // Better Auth sends the browser to /sign-in (authorize) or answers 401 (consent).
  if (!lookupAllowlist(s.user.email)) {
    log.info("OAuth authorization refused: not on the allowlist");
    throw new AtriumError("This email is not on the allowlist. Ask the owner of this Atrium to add it.", 403, "not_allowlisted");
  }
  if (path === "/oauth2/consent" && req.method === "POST") {
    const b = await body(req);
    if (b.accept !== true) return;
    const granted = typeof b.scope === "string" ? b.scope.split(" ").filter(Boolean) : scopesIn(typeof b.oauth_query === "string" ? b.oauth_query : null);
    if (granted.includes("atrium:propose")) await requireStepUpFrom(req.headers);
  }
}

