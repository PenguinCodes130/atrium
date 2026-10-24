// Spec import v2 on the server (recipes spec 3.3): find or read a spec, hold it for the person who
// asked, and import it into a new or existing Custom API integration as reads (CustomEndpoint
// records with settings), opted-in commands, a `spec` recipe and a live check. Owners and members
// only; agents need atrium:edit and only ever make drafts. Secret values are sealed through the
// held-secrets path, never echoed, and no response carries config or secrets.
import "server-only";
import { getServiceRow, kindFromTitle, saveServiceRow } from "../service-info";
import { randomBytes } from "node:crypto";
import type { CustomCommand, CustomEndpoint, JsonSchema, Principal, ReadCheck } from "@/core/contracts";
import { AtriumError, NotFound } from "@/core/errors";
import { forgetIntegration } from "@/features/data/runtime";
import { addCommand, publishCommands } from "../commands";
import { normalizeUrl } from "../detect";
import { HostError } from "../host/errors";
import { holdSecrets } from "../host/pending";
import { customEndpointSchema } from "../manifest";
import * as repo from "../repo";
import { canEdit, canManage, createIntegration, testConnection } from "../service";
import { fetchSpec, findSpec } from "./fetch";
import { importSpec, toEndpoint, type CommandCandidate, type SpecImport, type SpecRead } from "./import";
import { parseSpecText, SPEC_MAX_BYTES, SpecError, type SpecDoc } from "./load";
import { specRecipe } from "./recipe";
import { recipeHooks } from "./recipe-hooks";

const HOLD_MS = 30 * 60_000;
type Held = { userId: string; doc: SpecDoc; specUrl?: string; expiresAt: number };
const g = globalThis as unknown as { __atriumHeldSpecs?: Map<string, Held> };
const held = (g.__atriumHeldSpecs ??= new Map());

function sweep() {
  const now = Date.now();
  for (const [k, v] of held) if (v.expiresAt < now) held.delete(k);
}

/** Viewers, guests and agents without atrium:edit get not found: the import routes do not exist for them. */
export function requireImporter(p: Principal): asserts p is Exclude<Principal, { kind: "guest" }> {
  if (!canEdit(p)) throw new NotFound("Not found.");
}

export type SpecSource = { address?: string; specUrl?: string; text?: string };

/** What the import screen shows: words and counts only, never a secret or a config value. */
export type SpecPreview = {
  specId: string;
  specUrl?: string;
  title: string; version: string; specVersion: string; basePath: string;
  totals: SpecImport["totals"] & { commands: number; skipped: number };
  reads: { id: string; label: string; description?: string; group: string; headline: boolean; shape: string; path: string; settings: { key: string; title: string; required: boolean; choices: boolean }[]; formats: string[] }[];
  commands: { id: string; label: string; description: string; method: string; path: string; canAdd: boolean; why?: string }[];
  auth: { key: string; scheme: string; label: string; hint: string; as: string; name?: string; needsUser?: boolean }[];
  unsupportedAuth: string[];
  skipped: { method: string; path: string; reason: string }[];
};

