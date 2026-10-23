// Auth e2e, "owner" scenario (both owner variables set). Start the slot first:
//   tests/e2e/auth/serve.sh owner &   then
//   ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 pnpm exec playwright test tests/e2e/auth
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request as pwRequest } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { EVIDENCE, SCENARIO, VARIANTS, addUser, applyVariant, freshIp, minContrast, secretFromUri, shot, signInUI, tabAudit, totp, db } from "./helpers";

test.skip(SCENARIO !== "owner", "owner scenario only");
test.describe.configure({ mode: "serial" });

const desktopOnly = () => test.skip(test.info().project.name !== "desktop", "desktop project only");
const MEMBER = { email: "member@atrium.test", password: "e2e-member-password-456" };
const TOTP_USER = { email: "totp@atrium.test", password: "e2e-totp-user-password-789" };

// One owner sign-in per worker, through the real endpoint, reused as storage state.
let ownerStatePath: string | undefined;
async function ownerState(baseURL: string): Promise<string> {
  if (ownerStatePath) return ownerStatePath;
  const ctx = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL } });
  const r = await ctx.post("/api/auth/sign-in/email", { data: { email: OWNER.email, password: OWNER.password } });
  expect(r.status()).toBe(200);
  mkdirSync("test-results/auth", { recursive: true });
  ownerStatePath = path.resolve("test-results/auth/owner-state.json");
  await ctx.storageState({ path: ownerStatePath });
  await ctx.dispose();
  return ownerStatePath;
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
});

test("sign-in screen in three shell variants, no sign-up option (V4, V5, criterion 8)", async ({ page, context, baseURL }, info) => {
  for (const v of VARIANTS) {
    await context.clearCookies();
    await applyVariant(context, v, baseURL!);
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Sign in to Atrium" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(page.getByText(/sign up|create account|register/i)).toHaveCount(0);
    await page.screenshot({ path: shot(`sign-in-${v.name}${info.project.name === "mobile" ? "-mobile" : ""}`), fullPage: true });
  }
});

test("wrong password: one plain message that does not say which part was wrong", async ({ page }) => {
  desktopOnly();
  await signInUI(page, OWNER.email, "not-the-right-password");
  await expect(page.locator("#signin-message")).toHaveText("That email and password do not match. Check both and try again.");
  await page.screenshot({ path: shot("sign-in-error-light") });
});

test("not on the allowlist: refused with a plain message and no session (criterion 9)", async ({ page, context }) => {
  desktopOnly();
  await signInUI(page, "stranger@elsewhere.test", "whatever-password-123");
  await expect(page.locator("#signin-message")).toContainText("not on the allowlist");
  expect((await context.cookies()).find((c) => c.name === "atrium.session")).toBeUndefined();
});

