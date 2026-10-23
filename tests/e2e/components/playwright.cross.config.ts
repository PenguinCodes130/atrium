// Criterion 52: the sandbox suite (d-sandbox.spec.ts, criteria 44 to 51) in Firefox or WebKit.
// The project is named "desktop" because the suite runs only there. Pick the engine with
// ATRIUM_E2E_BROWSER=firefox|webkit and keep evidence apart with ATRIUM_E2E_EVIDENCE_ROUND.
// Run against the components slot (tests/e2e/components/serve.sh, port 3114):
//   ATRIUM_E2E_BROWSER=firefox ATRIUM_E2E_EVIDENCE_ROUND=r2-firefox ATRIUM_E2E_SLOT=components ATRIUM_E2E_PORT=3114 \
//     pnpm exec playwright test -c tests/e2e/components/playwright.cross.config.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import base from "../../../playwright.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = process.env.ATRIUM_E2E_BROWSER === "webkit" ? "webkit" : "firefox";
const device = engine === "webkit" ? devices["Desktop Safari"] : devices["Desktop Firefox"];

export default defineConfig({
  ...base,
  testDir: here,
  testMatch: process.env.ATRIUM_E2E_MATCH ?? "d-sandbox.spec.ts",
  outputDir: path.resolve(here, `../../../test-results/components-${engine}`),
  projects: [{ name: "desktop", use: { ...device, viewport: { width: 1280, height: 800 } } }],
});
