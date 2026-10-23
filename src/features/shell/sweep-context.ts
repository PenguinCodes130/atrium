"use client";
// Where the opening light sweep is relative to one item (design v4 Note 1): "pending" until the band
// reaches the item's top edge, "passing" while it crosses, "done" after. Outside a <SettleItem>, and
// whenever the page renders lit, it is "done". Window title bars read it to light their door glyph as
// the band passes (paper at 0.6 to gold, staying gold if the window is live).
import { createContext, useContext } from "react";

export type SweepPass = "pending" | "passing" | "done";
export const SweepPassContext = createContext<SweepPass>("done");

export function useSweepPass(): SweepPass {
  return useContext(SweepPassContext);
}

/** How long a door glyph of a window that is not live stays lit after the band passes it. */
export const DOOR_PASS_MS = 420;

/** Whether a title bar's door glyph is gold for this sweep state. */
export function doorLit(live: boolean, pass: SweepPass): boolean {
  if (pass === "pending") return false;
  if (pass === "passing") return true;
  return live;
}
