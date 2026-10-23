// Commands (architecture v3 section 3.1, amendments A1.1 and A1.4): what each integration may
// change, who may add or change commands, who may bind an integration into an app, and the
// read-only command listing. Nothing here runs a command; host/command.ts is the only entry point.
import "server-only";
import type { App, CommandDef, CommandListing, CustomCommand, Principal, ReadCheck } from "@/core/contracts";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { audit } from "@/features/audit/write";
import { dataRuntime } from "@/features/data/runtime";
import { cacheKey } from "@/features/data/keys";
import { FieldError } from "./field-error";
import { customCommandSchema } from "./manifest";
import * as repo from "./repo";
import { SECRETS_LOCKED_MESSAGE } from "./host/errors";
import { effectiveManifest, endpointsOf, getPackage, integrationLocked } from "./runtime";
import { canEdit, isOwnerOrCreator, requireManage } from "./service";
import { checksMap } from "@/features/recipes/repo";
import { builtinFrom, fromTag } from "@/features/recipes/store";
import { availabilityOf } from "./availability";
import { choicesSummary } from "./choices";

export type CommandEntry = {
  def: CommandDef;
  /** The record the generic runner sends, for declarative and Custom API commands. */
  custom?: CustomCommand;
  method?: CustomCommand["method"];
  path?: string;
};

export type PendingCommand = CommandEntry & { change: "added" | "changed" };

export const ONLY_READS = "This integration only reads";

/** A CustomCommand as the CommandDef every listing and check uses. Custom commands have no target. */
export function defOfCustom(c: CustomCommand): CommandDef {
  return { id: c.id, label: c.label, description: c.description, params: c.params, risk: c.risk };
}

function entryOfCustom(c: CustomCommand): CommandEntry {
  return { def: defOfCustom(c), custom: c, method: c.method, path: c.path };
}

/**
 * The published commands this integration may run: a code package's manifest commands that its
 * command permission lists, a declarative package's published commands.json records, or a Custom
 * API integration's published records. Drafts are never included.
 */
export function commandCatalog(row: Pick<repo.IntegrationRow, "id" | "packageId" | "secretFields">): Map<string, CommandEntry> {
  const out = new Map<string, CommandEntry>();
  const pkg = getPackage(row.packageId);
  if (!pkg) return out;
  if (pkg.manifest.id === "custom-api") {
    for (const r of repo.listCustomCommandRows(row.id)) if (r.record) out.set(r.commandId, entryOfCustom(r.record as unknown as CustomCommand));
    return out;
  }
  const manifest = effectiveManifest(pkg, row.secretFields);
  const permitted = new Set(manifest.permissions.flatMap((p) => (p.kind === "command" ? p.ids : [])));
  if (pkg.source === "declarative") {
    for (const c of pkg.declarativeCommands ?? []) if (permitted.has(c.id)) out.set(c.id, entryOfCustom(c));
    return out;
  }
  for (const c of manifest.commands ?? []) if (permitted.has(c.id)) out.set(c.id, { def: c });
  return out;
}

/** Added or changed commands waiting to be published ("This integration can change"). */
export function pendingCommands(row: Pick<repo.IntegrationRow, "id" | "packageId" | "secretFields" | "status">): PendingCommand[] {
  const pkg = getPackage(row.packageId);
  if (!pkg) return [];
  if (pkg.manifest.id === "custom-api") {
    return repo.listCustomCommandRows(row.id).filter((r) => r.draft).map((r) => ({ ...entryOfCustom(r.draft as unknown as CustomCommand), change: r.record ? "changed" : "added" }));
  }
  // An integration that is still a draft can change everything its package declares once published.
  if (row.status === "draft") return [...commandCatalog(row).values()].map((e) => ({ ...e, change: "added" as const }));
  return [];
}

