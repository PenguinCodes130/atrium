// The Prometheus reads that are not recipes: custom PromQL (Advanced), scrape targets, firing alerts
// (from /api/v1/alerts, not a query), disk health (merges smartmon and the NVMe collector) and the
// guided metric browser ("Pick a metric"). Every person-picked value enters PromQL through lit() or a
// strict metric/label name check.
import type { AdapterContext, ShapedData } from "@/core/contracts";
import { arr, fail, num, obj, param, str, type ReadFn } from "../lib";
import { api, machineNames, matrix, metricNames, vector, type Sample } from "./api";
import { EVERY, friendlyName, labelName, lit, metricName, rangeFor, round, seriesDisplays, withoutPort } from "./promql";

/** The pre-2.7 series name (raw labels), kept as the stable key so existing bindings keep their meaning. */
function legacyName(metric: Record<string, string>): string {
  const name = metric.__name__ ?? "";
  const labels = Object.entries(metric).filter(([k]) => k !== "__name__").map(([k, v]) => `${k}="${v}"`);
  return labels.length ? `${name}{${labels.join(",")}}` : name || "value";
}

function unitOf(params: Record<string, unknown>) {
  return typeof params.unit === "string" && params.unit ? { unit: params.unit } : {};
}

/** Several samples as rows: a friendly name per sample and its value. */
function rowsOf(samples: Sample[], names: Map<string, string>, valueLabel: string, nameOf?: (s: Sample) => string): ShapedData {
  const displays = seriesDisplays(samples.map((s) => s.metric), names);
  const rows = samples.map((s, i) => ({ name: nameOf ? nameOf(s) : displays[i]!, value: round(s.value, 4) }));
  return { kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, { key: "value", label: valueLabel, type: "number" }], rows, total: rows.length };
}

// ---- Disk health (smartmon and NVMe) ----

type Disk = { instance: string; machine: string; disk: string; model: string; serial: string; type: string; healthy: boolean | null; temperature: number | null; poweredOnSec: number | null; lifeLeft: number | null; mediaErrors: number | null };

async function diskList(ctx: AdapterContext): Promise<Disk[]> {
  const q = {
    healthy: "smartmon_device_smart_healthy", info: "smartmon_device_info", temp: "smartmon_temperature_celsius_raw_value", hours: "smartmon_power_on_hours_raw_value", life: "smartmon_percent_lifetime_remain_value",
    nvWarn: "nvme_critical_warning", nvTemp: "nvme_temperature_celsius", nvUsed: "nvme_percentage_used_ratio", nvHours: "nvme_power_on_hours_total", nvErr: "nvme_media_errors_total",
  };
  const keys = Object.keys(q) as (keyof typeof q)[];
  const [names, ...res] = await Promise.all([machineNames(ctx), ...keys.map((k) => vector(ctx, q[k]).catch(() => [] as Sample[]))]);
  const r = Object.fromEntries(keys.map((k, i) => [k, res[i]!])) as Record<keyof typeof q, Sample[]>;
  const find = (list: Sample[], inst: string, label: string, v: string) => list.find((s) => s.metric.instance === inst && s.metric[label] === v);
  const machineOf = (m: Record<string, string>) => names.get(m.instance ?? "") ?? friendlyName(m);
  const out: Disk[] = [];
  for (const s of r.healthy) {
    const inst = s.metric.instance ?? "", disk = s.metric.disk ?? "";
    const info = find(r.info, inst, "disk", disk)?.metric ?? {};
    out.push({ instance: inst, machine: machineOf(s.metric), disk, model: info.device_model ?? info.model_name ?? "", serial: info.serial_number ?? "", type: s.metric.type ?? "", healthy: s.value === null ? null : s.value === 1, temperature: find(r.temp, inst, "disk", disk)?.value ?? null, poweredOnSec: (find(r.hours, inst, "disk", disk)?.value ?? null) === null ? null : find(r.hours, inst, "disk", disk)!.value! * 3600, lifeLeft: find(r.life, inst, "disk", disk)?.value ?? null, mediaErrors: null });
  }
  for (const s of r.nvWarn) {
    const inst = s.metric.instance ?? "", dev = s.metric.device ?? "";
    // smartmon names the controller /dev/nvme0; the NVMe collector names the namespace nvme0n1.
    const ctrl = `/dev/${dev.replace(/n\d+$/, "")}`;
    const used = find(r.nvUsed, inst, "device", dev)?.value ?? null;
    const extra = { temperature: find(r.nvTemp, inst, "device", dev)?.value ?? null, lifeLeft: used === null ? null : round(100 * (1 - used), 1), mediaErrors: find(r.nvErr, inst, "device", dev)?.value ?? null };
    const hours = find(r.nvHours, inst, "device", dev)?.value ?? null;
    const twin = out.find((d) => d.instance === inst && d.disk === ctrl);
    if (twin) {
      twin.temperature ??= extra.temperature;
      twin.lifeLeft ??= extra.lifeLeft;
      twin.mediaErrors ??= extra.mediaErrors;
      twin.poweredOnSec ??= hours === null ? null : hours * 3600;
      continue;
    }
    out.push({ instance: inst, machine: machineOf(s.metric), disk: `/dev/${dev}`, model: "", serial: "", type: "nvme", healthy: s.value === null ? null : s.value === 0, ...extra, poweredOnSec: hours === null ? null : hours * 3600 });
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine, "en", { sensitivity: "base" }) || a.disk.localeCompare(b.disk));
}

