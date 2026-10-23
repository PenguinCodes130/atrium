// Auth e2e, round 5 (auth-spec-v3, architecture v3 Amendment 3): member invites and resets, /account in
// the shell, the allowlist low items, and the V4, V5 and V8 captures of the new screens.
// Two scenarios:
//   tests/e2e/auth/serve.sh owner &            then ATRIUM_E2E_ROUND=r5 ATRIUM_E2E_SCENARIO=owner ...
//   tests/e2e/auth/serve.sh owner-nogoogle &   then ATRIUM_E2E_ROUND=r5 ATRIUM_E2E_SCENARIO=owner-nogoogle ...
// with ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 pnpm exec playwright test tests/e2e/auth/round5.spec.ts
// Writes test-results/auth/v10-seeds-r5.json (tokens, their hashes, passwords) and traffic-r5.txt for V10.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request as pwRequest, type BrowserContext, type Page } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { encodeQr, qrPath } from "../../../src/features/auth/qr/encode";
import { EVIDENCE, SCENARIO, VARIANTS, addUser, applyVariant, db, freshIp, minContrast, shot, signInUI, tabAudit, type Variant } from "./helpers";

test.skip(SCENARIO !== "owner" && SCENARIO !== "owner-nogoogle", "owner or owner-nogoogle scenario only");
test.describe.configure({ mode: "default" });
test.setTimeout(180_000);

const INVITEE_PW = "e2e-invitee-password-789";
const RESET_PW = "e2e-reset-member-pass-321";
const MEMBER = { email: "member5@atrium.test", password: "e2e-member5-password-654" };
const DEAD = "This link has expired or was already used";
const LINK_RE = /^http:\/\/127\.0\.0\.1:\d+\/invite\/atr_i_[A-Za-z0-9_-]{43}$/;

const isMobile = () => test.info().project.name === "mobile";
const suffix = () => (isMobile() ? "-mobile" : "");
const viewport = () => (isMobile() ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } });
const log: string[] = [];
const note = (line: string) => log.push(`[${test.info().project.name}] ${line}`);
const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

// ---- V10 seeds and traffic --------------------------------------------------------------------------
const SEEDS = "test-results/auth/v10-seeds-r5.json";
const TRAFFIC = "test-results/auth/traffic-r5.txt";
function seed(label: string, value: string) {
  mkdirSync("test-results/auth", { recursive: true });
  const cur = existsSync(SEEDS) ? (JSON.parse(readFileSync(SEEDS, "utf8")) as Record<string, string>) : {};
  cur[label] = value;
  writeFileSync(SEEDS, JSON.stringify(cur, null, 2));
}
function seedLink(url: string, label: string) {
  seed(`${label} token`, tokenOf(url));
  seed(`${label} token hash`, sha(tokenOf(url)));
}
/**
 * Records every response body and its headers (not request URLs: a person's own link is in the address
 * they opened). `gate()` false skips a response, used to leave out the one create response that is
 * allowed to carry the link once.
 */
function record(page: Page, gate: () => boolean = () => true) {
  page.on("response", async (r) => {
    if (!gate()) return;
    let body = await r.text().catch(() => "");
    const headers = { ...r.headers() };
    delete headers["location"]; // a 303 to the visitor's own /invite/<token>/set echoes the link they opened
    // A response to the holder's own /invite/<token> address carries that token in Next's route tree (the
    // dynamic segment is part of the page). That one token is masked there and only there; every other
    // token, every hash and every password is still checked in every response.
    const own = /atr_i_[A-Za-z0-9_-]{43}/.exec(new URL(r.url()).pathname)?.[0];
    if (own) body = body.split(own).join("<own link token>");
    mkdirSync("test-results/auth", { recursive: true });
    writeFileSync(TRAFFIC, `### ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname.replace(/atr_i_[A-Za-z0-9_-]+/, "atr_i_<token>")}\n${JSON.stringify(headers)}\n${body}\n\n`, { flag: "a" });
  });
}

