// Saved credentials (architecture v3 Amendment 2): save one on its own, use it from integrations,
// rotate it in one place. Only the creator and the owner of this Atrium may see, use, rotate or
// delete a credential; other members never learn it exists. Values only flow inward (seal), and
// are opened only by the integrations host at send time (host/credentials.ts).
import "server-only";
import { z } from "zod";
import type { AuthPlacement, Credential, CredentialKind, Principal } from "@/core/contracts";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { removeSecrets, seal, secretStatus, vaultStatus } from "@/features/vault";
import { forgetIntegration } from "@/features/data/runtime";
import { audit } from "@/features/audit/write";
import { SECRETS_LOCKED_MESSAGE } from "../host/errors";
import { CREDENTIAL_KINDS, KIND_FIELDS, KIND_LABELS, kindForPlacement, NAME_MAX, normaliseOrigin } from "./kinds";
import * as repo from "./repo";
import { withScheme } from "../address-input";
import { getIntegrationRow } from "../repo";
import { effectiveManifest, getPackage, pinFor } from "../runtime";

type Account = Exclude<Principal, { kind: "guest" }>;

export const NO_CREDENTIAL_ROLE_MESSAGE = "Your role can view integrations but not save credentials.";

function requireAccount(p: Principal): asserts p is Account {
  if (p.kind === "guest") throw new Forbidden("Guests cannot open integrations.");
}

/** Saving, rotating and deleting happen on the Credentials view, signed in. Agents never can. */
function requireSaver(p: Principal): asserts p is Extract<Principal, { kind: "user" }> {
  requireAccount(p);
  if (p.kind !== "user") throw new Forbidden("Only a signed-in person can save, rotate or delete a credential, on the Credentials view.");
  if (p.role === "viewer") throw new Forbidden(NO_CREDENTIAL_ROLE_MESSAGE);
}

/** The creator and the owner of this Atrium (Amendment 2, "Who"). */
export function canUseCredential(p: Principal, row: Pick<repo.CredentialRow, "createdById">): boolean {
  return p.kind !== "guest" && (p.role === "owner" || row.createdById === p.userId);
}

function requireVaultReady() {
  if (vaultStatus().state === "locked") throw new AtriumError(SECRETS_LOCKED_MESSAGE, 503, "secrets_locked");
}

// ---- Views ----
/** `usedAt`: the server each integration using it points at, so the remove confirm names only those on it. */
export type CredentialView = Credential & { locked: boolean; usedAt: { integrationId: string; origin: string | null }[] };

function originOfIntegration(id: string): string | null {
  const row = getIntegrationRow(id);
  const pkg = row ? getPackage(row.packageId) : undefined;
  if (!row || !pkg) return null;
  return pinFor(effectiveManifest(pkg, row.secretFields), row.config) ?? null;
}

export function toCredential(row: repo.CredentialRow): CredentialView {
  const status = secretStatus("credential", row.id, KIND_FIELDS[row.kind].map((f) => f.key));
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    fields: status,
    lockedOrigins: row.lockedOrigins,
    createdBy: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
    usedBy: repo.usersOf(row.id),
    usedAt: repo.usersOf(row.id).map((u) => ({ integrationId: u.integrationId, origin: originOfIntegration(u.integrationId) })),
    locked: vaultStatus().state === "locked" && status.some((s) => s.set),
  };
}

