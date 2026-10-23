import "server-only";
import { headers } from "next/headers";
import type { AgentScope, Role } from "@/core/contracts";
import type { AccountPrincipal } from "./server/policy";
import { guestFromHeaders, requireViewerFrom, type GuestViewer, type Viewer } from "./guest/service";
import {
  principalFromHeaders,
  requireScopeFrom,
  requireStepUpFrom,
  requireUserFrom,
  sessionFromHeaders,
  type AtriumSession,
} from "./server/session";

// Auth's server exports (architecture section 2). Every route handler and server action calls
// requireUser() or requireScope(); the proxy is never the only check. Pass the Request in route
// handlers; server components and server actions can omit it (next/headers is used).
//
//   const { user, principal } = await requireUser();            // 401 when signed out
//   await requireUser(req, "member");                            // 403 for a viewer
//   const p = await requireScope("atrium:edit", { req });        // agents need the scope AND the role
//   await requireStepUp();                                       // 403 step_up_required when stale
//
// Errors are AtriumError subclasses; `errorResponse(err)` from "@/core/errors" turns them into
// 401, 403 or 429 (with Retry-After) responses.

export type { AtriumSession, SessionUser, SessionInfo, AgentTokenRecord, AgentTokenResolver, StepUpMethod } from "./server/session";
export { StepUpRequired, registerAgentTokenResolver } from "./server/session";
export { onUserAccessRevoked } from "./server/users";
export { checkScope, roleAtLeast, SCOPE_MIN_ROLE, ALL_SCOPES, STEP_UP_WINDOW_MS } from "./server/policy";
export { createPersonalAccessToken, hashPersonalAccessToken, mcpUnauthorized } from "./server/tokens";
export { getAuthBanners } from "./server/banners";
// MCP OAuth (round 2). agent-api serves /.well-known/oauth-protected-resource with
// { resource: mcpResource(), authorization_servers: [oauthIssuer()], scopes_supported: OAUTH_SCOPES },
// and can answer /.well-known/oauth-authorization-server/api/auth by fetching auth's
// /api/auth/.well-known/oauth-authorization-server. OAuth access tokens (atr_oat_...) resolve through
// getPrincipal() / requireScope() like personal access tokens.
export { mcpResource, oauthIssuer, OAUTH_SCOPES, OAUTH_ACCESS_TOKEN_PREFIX } from "./server/oauth-tokens";

async function hdrs(req?: Request): Promise<Headers> {
  return req ? req.headers : new Headers(await headers());
}

/** The signed-in session, or null. */
export async function getSession(req?: Request): Promise<AtriumSession | null> {
  return sessionFromHeaders(await hdrs(req));
}

/** The current principal (agent by bearer token, else signed-in user), or null. */
export async function getPrincipal(req?: Request): Promise<AccountPrincipal | null> {
  return principalFromHeaders(await hdrs(req));
}

/** Requires a signed-in user (sessions only, never an agent token), optionally with a minimum role. */
export async function requireUser(req?: Request, minRole?: Role): Promise<AtriumSession> {
  return requireUserFrom(await hdrs(req), minRole);
}

/** Requires a principal whose scopes include `scope` and whose role meets the scope's (or `minRole`). */
export async function requireScope(scope: AgentScope, opts: { req?: Request; minRole?: Role } = {}): Promise<AccountPrincipal> {
  return requireScopeFrom(await hdrs(opts.req), scope, opts.minRole);
}

/** Requires a step-up on this session within the last 10 minutes. */
export async function requireStepUp(req?: Request): Promise<AtriumSession> {
  return requireStepUpFrom(await hdrs(req));
}

// ---- Guest links (architecture v3 section 5.1, round 3) -------------------------------------------
// Guest routes (/a/<slug>/*, the data stream and its polling fallback, POST /api/controls/run, uploads
// and /api/img for the published app) call requireViewer(); every other route keeps requireUser() or
// requireScope(), which never accept a guest.
//
//   const viewer = await requireViewer(req, { appId });  // session user, or the guest of that app; else 401
//   if (viewer.kind === "guest") { ...published version only, resolved values only... }
//
// app-builder calls revokeAppGuestLinks(appId, "guests_off" | "app_deleted", principal) when an app's
// access.guests is turned off or the app is deleted, and revokeCreatorGuestLinks(userId,
// "creator_lost_edit", principal, appId) when a member loses edit access to an app (amendment A1.1).
// requireViewer() re-checks canOpenApp on every guest request, so a missed call still ends the session.
export type { GuestPrincipal, GuestLinkView, GuestLinkList, CreatedGuestLink, Viewer, GuestViewer } from "./guest/service";
export { createGuestLink, listGuestLinks, revokeGuestLink, revokeAppGuestLinks, revokeCreatorGuestLinks, isGuest } from "./guest/service";
export { GUEST_COOKIE, EXPIRED_TEXT } from "./guest/policy";

/** A signed-in user (a session always wins), or the guest principal on a guest route; else 401. */
export async function requireViewer(req?: Request, opts: { appId?: string } = {}): Promise<Viewer> {
  return requireViewerFrom(await hdrs(req), opts);
}

/** The guest and their app when the request carries a valid guest session (and no session), else null. */
export async function getGuestViewer(req?: Request): Promise<GuestViewer | null> {
  const h = await hdrs(req);
  if (await sessionFromHeaders(h)) return null;
  return guestFromHeaders(h);
}