// ---- Sessions ---------------------------------------------------------------------------------------
const states = new Map<string, string>();
async function stateFor(baseURL: string, email: string, password: string): Promise<string> {
  const known = states.get(email);
  if (known) return known;
  const ctx = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL } });
  const r = await ctx.post("/api/auth/sign-in/email", { data: { email, password } });
  expect(r.status()).toBe(200);
  mkdirSync("test-results/auth", { recursive: true });
  const p = path.resolve(`test-results/auth/r5-state-${email.replace(/\W/g, "_")}-${test.info().project.name}.json`);
  await ctx.storageState({ path: p });
  await ctx.dispose();
  states.set(email, p);
  return p;
}

async function ownerPage(browser: import("@playwright/test").Browser, baseURL: string, v: Variant = VARIANTS[0]!, reduced = true): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: await stateFor(baseURL, OWNER.email, OWNER.password), reducedMotion: reduced ? "reduce" : "no-preference", ...viewport() });
  await applyVariant(context, v, baseURL);
  await context.addCookies([{ name: "atrium_swept", value: "1", url: baseURL }]);
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
  return { context, page };
}

async function freshPage(browser: import("@playwright/test").Browser, baseURL: string, v: Variant = VARIANTS[0]!, reduced = true) {
  const context = await browser.newContext({ reducedMotion: reduced ? "reduce" : "no-preference", ...viewport() });
  await applyVariant(context, v, baseURL);
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
  return { context, page };
}

/** Picks an option in the shell's square menu (settings' SelectMenu; settings r3 SFR replaced the native selects). */
async function pickFromMenu(page: Page, trigger: import("@playwright/test").Locator, value: string) {
  await trigger.click();
  const name = await trigger.getAttribute("data-select");
  await page.locator(`[data-select-menu="${name}"] [data-option="${value}"]`).click();
  await expect(page.locator(`[data-select-menu="${name}"]`)).toHaveCount(0);
}

/** Creates an invite through the users and security screen and returns the one-time link text. */
async function inviteThroughUI(page: Page, email: string, role: "member" | "viewer"): Promise<string> {
  const form = page.locator("[data-invite-form]");
  await form.getByLabel("Their email").fill(email);
  await pickFromMenu(page, form.locator('[data-select="invite-role"]'), role);
  await form.getByRole("button", { name: "Create invite link" }).click();
  const url = (await page.locator("[data-one-time-url]").textContent({ timeout: 15_000 }))!.trim();
  expect(url).toMatch(LINK_RE);
  return url;
}

let ownerLinks: { invite?: string; reset?: string } = {};

test.beforeAll(() => {
  const d = db();
  try {
    d.prepare("DELETE FROM auth_rate_limit").run();
  } finally {
    d.close();
  }
});

test.afterAll(() => {
  writeFileSync(path.join(EVIDENCE, `round5-checks-${SCENARIO}.txt`), log.join("\n") + "\n", { flag: "a" });
});

// ---- owner scenario ---------------------------------------------------------------------------------