/** Credentials the principal may see and use, oldest first. Other members' are simply absent. */
export function listCredentials(p: Principal): CredentialView[] {
  requireAccount(p);
  return repo.listCredentialRows().filter((r) => canUseCredential(p, r)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(toCredential);
}

/** One credential, or NotFound when it does not exist or the principal may not use it (same answer). */
export function usableCredential(p: Principal, id: string): repo.CredentialRow {
  requireAccount(p);
  const row = repo.getCredentialRow(id);
  if (!row || !canUseCredential(p, row)) throw new NotFound("That saved credential does not exist.");
  return row;
}

/** The name and lock of a credential, when this principal may see it; otherwise nothing at all. */
export function credentialLabel(p: Principal | undefined, id: string): { id: string; name: string; kind: CredentialKind; lockedOrigins: string[] } | undefined {
  if (!p) return undefined;
  const row = repo.getCredentialRow(id);
  if (!row || !canUseCredential(p, row)) return undefined;
  return { id: row.id, name: row.name, kind: row.kind, lockedOrigins: row.lockedOrigins };
}

/** Whether every value field of a credential is set (a field filled from it counts as set). */
export function credentialComplete(id: string): boolean {
  const row = repo.getCredentialRow(id);
  if (!row) return false;
  return secretStatus("credential", row.id, KIND_FIELDS[row.kind].map((f) => f.key)).every((s) => s.set);
}

// ---- Save, rotate, delete ----
export const createCredentialInput = z.object({
  name: z.string().max(200).default(""),
  kind: z.enum(CREDENTIAL_KINDS as [CredentialKind, ...CredentialKind[]]),
  values: z.record(z.string(), z.string().max(8192)).default({}),
  server: z.string().max(2048).optional(),
});

export function createCredential(p: Principal, input: z.infer<typeof createCredentialInput>): CredentialView {
  requireSaver(p);
  const name = input.name.trim();
  if (!name) throw new AtriumError("Name: give the credential a name.", 400, "name");
  if (name.length > NAME_MAX) throw new AtriumError(`Name: use at most ${NAME_MAX} characters.`, 400, "name");
  if (repo.nameTaken(p.userId, name)) throw new AtriumError(`Name: you already have a credential called "${name}".`, 409, "name");
  const fields = KIND_FIELDS[input.kind];
  for (const f of fields) if (!input.values[f.key]?.trim()) throw new AtriumError(`${f.label}: enter a value.`, 400, f.key);
  let lockedOrigins: string[] = [];
  if (input.server?.trim()) {
    // A bare LAN address (10.0.0.7:9090) gets http:// in front, like every URL field (Fix List r2 item 11).
    const origin = normaliseOrigin(withScheme(input.server));
    if (!origin) throw new AtriumError("Server: use a full http:// or https:// address, for example https://ha.local:8123.", 400, "server");
    lockedOrigins = [origin];
  }
  requireVaultReady();
  const row = repo.insertCredential({ name, kind: input.kind, lockedOrigins, createdById: p.userId });
  try {
    for (const f of fields) seal({ ownerType: "credential", ownerId: row.id, key: f.key }, input.values[f.key]!.trim());
  } catch (err) {
    removeSecrets("credential", row.id);
    repo.deleteCredentialRow(row.id);
    throw err;
  }
  audit.write({ actor: p, event: "credential.created", target: { type: "credential", id: row.id, label: name }, result: "ok", detail: { credential: name, kind: input.kind, server: lockedOrigins[0] ?? null } });
  return toCredential(repo.getCredentialRow(row.id)!);
}

export const rotateCredentialInput = z.object({ values: z.record(z.string(), z.string().max(8192)).default({}) });

/** New values for some or all fields (blank keeps a field). Every integration using it switches at once. */
export function rotateCredential(p: Principal, id: string, input: z.infer<typeof rotateCredentialInput>): CredentialView {
  requireSaver(p);
  const row = usableCredential(p, id);
  const changed = KIND_FIELDS[row.kind].filter((f) => input.values[f.key]?.trim());
  if (!changed.length) throw new AtriumError("Enter at least one new value. Blank fields keep their value.", 400, "values");
  requireVaultReady();
  for (const f of changed) seal({ ownerType: "credential", ownerId: row.id, key: f.key }, input.values[f.key]!.trim());
  repo.touchCredential(row.id, { updatedAt: new Date() });
  // Rotation: drop every user's cached values so the next read sends the new value.
  for (const u of repo.usersOf(row.id)) forgetIntegration(u.integrationId);
  audit.write({ actor: p, event: "credential.updated", target: { type: "credential", id: row.id, label: row.name }, result: "ok", detail: { credential: row.name, changedFields: changed.map((f) => f.label) } });
  return toCredential(repo.getCredentialRow(row.id)!);
}

// ---- Fix List r2 item 4: rename, and remove a server from the lock list ----
export const updateCredentialInput = z.object({
  name: z.string().max(200).optional(),
  /** Servers to take off the lock list; each must be on it. */
  removeOrigins: z.array(z.string().max(2048)).max(50).optional(),
});

/** Raised when a server would be removed from a credential without a fresh step-up. */
export class RemoveStepUpNeeded extends AtriumError {
  constructor() {
    super("Confirm it is you to remove a server from a saved credential.", 403, "step_up_required");
  }
}

/**
 * Renames a credential and/or removes servers from its lock list. The creator or the owner, signed
 * in. Removing a server always needs a step-up in the last 10 minutes, whether or not integrations
 * use the credential now (Fix List r3 item 1: otherwise deleting its integrations first made the
 * removal free, and an emptied lock list made the next server a free "first use"); an
 * integration that points at a removed server then fails its reads with the permission error until
 * someone allows the server again on its connection form. Audited as credential.updated.
 */
export function updateCredential(p: Principal, id: string, input: z.infer<typeof updateCredentialInput>, lock: Pick<LockOptions, "stepUpFresh"> = {}): CredentialView {
  requireSaver(p);
  const row = usableCredential(p, id);
  const detail: Record<string, unknown> = { credential: row.name };
  const patch: Parameters<typeof repo.touchCredential>[1] = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new AtriumError("Name: give the credential a name.", 400, "name");
    if (name.length > NAME_MAX) throw new AtriumError(`Name: use at most ${NAME_MAX} characters.`, 400, "name");
    if (name !== row.name) {
      // Names are unique per creator (spec v3 gap 5), so the check is on the creator's names.
      if (repo.nameTaken(row.createdById, name, row.id)) throw new AtriumError(`Name: there is already a credential called "${name}".`, 409, "name");
      patch.name = name;
      patch.nameKey = name.toLowerCase();
      detail.renamedFrom = row.name;
      detail.credential = name;
    }
  }
  let removed: string[] = [];
  if (input.removeOrigins?.length) {
    const wanted = new Set<string>();
    for (const raw of input.removeOrigins) {
      const o = normaliseOrigin(withScheme(raw));
      if (!o || !row.lockedOrigins.includes(o)) throw new AtriumError(`Server: ${row.name} is not locked to ${raw}.`, 400, "server");
      wanted.add(o);
    }
    removed = [...wanted];
    if (!lock.stepUpFresh) throw new RemoveStepUpNeeded();
    patch.lockedOrigins = row.lockedOrigins.filter((o) => !wanted.has(o));
    detail.removedOrigins = removed;
    detail.origin = removed[0];
  }
  if (!patch.name && !patch.lockedOrigins) return toCredential(row);
  patch.updatedAt = new Date();
  repo.touchCredential(row.id, patch);
  // Integrations on a removed server must not keep serving cached values read with it.
  if (removed.length) for (const u of repo.usersOf(row.id)) forgetIntegration(u.integrationId);
  audit.write({ actor: p, event: "credential.updated", target: { type: "credential", id: row.id, label: patch.name ?? row.name }, result: "ok", detail });
  return toCredential(repo.getCredentialRow(row.id)!);
}

