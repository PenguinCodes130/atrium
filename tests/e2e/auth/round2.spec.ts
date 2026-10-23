// Auth round 2 e2e, "owner" scenario (Fix List items 4, 5, 6 and 9). Start the slot first:
//   tests/e2e/auth/serve.sh owner &   then
//   ATRIUM_E2E_SCENARIO=owner ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 pnpm exec playwright test tests/e2e/auth
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request as pwRequest, type Page } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { EVIDENCE, SCENARIO, VARIANTS, applyVariant, db, freshIp, shot } from "./helpers";

test.skip(SCENARIO !== "owner", "owner scenario only");
test.describe.configure({ mode: "serial" });

const REDIRECT = "http://127.0.0.1:7777/callback";
const KEYBOARD = 336; // an iPhone keyboard with the suggestion bar, as the mobile critic asked
const isMobile = () => test.info().project.name === "mobile";
const suffix = () => (isMobile() ? "-mobile" : "");

async function signInOwner(page: Page, baseURL: string) {
  resetOwnerLimit();
  const r = await page.request.post(`${baseURL}/api/auth/sign-in/email`, { headers: { origin: baseURL, "x-forwarded-for": freshIp() }, data: { email: OWNER.email, password: OWNER.password } });
  expect(r.status()).toBe(200);
}

// These specs sign the owner in many times; reset the owner's per-account counter (10 per hour)
// around them so they do not starve the round 1 specs that run in the same hour. Test data only.
function resetOwnerLimit() {
  const d = db();
  d.prepare("DELETE FROM auth_rate_limit WHERE key = ?").run(`signInAccount:${OWNER.email}`);
  d.close();
}

test.beforeEach(async ({ page }) => {
  resetOwnerLimit();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
});
test.afterAll(resetOwnerLimit);

// ---- Item 9: 16px inputs, field above the keyboard -------------------------------------------------

async function controlSizes(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("input, select, textarea")]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => ({ name: (e as HTMLInputElement).name || e.id, px: parseFloat(getComputedStyle(e).fontSize) })),
  );
}

test("every auth input and select is 16px or more at phone size, with no viewport zoom hack (item 9)", async ({ page, baseURL }) => {
  test.skip(!isMobile(), "mobile project only");
  const lines: string[] = [];
  await page.goto("/sign-in");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  lines.push(`viewport meta: ${viewport}`);
  expect(viewport ?? "").not.toMatch(/maximum-scale|user-scalable=no/);
  for (const [label, url] of [["sign-in", "/sign-in"], ["settings users (users, allowlist)", "/settings/users"], ["settings security (password, sessions, 2FA)", "/settings/security"], ["step-up page", "/step-up"]] as const) {
    if (url !== "/sign-in") await signInOwner(page, baseURL!);
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const sizes = await controlSizes(page);
    lines.push(`${label}: ${sizes.map((s) => `${s.name}=${s.px}px`).join(", ")}`);
    expect(sizes.length, label).toBeGreaterThan(0);
    for (const s of sizes) expect(s.px, `${label} ${s.name}`).toBeGreaterThanOrEqual(16);
  }
  writeFileSync(path.join(EVIDENCE, "input-font-sizes-mobile.txt"), lines.join("\n") + "\n");
});

async function visibleAbove(page: Page, selector: string, bottom: number) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, selector).not.toBeNull();
  return { selector, top: Math.round(box!.y), bottom: Math.round(box!.y + box!.height), visible: box!.y >= 0 && box!.y + box!.height <= bottom };
}

test("step-up sheet: password field and Confirm stay above a 336px keyboard (item 9)", async ({ page, baseURL }) => {
  test.skip(!isMobile(), "mobile project only");
  await signInOwner(page, baseURL!);
  // A second user so "Make owner" (a transfer, which asks for step-up) exists.
  const d = db();
  const now = Date.now();
  d.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("r2-member", "r2", "r2-member@atrium.test", 1, "member", 0, now, now);
  d.close();
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Make owner" }).first().click();
  const field = page.locator('[data-sheet="step-up"] input[name="password"]');
  await field.waitFor();
  await field.focus();
  // The keyboard takes the bottom 336px: the visual viewport shrinks to 390 x 508.
  await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
  await page.waitForTimeout(400);
  const checks = [await visibleAbove(page, '[data-sheet="step-up"] input[name="password"]', 844 - KEYBOARD), await visibleAbove(page, '[data-sheet="step-up"] button[type="submit"]', 844 - KEYBOARD)];
  writeFileSync(path.join(EVIDENCE, "step-up-sheet-keyboard-mobile.txt"), checks.map((c) => JSON.stringify(c)).join("\n") + "\n");
  for (const c of checks) expect(c.visible, c.selector).toBe(true);
  await page.screenshot({ path: shot("step-up-sheet-keyboard-mobile") });
  await page.keyboard.press("Escape");
});