/** The pending commands of a declarative package (its draft commands.json). */
export function pendingPackageCommands(packageId: string): PendingCommand[] {
  const d = repo.getDeclarativeRow(packageId);
  if (!d?.draftCommands) return [];
  const published = new Map(((d.commands ?? []) as CustomCommand[]).map((c) => [c.id, JSON.stringify(c)]));
  return (d.draftCommands as CustomCommand[]).filter((c) => published.get(c.id) !== JSON.stringify(c)).map((c) => ({ ...entryOfCustom(c), change: published.has(c.id) ? "changed" : "added" }));
}

// ---- Who may bind (section 3.1, A1.1) ----

/** Only the owner and the integration's creator may bind its commands into a control. */
export function canBindCommands(p: Principal, row: Pick<repo.IntegrationRow, "createdById">): boolean {
  if (p.kind === "guest" || p.role === "viewer") return false;
  return isOwnerOrCreator(p, row);
}

/** Reads: anyone who can edit an app when Shared is on, otherwise only the owner and the creator. */
export function canBindReads(p: Principal, row: Pick<repo.IntegrationRow, "createdById" | "shared">): boolean {
  if (p.kind === "guest" || p.role === "viewer") return false;
  return row.shared || isOwnerOrCreator(p, row);
}

export const NOT_SHARED_MESSAGE = "No data: this integration is no longer shared";

/**
 * Amendment A1.1: with Shared off, a binding keeps working only in apps that nobody but the
 * owner and the integration's creator can edit. Anyone else able to edit the app could repoint it.
 */
export function bindingAllowedInApp(app: Pick<App, "access">, row: Pick<repo.IntegrationRow, "createdById" | "shared">, owners: Set<string> = repo.ownerIds()): boolean {
  if (row.shared) return true;
  const edit = app.access.edit;
  if (edit === "owner") return true;
  if (edit === "everyone") return false;
  return edit.userIds.every((id) => owners.has(id) || id === row.createdById);
}

// ---- Listings (A1.4) ----

type TargetRow = Record<string, unknown>;
const MAX_TARGETS = 500;

/** Targets from the target endpoint's cached rows, filtered to the command's domain ("light" for light.toggle). */
function targetsFor(row: repo.IntegrationRow, def: CommandDef): { id: string; label: string }[] | undefined {
  if (!def.target) return undefined;
  const { cache } = dataRuntime();
  const domain = def.id.includes(".") ? def.id.split(".")[0]! : undefined;
  const keys = [cacheKey({ integrationId: row.id, endpointId: def.target.endpointId }), ...(domain ? [cacheKey({ integrationId: row.id, endpointId: def.target.endpointId, params: { domain } })] : [])];
  const seen = new Map<string, string>();
  for (const k of keys) {
    const data = cache.get(k)?.lastGood?.data;
    if (!data || data.kind !== "table") continue;
    for (const r of data.rows as TargetRow[]) {
      const id = r[def.target.field];
      if (typeof id !== "string" || seen.has(id)) continue;
      const rowDomain = typeof r.domain === "string" ? r.domain : id.includes(".") ? id.split(".")[0] : undefined;
      if (domain && rowDomain !== undefined && rowDomain !== domain) continue;
      const label = typeof r.name === "string" && r.name ? r.name : typeof r.label === "string" && r.label ? r.label : id;
      seen.set(id, label);
      if (seen.size >= MAX_TARGETS) break;
    }
  }
  return [...seen].map(([id, label]) => ({ id, label }));
}

/**
 * Every command the principal may bind into a control, with targets. Read only: it never runs
 * anything. Owner-only commands are offered to the owner only; guests and viewers get nothing.
 */
export function listCommands(p: Principal): CommandListing[] {
  if (p.kind === "guest" || p.role === "viewer") return [];
  const out: CommandListing[] = [];
  for (const row of repo.listIntegrationRows().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (row.status !== "active" || !canBindCommands(p, row)) continue;
    for (const e of commandCatalog(row).values()) {
      if (e.def.ownerOnly && p.role !== "owner") continue;
      const targets = targetsFor(row, e.def);
      out.push({ integrationId: row.id, integrationName: row.name, command: e.def, ...(targets ? { targets } : {}) });
    }
  }
  return out;
}