// ---- Metric descriptions (the browser's hints) ----

const CURATED: Record<string, string> = {
  smartmon_device_smart_healthy: "Whether the disk's own SMART check passes (1 = healthy).",
  node_cpu_seconds_total: "Seconds the processors spent in each mode (idle, user, system).",
  container_last_seen: "When cAdvisor last saw the container (a time).",
  pve_up: "Whether a Proxmox node, guest or storage is up (1 = up).",
  up: "Whether Prometheus could scrape the target (1 = up).",
  ALERTS: "Alerts that are pending or firing.",
};

function parentOf(name: string): string[] {
  const out = [name];
  for (const suf of ["_bucket", "_sum", "_count", "_total", "_created", "_info"]) if (name.endsWith(suf)) out.push(name.slice(0, -suf.length));
  return out;
}

// ---- The guided metric browser ----

const HOW = ["asis", "rate", "sum", "sumRate", "avg", "max", "min", "p95"] as const;

function exploreQuery(params: Record<string, unknown>): { query: string; split?: string; metric: string } {
  const metric = metricName(params.metric);
  const how = (str(params.how) || "asis") as (typeof HOW)[number];
  if (!(HOW as readonly string[]).includes(how)) fail("config", `"${how}" is not a way Atrium can show a metric.`);
  const m: string[] = [];
  const machine = str(params.machine).trim();
  if (machine && machine !== EVERY) m.push(`instance=${lit(machine)}`);
  const fl = str(params.filterLabel).trim();
  const fv = str(params.filterValue).trim();
  if (fl && fv) m.push(`${labelName(fl)}=${lit(fv)}`);
  const split = str(params.splitBy).trim() ? labelName(params.splitBy, "split by") : undefined;
  const sel = (name: string) => (m.length ? `${name}{${m.join(",")}}` : name);
  const by = split ? ` by (${split})` : "";
  let query: string;
  switch (how) {
    case "asis": query = split ? `sum${by} (${sel(metric)})` : sel(metric); break;
    case "rate": query = split ? `sum${by} (rate(${sel(metric)}[5m]))` : `rate(${sel(metric)}[5m])`; break;
    case "sumRate": query = `sum${by} (rate(${sel(metric)}[5m]))`; break;
    case "p95": {
      const bucket = metric.endsWith("_bucket") ? metric : `${metric.replace(/_(sum|count)$/, "")}_bucket`;
      query = `histogram_quantile(0.95, sum by (le${split ? `, ${split}` : ""}) (rate(${sel(bucket)}[5m])))`;
      break;
    }
    default: query = `${how}${by} (${sel(metric)})`;
  }
  return { query, metric, ...(split ? { split } : {}) };
}

