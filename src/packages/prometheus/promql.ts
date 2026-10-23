// PromQL builders and the friendly machine name rule for the Prometheus package (data ease spec 3.3,
// research section 5). Pure, no I/O. Every value a person picks goes into a query only through
// `lit()` (a quoted, escaped string literal) or after a strict name check, never as raw text.
import type { ValueFormat } from "@/core/contracts";
import { fail } from "../lib";

/** The choice value meaning "every machine" (architecture A8.2). */
export const EVERY = "*";

/** Physical network cards only, so bridged guest traffic is counted once (research section 5). */
export const NIC = 'device!~"lo|veth.*|docker.*|br-.*|fwbr.*|fwpr.*|fwln.*|tap.*|vmbr.*"';
/** Real filesystems only: on the operator's server this leaves exactly / per machine. */
export const FS = 'fstype!~"tmpfs|devtmpfs|overlay|squashfs|ramfs|nsfs|fuse.*",mountpoint!~"/boot.*|/run.*|/snap.*"';

const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A PromQL double-quoted string literal. Backslashes, quotes and line breaks are escaped. */
export function lit(v: string): string {
  if (v.length > 512) fail("config", "That value is too long for a Prometheus query.");
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

export function metricName(v: unknown, what = "metric"): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) fail("config", `Pick a ${what}.`);
  if (!METRIC_NAME.test(s) || s.length > 200) fail("config", `"${s.slice(0, 60)}" is not a metric name.`, "Metric names use letters, numbers, _ and :, such as node_load5.");
  return s;
}

export function labelName(v: unknown, what = "label"): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!LABEL_NAME.test(s) || s.length > 100) fail("config", `"${s.slice(0, 60)}" is not a ${what} name.`, "Label names use letters, numbers and _.");
  return s;
}

// ---- Measures: one query template per measure, answering one sample per machine (by instance) ----
// Plain data, filled by recipe.ts fillQuery: {{machine}} is the machine filter, {{mount}} the mount (default /).

export type MeasureKey = "cpu" | "memory" | "memoryUsed" | "memoryTotal" | "disk" | "netIn" | "netOut" | "load1" | "load5" | "load15" | "uptime" | "temperature" | "updates" | "reboot" | "cores";
export type Measure = { key: MeasureKey; label: string; format: ValueFormat; query: string };

export const MEASURES: Record<MeasureKey, Measure> = {
  cpu: { key: "cpu", label: "CPU in use", format: "percent", query: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{ {{machine}} mode="idle"}[5m])))' },
  memory: { key: "memory", label: "Memory in use", format: "percent", query: "100 * (1 - node_memory_MemAvailable_bytes{ {{machine}} } / node_memory_MemTotal_bytes{ {{machine}} })" },
  memoryUsed: { key: "memoryUsed", label: "Memory used", format: "bytes", query: "node_memory_MemTotal_bytes{ {{machine}} } - node_memory_MemAvailable_bytes{ {{machine}} }" },
  memoryTotal: { key: "memoryTotal", label: "Memory", format: "bytes", query: "node_memory_MemTotal_bytes{ {{machine}} }" },
  disk: { key: "disk", label: "Disk in use", format: "percent", query: "max by (instance) (100 * (1 - node_filesystem_avail_bytes{ {{machine}} mountpoint={{mount}} } / node_filesystem_size_bytes{ {{machine}} mountpoint={{mount}} }))" },
  netIn: { key: "netIn", label: "Network in", format: "bytesPerSec", query: "sum by (instance) (rate(node_network_receive_bytes_total{ {{machine}} {{NIC}} }[5m]))" },
  netOut: { key: "netOut", label: "Network out", format: "bytesPerSec", query: "sum by (instance) (rate(node_network_transmit_bytes_total{ {{machine}} {{NIC}} }[5m]))" },
  load1: { key: "load1", label: "Load (1 min)", format: "number", query: "node_load1{ {{machine}} }" },
  load5: { key: "load5", label: "Load (5 min)", format: "number", query: "node_load5{ {{machine}} }" },
  load15: { key: "load15", label: "Load (15 min)", format: "number", query: "node_load15{ {{machine}} }" },
  uptime: { key: "uptime", label: "Uptime", format: "seconds", query: "time() - node_boot_time_seconds{ {{machine}} }" },
  temperature: { key: "temperature", label: "Temperature", format: "celsius", query: "max by (instance) (node_hwmon_temp_celsius{ {{machine}} }) or max by (instance) (node_thermal_zone_temp{ {{machine}} })" },
  updates: { key: "updates", label: "Pending updates", format: "number", query: "sum by (instance) (apt_upgrades_pending{ {{machine}} })" },
  reboot: { key: "reboot", label: "Reboot needed", format: "number", query: "max by (instance) (node_reboot_required{ {{machine}} })" },
  cores: { key: "cores", label: "CPU cores", format: "number", query: 'count by (instance) (node_cpu_seconds_total{ {{machine}} mode="idle"})' },
};

