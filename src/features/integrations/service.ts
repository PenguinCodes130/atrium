// Integration operations shared by the API routes, the pages and the agent tools. Every function
// takes the caller's Principal and checks it; secret values only flow inward, never out.
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { AdapterError, CustomEndpoint, HealthResult, Integration, PackageManifest, PackageProblem, Principal } from "@/core/contracts";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { removeSecrets, seal, secretStatus, vaultStatus } from "@/features/vault";
import { forgetIntegration } from "@/features/data/runtime";
import { canonicalJson } from "@/features/data/keys";
import { ERROR_HEADINGS, SECRETS_LOCKED_MESSAGE } from "./host/errors";
import { FieldError } from "./field-error";
import { pendingFields, pendingOrigin, sealPending, type PendingField } from "./host/pending";
import { PIN_KEY, recordPin } from "./host/secrets";
import { customCommandSchema, customEndpointSchema, endpointDefsFor, headlineStatSchema, validateManifest, CUSTOM_MIN_REFRESH_SEC, SERVICE_KINDS, SYSTEM_PACKAGE_ID } from "./manifest";
import { cleanOpenUrl, baseAddressOf, saveServiceRow, serviceInfoOf, serviceTableReady, SERVICE_TABLE_MISSING } from "./service-info";
import { audit } from "@/features/audit/write";
import { appAccess } from "@/core/hooks";
import { galleryOrder, type LoadedPackage } from "./registry";
import * as repo from "./repo";
import * as credRepo from "./credentials/repo";
import { applyLocks, checkPick, credentialComplete, credentialLabel, guardLocks, locksNeeded, type LockOptions } from "./credentials/service";
import { effectiveManifest, endpointsOf, getPackage, getRegistry, pinFor, reloadRegistry, requiredSecretKeys, runHealth, validateConfig } from "./runtime";
import { checkReads } from "@/features/recipes/check";
import { builtinFrom, fromTag } from "@/features/recipes/store";

export const CREDENTIAL_LINK_TTL_MS = 24 * 60 * 60_000;
const PASS_TTL_MS = 15 * 60_000;

// ---- Permissions ----
/** Guests (architecture v3 section 5.1) never see or change integrations; every check starts here. */
export function requireAccount(p: Principal): asserts p is repo.AccountPrincipal {
  if (p.kind === "guest") throw new Forbidden("Guests cannot open integrations.");
}

export function canEdit(p: Principal): p is repo.AccountPrincipal {
  if (p.kind === "guest") return false;
  if (p.role === "viewer") return false;
  if (p.kind === "agent") return p.scopes.includes("atrium:edit");
  return true;
}

function requireEdit(p: Principal): asserts p is repo.AccountPrincipal {
  requireAccount(p);
  if (!canEdit(p)) throw new Forbidden("Your role can view integrations but not change them.");
}

/** The owner of this Atrium, or the person who created the integration (architecture v3 section 3.1). */
export function isOwnerOrCreator(p: Principal, row: Pick<repo.IntegrationRow, "createdById">): boolean {
  return p.kind !== "guest" && (p.role === "owner" || row.createdById === p.userId);
}

/**
 * Changing or testing an existing integration (its address, credentials, endpoints, commands,
 * sharing, status) is for the owner of this Atrium or the person who created it.
 */
export function canManage(p: Principal, row: Pick<repo.IntegrationRow, "createdById">): boolean {
  return canEdit(p) && isOwnerOrCreator(p, row);
}

export function requireManage(p: Principal, row: Pick<repo.IntegrationRow, "createdById">): asserts p is repo.AccountPrincipal {
  requireEdit(p);
  if (!canManage(p, row)) throw new Forbidden("Only the owner or the person who added this integration can change it.");
}

function requireSessionUser(p: Principal): asserts p is Extract<Principal, { kind: "user" }> {
  if (p.kind !== "user") throw new Forbidden("Only a signed-in person can do this, on the integration's own page.");
}

// ---- Views ----
/** Amendment 2: a field filled from a saved credential. `credential` is present only for people who may see it. */
export type FieldCredential = { id: string; name: string; kind: string; lockedOrigins: string[] };
export type IntegrationView = Integration & { packageName: string; packageMissing: boolean; locked: boolean; untested: boolean; system: boolean; serviceSaved: boolean; secretFields: (PendingField & { set: boolean; updatedAt?: string; required: boolean; viaCredential: boolean; credential?: FieldCredential })[] };

function secretFieldsOf(row: repo.IntegrationRow, pkg: LoadedPackage | undefined): PackageManifest["secrets"] {
  if (!pkg) return [];
  return effectiveManifest(pkg, row.secretFields).secrets;
}

/**
 * The integration as the API shows it. `viewer` decides whether saved credential names are shown:
 * only the credential's creator and the owner see them (Amendment 2); without a viewer, none are.
 */
export function toView(row: repo.IntegrationRow, viewer?: Principal): IntegrationView {
  const pkg = getPackage(row.packageId);
  const fields = secretFieldsOf(row, pkg);
  const refs = new Map(credRepo.refsOfIntegration(row.id).map((r) => [r.secretKey, r]));
  const status = secretStatus("integration", row.id, fields.map((f) => f.key)).map((s) => {
    const ref = refs.get(s.key);
    if (!ref) return s;
    const label = credentialLabel(viewer, ref.credentialId);
    const c = credRepo.getCredentialRow(ref.credentialId);
    return { key: s.key, set: credentialComplete(ref.credentialId), ...(c ? { updatedAt: c.updatedAt.toISOString() } : {}), ...(label ? { credentialId: ref.credentialId } : {}) };
  });
  const locked = vaultStatus().state === "locked" && (status.some((s) => s.set) || refs.size > 0);
  const required = pkg ? requiredSecretKeys(effectiveManifest(pkg, row.secretFields), row.config) : new Set<string>();
  const info = serviceInfoOf(row, pkg?.manifest);
  return {
    id: row.id,
    packageId: row.packageId,
    name: row.name,
    config: row.config,
    secrets: status,
    status: row.status,
    shared: row.shared,
    kind: info.kind,
    ...(info.openUrl ? { openUrl: info.openUrl } : {}),
    ...(info.headline.length ? { headline: info.headline } : {}),
    system: row.id === repo.SYSTEM_INTEGRATION_ID,
    serviceSaved: serviceTableReady(),
    ...(row.lastHealth ? { lastHealth: row.lastHealth } : {}),
    createdBy: row.createdBy,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    packageName: pkg?.manifest.name ?? row.packageId,
    packageMissing: !pkg,
    locked,
    untested: !row.lastHealth,
    secretFields: fields.map((f) => {
      const s = status.find((x) => x.key === f.key);
      const ref = refs.get(f.key);
      const label = ref ? credentialLabel(viewer, ref.credentialId) : undefined;
      return { key: f.key, label: f.label, hint: f.hint, auth: f.auth, set: !!s?.set, required: required.has(f.key), viaCredential: !!ref, ...(label ? { credential: label } : {}), ...(s?.updatedAt ? { updatedAt: s.updatedAt } : {}) };
    }),
  };
}

