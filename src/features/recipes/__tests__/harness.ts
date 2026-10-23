// A throwaway database with the real schema plus the recipe tables (drizzle-kit push, until the
// lead's migration exists). Call before importing anything that opens the database.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setupTestDb } from "@/features/integrations/__tests__/db-harness";

export function setupRecipeDb(): string {
  const dir = setupTestDb();
  const app = path.resolve(__dirname, "../../../..");
  execFileSync("pnpm", ["exec", "drizzle-kit", "push", "--force", "--config", "src/features/recipes/__tests__/drizzle.push.config.ts"], { cwd: app, env: { ...process.env, ATRIUM_DATA_DIR: dir }, stdio: "ignore" });
  return dir;
}

/** A small recipe file: two promql reads and one http read that answers 404 on Prometheus. */
export function sampleRecipe(over: Record<string, unknown> = {}) {
  return {
    atriumRecipe: "1", id: "test/lab", name: "Lab extras", version: "1.0.0", author: "Tester", description: "Reads for the lab.", source: "file",
    appliesTo: { package: "prometheus" },
    reads: [
      { id: "machines-list", label: "Machine list", request: { kind: "label-values", metric: "node_uname_info", label: "instance", display: "nodename" }, shape: "table", advanced: true },
      { id: "load", label: "Load (5 min)", group: "Lab", params: { type: "object", properties: { node: { type: "string", title: "Machine", "x-atrium-choices": { endpointId: "machines-list", value: "value", label: "label" } } }, required: ["node"] }, request: { kind: "promql", expr: "node_load5{instance={{ params.node }}}" }, shape: "stat", format: "number" },
      { id: "memory", label: "Memory total", group: "Lab", request: { kind: "promql", expr: "sum(node_memory_MemTotal_bytes)" }, shape: "stat", format: "bytes" },
      { id: "missing", label: "A path this server lacks", group: "Lab", request: { kind: "http", path: "/api/v1/not-here" }, fields: [{ path: "$.data", label: "Data", role: "value" }], shape: "stat" },
    ],
    ...over,
  };
}