export const SPECIAL_READS: Record<string, ReadFn> = {
  async targets(ctx) {
    const data = obj(await api(ctx, "api/v1/targets", { state: "active" }), "targets");
    const items = arr(data.activeTargets, "target list").map((t) => {
      const target = obj(t, "target");
      const labels = Object.fromEntries(Object.entries(obj(target.labels ?? {}, "labels")).map(([k, v]) => [k, str(v)]));
      const health = str(target.health);
      return {
        label: `${labels.job ?? "job"}: ${friendlyName(labels)}`,
        state: (health === "up" ? "up" : health === "down" ? "down" : "unknown") as "up" | "down" | "unknown",
        detail: str(target.lastError) ? str(target.lastError).slice(0, 300) : withoutPort(labels.instance ?? ""),
      };
    });
    const rank = { down: 0, unknown: 1, up: 2 } as const;
    items.sort((a, b) => rank[a.state] - rank[b.state] || a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
    return { data: { kind: "status", items } };
  },

  async query(ctx, params) {
    const query = param(params, "query");
    const data = obj(await api(ctx, "api/v1/query", { query }), "query result");
    const type = str(data.resultType);
    if (type === "scalar" || type === "string") {
      const raw = arr(data.result, "result")[1];
      return { data: { kind: "stat", value: num(raw) ?? str(raw), label: "Result", ...unitOf(params) } };
    }
    if (type !== "vector") fail("bad_response", `An instant query must return values, not a ${type || "different result"}.`, "Use a query without a [range], or use Custom PromQL: over time.");
    const samples = arr(data.result, "result").map((r) => {
      const s = obj(r, "series");
      return { metric: Object.fromEntries(Object.entries(obj(s.metric ?? {}, "labels")).map(([k, v]) => [k, str(v)])), value: num(arr(s.value, "sample")[1]) };
    });
    if (!samples.length) fail("bad_response", "The query returned no series.", "Check the metric name and labels.");
    if (samples.length === 1) {
      const display = seriesDisplays([samples[0]!.metric])[0]!;
      return { data: { kind: "stat", value: samples[0]!.value ?? 0, label: display === "value" ? "Result" : display, ...unitOf(params) } };
    }
    // Research 5.9: several series come back as rows instead of failing.
    return { data: rowsOf(samples, await machineNames(ctx), typeof params.unit === "string" && params.unit ? `Value (${params.unit})` : "Value") };
  },

  async range(ctx, params) {
    const query = param(params, "query");
    const rangeSec = Math.min(Math.max(num(params.rangeSec) ?? 3600, 60), 30 * 86400);
    const stepSec = Math.max(num(params.stepSec) ?? 60, Math.ceil(rangeSec / 10_000), 1);
    const end = Math.floor(ctx.now().getTime() / 1000);
    const [{ lines, total }, names] = await Promise.all([matrix(ctx, query, { start: end - rangeSec, end, step: stepSec }), machineNames(ctx)]);
    const displays = seriesDisplays(lines.map((l) => l.metric), names);
    // Amendment A4.1: `total` is the full result count before Atrium trims it to 20.
    const series = lines.map((l, i) => ({ name: legacyName(l.metric), display: displays[i]!, points: l.points }));
    return { data: { kind: "series", series, total, ...unitOf(params) } };
  },

  async alerts(ctx) {
    const data = obj(await api(ctx, "api/v1/alerts"), "alerts");
    const items = arr(data.alerts, "alert list").flatMap((a) => {
      const o = obj(a, "alert");
      const labels = Object.fromEntries(Object.entries(obj(o.labels ?? {}, "labels")).map(([k, v]) => [k, str(v)]));
      const ann = Object.fromEntries(Object.entries(obj(o.annotations ?? {}, "annotations")).map(([k, v]) => [k, str(v)]));
      const st = str(o.state);
      if (st !== "firing" && st !== "pending") return [];
      const sev = (labels.severity ?? "").toLowerCase();
      const state: "down" | "warn" | "unknown" = st === "pending" ? "warn" : sev === "critical" || sev === "page" ? "down" : sev === "warning" ? "warn" : "unknown";
      const who = labels.name ?? labels.storage ?? labels.host ?? (labels.instance ? withoutPort(labels.instance) : "");
      const label = ann.summary || [labels.alertname, who].filter(Boolean).join(": ") || "Alert";
      const detail = (ann.description || (st === "pending" ? "Pending" : sev ? `Severity ${sev}` : "")).slice(0, 300);
      return [{ label: label.slice(0, 200), state, ...(detail ? { detail } : {}) }];
    });
    const rank = { down: 0, warn: 1, unknown: 2 } as const;
    items.sort((a, b) => rank[a.state] - rank[b.state] || a.label.localeCompare(b.label));
    return { data: { kind: "status", items } };
  },

  async "alerts-count"(ctx) {
    const data = obj(await api(ctx, "api/v1/alerts"), "alerts");
    const n = arr(data.alerts, "alert list").filter((a) => str(obj(a, "alert").state) === "firing").length;
    return { data: { kind: "stat", value: n, label: "Firing alerts", format: "number" } };
  },

  async "disk-health"(ctx) {
    const disks = await diskList(ctx);
    const items = disks.map((d) => {
      const bits = [d.temperature !== null ? `${round(d.temperature, 0)} °C` : "", d.lifeLeft !== null ? `${round(d.lifeLeft, 0)} % life left` : "", d.mediaErrors ? `${d.mediaErrors} media errors` : ""].filter(Boolean);
      return { label: `${d.machine} ${d.disk}${d.model ? ` (${d.model})` : ""}`, state: (d.healthy === null ? "unknown" : d.healthy ? "up" : "down") as "up" | "down" | "unknown", ...(bits.length ? { detail: bits.join(" · ") } : {}) };
    });
    const rank = { down: 0, unknown: 1, up: 2 } as const;
    items.sort((a, b) => rank[a.state] - rank[b.state]);
    return { data: { kind: "status", items } };
  },

  async "disks-smart"(ctx) {
    const rows = (await diskList(ctx)).map((d) => ({ machine: d.machine, disk: d.disk, model: d.model, serial: d.serial, type: d.type, healthy: d.healthy === null ? "unknown" : d.healthy ? "up" : "down", temperature: d.temperature, poweredOn: d.poweredOnSec, lifeLeft: d.lifeLeft, mediaErrors: d.mediaErrors }));
    return {
      data: {
        kind: "table",
        columns: [
          { key: "machine", label: "Machine", type: "text" }, { key: "disk", label: "Disk", type: "text" }, { key: "model", label: "Model", type: "text" }, { key: "serial", label: "Serial", type: "text" }, { key: "type", label: "Type", type: "text" },
          { key: "healthy", label: "Healthy", type: "status" }, { key: "temperature", label: "Temperature", type: "number", format: "celsius" }, { key: "poweredOn", label: "Powered on", type: "number", format: "seconds" },
          { key: "lifeLeft", label: "Life left", type: "number", format: "percent" }, { key: "mediaErrors", label: "Media errors", type: "number", format: "number" },
        ],
        rows,
        total: rows.length,
      },
    };
  },

  async metrics(ctx) {
    const [names, meta] = await Promise.all([metricNames(ctx), api(ctx, "api/v1/metadata").catch(() => ({}))]);
    const md = (meta && typeof meta === "object" ? meta : {}) as Record<string, { type?: string; help?: string }[] | undefined>;
    const rows = names.map((name) => {
      const parent = parentOf(name).find((p) => md[p]?.[0]);
      const m = parent ? md[parent]![0]! : undefined;
      const description = CURATED[name] ?? (m?.help ? `${m.help}${parent !== name ? ` (${name.slice(parent!.length + 1)} part)` : ""}` : "");
      return { name, description: description.slice(0, 200), type: str(m?.type) || (name.includes(":") ? "recording rule" : "") };
    });
    return { data: { kind: "table", columns: [{ key: "name", label: "Metric", type: "text" }, { key: "description", label: "What it is", type: "text" }, { key: "type", label: "Type", type: "text" }], rows, total: rows.length } };
  },

  async "metric-labels"(ctx, params) {
    const metric = metricName(params.metric);
    const series = arr(await api(ctx, "api/v1/series", { "match[]": metric, limit: "2000" }), "series");
    const values = new Map<string, Set<string>>();
    for (const s of series) for (const [k, v] of Object.entries(obj(s, "series"))) if (k !== "__name__") (values.get(k) ?? values.set(k, new Set()).get(k)!).add(str(v));
    const rows = [...values].map(([label, set]) => {
      const ex = [...set].slice(0, 3).join(", ");
      return { label, values: set.size, detail: `${set.size} value${set.size === 1 ? "" : "s"}${ex ? `, for example ${ex}` : ""}`.slice(0, 200) };
    }).sort((a, b) => a.label.localeCompare(b.label));
    return { data: { kind: "table", columns: [{ key: "label", label: "Label", type: "text" }, { key: "values", label: "Values", type: "number" }, { key: "detail", label: "Detail", type: "text" }], rows, total: rows.length } };
  },

  async "metric-label-values"(ctx, params) {
    const metric = metricName(params.metric);
    const label = labelName(params.label);
    const [vals, names] = await Promise.all([api(ctx, `api/v1/label/${label}/values`, { "match[]": metric }), label === "instance" ? machineNames(ctx) : Promise.resolve(new Map<string, string>())]);
    const rows = arr(vals, "label values").map((v) => ({ value: str(v), name: names.get(str(v)) ?? str(v) })).slice(0, 2000);
    return { data: { kind: "table", columns: [{ key: "value", label: "Value", type: "text" }, { key: "name", label: "Name", type: "text" }], rows, total: rows.length } };
  },

  async "explore-value"(ctx, params) {
    const { query, split, metric } = exploreQuery(params);
    const [samples, names] = await Promise.all([vector(ctx, query), machineNames(ctx)]);
    if (!samples.length) fail("bad_response", "Prometheus has no values for that metric with these settings.", "Try another machine or filter, or no filter.");
    if (samples.length === 1 && !split) return { data: { kind: "stat", value: round(samples[0]!.value, 4) ?? 0, label: metric } };
    return { data: rowsOf(samples, names, metric, split ? (s) => (split === "instance" ? (names.get(s.metric.instance ?? "") ?? s.metric.instance ?? "") : (s.metric[split] ?? "")) : undefined) };
  },

  async "explore-history"(ctx, params) {
    const { query, split } = exploreQuery(params);
    const range = rangeFor(params.hours, ctx.now().getTime());
    const [{ lines, total }, names] = await Promise.all([matrix(ctx, query, range), machineNames(ctx)]);
    const displays = seriesDisplays(lines.map((l) => l.metric), names);
    const series = lines.map((l, i) => ({ name: legacyName(l.metric), display: split === "instance" ? (names.get(l.metric.instance ?? "") ?? displays[i]!) : split ? (l.metric[split] ?? displays[i]!) : displays[i]!, points: l.points }));
    return { data: { kind: "series", series, total } };
  },
};

/** Which special reads need which metrics (A8.1), in the same form as a recipe's `needs`. */
export const SPECIAL_NEEDS: Record<string, string[]> = {
  "disk-health": ["smartmon_device_smart_healthy", "nvme_critical_warning"],
  "disks-smart": ["smartmon_device_smart_healthy", "nvme_critical_warning"],
};