export function listIntegrations(p: Principal): IntegrationView[] {
  requireAccount(p); // every signed-in role may list; guests never
  return repo.listIntegrationRows().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => toView(r, p));
}

export function getIntegration(p: Principal, id: string): IntegrationView {
  requireAccount(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  return toView(row, p);
}

/**
 * Reading an integration's live data outside an app (endpoint previews, GET /api/data/endpoint):
 * the owner or the integration's creator (the same isOwnerOrCreator check as canManage and Try it),
 * or anyone signed in when it is Shared (Amendment A1.1). Guests never.
 */
export function canReadData(p: Principal, row: Pick<repo.IntegrationRow, "createdById" | "shared">): boolean {
  if (p.kind === "guest") return false;
  return row.shared || isOwnerOrCreator(p, row);
}

/** The integration row for a data read, or the same NotFound as an unknown endpoint (no probing ids). */
export function readableIntegration(p: Principal, id: string): repo.IntegrationRow {
  const row = repo.getIntegrationRow(id);
  if (!row || !canReadData(p, row)) throw new NotFound("That endpoint does not exist.");
  return row;
}

/** v3: what a package can change, as listed under "This integration can change". */
export type CommandSummary = { id: string; label: string; risk: "low" | "medium"; ownerOnly: boolean; method?: string; path?: string };
export type PackageCard = { id: string; name: string; description: string; icon: string; source: LoadedPackage["source"]; status?: "draft" | "active"; config: PackageManifest["config"]; secrets: PackageManifest["secrets"]; endpoints: PackageManifest["endpoints"]; commands: CommandSummary[]; pendingCommands: CommandSummary[]; service?: PackageManifest["service"] };
function commandSummaries(p: LoadedPackage): CommandSummary[] {
  if (p.source === "declarative") return (p.declarativeCommands ?? []).map((c) => ({ id: c.id, label: c.label, risk: c.risk, ownerOnly: false, method: c.method, path: c.path }));
  const permitted = new Set(p.manifest.permissions.flatMap((x) => (x.kind === "command" ? x.ids : [])));
  return (p.manifest.commands ?? []).filter((c) => permitted.has(c.id)).map((c) => ({ id: c.id, label: c.label, risk: c.risk, ownerOnly: !!c.ownerOnly }));
}
function pendingSummaries(p: LoadedPackage): CommandSummary[] {
  if (p.source !== "declarative") return [];
  const d = repo.getDeclarativeRow(p.manifest.id);
  const published = new Map(((d?.commands ?? []) as { id: string }[]).map((c) => [c.id, JSON.stringify(c)]));
  return ((d?.draftCommands ?? []) as { id: string; label: string; risk: "low" | "medium"; method: string; path: string }[])
    .filter((c) => published.get(c.id) !== JSON.stringify(c))
    .map((c) => ({ id: c.id, label: c.label, risk: c.risk, ownerOnly: false, method: c.method, path: c.path }));
}
const card = (p: LoadedPackage): PackageCard => ({ id: p.manifest.id, name: p.manifest.name, description: p.manifest.description, icon: p.manifest.icon, source: p.source, ...(p.status ? { status: p.status } : {}), config: p.manifest.config, secrets: p.manifest.secrets, endpoints: p.manifest.endpoints, commands: commandSummaries(p), pendingCommands: pendingSummaries(p), ...(p.manifest.service ? { service: p.manifest.service } : {}) });

export function gallery(): { packages: PackageCard[]; declarative: PackageCard[]; problems: PackageProblem[] } {
  const r = getRegistry();
  return {
    packages: galleryOrder(r).map(card),
    declarative: r.order.map((id) => r.packages.get(id)!).filter((p) => p.source === "declarative").map(card),
    problems: r.problems.map((p) => ({ ...p, at: repo.firstSeen(p) })),
  };
}

export function packageCard(id: string): PackageCard {
  const p = getPackage(id);
  if (!p) throw new NotFound("That package is not installed.");
  return card(p);
}

// ---- Connection test ----
export type TestOutcome =
  | { ok: true; health: HealthResult; passId?: string }
  | { ok: false; heading: string; error: AdapterError; latencyMs: number };

const g = globalThis as unknown as { __atriumTestPasses?: Map<string, { fp: string; health: HealthResult; expiresAt: number }> };
const passes = (g.__atriumTestPasses ??= new Map());

function fingerprint(packageId: string, config: Record<string, unknown>, integrationId: string | undefined, secrets: Record<string, string>, pendingId?: string, credentials: Record<string, string> = {}) {
  const sec = Object.entries(secrets).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${createHash("sha256").update(v).digest("hex")}`);
  const picks = Object.entries(credentials).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}@${v}`);
  return createHash("sha256").update(JSON.stringify([packageId, canonicalJson(config), integrationId ?? "", sec, pendingId ?? "", picks])).digest("hex");
}

/** Amendment 2: saved credentials picked per secret key. `null` (updates only) switches a field back to its own value. */
const credentialPicks = z.record(z.string(), z.string().max(100));

/** Validates picks against the manifest's secret fields. Returns only the keys that name a credential. */
function checkPicks(p: Principal, manifest: PackageManifest, picks: Record<string, string | null> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(picks ?? {})) {
    if (!id) continue;
    const field = manifest.secrets.find((f) => f.key === key);
    if (!field) throw new AtriumError(`"${key}" is not a secret field of this integration.`, 400, "credential_pick");
    checkPick(p, field, id);
    out[key] = id;
  }
  return out;
}

