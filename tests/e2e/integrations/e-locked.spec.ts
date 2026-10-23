// Secrets locked: sealed secrets exist and the master key is gone. Start the slot with
//   tests/e2e/integrations/serve.sh locked > evidence/integrations/r6/logs/server-locked.log 2>&1 &
// then run with ATRIUM_E2E_SCENARIO=locked.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../fixtures";
import { DATA_DIR, EVIDENCE, ORIGIN, themedContext, type Theme, shot } from "./helpers";

test.skip(process.env.ATRIUM_E2E_SCENARIO !== "locked", "locked scenario only");
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project"));

test("Atrium starts, each affected integration shows Secrets locked, tests fail with that message, and no new key is created (criterion 19, V4)", async ({ browser, request }) => {
  expect((await request.get(`${ORIGIN}/api/health`)).status()).toBe(200);
  for (const theme of ["daylight", "dusk", "solid"] as Theme[]) {
    const ctx = await themedContext(browser, theme);
    const page = await ctx.newPage();
    await page.goto("/integrations");
    const locked = page.locator("[data-integration-card] [data-secrets-locked]");
    expect(await locked.count()).toBeGreaterThan(0);
    await expect(locked.first()).toHaveText("Secrets locked: the master key is missing or wrong");
    await shot(page, `screens/secrets-locked-${theme}.png`);
    await ctx.close();
  }
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  const list = (await (await page.request.get("/api/integrations")).json()) as { integrations: { id: string; locked: boolean; packageId: string; secrets: { set: boolean }[] }[] };
  const withSecrets = list.integrations.filter((i) => i.secrets.some((s) => s.set));
  expect(withSecrets.length).toBeGreaterThan(0);
  expect(withSecrets.every((i) => i.locked)).toBe(true);
  expect(list.integrations.filter((i) => !i.secrets.some((s) => s.set)).every((i) => !i.locked)).toBe(true);
  const npm = withSecrets.find((i) => i.packageId === "npm")!;
  await page.goto(`/integrations/${npm.id}`);
  await expect(page.locator("[data-secrets-locked]").first()).toBeVisible();
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-error-code]")).toContainText("Secrets locked: the master key is missing or wrong", { timeout: 10_000 });
  // Nothing asks to re-enter keys, and saving a new value is refused rather than sealing with a new key.
  const r = await page.request.put(`/api/integrations/${npm.id}/secrets`, { data: { secrets: { token: "atrium-v10-FAKE-locked-attempt" } }, headers: { origin: ORIGIN } });
  expect(r.status()).toBe(503);
  expect(existsSync(path.join(DATA_DIR, "master.key"))).toBe(false);
  // A package problem already alerted before the restart is not alerted again.
  const log = readFileSync(path.join(EVIDENCE, "logs/server-locked.log"), "utf8");
  expect(log.includes('Package \\"local/broken-e2e\\" could not be loaded')).toBe(false);
  await page.goto("/integrations");
  await expect(page.locator('[data-problem="local/broken-e2e"]')).toBeVisible();
  await ctx.close();
});
