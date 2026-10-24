// Check V2 for Wave 2.9 (A10.4): the data catalogue against a real Prometheus, GET only, in a
// throwaway database. Run with
//   ATRIUM_TEST_PROM_URL=<address from shared/constants.md> [ATRIUM_TEST_PROM_OUT=<file>] pnpm exec vitest run src/features/data/__tests__/catalogue-live.test.ts
// Skipped (never passed) without the variable. The catalogue must answer within 3 s.
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { setupRecipeDb } from "@/features/recipes/__tests__/harness";
import { owner } from "@/features/controls/__tests__/harness";

const URL_ = process.env.ATRIUM_TEST_PROM_URL;
if (URL_) setupRecipeDb();
vi.mock("@/features/auth", () => ({ getPrincipal: async () => owner }));

describe.skipIf(!URL_)("the data catalogue on a real Prometheus", () => {
  it("lists machines and reads within 3 s, and peeks values", async () => {
    const svc = await import("@/features/integrations/service");
    const cat = await import("../catalogue");
    const id = svc.createIntegration(owner, { packageId: "prometheus", name: "Live Prometheus", config: { baseUrl: URL_ }, secrets: {}, untested: true }).id;
    const runs: { q: string; ms: number; items: number; pending: number; first?: string }[] = [];
    for (const q of ["", "cpu", "memory", "cpu", "disk"]) {
      const t = Date.now();
      const r = await cat.buildCatalogue(owner, { q, fits: "stat", integrationId: id, limit: 200 });
      runs.push({ q: q || "(none)", ms: Date.now() - t, items: r.items.length, pending: r.pending.length, ...(r.items[0] ? { first: `${r.items[0].label}, ${r.items[0].thing?.label ?? "-"}` } : {}) });
    }
    const all = await cat.buildCatalogue(owner, { integrationId: id, limit: 200, q: "cpu" });
    const machines = all.items.filter((i) => i.endpointId === "machine-cpu" && i.thing && i.thing.value !== "*").length;
    const t = Date.now();
    const pk = await cat.peek(owner, all.items.slice(0, 10).map((i) => ({ integrationId: i.integrationId, endpointId: i.endpointId, params: i.params })));
    const peekMs = Date.now() - t;
    const out = { runs, machines, peekMs, peekOk: pk.values.filter((v) => v.data).length, peekErrors: pk.values.filter((v) => v.error).map((v) => v.error) };
    if (process.env.ATRIUM_TEST_PROM_OUT) writeFileSync(process.env.ATRIUM_TEST_PROM_OUT, JSON.stringify(out, null, 2));
    for (const r of runs) expect(r.ms).toBeLessThan(3000);
    expect(machines).toBeGreaterThan(0);
  }, 60_000);
});
