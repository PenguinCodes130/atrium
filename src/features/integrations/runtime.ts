// Runs packages: the registry singleton, health checks and readEndpoint() (architecture v2 section 2 exports).
import "server-only";
import type { AdapterContext, AdapterError, CustomEndpoint, EndpointDef, HealthResult, PackageManifest, ReadResult } from "@/core/contracts";
import { env } from "@/core/env";
import { logger } from "@/core/log";
import { sendSystemAlert } from "./alerts";
import { HostError } from "./host/errors";
import { createHostHttp, pinOriginFor, type RequestRecord } from "./host/http";
import { secretsLocked, vaultResolver } from "./host/secrets";
import { SECRETS_LOCKED_MESSAGE } from "./host/errors";
import { secretStatus } from "@/features/vault";
import { CUSTOM_MIN_REFRESH_SEC } from "./manifest";
import { refsOfIntegration } from "./credentials/repo";
import { withScheme } from "./address-input";
import { secretKeysFor } from "./config-ui";
import { OFFICIAL_PACKAGES } from "./official";
import { buildRegistry, type LoadedPackage, type Registry } from "./registry";
import { offBuiltinReads, recipeEndpoints, resolveRead, type RecipeEndpoint } from "@/features/recipes/store";
import { parseRecipeEndpointId } from "@/features/recipes/schema";
import { runRecipeRead } from "@/features/recipes/run";
import { dbProblemSink, getIntegrationRow, listCustomEndpoints, listDeclarativeRows, type IntegrationRow, type SecretFieldMeta } from "./repo";

const g = globalThis as unknown as { __atriumRegistry?: Registry };

export function getRegistry(): Registry {
  if (!g.__atriumRegistry) {
    g.__atriumRegistry = buildRegistry(OFFICIAL_PACKAGES, listDeclarativeRows(), dbProblemSink, (p) =>
      sendSystemAlert({ severity: "warning", title: `Package "${p.packageId}" could not be loaded`, body: `${p.source} package skipped: ${p.reason}`, url: "/integrations", dedupeKey: `package-problem:${p.packageId}:${p.reason}` }),
    );
  }
  return g.__atriumRegistry;
}

export function reloadRegistry(): Registry {
  g.__atriumRegistry = undefined;
  return getRegistry();
}

export function getPackage(id: string): LoadedPackage | undefined {
  return getRegistry().packages.get(id);
}

/** Custom API integrations add their own secret fields (found in a pasted curl command). */
export function effectiveManifest(pkg: LoadedPackage, secretFields: SecretFieldMeta[] = []): PackageManifest {
  if (pkg.manifest.id !== "custom-api" || secretFields.length === 0) return pkg.manifest;
  const fields = secretFields.map((s) => ({ key: s.key, label: s.label, hint: s.hint, auth: s.auth as PackageManifest["secrets"][number]["auth"] }));
  // A Basic auth field needs its username as a (non-secret) config value.
  const config = pkg.manifest.config as { properties?: Record<string, unknown> };
  const userKeys = fields.flatMap((f) => (f.auth.as === "basic" ? [f.auth.userKey] : []));
  const properties = { ...(config.properties ?? {}), ...Object.fromEntries(userKeys.map((k) => [k, { type: "string", title: "Username", description: "The Basic auth username." }])) };
  return {
    ...pkg.manifest,
    config: { ...pkg.manifest.config, properties },
    secrets: [...pkg.manifest.secrets, ...fields],
    permissions: [...pkg.manifest.permissions, ...fields.map((f) => ({ kind: "secret" as const, key: f.key }))],
  };
}

type Prop = { type?: string; title?: string; description?: string; default?: unknown; format?: string; enum?: unknown[] };

/**
 * Which secret fields must be set for this config. A config property may carry an
 * `x-atrium-secrets` map from its value to the secret keys that value needs (Prometheus: no
 * login, Basic or bearer). Keys named in such a map are optional unless the current value lists
 * them; every other secret is required.
 */
export function requiredSecretKeys(manifest: PackageManifest, config: Record<string, unknown>): Set<string> {
  return secretKeysFor(manifest.config, config, manifest.secrets.map((s) => s.key));
}

