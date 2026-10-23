// app-shell round 3: the app-shell-spec.md criteria that stay in force under spec v2 (3, 14, 15, 16,
// 17, 37, 38, 39, 45), re-run on the design v4 shell. (20 and 28 are in r3-motion.spec.ts; 40 to 42
// are the r1 trace, unchanged, and the v4 marks in r3-look.spec.ts.)
import { test, expect } from "../fixtures";
import { evidence, go, markSwept, ORIGIN, previewUrl, signIn, writeEvidence } from "./helpers";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop project");
const mobileOnly = (name: string) => test.skip(name !== "mobile", "mobile project");

test.beforeEach(async ({ page, context }) => {
  await signIn(page);
  await markSwept(context, ORIGIN);
});

test("v1 C3 a full page load makes no font, script or style request to another host", async ({ page }, info) => {
  desktopOnly(info.project.name);
  const reqs: { url: string; type: string }[] = [];
  page.on("request", (r) => reqs.push({ url: r.url(), type: r.resourceType() }));
  for (const url of ["/", "/integrations", previewUrl({ scene: "app" }), previewUrl({ scene: "buttons" })]) {
    await go(page, url);
    await page.waitForTimeout(1500);
  }
  const foreign = reqs.filter((r) => !r.url.startsWith(ORIGIN) && !r.url.startsWith("data:"));
  const fonts = reqs.filter((r) => r.type === "font");
  writeEvidence("network/full-page-load.json", { origin: ORIGIN, total: reqs.length, foreign, fonts, requests: reqs });
  expect(foreign).toEqual([]);
  expect(fonts.length).toBeGreaterThan(0);
  for (const f of fonts) expect(f.url).toContain(`${ORIGIN}/_next/static/media/`);
});

test("v1 C14 toast placement on desktop: bottom right, 24px from the edges, 360px", async ({ page }, info) => {
  desktopOnly(info.project.name);
  await go(page, previewUrl({ scene: "toasts" }));
  await page.locator('[data-raise="info"]').click();
  const t = page.locator("[data-toast]");
  await expect(t).toBeVisible();
  await page.waitForTimeout(500);
  const b = (await t.boundingBox())!;
  const vp = page.viewportSize()!;
  const pos = { width: b.width, right: vp.width - (b.x + b.width), bottom: vp.height - (b.y + b.height) };
  expect(pos).toEqual({ width: 360, right: 24, bottom: 24 });
  await page.screenshot({ path: evidence("screens/toast-desktop.png") });
  writeEvidence("criteria/v1-c14-toast-desktop.json", pos);
});

test("v1 C14 toast placement on a phone: top, full width minus 32px", async ({ page }, info) => {
  mobileOnly(info.project.name);
  await go(page, previewUrl({ scene: "toasts" }));
  await page.locator('[data-raise="success"]').click();
  const t = page.locator("[data-toast]");
  await page.waitForTimeout(500);
  const b = (await t.boundingBox())!;
  expect(b.width).toBe(390 - 32);
  expect(b.x).toBe(16);
  expect(b.y).toBeLessThanOrEqual(12);
  await page.screenshot({ path: evidence("screens/toast-phone.png") });
  writeEvidence("criteria/v1-c14-toast-phone.json", { width: b.width, x: b.x, y: b.y });
});

