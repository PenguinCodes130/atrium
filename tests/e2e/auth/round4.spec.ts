// Auth e2e, round 4 (gauntlet r2 fix list), "owner" scenario. Start the slot first:
//   tests/e2e/auth/serve.sh owner &   then
//   ATRIUM_E2E_ROUND=r4 ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 pnpm exec playwright test tests/e2e/auth/round4.spec.ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request as pwRequest, type Page } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { EVIDENCE, SCENARIO, VARIANTS, addUser, applyVariant, db, freshIp, minContrast, shot, signInUI, tabAudit } from "./helpers";

test.skip(SCENARIO !== "owner", "owner scenario only");
test.describe.configure({ mode: "serial" });

const MEMBER = { email: "member4@atrium.test", password: "e2e-member4-password-456" };
const isMobile = () => test.info().project.name === "mobile";
const suffix = () => (isMobile() ? "-mobile" : "");
const log: string[] = [];
const note = (line: string) => log.push(`[${test.info().project.name}] ${line}`);

// One sign-in per account per worker (10 sign-ins per account per hour is the real limit).
const states = new Map<string, string>();
async function stateFor(baseURL: string, email: string, password: string, file: string): Promise<string> {
  const known = states.get(email);
  if (known) return known;
  const ctx = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL } });
  const r = await ctx.post("/api/auth/sign-in/email", { data: { email, password } });
  expect(r.status()).toBe(200);
  mkdirSync("test-results/auth", { recursive: true });
  const p = path.resolve(`test-results/auth/${file}`);
  await ctx.storageState({ path: p });
  await ctx.dispose();
  states.set(email, p);
  return p;
}

const viewport = () => (isMobile() ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } });
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeAll(() => {
  // Slot database only: start from clean limiter counts so earlier specs on this server do not count.
  const d = db();
  try {
    d.prepare("DELETE FROM auth_rate_limit").run();
  } finally {
    d.close();
  }
});

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
});

test.afterAll(() => {
  writeFileSync(path.join(EVIDENCE, `round4-checks.txt`), log.join("\n") + "\n", { flag: "a" });
});

test("fix 2: an empty form names each empty field, focuses it, and sends nothing", async ({ page }) => {
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/auth/sign-in/email")) sent += 1;
  });
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("[data-field-error]")).toHaveText(["Enter your email.", "Enter your password."]);
  await expect(page.getByLabel("Email")).toBeFocused();
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText(/allowlist/i)).toHaveCount(0);
  await page.screenshot({ path: shot(`sign-in-empty${suffix()}`), fullPage: true });
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("[data-field-error]")).toHaveText(["Enter your password."]);
  await expect(page.getByLabel("Password")).toBeFocused();
  expect(sent).toBe(0);
  note("empty form: 'Enter your email.' and 'Enter your password.' by the fields, no allowlist text, 0 requests sent");
});

test("fix 2: the server also answers an empty email with 'Enter your email.'", async ({ request, baseURL }) => {
  const r = await request.post("/api/auth/sign-in/email", { data: { email: "", password: "" }, headers: { origin: baseURL!, "x-forwarded-for": freshIp() } });
  expect(r.status()).toBe(400);
  expect(await r.json()).toMatchObject({ error: { code: "missing_email", message: "Enter your email." } });
  note(`POST /api/auth/sign-in/email with an empty email: ${r.status()} missing_email`);
});

test("fix 3: the sign-in title is --type-title-1 (44/42, 32/32 under 640px)", async ({ page }) => {
  await page.goto("/sign-in");
  const h = page.getByRole("heading", { name: "Sign in to Atrium" });
  const m = await h.evaluate((el) => ({ size: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight, weight: getComputedStyle(el).fontWeight }));
  expect(m).toEqual(isMobile() ? { size: "32px", line: "32px", weight: "600" } : { size: "44px", line: "42px", weight: "600" });
  note(`sign-in title ${m.size}/${m.line} ${m.weight}`);
});

test("fix 4: a refused attempt clears the password and focuses it", async ({ page }) => {
  test.skip(isMobile(), "desktop only (one wrong password is enough)");
  await signInUI(page, OWNER.email, "not-the-right-password");
  await expect(page.locator("#signin-message")).toHaveText("That email and password do not match. Check both and try again.");
  await expect(page.getByLabel("Password")).toBeFocused();
  await expect(page.getByLabel("Password")).toHaveValue("");
  await expect(page.getByLabel("Email")).toHaveValue(OWNER.email);
  await page.screenshot({ path: shot("sign-in-refused-focus") });
  note("wrong password: message shown, password cleared and focused, email kept");
});