export const testInput = z.object({
  packageId: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.string().max(8192)).default({}),
  integrationId: z.string().max(100).optional(),
  pendingId: z.string().max(100).optional(),
  customEndpoints: z.array(customEndpointSchema).max(50).optional(),
  credentials: credentialPicks.optional(),
  /** The explicit "Lock <credential> to <server>?" confirm for a picked credential not locked there yet. */
  confirmOrigins: z.boolean().optional(),
});

export async function testConnection(p: Principal, input: z.infer<typeof testInput>, lock: LockOptions = {}): Promise<TestOutcome> {
  requireEdit(p);
  let integrationId: string | undefined;
  let secretFields: repo.SecretFieldMeta[] | undefined;
  if (input.integrationId) {
    const row = repo.getIntegrationRow(input.integrationId);
    if (!row) throw new NotFound("That integration does not exist.");
    if (row.packageId !== input.packageId) throw new AtriumError("The package does not match this integration.");
    requireManage(p, row);
    integrationId = row.id;
    secretFields = row.secretFields;
  }
  const pending = input.pendingId ? pendingFields(input.pendingId, p.userId) : undefined;
  if (pending) secretFields = [...(secretFields ?? []), ...pending.filter((f) => !secretFields?.some((s) => s.key === f.key))];
  // Agents never supply secret values, nor pick credentials for a one-off test.
  const transient: Record<string, string> = p.kind === "user" ? { ...input.secrets } : {};
  const pkg = getPackage(input.packageId);
  const picks = p.kind === "user" && pkg ? checkPicks(p, effectiveManifest(pkg, secretFields), input.credentials) : {};
  for (const k of Object.keys(picks)) delete transient[k];
  if (pkg && Object.keys(picks).length) {
    // Fix List r3 item 1: a picked credential with no lock yet is tested only after the confirm and a
    // fresh step-up, and is locked to the tested server (audited as credential.locked) before the
    // test sends it. One locked to other servers is not sent (resolveCredential); Save asks for it.
    const manifest = effectiveManifest(pkg, secretFields);
    const cfg = validateConfig(manifest, input.config);
    const origin = cfg.ok ? pinFor(manifest, cfg.config) : undefined;
    if (origin && /^https?:\/\//.test(origin)) {
      const needs = locksNeeded(Object.values(picks), origin).filter((n) => n.firstUse);
      guardLocks(p, needs, { ...lock, confirmOrigins: input.confirmOrigins ?? lock.confirmOrigins });
      const row = integrationId ? repo.getIntegrationRow(integrationId) : undefined;
      applyLocks(p, needs, { test: true, integration: row ? { id: row.id, name: row.name } : undefined });
    }
  }
  const out = await runHealth({
    credentialRefs: picks,
    packageId: input.packageId,
    config: input.config,
    ...(integrationId ? { integrationId } : {}),
    transientSecrets: { ...transient },
    ...(secretFields ? { secretFields } : {}),
    ...(input.customEndpoints ? { customEndpoints: input.customEndpoints as CustomEndpoint[] } : {}),
    ...(input.pendingId && pending ? { pending: { id: input.pendingId, userId: p.userId } } : {}),
  });
  const checkedAt = new Date().toISOString();
  if (integrationId) {
    repo.updateIntegration(integrationId, { lastHealth: out.ok ? { ...out.health, checkedAt } : { status: "down", latencyMs: out.latencyMs, message: out.error.message, checkedAt } });
  }
  if (!out.ok) return { ok: false, heading: ERROR_HEADINGS[out.error.code], error: out.error, latencyMs: out.latencyMs };
  const passId = `tp_${randomBytes(16).toString("base64url")}`;
  passes.set(passId, { fp: fingerprint(input.packageId, input.config, integrationId, transient, input.pendingId, picks), health: out.health, expiresAt: Date.now() + PASS_TTL_MS });
  return { ok: true, health: out.health, passId };
}

function takePass(passId: string | undefined, fp: string): HealthResult | undefined {
  if (!passId) return undefined;
  const pass = passes.get(passId);
  if (!pass || pass.expiresAt < Date.now() || pass.fp !== fp) return undefined;
  passes.delete(passId);
  return pass.health;
}

// ---- Create, update, delete ----
/** A10.5: the service fields of the integration form (not config, not secret). "" clears a field. */
const serviceFields = {
  kind: z.enum(SERVICE_KINDS).optional(),
  openUrl: z.string().max(2048).optional(),
  headline: z.array(headlineStatSchema).max(4).nullable().optional(),
};

/** The service fields to save: an Open address must be an http or https address with no credentials. */
function servicePatch(input: { kind?: z.infer<typeof serviceFields.kind>; openUrl?: string | undefined; headline?: z.infer<typeof headlineStatSchema>[] | null | undefined }) {
  const out: Parameters<typeof saveServiceRow>[1] = {};
  if (input.kind !== undefined) out.kind = input.kind;
  if (input.openUrl !== undefined) {
    if (!input.openUrl.trim()) out.openUrl = ""; // no link
    else {
      const u = cleanOpenUrl(input.openUrl);
      if (!u) throw new FieldError("The Open address must be a full http:// or https:// address with no user name or password in it.", "openUrl");
      out.openUrl = u;
    }
  }
  if (input.headline !== undefined) out.headline = input.headline as never;
  return out;
}

export const createInput = z.object({
  packageId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(120),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.string().max(8192)).default({}),
  pendingId: z.string().max(100).optional(),
  passId: z.string().max(100).optional(),
  untested: z.boolean().optional(),
  endpoints: z.array(customEndpointSchema).max(50).optional(),
  credentials: credentialPicks.optional(),
  /** The explicit "Also allow <credential> on <server>" confirm (Amendment 2). */
  confirmOrigins: z.boolean().optional(),
  ...serviceFields,
});