test("v1 C15 C45 toast timers: 5s, 8s, critical and Secrets locked stay; hover and focus pause", async ({ page }, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(90_000);
  await go(page, previewUrl({ scene: "toasts" }));
  const count = (kind: string) => page.locator(`[data-toast="${kind}"]`).count();
  await page.locator('[data-raise="info"]').click();
  await page.waitForTimeout(4500);
  expect(await count("info")).toBe(1);
  await page.waitForTimeout(1100);
  expect(await count("info")).toBe(0);
  await page.locator('[data-raise="error"]').click();
  await page.waitForTimeout(7500);
  expect(await count("error")).toBe(1);
  await page.waitForTimeout(1100);
  expect(await count("error")).toBe(0);
  await page.locator('[data-raise="critical"]').click();
  await page.locator('[data-raise="secrets-locked"]').click();
  await page.waitForTimeout(10_000);
  expect(await count("critical")).toBe(1);
  expect(await count("secrets-locked")).toBe(1);
  await page.locator('[data-toast="critical"] button[aria-label^="Dismiss"]').click();
  await page.locator('[data-toast="secrets-locked"] button[aria-label^="Dismiss"]').click();
  await page.locator('[data-raise="success"]').click();
  await page.waitForTimeout(3000);
  await page.locator('[data-toast="success"]').hover();
  await page.waitForTimeout(4000);
  expect(await count("success")).toBe(1);
  await page.mouse.move(10, 400);
  await page.waitForTimeout(1500);
  expect(await count("success")).toBe(1);
  await page.waitForTimeout(1200);
  expect(await count("success")).toBe(0);
  await page.locator('[data-raise="info"]').click();
  await page.locator('[data-toast="info"] button[aria-label^="Dismiss"]').focus();
  await page.waitForTimeout(6000);
  expect(await count("info")).toBe(1);
  writeEvidence("criteria/v1-c15-c45-toast-timers.json", { info5s: "present at 4.5s, gone by 5.6s", error8s: "present at 7.5s, gone by 8.6s", criticalAndSecretsLocked: "present after 10s until dismissed", hoverPause: "present 7s after raise while hovered; gone about 2.7s after leaving", focusPause: "present 6s after raise while focused" });
});

test("v1 C16 C17 five toasts show the 3 newest, newest on top; announced politely or assertively", async ({ page }, info) => {
  desktopOnly(info.project.name);
  await go(page, previewUrl({ scene: "toasts" }));
  for (const k of ["info", "success", "error", "info", "success"]) await page.locator(`[data-raise="${k}"]`).click();
  await page.waitForTimeout(600);
  const titles = await page.locator("[data-toast] p.font-semibold").allTextContents();
  const ys = await page.locator("[data-toast]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
  // Round 4 (design v4 Note 1): success toasts enter 300ms after their event, so the two successes
  // raised second and fifth are the newest to arrive.
  expect(titles).toEqual(["Connection test passed", "Connection test passed", "Saved"]);
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  await page.screenshot({ path: evidence("screens/toast-stack-3-of-5.png") });
  await go(page, previewUrl({ scene: "toasts" }));
  await page.locator('[data-raise="info"]').click();
  const polite = page.locator('[data-toast-announcer="polite"]');
  const assertive = page.locator('[data-toast-announcer="assertive"]');
  await expect(polite).toHaveText("Saved. Your layout is saved.");
  await page.locator('[data-raise="error"]').click();
  await expect(assertive).toHaveText("Could not reach Proxmox. Timed out after 10 s.");
  const attrs = { polite: await polite.evaluate((e) => [e.getAttribute("aria-live"), e.getAttribute("role")]), assertive: await assertive.evaluate((e) => [e.getAttribute("aria-live"), e.getAttribute("role")]) };
  expect(attrs).toEqual({ polite: ["polite", "status"], assertive: ["assertive", "alert"] });
  const snap = await page.locator("body").ariaSnapshot();
  writeEvidence("a11y/toast-live-regions.txt", `Accessibility tree after raising an info toast then an error toast (Chromium, Playwright ariaSnapshot).\nThis is the tree a screen reader reads; no physical screen reader was run.\n\naria-live attributes: ${JSON.stringify(attrs)}\n\n${snap}`);
});

test("v1 C37 keyboard: the account menu and sheets by keyboard, Esc closes the top sheet, Ctrl/Cmd+K from every shell screen", async ({ page }, info) => {
  desktopOnly(info.project.name);
  await go(page, previewUrl({ scene: "widgets" }));
  await page.locator('[data-shell="topbar"] [data-account-trigger]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-account-menu]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-account-menu]")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-account-trigger"))).toBe(true);
  // The palette by keyboard; Esc closes it and focus returns
  await page.locator("[data-search-hint]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-sheet="palette-fallback"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-sheet="palette-fallback"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-search-hint"))).toBe(true);
  const screens = ["/", previewUrl({ scene: "widgets" }), previewUrl({ scene: "loading" }), previewUrl({ scene: "error" }), "/integrations", "/no-such-room"];
  const results: Record<string, boolean> = {};
  for (const url of screens) {
    await go(page, url);
    for (const combo of ["Control+k", "Meta+k"]) {
      const fired = page.evaluate(() => new Promise<boolean>((res) => {
        const t = setTimeout(() => res(false), 1500);
        window.addEventListener("atrium:open-palette", () => { clearTimeout(t); res(true); }, { once: true });
      }));
      await page.waitForTimeout(50);
      await page.keyboard.press(combo);
      results[`${url} ${combo}`] = await fired;
      await page.keyboard.press("Escape");
    }
  }
  writeEvidence("criteria/v1-c37-keyboard.json", results);
  for (const [k, v] of Object.entries(results)) expect(v, k).toBe(true);
});

