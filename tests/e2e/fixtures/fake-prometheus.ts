// A stand-in Prometheus for e2e tests (Wave 2.7, data ease spec V11). It answers the HTTP API v1
// reads Atrium's Prometheus package sends, for 9 node-exporter machines shaped like the operator's
// server: 8 carry a `host` label, and RP5-3's exporter is `host.docker.internal:9100` with no host
// label, so its friendly name must come from node_uname_info's nodename. cAdvisor, the Proxmox
// exporter, smartmon, NVMe and alert rules are absent, so reads that need them count as not
// available. GET only (anything else answers 405). No credentials anywhere.
//
//   const prom = await startFakePrometheus();      // or startFakePrometheus(9391)
//   ... connect a Prometheus integration to prom.url ...
//   prom.setHost("10.77.99.8:9100", "ACE-renamed"); // criterion 4: rename a machine in "Prometheus"
//   await prom.close();
//
// The query engine is keyword based, not real PromQL: it recognises the metric names in the query,
// an `instance="..."` filter, a `mountpoint="..."` filter and `topk(N, ...)`, and answers one sample
// per machine (per mount for filesystem metrics) with the machine's target labels. Values are fixed
// per machine so tests can assert them (ACE: CPU 7.8 %, memory 41.2 %, root disk 52.3 %).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type FakeMachine = {
  instance: string;
  host?: string;
  nodename: string;
  arch: "x86_64" | "aarch64";
  cores: number;
  memGiB: number;
  cpu: number; // % in use
  mem: number; // % in use
  disk: number; // % of / in use
  netIn: number; // bytes per second
  netOut: number;
  load5: number;
  uptimeSec: number;
  temp?: number; // °C, absent on the three VMs
  updates?: number; // apt, only on the Proxmox hosts
  mounts: string[];
};

const GiB = 1024 ** 3;

/** The 9 machines, in the order the operator's server lists them. */
export const FAKE_MACHINES: readonly FakeMachine[] = [
  { instance: "10.77.99.8:9100", host: "ACE", nodename: "acebot", arch: "x86_64", cores: 4, memGiB: 16, cpu: 7.8, mem: 41.2, disk: 52.3, netIn: 3_100_000, netOut: 420_000, load5: 0.41, uptimeSec: 3 * 86400 + 4 * 3600, mounts: ["/"] },
  { instance: "10.77.99.11:9100", host: "firefly", nodename: "firefly", arch: "x86_64", cores: 8, memGiB: 32, cpu: 12.5, mem: 55.0, disk: 33.1, netIn: 1_200_000, netOut: 800_000, load5: 1.2, uptimeSec: 17 * 86400, temp: 48, mounts: ["/"] },
  { instance: "10.77.99.5:9100", host: "minipc-ubuntu", nodename: "minipc-ubuntu", arch: "x86_64", cores: 4, memGiB: 16, cpu: 3.2, mem: 30.3, disk: 18.0, netIn: 250_000, netOut: 90_000, load5: 0.15, uptimeSec: 9 * 86400 + 3600, mounts: ["/"] },
  { instance: "10.77.99.103:9100", host: "Pelican", nodename: "gs01", arch: "x86_64", cores: 4, memGiB: 8, cpu: 21.0, mem: 62.7, disk: 77.5, netIn: 5_600_000, netOut: 2_300_000, load5: 0.9, uptimeSec: 2 * 86400, mounts: ["/"] },
  { instance: "10.77.99.4:9100", host: "pve1", nodename: "proxmox", arch: "x86_64", cores: 12, memGiB: 64, cpu: 34.6, mem: 71.4, disk: 40.2, netIn: 12_400_000, netOut: 6_100_000, load5: 3.4, uptimeSec: 41 * 86400, temp: 55, updates: 120, mounts: ["/", "/data"] },
  { instance: "10.77.99.10:9100", host: "pve2", nodename: "pve2", arch: "x86_64", cores: 8, memGiB: 32, cpu: 18.2, mem: 48.9, disk: 61.0, netIn: 2_000_000, netOut: 1_500_000, load5: 1.6, uptimeSec: 20 * 86400, temp: 51, updates: 116, mounts: ["/"] },
  { instance: "10.77.110.20:9100", host: "pve3", nodename: "pve3", arch: "x86_64", cores: 8, memGiB: 32, cpu: 9.9, mem: 39.5, disk: 22.7, netIn: 900_000, netOut: 700_000, load5: 0.8, uptimeSec: 20 * 86400 + 7200, temp: 47, updates: 73, mounts: ["/"] },
  { instance: "10.77.99.6:9100", host: "RP5-2", nodename: "RP5-2", arch: "aarch64", cores: 4, memGiB: 8, cpu: 4.4, mem: 25.6, disk: 45.5, netIn: 600_000, netOut: 300_000, load5: 0.3, uptimeSec: 60 * 86400, temp: 52.5, mounts: ["/"] },
  { instance: "host.docker.internal:9100", nodename: "RP5-3", arch: "aarch64", cores: 4, memGiB: 8, cpu: 15.1, mem: 58.1, disk: 66.6, netIn: 1_800_000, netOut: 1_100_000, load5: 0.7, uptimeSec: 12 * 86400, temp: 61.2, mounts: ["/"] },
];