/** Validates config against the manifest's JSON schema subset (required, string/number/boolean). Unknown keys are dropped. */
export function validateConfig(manifest: PackageManifest, input: Record<string, unknown>): { ok: true; config: Record<string, unknown> } | { ok: false; error: AdapterError } {
  const props = ((manifest.config as { properties?: Record<string, Prop> }).properties ?? {}) as Record<string, Prop>;
  const required = ((manifest.config as { required?: string[] }).required ?? []) as string[];
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(props)) {
    let v = input[key];
    if (v === undefined || v === "") v = p.default;
    if (v === undefined || v === "") {
      if (required.includes(key)) return { ok: false, error: { code: "config", message: `${p.title ?? key} is required.`, hint: p.description } };
      continue;
    }
    if (p.type === "boolean") v = v === true || v === "true" || v === "on";
    else if (p.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, error: { code: "config", message: `${p.title ?? key} must be a number.` } };
      v = n;
    } else if (p.type === "string") {
      if (typeof v !== "string") return { ok: false, error: { code: "config", message: `${p.title ?? key} must be text.` } };
      v = v.trim().slice(0, 2048);
      if (Array.isArray(p.enum) && !p.enum.includes(v)) return { ok: false, error: { code: "config", message: `${p.title ?? key} must be one of: ${p.enum.join(", ")}.` } };
      if (p.format === "uri") {
        v = withScheme(v as string);
        try {
          const u = new URL(v as string);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
          if (u.username || u.password) return { ok: false, error: { code: "config", message: "Put credentials in a secret field, not in the address." } };
        } catch {
          return { ok: false, error: { code: "config", message: `${p.title ?? key} must be a full http:// or https:// address.`, hint: p.description } };
        }
      }
    }
    out[key] = v;
  }
  return { ok: true, config: out };
}

/** Shown to an adapter as the Basic auth username when a saved credential brings its own (Amendment 2). */
export const CREDENTIAL_USER_PLACEHOLDER = "(saved credential)";

/**
 * A Basic auth field filled from a saved username and password credential takes the username from
 * the credential, which the host writes into the request. The adapter only sees a placeholder, so
 * its "username is required" check passes without the form asking for one.
 */
export function withCredentialUsers(manifest: PackageManifest, config: Record<string, unknown>, integrationId?: string, picks: Record<string, string> = {}, typed: Record<string, string> = {}): Record<string, unknown> {
  const stored = integrationId ? refsOfIntegration(integrationId).map((r) => r.secretKey).filter((k) => !typed[k]) : [];
  const keys = new Set([...Object.keys(picks), ...stored]);
  if (!keys.size) return config;
  const out = { ...config };
  for (const f of manifest.secrets) if (f.auth.as === "basic" && keys.has(f.key) && !String(out[f.auth.userKey] ?? "").trim()) out[f.auth.userKey] = CREDENTIAL_USER_PLACEHOLDER;
  return out;
}

/** The origin a saved integration's secrets belong to: its stored address, normalised like a read would. */
export function pinFor(manifest: PackageManifest, storedConfig: Record<string, unknown>): string | undefined {
  const v = validateConfig(manifest, storedConfig);
  return v.ok ? pinOriginFor(manifest, v.config) : undefined;
}

/** Custom API and declarative packages run records a person wrote, not reviewed adapter code. */
export function isUserShaped(pkg: LoadedPackage): boolean {
  return pkg.manifest.id === "custom-api" || pkg.source !== "official";
}

function context(pkg: LoadedPackage, manifest: PackageManifest, config: Record<string, unknown>, secrets: ReturnType<typeof vaultResolver>, signal: AbortSignal, onRequest?: (r: RequestRecord) => void): AdapterContext {
  return {
    config,
    http: createHostHttp({ manifest, config, secrets, signal, allowDockerSocket: env().ATRIUM_ALLOW_DOCKER_SOCKET === "true", userShaped: isUserShaped(pkg), ...(onRequest ? { onRequest } : {}) }),
    log: logger(`package.${manifest.id}`),
    signal,
    now: () => new Date(),
  };
}

function asError(err: unknown): AdapterError {
  if (err instanceof HostError) return err.adapterError;
  const e = err as { adapterError?: AdapterError };
  if (e?.adapterError?.code) return e.adapterError;
  return { code: "bad_response", message: "The check failed in an unexpected way.", hint: "Check the address and try again." };
}

export type HealthOutcome = { ok: true; health: HealthResult } | { ok: false; error: AdapterError; latencyMs: number };

