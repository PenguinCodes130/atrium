// Wave 2.10c round 2 (gauntlet r1 Fix List item 1, architecture A11.4): what a roulette in the builder takes.
// Slots mode turns through 2 to 50 children, one per slot; repeat mode draws exactly one template per row. Every
// builder path that puts a widget into a container (a drop from Insert, a canvas move, an Insert click, a Layers
// drag or menu, Ctrl+V) asks here first, and a refusal is said in words. No React and no DOM, so it is unit-tested.
import type { ComponentNode } from "@/core/contracts";

/** Wave 2.10c r2 item 1: the most slots a roulette turns through (A11.4). */
export const ROULETTE_SLOTS = 50;
/** Wave 2.10c r2 item 1: the builder asks the roulette (components) to turn to a slot it just received. */
export const ROULETTE_SHOW_EVENT = "atrium:roulette-show";
/**
 * Wave 2.10c r2 item 1 (A11.4): why a roulette takes no more widgets, or null when it takes one. Repeat mode
 * holds exactly one template; slots mode at most 50 slots. `movingId` (a widget already inside) is left out.
 */
export function rouletteRefusal(roulette: ComponentNode, movingId?: string): string | null {
  const kids = (roulette.children ?? []).filter((c) => c.id !== movingId);
  if (roulette.props.mode === "repeat") return kids.length ? "This roulette repeats one widget for each row and already has it. Remove that one first, or switch Turns through to its slots." : null;
  return kids.length >= ROULETTE_SLOTS ? `A roulette turns through at most ${ROULETTE_SLOTS} slots. Use a list or a table for more.` : null;
}
