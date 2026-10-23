// Window status roll-up and data shape checks (gauntlet w2-r2 Fixes 4 and 14). Pure and isomorphic.
//
// A card is the outer window: the data components inside it are drawn as wells without a title bar of
// their own, so the card's bar carries their worst status (the same ranking a data component uses for
// its sources). A data component bound to a source of the wrong shape says so in plain words instead of
// drawing an empty "live" window.
import type { ComponentNode } from "@/core/contracts";
import { expandInstance } from "../library-instance";
import { notConnected } from "../catalogue/samples";
import { instanceComponent, instanceScope, nodeStatus, valueKey, type NodeStatus, type PageScope } from "./resolve";

const RANK: Record<NodeStatus["kind"], number> = { not_available: 7, not_shared: 6, loading: 5, empty: 4, failed: 3, stale: 2, ok: 1, none: 0 };

/** The worst data status among a window's child components (instances expanded, repeats skipped). */
export function rollupStatus(children: readonly ComponentNode[], scope: PageScope, opts: { edit: boolean; path: string }): NodeStatus {
  let worst: NodeStatus = { kind: "none" };
  const visit = (n: ComponentNode, sc: PageScope, depth: number) => {
    if (depth > 8) return;
    if (n.type.startsWith("lib:")) {
      const lib = instanceComponent(n, sc);
      if (lib) visit(expandInstance(n, lib), sc.$guest ? sc : instanceScope(n, lib, sc), depth + 1);
      return;
    }
    let st: NodeStatus = sc.$guest ? ((sc.$guest[valueKey(n.id, "$status", opts.path)] as NodeStatus | undefined) ?? { kind: "none" }) : nodeStatus(n, sc);
    // An unconnected data component shows samples while editing and the empty state elsewhere.
    if (notConnected(n)) st = opts.edit ? { kind: "none" } : { kind: "empty" };
    if (RANK[st.kind] > RANK[worst.kind]) worst = st;
    if (n.type !== "repeat") for (const c of n.children ?? []) visit(c, sc, depth + 1);
  };
  for (const c of children) visit(c, scope, 0);
  return worst;
}

const KIND_WORDS: Record<string, string> = { stat: "a single value", series: "a series over time", table: "a table", status: "a status list" };
const TRY_TYPE: Record<string, string> = { stat: "Stat", series: "Chart", table: "Table", status: "Status", list: "List" };
const NEEDS: Record<string, { kinds: string[]; need: string; title: string }> = {
  stat: { kinds: ["stat"], need: "a single value", title: "Stat" },
  status: { kinds: ["status"], need: "a status list", title: "Status" },
  table: { kinds: ["table"], need: "a table", title: "Table" },
  chart: { kinds: ["series"], need: "a series over time", title: "Chart" },
};

/**
 * When a data component's `data` is of the wrong shape, the calm message it shows instead of an empty
 * window ("cpu is a single value; Status needs a status list. Try Stat."); null when the shape fits or
 * there is no data yet.
 */
export function shapeMismatch(type: string, data: unknown, source?: string): string | null {
  const need = NEEDS[type];
  if (!need || data === undefined || data === null) return null;
  const kind = typeof data === "object" && !Array.isArray(data) ? (data as { kind?: unknown }).kind : undefined;
  if (typeof kind === "string" && need.kinds.includes(kind)) return null;
  // A stat shows a plain number or text as its value.
  if (type === "stat" && (typeof data === "number" || typeof data === "string")) return null;
  const isList = Array.isArray(data);
  const what = typeof kind === "string" && KIND_WORDS[kind] ? KIND_WORDS[kind]! : isList ? "a list" : typeof data === "object" ? "a set of fields" : "a single value";
  const suggestion = typeof kind === "string" ? TRY_TYPE[kind] : isList ? TRY_TYPE.list : typeof data !== "object" ? TRY_TYPE.stat : undefined;
  const name = source?.trim() || "This data";
  return `${name} is ${what}; ${need.title} needs ${need.need}.${suggestion && suggestion !== need.title ? ` Try ${suggestion}.` : ""}`;
}