test("owner signs in; cookie is atrium.session, httpOnly, SameSite=Lax, not Secure over http (criteria 3, 19)", async ({ page, context }) => {
  desktopOnly();
  await signInUI(page, OWNER.email, OWNER.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
  const c = (await context.cookies()).find((x) => x.name === "atrium.session");
  expect(c).toBeTruthy();
  expect(c!.httpOnly).toBe(true);
  expect(c!.sameSite).toBe("Lax");
  expect(c!.secure).toBe(false);
  expect(c!.expires - Date.now() / 1000).toBeGreaterThan(29 * 86400);
  const users = db().prepare("SELECT email, role FROM user").all();
  expect(users).toEqual([{ email: OWNER.email, role: "owner" }]);
});

test("default deny: every page redirects to sign-in and every API answers 401 without a session (criteria 1 sweep, 25)", async ({ request }) => {
  desktopOnly();
  const pages = ["/", "/settings", "/settings/users", "/settings/agents", "/integrations", "/integrations/abc/credentials?draft=d1", "/approvals", "/audit", "/p/home", "/agent", "/consent", "/step-up", "/settings/security", "/sign-up", "/anything/at/all"];
  const apis = ["/api/pages", "/api/settings", "/api/integrations", "/api/data/stream?page=x", "/api/actions", "/api/agent-tokens", "/api/notifications", "/api/palette", "/api/agent", "/api/anything"];
  const rows: string[] = [];
  for (const p of pages) {
    const r = await request.get(p, { maxRedirects: 0 });
    rows.push(`${r.status()} ${p} -> ${r.headers()["location"] ?? ""}`);
    expect(r.status(), p).toBe(307);
    expect(r.headers()["location"], p).toMatch(/^\/sign-in/);
  }
  for (const p of apis) {
    for (const method of ["GET", "POST"] as const) {
      const r = await request.fetch(p, { method, maxRedirects: 0, headers: { origin: "http://127.0.0.1:3111" } });
      rows.push(`${r.status()} ${method} ${p}`);
      expect(r.status(), `${method} ${p}`).toBe(401);
    }
  }
  const mcp = await request.post("/mcp", { maxRedirects: 0, headers: { origin: "http://127.0.0.1:3111" } });
  rows.push(`${mcp.status()} POST /mcp www-authenticate=${mcp.headers()["www-authenticate"]}`);
  expect(mcp.status()).toBe(401);
  expect(mcp.headers()["www-authenticate"]).toBe('Bearer resource_metadata="http://127.0.0.1:3111/.well-known/oauth-protected-resource"');
  for (const p of ["/api/health", "/sign-in"]) {
    const r = await request.get(p, { maxRedirects: 0 });
    rows.push(`${r.status()} ${p} (public)`);
    expect(r.status(), p).toBe(200);
  }
  writeFileSync(path.join(EVIDENCE, "route-sweep.txt"), rows.join("\n") + "\n");
});

test("security headers on pages and APIs; HSTS only over https (criterion 42)", async ({ request }) => {
  desktopOnly();
  const lines: string[] = [];
  for (const p of ["/sign-in", "/api/health", "/api/pages", "/"]) {
    const r = await request.get(p, { maxRedirects: 0 });
    const h = r.headers();
    lines.push(`${p} ${r.status()}`, ...["content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy", "strict-transport-security"].map((k) => `  ${k}: ${h[k] ?? "(absent)"}`));
    expect(h["content-security-policy"], p).toContain("default-src 'self'");
    expect(h["content-security-policy"], p).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"], p).not.toContain("unsafe-eval");
    expect(h["x-content-type-options"], p).toBe("nosniff");
    expect(h["referrer-policy"], p).toBe("same-origin");
    expect(h["strict-transport-security"], p).toBeUndefined(); // ATRIUM_PUBLIC_URL is http here
  }
  writeFileSync(path.join(EVIDENCE, "headers.txt"), lines.join("\n") + "\n");
});

test("a mutating request from another origin is refused (criterion 43)", async ({ request }) => {
  desktopOnly();
  const evil = await request.post("/api/auth/sign-in/email", { headers: { origin: "https://evil.example", "content-type": "application/json" }, data: { email: OWNER.email, password: OWNER.password } });
  expect(evil.status()).toBe(403);
  const none = await request.post("/api/auth/sign-in/email", { headers: { "content-type": "application/json" }, data: { email: OWNER.email, password: OWNER.password } });
  expect(none.status()).toBe(403);
  const ref = await request.post("/api/auth/sign-out", { headers: { referer: "https://evil.example/page" } });
  expect(ref.status()).toBe(403);
  writeFileSync(path.join(EVIDENCE, "origin-check.txt"), `evil origin -> ${evil.status()}\nno origin or referer -> ${none.status()}\nevil referer -> ${ref.status()}\n`);
});

test("6th sign-in from one address in a minute: 429, Retry-After, and the screen message (criterion 27)", async ({ page }) => {
  desktopOnly();
  const responses: { status: number; retryAfter?: string }[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/auth/sign-in/email")) responses.push({ status: r.status(), retryAfter: r.headers()["retry-after"] });
  });
  await page.goto("/sign-in");
  for (let i = 0; i < 6; i++) {
    await page.getByLabel("Email").fill("limit-test@atrium.test");
    await page.getByLabel("Password").fill(`wrong-password-${i}-xxxx`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#signin-message")).not.toBeEmpty();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  }
  await expect(page.locator("#signin-message")).toHaveText(/^Too many attempts\. Try again in \d+ minutes\.$/);
  expect(responses.at(-1)?.status).toBe(429);
  expect(Number(responses.at(-1)?.retryAfter)).toBeGreaterThan(0);
  await page.screenshot({ path: shot("sign-in-rate-limited-light") });
});

test("keyboard, focus ring, 44px targets and 4.5:1 text on the sign-in screen (criterion 44)", async ({ page, context, baseURL }) => {
  desktopOnly();
  const report: string[] = [];
  for (const v of VARIANTS) {
    await context.clearCookies();
    await applyVariant(context, v, baseURL!);
    await page.goto("/sign-in");
    const stops = await tabAudit(page);
    report.push(`[${v.name}] tab order: ${stops.map((s) => `${s.tag}:${s.label}`).join(" > ")}`);
    expect(stops.map((s) => s.label)).toEqual(expect.arrayContaining(["email", "password", "Sign in", "Continue with Google"]));
    for (const s of stops) {
      report.push(`  ${s.tag} "${s.label}" ${s.w}x${s.h} outline=${s.outline}`);
      expect(s.outline, s.label).toMatch(/solid 2px 3px/); // design v4 section 6: 2px ring, 3px offset
      expect(s.h, s.label).toBeGreaterThanOrEqual(44);
      expect(s.w, s.label).toBeGreaterThanOrEqual(44);
    }
    const c = await minContrast(page);
    report.push(`  min text contrast ${c.ratio.toFixed(2)} ("${c.text}")`);
    expect(c.ratio).toBeGreaterThanOrEqual(4.5);
    await page.getByLabel("Email").focus();
    await page.keyboard.press("Tab");
    await page.screenshot({ path: shot(`sign-in-focus-${v.name}`) });
  }
  writeFileSync(path.join(EVIDENCE, "a11y-sign-in.txt"), report.join("\n") + "\n");
});

test("TOTP: password alone gives no session, the code step completes sign-in (criterion 12, screens)", async ({ page, context, baseURL }) => {
  desktopOnly();
  const userId = await addUser(TOTP_USER.email, "member", TOTP_USER.password);
  // Enrol through the real endpoints as that user.
  await signInUI(page, TOTP_USER.email, TOTP_USER.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
  const en = await page.request.post("/api/auth/two-factor/enable", { headers: { origin: baseURL! }, data: { password: TOTP_USER.password } });
  expect(en.status()).toBe(200);
  const { totpURI, backupCodes } = (await en.json()) as { totpURI: string; backupCodes: string[] };
  expect(backupCodes).toHaveLength(10);
  const secret = secretFromUri(totpURI);
  expect((await page.request.post("/api/auth/two-factor/verify-totp", { headers: { origin: baseURL! }, data: { code: totp(secret) } })).status()).toBe(200);
  // Seeded values for the V10 grep (kept out of evidence/, which must hold no secrets).
  mkdirSync("test-results/auth", { recursive: true });
  writeFileSync("test-results/auth/v10-seeds.json", JSON.stringify({ totpSecret: secret, backupCodes, passwords: [OWNER.password, MEMBER.password, TOTP_USER.password] }));

  for (const v of VARIANTS) {
    await context.clearCookies();
    await applyVariant(context, v, baseURL!);
    await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
    await signInUI(page, TOTP_USER.email, TOTP_USER.password);
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === "atrium.session")).toBeUndefined();
    await page.screenshot({ path: shot(`totp-step-${v.name}`) });
    if (v.name === "light") {
      const stops = await tabAudit(page);
      for (const s of stops) {
        expect(s.outline, s.label).toMatch(/solid 2px 3px/); // design v4 section 6: 2px ring, 3px offset
        expect(Math.min(s.w, s.h), s.label).toBeGreaterThanOrEqual(44);
      }
      expect((await minContrast(page)).ratio).toBeGreaterThanOrEqual(4.5);
    }
  }
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
  expect((await context.cookies()).find((c) => c.name === "atrium.session")).toBeTruthy();
  expect(userId).toBeTruthy();
});

test("users screen, step-up sheet with reduced motion, sessions (V4, V8, criteria 44, 45 UI)", async ({ browser, baseURL }, info) => {
  const mobile = info.project.name === "mobile";
  await addUser(MEMBER.email, "member", MEMBER.password);
  for (const v of VARIANTS) {
    const context = await browser.newContext({
      storageState: await ownerState(baseURL!),
      reducedMotion: "reduce",
      ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } }),
    });
    await applyVariant(context, v, baseURL!);
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "x-forwarded-for": freshIp() });
    await page.goto("/settings/users");
    await expect(page.locator('[data-settings-tab="users"]')).toBeVisible();
    await expect(page.locator(`[data-user="${MEMBER.email}"]`)).toBeVisible();
    await page.screenshot({ path: shot(`users-${v.name}${mobile ? "-mobile" : ""}`), fullPage: true });
    if (!mobile && v.name === "light") {
      const c = await minContrast(page);
      writeFileSync(path.join(EVIDENCE, "a11y-users.txt"), `min text contrast ${c.ratio.toFixed(2)} ("${c.text}")\n`);
      expect(c.ratio).toBeGreaterThanOrEqual(4.5);
      // Settings r3 SFR auth-users-panel: role pickers are now the shell's Radix SelectMenu. Its trigger is a
      // button (still measured here); Radix also renders a 1px aria-hidden native select for form submission,
      // which nobody can see, focus or tap, so it is left out of the target-size check.
      const buttons = await page.locator('[data-users-manager] button, [data-users-manager] select:not([aria-hidden="true"]), [data-users-manager] input').evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { label: (e.textContent || e.getAttribute("name") || e.id).trim(), w: r.width, h: r.height };
        }),
      );
      for (const b of buttons) expect(Math.min(b.w, b.h), b.label).toBeGreaterThanOrEqual(44);
    }
    // Step-up before ownership transfer (criterion 45): the sheet opens, and cancel changes nothing.
    await page.locator(`[data-user="${MEMBER.email}"]`).getByRole("button", { name: "Make owner" }).click();
    const sheet = page.locator('[data-sheet="step-up"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel("Password")).toBeVisible();
    await page.screenshot({ path: shot(`step-up-sheet-reduced-motion-${v.name}${mobile ? "-mobile" : ""}`) });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    const owners = db().prepare("SELECT email FROM user WHERE role = 'owner'").all();
    expect(owners).toEqual([{ email: OWNER.email }]);
    await context.close();
  }
});

