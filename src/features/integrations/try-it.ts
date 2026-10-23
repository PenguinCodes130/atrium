// "Try it" (spec 3.5): one request by example, returned as a clickable tree. Nothing is cached,
// and credentials from a pasted curl command are held on the server, never echoed back.
import "server-only";
import { z } from "zod";
import type { AdapterError, Principal } from "@/core/contracts";
import { Forbidden, NotFound } from "@/core/errors";
import { parseCurl, CurlParseError } from "./curl";
import { HostError } from "./host/errors";
import { holdSecrets, pendingFields, pendingOrigin, type PendingField } from "./host/pending";
import { runTryRequest } from "./host/try";
import { serviceSaid, statusError } from "./host/errors";
import { checkUserHeaders, FORBIDDEN_HEADERS } from "./host/outbound";
import { normalizeUrl } from "./detect";
import { buildTree, type TreeNode } from "./shape";
import { getIntegrationRow } from "./repo";
import { effectiveManifest, getPackage, pinFor } from "./runtime";
import { requireManage } from "./service";
import { canUseCredential } from "./credentials/service";
import * as credRepo from "./credentials/repo";

export const tryInput = z.object({
  url: z.string().max(4096).optional(),
  curl: z.string().max(32_768).optional(),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.record(z.string().max(200), z.string().max(4096)).optional(),
  body: z.string().max(65_536).optional(),
  verifyTls: z.boolean().optional(),
  /** Reuse credentials held from an earlier curl paste, or an existing custom integration's sealed ones. */
  auth: z.union([z.object({ pendingId: z.string().max(100) }), z.object({ integrationId: z.string().max(100) })]).optional(),
});
export type TryInput = z.infer<typeof tryInput>;

/** `droppedHeaders` names headers that Atrium never sends (connection headers), so they are not kept either. */
export type TryRequestEcho = { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: string; verifyTls: boolean; droppedHeaders?: string[] };
/** A refresh suggestion that fits the API's published rate limit. */
export type RateHint = { limit: number; windowSec: number; refreshSec: number };
export type TryOk = { ok: true; status: number; contentType: string; tree: TreeNode; request: TryRequestEcho; secretFields: Omit<PendingField, never>[]; pendingId?: string; redactedCurl?: string; basicUser?: string; rateLimit?: RateHint };
export type TryFail = { ok: false; error: AdapterError; request?: TryRequestEcho; secretFields?: PendingField[]; pendingId?: string; redactedCurl?: string };

/** A saved custom integration whose sealed secrets may be attached, only for requests to the origin they were saved for. */
export type IntegrationAuth = { integrationId: string; origin: string; fields: PendingField[]; config: Record<string, unknown> };

/** Round 8: a saved integration's secrets aimed at another address refuse, like held curl secrets do. */
export const TRY_OTHER_ORIGIN_MESSAGE = "This integration's saved credentials can only be sent to the address it was saved with.";
export const TRY_OTHER_ORIGIN_HINT = "Use an address on the integration's own host, or try this address from a new integration.";

export const TRY_FOREIGN_CREDENTIAL_MESSAGE = "This integration uses a saved credential you cannot use, so Try it cannot send it.";

/**
 * Gauntlet r2 security finding 1: Try it may reuse a saved custom integration's credentials only for
 * a caller who may manage that integration (owner or creator, the integration routes' check), and
 * each saved credential behind it only for a caller who may use that credential. Throws Forbidden or
 * NotFound otherwise; nothing is sent. Returns undefined for an integration whose secrets cannot be
 * reused here (not a custom API, or no pinned address).
 */
export function integrationAuthFor(p: Principal, integrationId: string): IntegrationAuth | undefined {
  const row = getIntegrationRow(integrationId);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  for (const ref of credRepo.refsOfIntegration(row.id)) {
    const c = credRepo.getCredentialRow(ref.credentialId);
    if (!c || !canUseCredential(p, c)) throw new Forbidden(TRY_FOREIGN_CREDENTIAL_MESSAGE);
  }
  const pkg = getPackage(row.packageId);
  const origin = pkg ? pinFor(effectiveManifest(pkg, row.secretFields), row.config) : undefined;
  if (row.packageId !== "custom-api" || !origin) return undefined;
  return { integrationId: row.id, origin, fields: row.secretFields as IntegrationAuth["fields"], config: row.config };
}

/** Reads X-RateLimit-Limit (and RateLimit-Policy when given) and suggests a refresh using at most half the budget. */
export function rateHint(headers: Record<string, string>): RateHint | undefined {
  const limit = Number(headers["x-ratelimit-limit"] ?? headers["ratelimit-limit"]);
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  // The window comes from a RateLimit-Policy "w=" value; otherwise assume the common hourly window.
  const policy = /w=(\d+)/.exec(headers["ratelimit-policy"] ?? headers["x-ratelimit-policy"] ?? "");
  const windowSec = policy ? Math.max(1, Number(policy[1])) : 3600;
  const refreshSec = Math.max(10, Math.ceil((windowSec / limit) * 2));
  return { limit, windowSec, refreshSec };
}

