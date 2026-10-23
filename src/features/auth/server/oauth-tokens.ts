import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentScope } from "@/core/contracts";
import { db } from "@/core/db";
import { env } from "@/core/env";
import { oauthAccessTokens, oauthClients } from "@/db/schema/auth";
import { ALL_SCOPES } from "./policy";
import type { AgentTokenRecord } from "./session";

// MCP OAuth token names and validation (architecture section 9b). Kept apart from oauth.ts so the
// session module can use it without importing the Better Auth instance.

export const OAUTH_ACCESS_TOKEN_PREFIX = "atr_oat_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "atr_ort_";
/** Scopes an MCP client may ask for: the three agent scopes, plus offline_access for refresh tokens. */
export const OAUTH_SCOPES = ["atrium:read", "atrium:edit", "atrium:propose", "offline_access"] as const;
export const OAUTH_ACCESS_TOKEN_SECONDS = 60 * 60;

/** The MCP resource (RFC 8707 `resource`), the URL agent-api serves the MCP endpoint at. */
export function mcpResource(): string {
  return `${new URL(env().ATRIUM_PUBLIC_URL).origin}/mcp`;
}

/** The authorization server issuer: Better Auth's base URL. Metadata is at <issuer>/.well-known/oauth-authorization-server. */
export function oauthIssuer(): string {
  return `${new URL(env().ATRIUM_PUBLIC_URL).origin}/api/auth`;
}

// ---- Token validation (for agent-api's MCP endpoint, through getPrincipal / requireScope) -------

function storedHash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("base64url");
}

function parseList(v: string | null): string[] {
  if (!v) return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function looksLikeOAuthAccessToken(bearer: string): boolean {
  return bearer.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) && bearer.length > OAUTH_ACCESS_TOKEN_PREFIX.length;
}

/** Looks up an MCP OAuth access token. Null when unknown, revoked, expired, user-less or its client is disabled. */
export function resolveOAuthToken(bearer: string, now: number = Date.now()): AgentTokenRecord | null {
  if (!looksLikeOAuthAccessToken(bearer)) return null;
  // The prefix is not stored; the plugin keeps SHA-256 (base64url) of the rest.
  const row = db().select().from(oauthAccessTokens).where(eq(oauthAccessTokens.token, storedHash(bearer.slice(OAUTH_ACCESS_TOKEN_PREFIX.length)))).get();
  if (!row || row.revoked || !row.userId || !row.expiresAt || row.expiresAt.getTime() <= now) return null;
  const client = db().select({ name: oauthClients.name, disabled: oauthClients.disabled }).from(oauthClients).where(eq(oauthClients.clientId, row.clientId)).get();
  if (!client || client.disabled) return null;
  const resources = parseList(row.resources);
  if (resources.length && !resources.includes(mcpResource())) return null;
  const scopes = parseList(row.scopes).filter((s): s is AgentScope => (ALL_SCOPES as readonly string[]).includes(s));
  return { tokenId: row.id, userId: row.userId, agentName: client.name?.trim() || row.clientId, scopes, via: "mcp-oauth", createdAt: row.createdAt ?? new Date(0) };
}