export function createIntegration(p: Principal, input: z.infer<typeof createInput>, lock: LockOptions = {}): IntegrationView {
  requireEdit(p);
  const pkg = getPackage(input.packageId);
  if (!pkg) throw new NotFound("That package is not installed.");
  if (pkg.manifest.id === SYSTEM_PACKAGE_ID) throw new AtriumError("The built-in Atrium integration is already there; there is only one.", 400, "config");
  const service = servicePatch(input);
  const pending = input.pendingId ? (pendingFields(input.pendingId, p.userId) ?? []) : [];
  const secretFields: repo.SecretFieldMeta[] = pkg.manifest.id === "custom-api" ? pending.map((f) => ({ key: f.key, label: f.label, hint: f.hint, auth: f.auth })) : [];
  const manifest = effectiveManifest(pkg, secretFields);
  const cfg = validateConfig(manifest, input.config);
  if (!cfg.ok) throw new AtriumError(cfg.error.message, 400, "config");
  // Held curl credentials are sealed only onto an integration at the address they came with.
  if (input.pendingId && pending.length && pendingOrigin(input.pendingId, p.userId) !== pinFor(manifest, cfg.config)) {
    throw new AtriumError("Credentials from the pasted command can only be saved for the address they came with.", 400, "secrets_pinned");
  }
  const picks = checkPicks(p, manifest, input.credentials);
  const typedSecrets = Object.fromEntries(Object.entries(input.secrets).filter(([k]) => !picks[k]));
  const origin = pinFor(manifest, cfg.config);
  // A person saving locks each picked credential to this server, or must confirm a new one.
  const needs = p.kind === "user" ? locksNeeded(Object.values(picks), origin) : [];
  if (p.kind === "user") guardLocks(p, needs, { ...lock, confirmOrigins: input.confirmOrigins ?? lock.confirmOrigins });
  let status: Integration["status"];
  let lastHealth: (HealthResult & { checkedAt: string }) | null = null;
  if (p.kind !== "user") {
    // Agents create drafts only, and never touch credentials (architecture v2 section 9b).
    if (Object.values(input.secrets).some(Boolean) || input.pendingId) throw new Forbidden("Agents cannot set credentials. Use integrations.request_credentials to get a link for the user.");
    status = "draft";
  } else {
    const health = takePass(input.passId, fingerprint(input.packageId, input.config, undefined, typedSecrets, input.pendingId, picks));
    if (!health && !input.untested) throw new AtriumError("Test the connection first, or choose Save without testing.", 400, "untested");
    status = "active";
    if (health) lastHealth = { ...health, checkedAt: new Date().toISOString() };
  }
  const allowedKeys = new Set(manifest.secrets.map((s) => s.key));
  const row = repo.insertIntegration({ packageId: pkg.manifest.id, name: uniqueName(input.name), config: cfg.config, secretFields, status, lastHealth, principal: p });
  try {
    if (p.kind === "user") {
      let sealed = false;
      for (const [key, value] of Object.entries(typedSecrets)) if (value && allowedKeys.has(key)) { seal({ ownerType: "integration", ownerId: row.id, key }, value); sealed = true; }
      if (sealPending(input.pendingId, p.userId, row.id).length) sealed = true;
      for (const [key, id] of Object.entries(picks)) { credRepo.setRef(row.id, key, id); sealed = true; }
      if (sealed && origin) recordPin(row.id, origin);
    } else {
      // An agent may propose saved credentials for its draft; locking waits for the person's publish.
      for (const [key, id] of Object.entries(picks)) credRepo.setRef(row.id, key, id);
    }
    for (const e of input.endpoints ?? []) addEndpointRow(row, e as CustomEndpoint);
    // A10.5: the Open address defaults to the configured base address at creation.
    if (serviceTableReady()) saveServiceRow(row.id, { ...service, ...(service.openUrl === undefined || service.openUrl === "" ? { openUrl: baseAddressOf(row) ?? null } : {}) });
  } catch (err) {
    repo.deleteIntegrationRow(row.id);
    removeSecrets("integration", row.id);
    throw err;
  }
  if (p.kind === "user") applyLocks(p, needs, { id: row.id, name: row.name });
  return toView(repo.getIntegrationRow(row.id)!, p);
}

