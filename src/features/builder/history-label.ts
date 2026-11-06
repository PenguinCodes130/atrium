// Wave 2.10c N2 (architecture A11.1): the words for one builder history entry ("Move Stat", "Delete Group"),
// read from the ops of the edit and the document before it. Shown on the Undo and Redo buttons' tooltips
// ("Undo Move Stat") and in the delete toast. No React and no DOM, so it is unit-tested.
import type { AppDocument, ComponentNode, DraftOp } from "@/core/contracts";
import { findNode, findPage } from "@/features/apps/doc";

/** A component's kind in words: "stat" is "Stat", "service-tile" is "Service tile". */
export function kindWord(node: ComponentNode | undefined | null): string {
  if (!node) return "widget";
  const t = node.type.startsWith("lib:") ? "library component" : node.type.startsWith("pkg:") ? node.type.slice(4).split(/[.:]/).pop() ?? "widget" : node.type;
  const words = t.replace(/[-_]+/g, " ").trim() || "widget";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isBindingValue = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bind?: unknown }).$bind === "string";
const hasBinding = (v: unknown): boolean => {
  if (isBindingValue(v)) return true;
  if (Array.isArray(v)) return v.some(hasBinding);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some(hasBinding);
  return false;
};

/** The words for one node.update: Resize, Move, Rename, Hide, data or a plain change. */
function updateWord(node: ComponentNode | undefined, patch: Record<string, unknown>): string {
  const kind = kindWord(node);
  const keys = Object.keys(patch);
  if (keys.length === 1 && keys[0] === "slot") {
    const s = patch.slot as { w?: number; h?: number } | null;
    const was = node?.slot;
    return s && was && (s.w !== was.w || s.h !== was.h) ? `Resize ${kind}` : `Move ${kind}`;
  }
  if (keys.length === 1 && keys[0] === "responsive") {
    const r = patch.responsive as { mobile?: { slot?: { w?: number; h?: number }; hidden?: boolean } } | null;
    if (r?.mobile && "hidden" in r.mobile) return `${r.mobile.hidden ? "Hide" : "Show"} ${kind} on phones`;
    const was = node?.responsive?.mobile?.slot;
    const s = r?.mobile?.slot;
    return s && was && (s.w !== was.w || s.h !== was.h) ? `Resize ${kind}` : `Move ${kind}`;
  }
  if (keys.length === 1 && keys[0] === "name") return `Rename ${kind}`;
  if (keys.length === 1 && keys[0] === "hidden") return `${patch.hidden ? "Hide" : "Show"} ${kind}`;
  if (keys.length === 1 && keys[0] === "title") return `Change ${kind} title`;
  if (keys.includes("refreshSec")) return `Change ${kind} data`;
  if (keys.includes("style") || keys.includes("css") || keys.includes("overrideTheme")) return `Change ${kind} style`;
  if (keys.includes("props")) {
    const now = (patch.props ?? {}) as Record<string, unknown>;
    const before = (node?.props ?? {}) as Record<string, unknown>;
    const changed = Object.keys({ ...now, ...before }).filter((k) => JSON.stringify(now[k] ?? null) !== JSON.stringify(before[k] ?? null) && k in now);
    if (changed.some((k) => hasBinding(now[k]) || hasBinding(before[k]))) return `Change ${kind} data`;
  }
  return `Change ${kind}`;
}

/** Ops the person did not ask for directly (managed sources following their components, A10.1). */
const follower = (op: DraftOp) => op.op === "source.set" || op.op === "source.remove";

