import "server-only";
import { eq } from "drizzle-orm";
import type { AgentScope, Principal, Role } from "@/core/contracts";
import { db } from "@/core/db";
import { AtriumError, Forbidden, Unauthorized } from "@/core/errors";
import { users, twoFactors, accounts } from "@/db/schema/auth";
import { getAuth } from "./auth";
import { ensureBootstrapped } from "./bootstrap";
import { checkScope, stepUpValid, type AccountPrincipal } from "./policy";
import { hit } from "./rate-limit";
import { looksLikeOAuthAccessToken, resolveOAuthToken } from "./oauth-tokens";

// Principal resolution and the checks every route handler and server action calls
// (architecture sections 5 and 9b). The proxy is only the front gate; these are the real checks.

export type SessionUser = { id: string; email: string; name: string; role: Role; twoFactorEnabled: boolean };
export type SessionInfo = { id: string; createdAt: Date; expiresAt: Date; stepUpAt: Date | null };
export type AtriumSession = { user: SessionUser; session: SessionInfo; principal: Extract<Principal, { kind: "user" }> };

// ---- Agent tokens -------------------------------------------------------------------------------
// agent-api owns the agent_token table (architecture section 2), so it registers how a bearer token
// is looked up. Auth adds the user's live role, the access-revoked cut-off and the MCP rate limit.

export type AgentTokenRecord = {
  tokenId: string;
  userId: string;
  agentName: string;
  scopes: AgentScope[];
  via: "mcp-oauth" | "pat";
  createdAt: Date;
};
export type AgentTokenResolver = (bearer: string) => Promise<AgentTokenRecord | null>;

let tokenResolver: AgentTokenResolver | undefined;

export function registerAgentTokenResolver(fn: AgentTokenResolver): void {
  tokenResolver = fn;
}

// TOTP when enrolled; otherwise the password for a password account, else a fresh provider sign-in.
export type StepUpMethod = "totp" | "password" | "provider";

export class StepUpRequired extends AtriumError {
  constructor(readonly method: StepUpMethod) {
    super("Confirm it is you to continue.", 403, "step_up_required");
  }
}

function bearerOf(headers: Headers): string | null {
  const h = headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}

async function agentPrincipal(bearer: string): Promise<Extract<Principal, { kind: "agent" }> | null> {
  // MCP OAuth access tokens are auth's own (oauth-tokens.ts); personal access tokens are agent-api's.
  const rec = looksLikeOAuthAccessToken(bearer) ? resolveOAuthToken(bearer) : tokenResolver ? await tokenResolver(bearer) : null;
  if (!rec) return null;
  const u = db().select({ role: users.role, accessRevokedAt: users.accessRevokedAt }).from(users).where(eq(users.id, rec.userId)).get();
  if (!u) return null;
  if (u.accessRevokedAt && rec.createdAt.getTime() <= u.accessRevokedAt.getTime()) return null;
  hit("mcpToken", rec.tokenId); // 120 requests per minute per token; throws RateLimited
  return { kind: "agent", userId: rec.userId, role: u.role, via: rec.via, tokenId: rec.tokenId, agentName: rec.agentName, scopes: rec.scopes };
}

/** The signed-in session for these request headers, or null. Expired, revoked or unknown sessions are null. */
export async function sessionFromHeaders(headers: Headers): Promise<AtriumSession | null> {
  const setup = await ensureBootstrapped();
  if (setup.state !== "ready") return null;
  const res = await getAuth().api.getSession({ headers });
  if (!res) return null;
  const role = (res.user as { role?: Role }).role ?? "viewer";
  const s = res.session as typeof res.session & { stepUpAt?: Date | string | null };
  return {
    user: {
      id: res.user.id,
      email: res.user.email,
      name: res.user.name,
      role,
      twoFactorEnabled: !!(res.user as { twoFactorEnabled?: boolean }).twoFactorEnabled,
    },
    session: {
      id: s.id,
      createdAt: new Date(s.createdAt),
      expiresAt: new Date(s.expiresAt),
      stepUpAt: s.stepUpAt ? new Date(s.stepUpAt) : null,
    },
    principal: { kind: "user", userId: res.user.id, role, via: "session" },
  };
}

/** Any principal for these headers: an agent by bearer token, else a signed-in user. */
export async function principalFromHeaders(headers: Headers): Promise<AccountPrincipal | null> {
  const bearer = bearerOf(headers);
  if (bearer) return agentPrincipal(bearer);
  return (await sessionFromHeaders(headers))?.principal ?? null;
}

export async function requireUserFrom(headers: Headers, minRole?: Role): Promise<AtriumSession> {
  const s = await sessionFromHeaders(headers);
  if (!s) throw new Unauthorized();
  if (minRole) {
    const d = checkScope(s.principal, minRole === "viewer" ? "atrium:read" : "atrium:edit", minRole);
    if (!d.ok) throw new Forbidden(d.message);
  }
  return s;
}

export async function requireScopeFrom(headers: Headers, scope: AgentScope, minRole?: Role): Promise<AccountPrincipal> {
  const p = await principalFromHeaders(headers);
  if (!p) throw new Unauthorized();
  const d = checkScope(p, scope, minRole);
  if (!d.ok) throw new Forbidden(d.message);
  return p;
}

/** How this user proves it is them again (architecture section 5). */
export function stepUpMethodFor(userId: string): StepUpMethod {
  const tf = db().select({ verified: twoFactors.verified }).from(twoFactors).where(eq(twoFactors.userId, userId)).get();
  if (tf && tf.verified !== false) return "totp";
  const providers = db().select({ providerId: accounts.providerId }).from(accounts).where(eq(accounts.userId, userId)).all();
  return providers.some((a) => a.providerId === "credential") ? "password" : "provider";
}

export async function requireStepUpFrom(headers: Headers, now: number = Date.now()): Promise<AtriumSession> {
  const s = await requireUserFrom(headers);
  if (!stepUpValid(s.session.stepUpAt, now)) throw new StepUpRequired(stepUpMethodFor(s.user.id));
  return s;
}
