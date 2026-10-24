// A10.6 the built-in `atrium/system` package: reachability of any address, the last health of a
// connected service, and the Atrium server's own stats. Everything runs on the server; nothing here
// sends a credential or reads another integration's config.
import { probeReach, ReachInputError } from "@/features/integrations/host/reach";
import { getIntegrationRow, listIntegrationRows, SYSTEM_INTEGRATION_ID } from "@/features/integrations/repo";
import { defineAdapter, fail, param } from "../lib";
import { HOST_LABELS, HOST_MEASURES, hostMeasure, hostStat } from "./host";

const healthState = { ok: "up", degraded: "warn", down: "down" } as const;

export default defineAdapter({
  async health() {
    return { status: "ok" };
  },
  reads: {
    async reach(_ctx, params) {
      let r;
      try {
        r = await probeReach(params.url);
      } catch (err) {
        if (err instanceof ReachInputError) fail("config", err.message);
        throw err;
      }
      const label = String(params.url ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "") || "Address";
      return { data: { kind: "status", items: [{ label, state: r.up ? "up" : "down", detail: r.up ? `${r.ms} ms` : (r.reason ?? "Down") }] } };
    },
    async health(_ctx, params) {
      const id = param(params, "integrationId");
      const row = id === SYSTEM_INTEGRATION_ID ? undefined : getIntegrationRow(id);
      if (!row) fail("config", "That service is not connected any more.", "Pick another service.");
      const h = row.lastHealth;
      if (row.status === "disabled") return { data: { kind: "status", items: [{ label: row.name, state: "unknown", detail: "Turned off" }] } };
      if (!h) return { data: { kind: "status", items: [{ label: row.name, state: "unknown", detail: "Not checked yet" }] } };
      return { data: { kind: "status", items: [{ label: row.name, state: healthState[h.status], detail: h.status === "down" ? (h.message?.slice(0, 120) ?? "Down") : `${h.latencyMs} ms` }] }, sourceTimestamp: h.checkedAt };
    },
    async host(_ctx, params) {
      return { data: await hostStat(hostMeasure(params.measure)) };
    },
    // Only shared services are listed here: the choices route answers each person's own list instead.
    async integrations() {
      const rows = listIntegrationRows().filter((r) => r.id !== SYSTEM_INTEGRATION_ID && r.status === "active" && r.shared).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
      return { data: { kind: "table", columns: [{ key: "id", label: "Id", type: "text" }, { key: "name", label: "Name", type: "text" }, { key: "detail", label: "Package", type: "text" }], rows: rows.map((r) => ({ id: r.id, name: r.name, detail: r.packageId })), total: rows.length } };
    },
    async "host-measures"() {
      const rows = HOST_MEASURES.map((m) => ({ value: m, label: HOST_LABELS[m].label }));
      return { data: { kind: "table", columns: [{ key: "value", label: "Measure", type: "text" }, { key: "label", label: "Name", type: "text" }], rows, total: rows.length } };
    },
  },
});
