// Manifest validation (architecture v2 section 3, spec 3.1). Pure, no I/O.
import { z } from "zod";
import type { CustomCommand, CustomEndpoint, PackageManifest } from "@/core/contracts";
import { isCredentialHeader } from "./header-rules";
import { placeholderNames } from "./params";

export const SHAPES = ["stat", "series", "table", "status"] as const;
export const CUSTOM_MIN_REFRESH_SEC = 10;
/** A8.4 value formats. */
export const VALUE_FORMATS = ["percent", "bytes", "bytesPerSec", "seconds", "celsius", "number"] as const;

/** A9.3: the {{ params.x }} names used in a path and query values. */
export function pathPlaceholders(e: { path: string; query?: Record<string, string> | undefined }): string[] {
  return placeholderNames([e.path, ...Object.values(e.query ?? {})]);
}

function paramsDeclared(e: { path: string; query?: Record<string, string> | undefined; params?: Record<string, unknown> | undefined }): boolean {
  const used = pathPlaceholders(e);
  if (!used.length) return true;
  const props = ((e.params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>;
  return used.every((n) => Object.prototype.hasOwnProperty.call(props, n));
}
export const ATRIUM_FLOOR_SEC = 5;
/** A10.4 measures and A10.5 service kinds. */
export const MEASURES = ["cpu", "memory", "disk", "network", "temperature", "uptime", "count", "status", "other"] as const;
export const SERVICE_KINDS = ["media", "monitoring", "network", "smart-home", "storage", "containers", "other"] as const;
/** A10.6: the one built-in package whose id is not a plain slug. */
export const SYSTEM_PACKAGE_ID = "atrium/system";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const OFFICIAL_ID = /^[a-z][a-z0-9-]{1,40}$/;
const COMMUNITY_ID = /^github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const DECLARATIVE_ID = /^(local\/[a-z0-9][a-z0-9-]{0,60}|github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})$/;

/**
 * Gauntlet r3 security M1: why a request path would leave the integration's own address, or null
 * when it stays there. A backslash reads as "/" to URL parsing (`/\\host:port/x` became another
 * port) and tabs, line breaks and other control characters are dropped by it, so both are refused
 * outright; a path that still resolves to another origin (`/http://other/`) is refused too. Pure, so
 * the save-time schemas and the send-time check in host.fetch share it.
 */
export function endpointPathProblem(path: string): string | null {
  if (path.includes("\\")) return "The path cannot contain a backslash (\\). Use / between parts of the path.";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return "The path cannot contain a control character such as a tab or a line break.";
  const probe = new URL("http://atrium.invalid/base/");
  let resolved: URL;
  try {
    resolved = path === "" ? probe : new URL(path.replace(/^\//, ""), probe);
  } catch {
    return "The path is not valid.";
  }
  if (resolved.origin !== probe.origin) return "The path must stay on the integration's address. Put the full address in the base URL, not in the path.";
  return null;
}

/** A saved path: starts with "/" and passes endpointPathProblem. */
const savedPath = (max?: number) => {
  const base = z.string().min(1).startsWith("/", "path must start with /");
  return (max ? base.max(max) : base).superRefine((p, ctx) => {
    const why = endpointPathProblem(p);
    if (why) ctx.addIssue({ code: "custom", message: why });
  });
};

const nonEmpty = (what: string) => z.string({ error: `${what} is missing` }).trim().min(1, `${what} is missing`);

const authPlacement = z.discriminatedUnion("as", [
  z.object({ as: z.literal("bearer") }),
  z.object({ as: z.literal("header"), name: nonEmpty("header name") }),
  z.object({ as: z.literal("query"), name: nonEmpty("query name") }),
  z.object({ as: z.literal("basic"), userKey: nonEmpty("basic userKey") }),
  z.object({ as: z.literal("proxmox-token") }),
], { error: "secret auth placement must be bearer, header, query, basic or proxmox-token" });

const endpointDef = z.object({
  id: nonEmpty("endpoint id"),
  label: nonEmpty("endpoint label"),
  description: nonEmpty("endpoint description"),
  params: z.record(z.string(), z.unknown()).optional(),
  shape: z.enum(SHAPES, { error: "endpoint shape must be stat, series, table or status" }),
  defaultRefreshSec: z.number({ error: "endpoint defaultRefreshSec must be a number" }).positive(),
  minRefreshSec: z.number({ error: "endpoint minRefreshSec must be a number" }).positive(),
  // Amendment 8 (A8.1): a heading in words, the Advanced tier and what the service must have.
  group: z.string().trim().min(1).max(60).optional(),
  advanced: z.boolean().optional(),
  needs: z.string().trim().min(1).max(200).optional(),
  // Amendment 10 (A10.3, A10.4): the series read for this value over time, what it measures, and
  // whether it is one of the service's main reads.
  history: z.object({ endpointId: z.string().min(1).max(200), params: z.record(z.string(), z.unknown()).optional() }).optional(),
  measure: z.enum(MEASURES).optional(),
  headline: z.boolean().optional(),
});

/** A10.5: a service's headline stat. `value` is a template body over that read's source. */
export const headlineStatSchema = z.object({
  label: z.string().trim().min(1).max(60),
  endpointId: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).optional(),
  value: z.string().trim().min(1).max(300),
  format: z.enum(VALUE_FORMATS).optional(),
});

const COMMAND_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** A JSON Schema for params: an object schema with typed properties. */
const paramsSchema = z.record(z.string(), z.unknown()).refine((s) => s.type === "object", "command params must be an object schema").refine((s) => JSON.stringify(s).length <= 16_384, "command params schema is larger than 16 KB");

// Section 3.1: a command is a small, named change. High-risk changes are never commands.
const commandDef = z.object({
  id: z.string({ error: "command id is missing" }).regex(COMMAND_ID, "command ids are lowercase words joined by dots, such as light.toggle"),
  label: nonEmpty("command label"),
  description: nonEmpty("command description"),
  params: paramsSchema,
  target: z.object({ endpointId: nonEmpty("command target endpoint"), field: nonEmpty("command target field") }).optional(),
  risk: z.enum(["low", "medium"], { error: 'command risk must be "low" or "medium"; higher-risk changes are actions, not commands' }),
  ownerOnly: z.boolean().optional(),
});

export const manifestSchema = z.object({
  atriumApi: z.literal("1", { error: 'atriumApi must be "1"' }),
  kind: z.enum(["code", "declarative"], { error: 'kind must be "code" or "declarative"' }),
  id: nonEmpty("id"),
  name: nonEmpty("name"),
  version: z.string({ error: "version is missing" }).regex(SEMVER, "version must be valid semver"),
  author: nonEmpty("author"),
  homepage: z.string().optional(),
  description: nonEmpty("description"),
  icon: nonEmpty("icon"),
  permissions: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("network"), hosts: z.union([z.literal("configured"), z.array(z.string().min(1))]) }),
    z.object({ kind: z.literal("secret"), key: nonEmpty("secret permission key") }),
    z.object({ kind: z.literal("command"), ids: z.array(nonEmpty("command permission id")) }),
  ], { error: "permission kind must be network, secret or command" })),
  config: z.record(z.string(), z.unknown()),
  secrets: z.array(z.object({ key: nonEmpty("secret key"), label: nonEmpty("secret label"), hint: nonEmpty("secret hint"), auth: authPlacement })),
  endpoints: z.array(endpointDef),
  // v3: package components register as pkg:<id>/<name> (the v2 "widgets" field is gone).
  components: z.array(z.object({ type: z.string().regex(/^pkg:[^/]+\/.+$/, "component types use pkg:<package>/<name>"), accepts: z.array(z.enum(SHAPES)), entry: z.string() })).optional(),
  commands: z.array(commandDef).optional(),
  detect: z.object({ serverHeader: z.string().optional(), probe: z.object({ path: z.string().startsWith("/"), match: z.string().min(1) }).optional() }).optional(),
  // A10.5: the kind of service (for start page groups) and up to 4 headline stats.
  service: z.object({ kind: z.enum(SERVICE_KINDS), headline: z.array(headlineStatSchema).max(4).optional() }).optional(),
});