test("step-up page, consent screen and sessions panel captures (V4)", async ({ browser, baseURL }) => {
  desktopOnly();
  for (const v of VARIANTS) {
    const context = await browser.newContext({ storageState: await ownerState(baseURL!), reducedMotion: "reduce" });
    await applyVariant(context, v, baseURL!);
    const page = await context.newPage();
    await page.goto("/step-up?next=/settings");
    await expect(page.getByLabel("Password")).toBeVisible();
    await page.screenshot({ path: shot(`step-up-page-${v.name}`) });
    if (v.name === "light") {
      const stops = await tabAudit(page);
      for (const s of stops) {
        expect(s.outline, s.label).toMatch(/solid 2px 3px/); // design v4 section 6: 2px ring, 3px offset
        expect(Math.min(s.w, s.h), s.label).toBeGreaterThanOrEqual(44);
      }
      expect((await minContrast(page)).ratio).toBeGreaterThanOrEqual(4.5);
    }
    await page.goto("/consent");
    await expect(page.getByRole("heading", { name: "No agent is asking for access" })).toBeVisible();
    await page.screenshot({ path: shot(`consent-${v.name}`) });
    await context.close();
  }
});

test("V10 traffic capture: sign-in with a code, users page, step-up page (grep runs in v10-grep.mjs)", async ({ browser, baseURL }) => {
  desktopOnly();
  const seeds = JSON.parse((await import("node:fs")).readFileSync("test-results/auth/v10-seeds.json", "utf8")) as { totpSecret: string };
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
  const page = await context.newPage();
  const chunks: string[] = [];
  page.on("response", async (r) => {
    let body = "";
    try {
      body = await r.text();
    } catch {
      body = "";
    }
    chunks.push(`### ${r.status()} ${r.request().method()} ${r.url()}\n${JSON.stringify(r.headers())}\n${body}`);
  });
  await signInUI(page, TOTP_USER.email, TOTP_USER.password);
  await page.getByLabel("6-digit code").fill(totp(seeds.totpSecret, Date.now() + 30_000));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
  await page.goto("/step-up");
  await page.goto("/consent");
  await context.close();
  const owner = await browser.newContext({ storageState: await ownerState(baseURL!) });
  const op = await owner.newPage();
  op.on("response", async (r) => chunks.push(`### ${r.status()} ${r.url()}\n${JSON.stringify(r.headers())}\n${await r.text().catch(() => "")}`));
  await op.goto("/settings/security");
  await expect(op.locator("[data-sessions-panel] li").first()).toBeVisible();
  await owner.close();
  writeFileSync("test-results/auth/traffic.txt", chunks.join("\n\n"));
  expect(chunks.length).toBeGreaterThan(5);
});
