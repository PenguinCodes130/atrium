// Proxmox VE API adapter. Read-only, GET only, with an API token (PVEAPIToken header).
import type { AdapterContext } from "@/core/contracts";
import { arr, defineAdapter, fail, getJson, num, obj, param, str } from "../lib";

const TOKEN = { auth: "token", secretLabel: "API token" };

async function data(ctx: AdapterContext, path: string, query?: Record<string, string>) {
  return obj(await getJson(ctx, path, { ...TOKEN, ...(query ? { query } : {}) }), "answer").data;
}

async function nodes(ctx: AdapterContext) {
  return arr(await data(ctx, "api2/json/nodes"), "node list").map((n) => obj(n, "node"));
}

async function node(ctx: AdapterContext, name: string) {
  const n = (await nodes(ctx)).find((x) => str(x.node) === name);
  if (!n) fail("config", `There is no node called "${name}".`, "Check the node name, as shown in the Proxmox tree.");
  return n;
}

const pct = (a: number | null, b: number | null) => (a !== null && b ? Math.round((a / b) * 1000) / 10 : 0);

/** cluster/resources already carries CPU, memory and disk for every guest, so these columns cost no extra request. */
async function guestRows(ctx: AdapterContext) {
  return arr(await data(ctx, "api2/json/cluster/resources", { type: "vm" }), "resource list")
    .map((r) => obj(r, "resource"))
    .filter((r) => (r.type === "qemu" || r.type === "lxc") && r.template !== 1)
    .map((r) => {
      const kind = r.type === "lxc" ? "Container" : "VM";
      const node = str(r.node);
      const mem = num(r.mem), maxmem = num(r.maxmem);
      return {
        name: str(r.name) || `${str(r.type)} ${str(r.vmid)}`,
        id: str(r.id) || `${str(r.type)}/${str(r.vmid)}`,
        node,
        kind,
        state: str(r.status) === "running" ? "up" : str(r.status) === "stopped" ? "down" : "warn",
        cpu: num(r.cpu) === null ? null : Math.round(num(r.cpu)! * 1000) / 10,
        memory: maxmem ? pct(mem, maxmem) : null,
        memoryUsed: mem,
        disk: num(r.disk),
        diskSize: num(r.maxdisk),
        uptime: num(r.uptime) ?? 0,
        detail: `${kind} ${str(r.vmid)} on ${node}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

const GUEST_COLUMNS = [
  { key: "name", label: "Name", type: "text" as const },
  { key: "node", label: "Node", type: "text" as const },
  { key: "kind", label: "Type", type: "text" as const },
  { key: "state", label: "State", type: "status" as const },
  { key: "cpu", label: "CPU", type: "number" as const, format: "percent" as const },
  { key: "memory", label: "Memory", type: "number" as const, format: "percent" as const },
  { key: "memoryUsed", label: "Memory used", type: "number" as const, format: "bytes" as const },
  { key: "disk", label: "Disk used", type: "number" as const, format: "bytes" as const },
  { key: "diskSize", label: "Disk size", type: "number" as const, format: "bytes" as const },
  { key: "uptime", label: "Uptime", type: "number" as const, format: "seconds" as const },
  { key: "id", label: "Id", type: "text" as const },
  { key: "detail", label: "Detail", type: "text" as const },
];

export default defineAdapter({
  async health(ctx) {
    const v = obj(await data(ctx, "api2/json/version"), "version");
    return { status: "ok", version: str(v.version) || undefined };
  },
  reads: {
    async nodes(ctx) {
      const items = (await nodes(ctx)).map((n) => {
        const status = str(n.status);
        return { label: str(n.node), state: (status === "online" ? "up" : status === "offline" ? "down" : "unknown") as "up" | "down" | "unknown", detail: status };
      });
      return { data: { kind: "status", items } };
    },
    async "node-cpu"(ctx, params) {
      const n = await node(ctx, param(params, "node"));
      return { data: { kind: "stat", value: Math.round((num(n.cpu) ?? 0) * 1000) / 10, format: "percent", label: `${str(n.node)} CPU`, thresholds: { warn: 80, bad: 95 } } };
    },
    async "node-memory"(ctx, params) {
      const n = await node(ctx, param(params, "node"));
      return { data: { kind: "stat", value: pct(num(n.mem), num(n.maxmem)), format: "percent", label: `${str(n.node)} memory`, thresholds: { warn: 85, bad: 95 } } };
    },
    async guests(ctx) {
      const rows = await guestRows(ctx);
      return { data: { kind: "table", columns: GUEST_COLUMNS, rows, total: rows.length } };
    },
    async guest(ctx, params) {
      const id = param(params, "guest");
      const all = await guestRows(ctx);
      // A8.2: "*" is every guest; otherwise the one picked, by its stable id (qemu/101).
      const rows = id === "*" ? all : all.filter((r) => r.id === id);
      if (!rows.length) fail("config", `There is no VM or container "${id.slice(0, 40)}".`, "Pick one from the list; it may have been removed.");
      return { data: { kind: "table", columns: GUEST_COLUMNS, rows, total: rows.length } };
    },
    async storage(ctx) {
      const rows = arr(await data(ctx, "api2/json/cluster/resources", { type: "storage" }), "resource list")
        .map((r) => obj(r, "resource"))
        .filter((r) => r.type === "storage")
        .map((r) => {
          const used = num(r.disk), size = num(r.maxdisk);
          const status = str(r.status);
          return { storage: str(r.storage), node: str(r.node), type: str(r.plugintype), state: status === "available" ? "up" : status ? "down" : "unknown", used, size, free: used !== null && size !== null ? size - used : null, usedPct: size ? pct(used, size) : null, shared: r.shared === 1 || r.shared === true ? "Yes" : "No" };
        })
        .sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1));
      return {
        data: {
          kind: "table",
          columns: [
            { key: "storage", label: "Storage", type: "text" }, { key: "node", label: "Node", type: "text" }, { key: "type", label: "Type", type: "text" }, { key: "state", label: "State", type: "status" },
            { key: "used", label: "Used", type: "number", format: "bytes" }, { key: "size", label: "Size", type: "number", format: "bytes" }, { key: "free", label: "Free", type: "number", format: "bytes" },
            { key: "usedPct", label: "Used %", type: "number", format: "percent" }, { key: "shared", label: "Shared", type: "text" },
          ],
          rows,
          total: rows.length,
        },
      };
    },
  },
});
