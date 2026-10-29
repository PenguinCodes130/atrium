// Fit components grow their slot to their content (Wave 2.10 B1, architecture A11.2): in a fixed-row grid the
// builder writes the grown `h` on insert and when a component's props, data or children change, as one
// history entry with that edit, pushing siblings down (fitOps). This file decides which edits start a
// check (pure, unit-tested); builder-screen measures after the page has drawn (fit-measure.ts).
import type { AppDocument, ComponentSizing, ComponentType, DraftOp } from "@/core/contracts";
import { findNode } from "@/features/apps/doc";

/** How long after an edit its components are still watched (live data and images arrive later). */
export const WATCH_MS = 4000;
/** At most this many rows of growth per component per watched edit (a runaway guard: 3200 px; nine machine cards need about 1760). */
export const MAX_GROW_ROWS = 400;

/**
 * A component's sizing (A11.2); absent means fit. Given the node, a repeat of cards ("Card for each") is fit
 * as components' sizingOf says (recheck H1), so it grows to its cards like any fit box.
 */
export function sizingOf(type: ComponentType, lookup: (t: ComponentType) => { sizing?: ComponentSizing } | undefined, node?: { children?: readonly { type: ComponentType }[] }): ComponentSizing {
  if (type === "repeat" && node?.children?.[0]?.type === "card") return "fit";
  return lookup(type)?.sizing ?? "fit";
}

/**
 * True for a node.update patch that only places or hides the node (slot, phone slot), or only flips
 * "Customise the look" on a node with no saved style: content is unchanged.
 */
function placesOnly(patch: Record<string, unknown>, styled: boolean): boolean {
  return Object.keys(patch).every((k) => {
    if (k === "slot" || k === "hidden") return true;
    if (k === "overrideTheme") return !styled;
    if (k !== "responsive") return false;
    const mobile = (patch.responsive as { mobile?: Record<string, unknown> } | undefined)?.mobile;
    return !!mobile && Object.keys(mobile).every((m) => m === "slot" || m === "hidden");
  });
}

/**
 * The nodes whose content an edit changes: an inserted node and the container it went into; a node whose
 * props, data, title or style changed; both containers of a move between parents. Moves inside one parent,
 * resizes, removals and page or theme edits start no check (a resize is the person's chosen size).
 */
export function growTriggers(before: AppDocument, ops: DraftOp[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === "node.add") {
      out.add(op.node.id);
      out.add(op.parentId);
    } else if (op.op === "node.update") {
      const node = findNode(before, op.nodeId)?.node;
      const styled = !!(node?.style || node?.responsive?.mobile?.style);
      if (!placesOnly(op.patch as Record<string, unknown>, styled)) out.add(op.nodeId);
    } else if (op.op === "node.move") {
      const at = findNode(before, op.nodeId);
      if (at?.parent && at.parent.id !== op.parentId) {
        out.add(op.nodeId);
        out.add(op.parentId);
        out.add(at.parent.id);
      }
    }
  }
  return [...out];
}