export class CredentialInUse extends AtriumError {
  constructor(readonly name: string, readonly users: { integrationId: string; name: string }[]) {
    super(`${name} is used by ${users.map((u) => u.name).join(", ")}. Switch them to another credential first.`, 409, "credential_in_use");
  }
}

export function deleteCredential(p: Principal, id: string): void {
  requireSaver(p);
  const row = usableCredential(p, id);
  const users = repo.usersOf(row.id);
  if (users.length) throw new CredentialInUse(row.name, users);
  repo.deleteCredentialRow(row.id);
  removeSecrets("credential", row.id);
  audit.write({ actor: p, event: "credential.deleted", target: { type: "credential", id: row.id, label: row.name }, result: "ok", detail: { credential: row.name } });
}

// ---- Using a credential from an integration's secret field ----
type FieldLike = { key: string; label: string; auth: AuthPlacement | { as: string } };

/**
 * Checks a picked credential for one secret field: it must exist, be usable by the principal and be
 * of the field's kind. Unknown, unusable and wrong-kind answer with the same message, naming the field.
 */
export function checkPick(p: Principal, field: FieldLike, credentialId: string): repo.CredentialRow {
  const want = kindForPlacement(field.auth);
  const row = repo.getCredentialRow(credentialId);
  if (!want || !row || !canUseCredential(p, row) || row.kind !== want) {
    throw new AtriumError(`${field.label}: pick a saved ${want ? KIND_LABELS[want].toLowerCase() : "credential"} you can use. That one does not fit this field.`, 400, "credential_pick");
  }
  return row;
}

