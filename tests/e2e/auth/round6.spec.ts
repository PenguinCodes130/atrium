// Auth e2e, round 6 (Wave 2 touch-ups, architecture v3 A4.4):
//   - safeNext percent-encodes characters above U+007E instead of refusing them; a non-ASCII `next`
//     never answers 500 and `/x?q=caf%C3%A9` survives sign-in.
//   - the Security panel's password change (settings mounts it at /settings/security); auth tests it on
//     it there (Wave 2 lead: the temporary panels host is gone).
// "owner" scenario:
//   tests/e2e/auth/serve.sh owner &   then
//   ATRIUM_E2E_ROUND=r6 ATRIUM_E2E_SCENARIO=owner ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 \
//     pnpm exec playwright test tests/e2e/auth/round6.spec.ts
// Writes test-results/auth/v10-seeds-r6.json (the passwords it sets) and traffic-r6.txt for V10.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request as pwRequest, type Page } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { EVIDENCE, SCENARIO, VARIANTS, addUser, applyVariant, db, freshIp, minContrast, shot } from "./helpers";

test.skip(SCENARIO !== "owner", "owner scenario only");
test.describe.configure({ mode: "default" });
test.setTimeout(120_000);

const isMobile = () => test.info().project.name === "mobile";
const suffix = () => (isMobile() ? "-mobile" : "");
const viewport = () => (isMobile() ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } });
const log: string[] = [];
const note = (line: string) => log.push(`[${test.info().project.name}] ${line}`);
const seeds: Record<string, string> = {};
const traffic: string[] = [];
const record = (page: Page) =>
  page.on("response", async (r) => traffic.push(`### ${r.status()} ${r.request().method()} ${r.url()}\n${JSON.stringify(r.headers())}\n${await r.text().catch(() => "")}`));

test.beforeAll(() => {
  const d = db();
  try {
    d.prepare("DELETE FROM auth_rate_limit").run();
  } finally {
    d.close();
  }
});

test.afterAll(() => {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, "round6-e2e-notes.txt"), log.join("\n") + "\n", { flag: "a" });
  mkdirSync("test-results/auth", { recursive: true });
  // Merge: each project's worker writes here, and the mobile run sets no passwords.
  const file = "test-results/auth/v10-seeds-r6.json";
  const before = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
  writeFileSync(file, JSON.stringify({ ...before, ...seeds }, null, 2));
  writeFileSync("test-results/auth/traffic-r6.txt", traffic.join("\n\n"), { flag: "a" });
});

async function signedInRequest(baseURL: string, email: string, password: string) {
  const ctx = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL } });
  const r = await ctx.post("/api/auth/sign-in/email", { data: { email, password } });
  expect(r.status()).toBe(200);
  return ctx;
}

// What reaches the sign-in page as the raw query after `next=`; Next decodes it once before safeNext.
const NON_ASCII: [string, string, string][] = [
  ["e acute, encoded once", "/caf%C3%A9", "/caf%C3%A9"],
  ["query with e acute, inner value encoded", "%2Fx%3Fq%3Dcaf%25C3%25A9", "/x?q=caf%C3%A9"],
  ["query with e acute, inner value raw", "/x?q=caf%C3%A9", "/x?q=caf%C3%A9"],
  ["CJK path and an emoji", "/%E6%97%A5%E6%9C%AC?q=%F0%9F%98%80", "/%E6%97%A5%E6%9C%AC?q=%F0%9F%98%80"],
  ["full-width solidus pair", "/%EF%BC%8F%EF%BC%8Fevil.example", "/%EF%BC%8F%EF%BC%8Fevil.example"],
  ["no-break space (refused)", "/%C2%A0/evil.example", "/"],
  ["line separator (refused)", "/%E2%80%A8/evil.example", "/"],
];

