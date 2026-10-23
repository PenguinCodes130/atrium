// host.command() (architecture v3 section 3.1): the only way any command runs. It checks the
// package's command permission (the published catalog), validates params against the command's
// schema, runs the adapter (or the generic runner for declarative and Custom API commands) with
// the same secret, host, redirect and address rules as reads, then invalidates the integration's
// cached values and refreshes its active keys at once. PUT, PATCH and DELETE can leave the server
// only from here. Results never contain a secret: errors are AdapterErrors, which are plain text.
import "server-only";
import type { AdapterContext, AdapterError, CommandResult } from "@/core/contracts";
import { env } from "@/core/env";
import { logger } from "@/core/log";
import { secretStatus } from "@/features/vault";
import { refreshIntegrationNow } from "@/features/data/runtime";
import { runCustomCommand } from "@/packages/declarative/runner";
import { commandCatalog } from "../commands";
import { validateParams } from "../params";
import { getIntegrationRow, listCustomEndpoints } from "../repo";
import { effectiveManifest, getPackage, isUserShaped, validateConfig, withCredentialUsers } from "../runtime";
import { refsOfIntegration } from "../credentials/repo";
import { HostError, SECRETS_LOCKED_MESSAGE } from "./errors";
import { createHostHttp, pinOriginFor, type RequestRecord } from "./http";
import { secretsLocked, vaultResolver } from "./secrets";

const log = logger("integrations.command");

/** The whole command, every request and redirect included, is capped at 12 s; each request has the 10 s timeout. */
export const COMMAND_DEADLINE_MS = 12_000;

export type HostCommandOptions = {
  signal?: AbortSignal;
  /** Test hook: sees each request after the checks pass, before it is sent. */
  onRequest?: (r: RequestRecord) => void;
};

const now = () => new Date().toISOString();
const fail = (error: AdapterError): CommandResult => ({ ok: false, error, at: now() });

export async function hostCommand(integrationId: string, commandId: string, params: unknown, opts: HostCommandOptions = {}): Promise<CommandResult> {
  const row = getIntegrationRow(integrationId);
  if (!row) return fail({ code: "config", message: "This integration no longer exists." });
  if (row.status !== "active") return fail({ code: "config", message: row.status === "draft" ? "This integration is still a draft." : "This integration is disabled.", hint: "Publish or turn it back on in Integrations." });
  const pkg = getPackage(row.packageId);
  if (!pkg) return fail({ code: "config", message: `The package "${row.packageId}" is not installed.` });
  // 1. The command permission: only published, permitted commands are in the catalog.
  const entry = commandCatalog(row).get(commandId);
  if (!entry) return fail({ code: "permission", message: `This integration is not allowed to run "${commandId}".`, hint: "Only commands its package declares and permits, and that are published, can run." });
  // 2. Params against the schema, before anything else sees them.
  const checked = validateParams(entry.def.params, params);
  if (!checked.ok) return fail({ code: "config", message: `Invalid parameter ${checked.param}: ${checked.message}`, hint: "Fix the control's parameters in the builder." });
  const manifest = effectiveManifest(pkg, row.secretFields);
  const cfg = validateConfig(manifest, row.config);
  if (!cfg.ok) return fail(cfg.error);
  if (manifest.secrets.length && secretsLocked() && (refsOfIntegration(row.id).length > 0 || secretStatus("integration", row.id, manifest.secrets.map((s) => s.key)).some((s) => s.set))) {
    return fail({ code: "config", message: SECRETS_LOCKED_MESSAGE, hint: "Restore ATRIUM_MASTER_KEY or the master.key file on the server, then restart Atrium." });
  }
  const adapter = pkg.adapterFor(listCustomEndpoints(row.id));
  if (!entry.custom && !adapter.command) return fail({ code: "permission", message: "This package has no command runner." });
  const signal = AbortSignal.any([AbortSignal.timeout(COMMAND_DEADLINE_MS), ...(opts.signal ? [opts.signal] : [])]);
  const config = withCredentialUsers(manifest, cfg.config, row.id);
  const ctx: AdapterContext = {
    config,
    http: createHostHttp({
      manifest,
      config,
      secrets: vaultResolver({ integrationId: row.id, pinOrigin: pinOriginFor(manifest, cfg.config) }),
      signal,
      allowDockerSocket: env().ATRIUM_ALLOW_DOCKER_SOCKET === "true",
      userShaped: isUserShaped(pkg),
      mode: "command",
      ...(opts.onRequest ? { onRequest: opts.onRequest } : {}),
    }),
    log: logger(`package.${manifest.id}`),
    signal,
    now: () => new Date(),
  };
  let result: CommandResult;
  try {
    result = entry.custom ? await runCustomCommand(ctx, entry.custom, checked.value) : await adapter.command!(ctx, commandId, checked.value);
  } catch (err) {
    result = fail(err instanceof HostError ? err.adapterError : (err as { adapterError?: AdapterError })?.adapterError ?? { code: "bad_response", message: "The command failed in an unexpected way." });
  }
  // 4. Whatever the outcome, the remote state may have changed: refresh every open page at once.
  refreshIntegrationNow(row.id);
  log.info("command run", { integrationId: row.id, commandId, ok: result.ok, ...(result.ok ? {} : { code: result.error.code }) });
  return result;
}