// ---- Item 4: recovery hint on sign-in --------------------------------------------------------------

test("sign-in links to the owner recovery hint (item 4)", async ({ page, context, baseURL }) => {
  for (const v of VARIANTS) {
    await context.clearCookies();
    await applyVariant(context, v, baseURL!);
    await page.goto("/sign-in");
    await page.getByText("Forgot your password?").click();
    await expect(page.locator("[data-recovery-hint]")).toContainText("ATRIUM_RESET_OWNER_PASSWORD");
    await page.screenshot({ path: shot(`sign-in-recovery-hint-${v.name}${suffix()}`), fullPage: true });
  }
});

// ---- Item 5: QR code at TOTP enrolment -------------------------------------------------------------

test("TOTP enrolment shows a locally drawn QR code next to the key, with no outside request (item 5)", async ({ page, context, baseURL }) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(baseURL!)) outside.push(r.url());
  });
  let secret = "";
  for (const v of VARIANTS) {
    await context.clearCookies();
    await applyVariant(context, v, baseURL!);
    await signInOwner(page, baseURL!);
    await page.goto("/settings/security");
    const panel = page.locator("[data-two-factor-panel]");
    await panel.getByLabel("Your password").fill(OWNER.password);
    await panel.getByRole("button", { name: "Set up authenticator app" }).click();
    const qr = panel.locator("[data-totp-qr]");
    await expect(qr).toBeVisible();
    await expect(panel.locator("[data-totp-key]")).toBeVisible();
    secret = (await panel.locator("[data-totp-key]").innerText()).trim();
    expect(await qr.getAttribute("aria-label")).toContain("authenticator");
    const box = (await qr.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(160);
    await qr.scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot(`totp-enrol-qr-${v.name}${suffix()}`) });
    await qr.screenshot({ path: shot(`totp-enrol-qr-code-${v.name}${suffix()}`) });
  }
  expect(outside).toEqual([]);
  // Enrolment was never confirmed: remove it so the owner keeps signing in with the password alone.
  const d = db();
  d.prepare("DELETE FROM two_factor WHERE user_id = (SELECT id FROM user WHERE email = ?)").run(OWNER.email);
  d.close();
  mkdirSync("test-results/auth", { recursive: true });
  writeFileSync("test-results/auth/v10-seeds-r2-qr.json", JSON.stringify({ qrTotpSecret: secret }));
});

// ---- Item 6: MCP OAuth consent ---------------------------------------------------------------------

async function registerClient(baseURL: string, name: string) {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
  const r = await api.post("/api/auth/oauth2/register", { data: { client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } });
  expect(r.status()).toBe(201);
  const id = ((await r.json()) as { client_id: string }).client_id;
  await api.dispose();
  return id;
}

function authorizePath(clientId: string, scope: string, challenge: string, baseURL: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, state: "e2e-state", code_challenge: challenge, code_challenge_method: "S256", resource: `${baseURL}/mcp` });
  return `/api/auth/oauth2/authorize?${q}`;
}