test("safeNext: /sign-in and /step-up with a non-ASCII next never answer 500; signed in, the redirect keeps it percent-encoded", async ({ baseURL }) => {
  test.skip(isMobile(), "HTTP checks, once");
  const anon = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
  const owner = await signedInRequest(baseURL!, OWNER.email, OWNER.password);
  try {
    for (const [name, raw, expected] of NON_ASCII) {
      const out = await anon.get(`/sign-in?next=${raw}`, { maxRedirects: 0 });
      note(`signed out GET /sign-in?next=${raw} (${name}) -> ${out.status()}`);
      expect(out.status(), name).toBe(200);
      const html = await out.text();
      expect(html, name).not.toMatch(/(?:href|action|formaction|content)="[^"]*evil\.example/i);

      const r = await owner.get(`/sign-in?next=${raw}`, { maxRedirects: 0 });
      const loc = r.headers()["location"] ?? "";
      note(`signed in GET /sign-in?next=${raw} (${name}) -> ${r.status()} Location ${JSON.stringify(loc)}`);
      expect(r.status(), name).toBe(307);
      expect(loc, name).toBe(expected);
      expect(loc, name).toMatch(/^[!-~]+$/);
      expect(new URL(loc, baseURL).origin, name).toBe(new URL(baseURL!).origin);

      const s = await owner.get(`/step-up?next=${raw}`, { maxRedirects: 0 });
      note(`signed in GET /step-up?next=${raw} (${name}) -> ${s.status()}`);
      expect(s.status(), name).toBe(200);
    }
  } finally {
    await anon.dispose();
    await owner.dispose();
  }
});

test("safeNext: signed out, /x?q=caf%C3%A9 goes to sign-in and the same address survives the sign-in", async ({ browser }) => {
  test.skip(isMobile(), "one browser run is enough; the form is the same on phones");
  const context = await browser.newContext({ reducedMotion: "reduce", ...viewport() });
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
  const statuses: number[] = [];
  page.on("response", (r) => statuses.push(r.status()));
  await page.goto("/x?q=caf%C3%A9");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fx%3Fq%3Dcaf%25C3%25A9$/);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => u.pathname === "/x");
  const landed = new URL(page.url());
  note(`signed out /x?q=caf%C3%A9 -> sign-in -> landed on ${landed.pathname}${landed.search} (q=${landed.searchParams.get("q")})`);
  expect(landed.search).toBe("?q=caf%C3%A9");
  expect(landed.searchParams.get("q")).toBe("café");
  expect(statuses.filter((s) => s >= 500)).toEqual([]);
  await context.close();
});

const MEMBER = { email: "member6@atrium.test", password: "e2e-member6-password-246" };
const NEW_PW = "e2e-member6-new-password-357";