export const customEndpointSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-_]{0,60}$/i, "endpoint id must be letters, numbers, - or _"),
  label: nonEmpty("label"),
  method: z.enum(["GET", "POST"]),
  path: savedPath(),
  query: z.record(z.string(), z.string()).optional(),
  auth: z.string().min(1).optional(),
  // Non-secret headers only (architecture v2 section 3 amendment).
  headers: z
    .record(z.string().min(1).max(200).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "header names use letters, numbers and dashes"), z.string().max(4096).refine((v) => !/[\r\n]/.test(v), "header values must be on one line"))
    .refine((h) => Object.keys(h).length <= 20, "at most 20 headers")
    .refine((h) => !Object.entries(h).some(([k, v]) => isCredentialHeader(k, v)), "a header that looks like a credential must be a secret field instead")
    .optional(),
  body: z.unknown().optional(),
  fields: z.array(z.object({ path: z.string().startsWith("$"), label: z.string(), role: z.enum(["value", "label", "time", "status", "column"]) })).min(1, "pick at least one field"),
  shape: z.enum(SHAPES),
  refreshSec: z.number().int().min(CUSTOM_MIN_REFRESH_SEC, `refresh must be at least ${CUSTOM_MIN_REFRESH_SEC} seconds`),
  // A9.3 (spec import v2): words, settings with {{ params.x }} placeholders in path and query, groups and formats.
  description: z.string().trim().min(1).max(500).optional(),
  params: z.record(z.string(), z.unknown()).refine((s) => s.type === "object", "params must be an object schema").refine((s) => JSON.stringify(s).length <= 16_384, "params schema is larger than 16 KB").optional(),
  group: z.string().trim().min(1).max(60).optional(),
  advanced: z.boolean().optional(),
  format: z.enum(VALUE_FORMATS).optional(),
  columnFormats: z.record(z.string(), z.enum(VALUE_FORMATS)).optional(),
}).refine((e) => e.body === undefined || e.method === "POST", { message: "only a POST endpoint can have a body", path: ["body"] })
  .refine((e) => paramsDeclared(e), { message: "every {{ params.x }} in the path or query must be a declared setting", path: ["params"] })
  .refine((e) => e.body === undefined || JSON.stringify(e.body).length <= 65_536, { message: "the body is larger than 64 KB", path: ["body"] });

