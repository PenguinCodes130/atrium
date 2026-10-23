import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { env } from "@/core/env";
import { PAT_PATTERN, PAT_PREFIX } from "./policy";
import { wwwAuthenticate } from "./security";

// Personal access tokens (architecture section 9b): `atr_pat_<32 random bytes base64url>`.
// The value is shown once; only its SHA-256 hash is stored (by agent-api, in agent_token).

export function createPersonalAccessToken(): { token: string; hash: string } {
  const token = `${PAT_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashPersonalAccessToken(token) };
}

export function hashPersonalAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function looksLikePat(token: string): boolean {
  return PAT_PATTERN.test(token);
}

/** The 401 an MCP call gets without a valid token, pointing at the protected resource metadata. */
export function mcpUnauthorized(message = "A valid access token is required."): Response {
  return Response.json(
    { error: { code: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate(new URL(env().ATRIUM_PUBLIC_URL).origin) } },
  );
}
