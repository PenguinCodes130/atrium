// Secrets locked: a sealed secret exists and the master key is gone. Start the slot first:
//   tests/e2e/auth/serve.sh locked &
//   ATRIUM_E2E_SCENARIO=locked ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 pnpm exec playwright test tests/e2e/auth/locked.spec.ts
import { existsSync } from "node:fs";
import path from "node:path";
import { request as pwRequest } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { DATA_DIR, SCENARIO, freshIp, shot } from "./helpers";

test.skip(SCENARIO !== "locked", "locked scenario only");

test("Atrium starts, the owner sees the Secrets locked banner, and no new key file appears (criterion 40, auth part)", async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  expect((await (await pwRequest.newContext({ baseURL })).get("/api/health")).status()).toBe(200);
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL!, "x-forwarded-for": freshIp() } });
  expect((await api.post("/api/auth/sign-in/email", { data: OWNER })).status()).toBe(200);
  const state = await api.storageState();
  const context = await browser.newContext({ storageState: state });
  const page = await context.newPage();
  await page.goto("/settings/users");
  await expect(page.locator('[data-banner="secrets-locked"]')).toHaveText("Secrets locked: the master key is missing or wrong");
  await page.screenshot({ path: shot("secrets-locked-banner-light"), fullPage: true });
  expect(existsSync(path.join(DATA_DIR, "master.key"))).toBe(false);
});
