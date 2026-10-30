// AC 7, 8, 9, 11, 13 to 16, 19, 26, 28, 29, 32, 33, 35, 37, 40 in the browser, plus V10 traffic capture.
// Test-only values; none are real credentials.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, request, test } from "@playwright/test";
import { MEMBER, ORIGIN, OWNER, addUser, captureTraffic, context, ev, shot, stateFor } from "./helpers";

test.setTimeout(180_000);
test.beforeEach(async ({}, info) => test.skip(info.project.name !== "desktop", "behaviour runs once, on desktop"));

export const SEEDED = { token: "atrium-settings-e2e-FAKE-token-7c1d9e", backupPassword: "e2e-backup-FAKE-pass-4410" };

test.beforeAll(async () => {
  await addUser(MEMBER.email, "member", MEMBER.password);
});

test("instance name reaches the clock readout on the next load; one settings.updated (AC 7, 8)", async ({ browser }) => {
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  captureTraffic(page, "general");
  await page.goto("/settings/general");
  await page.locator('[data-field="instanceName"]').fill("lab.atrium");
  await page.locator('[data-field="versionRetention"]').fill("19");
  await page.locator("[data-save-general]").click();
  await expect(page.locator('[data-field-error="versionRetention"]')).toHaveText("Keep at least 20 versions.");
  await page.locator('[data-field="auditRetentionDays"]').fill("0");
  await page.locator("[data-save-general]").click();
  await expect(page.locator('[data-field-error="auditRetentionDays"]')).toHaveText("Audit retention must be at least 1 day.");
  await shot(page, "general-refused");
  // The server refuses the same values, naming the minimum.
  const api = await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
  const r19 = await api.put("/api/settings/instance", { data: { versionRetention: 19 } });
  expect(r19.status()).toBe(400);
  expect((await r19.json()).error.message).toBe("Keep at least 20 versions.");
  await page.locator('[data-field="auditRetentionDays"]').fill("365");
  await page.locator('[data-field="keepAll"]').check();
  await page.locator("[data-save-general]").click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("Saved General settings", { exact: true })).toBeVisible();
  await page.goto("/settings/appearance");
  await expect(page.locator("[data-clock] [data-instance]")).toHaveText("lab.atrium");
  await page.goto("/integrations");
  await expect(page.locator("[data-clock] [data-instance]")).toHaveText("lab.atrium");
  await shot(page, "clock-readout-after-rename");
  const rows = (await import("./helpers")).db().prepare("SELECT detail FROM audit_log WHERE event = 'settings.updated' AND target_type = 'settings'").all() as { detail: string }[];
  const last = JSON.parse(rows[rows.length - 1]!.detail);
  expect(last.keys).toEqual(["instanceName"]);
  expect(last.changes.instanceName.new).toBe("lab.atrium");
  await api.dispose();
  await ctx.close();
});

test("Dark on Appearance darkens only this user's shell, even with a light system preference (AC 9)", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: await stateFor(OWNER), baseURL: ORIGIN, colorScheme: "light", viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name: "atrium_swept", value: "1", url: ORIGIN }]);
  const page = await ctx.newPage();
  await page.goto("/settings/appearance");
  await page.locator('[data-shell-mode="dark"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await shot(page, "appearance-dark-on-light-system");
  // The theme sample canvases keep their own theme colours.
  await page.goto("/settings/themes");
  const sample = await page.locator('[data-theme-window="solid"] [data-atrium-canvas]').evaluate((el) => getComputedStyle(el).getPropertyValue("--theme-surface").trim());
  expect(sample.toLowerCase()).toBe("#ffffff");
  // A fresh browser for the member: unchanged.
  const m = await context(browser, MEMBER, { variant: "light" });
  const mp = await m.newPage();
  await mp.goto("/settings/appearance");
  await expect(mp.locator("html")).not.toHaveAttribute("data-theme", "dark");
  const mbg = await mp.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(mbg).not.toBe(bg);
  // The owner's stored preference follows them to a new browser.
  const fresh = await browser.newContext({ storageState: await stateFor(OWNER), baseURL: ORIGIN, colorScheme: "light" });
  await fresh.clearCookies({ name: "atrium_theme" });
  const fp = await fresh.newPage();
  await fp.goto("/settings/appearance");
  await expect(fp.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/settings/appearance");
  await page.locator('[data-shell-mode="system"]').click();
  await Promise.all([ctx.close(), m.close(), fresh.close()]);
});

