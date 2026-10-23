// Docker Engine API adapter. The host only ever sends GET for this package.
import type { AdapterContext } from "@/core/contracts";
import { arr, defineAdapter, fail, getJson, num, obj, param, str } from "../lib";

async function containers(ctx: AdapterContext) {
  return arr(await getJson(ctx, "containers/json", { query: { all: "1" } }), "container list").map((c) => obj(c, "container"));
}

const name = (c: Record<string, unknown>) => (Array.isArray(c.Names) && c.Names.length ? str(c.Names[0]).replace(/^\//, "") : str(c.Id).slice(0, 12));

/** "Up 3 days (healthy)" gives "healthy"; no health check gives "". */
function health(status: string): string {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  return m ? (m[1] === "health: starting" ? "starting" : m[1]!) : "";
}

function row(c: Record<string, unknown>) {
  const status = str(c.Status);
  const h = health(status);
  return { name: name(c), image: str(c.Image), state: str(c.State), status, health: h === "healthy" ? "up" : h === "unhealthy" ? "down" : h === "starting" ? "warn" : "", detail: `${str(c.Image)} · ${str(c.State)}` };
}

const COLUMNS = [
  { key: "name", label: "Name", type: "text" as const },
  { key: "image", label: "Image", type: "text" as const },
  { key: "state", label: "State", type: "status" as const },
  { key: "status", label: "Status", type: "text" as const },
  { key: "health", label: "Health", type: "status" as const },
];

/**
 * CPU % and memory from one stats sample (GET containers/<id>/stats?stream=false). The id comes from
 * the container list, never from the person's text. A proxy that refuses stats leaves the cells empty.
 */
async function stats(ctx: AdapterContext, id: string): Promise<{ cpu: number | null; memory: number | null; memoryLimit: number | null }> {
  const none = { cpu: null, memory: null, memoryLimit: null };
  if (!/^[a-f0-9]{12,64}$/.test(id)) return none;
  try {
    const s = obj(await getJson(ctx, `containers/${id}/stats`, { query: { stream: "false" } }), "stats");
    const cpu = obj(s.cpu_stats ?? {}, "cpu stats"), pre = obj(s.precpu_stats ?? {}, "cpu stats");
    const total = (o: Record<string, unknown>) => num(obj(o.cpu_usage ?? {}, "cpu usage").total_usage);
    const dCpu = (total(cpu) ?? 0) - (total(pre) ?? 0), dSys = (num(cpu.system_cpu_usage) ?? 0) - (num(pre.system_cpu_usage) ?? 0);
    const cores = num(cpu.online_cpus) ?? 1;
    const mem = obj(s.memory_stats ?? {}, "memory stats");
    const usage = num(mem.usage);
    const inactive = num(obj(mem.stats ?? {}, "memory").inactive_file) ?? 0;
    return { cpu: dSys > 0 ? Math.round((dCpu / dSys) * cores * 1000) / 10 : null, memory: usage === null ? null : usage - inactive, memoryLimit: num(mem.limit) };
  } catch {
    return none;
  }
}

export default defineAdapter({
  async health(ctx) {
    const v = obj(await getJson(ctx, "version"), "version");
    return { status: "ok", version: str(v.Version) || undefined };
  },
  reads: {
    async containers(ctx) {
      const rows = (await containers(ctx)).map(row).sort((a, b) => a.name.localeCompare(b.name));
      return { data: { kind: "table", columns: [...COLUMNS, { key: "detail", label: "Detail", type: "text" }], rows, total: rows.length } };
    },
    async running(ctx) {
      const all = await containers(ctx);
      return { data: { kind: "stat", value: all.filter((c) => str(c.State) === "running").length, label: "Running containers", format: "number" } };
    },
    async unhealthy(ctx) {
      const all = (await containers(ctx)).map(row);
      return { data: { kind: "stat", value: all.filter((c) => c.health === "down").length, label: "Unhealthy containers", format: "number" } };
    },
    async container(ctx, params) {
      const picked = param(params, "container");
      const all = await containers(ctx);
      // A8.2: "*" is every container (no stats: one request each would be too many).
      if (picked === "*") {
        const rows = all.map(row).sort((a, b) => a.name.localeCompare(b.name));
        return { data: { kind: "table", columns: COLUMNS, rows, total: rows.length } };
      }
      const c = all.find((x) => name(x) === picked);
      if (!c) fail("config", `There is no container called "${picked.slice(0, 60)}".`, "Pick one from the list; it may have been removed or renamed.");
      const s = str(c.State) === "running" ? await stats(ctx, str(c.Id)) : { cpu: null, memory: null, memoryLimit: null };
      const r = { ...row(c), ...s };
      return {
        data: {
          kind: "table",
          columns: [...COLUMNS, { key: "cpu", label: "CPU", type: "number", format: "percent" }, { key: "memory", label: "Memory", type: "number", format: "bytes" }, { key: "memoryLimit", label: "Memory limit", type: "number", format: "bytes" }],
          rows: [r],
          total: 1,
        },
      };
    },
  },
});