/**
 * What the builder's data picker needs about each bindable integration (A6.1): its package and health, and
 * per endpoint its description (method and path for Custom API) and parameter schema. No config or secrets.
 * Amendment 8: each endpoint also carries its group, advanced flag, needs and whether this service has
 * its data (`available`, false only when the adapter's check said so), plus a summary of its live-choice
 * params (`choices`, read through GET /api/data/choices).
 */
export type EndpointListing = {
  integrationId: string; integrationName: string; packageId: string;
  health: "ok" | "failing" | "locked" | "unknown"; healthMessage?: string;
  /** A8.1: true when the adapter's availability check answered (otherwise every endpoint shows as available). */
  availabilityChecked: boolean;
  endpoints: {
    id: string; label: string; description: string; params?: Record<string, unknown>; shape: string; defaultRefreshSec: number; minRefreshSec: number;
    group?: string; advanced?: boolean; needs?: string; available: boolean;
    choices?: { param: string; endpointId: string; every: boolean; dependsOn?: string[] }[];
    /** A9.2: the read's last live check (editors only); `available` is false when it failed. */
    check?: ReadCheck;
    /** A9.1: where a recipe read came from, as a small tag ("Node Exporter Full, from Grafana"). */
    from?: string;
  }[];
};

/** Every integration whose reads the principal may bind into an app (section 3.1). */
export async function listBindableEndpoints(p: Principal, opts: { waitMs?: number } = {}): Promise<EndpointListing[]> {
  if (p.kind === "guest" || p.role === "viewer") return [];
  const rows = repo.listIntegrationRows()
    .filter((row) => row.status === "active" && canBindReads(p, row))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return Promise.all(rows.map(async (row) => {
    const locked = integrationLocked(row);
    const h = row.lastHealth;
    const health: EndpointListing["health"] = locked ? "locked" : !h ? "unknown" : h.status === "ok" ? "ok" : "failing";
    const avail = locked ? { known: false, value: {} as Record<string, boolean> } : await availabilityOf(row.id, row.updatedAt.toISOString(), opts.waitMs);
    const checks = canEdit(p) ? checksMap(row.id) : new Map<string, ReadCheck>();
    return {
      integrationId: row.id, integrationName: row.name, packageId: row.packageId, health, availabilityChecked: avail.known,
      ...(locked ? { healthMessage: SECRETS_LOCKED_MESSAGE } : h && h.status !== "ok" && h.message ? { healthMessage: h.message } : {}),
      endpoints: endpointsOf(row).map((e) => {
        const choices = choicesSummary(e.params);
        const check = checks.get(e.id);
        return {
          id: e.id, label: e.label, description: e.description ?? "", ...(e.params ? { params: e.params as Record<string, unknown> } : {}), shape: e.shape, defaultRefreshSec: e.defaultRefreshSec, minRefreshSec: e.minRefreshSec,
          ...(e.group ? { group: e.group } : {}), ...(e.advanced ? { advanced: true } : {}), ...(e.needs ? { needs: e.needs } : {}),
          available: avail.value[e.id] !== false && check?.status !== "failed",
          ...(choices.length ? { choices } : {}),
          ...(check ? { check: { status: check.status, at: check.at, ...(check.reason ? { reason: check.reason } : {}) } } : {}),
          ...(e.recipe ? { from: fromTag(e.recipe.name, e.recipe.source) } : builtinFrom(row.packageId, e.id)),
        };
      }),
    };
  }));
}

// ---- Commands screen ----

export type CommandView = { id: string; label: string; description: string; risk: "low" | "medium"; ownerOnly: boolean; target?: { endpointId: string; field: string }; method?: string; path?: string };
export type CommandsView = { commands: CommandView[]; pending: (CommandView & { change: "added" | "changed" })[]; canChange: boolean; customCommands: boolean };