test("Themes: built-ins Duplicate only; folded editor; contrast warning; field refusals; font limits (AC 11, 13 to 16)", async ({ browser }) => {
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  captureTraffic(page, "themes");
  await page.goto("/settings/themes");
  for (const id of ["control-room", "dusk", "solid", "daylight"]) {
    const w = page.locator(`[data-theme-window="${id}"]`);
    await expect(w).toBeVisible();
    await expect(w.locator("[data-edit-theme], [data-delete-theme]")).toHaveCount(0);
    await expect(w.locator("[data-duplicate-theme]")).toBeVisible();
  }
  await page.locator('[data-theme-window="solid"] [data-duplicate-theme]').click();
  await page.waitForURL(/\/settings\/themes\/t-/);
  // Folded: only the basics are open; every group and Advanced are closed.
  for (const g of ["surfaces", "colours", "type", "shape", "motion", "chrome", "dark", "advanced"]) await expect(page.locator(`[data-group="${g}"]`)).toHaveAttribute("data-open", "false");
  await expect(page.locator('[data-field="customCss"]')).toBeHidden();
  await shot(page, "editor-folded");
  // Surface text #777777 on the white Solid surface: warned on the basics view with its group folded.
  await page.locator('[data-group-toggle="colours"]').click();
  await page.locator('[data-field="color.surfaceText"]').fill("#777777");
  await page.locator('[data-group-toggle="colours"]').click();
  await expect(page.locator('[data-group="colours"]')).toHaveAttribute("data-open", "false");
  const warn = page.locator('[data-basics] [data-contrast-warning="color.surfaceText"]');
  await expect(warn).toContainText(/Surface text on the surface: 4\.4\d:1/);
  await warn.locator("[data-open-group]").click();
  await expect(page.locator('[data-group="colours"]')).toHaveAttribute("data-open", "true");
  await page.locator('[data-field="color.surfaceText"]').fill("#1A1A1A");
  // Out-of-range input is refused at the field with the range named.
  await page.locator('[data-group-toggle="shape"]').click();
  await page.locator('[data-field="shape.radiusPx"]').fill("40");
  await expect(page.locator('[data-field-error="shape.radiusPx"]')).toHaveText("Radius (px) must be between 0 and 32.");
  await page.locator('[data-group-toggle="surfaces"]').click();
  // Wave 2.10b F12: opacity and blur show only for Frosted glass, so pick it first.
  await page.locator('[data-field="surface.material"] [role="radio"]', { hasText: /^Frosted glass$/ }).click();
  await page.locator('[data-field="surface.opacity"]').fill("0.2");
  await expect(page.locator('[data-field-error="surface.opacity"]')).toHaveText("Surface opacity must be between 0.3 and 1.");
  await page.locator('[data-group-toggle="type"]').click();
  await page.locator('[data-field="type.scale"]').fill("2");
  await expect(page.locator('[data-field-error="type.scale"]')).toHaveText("Type scale must be between 0.85 and 1.3.");
  await shot(page, "editor-refusals");
  // Fonts: a 3 MB woff2 and a font that is not woff2 are refused with the reason.
  await page.locator('[data-group-toggle="advanced"]').click();
  const big = Buffer.alloc(3 * 1024 * 1024, 1); big.write("wOF2", 0, "ascii");
  const input = page.locator('[data-upload-field="font"] [data-upload-input]');
  await input.setInputFiles({ name: "big.woff2", mimeType: "font/woff2", buffer: big });
  await expect(page.locator('[data-upload-field="font"] [data-upload-message]')).toContainText(/at most 2 MB/);
  await input.setInputFiles({ name: "fake.woff2", mimeType: "font/woff2", buffer: Buffer.from("<html><body>not a font</body></html>") });
  await expect(page.locator('[data-upload-field="font"] [data-upload-message]')).toContainText(/not a woff2 font/);
  await shot(page, "editor-font-refused");
  await ctx.close();
});

