// Gauntlet w210c-r1 item 1 (architecture A11.4): what a roulette takes as a child, in one place, so every way
// of putting a widget into it (Insert with it selected, a drag from Insert, a move on the canvas, Layers and
// its menu, paste) gives the same answer and the same sentence. Pure, browser and server safe.
//   - Slots mode: each child is one slot, at most 50 (a new one goes at the end).
//   - Repeat mode: exactly one child, the template drawn once per row (a second is refused with a sentence).
import type { ComponentNode } from "@/core/contracts";

export const ROULETTE_MAX_SLOTS = 50;
export const ROULETTE_FULL = "This roulette already turns through 50 slots, the most it can hold. Show them as a list or a table instead.";
export const ROULETTE_TEMPLATE_TAKEN = "A roulette that repeats for each row holds one widget, and this one already has one. Remove it first, or switch Turns through to its slots.";
export const ROULETTE_NOT_ITSELF = "A roulette cannot go inside itself.";
/** The builder dispatches this window event (detail { nodeId, slot }) to turn a roulette to a slot it selected. */
export const ROULETTE_SHOW_EVENT = "atrium:roulette-show";

export type RouletteDropRule = { accepts: true; mode: "slots" | "repeat"; index: number } | { accepts: false; reason: string };

/**
 * Whether the roulette takes one more child, and where it goes. `moving` is the id of a widget being moved:
 * a widget already inside it (a reorder) is always taken, and the roulette itself never is.
 */
export function rouletteDropRule(node: Pick<ComponentNode, "id" | "props" | "children">, moving?: string): RouletteDropRule {
  const kids = node.children ?? [];
  const mode = node.props?.mode === "repeat" ? "repeat" : "slots";
  if (moving && moving === node.id) return { accepts: false, reason: ROULETTE_NOT_ITSELF };
  const inside = !!moving && kids.some((k) => k.id === moving);
  if (mode === "repeat") {
    if (kids.length >= 1 && !inside) return { accepts: false, reason: ROULETTE_TEMPLATE_TAKEN };
    return { accepts: true, mode, index: 0 };
  }
  if (kids.length >= ROULETTE_MAX_SLOTS && !inside) return { accepts: false, reason: ROULETTE_FULL };
  return { accepts: true, mode, index: inside ? kids.length - 1 : kids.length };
}