test("fix 4: 'Forgot your password?' shows the exact reset command", async ({ page, context, baseURL }) => {
  for (const v of VARIANTS) {
    await context.clearCookies();
    await applyVariant(context, v, baseURL!);
    await page.goto("/sign-in");
    await page.getByText("Forgot your password?").click();
    await expect(page.locator("[data-recovery-command]")).toHaveText("pnpm atrium:reset-owner");
    await expect(page.locator("[data-recovery-steps]")).toContainText("docker exec -it <container> pnpm atrium:reset-owner");
    await expect(page.locator("[data-recovery-steps]")).toContainText("ATRIUM_RESET_OWNER_PASSWORD");
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: shot(`sign-in-forgot-${v.name}${suffix()}`), fullPage: true });
    // The plain sign-in screen in each variant (V4, V5), with the title-1 headline.
    await page.getByText("Forgot your password?").click();
    await page.screenshot({ path: shot(`sign-in-${v.name}${suffix()}`), fullPage: true });
  }
  note("forgot password: command shown in mono, Docker and variable options named, no side scroll");
});

test("fix 1 (round 6): /account is a permanent redirect; the panels' host signed out goes to sign-in and comes back", async ({ page }) => {
  // Round 6 (A4.4): /account answers 308 to /settings/security before the sign-in gate.
  const moved = await page.request.get("/account", { maxRedirects: 0, headers: { "x-forwarded-for": freshIp() } });
  expect(moved.status()).toBe(308);
  expect(moved.headers()["location"]).toMatch(/\/settings\/security$/);
  const res = await page.request.get("/settings/security", { maxRedirects: 0, headers: { "x-forwarded-for": freshIp() } });
  expect([302, 303, 307]).toContain(res.status());
  expect(res.headers()["location"]).toContain("/sign-in?next=%2Fsettings%2Fsecurity");
  await page.goto("/settings/security");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings%2Fsecurity/);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => u.pathname === "/settings/security");
  await expect(page.locator('[data-settings-tab="security"]')).toBeVisible();
  note(`/account: ${moved.status()} to ${moved.headers()["location"]}; /settings/security signed out: ${res.status()} to ${res.headers()["location"]}; signing in lands back on /settings/security`);
});

