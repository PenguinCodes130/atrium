// Managed data sources (architecture Amendment 10, A10.1; direct data spec 3.1 and 3.3). A component's
// data choice creates (or reuses) one hidden source per integration, endpoint and canonical params, with a
// generated name and a label in words; nobody names or manages it. After every applied draft change the
// sources are normalised: each managed source runs at the fastest refresh of the components that bind it
// (the read's default when a component sets none), never below the read's minimum, and a managed source
// nothing binds is removed. Pure and isomorphic: the server runs it after every batch (service.ts) and the
// builder runs it while editing, so the follow-up ops land in the same change and one undo reverts all.
import type { AppDocument, ComponentNode, DataSourceDef, DraftOp, PropValue } from "@/core/contracts";
import { sourcesInTemplate, templatesIn } from "@/features/components/bindings";
import { isBinding, walk } from "./doc";

/** The lowest refresh Atrium allows for any source (same floor as checks.ts). */
export const REFRESH_FLOOR = 5;
export const MANAGED_NAME = /^d_[a-z2-7]{8}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** "d_" plus 8 lowercase base32 characters, unique in the app. */
export function managedName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken);
  for (;;) {
    let s = "d_";
    for (let i = 0; i < 8; i++) s += B32[Math.floor(random() * 32) % 32];
    if (!used.has(s)) return s;
  }
}

/** Defaults of a JSON Schema's properties, when it declares any. */
function schemaDefaults(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, { default?: unknown }>;
  return Object.fromEntries(Object.entries(props).filter(([, p]) => p && typeof p === "object" && "default" in p).map(([k, p]) => [k, p.default]));
}

/** Params with keys sorted, empty values and values equal to the schema's default dropped (A10.1). */
export function canonicalParams(params: Record<string, PropValue> | undefined, schema?: Record<string, unknown>): Record<string, PropValue> {
  const defaults = schemaDefaults(schema);
  const out: Record<string, PropValue> = {};
  for (const k of Object.keys(params ?? {}).sort()) {
    const v = params![k];
    if (v === undefined || v === null || v === "") continue;
    if (k in defaults && JSON.stringify(defaults[k]) === JSON.stringify(v)) continue;
    out[k] = v;
  }
  return out;
}

export type ReadRef = { integrationId: string; endpointId: string; params?: Record<string, PropValue> };

/** One string per read: integration, endpoint and canonical params. */
export function readKey(r: ReadRef, schema?: Record<string, unknown>): string {
  return JSON.stringify([r.integrationId, r.endpointId, canonicalParams(r.params, schema)]);
}

/** The managed source already reading this (integration, endpoint, canonical params), if any. */
export function findManaged(doc: Pick<AppDocument, "dataSources">, r: ReadRef, schema?: Record<string, unknown>): DataSourceDef | null {
  const k = readKey(r, schema);
  return doc.dataSources.find((s) => s.managed && readKey(s, schema) === k) ?? null;
}

export type ManagedWant = ReadRef & { label: string; defaultRefreshSec: number; minRefreshSec: number; schema?: Record<string, unknown> };

/**
 * The managed source for a read: the existing one (no ops), or a new one with a generated name, its label
 * and the read's default refresh (normalisation then sets the real interval from the components).
 */
export function ensureManaged(doc: Pick<AppDocument, "dataSources">, want: ManagedWant, opts: { random?: () => number; taken?: Iterable<string> } = {}): { name: string; ops: DraftOp[]; created: boolean } {
  const found = findManaged(doc, want, want.schema);
  if (found) return { name: found.name, ops: [], created: false };
  const name = managedName([...doc.dataSources.map((s) => s.name), ...(opts.taken ?? [])], opts.random);
  const params = canonicalParams(want.params, want.schema);
  const refreshSec = Math.max(REFRESH_FLOOR, want.minRefreshSec, want.defaultRefreshSec);
  const source: DataSourceDef = {
    name,
    integrationId: want.integrationId,
    endpointId: want.endpointId,
    refreshSec,
    ...(Object.keys(params).length ? { params } : {}),
    ...(want.label.trim() ? { label: want.label.trim().slice(0, 80) } : {}),
    managed: true,
  };
  return { name, ops: [{ op: "source.set", source }], created: true };
}

