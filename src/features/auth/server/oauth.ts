import "server-only";
import { oauthProvider, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { db } from "@/core/db";
import { devSecret } from "@/core/env";
import { oauthClients } from "@/db/schema/auth";
import { mcpResource, OAUTH_ACCESS_TOKEN_PREFIX, OAUTH_ACCESS_TOKEN_SECONDS, OAUTH_REFRESH_TOKEN_PREFIX, OAUTH_SCOPES } from "./oauth-tokens";

// MCP OAuth, the auth half (architecture section 9b; auth gauntlet r1, fix 6): Better Auth's OAuth 2.1
// provider with authorization code + PKCE, dynamic client registration, Atrium's consent screen with
// the client name and every requested scope, step-up before granting atrium:propose, and the allowlist
// on every authorization. The MCP endpoint itself (agent-api) validates tokens with getPrincipal().

export function oauthPlugin() {
  const resource = mcpResource();
  return oauthProvider({
    loginPage: "/sign-in",
    consentPage: "/consent",
    scopes: [...OAUTH_SCOPES],
    // Agents always act as a real user, so no client_credentials grant.
    grantTypes: ["authorization_code", "refresh_token"],
    // MCP clients register themselves before anyone signs in (RFC 7591). They get no access until a
    // signed-in, allowlisted user consents; registration is capped per address (handler.ts).
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultApplicationType: "infer",
    clientRegistrationRequirePKCE: true,
    // Opaque access tokens, stored hashed, looked up by resolveOAuthToken(). No JWT signing keys.
    disableJwtPlugin: true,
    storeTokens: "hashed",
    accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_SECONDS,
    prefix: { opaqueAccessToken: OAUTH_ACCESS_TOKEN_PREFIX, refreshToken: OAUTH_REFRESH_TOKEN_PREFIX },
    resources: [{ identifier: resource, name: "Atrium MCP", allowedScopes: [...OAUTH_SCOPES] }],
    resourceSeedMode: "overwrite",
    clientRegistrationDefaultResources: [resource],
    // Managing OAuth clients by hand is for the owner only.
    clientPrivileges: ({ user }) => (user as { role?: string } | undefined)?.role === "owner",
    resourcePrivileges: ({ user }) => (user as { role?: string } | undefined)?.role === "owner",
  });
}

export { scopesIn };

function scopesIn(query: string | null | undefined): string[] {
  if (!query) return [];
  return (new URLSearchParams(query).get("scope") ?? "").split(" ").filter(Boolean);
}

// ---- Consent screen data ------------------------------------------------------------------------

export type ConsentDetails = { clientId: string; clientName: string; clientUri: string | null; scopes: string[]; oauthQuery: string };

/** The authorization request behind /consent, or null when the signed query is missing, forged or expired. */
export async function consentDetails(search: URLSearchParams): Promise<ConsentDetails | null> {
  const oauthQuery = search.toString();
  if (!search.get("sig") || !search.get("client_id")) return null;
  if (!(await verifyOAuthQueryParams(oauthQuery, devSecret("BETTER_AUTH_SECRET")))) return null;
  const clientId = search.get("client_id")!;
  const c = db().select({ name: oauthClients.name, uri: oauthClients.uri, disabled: oauthClients.disabled }).from(oauthClients).where(eq(oauthClients.clientId, clientId)).get();
  if (!c || c.disabled) return null;
  return { clientId, clientName: c.name?.trim() || "An unnamed agent", clientUri: c.uri ?? null, scopes: scopesIn(oauthQuery), oauthQuery };
}