// Round 6 (A4.4): /account moved to /settings/security, which settings renders inside the shell; the
// shell placement checks of criterion 23 move to settings' suite. Auth checks the redirect itself here.
test("23 (round 6): /account and every path under it answer 308 to /settings/security with the query kept", async ({ browser, baseURL }) => {
  test.skip(SCENARIO !== "owner", "owner scenario");
  test.skip(isMobile(), "HTTP checks, once");
  const { context, page } = await ownerPage(browser, baseURL!);
  const cases: [string, string][] = [
    ["/account", "/settings/security"],
    ["/account?tab=sessions", "/settings/security?tab=sessions"],
    ["/account/security/x?a=1&b=caf%C3%A9", "/settings/security?a=1&b=caf%C3%A9"],
  ];
  for (const signedIn of [true, false]) {
    const ctx = signedIn ? page.request : await pwRequest.newContext({ baseURL });
    for (const [from, to] of cases) {
      const r = await ctx.get(from, { maxRedirects: 0, headers: { "x-forwarded-for": freshIp() } });
      note(`${signedIn ? "signed in" : "signed out"} GET ${from} -> ${r.status()} ${r.headers()["location"]}`);
      expect(r.status(), from).toBe(308);
      expect(new URL(r.headers()["location"]!, baseURL).pathname + new URL(r.headers()["location"]!, baseURL).search, from).toBe(to);
    }
    // A trailing slash is first normalised by Next (308 to /account), then redirected the same way.
    const slash = await ctx.get("/account/?tab=x", { headers: { "x-forwarded-for": freshIp() }, maxRedirects: 5 });
    note(`${signedIn ? "signed in" : "signed out"} GET /account/?tab=x (followed) -> ${slash.url()}`);
    expect(new URL(slash.url()).pathname).toMatch(/^\/(settings\/security|sign-in)$/);
    if (signedIn) expect(new URL(slash.url()).pathname).not.toBe("/account");
    if (!signedIn) await (ctx as Awaited<ReturnType<typeof pwRequest.newContext>>).dispose();
  }
  await context.close();
});