function settingsOf(r: SpecRead): SpecPreview["reads"][number]["settings"] {
  const props = ((r.params as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const req = ((r.params as { required?: string[] } | undefined)?.required ?? []) as string[];
  return Object.entries(props).map(([key, p]) => ({ key, title: String(p.title ?? key), required: req.includes(key), choices: !!p["x-atrium-choices"] || Array.isArray(p.enum) }));
}

export function previewOf(specId: string, imp: SpecImport, specUrl?: string): SpecPreview {
  return {
    specId,
    ...(specUrl ? { specUrl } : {}),
    title: imp.title, version: imp.version, specVersion: imp.specVersion, basePath: imp.basePath,
    totals: { ...imp.totals, commands: imp.commands.length, skipped: imp.skipped.length },
    reads: imp.reads.map((r) => ({
      id: r.id, label: r.label, ...(r.description ? { description: r.description } : {}), group: r.group ?? "Other", headline: r.headline, shape: r.shape, path: r.source.path,
      settings: settingsOf(r),
      formats: [...new Set([...(r.format ? [r.format] : []), ...Object.values(r.columnFormats ?? {})])],
    })),
    commands: imp.commands.map((c) => ({ id: c.id, label: c.label, description: c.description, method: c.method, path: c.path, canAdd: c.canAdd, ...(c.why ? { why: c.why } : {}) })),
    auth: imp.auth.map((a) => ({ key: a.key, scheme: a.scheme, label: a.label, hint: a.hint, as: a.auth.as, ...("name" in a.auth ? { name: a.auth.name } : {}), ...(a.needsUser ? { needsUser: true } : {}) })),
    unsupportedAuth: imp.unsupportedAuth,
    skipped: imp.skipped.slice(0, 500),
  };
}

function hold(userId: string, doc: SpecDoc, specUrl?: string): string {
  sweep();
  const id = `sp_${randomBytes(18).toString("base64url")}`;
  held.set(id, { userId, doc, ...(specUrl ? { specUrl } : {}), expiresAt: Date.now() + HOLD_MS });
  return id;
}

function heldSpec(id: string, userId: string): Held {
  sweep();
  const h = held.get(id);
  if (!h || h.userId !== userId) throw new AtriumError("The spec is no longer held. Read it again.", 400, "spec_expired");
  return h;
}

/** Reads a spec from pasted text, a spec URL, or by probing the service address, and holds it for 30 minutes. */
export async function previewSpec(p: Principal, src: SpecSource, signal?: AbortSignal): Promise<SpecPreview> {
  requireImporter(p);
  let doc: SpecDoc;
  let specUrl: string | undefined;
  try {
    if (src.text !== undefined) {
      if (Buffer.byteLength(src.text, "utf8") > SPEC_MAX_BYTES) throw new SpecError("This spec is larger than 10 MB, the most Atrium reads.");
      doc = parseSpecText(src.text);
    } else if (src.specUrl) {
      const r = await fetchSpec(normalizeUrl(src.specUrl), { ...(signal ? { signal } : {}), ...(src.address ? { sameOriginAs: normalizeUrl(src.address).toString() } : {}) });
      doc = r.doc;
      specUrl = r.url;
    } else if (src.address) {
      const r = await findSpec(normalizeUrl(src.address), signal);
      if (!r) throw new SpecError("No API spec was found at this address.", "Paste the spec's own address, or upload the file.");
      doc = r.doc;
      specUrl = r.url;
    } else throw new SpecError("Paste a spec address or choose a spec file.");
  } catch (err) {
    if (err instanceof SpecError) throw new AtriumError(err.message + (err.hint ? ` ${err.hint}` : ""), 400, "spec_invalid");
    if (err instanceof HostError) throw new AtriumError(err.adapterError.message + (err.adapterError.hint ? ` ${err.adapterError.hint}` : ""), 400, `spec_${err.adapterError.code}`);
    throw err;
  }
  const imp = importSpec(doc);
  if (!imp.reads.length && !imp.commands.length) throw new AtriumError("This spec has no calls Atrium can read.", 400, "spec_empty");
  return previewOf(hold(p.userId, doc, specUrl), imp, specUrl);
}

export type ImportInput = {
  specId: string;
  /** A new integration: its name and address. */
  name?: string; baseUrl?: string; verifyTls?: boolean;
  /** Or an existing Custom API integration to add the reads to. */
  integrationId?: string;
  /** Which auth option the reads use; null for none. */
  authKey?: string | null;
  secret?: string; basicUser?: string;
  readIds?: string[];
  commands?: { id: string; risk: "low" | "medium" }[];
  untested?: boolean;
};

export type ImportOutcome =
  | { ok: false; heading: string; error: { code: string; message: string; hint?: string } }
  | { ok: true; integrationId: string; added: number; skipped: { id: string; reason: string }[]; commands: { added: string[]; drafts: boolean }; recipe?: { id: string; saved: boolean; problem?: string }; check: { running: boolean; total: number; results?: Record<string, ReadCheck> } };

function chosenAuth(imp: SpecImport, key: string | null | undefined) {
  return key === null ? undefined : imp.auth.find((a) => a.key === key) ?? imp.auth[0];
}

/** Drops choices that point at reads not being imported, so a dropdown never names a missing list. */
function keepChoices(e: CustomEndpoint, kept: Set<string>): CustomEndpoint {
  if (!e.params) return e;
  const props = { ...((e.params as { properties?: Record<string, Record<string, unknown>> }).properties ?? {}) };
  let changed = false;
  for (const [k, p] of Object.entries(props)) {
    const c = p["x-atrium-choices"] as { endpointId?: string } | undefined;
    if (c?.endpointId && !kept.has(c.endpointId)) { const { ["x-atrium-choices"]: _x, ...rest } = p; void _x; props[k] = rest; changed = true; }
  }
  return changed ? { ...e, params: { ...(e.params as object), properties: props } as JsonSchema } : e;
}

function commandOf(c: CommandCandidate, risk: "low" | "medium"): CustomCommand {
  return { id: c.id, label: c.label, description: c.description, method: c.method, path: c.path, ...(c.auth ? { auth: c.auth } : {}), ...(c.body !== undefined ? { body: c.body } : {}), params: c.params, risk };
}

/** Imports a held spec. A new integration is tested first (unless `untested`), like any other. */
export async function importHeldSpec(p: Principal, input: ImportInput, lock: Parameters<typeof createIntegration>[2] = {}): Promise<ImportOutcome> {
  requireImporter(p);
  const h = heldSpec(input.specId, p.userId);
  const imp = importSpec(h.doc, { authKey: input.authKey ?? undefined });
  const auth = chosenAuth(imp, input.authKey);
  if (input.authKey === null) for (const r of imp.reads) delete r.auth;
  const wanted = input.readIds ? new Set(input.readIds) : undefined;
  const reads = imp.reads.filter((r) => !wanted || wanted.has(r.id));
  if (!reads.length) throw new AtriumError("Pick at least one read to import.", 400, "config");
  const kept = new Set(reads.map((r) => r.id));
  let integrationId: string;
  if (input.integrationId) {
    const row = repo.getIntegrationRow(input.integrationId);
    if (!row || !canEdit(p)) throw new NotFound("That integration does not exist.");
    if (!canManage(p, row)) throw new AtriumError("Only the owner or the person who added this integration can change it.", 403, "forbidden");
    if (row.packageId !== "custom-api") throw new AtriumError("Only a Custom API integration can take reads from a spec.", 400, "config");
    if (p.kind !== "user" && row.status !== "draft") throw new AtriumError("Agents can only add reads to draft integrations.", 403, "forbidden");
    if (auth && !row.secretFields.some((f) => f.key === auth.key)) {
      // Existing integrations keep their own secret fields; reads that need the spec's auth use it only when it is there.
      for (const r of reads) delete r.auth;
    }
    repo.updateIntegration(row.id, { config: { ...row.config, specTitle: imp.title } });
    integrationId = row.id;
  } else {
    if (!input.name || !input.baseUrl) throw new AtriumError("Give the integration a name and an address.", 400, "config");
    const base = normalizeUrl(input.baseUrl);
    const config: Record<string, unknown> = { baseUrl: base.toString().replace(/\/$/, ""), verifyTls: input.verifyTls ?? true, specTitle: imp.title };
    let pendingId: string | undefined;
    if (auth && input.secret && p.kind === "user") {
      pendingId = holdSecrets(p.userId, base.origin, [{ key: auth.key, label: auth.label, hint: auth.hint, auth: auth.auth, value: input.secret }]);
      if (auth.auth.as === "basic") config[auth.auth.userKey] = input.basicUser ?? "";
    } else if (auth && p.kind === "user" && !input.secret) {
      for (const r of reads) delete r.auth; // no secret given: read without one
    }
    if (p.kind !== "user") for (const r of reads) delete r.auth;
    let passId: string | undefined;
    if (p.kind === "user" && !input.untested) {
      const probe = reads.find((r) => !((r.params as { required?: string[] } | undefined)?.required ?? []).length);
      const t = await testConnection(p, { packageId: "custom-api", config, secrets: {}, ...(pendingId ? { pendingId } : {}), ...(probe ? { customEndpoints: [toEndpoint(probe)] } : {}) });
      if (!t.ok) return { ok: false, heading: t.heading, error: t.error };
      passId = t.passId;
    }
    const view = createIntegration(p, { packageId: "custom-api", name: input.name, config, secrets: {}, ...(pendingId ? { pendingId } : {}), ...(passId ? { passId } : {}), ...(input.untested || p.kind !== "user" ? { untested: true } : {}) }, lock);
    integrationId = view.id;
  }
  const skipped: { id: string; reason: string }[] = [];
  let added = 0;
  for (const r of reads) {
    const e = keepChoices(toEndpoint(r), kept);
    const parsed = customEndpointSchema.safeParse(e);
    if (!parsed.success) { skipped.push({ id: r.id, reason: parsed.error.issues[0]?.message ?? "not valid" }); continue; }
    repo.upsertCustomEndpoint(integrationId, parsed.data as CustomEndpoint);
    added++;
  }
  // A10.5: the service's kind from the spec title, and its top 4 stat-shaped headline reads as its
  // headline stats (unless the owner already picked some).
  const savedIds = new Set(reads.filter((r) => !skipped.some((x) => x.id === r.id)).map((r) => r.id));
  const prevService = getServiceRow(integrationId);
  const headline = reads
    .filter((r) => savedIds.has(r.id) && r.headline && r.shape === "stat" && !((r.params as { required?: string[] } | undefined)?.required ?? []).length)
    .slice(0, 4)
    .map((r) => ({ label: r.label.slice(0, 60), endpointId: r.id, value: "value", ...(r.format ? { format: r.format } : {}) }));
  saveServiceRow(integrationId, { ...(prevService?.kind ? {} : { kind: kindFromTitle(imp.title) }), ...(prevService?.headline?.length || !headline.length ? {} : { headline }) });
  // Changes the service can make: only the ones the owner picked, each with the risk they set.
  const addedCommands: string[] = [];
  for (const pick of input.commands ?? []) {
    const c = imp.commands.find((x) => x.id === pick.id);
    if (!c) throw new AtriumError(`The spec has no change "${pick.id}".`, 400, "config");
    if (!c.canAdd) throw new AtriumError(`"${c.label}" cannot be added automatically: ${c.why ?? "add it by hand"}`, 400, "config");
    addCommand(p, integrationId, commandOf(c, pick.risk));
    addedCommands.push(c.id);
  }
  if (addedCommands.length && p.kind === "user") publishCommands(p, integrationId);
  forgetIntegration(integrationId);
  // The recipe for sharing, then the live check.
  const hooks = await recipeHooks();
  let recipe: Extract<ImportOutcome, { ok: true }>["recipe"];
  const rec = specRecipe({ ...imp, reads: reads.filter((r) => !skipped.some((s) => s.id === r.id)) }, { author: p.kind === "user" ? "Atrium spec import" : "Atrium spec import (agent)" });
  if (hooks?.saveRecipe) {
    try {
      const saved = await hooks.saveRecipe(p, rec, { status: "active", integrationId });
      recipe = { id: saved.id, saved: true };
    } catch (err) {
      recipe = { id: rec.id, saved: false, problem: err instanceof Error ? err.message.slice(0, 300) : "not saved" };
    }
  } else recipe = { id: rec.id, saved: false, problem: "Recipes are not available on this Atrium yet." };
  const ids = reads.map((r) => r.id).filter((id) => !skipped.some((s) => s.id === id));
  let check: Extract<ImportOutcome, { ok: true }>["check"] = { running: false, total: 0 };
  const row = repo.getIntegrationRow(integrationId);
  if (hooks?.checkReads && row?.status === "active") {
    const run = hooks.checkReads(integrationId, ids);
    // Small imports wait for their check; big ones report progress on the integration page.
    if (ids.length <= 40) {
      const results = await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
      check = results ? { running: false, total: ids.length, results } : { running: true, total: ids.length };
    } else {
      run.catch(() => {});
      check = { running: true, total: ids.length };
    }
  }
  return { ok: true, integrationId, added, skipped, commands: { added: addedCommands, drafts: p.kind !== "user" }, recipe, check };
}
