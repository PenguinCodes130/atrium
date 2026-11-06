// Wave 2.10c R1 (builder half): "This copy only" edits inside a Repeat. The repeat node keeps
// `props.copyOverrides = { [rowKey]: { [childNodeId]: { props?, style?, hidden? } } }`; the renderer (components)
// merges a copy's override over the template child for that row only. Here: the row key of a drawn copy, the
// node as one copy shows it, and the one `node.update` on the repeat that writes or resets an override (so one
// history entry). No React and no DOM, so it is unit-tested.
import type { AppDocument, ComponentNode, DraftOp, PropValue } from "@/core/contracts";
import { findNode } from "@/features/apps/doc";
import { isBinding, sourcesInTemplate } from "@/features/components/bindings";
import { rowKeys } from "@/features/components/render/copy-overrides";

export type CopyOverride = { props?: Record<string, PropValue>; style?: Record<string, unknown>; hidden?: boolean };
export type CopyOverrides = Record<string, Record<string, CopyOverride>>;

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !("$bind" in (v as object));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A row's stable key, the one Repeat uses for its copies (components' `rowKeys`: the row's name, "pve1 (2)" for
 * a second row of the same name, the index only for a row with no name). The canvas's `data-row-key`
 * attribute wins over this; it is the fallback for a copy drawn without one.
 */
export function rowKeyOf(rows: readonly unknown[], index: number): string {
  return rowKeys(rows)[index] ?? `#${index}`;
}

/** The data source a repeat's rows come from (its `items` binding), or null. */
export function repeatSource(repeat: ComponentNode): string | null {
  const items = repeat.props.items;
  if (!isBinding(items)) return null;
  try { return sourcesInTemplate(items.$bind)[0] ?? null; } catch { return null; }
}

/** The overrides a repeat holds (an empty object when none, or when the prop is not an object). */
export function overridesOf(repeat: ComponentNode | null | undefined): CopyOverrides {
  const v = repeat?.props.copyOverrides as unknown;
  return plain(v) ? (v as CopyOverrides) : {};
}

/** The override one copy has for one node inside the template, or undefined. */
export function overrideFor(doc: AppDocument, repeatId: string, rowKey: string, nodeId: string): CopyOverride | undefined {
  const r = findNode(doc, repeatId)?.node;
  const row = overridesOf(r)[rowKey];
  return row && plain(row[nodeId]) ? row[nodeId] : undefined;
}

/** True when the copy for this row has any override. */
export function copyChanged(doc: AppDocument, repeatId: string, rowKey: string): boolean {
  const row = overridesOf(findNode(doc, repeatId)?.node)[rowKey];
  return !!row && Object.keys(row).length > 0;
}

/** The node as one copy draws it: the override merged over the template (shown in the inspector). */
export function withOverride(node: ComponentNode, ov: CopyOverride | undefined): ComponentNode {
  if (!ov) return node;
  return {
    ...node,
    props: { ...node.props, ...(ov.props ?? {}) },
    ...(ov.style ? { style: { ...((node.style as Record<string, unknown> | undefined) ?? {}), ...ov.style } as ComponentNode["style"] } : {}),
    ...(ov.hidden ? { hidden: true } : {}),
  };
}

/** A merge patch (null deletes a key) that turns `from` into `to`; undefined when they are the same. */
export function mergeDiff(from: unknown, to: unknown): unknown {
  if (plain(from) && plain(to)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(to)) {
      const d = mergeDiff(from[k], to[k]);
      if (d !== undefined) out[k] = d;
    }
    for (const k of Object.keys(from)) if (!(k in to)) out[k] = null;
    return Object.keys(out).length ? out : undefined;
  }
  if (to === undefined) return from === undefined ? undefined : null;
  return same(from, to) ? undefined : to;
}