test("21, 22: empty Add names the rule and focuses; Remove is named per entry and Undo restores the role; the sign-in line names the configured provider", async ({ browser, baseURL }) => {
  test.skip(SCENARIO !== "owner", "owner scenario");
  const { context, page } = await ownerPage(browser, baseURL!);
  record(page);
  await page.goto("/settings/users");
  const field = page.getByLabel("Email or *@domain");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Enter an email or *@domain.")).toBeVisible();
  await expect(field).toBeFocused();
  const email = `undo-${test.info().project.name}@atrium.test`;
  await field.fill(email);
  await pickFromMenu(page, page.locator('[data-select="new-pattern-role"]'), "member");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(`[data-pattern="${email}"]`)).toBeVisible();
  // Adding it again is refused and changes nothing (criterion 3, in the browser).
  await field.fill(email);
  await pickFromMenu(page, page.locator('[data-select="new-pattern-role"]'), "viewer");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Already on the allowlist as member.")).toBeVisible();
  await page.getByRole("button", { name: `Remove ${email}` }).click();
  await expect(page.locator(`[data-pattern="${email}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(`[data-pattern="${email}"] [data-select^="entry-role"]`)).toHaveText(/Member/);
  // The owner's entry has no role control and no Remove.
  await expect(page.locator(`[data-pattern="${OWNER.email}"] select, [data-pattern="${OWNER.email}"] button`)).toHaveCount(0);
  const line = (await page.locator("[data-sign-in-methods]").textContent())!;
  note(`allowlist sign-in line (Google configured): "${line}"`);
  expect(line).toContain("invite link");
  expect(line).toContain("Google");
  await context.close();
});

test("9, 13, V4, V5, V8: the one-time window (link text, QR, copy, close) in three themes; no reset on the owner's row", async ({ browser, baseURL }) => {
  test.skip(SCENARIO !== "owner", "owner scenario");
  const memberId = await addUser(MEMBER.email, "member", MEMBER.password);
  seed("member password", MEMBER.password);
  expect(memberId).toBeTruthy();
  for (const v of VARIANTS) {
    const { context, page } = await ownerPage(browser, baseURL!, v);
    if (!isMobile()) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    let windowOpen = false;
    record(page, () => !windowOpen);
    await page.goto("/settings/users");
    await expect(page.locator(`[data-user="${OWNER.email}"] [data-reset-user]`)).toHaveCount(0);
    windowOpen = true;
    const email = `invitee-${v.name}-${test.info().project.name}@atrium.test`;
    const url = await inviteThroughUI(page, email, "member");
    seedLink(url, `invite ${v.name}${suffix()}`);
    const svgPath = await page.locator("[data-one-time-link] svg[role=img] path").getAttribute("d");
    expect(svgPath).toBe(qrPath(encodeQr(url, "M"), 4));
    await expect(page.getByText("This link is shown once", { exact: false })).toBeVisible();
    await page.screenshot({ path: shot(`account-invite-window-${v.name}${suffix()}`), fullPage: true });
    if (v.name === "light") {
      const c = await minContrast(page);
      note(`/settings/users with the one-time window, light: min contrast ${c.ratio.toFixed(2)} ("${c.text}")`);
      expect(c.ratio).toBeGreaterThanOrEqual(4.5);
      if (!isMobile()) {
        await page.getByRole("button", { name: "Copy link" }).click();
        await expect(page.getByRole("region", { name: "Notifications" }).getByText("Link copied")).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
      }
      // A reset link for the member, from their row.
      await page.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: `Reset password for ${MEMBER.email}` }).click();
      const resetUrl = (await page.locator('[data-one-time-link="reset"] [data-one-time-url]').textContent({ timeout: 15_000 }))!.trim();
      expect(resetUrl).toMatch(LINK_RE);
      seedLink(resetUrl, `reset${suffix()}`);
      ownerLinks = { invite: url, reset: resetUrl };
    }
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator("[data-one-time-url]")).toHaveCount(0);
    await expect(page.locator("[data-one-time-link]")).toHaveCount(0);
    windowOpen = false;
    // Listing never shows the link again.
    await page.reload();
    expect(await page.content()).not.toContain(tokenOf(url));
    await expect(page.locator(`[data-account-link="waiting"][data-link-email="${email}"]`)).toBeVisible();
    await page.screenshot({ path: shot(`account-${v.name}${suffix()}`), fullPage: true });
    await context.close();
  }
  note(`one-time window: link text matches ${LINK_RE}, QR path equals the encoder's path for that URL, copy put the URL on the clipboard, close removed text and QR`);
});

test("10, 25, V4, V5, V8: the invite page, the reset page, the dead-link and signed-in screens in three themes, by keyboard, 44px, 4.5:1", async ({ browser, baseURL }) => {
  test.skip(SCENARIO !== "owner", "owner scenario");
  expect(ownerLinks.invite && ownerLinks.reset).toBeTruthy();
  const screens: [string, (page: Page) => Promise<void>][] = [
    ["invite-set", async (page) => {
      await page.goto(new URL(ownerLinks.invite!).pathname);
      await expect(page).toHaveURL(/\/invite\/atr_i_[A-Za-z0-9_-]{43}\/set$/);
      await expect(page.locator("[data-link-email]")).toHaveAttribute("readonly", "");
      await expect(page.getByRole("heading", { name: "Join this Atrium" })).toBeVisible();
    }],
    ["reset-set", async (page) => {
      await page.goto(new URL(ownerLinks.reset!).pathname);
      await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
      await expect(page.locator("[data-link-email]")).toHaveValue(MEMBER.email);
    }],
    ["expired", async (page) => {
      await page.goto(`/invite/atr_i_${"Z".repeat(43)}`);
      await expect(page).toHaveURL(/\/invite\/expired$/);
      await expect(page.locator("[data-account-link-dead]")).toHaveText(DEAD);
      await expect(page.locator("[data-account-link-screen] a, [data-account-link-screen] button")).toHaveCount(0);
    }],
  ];
  for (const v of VARIANTS) {
    for (const [name, open] of screens) {
      const { context, page } = await freshPage(browser, baseURL!, v);
      record(page);
      await open(page);
      await page.screenshot({ path: shot(`${name}-${v.name}${suffix()}`), fullPage: true });
      if (v.name === "light") await audit(page, name);
      await context.close();
    }
    const { context, page } = await ownerPage(browser, baseURL!, v);
    record(page);
    await page.goto(new URL(ownerLinks.invite!).pathname);
    await expect(page).toHaveURL(/\/invite\/signed-in$/);
    await expect(page.getByRole("heading", { name: "You are already signed in" })).toBeVisible();
    await page.screenshot({ path: shot(`signed-in-${v.name}${suffix()}`), fullPage: true });
    if (v.name === "light") await audit(page, "signed-in");
    await context.close();
  }

  // Criterion 10 in the browser: a short password and a mismatch are refused by the field; nothing is used.
  const { context, page } = await freshPage(browser, baseURL!);
  record(page);
  await page.goto(new URL(ownerLinks.invite!).pathname);
  await page.getByLabel("Password", { exact: true }).fill("elevenchars");
  await page.getByLabel("Type it again").fill("elevenchars");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("unbelievable");
  await page.getByLabel("Type it again").fill("unbelievable");
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page.getByText("That password is on the list of common passwords. Pick another.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(INVITEE_PW);
  await page.getByLabel("Type it again").fill(`${INVITEE_PW}x`);
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page.getByText("The two passwords do not match.", { exact: false })).toBeVisible();
  await page.screenshot({ path: shot(`invite-set-errors${suffix()}`), fullPage: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Join this Atrium" })).toBeVisible();
  await context.close();

  // V8 with motion allowed, for comparison with the reduced captures above.
  const m = await freshPage(browser, baseURL!, VARIANTS[0]!, false);
  await m.page.goto(new URL(ownerLinks.invite!).pathname);
  await m.page.screenshot({ path: shot(`invite-set-motion-on${suffix()}`), fullPage: true });
  await m.context.close();

  // Criterion 12 in the browser: the reset sets the password; the old one stops working.
  const r = await freshPage(browser, baseURL!);
  record(r.page);
  await r.page.goto(new URL(ownerLinks.reset!).pathname);
  const newPw = `${RESET_PW}${suffix()}`;
  await r.page.getByLabel("New password").fill(newPw);
  await r.page.getByLabel("Type it again").fill(newPw);
  seed(`reset password${suffix()}`, newPw);
  await r.page.getByRole("button", { name: "Save new password" }).click();
  await expect(r.page.getByRole("heading", { name: "Password changed" })).toBeVisible();
  await r.page.screenshot({ path: shot(`reset-done${suffix()}`), fullPage: true });
  await r.context.close();
  const ctx = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL! } });
  expect((await ctx.post("/api/auth/sign-in/email", { data: MEMBER })).status()).toBe(401);
  expect((await ctx.post("/api/auth/sign-in/email", { data: { email: MEMBER.email, password: newPw } })).status()).toBe(200);
  await ctx.dispose();
  MEMBER.password = newPw;
  note("reset through the page: Password changed; the old password answers 401 and the new one 200");
});