function viewOf(e: CommandEntry): CommandView {
  return { id: e.def.id, label: e.def.label, description: e.def.description, risk: e.def.risk, ownerOnly: !!e.def.ownerOnly, ...(e.def.target ? { target: e.def.target } : {}), ...(e.method ? { method: e.method } : {}), ...(e.path ? { path: e.path } : {}) };
}

export function commandsView(p: Principal, integrationId: string): CommandsView {
  if (p.kind === "guest") throw new Forbidden("Guests cannot open integrations.");
  const row = repo.getIntegrationRow(integrationId);
  if (!row) throw new NotFound("That integration does not exist.");
  const canChange = p.role !== "viewer" && isOwnerOrCreator(p, row);
  return {
    commands: [...commandCatalog(row).values()].map(viewOf),
    pending: pendingCommands(row).map((e) => ({ ...viewOf(e), change: e.change })),
    canChange,
    customCommands: row.packageId === "custom-api",
  };
}

// ---- Adding and publishing (section 3.1) ----

/**
 * Adds or changes one command on a Custom API integration. Only the owner and the integration's
 * creator may, from the app or through integrations.add_command. It always lands as a draft,
 * listed under "This integration can change" until a signed-in owner or creator publishes it.
 */
export function addCommand(p: Principal, integrationId: string, raw: unknown): CommandsView {
  const row = repo.getIntegrationRow(integrationId);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  if (p.kind === "agent" && !p.scopes.includes("atrium:edit")) throw new Forbidden("This token cannot change integrations.");
  if (row.packageId !== "custom-api") throw new AtriumError("Only Custom API integrations take their own commands. Packages declare theirs in the package.", 400, "config");
  const parsed = customCommandSchema.safeParse(raw);
  if (!parsed.success) {
    // Round 8: the message is a full sentence on its own; the field it belongs to travels separately so
    // the form can mark that field (no trailing " (at path)").
    const issue = parsed.error.issues[0]!;
    const field = typeof issue.path[0] === "string" ? issue.path[0] : undefined;
    if (field) throw new FieldError(issue.message, field);
    throw new AtriumError(issue.message, 400, "config");
  }
  const c = parsed.data as CustomCommand;
  const pkg = getPackage(row.packageId)!;
  const keys = new Set(effectiveManifest(pkg, row.secretFields).secrets.map((s) => s.key));
  if (c.auth && !keys.has(c.auth)) throw new AtriumError(`The secret "${c.auth}" is not a field of this integration.`, 400, "config");
  repo.saveCustomCommandDraft(row.id, c.id, c as unknown as Record<string, unknown>, p.userId);
  audit.write({ actor: p, event: "draft.created", target: { type: "integration", id: row.id, label: row.name }, result: "ok", detail: { command: c.id, method: c.method, path: c.path, risk: c.risk } });
  return commandsView(p, row.id);
}

/** Publishes the pending commands. Signed-in owner or creator only; agents can never publish. */
export function publishCommands(p: Principal, integrationId: string): CommandsView {
  if (p.kind !== "user") throw new Forbidden("Only a signed-in person can publish what an integration can change.");
  const row = repo.getIntegrationRow(integrationId);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  const ids = repo.publishCustomCommands(row.id, p.userId);
  if (ids.length) audit.write({ actor: p, event: "draft.published", target: { type: "integration", id: row.id, label: row.name }, result: "ok", detail: { commands: ids } });
  return commandsView(p, row.id);
}

export function discardCommands(p: Principal, integrationId: string): CommandsView {
  const row = repo.getIntegrationRow(integrationId);
  if (!row) throw new NotFound("That integration does not exist.");
  requireManage(p, row);
  repo.discardCustomCommandDrafts(row.id);
  audit.write({ actor: p, event: "draft.discarded", target: { type: "integration", id: row.id, label: row.name }, result: "ok", detail: { commands: true } });
  return commandsView(p, row.id);
}