const headersSchema = z
  .record(z.string().min(1).max(200).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "header names use letters, numbers and dashes"), z.string().max(4096).refine((v) => !/[\r\n]/.test(v), "header values must be on one line"))
  .refine((h) => Object.keys(h).length <= 20, "at most 20 headers")
  .refine((h) => !Object.entries(h).some(([k, v]) => isCredentialHeader(k, v)), "a header that looks like a credential must be a secret field instead");

/** Section 3.1: a command declared as a record (declarative commands.json and Custom API). */
export const customCommandSchema = z.object({
  id: z.string({ error: "command id is missing" }).regex(COMMAND_ID, "command ids are lowercase words joined by dots, such as lamp.toggle"),
  label: nonEmpty("label"),
  description: nonEmpty("description"),
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"], { error: "a command uses POST, PUT, PATCH or DELETE" }),
  path: savedPath(2048).refine((p) => !p.includes("{{"), "placeholders go in the body only"),
  query: z.record(z.string(), z.string().max(2048)).optional(),
  auth: z.string().min(1).optional(),
  headers: headersSchema.optional(),
  body: z.unknown().optional(),
  params: paramsSchema,
  risk: z.enum(["low", "medium"], { error: 'command risk must be "low" or "medium"; higher-risk changes are actions, not commands' }),
}).refine((c) => c.body === undefined || JSON.stringify(c.body).length <= 65_536, { message: "the body is larger than 64 KB", path: ["body"] })
  .refine((c) => placeholderNames(c.body).every((n) => Object.prototype.hasOwnProperty.call((c.params.properties ?? {}) as object, n)), { message: "every {{ params.<name> }} placeholder must name a declared parameter", path: ["body"] });

/** Checks commands against the manifest: declared ids, permission coverage and target endpoints. */
export function checkCommands(m: Pick<PackageManifest, "permissions" | "endpoints">, commands: { id: string; target?: { endpointId: string } }[], secretKeys?: Set<string>, auths?: (string | undefined)[]): string | null {
  const ids = new Set<string>();
  for (const c of commands) {
    if (ids.has(c.id)) return `command id "${c.id}" is declared twice`;
    ids.add(c.id);
  }
  const permitted = new Set(m.permissions.flatMap((p) => (p.kind === "command" ? p.ids : [])));
  for (const id of ids) if (!permitted.has(id)) return `command "${id}" is missing from the command permission`;
  for (const id of permitted) if (!ids.has(id)) return `the command permission names undeclared command "${id}"`;
  const endpoints = new Set(m.endpoints.map((e) => e.id));
  for (const c of commands) if (c.target && !endpoints.has(c.target.endpointId)) return `command "${c.id}" targets undeclared endpoint "${c.target.endpointId}"`;
  if (secretKeys && auths) for (const [i, a] of auths.entries()) if (a && !secretKeys.has(a)) return `command "${commands[i]!.id}" uses undeclared secret "${a}"`;
  return null;
}

export type ValidationResult = { ok: true; manifest: PackageManifest } | { ok: false; reason: string };