/** Runs a package health check on the server. Each request has the 10 s timeout; the whole check is capped at 12 s. */
export async function runHealth(opts: {
  packageId: string;
  config: Record<string, unknown>;
  integrationId?: string;
  transientSecrets?: Record<string, string>;
  secretFields?: SecretFieldMeta[];
  customEndpoints?: CustomEndpoint[];
  pending?: { id: string; userId: string };
  /** Amendment 2: saved credentials picked for this test, already checked as usable by the caller. */
  credentialRefs?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<HealthOutcome> {
  const start = performance.now();
  const pkg = getPackage(opts.packageId);
  if (!pkg) return { ok: false, error: { code: "config", message: "That package is not installed.", hint: "Check Packages with problems on the Integrations page." }, latencyMs: 0 };
  const manifest = effectiveManifest(pkg, opts.secretFields);
  const cfg = validateConfig(manifest, opts.config);
  if (!cfg.ok) return { ok: false, error: cfg.error, latencyMs: 0 };
  if (lockedFor(opts.integrationId, manifest)) return { ok: false, error: LOCKED, latencyMs: 0 };
  const signal = AbortSignal.any([AbortSignal.timeout(12_000), ...(opts.signal ? [opts.signal] : [])]);
  try {
    // Stored secrets are pinned to the integration's saved address, never to the address under test.
    const row = opts.integrationId ? getIntegrationRow(opts.integrationId) : undefined;
    const pinOrigin = row ? pinFor(manifest, row.config) : undefined;
    const config = withCredentialUsers(manifest, cfg.config, opts.integrationId, opts.credentialRefs, opts.transientSecrets);
    const ctx = context(pkg, manifest, config, vaultResolver({ integrationId: opts.integrationId, pinOrigin, transient: opts.transientSecrets, pending: opts.pending, credentialRefs: opts.credentialRefs }), signal);
    const eps = opts.customEndpoints ?? (opts.integrationId ? listCustomEndpoints(opts.integrationId) : []);
    const health = await pkg.adapterFor(eps).health(ctx);
    return { ok: true, health };
  } catch (err) {
    return { ok: false, error: asError(err), latencyMs: Math.round(performance.now() - start) };
  }
}

export type ListedEndpoint = EndpointDef & { custom?: CustomEndpoint; recipe?: RecipeEndpoint["recipe"] };

/**
 * Every endpoint of an integration: its package's (or its own Custom API) endpoints, then the reads
 * of the recipes that apply to it (A9.1, ids r:<recipeId>:<readId>). Built-in recipe reads are
 * package endpoints and drop out when their recipe is turned off. `includeDrafts` (the live check
 * only) adds the reads of draft recipes.
 */
export function endpointsOf(row: Pick<IntegrationRow, "id" | "packageId"> & { config?: Record<string, unknown> }, opts: { includeDrafts?: boolean } = {}): ListedEndpoint[] {
  const pkg = getPackage(row.packageId);
  if (!pkg) return [];
  const like = { id: row.id, packageId: row.packageId, config: row.config ?? getIntegrationRow(row.id)?.config ?? {} };
  if (pkg.manifest.id === "custom-api") {
    const custom = listCustomEndpoints(row.id);
    const own: ListedEndpoint[] = custom.map((e) => ({
      id: e.id, label: e.label, description: e.description ?? `${e.method} ${e.path}`, shape: e.shape, defaultRefreshSec: e.refreshSec, minRefreshSec: CUSTOM_MIN_REFRESH_SEC,
      ...(e.params ? { params: e.params } : {}), ...(e.group ? { group: e.group } : {}), ...(e.advanced ? { advanced: true } : {}), custom: e,
    }));
    return [...own, ...recipeEndpoints(like, { ...opts, customIds: new Set(custom.map((e) => e.id)) })];
  }
  const off = pkg.source === "official" ? offBuiltinReads() : new Set<string>();
  const base = pkg.manifest.endpoints.filter((e) => !off.has(e.id)).map((e) => (pkg.source === "declarative" ? { ...e, minRefreshSec: Math.max(e.minRefreshSec, CUSTOM_MIN_REFRESH_SEC) } : e));
  return [...base, ...recipeEndpoints(like, opts)];
}

export function minRefreshFor(integrationId: string, endpointId: string): number {
  const row = getIntegrationRow(integrationId);
  const ep = row ? endpointsOf(row).find((e) => e.id === endpointId) : undefined;
  return ep?.minRefreshSec ?? CUSTOM_MIN_REFRESH_SEC;
}

/** True when this integration's secrets are sealed and cannot be opened (section 11), for listings (A6.1). */
export function integrationLocked(row: Pick<IntegrationRow, "id" | "packageId">): boolean {
  const pkg = getPackage(row.packageId);
  return !!pkg && lockedFor(row.id, pkg.manifest);
}

/** True when this integration has sealed secrets that cannot be opened (section 11): fail before any request. */
function lockedFor(integrationId: string | undefined, manifest: PackageManifest): boolean {
  if (!integrationId || manifest.secrets.length === 0 || !secretsLocked()) return false;
  if (refsOfIntegration(integrationId).length) return true; // fields filled from saved credentials (Amendment 2)
  return secretStatus("integration", integrationId, manifest.secrets.map((s) => s.key)).some((s) => s.set);
}

const LOCKED: AdapterError = { code: "config", message: SECRETS_LOCKED_MESSAGE, hint: "Restore ATRIUM_MASTER_KEY or the master.key file on the server, then restart Atrium." };

const fail = (error: AdapterError): ReadResult => ({ ok: false, error, fetchedAt: new Date().toISOString() });

/** Reads one endpoint of a saved integration through its adapter and the host boundary. Never cached here. */
export async function readEndpoint(integrationId: string, endpointId: string, params: unknown, signal?: AbortSignal, opts: { includeDrafts?: boolean } = {}): Promise<ReadResult> {
  const row = getIntegrationRow(integrationId);
  if (!row) return fail({ code: "config", message: "This integration no longer exists." });
  if (row.status === "disabled") return fail({ code: "config", message: "This integration is disabled.", hint: "Turn it back on in Integrations." });
  const pkg = getPackage(row.packageId);
  if (!pkg) return fail({ code: "config", message: `The package "${row.packageId}" is not installed.`, hint: "Import the package again to bring this integration back." });
  const manifest = effectiveManifest(pkg, row.secretFields);
  const rid = parseRecipeEndpointId(endpointId);
  const recipeRead = rid ? resolveRead(row, rid.recipeId, rid.readId, opts) : undefined;
  if (rid ? !recipeRead : !endpointsOf(row).some((e) => e.id === endpointId)) return fail({ code: "config", message: `This integration has no endpoint "${endpointId}".` });
  const cfg = validateConfig(manifest, row.config);
  if (!cfg.ok) return fail(cfg.error);
  if (lockedFor(row.id, manifest)) return fail(LOCKED);
  const s = AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]);
  try {
    const ctx = context(pkg, manifest, withCredentialUsers(manifest, cfg.config, row.id), vaultResolver({ integrationId: row.id, pinOrigin: pinOriginFor(manifest, cfg.config) }), s);
    if (recipeRead) {
      const p = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      const auth = isUserShaped(pkg) ? manifest.secrets[0]?.key : undefined;
      return await runRecipeRead(ctx, recipeRead, p, { packageId: pkg.manifest.id, ...(auth ? { auth } : {}) });
    }
    return await pkg.adapterFor(listCustomEndpoints(row.id)).read(ctx, endpointId, params ?? {});
  } catch (err) {
    return fail(asError(err));
  }
}

/**
 * A8.1: which endpoints of a saved integration have data on its service, from the adapter's optional
 * available() hook. Null when the package has no hook, or the check cannot run or fails (then every
 * read counts as available). Never cached here: availability.ts caches it for 5 minutes.
 */
export async function readAvailability(integrationId: string, signal?: AbortSignal): Promise<Record<string, boolean> | null> {
  const row = getIntegrationRow(integrationId);
  if (!row || row.status === "disabled") return null;
  const pkg = getPackage(row.packageId);
  if (!pkg) return null;
  const adapter = pkg.adapterFor(listCustomEndpoints(row.id));
  if (!adapter.available) return null;
  const manifest = effectiveManifest(pkg, row.secretFields);
  const cfg = validateConfig(manifest, row.config);
  if (!cfg.ok || lockedFor(row.id, manifest)) return null;
  const s = AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]);
  try {
    const ctx = context(pkg, manifest, withCredentialUsers(manifest, cfg.config, row.id), vaultResolver({ integrationId: row.id, pinOrigin: pinOriginFor(manifest, cfg.config) }), s);
    const r = await adapter.available(ctx);
    return Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === "boolean"));
  } catch {
    return null;
  }
}