/** "Prometheus", then "Prometheus 2", "Prometheus 3": two integrations never share a name. */
function uniqueName(name: string, exceptId?: string): string {
  const taken = new Set(repo.listIntegrationRows().filter((r) => r.id !== exceptId).map((r) => r.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`.slice(0, 120);
}

/** Saved integrations at the same address as `config` (for the "already set up here" notice). */
export function sameAddress(packageId: string, config: Record<string, unknown>): { id: string; name: string; packageId: string }[] {
  const pkg = getPackage(packageId);
  if (!pkg) return [];
  const v = validateConfig(pkg.manifest, config);
  const origin = v.ok ? pinFor(pkg.manifest, v.config) : undefined;
  if (!origin) return [];
  return repo.listIntegrationRows().filter((r) => {
    const rp = getPackage(r.packageId);
    return rp && pinFor(rp.manifest, r.config) === origin;
  }).map((r) => ({ id: r.id, name: r.name, packageId: r.packageId }));
}

/** Every saved integration with the origin it points at, for "already set up here" notices. */
export type AddressEntry = { id: string; name: string; packageId: string; origin: string };
export function addressBook(p: Principal): AddressEntry[] {
  requireAccount(p);
  return repo.listIntegrationRows().flatMap((r) => {
    const rp = getPackage(r.packageId);
    const origin = rp ? pinFor(effectiveManifest(rp, r.secretFields), r.config) : undefined;
    return origin ? [{ id: r.id, name: r.name, packageId: r.packageId, origin }] : [];
  });
}

export const SECRETS_PINNED_MESSAGE = "Changing the address removes the saved credentials, because Atrium only sends them to the address they were saved for";

export const updateInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  /** v3 (section 3.1, A1.1): only the owner and the creator may switch it; a session user only. */
  shared: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  /** Required to move an integration with saved credentials to a new address: they are deleted. */
  clearSecrets: z.boolean().optional(),
  /** Amendment 2: saved credential picks (agents: drafts only). Empty string switches a field back. */
  credentials: z.record(z.string(), z.string().max(100)).optional(),
  confirmOrigins: z.boolean().optional(),
  ...serviceFields,
});

export function updateIntegration(p: Principal, id: string, input: z.infer<typeof updateInput>, lock: LockOptions = {}): IntegrationView {
  requireEdit(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  if (row.id === repo.SYSTEM_INTEGRATION_ID && ((input.config && Object.keys(input.config).length) || input.status || input.shared === false || input.credentials)) throw new Forbidden("The built-in Atrium integration cannot be changed or turned off.");
  const service = servicePatch(input);
  if (Object.keys(service).length && !serviceTableReady()) throw new AtriumError(SERVICE_TABLE_MISSING, 503, "service_fields_unavailable");
  if (p.kind !== "user") {
    if (row.status !== "draft") throw new Forbidden("Agents can only change draft integrations. Ask the user to edit a live one.");
    if (input.status) throw new Forbidden("Only the user can publish or disable an integration.");
  }
  const patch: Parameters<typeof repo.updateIntegration>[1] = {};
  if (input.shared !== undefined && input.shared !== row.shared) {
    if (p.kind !== "user") throw new Forbidden("Only a signed-in person can change who may use this integration.");
    patch.shared = input.shared;
  }
  if (input.name) patch.name = uniqueName(input.name, id);
  let clear = false;
  let newOrigin: string | undefined;
  let moveNeeds: ReturnType<typeof locksNeeded> = [];
  const pickInput = input.credentials ? Object.fromEntries(Object.entries(input.credentials).map(([k, v]) => [k, v || null])) : undefined;
  if (pickInput && row.status !== "draft") throw new AtriumError("Pick saved credentials on the integration's connection form.", 400, "credential_pick");
  if (input.config) {
    const pkg = getPackage(row.packageId);
    if (!pkg) throw new NotFound("That package is not installed.");
    const manifest = effectiveManifest(pkg, row.secretFields);
    const cfg = validateConfig(manifest, { ...row.config, ...input.config });
    if (!cfg.ok) throw new AtriumError(cfg.error.message, 400, "config");
    // Secrets are pinned to the saved address: moving to another origin deletes them (finding 1).
    const moved = pinFor(manifest, row.config) !== pinFor(manifest, cfg.config);
    const hasSecrets = secretStatus("integration", id).some((x) => x.set && x.key !== PIN_KEY);
    if (moved && hasSecrets) {
      if (!input.clearSecrets) throw new AtriumError(`${SECRETS_PINNED_MESSAGE}. Confirm to remove them, then enter them again.`, 409, "secrets_pinned");
      if (vaultStatus().state === "locked") throw new AtriumError(SECRETS_LOCKED_MESSAGE, 503, "secrets_locked");
      clear = true;
    }
    // Saved credentials stay, but a live integration's new server must be in their lock lists (Amendment 2).
    const refs = credRepo.refsOfIntegration(id);
    if (moved && refs.length) {
      newOrigin = pinFor(manifest, cfg.config);
      if (row.status !== "draft") {
        moveNeeds = locksNeeded(refs.map((r) => r.credentialId), newOrigin);
        guardLocks(p, moveNeeds, { ...lock, confirmOrigins: input.confirmOrigins ?? lock.confirmOrigins });
      }
    }
    patch.config = cfg.config;
    patch.lastHealth = null; // a changed config is untested until it passes again
  }
  if (input.status) {
    if (row.status === "draft") throw new AtriumError("Publish the draft on its credentials page first.");
    patch.status = input.status;
  }
  if (pickInput) {
    const pkg = getPackage(row.packageId);
    if (!pkg) throw new NotFound("That package is not installed.");
    const picks = checkPicks(p, effectiveManifest(pkg, row.secretFields), pickInput);
    for (const [key, v] of Object.entries(pickInput)) if (v === null) credRepo.removeRef(id, key);
    for (const [key, cid] of Object.entries(picks)) credRepo.setRef(id, key, cid);
  }
  if (clear) removeSecrets("integration", id);
  repo.updateIntegration(id, patch);
  if (Object.keys(service).length) saveServiceRow(id, service);
  if (newOrigin && row.status !== "draft") {
    applyLocks(p, moveNeeds, { id, name: patch.name ?? row.name });
    recordPin(id, newOrigin);
  }
  if (patch.shared !== undefined) audit.write({ actor: p, event: "integration.updated", target: { type: "integration", id, label: row.name }, result: "ok", detail: { shared: patch.shared } });
  if (input.config || input.status) forgetIntegration(id);
  // A9.2: a changed address or setting re-checks the recipe reads on the server it now points at.
  if ((input.config || input.status === "active") && (patch.status ?? row.status) === "active") void checkReads(id).catch(() => undefined);
  return toView(repo.getIntegrationRow(id)!, p);
}

export type FieldChoices = {
  /** Typed values; a blank value keeps the stored one. */
  secrets: Record<string, string>;
  /** Saved credential picks by key; null switches a field back to its own value (Amendment 2). */
  credentials?: Record<string, string | null> | undefined;
  confirmOrigins?: boolean | undefined;
};

/**
 * Write-only secret fields: a blank value keeps the stored one. Session users only. A field is
 * filled either by its own value or by a saved credential, never both. Picking a credential on a
 * live integration checks its lock (Amendment 2); on a draft the check waits for publish.
 */
export function saveSecrets(p: Principal, id: string, values: Record<string, string>, more: Omit<FieldChoices, "secrets"> = {}, lock: LockOptions = {}): IntegrationView {
  requireSessionUser(p);
  requireEdit(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  const pkg = getPackage(row.packageId);
  if (!pkg) throw new NotFound("That package is not installed.");
  const manifest = effectiveManifest(pkg, row.secretFields);
  const allowed = new Set(manifest.secrets.map((s) => s.key));
  const picks = checkPicks(p, manifest, more.credentials ?? undefined);
  const origin = pinFor(manifest, row.config);
  const current = new Map(credRepo.refsOfIntegration(id).map((r) => [r.secretKey, r.credentialId]));
  const added = Object.entries(picks).filter(([k, v]) => current.get(k) !== v).map(([, v]) => v);
  // Fix List r2 item 4: a kept pick whose credential no longer lists this server (it was removed)
  // is confirmed again here, under the same rules as a new server.
  const kept = Object.entries(picks).filter(([k, v]) => current.get(k) === v).map(([, v]) => v);
  const relock = row.status !== "draft" && origin ? kept.filter((cid) => !(credRepo.getCredentialRow(cid)?.lockedOrigins ?? []).includes(origin)) : [];
  const needs = row.status !== "draft" ? locksNeeded([...added, ...relock], origin) : [];
  guardLocks(p, needs, { ...lock, confirmOrigins: more.confirmOrigins ?? lock.confirmOrigins });
  const typed = Object.entries(values).filter(([key, value]) => allowed.has(key) && value && !picks[key]);
  if (typed.length && vaultStatus().state === "locked") throw new AtriumError(SECRETS_LOCKED_MESSAGE, 503, "secrets_locked");
  let changed = false;
  for (const [key, value] of typed) {
    seal({ ownerType: "integration", ownerId: id, key }, value);
    credRepo.removeRef(id, key);
    changed = true;
  }
  for (const [key, v] of Object.entries(more.credentials ?? {})) {
    if (v !== null || !current.has(key)) continue;
    credRepo.removeRef(id, key);
    changed = true;
  }
  for (const [key, cid] of Object.entries(picks)) {
    if (current.get(key) === cid) continue;
    credRepo.setRef(id, key, cid);
    removeSecrets("integration", id, key); // the field now uses the credential, not its own value
    changed = true;
  }
  if (relock.length) changed = true;
  if (changed) {
    // The secrets are typed for the address saved now, so that is where they are pinned.
    if (origin) recordPin(id, origin);
    applyLocks(p, needs, { id, name: row.name });
    repo.updateIntegration(id, { lastHealth: null });
    forgetIntegration(id);
  }
  return toView(repo.getIntegrationRow(id)!, p);
}

export function deleteIntegration(p: Principal, id: string): void {
  requireEdit(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  if (row.id === repo.SYSTEM_INTEGRATION_ID) throw new Forbidden("The built-in Atrium integration cannot be removed.");
  if (p.kind !== "user" && row.status !== "draft") throw new Forbidden("Agents can only delete draft integrations.");
  requireManage(p, row);
  repo.deleteIntegrationRow(id);
  removeSecrets("integration", id);
  forgetIntegration(id);
}

// ---- Endpoints ----
export function listEndpoints(p: Principal, id: string) {
  requireAccount(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  return endpointsOf(row).map(({ custom, recipe, ...e }) => ({ ...e, ...(custom ? { method: custom.method, path: custom.path, fields: custom.fields } : {}), ...(recipe ? { from: fromTag(recipe.name, recipe.source) } : builtinFrom(row.packageId, e.id)) }));
}

function addEndpointRow(row: repo.IntegrationRow, e: CustomEndpoint) {
  if (row.packageId !== "custom-api") throw new AtriumError("Only Custom API integrations take custom endpoints. Save it as a declarative package to share it.");
  const parsed = customEndpointSchema.safeParse(e);
  if (!parsed.success) throw new AtriumError(parsed.error.issues[0]!.message, 400, "config");
  const pkg = getPackage(row.packageId)!;
  const keys = new Set(effectiveManifest(pkg, row.secretFields).secrets.map((s) => s.key));
  if (parsed.data.auth && !keys.has(parsed.data.auth)) throw new AtriumError(`The secret "${parsed.data.auth}" is not a field of this integration.`);
  repo.upsertCustomEndpoint(row.id, parsed.data as CustomEndpoint);
}

export function addEndpoint(p: Principal, id: string, e: unknown): ReturnType<typeof listEndpoints> {
  requireEdit(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  if (p.kind !== "user" && row.status !== "draft") throw new Forbidden("Agents can only add endpoints to draft integrations.");
  requireManage(p, row);
  const r = customEndpointSchema.safeParse(e);
  if (!r.success) throw new AtriumError(r.error.issues[0]!.message, 400, "config");
  if (r.data.refreshSec < CUSTOM_MIN_REFRESH_SEC) throw new AtriumError(`Refresh must be at least ${CUSTOM_MIN_REFRESH_SEC} seconds.`);
  addEndpointRow(row, r.data as CustomEndpoint);
  forgetIntegration(id);
  return listEndpoints(p, id);
}

export function removeEndpoint(p: Principal, id: string, endpointId: string) {
  requireEdit(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  repo.deleteCustomEndpoint(id, endpointId);
  forgetIntegration(id);
  return listEndpoints(p, id);
}

// ---- Credentials link and publishing (section 9b) ----
export function requestCredentials(p: Principal, id: string, baseUrl: string, picks?: Record<string, string>): { credentialsUrl: string; expiresAt: string } {
  requireEdit(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  if (picks && Object.keys(picks).length) {
    // Amendment 2: an agent may propose saved credentials; the person still publishes on the page.
    if (row.status !== "draft") throw new AtriumError("Saved credentials can only be proposed for a draft integration.", 400, "credential_pick");
    const pkg = getPackage(row.packageId);
    if (!pkg) throw new NotFound("That package is not installed.");
    for (const [key, cid] of Object.entries(checkPicks(p, effectiveManifest(pkg, row.secretFields), picks))) credRepo.setRef(id, key, cid);
  }
  const token = randomBytes(24).toString("base64url");
  const { expiresAt } = repo.insertCredentialLink(id, token, p.userId, CREDENTIAL_LINK_TTL_MS);
  const url = new URL(`/integrations/${encodeURIComponent(id)}/credentials`, baseUrl);
  url.searchParams.set("draft", token);
  return { credentialsUrl: url.toString(), expiresAt: expiresAt.toISOString() };
}

export const LINK_EXPIRED_MESSAGE = "This link has expired. Ask your agent for a new one";

export function checkCredentialLink(id: string, token: string | undefined, now = Date.now()): { ok: true } | { ok: false; message: string } {
  if (!token) return { ok: false, message: LINK_EXPIRED_MESSAGE };
  const link = repo.getCredentialLink(token);
  if (!link || link.integrationId !== id || link.usedAt || link.expiresAt.getTime() <= now) return { ok: false, message: LINK_EXPIRED_MESSAGE };
  return { ok: true };
}

/**
 * Saves the credentials and publishes a draft. Session users only, never agents; every secret must
 * be set. Saved credentials it uses are locked to its server here (Amendment 2): a new server for a
 * credential locked elsewhere needs the explicit confirm and a fresh step-up, before anything changes.
 */
export function publishDraft(p: Principal, id: string, input: { token?: string; secrets: Record<string, string>; credentials?: Record<string, string | null>; confirmOrigins?: boolean }, lock: LockOptions = {}): IntegrationView {
  requireSessionUser(p);
  requireEdit(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  if (input.token) {
    const link = checkCredentialLink(id, input.token);
    if (!link.ok) throw new AtriumError(link.message, 410, "link_expired");
  }
  const pkg = getPackage(row.packageId);
  const manifest = pkg ? effectiveManifest(pkg, row.secretFields) : undefined;
  // The refs after this publish: the stored ones, overlaid with this request's picks.
  const final = new Map(credRepo.refsOfIntegration(id).map((r) => [r.secretKey, r.credentialId]));
  const picks = manifest ? checkPicks(p, manifest, input.credentials) : {};
  for (const [k, v] of Object.entries(input.credentials ?? {})) if (v === null) final.delete(k);
  for (const [k, v] of Object.entries(input.secrets)) if (v && !picks[k]) final.delete(k);
  for (const [k, v] of Object.entries(picks)) final.set(k, v);
  const publishing = row.status === "draft";
  const origin = manifest ? pinFor(manifest, row.config) : undefined;
  const needs = publishing ? locksNeeded([...final.values()], origin) : [];
  guardLocks(p, needs, { ...lock, confirmOrigins: input.confirmOrigins ?? lock.confirmOrigins });
  if (Object.values(input.secrets).some(Boolean) || input.credentials) saveSecrets(p, id, input.secrets, { credentials: input.credentials }, { ...lock, confirmOrigins: true });
  const view = toView(repo.getIntegrationRow(id)!, p);
  const missing = view.secretFields.filter((f) => f.required && !f.set);
  if (missing.length) throw new AtriumError(`Enter ${missing.map((m) => m.label).join(", ")} before publishing.`, 400, "secrets_missing");
  repo.markLinksUsed(id);
  if (publishing) {
    applyLocks(p, needs, { id, name: row.name });
    if (final.size && origin) recordPin(id, origin);
    repo.updateIntegration(id, { status: "active" });
  }
  return toView(repo.getIntegrationRow(id)!, p);
}

// ---- Declarative packages ----
const declarativeInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300).default("A package made in Atrium."),
  id: z.string().regex(/^local\/[a-z0-9][a-z0-9-]{0,60}$/).optional(),
  version: z.string().default("1.0.0"),
  hosts: z.array(z.string()).max(10).optional(),
  secrets: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), hint: z.string().min(1), auth: z.any() })).max(10).default([]),
  endpoints: z.array(customEndpointSchema).min(1).max(50),
  // v3 (section 3.1): commands.json. Added or changed commands wait as a draft until published.
  commands: z.array(customCommandSchema).max(50).optional(),
});
export type DeclarativeInput = z.input<typeof declarativeInput>;

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "package";

function declarativeManifest(p: repo.AccountPrincipal, d: z.infer<typeof declarativeInput>, id: string, commandIds: string[] = []): Record<string, unknown> {
  return {
    atriumApi: "1",
    kind: "declarative",
    id,
    name: d.name,
    version: d.version,
    author: p.kind === "agent" ? `${p.agentName} (agent)` : "Atrium user",
    description: d.description,
    icon: "icon.svg",
    permissions: [{ kind: "network", hosts: d.hosts?.length ? d.hosts : "configured" }, ...d.secrets.map((s) => ({ kind: "secret", key: s.key })), ...(commandIds.length ? [{ kind: "command", ids: commandIds }] : [])],
    config: { type: "object", required: ["baseUrl"], properties: { baseUrl: { type: "string", title: "Base URL", format: "uri", description: "The address of the service." }, verifyTls: { type: "boolean", title: "Verify TLS", default: true } } },
    secrets: d.secrets,
    endpoints: endpointDefsFor(d.endpoints as CustomEndpoint[]),
  };
}

export function saveDeclarativePackage(p: Principal, raw: unknown, opts: { update?: string } = {}): PackageCard {
  requireEdit(p);
  const d = declarativeInput.parse(raw);
  const id = opts.update ?? d.id ?? `local/${slugify(d.name)}`;
  if (opts.update && !repo.getDeclarativeRow(opts.update)) throw new NotFound("That package does not exist.");
  if (!opts.update && (repo.getDeclarativeRow(id) || getPackage(id))) throw new AtriumError(`A package with the id ${id} already exists.`, 409, "conflict");
  const existing = opts.update ? repo.getDeclarativeRow(opts.update) : undefined;
  if (existing && existing.createdById !== p.userId && p.role !== "owner") throw new Forbidden("Only the owner or the person who made this package can change it.");
  // Published commands stay as they are; a new or changed commands.json becomes a pending draft.
  const published = (existing?.commands ?? []) as z.infer<typeof customCommandSchema>[];
  const manifest = declarativeManifest(p, d, id, published.map((c) => c.id));
  const v = validateManifest(manifest, { hasAdapter: false, source: "declarative", declarativeEndpoints: d.endpoints, declarativeCommands: published });
  if (!v.ok) throw new AtriumError(`The package is not valid: ${v.reason}.`, 400, "invalid_package");
  let draftCommands: unknown[] | null | undefined;
  if (d.commands) {
    const keys = new Set(d.secrets.map((x) => x.key));
    for (const c of d.commands) if (c.auth && !keys.has(c.auth)) throw new AtriumError(`The package is not valid: command "${c.id}" uses undeclared secret "${c.auth}".`, 400, "invalid_package");
    if (new Set(d.commands.map((c) => c.id)).size !== d.commands.length) throw new AtriumError("The package is not valid: a command id is used twice.", 400, "invalid_package");
    draftCommands = JSON.stringify(d.commands) === JSON.stringify(published) ? null : d.commands;
  }
  repo.saveDeclarative({ id, manifest, endpoints: d.endpoints, status: p.kind === "user" ? (existing?.status ?? "active") : "draft", principal: p, ...(existing ? {} : { commands: [] }), ...(draftCommands !== undefined ? { draftCommands } : {}) });
  if (draftCommands) audit.write({ actor: p, event: "draft.created", target: { type: "package", id }, result: "ok", detail: { commands: (draftCommands as { id: string }[]).map((c) => c.id) } });
  reloadRegistry();
  return packageCard(id);
}

/** Publishes a declarative package's pending commands.json. Signed-in owner or the package's creator only. */
export function publishPackageCommands(p: Principal, id: string): PackageCard {
  requireSessionUser(p);
  const row = repo.getDeclarativeRow(id);
  if (!row) throw new NotFound("That package does not exist.");
  if (row.createdById !== p.userId && p.role !== "owner") throw new Forbidden("Only the owner or the person who made this package can publish what it can change.");
  if (!row.draftCommands) return packageCard(id);
  const commands = row.draftCommands as z.infer<typeof customCommandSchema>[];
  const manifest = { ...row.manifest, permissions: [...((row.manifest.permissions as { kind: string }[]) ?? []).filter((x) => x.kind !== "command"), ...(commands.length ? [{ kind: "command", ids: commands.map((c) => c.id) }] : [])] };
  const v = validateManifest(manifest, { hasAdapter: false, source: "declarative", declarativeEndpoints: row.endpoints, declarativeCommands: commands });
  if (!v.ok) throw new AtriumError(`The package is not valid: ${v.reason}.`, 400, "invalid_package");
  repo.setDeclarativeCommands(id, { commands, draftCommands: null, manifest });
  audit.write({ actor: p, event: "draft.published", target: { type: "package", id }, result: "ok", detail: { commands: commands.map((c) => c.id) } });
  reloadRegistry();
  return packageCard(id);
}

/** Export format: one JSON file, shared like a theme. */
export type PackageFile = { atriumPackage: "1"; manifest: Record<string, unknown>; endpoints: unknown[]; commands?: unknown[] };

export function exportDeclarativePackage(id: string): PackageFile {
  const row = repo.getDeclarativeRow(id);
  if (!row) throw new NotFound("That package does not exist.");
  return { atriumPackage: "1", manifest: row.manifest, endpoints: row.endpoints, ...((row.commands ?? []).length ? { commands: row.commands } : {}) };
}

export function importDeclarativePackage(p: Principal, file: unknown): PackageCard {
  requireEdit(p);
  const f = z.object({ atriumPackage: z.literal("1"), manifest: z.record(z.string(), z.unknown()), endpoints: z.array(z.unknown()), commands: z.array(z.unknown()).optional() }).safeParse(file);
  if (!f.success) throw new AtriumError("That file is not an Atrium package.", 400, "invalid_package");
  const v = validateManifest(f.data.manifest, { hasAdapter: false, source: "declarative", declarativeEndpoints: f.data.endpoints, declarativeCommands: f.data.commands ?? [] });
  if (!v.ok) throw new AtriumError(`The package is not valid: ${v.reason}.`, 400, "invalid_package");
  if (v.manifest.kind !== "declarative") throw new AtriumError("Only declarative packages can be imported. They contain no code.", 400, "invalid_package");
  if (getPackage(v.manifest.id)?.source === "official") throw new AtriumError("That id belongs to an official package.", 409, "conflict");
  // Imported commands never arrive live: they wait under "This integration can change" until published.
  const imported = f.data.commands ?? [];
  const manifest = { ...f.data.manifest, permissions: ((f.data.manifest.permissions as { kind: string }[]) ?? []).filter((x) => x.kind !== "command") };
  repo.saveDeclarative({ id: v.manifest.id, manifest, endpoints: f.data.endpoints, status: p.kind === "user" ? "active" : "draft", principal: p, commands: [], draftCommands: imported.length ? imported : null });
  reloadRegistry();
  return packageCard(v.manifest.id);
}

export function deleteDeclarativePackage(p: Principal, id: string): void {
  requireEdit(p);
  const row = repo.getDeclarativeRow(id);
  if (!row) throw new NotFound("That package does not exist.");
  if (p.kind !== "user" && row.status !== "draft") throw new Forbidden("Agents can only delete draft packages.");
  repo.deleteDeclarative(id);
  reloadRegistry();
}

/** Turns a Custom API integration's endpoints into a declarative package (the "Save as package" button). */
export function packageFromIntegration(p: Principal, integrationId: string, name: string): PackageCard {
  const row = repo.getIntegrationRow(integrationId);
  if (!row) throw new NotFound("That integration does not exist.");
  if (row.packageId !== "custom-api") throw new AtriumError("Only Custom API integrations can be saved as a package.");
  const endpoints = repo.listCustomEndpoints(integrationId);
  if (!endpoints.length) throw new AtriumError("Add at least one endpoint first.");
  return saveDeclarativePackage(p, { name, description: `Made from ${row.name}.`, secrets: row.secretFields, endpoints });
}

export function canPublish(view: IntegrationView): boolean {
  return view.secretFields.every((f) => !f.required || f.set);
}

// ---- Sharing (section 3.1, amendment A1.1) ----
export type SharingView = { shared: boolean; canChange: boolean; affectedApps: { id: string; name: string; slug: string }[]; appsKnown: boolean };

/**
 * The Shared setting and, before it is switched off, the apps that would stop showing this
 * integration's data: apps that someone other than the owner and the creator can edit. Until
 * app-builder registers the app access hook (Wave 2) no apps exist, so the list is empty and
 * `appsKnown` is false.
 */
export async function sharingView(p: Principal, id: string): Promise<SharingView> {
  requireAccount(p);
  const row = repo.getIntegrationRow(id);
  if (!row) throw new NotFound("That integration does not exist.");
  const hook = appAccess();
  let affected: SharingView["affectedApps"] = [];
  if (hook && p.kind === "user") {
    const { bindingAllowedInApp } = await import("./commands");
    const owners = repo.ownerIds();
    const apps = await hook.appsFor(p);
    affected = apps.filter((a) => !bindingAllowedInApp(a, { ...row, shared: false }, owners)).map((a) => ({ id: a.id, name: a.name, slug: a.slug }));
  }
  return { shared: row.shared, canChange: canManage(p, row) && p.kind === "user", affectedApps: affected, appsKnown: !!hook };
}
