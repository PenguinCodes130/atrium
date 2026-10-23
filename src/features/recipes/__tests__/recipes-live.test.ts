// Check V2 for Wave 2.8: Grafana dashboard 1860 (downloaded once from grafana.com by id) imported onto
// the operator's real Prometheus, the live check run, and the built-in recipe reads checked. Run with
//   ATRIUM_TEST_PROM_URL=http://10.77.99.7:9090 [ATRIUM_TEST_GRAFANA_DOWNLOAD=1] [ATRIUM_TEST_RECIPES_OUT=<file>] pnpm exec vitest run src/features/recipes/__tests__/recipes-live.test.ts
// Skipped (never passed) without the variable. Only the reads' own GET requests reach Prometheus.
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { owner } from "@/features/controls/__tests__/harness";
import { setupRecipeDb } from "./harness";

const URL_ = process.env.ATRIUM_TEST_PROM_URL;
if (URL_) setupRecipeDb();
vi.mock("@/features/auth", () => ({ getPrincipal: async () => null }));

describe.skipIf(!URL_)(`recipes against ${URL_}`, () => {
  it("imports Grafana 1860 by id and at least 100 reads work, with the operator's machines in the dropdown", async () => {
    const isvc = await import("@/features/integrations/service");
    const svc = await import("../service");
    const check = await import("../check");
    const runtime = await import("@/features/integrations/runtime");
    const id = isvc.createIntegration(owner, { packageId: "prometheus", name: "rp5-3 Prometheus", config: { baseUrl: URL_! }, secrets: {}, untested: true }).id;
    const t0 = Date.now();
    // ATRIUM_TEST_GRAFANA_DOWNLOAD=1 downloads 1860 from grafana.com by id (done once for the r1 report); otherwise the saved copy.
    const json = process.env.ATRIUM_TEST_GRAFANA_DOWNLOAD === "1" ? undefined : JSON.stringify((await import("../__fixtures__/grafana-1860.json")).default);
    const r = await svc.importGrafana(owner, { integrationId: id, ...(json ? { json } : { dashboardId: "1860" }) });
    const tImport = Date.now() - t0;
    const t1 = Date.now();
    const res = await check.checkReads(id);
    const tCheck = Date.now() - t1;
    const lines: string[] = [];
    const count = (prefix: string) => {
      const mine = Object.entries(res).filter(([k]) => prefix ? k.startsWith(prefix) : !k.startsWith("r:"));
      const n = (st: string) => mine.filter(([, c]) => c.status === st).length;
      return { total: mine.length, ok: n("ok"), empty: n("empty"), failed: n("failed"), odd: n("odd"), list: mine };
    };
    const g = count("r:grafana/1860:");
    const b = count("");
    lines.push(`Grafana 1860 ${json ? "from the saved JSON" : "by id from grafana.com"}: ${r.reads} reads (${r.skipped.length} panels skipped), downloaded and mapped in ${tImport} ms; live check of ${Object.keys(res).length} reads in ${tCheck} ms (4 at a time, 5 s each)`);
    lines.push(`grafana/1860: ${g.ok} work, ${g.empty} empty, ${g.odd} look odd, ${g.failed} failed, of ${g.total}`);
    lines.push(`built-in recipes: ${b.ok} work, ${b.empty} empty, ${b.odd} look odd, ${b.failed} failed, of ${b.total}`);
    const machines = await runtime.readEndpoint(id, "r:grafana/1860:list-node", {}, undefined, { includeDrafts: true });
    const names = machines.ok && machines.data.kind === "table" ? machines.data.rows.map((x) => `${String(x.label)}${x.detail ? ` (${String(x.detail)})` : ""}`) : [];
    lines.push(`"Instance" dropdown (${names.length}): ${names.join(", ")}`);
    for (const s of r.skipped) lines.push(`skipped: ${s.title}: ${s.reason}`);
    lines.push("", "not working:");
    for (const [k, c] of [...g.list, ...b.list]) if (c.status !== "ok") lines.push(`  ${c.status.padEnd(6)} ${k}: ${c.reason ?? ""}`);
    if (process.env.ATRIUM_TEST_RECIPES_OUT) writeFileSync(process.env.ATRIUM_TEST_RECIPES_OUT, `${lines.join("\n")}\n`);
    console.log(lines.slice(0, 4).join("\n"));
    expect(g.ok).toBeGreaterThanOrEqual(100);
    expect(names.length).toBeGreaterThan(3);
  }, 240_000);
});
