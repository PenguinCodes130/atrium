// Route helpers: every handler signs the caller in through auth, parses input with Zod and sends
// output through a Zod schema that strips unknown fields (architecture v2 section 11, proof 2).
import "server-only";
import { z, type ZodType } from "zod";
import type { Role } from "@/core/contracts";
import { AtriumError, errorResponse } from "@/core/errors";
import { FieldError } from "./field-error";
import { requireStepUp, requireUser, STEP_UP_WINDOW_MS, type AtriumSession } from "@/features/auth";
import { CredentialInUse, OriginConfirmNeeded, OriginStepUpNeeded, RemoveStepUpNeeded, type LockOptions } from "./credentials/service";

export async function handle(req: Request, minRole: Role | undefined, fn: (s: AtriumSession) => Promise<Response> | Response): Promise<Response> {
  try {
    const s = await requireUser(req, minRole);
    return await fn(s);
  } catch (err) {
    if (err instanceof z.ZodError) return Response.json({ error: { code: "bad_request", message: err.issues[0]?.message ?? "That request is not valid." } }, { status: 400 });
    if (err instanceof FieldError) return Response.json({ error: { code: err.code, message: err.message, field: err.field } }, { status: err.status });
    return errorResponse(err);
  }
}

/** Whether this session completed a step-up in the last 10 minutes (architecture section 5). */
export function stepUpFresh(s: AtriumSession, now = Date.now()): boolean {
  const at = s.session.stepUpAt;
  return !!at && now - at.getTime() <= STEP_UP_WINDOW_MS && at.getTime() <= now + 1000;
}

/**
 * Like handle(), for saves that may lock a saved credential to a server (Amendment 2). A new server
 * answers 409 credential_origin_confirm with the credentials and server to confirm; a confirmed one
 * without a fresh step-up answers auth's 403 step_up_required, so the step-up prompt can retry it.
 */
export async function handleLocks(req: Request, minRole: Role | undefined, fn: (s: AtriumSession, lock: LockOptions) => Promise<Response> | Response): Promise<Response> {
  return handle(req, minRole, async (s) => {
    try {
      return await fn(s, { stepUpFresh: stepUpFresh(s) });
    } catch (err) {
      if (err instanceof OriginConfirmNeeded) {
        return Response.json(
          { error: { code: err.code, message: err.message }, confirm: { origin: err.needs[0]!.origin, credentials: err.needs.map((n) => ({ id: n.credentialId, name: n.name, lockedOrigins: n.lockedOrigins })) } },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      }
      if (err instanceof OriginStepUpNeeded || err instanceof RemoveStepUpNeeded) {
        await requireStepUp(req); // throws auth's StepUpRequired with the right method
      }
      if (err instanceof CredentialInUse) {
        return Response.json({ error: { code: err.code, message: err.message }, usedBy: err.users }, { status: 409, headers: { "cache-control": "no-store" } });
      }
      throw err;
    }
  });
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AtriumError("The request body must be JSON.");
  }
  return schema.parse(raw);
}

export function send<T>(schema: ZodType<T>, data: unknown, init?: ResponseInit): Response {
  return Response.json(schema.parse(data), { ...init, headers: { "cache-control": "no-store", ...(init?.headers ?? {}) } });
}

// ---- Output schemas (no secret value can pass through these) ----
const health = z.object({ status: z.enum(["ok", "degraded", "down"]), latencyMs: z.number(), message: z.string().optional(), version: z.string().optional() });
const adapterError = z.object({ code: z.string(), message: z.string(), hint: z.string().optional(), retryAfterSec: z.number().optional() });
const authPlacement = z.object({ as: z.string(), name: z.string().optional(), userKey: z.string().optional() });
const secretField = z.object({ key: z.string(), label: z.string(), hint: z.string(), auth: authPlacement });

export const integrationOut = z.object({
  id: z.string(),
  packageId: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  secrets: z.array(z.object({ key: z.string(), set: z.boolean(), updatedAt: z.string().optional(), credentialId: z.string().optional() })),
  status: z.enum(["draft", "active", "disabled"]),
  shared: z.boolean(),
  lastHealth: health.extend({ checkedAt: z.string() }).optional(),
  createdBy: z.string(),
  createdById: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  packageName: z.string(),
  packageMissing: z.boolean(),
  locked: z.boolean(),
  untested: z.boolean(),
  // A10.5: service information (not config, not secret)
  kind: z.string().optional(),
  openUrl: z.string().optional(),
  headline: z.array(z.object({ label: z.string(), endpointId: z.string(), params: z.record(z.string(), z.unknown()).optional(), value: z.string(), format: z.string().optional() })).optional(),
  system: z.boolean().optional(),
  serviceSaved: z.boolean().optional(),
  secretFields: z.array(secretField.extend({
    set: z.boolean(), updatedAt: z.string().optional(), required: z.boolean(), viaCredential: z.boolean(),
    credential: z.object({ id: z.string(), name: z.string(), kind: z.string(), lockedOrigins: z.array(z.string()) }).optional(),
  })),
});