test("Security panel: change password (mismatch named on the field, weak refused, success ends every other session)", async ({ browser, baseURL }) => {
  test.skip(isMobile(), "behaviour once; the phone layout is captured below");
  await addUser(MEMBER.email, "member", MEMBER.password);
  seeds["member6 password"] = MEMBER.password;
  seeds["member6 new password"] = NEW_PW;
  // A second device, signed in first: it must be signed out by the change.
  const other = await signedInRequest(baseURL!, MEMBER.email, MEMBER.password);
  expect((await other.get("/settings/security", { maxRedirects: 0 })).status()).toBe(200);

  const context = await browser.newContext({ reducedMotion: "reduce", ...viewport() });
  await applyVariant(context, VARIANTS[0]!, baseURL!);
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
  record(page);
  await page.goto("/sign-in?next=%2Fsettings%2Fsecurity");
  await page.getByLabel("Email").fill(MEMBER.email);
  await page.getByLabel("Password").fill(MEMBER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => u.pathname === "/settings/security");
  const panel = page.locator("[data-password-panel]");
  await expect(panel.getByRole("heading", { name: "Password" })).toBeVisible();
  await expect(page.locator("[data-users-settings-panel]")).toHaveCount(0); // /settings/security shows one panel

  // Mismatch: named under the second field, which is marked invalid and described by the message.
  await panel.getByLabel("Current password").fill(MEMBER.password);
  await panel.getByLabel("New password", { exact: true }).fill(NEW_PW);
  await panel.getByLabel("New password again").fill(`${NEW_PW}-x`);
  await panel.getByRole("button", { name: "Change password" }).click();
  const again = panel.getByLabel("New password again");
  await expect(again).toHaveAttribute("aria-invalid", "true");
  const describedBy = (await again.getAttribute("aria-describedby"))!;
  await expect(page.locator(`#${describedBy.split(" ")[0]!.replace(/:/g, "\\:")}`)).toHaveText("The two new passwords do not match.");

  // Weak: the server's rule is shown.
  await panel.getByLabel("New password", { exact: true }).fill("unbelievable");
  await again.fill("unbelievable");
  await panel.getByRole("button", { name: "Change password" }).click();
  await expect(panel.locator('[data-auth-message="error"]')).toContainText("common passwords");

  // Wrong current password.
  await panel.getByLabel("Current password").fill("not-the-right-password-1");
  await panel.getByLabel("New password", { exact: true }).fill(NEW_PW);
  await again.fill(NEW_PW);
  await panel.getByRole("button", { name: "Change password" }).click();
  await expect(panel.locator('[data-auth-message="error"]')).toHaveText("That password or code is not right. Try again.");

  // Success.
  await panel.getByLabel("Current password").fill(MEMBER.password);
  await panel.getByLabel("New password", { exact: true }).fill(NEW_PW);
  await again.fill(NEW_PW);
  await panel.getByRole("button", { name: "Change password" }).click();
  await expect(panel.locator('[data-auth-message="info"]')).toHaveText("Password changed. Every other device was signed out.");
  await expect(panel.getByLabel("Current password")).toHaveValue("");
  await page.screenshot({ path: shot("security-password-changed-light"), fullPage: true });

  // This device stays signed in; the other device is signed out; the new password works, the old one not.
  await page.reload();
  await expect(page.locator("[data-password-panel]")).toBeVisible();
  const otherAfter = await other.get("/settings/security", { maxRedirects: 0 });
  expect([302, 303, 307]).toContain(otherAfter.status());
  await other.dispose();
  const oldTry = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL! } });
  expect((await oldTry.post("/api/auth/sign-in/email", { data: MEMBER })).status()).toBeGreaterThanOrEqual(400);
  expect((await oldTry.post("/api/auth/sign-in/email", { data: { email: MEMBER.email, password: NEW_PW } })).status()).toBe(200);
  await oldTry.dispose();
  note(`password change: mismatch on the field (aria-describedby ${describedBy}), weak and wrong refused, success kept this device and signed out the other (${otherAfter.status()}); new password signs in, old does not`);
  await context.close();
});

test("Security and Users panels mounted alone (V4 three themes, V5 390px, V8 reduced motion)", async ({ browser, baseURL }) => {
  const ownerCtx = await signedInRequest(baseURL!, OWNER.email, OWNER.password);
  const state = path.resolve(`test-results/auth/r6-owner-${test.info().project.name}.json`);
  await ownerCtx.storageState({ path: state });
  await ownerCtx.dispose();
  for (const v of VARIANTS) {
    const context = await browser.newContext({ storageState: state, reducedMotion: "reduce", ...viewport() });
    await applyVariant(context, v, baseURL!);
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
    record(page);
    for (const panel of ["security", "users"] as const) {
      await page.goto(`/settings/${panel}`);
      await expect(page.locator(panel === "security" ? "[data-security-settings-panel]" : "[data-users-settings-panel]")).toBeVisible();
      if (panel === "security") {
        await expect(page.locator("[data-password-panel]")).toBeVisible();
        await expect(page.locator("[data-two-factor-panel]")).toBeVisible();
        await expect(page.locator("[data-sessions-panel] li").first()).toBeVisible();
      } else {
        await expect(page.locator("[data-users-manager]")).toBeVisible();
        await expect(page.locator("[data-password-panel]")).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: shot(`panel-${panel}-${v.name}${suffix()}`), fullPage: true });
      if (v.name === "light") {
        const c = await minContrast(page);
        note(`panel ${panel} light${suffix()}: min text contrast ${c.ratio.toFixed(2)} ("${c.text}")`);
        expect(c.ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
    await context.close();
  }
});