function echoOf(method: "GET" | "POST", url: string, rawHeaders: Record<string, string>, body: string | undefined, verifyTls: boolean): TryRequestEcho {
  const dropped = Object.keys(rawHeaders).filter((k) => FORBIDDEN_HEADERS.has(k.trim().toLowerCase()));
  const kept = Object.fromEntries(Object.entries(rawHeaders).filter(([k]) => !dropped.includes(k)));
  return { method, url, headers: kept, ...(body !== undefined ? { body } : {}), verifyTls, ...(dropped.length ? { droppedHeaders: dropped } : {}) };
}

export async function runTry(input: TryInput, userId: string, integrationAuth?: IntegrationAuth): Promise<TryOk | TryFail> {
  let req: TryRequestEcho;
  let secretFields: PendingField[] = [];
  let pendingId: string | undefined;
  let redactedCurl: string | undefined;
  let basicUser: string | undefined;
  try {
    if (input.curl && input.curl.trim()) {
      const c = parseCurl(input.curl);
      const u = new URL(c.url);
      for (const [k, v] of Object.entries(c.query)) u.searchParams.set(k, v);
      req = echoOf(c.method, u.toString(), c.headers, c.body, c.verifyTls);
      redactedCurl = c.redacted;
      basicUser = c.basicUser;
      if (c.secrets.length) {
        pendingId = holdSecrets(userId, new URL(c.url).origin, c.secrets);
        secretFields = c.secrets.map(({ key, label, hint, auth }) => ({ key, label, hint, auth }));
      }
    } else {
      const u = normalizeUrl(input.url ?? "");
      req = echoOf(input.method ?? "GET", u.toString(), input.headers ?? {}, input.body !== undefined && input.method === "POST" ? input.body : undefined, input.verifyTls ?? true);
      // A credential typed as a plain header would be echoed and saved in the clear: refuse it.
      const h = checkUserHeaders(req.headers);
      if (!h.ok) return { ok: false, error: { code: "config", message: h.message, hint: h.hint }, request: { ...req, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== h.name)) } };
      if (input.auth && "pendingId" in input.auth) {
        const fields = pendingFields(input.auth.pendingId, userId);
        if (fields) { pendingId = input.auth.pendingId; secretFields = fields; }
      }
    }
  } catch (err) {
    if (err instanceof CurlParseError) return { ok: false, error: { code: "config", message: err.message, hint: "Paste the whole command, starting with curl." } };
    if (err instanceof HostError) return { ok: false, error: err.adapterError };
    throw err;
  }
  const sameOrigin = (o: string | undefined) => !!o && new URL(req.url).origin === o;
  // Round 8 (Wave 1 carry-over): this used to drop the saved secrets and send the request bare, while
  // held curl secrets refused. Both now refuse, and nothing is sent. An integration with no secret
  // fields has nothing to protect, so its request still goes out without credentials.
  if (integrationAuth && !sameOrigin(integrationAuth.origin)) {
    if (integrationAuth.fields.length > 0) {
      return { ok: false, error: { code: "permission", message: TRY_OTHER_ORIGIN_MESSAGE, hint: TRY_OTHER_ORIGIN_HINT }, request: req };
    }
    integrationAuth = undefined;
  }
  if (pendingId && !sameOrigin(pendingOrigin(pendingId, userId))) {
    return { ok: false, error: { code: "permission", message: "Credentials from the pasted command can only be sent to the address they came with.", hint: "Paste a new curl command for the other address." }, request: req, secretFields, pendingId };
  }
  try {
    const res = await runTryRequest({
      ...req,
      config: integrationAuth ? integrationAuth.config : basicUser !== undefined ? { username: basicUser } : {},
      secrets: (integrationAuth ? integrationAuth.fields : secretFields).map((s) => ({ key: s.key, auth: s.auth })),
      source: integrationAuth ? { kind: "integration", integrationId: integrationAuth.integrationId, pinOrigin: integrationAuth.origin } : pendingId ? { kind: "pending", id: pendingId, userId } : { kind: "none" },
    });
    const echo = req;
    const label = secretFields[0]?.label;
    const text = res.body.toString("utf8");
    const err = statusError(res.status, { ...(label ? { secretLabel: label } : {}), said: res.status >= 400 ? serviceSaid(text, res.contentType) : undefined });
    const base = { request: echo, secretFields, ...(pendingId ? { pendingId } : {}), ...(redactedCurl ? { redactedCurl } : {}) };
    if (err) return { ok: false, error: err, ...base };
    let json: unknown;
    try { json = JSON.parse(text); } catch {
      return { ok: false, error: { code: "bad_response", message: "The service answered, but not with JSON.", hint: "Point Try it at an API endpoint that returns JSON." }, ...base };
    }
    const rate = rateHint(res.headers);
    return { ok: true, status: res.status, contentType: res.contentType, tree: buildTree(json), ...base, ...(basicUser !== undefined ? { basicUser } : {}), ...(rate ? { rateLimit: rate } : {}) };
  } catch (err) {
    if (err instanceof HostError) return { ok: false, error: err.adapterError, request: req, secretFields, ...(pendingId ? { pendingId } : {}), ...(redactedCurl ? { redactedCurl } : {}) };
    throw err;
  }
}