test("export, import twice, delete; hostile file refused; hostile CSS cannot touch the shell (AC 19, 26, 28, 29)", async ({ browser }) => {
  const api = await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
  // Start clean: no imported Dusk copies from an earlier run.
  for (const t of (await (await api.get("/api/settings/themes")).json()).themes.filter((x: { builtIn: boolean; name: string }) => !x.builtIn && /^(Dusk \(|Evil)/.test(x.name))) await api.delete(`/api/settings/themes/${t.id}`);
  const file = await (await api.get("/api/settings/themes/dusk/export")).body();
  expect(file.readUInt32LE(0)).toBe(0x04034b50);
  const names: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await api.post("/api/settings/themes/import", { multipart: { file: { name: "dusk.atrium-theme", mimeType: "application/zip", buffer: file } } });
    expect(r.status()).toBe(201);
    names.push((await r.json()).name);
  }
  expect(names).toEqual(["Dusk (2)", "Dusk (3)"]); // "Dusk" itself is the built-in's name
  const bad = await api.post("/api/settings/themes/import", { multipart: { file: { name: "x.atrium-theme", mimeType: "application/json", buffer: Buffer.from("{ not json") } } });
  expect(bad.status()).toBe(400);
  writeFileSync(ev("theme-import.json"), JSON.stringify({ names, damaged: await bad.json() }, null, 2));

  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto("/settings/themes");
  const shellParts = ['[data-shell="topbar"]', "[data-sky-band]"];
  const before = await Promise.all(shellParts.map((s) => page.locator(s).first().screenshot({ animations: "disabled", mask: [page.locator("[data-clock], .live-dot, [data-sky-shader], [data-sky-speckle]")] })));
  const hostile = { ...JSON.parse(readFileSync(new URL("./hostile-theme.json", import.meta.url), "utf8")) };
  const r = await api.post("/api/settings/themes/import", { multipart: { file: { name: "evil.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(hostile)) } } });
  expect(r.status()).toBe(201);
  await page.reload();
  await expect(page.locator("[data-theme-window]").last()).toBeVisible();
  await page.waitForTimeout(400);
  const after = await Promise.all(shellParts.map((s) => page.locator(s).first().screenshot({ animations: "disabled", mask: [page.locator("[data-clock], .live-dot, [data-sky-shader], [data-sky-speckle]")] })));
  shellParts.forEach((s, i) => {
    writeFileSync(ev("screens", `hostile-${i}-before.png`), before[i]!);
    writeFileSync(ev("screens", `hostile-${i}-after.png`), after[i]!);
  });
  shellParts.forEach((s, i) => expect(Buffer.compare(before[i]!, after[i]!), `${s} pixels`).toBe(0));
  const bodyVisible = await page.evaluate(() => getComputedStyle(document.body).display !== "none" && getComputedStyle(document.documentElement).filter === "none");
  expect(bodyVisible).toBe(true);
  await shot(page, "themes-after-hostile-import");
  // Delete the imported copies (no app uses them): one through the screen, the rest through the API.
  const first = page.locator("[data-theme-window^='t-']").filter({ hasText: "Dusk (" }).first();
  await first.locator("[data-delete-theme]").click();
  await first.locator("[data-confirm-delete]").click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText(/^Deleted Dusk/).first()).toBeVisible();
  const list = await (await api.get("/api/settings/themes")).json();
  for (const t of list.themes.filter((x: { builtIn: boolean; name: string }) => !x.builtIn && (/^Dusk \(/.test(x.name) || x.name.startsWith("Evil")))) await api.delete(`/api/settings/themes/${t.id}`);
  await api.dispose();
  await ctx.close();
});

test("uploads: HTML refused, SVG sanitised and served with nosniff, image proxy refusals (AC 32, 33, 35)", async () => {
  const api = await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
  const out: Record<string, unknown> = {};
  const html = await api.post("/api/settings/uploads", { multipart: { accept: "image", file: { name: "cat.png", mimeType: "image/png", buffer: Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>") } } });
  out.htmlAsPng = { status: html.status(), body: await html.json() };
  expect((await html.json()).error.message).toBe("This file type is not allowed. Upload a picture (PNG, JPEG, GIF, WebP, AVIF or SVG).");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><foreignObject><p>x</p></foreignObject><image href="https://evil.example/a.png"/><rect width="5" height="5"/></svg>';
  const up = await api.post("/api/settings/uploads", { multipart: { accept: "image", file: { name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) } } });
  const { path } = await up.json();
  const served = await api.get(path);
  const text = await served.text();
  out.svg = { path, headers: served.headers(), body: text };
  expect(text).not.toMatch(/script|onload|foreignObject|evil\.example/);
  expect(served.headers()["x-content-type-options"]).toBe("nosniff");
  expect(served.headers()["content-disposition"]).toBe("inline");
  for (const [k, q] of Object.entries({ unsigned: "u=http%3A%2F%2Fexample.com%2Fa.png", altered: "u=http%3A%2F%2Fexample.com%2Fa.png&a=app1&v=g&n=d&e=9999999999&s=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", metadata: "u=http%3A%2F%2F169.254.169.254%2Flatest&s=x" })) {
    const r = await api.get(`/api/img?${q}`);
    out[`img-${k}`] = r.status();
    expect(r.status(), k).toBe(403);
  }
  writeFileSync(ev("uploads-and-proxy.json"), JSON.stringify(out, null, 2));
  await api.dispose();
});

test("backups: members cannot export or import; step-up, then mismatched passwords refused; export downloads; damaged import changes nothing (AC 36, 37, 40)", async ({ browser }) => {
  const mApi = await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(MEMBER), extraHTTPHeaders: { origin: ORIGIN } });
  expect((await mApi.post("/api/settings/backup/export", { data: { includeSecrets: false } })).status()).toBe(403);
  expect((await mApi.post("/api/settings/backup/import")).status()).toBe(403);
  await mApi.dispose();
  // A saved credential with a sealed test value, for the V10 grep.
  const api = await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
  const existing = await (await api.get("/api/integrations/credentials")).json();
  if (!existing.credentials?.some((c: { name: string }) => c.name === "E2E token")) {
    expect((await api.post("/api/integrations/credentials", { data: { name: "E2E token", kind: "token", values: { token: SEEDED.token } } })).status()).toBe(201);
  }
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  captureTraffic(page, "backups");
  await page.goto("/settings/backups");
  await shot(page, "backups-before");
  await page.locator("[data-with-secrets]").check();
  await page.locator("[data-backup-password]").fill(SEEDED.backupPassword);
  await page.locator("[data-backup-password-again]").fill(`${SEEDED.backupPassword}-typo`);
  await page.locator("[data-export-backup]").click();
  await expect(page.locator("[data-export-error]")).toHaveText("The two passwords do not match.");
  await page.locator("[data-backup-password-again]").fill(SEEDED.backupPassword);
  await page.locator("[data-export-backup]").click();
  // A session without a fresh step-up is refused by the server.
  const fresh = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN, "x-forwarded-for": "198.51.100.250" } });
  expect((await fresh.post("/api/auth/sign-in/email", { data: OWNER })).ok()).toBe(true);
  const refused = await fresh.post("/api/settings/backup/export", { data: { includeSecrets: false } });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe("step_up_required");
  await fresh.dispose();
  // In the screen, the step-up sheet opens first (password method for this owner) unless this
  // session stepped up in the last 10 minutes.
  const download = page.waitForEvent("download");
  const sheet = page.getByRole("dialog");
  if (await sheet.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) {
    await expect(sheet).toContainText("export a backup");
    await shot(page, "backups-step-up");
    await sheet.locator('input[type="password"]').fill(OWNER.password);
    await sheet.getByRole("button", { name: /confirm|continue/i }).click();
  }
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^atrium-backup-\d{4}-\d{2}-\d{2}\.atrium$/);
  const saved = `${test.info().outputDir}/backup-with-secrets.atrium`; // test output only, never evidence
  await d.saveAs(saved);
  const bytes = readFileSync(saved);
  for (const s of Object.values(SEEDED)) expect(bytes.includes(Buffer.from(s)), s).toBe(false);
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("Backup ready", { exact: true })).toBeVisible();
  // A damaged file is refused and nothing changes.
  const before = (await import("./helpers")).db().prepare("SELECT COUNT(*) AS n FROM credential").get() as { n: number };
  await page.reload();
  await page.locator("[data-backup-file]").setInputFiles({ name: "broken.atrium", mimeType: "application/octet-stream", buffer: Buffer.from("PK\u0003\u0004 this is not a backup") });
  await page.locator("[data-replace-confirm] [role=checkbox]").check();
  await page.locator("[data-import-backup]").click();
  // r2 (w2-r1 item 1): import asks for a step-up first when the last one is stale.
  const importSheet = page.locator('[data-sheet="step-up"]');
  if (await importSheet.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
    await importSheet.getByLabel("Password").fill(OWNER.password);
    await importSheet.getByRole("button", { name: "Confirm" }).click();
  }
  await expect(page.locator("[data-import-error]")).toContainText(/damaged.*Nothing was changed/);
  await shot(page, "backups-damaged-refused");
  const after = (await import("./helpers")).db().prepare("SELECT COUNT(*) AS n FROM credential").get() as { n: number };
  expect(after.n).toBe(before.n);
  await api.dispose();
  await ctx.close();
});