const OTHER_TARGETS = [{ instance: "localhost:9090", job: "prometheus", host: "RP5-3" }];

const METRIC_NAMES = [
  "node_boot_time_seconds", "node_cpu_seconds_total", "node_filesystem_avail_bytes", "node_filesystem_size_bytes", "node_hwmon_temp_celsius", "node_load1", "node_load15", "node_load5",
  "node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes", "node_network_receive_bytes_total", "node_network_transmit_bytes_total", "node_reboot_required", "node_thermal_zone_temp",
  "node_uname_info", "apt_upgrades_pending", "prometheus_build_info", "up",
];

const METADATA: Record<string, { type: string; help: string; unit: string }[]> = {
  node_boot_time_seconds: [{ type: "gauge", help: "Node boot time, in unixtime.", unit: "" }],
  node_cpu_seconds_total: [{ type: "counter", help: "Seconds the CPUs spent in each mode.", unit: "" }],
  node_filesystem_avail_bytes: [{ type: "gauge", help: "Filesystem space available to non-root users in bytes.", unit: "" }],
  node_filesystem_size_bytes: [{ type: "gauge", help: "Filesystem size in bytes.", unit: "" }],
  node_hwmon_temp_celsius: [{ type: "gauge", help: "Hardware monitor for temperature (input)", unit: "" }],
  node_load1: [{ type: "gauge", help: "1m load average.", unit: "" }],
  node_load5: [{ type: "gauge", help: "5m load average.", unit: "" }],
  node_load15: [{ type: "gauge", help: "15m load average.", unit: "" }],
  node_memory_MemAvailable_bytes: [{ type: "gauge", help: "Memory information field MemAvailable_bytes.", unit: "" }],
  node_memory_MemTotal_bytes: [{ type: "gauge", help: "Memory information field MemTotal_bytes.", unit: "" }],
  node_network_receive_bytes_total: [{ type: "counter", help: "Network device statistic receive_bytes.", unit: "" }],
  node_network_transmit_bytes_total: [{ type: "counter", help: "Network device statistic transmit_bytes.", unit: "" }],
  node_uname_info: [{ type: "gauge", help: "Labeled system information as provided by the uname system call.", unit: "" }],
  up: [{ type: "gauge", help: "Whether the target is up.", unit: "" }],
};

type Sample = { metric: Record<string, string>; value: number };

