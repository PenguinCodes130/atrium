// The component library store (architecture v3 section 4.8, amendment A4.1). SERVER ONLY.
// Shared: every owner and member sees every component; viewers and guests see none. Only the creator
// and the owner update or delete. Deleting hides the component and keeps its versions, so published
// apps pinned to it keep rendering; registered handlers detach instances in drafts.
import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AppDocument, ComponentNode, LibraryComponent, LibraryParam, Principal } from "@/core/contracts";
import { db, transaction } from "@/core/db";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { write as audit } from "@/features/audit/write";
import { libraryComponents, libraryVersions } from "@/db/schema/library";
import { parameterize, containsCode as hasCode, expandInstance, instanceNodeFor, type Promotion } from "@/features/components/library-instance";
import { validateSubtree } from "@/features/components/validate";
import { libraryRefs } from "@/features/components/page";
import type { ComponentFile } from "./file";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function newLibraryId(): string {
  const b = new Uint8Array(10);
  globalThis.crypto.getRandomValues(b);
  return `l_${[...b].map((x) => ALPHABET[x % 32]).join("")}`;
}

type Actor = Exclude<Principal, { kind: "guest" }>;

/** Owners and members only (viewers, guests: no library). */
export function libraryActor(p: Principal): Actor {
  if (p.kind === "guest") throw new Forbidden("Guests cannot use the component library.");
  if (p.role === "viewer") throw new Forbidden("Viewers cannot use the component library.");
  return p;
}

function canUpdate(p: Actor, createdBy: string): boolean {
  return p.role === "owner" || p.userId === createdBy;
}

type Row = typeof libraryComponents.$inferSelect;
type VRow = typeof libraryVersions.$inferSelect;

function toComponent(row: Row, v: VRow): LibraryComponent {
  return {
    id: row.id,
    name: v.name,
    ...(v.description ? { description: v.description } : {}),
    tags: v.tags,
    version: v.version,
    node: v.node as ComponentNode,
    params: v.params as LibraryParam[],
    containsCode: v.containsCode,
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: (v.createdAt ?? row.updatedAt).toISOString(),
  };
}

export type LibraryListItem = LibraryComponent & { canUpdate: boolean };

export function listLibrary(p: Principal): LibraryListItem[] {
  const a = libraryActor(p);
  const rows = db().select().from(libraryComponents).where(isNull(libraryComponents.deletedAt)).orderBy(desc(libraryComponents.updatedAt)).all();
  return rows.flatMap((r) => {
    const v = db().select().from(libraryVersions).where(and(eq(libraryVersions.componentId, r.id), eq(libraryVersions.version, r.version))).get();
    return v ? [{ ...toComponent(r, v), canUpdate: canUpdate(a, r.createdBy) }] : [];
  });
}

/** A component at a version (default: latest), plus its latest version. Deleted components stay readable by version. */
export function getLibrary(p: Principal, id: string, version?: number): { component: LibraryComponent; latest: LibraryComponent; deleted: boolean; canUpdate: boolean } {
  const a = libraryActor(p);
  const row = db().select().from(libraryComponents).where(eq(libraryComponents.id, id)).get();
  if (!row) throw new NotFound("That library component does not exist.");
  const latestV = db().select().from(libraryVersions).where(and(eq(libraryVersions.componentId, id), eq(libraryVersions.version, row.version))).get();
  const v = version ? db().select().from(libraryVersions).where(and(eq(libraryVersions.componentId, id), eq(libraryVersions.version, version))).get() : latestV;
  if (!v || !latestV) throw new NotFound("That version does not exist.");
  return { component: toComponent(row, v), latest: toComponent(row, latestV), deleted: !!row.deletedAt, canUpdate: canUpdate(a, row.createdBy) };
}

export type SaveInput = {
  componentId?: string;
  name: string;
  description?: string;
  tags?: string[];
  node: ComponentNode;
  promote?: Promotion[];
  /** The app's data source names and controls, so they become parameters. */
  sources: string[];
  controls: { id: string; label: string }[];
};

function checkSaved(c: Pick<LibraryComponent, "node" | "params" | "id" | "name" | "version">): void {
  const controls = c.params.filter((x) => x.kind === "control" && typeof x.default === "string").map((x) => ({ id: x.default as string, label: x.label, run: { kind: "workflow" as const, actionId: "library-check" } }));
  const expanded = expandInstance({ ...instanceNodeFor(c), id: "c_libcheckaa" }, { ...c, description: undefined, tags: [], containsCode: false, source: "local", createdBy: "", createdAt: "", updatedAt: "" });
  const problems = validateSubtree(expanded, { dataSources: [], controls }, { inLibrary: true }).filter((x) => x.severity === "error" && x.code !== "binding.unknown_source" && x.code !== "node.duplicate_id");
  if (problems.length) throw new AtriumError(`This component has a problem: ${problems[0]!.message}`, 400, "invalid");
}

