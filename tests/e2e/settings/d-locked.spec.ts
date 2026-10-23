// AC 10: with the master key removed while sealed secrets exist, the owner sees the secrets-locked
// banner on every settings screen and a member does not. Run against serve.sh <build> locked with
// ATRIUM_E2E_SCENARIO=locked.
import { expect, request, test } from "@playwright/test";
import { MEMBER, ORIGIN, OWNER, context, shot, stateFor } from "./helpers";

const TABS = ["general", "appearance", "themes", "users", "security", "backups", "notifications", "agents"];
const MESSAGE = "Secrets locked: the master key is missing or wrong";
const EXPORT_LOCKED = "Secrets are locked because the master key is missing or wrong, so they can't be included in a backup. Restore the master key, or export without secrets.";

test.skip(process.env.ATRIUM_E2E_SCENARIO !== "locked", "locked scenario only");

test("owner sees the banner on every settings screen; a member never does", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const o = await context(browser, OWNER);
  const op = await o.newPage();
  for (const t of TABS) {
    await op.goto(`/settings/${t}`);
    await expect(op.locator('[data-banner="secrets-locked"]'), t).toHaveText(MESSAGE);
  }
  await shot(op, "locked-owner-banner");
  const m = await context(browser, MEMBER);
  const mp = await m.newPage();
  for (const t of ["appearance", "themes", "security", "notifications", "agents"]) {
    await mp.goto(`/settings/${t}`);
    await expect(mp.locator(`[data-settings-tab="${t}"]`)).toBeVisible();
    await expect(mp.getByText(MESSAGE)).toHaveCount(0);
  }
  await shot(mp, "locked-member-no-banner");
  await o.close();
  await m.close();
});

// Fix List 2026-10-19: on a locked instance an export WITH secrets is refused at once (409, the cause
// named) and the Backups screen shows that message; it used to leave the owner waiting for a download.
// An export WITHOUT secrets is not refused by the lock (it still needs the owner's step-up).
test("locked: export with secrets is refused fast with the cause named; without secrets is not refused by the lock", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const api = await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
  const started = Date.now();
  const refused = await api.post("/api/settings/backup/export", { data: { includeSecrets: true, password: "locked-e2e-pass-123", passwordAgain: "locked-e2e-pass-123" } });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toEqual({ code: "backup_secrets_locked", message: EXPORT_LOCKED });
  const plain = await api.post("/api/settings/backup/export", { data: { includeSecrets: false } });
  if (plain.status() !== 200) {
    expect(plain.status()).toBe(403);
    expect((await plain.json()).error.code).toBe("step_up_required");
  }
  await api.dispose();

  const o = await context(browser, OWNER);
  const page = await o.newPage();
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await page.goto("/settings/backups");
  await page.locator("[data-with-secrets]").check();
  await page.locator("[data-backup-password]").fill("locked-e2e-pass-123");
  await page.locator("[data-backup-password-again]").fill("locked-e2e-pass-123");
  await page.locator("[data-export-backup]").click();
  await expect(page.locator("[data-export-error]")).toHaveText(EXPORT_LOCKED, { timeout: 5000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-export-backup]")).toBeEnabled();
  expect(downloaded).toBe(false);
  await shot(page, "locked-export-refused");
  await o.close();
});
