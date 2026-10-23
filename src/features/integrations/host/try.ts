// Runs one Try it request (spec 3.5): address rules of detection, the 10 s timeout, secrets
// attached here and scrubbed out of the answer. Nothing is cached.
// Gauntlet r1 security fixes: a request that carries a credential follows redirects only within
// its own origin, every secret is pinned to the origin it belongs to, every wire form of a secret
// (Basic `user:secret` included) is scrubbed, and to a private address only a plain GET goes out.
import "server-only";
import type { AuthPlacement } from "@/core/contracts";
import { attachSecret, checkUserHeaders, scrubSecrets } from "./outbound";
import { hostError } from "./errors";
import { safeRequest } from "./request";
import { splitSecret, vaultResolver } from "./secrets";

export type TryRequest = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  verifyTls: boolean;
  config: Record<string, unknown>;
  /** Secret fields to attach, with where their values come from. */
  secrets: { key: string; auth: AuthPlacement }[];
  source:
    | { kind: "pending"; id: string; userId: string }
    | { kind: "integration"; integrationId: string; pinOrigin: string }
    | { kind: "none" };
};

export type TryResponse = { status: number; contentType: string; body: Buffer; finalUrl: string; headers: Record<string, string> };

export const CREDENTIAL_REDIRECT_MESSAGE = "The service redirected to a different host, and Atrium does not send credentials there";

export async function runTryRequest(r: TryRequest): Promise<TryResponse> {
  const url = new URL(r.url);
  const checked = checkUserHeaders(r.headers);
  if (!checked.ok) throw hostError("config", checked.message, checked.hint);
  const headers = checked.headers;
  if (r.method === "POST" && r.body !== undefined && !headers["content-type"]) headers["content-type"] = /^\s*[[{]/.test(r.body) ? "application/json" : "application/x-www-form-urlencoded";
  const forms: string[] = [];
  const trusted: string[] = [];
  const resolve =
    r.source.kind === "integration"
      ? vaultResolver({ integrationId: r.source.integrationId, pinOrigin: r.source.pinOrigin })
      : r.source.kind === "pending"
        ? vaultResolver({ pending: { id: r.source.id, userId: r.source.userId } })
        : undefined;
  for (const s of r.secrets) {
    const { value: v, user } = splitSecret(resolve ? await resolve(s.key, url.origin) : null);
    if (!v) continue;
    const a = attachSecret(s.auth, v, headers, url, user !== undefined && s.auth.as === "basic" ? { ...r.config, [s.auth.userKey]: user } : r.config);
    forms.push(...a.forms);
    if (a.header) trusted.push(a.header);
  }
  const res = await safeRequest({
    url: url.toString(),
    method: r.method,
    headers,
    ...(r.method === "POST" && r.body !== undefined ? { body: r.body } : {}),
    verifyTls: r.verifyTls,
    // With a credential attached, redirects stay on this origin; without one, any checked host.
    redirect: forms.length ? { mode: "same-host", message: `${CREDENTIAL_REDIRECT_MESSAGE}.` } : { mode: "checked" },
    userShaped: { trustedHeaders: trusted },
    maxBytes: 2 * 1024 * 1024,
  });
  const finalUrl = new URL(res.url);
  for (const s of r.secrets) if (s.auth.as === "query") finalUrl.searchParams.delete(s.auth.name);
  return { status: res.status, contentType: res.headers["content-type"] ?? "", body: scrubSecrets(res.body, forms), finalUrl: finalUrl.toString(), headers: res.headers };
}