/** Saves a subtree (or a new version of an existing component). Audited as library.saved. */
export function saveLibrary(p: Principal, input: SaveInput): LibraryComponent {
  const a = libraryActor(p);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new AtriumError("Give the component a name.", 400, "invalid");
  if (input.node.type.startsWith("lib:")) throw new AtriumError("Detach this instance before saving it as a new component.", 400, "invalid");
  const doc: Pick<AppDocument, "dataSources" | "controls"> = {
    dataSources: input.sources.map((n) => ({ name: n, integrationId: "", endpointId: "", refreshSec: 30 })),
    controls: input.controls.map((c) => ({ id: c.id, label: c.label, run: { kind: "workflow", actionId: "" } })),
  };
  const { node, params } = parameterize(input.node, doc, input.promote ?? []);
  const now = new Date();
  const tags = (input.tags ?? []).map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  const code = hasCode(node);
  return transaction((tx) => {
    let id = input.componentId;
    let version = 1;
    let row: Row | undefined;
    if (id) {
      row = tx.select().from(libraryComponents).where(eq(libraryComponents.id, id)).get();
      if (!row || row.deletedAt) throw new NotFound("That library component does not exist.");
      if (!canUpdate(a, row.createdBy)) throw new Forbidden("Only the person who saved this component, or the owner, can update it.");
      version = row.version + 1;
    } else id = newLibraryId();
    checkSaved({ id, name, version, node, params });
    tx.insert(libraryVersions).values({ componentId: id, version, name, description: input.description?.slice(0, 300) || null, tags, node, params, containsCode: code, createdBy: a.userId, createdAt: now }).run();
    if (row) tx.update(libraryComponents).set({ name, description: input.description?.slice(0, 300) || null, tags, version, containsCode: code, updatedAt: now }).where(eq(libraryComponents.id, id)).run();
    else tx.insert(libraryComponents).values({ id, name, description: input.description?.slice(0, 300) || null, tags, version, containsCode: code, source: "local", createdBy: a.userId, createdAt: now, updatedAt: now }).run();
    audit({ actor: p, event: "library.saved", target: { type: "library_component", id, label: name }, result: "ok", detail: { version, params: params.map((x) => `${x.kind}:${x.name}`), containsCode: code } });
    const saved = tx.select().from(libraryComponents).where(eq(libraryComponents.id, id)).get()!;
    const v = tx.select().from(libraryVersions).where(and(eq(libraryVersions.componentId, id), eq(libraryVersions.version, version))).get()!;
    return toComponent(saved, v);
  });
}

/**
 * Import identity (gauntlet w2-r1 Fix 15). A component's id is its stable origin key: every export
 * carries it, and ids are random, so a file whose id names a live component here is that component
 * (for example an updated copy of it). Re-importing offers "Update <name> to v<N>"; otherwise the
 * import saves a new component, renamed "<name> (2)" when the name is taken.
 */
export type ImportMatch = { id: string; name: string; version: number; canUpdate: boolean };

export function importMatch(p: Principal, file: ComponentFile): ImportMatch | null {
  const a = libraryActor(p);
  const row = db().select().from(libraryComponents).where(eq(libraryComponents.id, file.id)).get();
  if (!row || row.deletedAt) return null;
  return { id: row.id, name: row.name, version: row.version, canUpdate: canUpdate(a, row.createdBy) };
}