async function audit(page: Page, name: string) {
  const c = await minContrast(page);
  note(`${name}: min text contrast ${c.ratio.toFixed(2)} ("${c.text}")`);
  expect(c.ratio, name).toBeGreaterThanOrEqual(4.5);
  if (isMobile()) return;
  const stops = await tabAudit(page, 20);
  for (const s of stops) {
    expect(s.outline, `${name}: ${s.label}`).toMatch(/solid 2px/);
    if (s.tag !== "a" || s.label) expect(Math.min(s.w, s.h), `${name}: ${s.label}`).toBeGreaterThanOrEqual(44);
  }
  note(`${name} keyboard: ${stops.length} tab stops (${stops.map((s) => `${s.label || s.tag} ${s.w}x${s.h}`).join(", ")}), all with the 2px ring`);
}

test("14, 15, 16, 19: route sweep with no cookie, a session cookie and a bearer token; the 31st open is limited", async ({ browser, baseURL }) => {
  test.skip(SCENARIO !== "owner", "owner scenario");
  test.skip(isMobile(), "HTTP checks, once");
  const { context, page } = await ownerPage(browser, baseURL!);
  await page.goto("/settings/users");
  const live = await inviteThroughUI(page, "sweep-live@atrium.test", "viewer");
  await page.getByRole("button", { name: "Close" }).click();
  const used = await inviteThroughUI(page, "sweep-used@atrium.test", "viewer");
  await page.getByRole("button", { name: "Close" }).click();
  const revoked = await inviteThroughUI(page, "sweep-revoked@atrium.test", "viewer");
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Revoke the invite link for sweep-revoked@atrium.test" }).click();
  await expect(page.locator('[data-account-link="revoked"][data-link-email="sweep-revoked@atrium.test"]')).toBeVisible();
  const expired = await inviteThroughUI(page, "sweep-expired@atrium.test", "viewer");
  await page.getByRole("button", { name: "Close" }).click();
  await context.close();
  for (const [l, u] of [["sweep live", live], ["sweep used", used], ["sweep revoked", revoked], ["sweep expired", expired]] as const) seedLink(u, l);
  // Expiry is only time passing: move this one's expiry into the past in the slot database.
  const d = db();
  try {
    d.prepare("UPDATE account_link SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1000, sha(tokenOf(expired)));
  } finally {
    d.close();
  }
  const anon = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL! } });
  expect((await anon.post(new URL(used).pathname, { data: { password: INVITEE_PW, confirm: INVITEE_PW } })).status()).toBe(200);
  seed("sweep invitee password", INVITEE_PW);

  const snap = async (ctx: import("@playwright/test").APIRequestContext, p: string) => {
    const r = await ctx.get(p, { maxRedirects: 0 });
    const h = r.headers();
    return { status: r.status(), location: h["location"] ?? "", setCookie: h["set-cookie"] ?? "", body: await r.text(), cache: h["cache-control"] ?? "" };
  };
  const out: string[] = [];
  const dead: [string, string][] = [
    ["unknown", `/invite/atr_i_${"Q".repeat(43)}`],
    ["malformed", "/invite/hello"],
    ["expired", new URL(expired).pathname],
    ["used", new URL(used).pathname],
    ["revoked", new URL(revoked).pathname],
  ];
  const fresh = () => pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL! } });
  const answers = new Set<string>();
  for (const [name, p] of dead) {
    const c = await fresh();
    const s = await snap(c, p);
    await c.dispose();
    out.push(`no cookie, ${name}: ${JSON.stringify(s)}`);
    expect(s.setCookie, name).toBe("");
    answers.add(JSON.stringify(s));
  }
  expect(answers.size).toBe(1);
  expect(JSON.parse([...answers][0]!)).toMatchObject({ status: 303, location: "/invite/expired", body: "" });

  const sessionCtx = await pwRequest.newContext({ baseURL, storageState: await stateFor(baseURL!, OWNER.email, OWNER.password), extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
  const signedIn = await snap(sessionCtx, new URL(live).pathname);
  out.push(`session cookie, live: ${JSON.stringify(signedIn)}`);
  expect(signedIn).toMatchObject({ status: 303, location: "/invite/signed-in" });
  await sessionCtx.dispose();

  const bearer = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), authorization: "Bearer atr_pat_e2e_not_a_token" } });
  for (const p of [new URL(live).pathname, `${new URL(live).pathname}/set`]) {
    const s = await snap(bearer, p);
    out.push(`bearer, ${p.replace(/atr_i_[^/]+/, "<live>")}: ${s.status} ${s.body.slice(0, 120)}`);
    expect(s.status).toBe(403);
  }
  const bp = await bearer.post(new URL(live).pathname, { data: { password: INVITEE_PW, confirm: INVITEE_PW }, headers: { origin: baseURL! } });
  out.push(`bearer POST live: ${bp.status()}`);
  expect(bp.status()).toBe(403);
  await bearer.dispose();

  // Still live for a signed-out browser after the signed-in and bearer attempts.
  const later = await fresh();
  const s = await snap(later, new URL(live).pathname);
  out.push(`no cookie, live, afterwards: ${s.status} ${s.location.replace(/atr_i_[^/]+/, "<live>")}`);
  expect(s.status).toBe(303);
  expect(s.location).toMatch(/\/set$/);
  await later.dispose();

  // Criterion 15: 30 opens per minute per IP, then 429 with Retry-After.
  const ip = freshIp();
  const burst = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": ip } });
  const codes: number[] = [];
  let retry = "";
  for (let i = 0; i < 31; i++) {
    const r = await burst.get(`/invite/atr_i_${String(i).padStart(43, "R")}`, { maxRedirects: 0 });
    codes.push(r.status());
    if (r.status() === 429) retry = r.headers()["retry-after"] ?? "";
  }
  out.push(`31 opens from ${ip}: ${codes.join(",")}; Retry-After ${retry}`);
  expect(codes.slice(0, 30).every((c) => c === 303)).toBe(true);
  expect(codes[30]).toBe(429);
  expect(Number(retry)).toBeGreaterThan(0);
  await burst.dispose();
  await anon.dispose();
  writeFileSync(path.join(EVIDENCE, "route-sweep-links.txt"), out.join("\n") + "\n");
});