/** The words for an edit, computed against the document before it. */
export function historyLabel(before: AppDocument, ops: DraftOp[]): string {
  const main = ops.filter((o) => !follower(o));
  const list = main.length ? main : ops;
  if (!list.length) return "Change";
  const kinds = new Set(list.map((o) => o.op));
  const node = (id: string) => findNode(before, id)?.node;
  // A move from one container to another is a remove and an add of the same node in some callers.
  const adds = list.filter((o): o is Extract<DraftOp, { op: "node.add" }> => o.op === "node.add");
  const removes = list.filter((o): o is Extract<DraftOp, { op: "node.remove" }> => o.op === "node.remove");
  const moves = list.filter((o): o is Extract<DraftOp, { op: "node.move" }> => o.op === "node.move");
  const updates = list.filter((o): o is Extract<DraftOp, { op: "node.update" }> => o.op === "node.update");
  const many = (n: number, one: string) => (n === 1 ? one : `${n} widgets`);
  if (kinds.has("page.add")) {
    const p = list.find((o): o is Extract<DraftOp, { op: "page.add" }> => o.op === "page.add")!;
    return `Add page ${p.page.title}`.trim();
  }
  if (kinds.has("page.remove")) {
    const p = list.find((o): o is Extract<DraftOp, { op: "page.remove" }> => o.op === "page.remove")!;
    return `Remove page ${findPage(before, p.pageId)?.title ?? ""}`.trim();
  }
  if (kinds.size === 1 && kinds.has("page.move")) return "Reorder pages";
  if (kinds.size === 1 && kinds.has("page.update")) {
    const p = list[0] as Extract<DraftOp, { op: "page.update" }>;
    const keys = Object.keys(p.patch ?? {});
    const title = findPage(before, p.pageId)?.title ?? "";
    if (keys.includes("title")) return `Rename page ${title}`.trim();
    if (keys.includes("inNav")) return `${p.patch.inNav ? "Show" : "Hide"} page ${title} in navigation`.trim();
    return `Change page ${title}`.trim();
  }
  if (kinds.size === 1 && kinds.has("app.update")) {
    const p = list[0] as Extract<DraftOp, { op: "app.update" }>;
    return "homePage" in (p.patch ?? {}) ? "Set start page" : "Change app settings";
  }
  if (kinds.has("theme.set")) return "Change theme";
  if (kinds.size === 1 && kinds.has("chrome.update")) return "Change navigation";
  if (adds.length && !removes.length) {
    const first = adds[0]!.node;
    if (adds.length === 1 && updates.length === 0) return `Insert ${kindWord(first)}`;
    return adds.length === 1 ? `Insert ${kindWord(first)}` : `Insert ${adds.length} widgets`;
  }
  if (removes.length && !adds.length) return `Delete ${many(removes.length, kindWord(node(removes[0]!.nodeId)))}`;
  if (moves.length && !updates.length) {
    // A resize handle sends a move in place with a new size: that is a resize.
    const resized = moves.every((m) => { const was = node(m.nodeId); const p = was ? findNode(before, m.nodeId)?.parent : null; return !!m.slot && !!was?.slot && p?.id === m.parentId && (m.slot.w !== was.slot.w || m.slot.h !== was.slot.h); });
    return `${resized ? "Resize" : "Move"} ${many(moves.length, kindWord(node(moves[0]!.nodeId)))}`;
  }
  if (updates.length) {
    const ids = new Set(updates.map((u) => u.nodeId));
    if (ids.size === 1) {
      const id = updates[0]!.nodeId;
      const merged = Object.assign({}, ...updates.map((u) => u.patch)) as Record<string, unknown>;
      return updateWord(node(id), merged);
    }
    const words = new Set(updates.map((u) => updateWord(node(u.nodeId), u.patch as Record<string, unknown>).split(" ")[0]));
    const verb = words.size === 1 ? [...words][0]! : "Change";
    return `${verb} ${ids.size} widgets`;
  }
  if (kinds.has("control.set") || kinds.has("control.remove")) return "Change control";
  if (ops.some(follower)) return "Change data";
  return "Change";
}

/**
 * The coalescing key of an edit typed or scrubbed in one field (A11.1: typing in one field until blur or
 * 1 s idle is one entry): the node and the props or style keys it changes, or null for anything else.
 */
export function fieldKey(before: AppDocument, ops: DraftOp[]): string | null {
  const main = ops.filter((o) => !follower(o));
  if (main.length !== 1) return null;
  const op = main[0]!;
  if (op.op === "page.update") return `page:${op.pageId}:${Object.keys(op.patch ?? {}).sort().join(",")}`;
  if (op.op !== "node.update") return null;
  const node = findNode(before, op.nodeId)?.node;
  const patch = op.patch as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(patch).sort()) {
    const now = patch[k];
    const was = (node as Record<string, unknown> | undefined)?.[k];
    if ((k === "props" || k === "style") && now && typeof now === "object" && !Array.isArray(now)) {
      const a = now as Record<string, unknown>;
      const b = (was ?? {}) as Record<string, unknown>;
      const changed = Object.keys({ ...a, ...b }).filter((x) => x in a && JSON.stringify(a[x] ?? null) !== JSON.stringify(b[x] ?? null)).sort();
      parts.push(`${k}.${changed.join("+") || "same"}`);
    } else parts.push(k);
  }
  return `node:${op.nodeId}:${parts.join(",")}`;
}