/** A free name: the name itself, or "name (2)", "name (3)" ... among live components. */
export function freeName(name: string): string {
  const taken = new Set(db().select({ name: libraryComponents.name }).from(libraryComponents).where(isNull(libraryComponents.deletedAt)).all().map((r) => r.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const base = name.replace(/ \(\d+\)$/, "").slice(0, 72);
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
  return `${base} (${Date.now()})`;
}

/**
 * Imports a parsed component file. `copy` (the default) saves a new, imported component with a free
 * name; `update` adds the file as the next version of the component it came from (its creator or the
 * owner only). Audited as library.imported.
 */
export function importLibrary(p: Principal, file: ComponentFile, opts: { mode?: "copy" | "update" } = {}): LibraryComponent {
  const a = libraryActor(p);
  const code = hasCode(file.node);
  checkSaved({ id: file.id, name: file.name, version: file.version, node: file.node, params: file.params as LibraryParam[] });
  const now = new Date();
  if (opts.mode === "update") {
    const match = importMatch(p, file);
    if (!match) throw new NotFound("There is no component here that this file updates. Import it as a copy instead.");
    if (!match.canUpdate) throw new Forbidden("Only the person who saved this component, or the owner, can update it.");
    return transaction((tx) => {
      const version = match.version + 1;
      tx.insert(libraryVersions).values({ componentId: match.id, version, name: file.name, description: file.description ?? null, tags: file.tags, node: file.node, params: file.params, containsCode: code, createdBy: a.userId, createdAt: now }).run();
      tx.update(libraryComponents).set({ name: file.name, description: file.description ?? null, tags: file.tags, version, containsCode: code, updatedAt: now }).where(eq(libraryComponents.id, match.id)).run();
      audit({ actor: p, event: "library.imported", target: { type: "library_component", id: match.id, label: file.name }, result: "ok", detail: { version, updated: true, fileVersion: file.version, containsCode: code, params: file.params.map((x) => `${x.kind}:${x.name}`) } });
      const row = tx.select().from(libraryComponents).where(eq(libraryComponents.id, match.id)).get()!;
      const v = tx.select().from(libraryVersions).where(and(eq(libraryVersions.componentId, match.id), eq(libraryVersions.version, version))).get()!;
      return toComponent(row, v);
    });
  }
  const name = freeName(file.name);
  return transaction((tx) => {
    const taken = tx.select({ id: libraryComponents.id }).from(libraryComponents).where(eq(libraryComponents.id, file.id)).get();
    const id = !taken && /^l_[a-z2-7]{10}$/.test(file.id) ? file.id : newLibraryId();
    const createdAt = Number.isFinite(Date.parse(file.createdAt)) ? new Date(file.createdAt) : now;
    const updatedAt = Number.isFinite(Date.parse(file.updatedAt)) ? new Date(file.updatedAt) : now;
    tx.insert(libraryVersions).values({ componentId: id, version: file.version, name, description: file.description ?? null, tags: file.tags, node: file.node, params: file.params, containsCode: code, createdBy: a.userId, createdAt: updatedAt }).run();
    tx.insert(libraryComponents).values({ id, name, description: file.description ?? null, tags: file.tags, version: file.version, containsCode: code, source: "imported", createdBy: a.userId, createdAt, updatedAt }).run();
    audit({ actor: p, event: "library.imported", target: { type: "library_component", id, label: name }, result: "ok", detail: { version: file.version, containsCode: code, params: file.params.map((x) => `${x.kind}:${x.name}`), ...(name !== file.name ? { renamedFrom: file.name } : {}) } });
    const row = tx.select().from(libraryComponents).where(eq(libraryComponents.id, id)).get()!;
    const v = tx.select().from(libraryVersions).where(and(eq(libraryVersions.componentId, id), eq(libraryVersions.version, file.version))).get()!;
    return toComponent(row, v);
  });
}

/** `by` is the person deleting the component (the draft changes the handler makes are theirs). */
type DeleteHandler = (componentId: string, versions: LibraryComponent[], by: Principal) => Promise<number> | number;
const g = globalThis as unknown as { __atriumLibraryDelete?: DeleteHandler[] };
/** app-builder registers this: detach every instance of the component in app drafts, returning how many. */
export function registerLibraryDeleteHandler(fn: DeleteHandler): void {
  (g.__atriumLibraryDelete ??= []).push(fn);
}

/** Deletes (hides) a component; instances are detached by the registered handlers. Audited as library.deleted. */
export async function deleteLibrary(p: Principal, id: string): Promise<{ detached: number }> {
  const a = libraryActor(p);
  const row = db().select().from(libraryComponents).where(eq(libraryComponents.id, id)).get();
  if (!row || row.deletedAt) throw new NotFound("That library component does not exist.");
  if (!canUpdate(a, row.createdBy)) throw new Forbidden("Only the person who saved this component, or the owner, can delete it.");
  const versions = db().select().from(libraryVersions).where(eq(libraryVersions.componentId, id)).all().map((v) => toComponent(row, v));
  let detached = 0;
  for (const fn of g.__atriumLibraryDelete ?? []) detached += await fn(id, versions, p);
  db().update(libraryComponents).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(libraryComponents.id, id)).run();
  audit({ actor: p, event: "library.deleted", target: { type: "library_component", id, label: row.name }, result: "ok", detail: { detached } });
  return { detached };
}

/** Every library version a document's instances pin, keyed `id@version` (for rendering and the guest resolver). */
export function libraryForDoc(doc: AppDocument): Record<string, LibraryComponent> {
  const out: Record<string, LibraryComponent> = {};
  for (const r of libraryRefs(doc)) {
    const row = db().select().from(libraryComponents).where(eq(libraryComponents.id, r.componentId)).get();
    const v = row ? db().select().from(libraryVersions).where(and(eq(libraryVersions.componentId, r.componentId), eq(libraryVersions.version, r.version))).get() : undefined;
    if (row && v) out[r.key] = toComponent(row, v);
  }
  return out;
}