/** Drops empty override objects (a node with nothing left, a row with no node). */
function prune(all: CopyOverrides): CopyOverrides {
  const out: CopyOverrides = {};
  for (const [row, nodes] of Object.entries(all)) {
    const keep: Record<string, CopyOverride> = {};
    for (const [id, ov] of Object.entries(nodes ?? {})) {
      const o: CopyOverride = {};
      if (ov.props && Object.keys(ov.props).length) o.props = ov.props;
      if (ov.style && Object.keys(ov.style).length) o.style = ov.style;
      if (ov.hidden) o.hidden = true;
      if (Object.keys(o).length) keep[id] = o;
    }
    if (Object.keys(keep).length) out[row] = keep;
  }
  return out;
}

/** The one op writing a repeat's whole new overrides (null when nothing changes). */
function writeOp(repeat: ComponentNode, next: CopyOverrides): DraftOp | null {
  const before = overridesOf(repeat);
  const pruned = prune(next);
  const empty = Object.keys(pruned).length === 0;
  if (empty && Object.keys(before).length === 0) return null;
  const diff = empty ? null : mergeDiff(before, pruned);
  if (diff === undefined) return null;
  return { op: "node.update", nodeId: repeat.id, patch: { props: { copyOverrides: diff as PropValue } } } as DraftOp;
}

/** The parts of an inspector patch that "This copy only" keeps for one copy. */
export const COPY_KEYS = ["props", "style", "hidden"] as const;

/**
 * Turns an inspector patch (made against the node as the copy shows it) into the op that stores it for this
 * copy only. Props and style keep only what differs from the template; a value set back to the template's
 * drops out of the override. Returns `rest` for patch keys a copy cannot keep (they go to every copy).
 */
export function copyEditOps(doc: AppDocument, repeatId: string, rowKey: string, nodeId: string, patch: Partial<Omit<ComponentNode, "id" | "children">>): { ops: DraftOp[]; rest: Partial<Omit<ComponentNode, "id" | "children">> | null } {
  const repeat = findNode(doc, repeatId)?.node;
  const node = findNode(doc, nodeId)?.node;
  if (!repeat || !node) return { ops: [], rest: patch };
  const all = structuredClone(overridesOf(repeat));
  const row = (all[rowKey] ??= {});
  const ov: CopyOverride = { ...(row[nodeId] ?? {}) };
  const p = patch as Record<string, unknown>;
  if ("props" in p && plain(p.props)) {
    const merged = { ...(ov.props ?? {}) };
    for (const [k, v] of Object.entries(p.props)) {
      if (same(v, node.props[k])) delete merged[k];
      else merged[k] = v as PropValue;
    }
    // Keys the patch dropped (a field cleared): the copy goes back to the template's value.
    for (const k of Object.keys(merged)) if (!(k in p.props)) delete merged[k];
    ov.props = merged;
  }
  if ("style" in p) {
    const s = p.style;
    const tmpl = (node.style as Record<string, unknown> | undefined) ?? {};
    const merged: Record<string, unknown> = { ...(ov.style ?? {}) };
    if (s === null) ov.style = {};
    else if (plain(s)) {
      for (const [k, v] of Object.entries(s)) {
        if (v === null || same(v, tmpl[k])) delete merged[k];
        else merged[k] = v;
      }
      ov.style = merged;
    }
  }
  if ("hidden" in p) ov.hidden = p.hidden === true;
  row[nodeId] = ov;
  const restKeys = Object.keys(p).filter((k) => !(COPY_KEYS as readonly string[]).includes(k));
  const rest = restKeys.length ? (Object.fromEntries(restKeys.map((k) => [k, p[k]])) as Partial<Omit<ComponentNode, "id" | "children">>) : null;
  const op = writeOp(repeat, all);
  return { ops: op ? [op] : [], rest };
}

/** Reset this copy: the op removing every override the row has (null when it has none). */
export function resetCopyOps(doc: AppDocument, repeatId: string, rowKey: string): DraftOp[] {
  const repeat = findNode(doc, repeatId)?.node;
  if (!repeat) return [];
  const all = structuredClone(overridesOf(repeat));
  if (!all[rowKey]) return [];
  delete all[rowKey];
  const op = writeOp(repeat, all);
  return op ? [op] : [];
}