/** The measures a chart over time or a "busiest" list can use, as the `measure` param's enum. */
export const CHART_MEASURES = ["cpu", "memory", "disk", "netIn", "netOut", "load5", "temperature"] as const;
export type ChartMeasure = (typeof CHART_MEASURES)[number];

export function chartMeasure(v: unknown): Measure {
  const k = typeof v === "string" && v ? v : "cpu";
  if (!(CHART_MEASURES as readonly string[]).includes(k)) fail("config", `"${k}" is not a measure Atrium can chart.`, `Pick one of: ${CHART_MEASURES.join(", ")}.`);
  return MEASURES[k as ChartMeasure];
}

// ---- Friendly names (data ease spec 3.3) ----

/** An address without its port: "10.77.99.8:9100" gives "10.77.99.8", "[::1]:9100" gives "::1". */
export function withoutPort(instance: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(instance);
  if (v6) return v6[1]!;
  return instance.replace(/:\d+$/, "");
}

/** The name a person gave a machine: the `host` label (or hostname, alias), else its own hostname, else the address. */
export function friendlyName(labels: Record<string, string | undefined>, nodename?: string): string {
  for (const k of ["host", "hostname", "alias"]) {
    const v = labels[k]?.trim();
    if (v) return v;
  }
  const n = (nodename ?? labels.nodename)?.trim();
  if (n && n !== "(none)" && n !== "localhost") return n;
  return withoutPort(labels.instance ?? "") || "unknown";
}

/**
 * Display names for chart lines: the friendly machine name when the series carry an instance, plus any
 * label that tells two series of the same machine apart. Never the raw label text (spec 3.3).
 */
export function seriesDisplays(metrics: Record<string, string>[], names?: Map<string, string>): string[] {
  const ignore = new Set(["__name__", "instance", "job", "host", "hostname", "alias", "nodename"]);
  const keys = new Set<string>();
  for (const m of metrics) for (const k of Object.keys(m)) if (!ignore.has(k)) keys.add(k);
  const varying = [...keys].filter((k) => new Set(metrics.map((m) => m[k] ?? "")).size > 1);
  const out = metrics.map((m) => {
    const who = m.instance || m.host ? (names?.get(m.instance ?? "") ?? friendlyName(m)) : "";
    const rest = varying.map((k) => m[k]).filter(Boolean).join(" ");
    return [who, rest].filter(Boolean).join(" ") || m.__name__ || "value";
  });
  // Two lines with the same words (one machine, several jobs) get the job, then the address, added.
  for (const extra of [(m: Record<string, string>) => m.job, (m: Record<string, string>) => m.instance]) {
    const count = new Map<string, number>();
    for (const d of out) count.set(d, (count.get(d) ?? 0) + 1);
    out.forEach((d, i) => { const x = extra(metrics[i]!); if ((count.get(d) ?? 0) > 1 && x && !d.includes(x)) out[i] = `${d} (${x})`; });
  }
  return out;
}

/** A stable key for a series: its label set without the metric name. */
export function seriesKey(metric: Record<string, string>): string {
  const labels = Object.entries(metric).filter(([k]) => k !== "__name__").sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}="${v}"`);
  return labels.length ? `{${labels.join(",")}}` : metric.__name__ || "value";
}

/** Window and step for a chart of `hours` hours: about 240 points, never under 30 s. */
export function rangeFor(hoursIn: unknown, nowMs: number): { start: number; end: number; step: number; hours: number } {
  const n = typeof hoursIn === "number" ? hoursIn : typeof hoursIn === "string" && hoursIn.trim() ? Number(hoursIn) : 6;
  const hours = Number.isFinite(n) ? Math.min(Math.max(n, 1), 24 * 30) : 6;
  const end = Math.floor(nowMs / 1000);
  const step = Math.max(30, Math.ceil((hours * 3600) / 240));
  return { start: end - Math.round(hours * 3600), end, step, hours };
}

/** Rounds to a few significant decimals so values stay small on the wire. */
export function round(v: number | null, d = 2): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