export type FakePrometheus = {
  url: string;
  port: number;
  /** Every request, in order (method and URL), for "GET only" and "no secret" checks. */
  hits: { method: string; url: string }[];
  /** Changes (or removes, with undefined) a machine's `host` label, as a scrape config edit would. */
  setHost(instance: string, host: string | undefined): void;
  /** Marks a machine down: `up` answers 0 and its other metrics disappear. */
  setDown(instance: string, down: boolean): void;
  close(): Promise<void>;
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function unquote(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** Answers one query as samples. Keyword based; see the header comment. */
function evaluate(q: string, machines: FakeMachine[], hosts: Map<string, string | undefined>, down: Set<string>): Sample[] {
  // "a or b": every sample of a, plus the samples of b for instances a has none for.
  const parts = q.split(/\)\s+or\s+/);
  if (parts.length > 1) {
    const seen = new Set<string>();
    const out: Sample[] = [];
    for (const [i, part] of parts.entries()) {
      for (const s of evaluate(i < parts.length - 1 ? `${part})` : part, machines, hosts, down)) {
        const k = s.metric.instance ?? "";
        if (i > 0 && seen.has(k)) continue;
        seen.add(k);
        out.push(s);
      }
    }
    return out;
  }
  if (/container_|pve_|smartmon_|nvme_|ALERTS|kube_/.test(q)) return [];
  const inst = /instance="((?:[^"\\]|\\.)*)"/.exec(q);
  const only = inst ? unquote(inst[1]!) : undefined;
  const mountM = /mountpoint="((?:[^"\\]|\\.)*)"/.exec(q);
  const mountOnly = mountM ? unquote(mountM[1]!) : undefined;
  const labelsOf = (m: FakeMachine): Record<string, string> => {
    const host = hosts.has(m.instance) ? hosts.get(m.instance) : m.host;
    return { instance: m.instance, job: "node-exporter", ...(host ? { host } : {}) };
  };
  const pool = machines.filter((m) => !only || m.instance === only);
  const live = pool.filter((m) => !down.has(m.instance));
  const per = (f: (m: FakeMachine) => number | undefined, extra?: (m: FakeMachine) => Record<string, string>): Sample[] =>
    live.flatMap((m) => {
      const v = f(m);
      return v === undefined ? [] : [{ metric: { ...labelsOf(m), ...(extra ? extra(m) : {}) }, value: v }];
    });
  let out: Sample[];
  if (/\bup\b/.test(q) && !/node_/.test(q)) {
    out = pool.map((m) => ({ metric: labelsOf(m), value: down.has(m.instance) ? 0 : 1 }));
    if (!only && !/job=/.test(q)) out.push(...OTHER_TARGETS.map((t) => ({ metric: { instance: t.instance, job: t.job, host: t.host }, value: 1 })));
  } else if (q.includes("node_uname_info")) {
    // last_over_time keeps a machine that is down right now, as the real server does for a day.
    const src = q.includes("last_over_time") ? pool : live;
    out = src.map((m) => ({ metric: { ...labelsOf(m), nodename: m.nodename, sysname: "Linux", release: m.arch === "aarch64" ? "6.8.0-1065-raspi" : "6.8.0-142-generic", machine: m.arch, domainname: "(none)" }, value: 1 }));
  } else if (q.includes("node_cpu_seconds_total")) {
    out = /count/.test(q) ? per((m) => m.cores) : per((m) => m.cpu);
  } else if (q.includes("node_memory_MemAvailable_bytes")) {
    if (/\/\s*node_memory_MemTotal_bytes/.test(q)) out = per((m) => m.mem);
    else out = per((m) => (m.memGiB * GiB * m.mem) / 100);
  } else if (q.includes("node_memory_MemTotal_bytes")) {
    out = per((m) => m.memGiB * GiB);
  } else if (q.includes("node_filesystem_")) {
    const size = (m: FakeMachine, mount: string) => (mount === "/" ? 100 : 500) * GiB * (m.cores / 4);
    const used = (m: FakeMachine, mount: string) => (mount === "/" ? m.disk : 12.5);
    out = live.flatMap((m) =>
      m.mounts.filter((mt) => !mountOnly || mt === mountOnly).map((mt) => {
        const labels = { ...labelsOf(m), mountpoint: mt, device: mt === "/" ? "/dev/sda2" : "/dev/sdb1", fstype: "ext4" };
        const pct = used(m, mt);
        const avail = size(m, mt) * (1 - pct / 100);
        const value = /\/\s*node_filesystem_size_bytes/.test(q) ? pct : /size_bytes[^-]*-\s*node_filesystem_avail_bytes/.test(q) ? size(m, mt) - avail : q.includes("avail_bytes") ? avail : size(m, mt);
        return { metric: labels, value };
      }),
    );
  } else if (q.includes("node_network_receive")) {
    out = per((m) => m.netIn);
  } else if (q.includes("node_network_transmit")) {
    out = per((m) => m.netOut);
  } else if (/node_load(1|5|15)\b/.test(q)) {
    const which = /node_load(1|5|15)\b/.exec(q)![1];
    out = per((m) => (which === "1" ? m.load5 * 1.1 : which === "15" ? m.load5 * 0.9 : m.load5));
  } else if (q.includes("node_boot_time_seconds")) {
    out = per((m) => m.uptimeSec);
  } else if (q.includes("node_hwmon_temp_celsius")) {
    out = per((m) => (m.arch === "x86_64" ? m.temp : undefined));
  } else if (q.includes("node_thermal_zone_temp")) {
    out = per((m) => (m.arch === "aarch64" ? m.temp : undefined));
  } else if (q.includes("apt_upgrades_pending")) {
    out = per((m) => m.updates);
  } else if (q.includes("node_reboot_required")) {
    out = per((m) => (m.updates === undefined ? undefined : 0));
  } else if (/count\(up\)/.test(q)) {
    out = [{ metric: {}, value: machines.length + OTHER_TARGETS.length }];
  } else {
    out = [];
  }
  const top = /topk\(\s*(\d+)\s*,/.exec(q);
  if (top) out = [...out].sort((a, b) => b.value - a.value).slice(0, Number(top[1]));
  if (/^\s*count\s*\(/.test(q) && !/by\s*\(/.test(q)) out = out.length ? [{ metric: {}, value: out.length }] : [];
  return out;
}

export async function startFakePrometheus(port = 0): Promise<FakePrometheus> {
  const hits: FakePrometheus["hits"] = [];
  const machines = [...FAKE_MACHINES];
  const hosts = new Map<string, string | undefined>();
  const down = new Set<string>();
  const now = () => Date.now() / 1000;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.method !== "GET") return json(res, 405, { status: "error", errorType: "method", error: "this stand-in answers GET only" });
    const u = new URL(req.url ?? "/", "http://fake");
    const p = u.pathname;
    if (p === "/-/healthy") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("Prometheus Server is Healthy.\n");
    }
    if (p === "/api/v1/status/buildinfo") return json(res, 200, { status: "success", data: { version: "3.14.0", revision: "fake", branch: "HEAD", goVersion: "go1.25" } });
    if (p === "/api/v1/targets") {
      const activeTargets = [
        ...machines.map((m) => {
          const host = hosts.has(m.instance) ? hosts.get(m.instance) : m.host;
          const isDown = down.has(m.instance);
          return { labels: { instance: m.instance, job: "node-exporter", ...(host ? { host } : {}) }, scrapePool: "node-exporter", scrapeUrl: `http://${m.instance}/metrics`, health: isDown ? "down" : "up", lastError: isDown ? "context deadline exceeded" : "", lastScrape: new Date().toISOString() };
        }),
        ...OTHER_TARGETS.map((t) => ({ labels: { instance: t.instance, job: t.job, host: t.host }, scrapePool: t.job, scrapeUrl: `http://${t.instance}/metrics`, health: "up", lastError: "", lastScrape: new Date().toISOString() })),
      ];
      return json(res, 200, { status: "success", data: { activeTargets, droppedTargets: [] } });
    }
    if (p === "/api/v1/query") {
      const q = u.searchParams.get("query") ?? "";
      if (!q.trim() || /[{(]\s*$/.test(q)) return json(res, 400, { status: "error", errorType: "bad_data", error: `1:${q.length + 1}: parse error: unexpected end of input` });
      const t = Number(u.searchParams.get("time")) || now();
      const result = evaluate(q, machines, hosts, down).map((s) => ({ metric: s.metric, value: [t, String(s.value)] }));
      return json(res, 200, { status: "success", data: { resultType: "vector", result } });
    }
    if (p === "/api/v1/query_range") {
      const q = u.searchParams.get("query") ?? "";
      const end = Number(u.searchParams.get("end")) || now();
      const start = Number(u.searchParams.get("start")) || end - 3600;
      const step = Math.max(Number(u.searchParams.get("step")) || 60, 1);
      const samples = evaluate(q, machines, hosts, down);
      const result = samples.map((s, i) => {
        const values: [number, string][] = [];
        for (let t = start, k = 0; t <= end && k < 11_000; t += step, k++) values.push([t, String(+(s.value * (1 + 0.1 * Math.sin(k / 5 + i))).toFixed(4))]);
        return { metric: s.metric, values };
      });
      return json(res, 200, { status: "success", data: { resultType: "matrix", result } });
    }
    const lv = /^\/api\/v1\/label\/([^/]+)\/values$/.exec(p);
    if (lv) {
      const name = decodeURIComponent(lv[1]!);
      const data =
        name === "__name__" ? METRIC_NAMES
        : name === "instance" ? [...machines.map((m) => m.instance), ...OTHER_TARGETS.map((t) => t.instance)]
        : name === "job" ? ["node-exporter", "prometheus"]
        : name === "host" ? [...new Set(machines.map((m) => (hosts.has(m.instance) ? hosts.get(m.instance) : m.host)).filter((h): h is string => !!h)), "gs01"] // a stale name, as the real server lists
        : name === "mountpoint" ? ["/", "/data"]
        : [];
      return json(res, 200, { status: "success", data });
    }
    if (p === "/api/v1/metadata") {
      const metric = u.searchParams.get("metric");
      return json(res, 200, { status: "success", data: metric ? (METADATA[metric] ? { [metric]: METADATA[metric] } : {}) : METADATA });
    }
    if (p === "/api/v1/series") {
      const matches = u.searchParams.getAll("match[]");
      const data = matches.flatMap((m) => {
        const name = /^\s*([A-Za-z_:][A-Za-z0-9_:]*)/.exec(m)?.[1] ?? "";
        if (!METRIC_NAMES.includes(name)) return [];
        return evaluate(m, machines, hosts, down).map((s) => ({ __name__: name, ...s.metric }));
      });
      const limit = Number(u.searchParams.get("limit")) || 0;
      return json(res, 200, { status: "success", data: limit ? data.slice(0, limit) : data });
    }
    if (p === "/api/v1/alerts") return json(res, 200, { status: "success", data: { alerts: [] } });
    if (p === "/api/v1/rules") return json(res, 200, { status: "success", data: { groups: [] } });
    json(res, 404, { status: "error", errorType: "not_found", error: "not found" });
  };

  const s = createServer(handler);
  await new Promise<void>((r) => s.listen(port, "127.0.0.1", () => r()));
  const bound = (s.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    hits,
    setHost(instance, host) { hosts.set(instance, host); },
    setDown(instance, isDown) { if (isDown) down.add(instance); else down.delete(instance); },
    close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }),
  };
}
