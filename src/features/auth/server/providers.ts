import "server-only";
import type { GenericOAuthConfig } from "better-auth/plugins";

// Sign-in providers come from the server environment. These variables are not in the shared env
// schema yet (shared file request in the auth build report), so they are read here directly.
//   Google:       ATRIUM_GOOGLE_CLIENT_ID, ATRIUM_GOOGLE_CLIENT_SECRET
//   Generic OIDC: ATRIUM_OIDC_CLIENT_ID, ATRIUM_OIDC_CLIENT_SECRET, ATRIUM_OIDC_NAME (shown on the button),
//                 and either ATRIUM_OIDC_DISCOVERY_URL or the three ATRIUM_OIDC_{AUTHORIZATION,TOKEN,USERINFO}_URL.

export const OIDC_PROVIDER_ID = "oidc";

export type ProviderInfo = { id: "google" | typeof OIDC_PROVIDER_ID; name: string };

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function providerConfig(): {
  google?: { clientId: string; clientSecret: string };
  oidc?: GenericOAuthConfig;
} {
  const out: ReturnType<typeof providerConfig> = {};
  const gId = read("ATRIUM_GOOGLE_CLIENT_ID");
  const gSecret = read("ATRIUM_GOOGLE_CLIENT_SECRET");
  if (gId && gSecret) out.google = { clientId: gId, clientSecret: gSecret };

  const oId = read("ATRIUM_OIDC_CLIENT_ID");
  const discoveryUrl = read("ATRIUM_OIDC_DISCOVERY_URL");
  const authorizationUrl = read("ATRIUM_OIDC_AUTHORIZATION_URL");
  const tokenUrl = read("ATRIUM_OIDC_TOKEN_URL");
  const userInfoUrl = read("ATRIUM_OIDC_USERINFO_URL");
  if (oId && (discoveryUrl || (authorizationUrl && tokenUrl && userInfoUrl))) {
    out.oidc = {
      providerId: OIDC_PROVIDER_ID,
      name: read("ATRIUM_OIDC_NAME") ?? "Single sign-on",
      clientId: oId,
      clientSecret: read("ATRIUM_OIDC_CLIENT_SECRET"),
      scopes: ["openid", "email", "profile"],
      pkce: true,
      // OIDC providers identify a user by `sub`, also when the endpoints are configured without discovery.
      accountSubject: ({ profile }) => {
        const sub = profile.sub;
        if (typeof sub !== "string" && typeof sub !== "number") throw new Error("The provider returned no subject.");
        return sub;
      },
      ...(discoveryUrl ? { discoveryUrl } : { authorizationUrl, tokenUrl, userInfoUrl }),
    };
  }
  return out;
}

/** The provider buttons the sign-in screen shows. Names only; never the client ids or secrets. */
export function configuredProviders(): ProviderInfo[] {
  const c = providerConfig();
  const list: ProviderInfo[] = [];
  if (c.google) list.push({ id: "google", name: "Google" });
  if (c.oidc) list.push({ id: OIDC_PROVIDER_ID, name: c.oidc.name ?? "Single sign-on" });
  return list;
}
