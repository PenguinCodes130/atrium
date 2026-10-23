import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/unit/server-only-stub.ts", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"], environment: "node", pool: "forks" },
});