// ---- Amendment 2: saved credentials (names, kinds, servers and usage; never a value) ----
export const credentialOut = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["token", "username-password", "proxmox-token"]),
  fields: z.array(z.object({ key: z.string(), set: z.boolean(), updatedAt: z.string().optional() })),
  lockedOrigins: z.array(z.string()), createdBy: z.string(), createdAt: z.string(), updatedAt: z.string(), lastUsedAt: z.string().optional(),
  usedBy: z.array(z.object({ integrationId: z.string(), name: z.string() })),
  usedAt: z.array(z.object({ integrationId: z.string(), origin: z.string().nullable() })),
  locked: z.boolean(),
});
export const credentialListOut = z.object({ credentials: z.array(credentialOut) });
export const integrationListOut = z.object({ integrations: z.array(integrationOut) });

const packageCard = z.object({
  id: z.string(), name: z.string(), description: z.string(), icon: z.string(), source: z.string(), status: z.string().optional(),
  config: z.record(z.string(), z.unknown()), secrets: z.array(secretField), endpoints: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), shape: z.string(), defaultRefreshSec: z.number(), minRefreshSec: z.number(), params: z.record(z.string(), z.unknown()).optional(), group: z.string().optional(), advanced: z.boolean().optional(), needs: z.string().optional() })),
  commands: z.array(z.object({ id: z.string(), label: z.string(), risk: z.enum(["low", "medium"]), ownerOnly: z.boolean(), method: z.string().optional(), path: z.string().optional() })),
  pendingCommands: z.array(z.object({ id: z.string(), label: z.string(), risk: z.enum(["low", "medium"]), ownerOnly: z.boolean(), method: z.string().optional(), path: z.string().optional() })),
  service: z.object({ kind: z.string(), headline: z.array(z.object({ label: z.string(), endpointId: z.string(), params: z.record(z.string(), z.unknown()).optional(), value: z.string(), format: z.string().optional() })).optional() }).optional(),
});
export const packageCardOut = packageCard;
export const galleryOut = z.object({
  packages: z.array(packageCard),
  declarative: z.array(packageCard),
  problems: z.array(z.object({ packageId: z.string(), source: z.string(), reason: z.string(), at: z.string() })),
});

const endpointSummary = z.object({ method: z.enum(["GET", "POST"]), path: z.string(), summary: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), suggestedShape: z.string().optional() });
export const detectOut = z.object({ url: z.string(), matches: z.array(z.string()), openapi: z.array(endpointSummary).optional(), openapiUrl: z.string().optional(), error: adapterError.optional() });

export const testOut = z.union([
  z.object({ ok: z.literal(true), health, passId: z.string().optional() }),
  z.object({ ok: z.literal(false), heading: z.string(), error: adapterError, latencyMs: z.number() }),
]);

const treeNode: ZodType = z.lazy(() =>
  z.object({ type: z.string(), path: z.string(), key: z.union([z.string(), z.number()]).optional(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), truncated: z.boolean().optional(), length: z.number().optional(), children: z.array(treeNode).optional() }),
);
const tryRequestEcho = z.object({ method: z.enum(["GET", "POST"]), url: z.string(), headers: z.record(z.string(), z.string()), body: z.string().optional(), verifyTls: z.boolean(), droppedHeaders: z.array(z.string()).optional() });
const rateLimit = z.object({ limit: z.number(), windowSec: z.number(), refreshSec: z.number() });
export const tryOut = z.union([
  z.object({ ok: z.literal(true), status: z.number(), contentType: z.string(), tree: treeNode, request: tryRequestEcho, secretFields: z.array(secretField), pendingId: z.string().optional(), redactedCurl: z.string().optional(), basicUser: z.string().optional(), rateLimit: rateLimit.optional() }),
  z.object({ ok: z.literal(false), heading: z.string(), error: adapterError, request: tryRequestEcho.optional(), secretFields: z.array(secretField).optional(), pendingId: z.string().optional(), redactedCurl: z.string().optional() }),
]);

export const endpointsOut = z.object({
  endpoints: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), shape: z.string(), defaultRefreshSec: z.number(), minRefreshSec: z.number(), params: z.record(z.string(), z.unknown()).optional(), group: z.string().optional(), advanced: z.boolean().optional(), needs: z.string().optional(), method: z.string().optional(), path: z.string().optional(), fields: z.array(z.object({ path: z.string(), label: z.string(), role: z.string() })).optional(), from: z.string().optional() })),
});

