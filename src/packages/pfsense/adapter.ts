// pfSense community REST API (pfrest, v2) adapter. Read-only, GET only.
import type { AdapterContext } from "@/core/contracts";
import { arr, defineAdapter, getJson, obj, str } from "../lib";

const KEY = { auth: "apiKey", secretLabel: "REST API key" };

async function data(ctx: AdapterContext, path: string) {
  return obj(await getJson(ctx, path, KEY), "answer").data;
}

function gatewayState(status: string): "up" | "down" | "warn" | "unknown" {
  const s = status.toLowerCase();
  if (s === "online" || s === "none") return "up";
  if (s === "down" || s === "offline" || s === "force_down") return "down";
  if (s.includes("loss") || s.includes("delay") || s === "highdelay" || s === "highloss") return "warn";
  return "unknown";
}

export default defineAdapter({
  async health(ctx) {
    const v = obj(await data(ctx, "api/v2/system/version"), "version");
    return { status: "ok", version: str(v.version) || undefined };
  },
  reads: {
    async gateways(ctx) {
      const items = arr(await data(ctx, "api/v2/status/gateways"), "gateway list").map((g) => {
        const gw = obj(g, "gateway");
        const status = str(gw.status, "unknown");
        return { label: str(gw.name, "gateway"), state: gatewayState(status), detail: `${status}, delay ${str(gw.delay, "?")}, loss ${str(gw.loss, "?")}` };
      });
      return { data: { kind: "status", items } };
    },
    async interfaces(ctx) {
      const rows = arr(await data(ctx, "api/v2/status/interfaces"), "interface list").map((i) => {
        const itf = obj(i, "interface");
        const status = str(itf.status);
        return { name: str(itf.descr) || str(itf.name), device: str(itf.hwif) || str(itf.if), status: status === "up" ? "up" : status === "down" || status === "no carrier" ? "down" : "unknown", address: str(itf.ipaddr) };
      });
      return {
        data: {
          kind: "table",
          columns: [
            { key: "name", label: "Interface", type: "text" },
            { key: "device", label: "Device", type: "text" },
            { key: "status", label: "Status", type: "status" },
            { key: "address", label: "Address", type: "text" },
          ],
          rows,
          total: rows.length,
        },
      };
    },
    async "rule-count"(ctx) {
      const rules = arr(await data(ctx, "api/v2/firewall/rules"), "rule list");
      return { data: { kind: "stat", value: rules.length, label: "Firewall rules" } };
    },
  },
});