/** Validates a manifest. `hasAdapter` says whether the package ships adapter code. */
export function validateManifest(input: unknown, opts: { hasAdapter: boolean; source: "official" | "declarative" | "community"; declarativeEndpoints?: unknown; declarativeCommands?: unknown }): ValidationResult {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? ` (at ${issue.path.join(".")})` : "";
    return { ok: false, reason: `${issue.message}${where}` };
  }
  const m = parsed.data as PackageManifest;
  if (m.kind === "declarative" && opts.hasAdapter) return { ok: false, reason: "a declarative package must not ship adapter code" };
  if (m.kind === "code" && !opts.hasAdapter) return { ok: false, reason: "a code package must ship adapter code" };
  if (opts.source === "official" && !OFFICIAL_ID.test(m.id) && m.id !== SYSTEM_PACKAGE_ID) return { ok: false, reason: "official package ids are short lowercase slugs" };
  if (opts.source === "community" && !COMMUNITY_ID.test(m.id)) return { ok: false, reason: "community package ids use the github.com/<owner>/<repo> form" };
  if (opts.source === "declarative" && !DECLARATIVE_ID.test(m.id)) return { ok: false, reason: "declarative package ids use local/<name> or github.com/<owner>/<repo>" };
  const seen = new Set<string>();
  for (const e of m.endpoints) {
    if (seen.has(e.id)) return { ok: false, reason: `endpoint id "${e.id}" is used twice` };
    seen.add(e.id);
    if (e.defaultRefreshSec < e.minRefreshSec) return { ok: false, reason: `endpoint "${e.id}" has a default refresh below its minimum` };
    if (m.kind === "declarative" && e.minRefreshSec < CUSTOM_MIN_REFRESH_SEC) return { ok: false, reason: `endpoint "${e.id}" has a minimum refresh below ${CUSTOM_MIN_REFRESH_SEC} seconds` };
  }
  for (const e of m.endpoints) if (e.history && !seen.has(e.history.endpointId)) return { ok: false, reason: `endpoint "${e.id}" names an undeclared history read "${e.history.endpointId}"` };
  for (const h of m.service?.headline ?? []) if (!seen.has(h.endpointId)) return { ok: false, reason: `headline stat "${h.label}" names undeclared endpoint "${h.endpointId}"` };
  const secretKeys = new Set<string>();
  for (const s of m.secrets) {
    if (secretKeys.has(s.key)) return { ok: false, reason: `secret key "${s.key}" is declared twice` };
    secretKeys.add(s.key);
  }
  for (const p of m.permissions) {
    if (p.kind === "secret" && !secretKeys.has(p.key)) return { ok: false, reason: `secret permission names undeclared key "${p.key}"` };
  }
  if (m.kind === "code") {
    if (m.commands?.length && !opts.hasAdapter) return { ok: false, reason: "commands need adapter code" };
    const why = checkCommands(m, m.commands ?? []);
    if (why) return { ok: false, reason: why };
  }
  if (m.kind === "declarative") {
    if (m.commands?.length) return { ok: false, reason: "a declarative package declares its commands in commands.json, not the manifest" };
    const cmds = z.array(customCommandSchema).safeParse(opts.declarativeCommands ?? []);
    if (!cmds.success) {
      const issue = cmds.error.issues[0]!;
      return { ok: false, reason: `commands.json: ${issue.message} (at ${issue.path.join(".")})` };
    }
    const why = checkCommands(m, cmds.data, secretKeys, cmds.data.map((c) => c.auth));
    if (why) return { ok: false, reason: why };
    const eps = z.array(customEndpointSchema).safeParse(opts.declarativeEndpoints ?? []);
    if (!eps.success) {
      const issue = eps.error.issues[0]!;
      return { ok: false, reason: `endpoints.json: ${issue.message} (at ${issue.path.join(".")})` };
    }
    const ids = new Set(eps.data.map((e) => e.id));
    for (const e of m.endpoints) if (!ids.has(e.id)) return { ok: false, reason: `endpoint "${e.id}" has no record in endpoints.json` };
    for (const e of eps.data) {
      if (e.auth && !secretKeys.has(e.auth)) return { ok: false, reason: `endpoint "${e.id}" uses undeclared secret "${e.auth}"` };
    }
  }
  return { ok: true, manifest: m };
}

/** Builds manifest EndpointDefs for a declarative package from its CustomEndpoint records. */
export function endpointDefsFor(endpoints: CustomEndpoint[]): PackageManifest["endpoints"] {
  return endpoints.map((e) => ({
    id: e.id,
    label: e.label,
    description: e.description ?? `${e.method} ${e.path}`,
    shape: e.shape,
    defaultRefreshSec: Math.max(e.refreshSec, CUSTOM_MIN_REFRESH_SEC),
    minRefreshSec: CUSTOM_MIN_REFRESH_SEC,
    ...(e.params ? { params: e.params } : {}),
    ...(e.group ? { group: e.group } : {}),
    ...(e.advanced ? { advanced: true } : {}),
  }));
}

export type { CustomCommand };