export const widgetDataOut = z.object({
  state: z.enum(["fresh", "stale", "failed", "empty"]),
  data: z.unknown().optional(),
  fetchedAt: z.string().optional(),
  sourceTimestamp: z.string().optional(),
  refreshSec: z.number(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
});

// ---- v3: commands, binding listings and sharing (no secret can pass through these either) ----
const commandView = z.object({
  id: z.string(), label: z.string(), description: z.string(), risk: z.enum(["low", "medium"]), ownerOnly: z.boolean(),
  target: z.object({ endpointId: z.string(), field: z.string() }).optional(), method: z.string().optional(), path: z.string().optional(),
});
export const commandsOut = z.object({
  commands: z.array(commandView),
  pending: z.array(commandView.extend({ change: z.enum(["added", "changed"]) })),
  canChange: z.boolean(),
  customCommands: z.boolean(),
});
const commandDefOut = z.object({
  id: z.string(), label: z.string(), description: z.string(), params: z.record(z.string(), z.unknown()), risk: z.enum(["low", "medium"]), ownerOnly: z.boolean().optional(),
  target: z.object({ endpointId: z.string(), field: z.string() }).optional(),
});
export const commandListingOut = z.object({
  commands: z.array(z.object({ integrationId: z.string(), integrationName: z.string(), command: commandDefOut, targets: z.array(z.object({ id: z.string(), label: z.string() })).optional() })),
});
export const bindableOut = z.object({
  integrations: z.array(z.object({
    integrationId: z.string(), integrationName: z.string(), packageId: z.string(),
    health: z.enum(["ok", "failing", "locked", "unknown"]), healthMessage: z.string().optional(),
    availabilityChecked: z.boolean(),
    endpoints: z.array(z.object({
      id: z.string(), label: z.string(), description: z.string(), params: z.record(z.string(), z.unknown()).optional(), shape: z.string(), defaultRefreshSec: z.number(), minRefreshSec: z.number(),
      group: z.string().optional(), advanced: z.boolean().optional(), needs: z.string().optional(), available: z.boolean(),
      choices: z.array(z.object({ param: z.string(), endpointId: z.string(), every: z.boolean(), dependsOn: z.array(z.string()).optional() })).optional(),
      check: z.object({ status: z.enum(["ok", "empty", "failed", "odd"]), reason: z.string().optional(), at: z.string() }).optional(),
      from: z.string().optional(),
    })),
  })),
});

// ---- Amendment 8 (A8.2): live choices for a parameter (value, label, detail; never config or secrets) ----
export const choicesOut = z.object({
  choices: z.array(z.object({ value: z.string(), label: z.string(), detail: z.string().optional() })),
  every: z.boolean(),
  total: z.number(),
  stale: z.boolean().optional(),
});
export const sharingOut = z.object({
  shared: z.boolean(), canChange: z.boolean(), appsKnown: z.boolean(),
  affectedApps: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
});

// ---- Amendment 10 (A10.4): the data catalogue and peek (reads, things and values; never config or secrets) ----
const propValue = z.unknown();
const headlineStatOut = z.object({ label: z.string(), endpointId: z.string(), params: z.record(z.string(), propValue).optional(), value: z.string(), format: z.string().optional() });
export const catalogueItemOut = z.object({
  key: z.string(), integrationId: z.string(), integrationName: z.string(), packageId: z.string(), serviceIcon: z.string(),
  endpointId: z.string(), label: z.string(),
  thing: z.object({ param: z.string(), value: z.string(), label: z.string(), detail: z.string().optional() }).optional(),
  params: z.record(z.string(), propValue), needsSettings: z.boolean().optional(),
  shape: z.enum(["stat", "series", "table", "status"]), format: z.string().optional(), group: z.string().optional(),
  measure: z.enum(["cpu", "memory", "disk", "network", "temperature", "uptime", "count", "status", "other"]), headline: z.boolean().optional(),
  history: z.object({ endpointId: z.string(), params: z.record(z.string(), propValue) }).optional(),
  check: z.object({ status: z.enum(["ok", "empty", "failed", "odd"]), reason: z.string().optional(), at: z.string() }).optional(),
  from: z.string().optional(), defaultRefreshSec: z.number(), minRefreshSec: z.number(),
});
export const catalogueServiceOut = z.object({
  integrationId: z.string(), name: z.string(), packageId: z.string(), icon: z.string(),
  kind: z.enum(["media", "monitoring", "network", "smart-home", "storage", "containers", "other"]), openUrl: z.string().optional(),
  headline: z.array(headlineStatOut), health: z.enum(["ok", "degraded", "down"]).optional(),
});
export const catalogueOut = z.object({ items: z.array(catalogueItemOut), fits: z.array(z.boolean()), services: z.array(catalogueServiceOut), pending: z.array(z.string()) });
export const peekIn = z.object({ items: z.array(z.object({ integrationId: z.string().min(1).max(100), endpointId: z.string().min(1).max(200), params: z.record(z.string(), z.unknown()).default({}) })).min(1).max(20) });
export const peekOut = z.object({ values: z.array(z.object({ key: z.string(), data: z.unknown().optional(), error: z.string().optional() })) });