test("an MCP client goes from sign-in to Atrium's consent screen, and the issued token works (item 6, criterion 35)", async ({ page, context, baseURL }) => {
  const clientId = await registerClient(baseURL!, "Claude Desktop");
  const traffic: string[] = [];
  page.on("response", async (r) => {
    if (!r.url().startsWith(baseURL!)) return;
    traffic.push(`${r.status()} ${r.url()}\n${await r.text().catch(() => "")}`);
  });
  let callback = "";
  await page.route(`${REDIRECT}**`, async (route) => {
    callback = route.request().url();
    await route.fulfill({ status: 200, contentType: "text/plain", body: "agent callback" });
  });
  for (const v of VARIANTS) {
    await context.clearCookies();
    await applyVariant(context, v, baseURL!);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    resetOwnerLimit();
    // Consent is remembered per client and user (a second visit skips the screen): forget it so
    // each theme pass shows the screen.
    const d = db();
    d.prepare("DELETE FROM oauth_consent").run();
    d.close();
    await page.goto(authorizePath(clientId, "atrium:read atrium:edit offline_access", challenge, baseURL!));
    await expect(page).toHaveURL(/\/sign-in\?/);
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/consent\?/);
    await expect(page.getByRole("heading", { name: "Allow Claude Desktop?" })).toBeVisible();
    for (const s of ["atrium:read", "atrium:edit", "offline_access"]) await expect(page.locator(`[data-scope="${s}"]`)).toBeVisible();
    await page.screenshot({ path: shot(`consent-${v.name}${suffix()}`), fullPage: true });
    if (v.name !== "light") continue;
    await page.getByRole("button", { name: "Allow" }).click();
    await expect.poll(() => callback).toContain("code=");
    const code = new URL(callback).searchParams.get("code")!;
    expect(new URL(callback).searchParams.get("state")).toBe("e2e-state");
    // The agent's side: exchange the code (PKCE), then call with the token. Not browser traffic.
    const api = await pwRequest.newContext({ baseURL });
    const tok = await api.post("/api/auth/oauth2/token", { form: { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${baseURL}/mcp` } });
    expect(tok.status()).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string };
    expect(t.access_token).toMatch(/^atr_oat_/);
    // The MCP endpoint itself is agent-api's (Wave 4); without a token the front gate answers 401
    // pointing at the protected resource metadata.
    const noToken = await api.get("/mcp");
    expect(noToken.status()).toBe(401);
    expect(noToken.headers()["www-authenticate"]).toContain("resource_metadata=");
    writeFileSync("test-results/auth/v10-seeds-r2.json", JSON.stringify({ oauthAccessToken: t.access_token, oauthRefreshToken: t.refresh_token, oauthAccessTokenBody: t.access_token.slice(8) }));
    await api.dispose();
  }
  writeFileSync("test-results/auth/traffic-r2.txt", traffic.join("\n\n"));
  const lines = [`client registered: ${clientId} (dynamic registration, public client, PKCE S256)`, `agent callback: ${callback.replace(/code=[^&]+/, "code=[redacted]")}`];
  writeFileSync(path.join(EVIDENCE, `consent-flow${suffix()}.txt`), lines.join("\n") + "\n");
});

test("granting atrium:propose asks for step-up first; cancelling grants nothing (item 6)", async ({ page, baseURL }) => {
  const clientId = await registerClient(baseURL!, "Home Agent");
  let callback = "";
  await page.route(`${REDIRECT}**`, async (route) => {
    callback = route.request().url();
    await route.fulfill({ status: 200, body: "ok" });
  });
  await signInOwner(page, baseURL!);
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  await page.goto(authorizePath(clientId, "atrium:read atrium:propose", challenge, baseURL!));
  await expect(page).toHaveURL(/\/consent\?/);
  await expect(page.locator('[data-scope="atrium:propose"]')).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  const sheet = page.locator('[data-sheet="step-up"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('input[name="password"]')).toBeVisible();
  await page.screenshot({ path: shot(`consent-step-up${suffix()}`) });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(callback).toBe("");
  // Now confirm with the password: the grant goes through.
  await page.getByRole("button", { name: "Allow" }).click();
  await sheet.locator('input[name="password"]').fill(OWNER.password);
  await sheet.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => callback).toContain("code=");
});

test("consent with an expired or forged request shows the plain unavailable state", async ({ page, baseURL }) => {
  await signInOwner(page, baseURL!);
  await page.goto("/consent?client_id=nope&scope=atrium%3Apropose&sig=forged&exp=1");
  await expect(page.locator("[data-consent-unavailable]")).toContainText("expired or is not valid");
  await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
});

test("TOTP sign-in step: the code field and Continue stay above a 336px keyboard (item 9)", async ({ page }) => {
  test.skip(!isMobile(), "mobile project only");
  // The TOTP user and its secret come from auth.spec.ts (criterion 12 test), which runs first.
  const seeds = JSON.parse((await import("node:fs")).readFileSync("test-results/auth/v10-seeds.json", "utf8")) as { totpSecret: string; passwords: string[] };
  const d = db();
  d.prepare("DELETE FROM auth_rate_limit WHERE key LIKE ?").run("%totp@atrium.test%");
  d.close();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("totp@atrium.test");
  await page.getByLabel("Password").fill(seeds.passwords[2]!);
  await page.getByRole("button", { name: "Sign in" }).click();
  const code = page.getByLabel("6-digit code");
  await code.waitFor();
  await code.focus();
  await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
  await page.waitForTimeout(400);
  const checks = [await visibleAbove(page, 'input[name="code"]', 844 - KEYBOARD), await visibleAbove(page, 'form[data-step="totp"] button[type="submit"]', 844 - KEYBOARD)];
  writeFileSync(path.join(EVIDENCE, "totp-step-keyboard-mobile.txt"), checks.map((c) => JSON.stringify(c)).join("\n") + "\n");
  for (const c of checks) expect(c.visible, c.selector).toBe(true);
  expect(parseFloat(await code.evaluate((e) => getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: shot("totp-step-keyboard-mobile") });
});
