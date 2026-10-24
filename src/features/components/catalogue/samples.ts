// Sample values for data components that are not connected to data yet (gauntlet w2-r1 Fix 7 and 14).
// In the builder a fresh Stat, Chart or Table shows these, marked "sample", instead of an empty box;
// the library's cards use them for data parameters. Pure and isomorphic; never sent as real data.
import type { ComponentNode, ShapedData } from "@/core/contracts";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const wave = (seed: number): [number, number | null][] => Array.from({ length: 24 }, (_, i) => [T0 + i * 300_000, Math.round((40 + seed * 9 + 14 * Math.sin((i + seed * 3) / 3.2)) * 10) / 10]);

export const SAMPLE_DATA: Record<"stat" | "series" | "table" | "status", ShapedData> = {
  stat: { kind: "stat", value: 42.5, unit: "%", label: "Sample" },
  // Three named series, like the landing page's prometheus window (gauntlet w2-r2 Fix 6).
  series: { kind: "series", unit: "%", series: [{ name: "node-1", points: wave(0) }, { name: "node-2", points: wave(1) }, { name: "node-3", points: wave(2) }] },
  table: {
    kind: "table",
    columns: [{ key: "name", label: "Name", type: "text" }, { key: "value", label: "Value", type: "number" }, { key: "state", label: "State", type: "status" }],
    rows: [{ name: "alpha", value: 12, state: "up" }, { name: "bravo", value: 48, state: "up" }, { name: "charlie", value: 87, state: "warn" }],
  },
  status: { kind: "status", items: [{ label: "Sample service", state: "up" }, { label: "Another service", state: "warn" }] },
};

/** The props each data type reads its data from, and the sample to show when none of them is set. */
const DATA_PROPS: Record<string, { keys: string[]; sample: Record<string, unknown> }> = {
  stat: { keys: ["data", "value"], sample: { data: SAMPLE_DATA.stat } },
  chart: { keys: ["data", "lines"], sample: { data: SAMPLE_DATA.series } },
  table: { keys: ["data"], sample: { data: SAMPLE_DATA.table } },
  list: { keys: ["items"], sample: { items: (SAMPLE_DATA.table as Extract<ShapedData, { kind: "table" }>).rows, labelKey: "name", detailKey: "value" } },
  status: { keys: ["data"], sample: { data: SAMPLE_DATA.status } },
  gauge: { keys: ["value"], sample: { value: 42 } },
  progress: { keys: ["value"], sample: { value: 42 } },
};

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && "$bind" in v && !String((v as { $bind: unknown }).$bind).trim());

/** True for a data component whose data props are all unset (a freshly inserted one). */
export function notConnected(node: ComponentNode): boolean {
  const d = DATA_PROPS[node.type];
  return !!d && d.keys.every((k) => empty(node.props[k]));
}

/** Sample props for a data component that is not connected yet, or null. */
export function sampleProps(node: ComponentNode): Record<string, unknown> | null {
  return notConnected(node) ? DATA_PROPS[node.type]!.sample : null;
}

/** The sample shaped data a library card shows for a data parameter, guessed from the type that reads it. */
export function sampleFor(type: string): ShapedData {
  return type === "chart" ? SAMPLE_DATA.series : type === "table" || type === "list" || type === "repeat" ? SAMPLE_DATA.table : type === "status" ? SAMPLE_DATA.status : SAMPLE_DATA.stat;
}

export const NOT_CONNECTED = "Not connected to data yet.";