// ---- owner-nogoogle scenario ------------------------------------------------------------------------

test("24, 22: story 1 end to end without Google or OIDC: invite as Member, set a password, skip the authenticator, signed in, sign in again", async ({ browser, baseURL }) => {
  test.skip(SCENARIO !== "owner-nogoogle", "owner-nogoogle scenario");
  const email = `family-${test.info().project.name}@atrium.test`;
  const pw = `${INVITEE_PW}-${test.info().project.name}`;
  seed(`story password${suffix()}`, pw);

  // The owner signs in on the screen and invites.
  const o = await freshPage(browser, baseURL!);
  record(o.page, () => false);
  await o.context.addCookies([{ name: "atrium_swept", value: "1", url: baseURL! }]);
  await o.page.goto("/sign-in");
  await expect(o.page.getByRole("button", { name: /google/i })).toHaveCount(0);
  await signInUI(o.page, OWNER.email, OWNER.password);
  await o.page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
  await o.page.goto("/settings/users");
  const line = (await o.page.locator("[data-sign-in-methods]").textContent())!;
  note(`allowlist sign-in line (no providers): "${line}"`);
  expect(line).not.toMatch(/google|oidc/i);
  const url = await inviteThroughUI(o.page, email, "member");
  seedLink(url, `story invite${suffix()}`);
  await o.page.screenshot({ path: shot(`story-owner-invite${suffix()}`), fullPage: true });
  await o.context.close();

  // A fresh browser opens the link and sets a password.
  const p = await freshPage(browser, baseURL!);
  record(p.page);
  await p.page.goto(new URL(url).pathname);
  await expect(p.page.locator("[data-link-email]")).toHaveValue(email);
  await p.page.getByLabel("Password", { exact: true }).fill(pw);
  await p.page.getByLabel("Type it again").fill(pw);
  await p.page.getByRole("button", { name: "Create my account" }).click();
  await expect(p.page.getByRole("heading", { name: "You are signed in" })).toBeVisible();
  await expect(p.page.getByRole("button", { name: "Set up authenticator app" })).toBeVisible();
  await p.page.screenshot({ path: shot(`story-invite-done${suffix()}`), fullPage: true });
  await p.page.getByRole("link", { name: "Continue to Atrium" }).click();
  await p.page.waitForURL((u) => u.pathname === "/");
  const session = (await (await p.page.request.get("/api/auth/get-session")).json()) as { user?: { email: string; role: string } };
  note(`after the invite: on ${new URL(p.page.url()).pathname}, session ${session.user?.email} as ${session.user?.role}`);
  expect(session.user).toMatchObject({ email, role: "member" });
  await p.page.screenshot({ path: shot(`story-landed${suffix()}`), fullPage: true });
  await p.context.close();

  // And signs in again later with that password.
  const again = await freshPage(browser, baseURL!);
  await signInUI(again.page, email, pw);
  await again.page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
  const s2 = (await (await again.page.request.get("/api/auth/get-session")).json()) as { user?: { email: string; role: string } };
  expect(s2.user).toMatchObject({ email, role: "member" });
  note(`second sign-in with the chosen password: ${s2.user?.email} as ${s2.user?.role}`);
  await again.context.close();
});