test("v1 C38 touch targets at least 44x44 at 390px", async ({ page }, info) => {
  mobileOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const url of ["/", "/integrations", previewUrl({ scene: "widgets", approvals: 2 })]) {
    await go(page, url);
    const small = await page.evaluate(() => {
      const els = [...document.querySelectorAll("[data-shell] a, [data-shell] button, [data-empty-room] button, [data-empty-room] a")] as HTMLElement[];
      return els.filter((e) => e.offsetParent !== null).map((e) => ({ label: e.getAttribute("aria-label") ?? e.textContent?.trim() ?? e.tagName, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })).filter((r) => r.w < 44 || r.h < 44);
    });
    out[url] = small;
    expect(small, url).toEqual([]);
  }
  writeEvidence("criteria/v1-c38-touch-targets.json", { pointerCoarse: await page.evaluate(() => matchMedia("(pointer: coarse)").matches), under44: out });
});

test("v1 C38 pointer targets at least 32x32", async ({ page }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const url of ["/", "/integrations", previewUrl({ scene: "widgets", approvals: 2 }), previewUrl({ scene: "buttons" })]) {
    await go(page, url);
    const small = await page.evaluate(() => {
      const els = [...document.querySelectorAll("[data-shell] a, [data-shell] button, [data-shell] [role=switch], main button, main [role=switch]")] as HTMLElement[];
      return els.filter((e) => e.offsetParent !== null && !e.closest("[data-integrations-home], [data-integration-detail]")).map((e) => ({ label: e.getAttribute("aria-label") ?? e.textContent?.trim(), w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })).filter((r) => r.w < 32 || r.h < 32);
    });
    out[url] = small;
    expect(small, url).toEqual([]);
  }
  writeEvidence("criteria/v1-c38-pointer-targets.json", { under32: out });
});

test("v1 C39 status marks: filled circle, triangle, square", async ({ page }, info) => {
  desktopOnly(info.project.name);
  await go(page, previewUrl({ scene: "buttons" }));
  const shapes = await page.locator("[data-status-marks] .status-mark").evaluateAll((els) => els.map((e) => { const cs = getComputedStyle(e); return { state: (e as HTMLElement).dataset.state, radius: cs.borderRadius, clip: cs.clipPath }; }));
  expect(shapes[0]).toMatchObject({ state: "up", radius: "9999px", clip: "none" });
  expect(shapes[1]!.clip).toContain("polygon(50% 0");
  expect(shapes[2]).toMatchObject({ state: "down", radius: "0px", clip: "none" });
  await page.locator("[data-status-marks]").screenshot({ path: evidence("screens/status-marks.png") });
  writeEvidence("criteria/v1-c39-status-marks.json", shapes);
});