// ---- Locking (Amendment 2, "Locking") ----
export type LockNeed = { credentialId: string; name: string; lockedOrigins: string[]; origin: string; firstUse: boolean };
/** What a credential.locked entry names besides the origin: the integration saved, or a test. */
export type LockReason = { id: string; name: string } | { test: true; integration?: { id: string; name: string } | undefined };

/** What saving at `origin` would add to the lock lists of these credentials. */
export function locksNeeded(credentialIds: string[], origin: string | undefined): LockNeed[] {
  const out: LockNeed[] = [];
  for (const id of new Set(credentialIds)) {
    const row = repo.getCredentialRow(id);
    if (!row) throw new AtriumError("A saved credential this integration uses was deleted. Pick another one.", 400, "credential_pick");
    if (!origin || !/^https?:\/\//.test(origin)) throw new AtriumError(`A saved credential needs an http or https address; "${row.name}" cannot be used here.`, 400, "credential_pick");
    if (row.lockedOrigins.includes(origin)) continue;
    out.push({ credentialId: row.id, name: row.name, lockedOrigins: row.lockedOrigins, origin, firstUse: row.lockedOrigins.length === 0 });
  }
  return out;
}

export class OriginConfirmNeeded extends AtriumError {
  constructor(readonly needs: LockNeed[]) {
    const n = needs[0]!;
    super(n.lockedOrigins.length ? `Also allow ${n.name} on ${n.origin}? It is locked to ${n.lockedOrigins.join(", ")}.` : `Lock ${n.name} to ${n.origin}? It is not locked to any server yet.`, 409, "credential_origin_confirm");
  }
}

/** Raised when a new server was confirmed but the session has no step-up in the last 10 minutes. */
export class OriginStepUpNeeded extends AtriumError {
  constructor() {
    super("Confirm it is you to allow this credential on another server.", 403, "step_up_required");
  }
}

export type LockOptions = { confirmOrigins?: boolean | undefined; stepUpFresh?: boolean | undefined };

/**
 * Throws unless every needed lock may be added now. Nothing is changed. Fix List r3 item 1: every
 * server added to a lock list, the first one included, needs the explicit confirm and a step-up in
 * the last 10 minutes, so a credential value never reaches a new origin on the session alone. (A
 * server typed when the credential is saved is on the list from the start and needs neither.)
 */
export function guardLocks(p: Principal, needs: LockNeed[], opts: LockOptions): void {
  if (!needs.length) return;
  if (p.kind !== "user") throw new Forbidden("Only a signed-in person can lock a saved credential to a server, when saving the integration.");
  if (!opts.confirmOrigins) throw new OriginConfirmNeeded(needs);
  if (!opts.stepUpFresh) throw new OriginStepUpNeeded();
}

/** Adds the origins (after guardLocks) and audits each as credential.locked, before anything is sent. */
export function applyLocks(p: Principal, needs: LockNeed[], reason: LockReason): void {
  const where = "test" in reason
    ? { via: "test", ...(reason.integration ? { integrationId: reason.integration.id, integration: reason.integration.name } : {}) }
    : { integrationId: reason.id, integration: reason.name };
  for (const n of needs) {
    const row = repo.getCredentialRow(n.credentialId);
    if (!row || row.lockedOrigins.includes(n.origin)) continue;
    repo.touchCredential(row.id, { lockedOrigins: [...row.lockedOrigins, n.origin], updatedAt: new Date() });
    audit.write({
      actor: p,
      event: "credential.locked",
      target: { type: "credential", id: row.id, label: row.name },
      result: "ok",
      detail: { credential: row.name, origin: n.origin, ...where, firstUse: n.firstUse },
    });
  }
}
