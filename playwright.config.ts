import { defineConfig, devices } from "@playwright/test";

// Parallel wave subagents each get their own port, build folder and data folder.
const port = Number(process.env.ATRIUM_E2E_PORT ?? 3102);
const slot = process.env.ATRIUM_E2E_SLOT ?? "main";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: `./test-results/${slot}`,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: true,
    timeout: 240_000,
    env: {
      ATRIUM_DATA_DIR: `./data/e2e-${slot}`,
      ATRIUM_DIST_DIR: slot === "main" ? ".next" : `.next-${slot}`,
      ATRIUM_OWNER_EMAIL: "owner@atrium.test",
      ATRIUM_OWNER_PASSWORD: "e2e-owner-password-123",
      ATRIUM_PUBLIC_URL: `http://127.0.0.1:${port}`,
      // Test-only value: next start runs in production mode, where devSecret() refuses to generate one.
      BETTER_AUTH_SECRET: "e2e-only-not-a-real-secret-0123456789abcdef",
    },
  },
});