test("fix 1: owner panels (settings routes since Wave 2) have users, allowlist, password, sessions and 2FA in titled windows (V4, V5)", async ({ browser, baseURL }) => {
  await addUser(MEMBER.email, "member", MEMBER.password);
  const state = await stateFor(baseURL!, OWNER.email, OWNER.password, "owner-state-r4.json");
  const traffic: string[] = [];
  for (const v of VARIANTS) {
    const context = await browser.newContext({ storageState: state, reducedMotion: "reduce", ...viewport() });
    await applyVariant(context, v, baseURL!);
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
    page.on("response", async (r) => traffic.push(`### ${r.status()} ${r.request().method()} ${r.url()}\n${JSON.stringify(r.headers())}\n${await r.text().catch(() => "")}`));
    // Wave 2 lead: settings mounts the panels; the security half is checked on /settings/security first.
    await page.goto("/settings/security");
    await expect(page.locator('[data-settings-tab="security"] [data-window-title]')).toHaveText("settings / security");
    await expect(page.locator("[data-sessions-panel] li").first()).toBeVisible();
    await expect(page.locator("[data-two-factor-panel]")).toBeVisible();
    await expect(page.locator("[data-password-panel]")).toBeVisible();
    await page.goto("/settings/users");
    await expect(page.locator('[data-settings-tab="users"] [data-window-title]')).toHaveText("settings / users");
    await expect(page.locator("[data-users-manager]")).toBeVisible();
    await expect(page.locator(`[data-user="${MEMBER.email}"]`)).toBeVisible();
    await expect(page.getByRole("heading", { name: /allowlist/i })).toBeVisible();
    // Round 5 (gauntlet r3 fix 4): no "Back to Atrium" button.
    await expect(page.locator("[data-account-back]")).toHaveCount(0);
    const title = await page.getByRole("heading", { name: "Settings", level: 1 }).evaluate((el) => getComputedStyle(el).fontSize);
    expect(title).toBe(isMobile() ? "32px" : "44px");
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: shot(`account-${v.name}${suffix()}`), fullPage: true });
    if (v.name === "light") {
      const c = await minContrast(page);
      note(`/settings owner ${v.name}: min text contrast ${c.ratio.toFixed(2)} ("${c.text}"), title ${title}`);
      expect(c.ratio).toBeGreaterThanOrEqual(4.5);
      if (!isMobile()) {
        // Round 5: /account is inside the shell, so the first stops are app-shell's top bar. Auth checks
        // its own controls (inside the account screen) for 44px; every stop must show the 2px ring.
        const stops = await tabAudit(page, 60, "[data-settings-screen]");
        for (const s of stops) {
          expect(s.outline, s.label).toMatch(s.inScope ? /solid 2px 3px/ : /solid 2px/);
          if (s.inScope) expect(Math.min(s.w, s.h), s.label).toBeGreaterThanOrEqual(44);
        }
        const shellSmall = stops.filter((s) => !s.inScope && Math.min(s.w, s.h) < 44).map((s) => `${s.label} ${s.w}x${s.h}`);
        note(`/settings keyboard: ${stops.length} tab stops, ${stops.filter((s) => s.inScope).length} in the account screen, all with the 2px ring; account controls 44px or more; shell stops under 44px: ${shellSmall.join(", ") || "none"}`);
      }
      const width = await page.locator("[data-users-manager]").evaluate((el) => Math.round(el.getBoundingClientRect().width));
      note(`/settings/users column width ${width}px`);
      if (!isMobile()) expect(width).toBeGreaterThan(600);
    }
    await context.close();
  }
  mkdirSync("test-results/auth", { recursive: true });
  writeFileSync("test-results/auth/traffic-r4.txt", traffic.join("\n\n"), { flag: "a" });
});

test("fix 4: the step-up sheet on the users panel says why it opened; cancel changes nothing", async ({ browser, baseURL }) => {
  const state = await stateFor(baseURL!, OWNER.email, OWNER.password, "owner-state-r4b.json");
  for (const v of VARIANTS) {
    const context = await browser.newContext({ storageState: state, reducedMotion: "reduce", ...viewport() });
    await applyVariant(context, v, baseURL!);
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
    await page.goto("/settings/users");
    await page.locator(`[data-user="${MEMBER.email}"]`).getByRole("button", { name: "Make owner" }).click();
    const sheet = page.locator('[data-sheet="step-up"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("[data-step-up-reason]")).toHaveText(`Confirm it is you to make ${MEMBER.email} the owner of this Atrium.`);
    await expect(sheet.getByLabel("Password")).toBeVisible();
    await page.screenshot({ path: shot(`step-up-reason-${v.name}${suffix()}`) });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await context.close();
  }
  expect(db().prepare("SELECT email FROM user WHERE role = 'owner'").all()).toEqual([{ email: OWNER.email }]);
  note("step-up sheet names the action ('to make ... the owner'); cancelling left one owner");
});

test("fix 1 (round 6): a member sees only their own security; the users panel says the owner manages it", async ({ browser, baseURL }) => {
  await addUser(MEMBER.email, "member", MEMBER.password);
  const state = await stateFor(baseURL!, MEMBER.email, MEMBER.password, "member-state-r4.json");
  const context = await browser.newContext({ storageState: state, ...viewport() });
  await applyVariant(context, VARIANTS[0]!, baseURL!);
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
  // Wave 2 lead: settings refuses /settings/users for a member before auth's panel is mounted.
  await page.goto("/settings/users");
  await expect(page.locator("[data-owner-only]")).toContainText("Only the owner can open Users.");
  await expect(page.locator("[data-users-manager]")).toHaveCount(0);
  await expect(page.locator(`[data-user="${OWNER.email}"]`)).toHaveCount(0);
  await page.goto("/settings/security");
  await expect(page.locator("[data-sessions-panel]")).toBeVisible();
  await expect(page.locator("[data-two-factor-panel]")).toBeVisible();
  await expect(page.locator("[data-password-panel]")).toBeVisible();
  await page.screenshot({ path: shot(`account-member-light${suffix()}`), fullPage: true });
  await context.close();
  note("member panels: own security only; users panel shows the owner-only sentence, no user data");
});