/** Whether a node's props (desktop and phone), visibility rule or library parameters name the source. */
export function nodeReads(n: ComponentNode, name: string): boolean {
  if (n.type.startsWith("lib:") && Object.values(n.props).some((v) => v === name)) return true;
  const temps = [...templatesIn(n.props as PropValue, "props"), ...(n.responsive?.mobile?.props ? templatesIn(n.responsive.mobile.props as PropValue, "props") : [])];
  if (isBinding(n.visibleWhen)) temps.push({ path: "visibleWhen", template: n.visibleWhen.$bind });
  return temps.some((t) => sourcesInTemplate(t.template).includes(name));
}

/** Every node (on every page) that reads the source. */
export function bindersOf(doc: AppDocument, name: string): ComponentNode[] {
  const out: ComponentNode[] = [];
  for (const p of doc.pages) for (const l of walk(p)) if (nodeReads(l.node, name)) out.push(l.node);
  return out;
}

/** What normalisation needs to know about a read: its default and minimum refresh. Null when unknown. */
export type ReadTiming = (s: DataSourceDef) => { defaultRefreshSec: number; minRefreshSec: number } | null;

/** The interval a managed source should run at, given its binders (null keeps the current one). */
export function managedRefresh(s: DataSourceDef, binders: ComponentNode[], timing: ReturnType<ReadTiming>): number | null {
  if (!timing) {
    // Unknown read (the listing is not loaded, or the integration is gone): only components' own settings count.
    const own = binders.map((n) => n.refreshSec).filter((x): x is number => typeof x === "number" && x > 0);
    return own.length ? Math.max(REFRESH_FLOOR, Math.round(Math.min(...own))) : null;
  }
  // A component without its own setting runs at the read's default (spec 3.3); the source runs at the fastest.
  const each = binders.map((n) => (typeof n.refreshSec === "number" && n.refreshSec > 0 ? n.refreshSec : timing.defaultRefreshSec));
  const fastest = Math.min(...each);
  return Math.max(REFRESH_FLOOR, timing.minRefreshSec, Math.round(fastest));
}

/**
 * The follow-up ops after a change (A10.1): set each managed source's refresh from its binders, and remove
 * managed sources nothing binds. Unmanaged sources are never touched. Empty when nothing needs to change.
 */
export function normaliseOps(doc: AppDocument, timing: ReadTiming = () => null): DraftOp[] {
  const ops: DraftOp[] = [];
  for (const s of doc.dataSources) {
    if (!s.managed) continue;
    const binders = bindersOf(doc, s.name);
    if (!binders.length) {
      ops.push({ op: "source.remove", name: s.name });
      continue;
    }
    let t: ReturnType<ReadTiming> = null;
    try { t = timing(s); } catch { t = null; }
    const want = managedRefresh(s, binders, t);
    if (want !== null && want !== s.refreshSec) ops.push({ op: "source.set", source: { ...s, refreshSec: want } });
  }
  return ops;
}

/** The interval a component shows in its Data line: its own setting, else the read's default (or the source's). */
export function nodeRefresh(n: Pick<ComponentNode, "refreshSec">, s: DataSourceDef, timing: ReturnType<ReadTiming>): number {
  if (typeof n.refreshSec === "number" && n.refreshSec > 0) return n.refreshSec;
  if (s.managed && timing) return Math.max(timing.minRefreshSec, timing.defaultRefreshSec);
  return s.refreshSec;
}

/** The refresh choices a component offers (spec 3.3), only at or above the read's minimum. */
export const REFRESH_CHOICES: { sec: number | "min"; label: string }[] = [
  { sec: "min", label: "As fast as allowed" },
  { sec: 10, label: "Every 10 s" },
  { sec: 30, label: "Every 30 s" },
  { sec: 60, label: "Every 1 min" },
  { sec: 300, label: "Every 5 min" },
  { sec: 3600, label: "Every 1 hour" },
];
export function refreshChoices(minRefreshSec: number): { sec: number; label: string }[] {
  const min = Math.max(REFRESH_FLOOR, minRefreshSec);
  const out: { sec: number; label: string }[] = [{ sec: min, label: `As fast as allowed (every ${secWords(min)})` }];
  for (const c of REFRESH_CHOICES) if (typeof c.sec === "number" && c.sec >= min && c.sec !== min) out.push({ sec: c.sec, label: c.label });
  return out;
}

/** "30 s", "1 min", "5 min", "1 hour". */
export function secWords(sec: number): string {
  if (sec % 3600 === 0) return sec === 3600 ? "1 hour" : `${sec / 3600} hours`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}
