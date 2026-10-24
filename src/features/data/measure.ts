// A10.4: what a read measures, for "By measure" browsing and search words. A read's own `measure`
// wins; otherwise it is derived from the words of its label (then its group). Pure, no I/O.
import type { DataShapeKind, Measure } from "@/core/contracts";

const RULES: [Measure, RegExp][] = [
  ["temperature", /\b(temp(erature)?s?|thermal|celsius|fahrenheit|heat)\b/],
  ["cpu", /\b(cpus?|processors?|cores?|load|busy)\b/],
  ["memory", /\b(memory|ram|swap|mem)\b/],
  ["disk", /\b(disks?|storage|filesystems?|mounts?|drives?|volumes?|smart|nvme|ssd|hdd|space)\b/],
  ["network", /\b(network|net|traffic|bandwidth|throughput|download|upload|received|sent|nic|interfaces?|in|out)\b/],
  ["uptime", /\b(uptime|boot(ed)?|up since|running for|age)\b/],
  ["status", /\b(status|state|health(y)?|up|down|online|offline|alerts?|monitors?|gateways?|unavailable|reachab(le|ility)|targets?)\b/],
  ["count", /\b(count|how many|number of|total|running|stopped|items|entities|hosts|containers|guests|rules|certificates)\b/],
];

/** The measure named by these words, or undefined. */
function fromWords(text: string): Measure | undefined {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const [m, re] of RULES) if (re.test(t)) return m;
  return undefined;
}

/** A read's measure: its own, else from its label, else its group, else `other` (a status read says status). */
export function measureOf(e: { measure?: Measure | undefined; label: string; group?: string | undefined; shape?: DataShapeKind }): Measure {
  if (e.measure) return e.measure;
  return fromWords(e.label) ?? fromWords(e.group ?? "") ?? (e.shape === "status" ? "status" : "other");
}

/** Words a person might type for each measure, so "memory" finds "RAM" and "network" finds "Network in". */
export const MEASURE_WORDS: Record<Measure, string> = {
  cpu: "cpu processor", memory: "memory ram", disk: "disk storage", network: "network traffic", temperature: "temperature",
  uptime: "uptime", count: "count", status: "status health", other: "",
};
