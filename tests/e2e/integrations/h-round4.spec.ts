// Round 4 (integrations-spec-v3.md, architecture v3 Amendment 2): saved credentials. The first-time
// story end to end (save a Home Assistant token before Home Assistant exists, pick it, Save and
// test), a second server with the confirm and the step-up, privacy between members, rotate and the
// in-use delete refusal, and the V4 and V5 screens. Two local fake Home Assistants only (A and B);
// no real service is ever called. Test-only secrets; none are real.
import { appendFileSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { OWNER } from "../fixtures";
import { captureTraffic, confirmLockAndStepUp, ev, expireStepUps, memberState, ORIGIN, pickCredential, SHELL_VARIANTS, shot, themedContext } from "./helpers";
import { FAKE, fakeHa, type FakeHa } from "./fakes";

const LOG = ev("security/http-r4.jsonl");
const log = (step: string, data: unknown) => appendFileSync(LOG, `${JSON.stringify({ step, data })}\n`);
const H = { origin: ORIGIN };
const CRED = "Home Assistant token";

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test.describe("normal scenario", () => {
  test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
  let A: FakeHa;
  let B: FakeHa;
  test.beforeAll(async () => { writeFileSync(LOG, ""); A = await fakeHa(); B = await fakeHa(); });
  test.afterAll(async () => { await A.close(); await B.close(); });

  test.describe.configure({ mode: "serial" });
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project"));

  test("Services and Credentials view tabs, each its own address; the empty Credentials view (criteria 1, 2; V4)", async ({ browser }) => {
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      captureTraffic(page, `r4-credentials-empty-${v.name}`);
      await page.goto("/integrations");
      const services = page.locator("[data-screen-tabs] a", { hasText: "Services" });
      await expect(services).toHaveAttribute("aria-current", "page");
      await page.locator("[data-screen-tabs] a", { hasText: "Credentials" }).click();
      await expect(page).toHaveURL(/\/integrations\/credentials$/);
      await page.reload();
      await expect(page.locator("[data-screen-tabs] a", { hasText: "Credentials" })).toHaveAttribute("aria-current", "page");
      // Active tab is filled ink (fg), the other paper.
      const bg = await page.locator("[data-screen-tabs] a", { hasText: "Credentials" }).locator("[data-screen-tab-box]").evaluate((el) => getComputedStyle(el).backgroundColor);
      const fg = await page.evaluate(() => getComputedStyle(document.body).color);
      expect(bg).toBe(fg);
      await expect(page.locator("[data-credentials-empty]")).toContainText("No saved credentials yet");
      await expect(page.locator("[data-new-credential-button]")).toBeVisible();
      await shot(page, `screens/r4-credentials-empty-${v.name}.png`);
      await ctx.close();
    }
  });

  test("first-time story: save a Home Assistant token with no server, then pick it on the Home Assistant setup form and Save and test (criteria 3, 4, 10, 12, 16; V4)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "r4-first-time");
    await page.goto("/integrations/credentials");
    await page.locator("[data-new-credential-button]").click();
    const form = page.locator("[data-new-credential]");
    await expect(form.locator("[data-credential-value]")).toHaveCount(1);
    await form.locator("[data-credential-kind]").selectOption("username-password");
    await expect(form.locator("[data-credential-value]")).toHaveCount(2);
    await form.locator("[data-credential-kind]").selectOption("proxmox-token");
    await expect(form.locator('[data-credential-value="tokenId"]')).toBeVisible();
    await expect(form.locator('[data-credential-value="secret"]')).toBeVisible();
    await form.locator("[data-credential-kind]").selectOption("token");
    // Blank value refused, naming the field.
    await form.locator("[data-credential-name]").fill(CRED);
    await form.locator("[data-credential-save]").click();
    await expect(form.locator("[data-error-code]")).toContainText("Token: enter a value.");
    await form.locator('[data-credential-value="token"]').fill(FAKE.ha);
    await shot(page, "screens/r4-new-credential-light.png");
    await form.locator("[data-credential-save]").click();
    const win = page.locator(`[data-credential-name-label="${CRED}"]`);
    await expect(win).toBeVisible();
    await expect(win.locator("[data-credential-kind-label]")).toHaveText("token"); // r5: the title bar status, lowercase
    await expect(win.locator("[data-credential-origins]")).toHaveText(/^Locks on first use/);
    await expect(win.locator("[data-credential-used-by]")).toContainText("Not used yet");
    await expect(win.locator("[data-credential-last-used]")).toHaveText("Never");
    expect(await page.content()).not.toContain(FAKE.ha);

    await page.goto("/integrations/new/home-assistant");
    await page.locator('[data-config="baseUrl"]').fill(A.url);
    const field = page.locator('[data-secret-field="token"]');
    await expect(field.getByText("Enter a value")).toBeVisible();
    await field.getByText("Use a saved credential").click();
    await pickCredential(field.locator('[data-credential-pick="token"]'), CRED);
    await expect(field.locator("[data-credential-lock]")).toHaveText(new RegExp(`^Locks to ${A.url} when you save`));
    // Round 6 (Fix List r3 item 1, replaces r5's lock-free test): a test before the first lock asks
    // "Lock <credential> to <server>?" and a step-up, then locks it to this server and tests.
    await page.locator("[data-test-button]").click();
    await confirmLockAndStepUp(page);
    await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
    expect(((await (await page.request.get("/api/integrations/credentials")).json()) as { credentials: { name: string; lockedOrigins: string[] }[] }).credentials.find((c) => c.name === CRED)!.lockedOrigins).toEqual([A.url]);
    const save = page.locator("[data-save-button]");
    await expect(save).toHaveText(/^\s*Save\s*$/);
    await save.click();
    await expect(page).toHaveURL(/\/integrations\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await expect(page.locator('[data-health="ok"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-health="ok"]').first()).toContainText("2026.10.1");
    await page.goto("/integrations/credentials");
    await expect(win.locator("[data-locked-origin]")).toHaveCount(1); // r5: each server row has a Remove button
    await expect(win.locator(`[data-locked-origin="${A.url}"]`)).toBeVisible();
    await expect(win.locator("[data-credential-used-by]")).toContainText("Home Assistant");
    await expect(win.locator("[data-credential-last-used]")).not.toHaveText("Never");
    await ctx.close();
  });

  test("a second server asks to allow it, then for a step-up; Cancel saves nothing (criteria 17 to 20; V4)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "r4-second-server");
    // Round 6: the first-time story now takes a step-up on its first test; end it so this test sees the prompt.
    await expireStepUps();
    const list = (await (await page.request.get("/api/integrations/credentials")).json()) as { credentials: { id: string; name: string; lockedOrigins: string[] }[] };
    const cred = list.credentials.find((c) => c.name === CRED)!;
    // Over the API: without the confirm, a 409 naming credential and server; with it, step-up required.
    const body = { packageId: "home-assistant", name: "HA B api", config: { baseUrl: B.url }, secrets: {}, credentials: { token: cred.id }, untested: true };
    const r1 = await page.request.post("/api/integrations", { data: body, headers: H });
    const j1 = await r1.json();
    log("new server without confirm", { status: r1.status(), body: j1 });
    expect(r1.status()).toBe(409);
    expect(j1).toMatchObject({ error: { code: "credential_origin_confirm" }, confirm: { origin: B.url, credentials: [{ name: CRED, lockedOrigins: [A.url] }] } });
    const r2 = await page.request.post("/api/integrations", { data: { ...body, confirmOrigins: true }, headers: H });
    const j2 = await r2.json();
    log("new server, confirmed, no step-up", { status: r2.status(), body: j2 });
    expect(r2.status()).toBe(403);
    expect(j2.error.code).toBe("step_up_required");
    expect(((await (await page.request.get("/api/integrations/credentials")).json()) as typeof list).credentials.find((c) => c.id === cred.id)!.lockedOrigins).toEqual([A.url]);
    expect(B.hits.length).toBe(0);

    await page.goto("/integrations/new/home-assistant");
    await page.locator('[data-config="name"], input[maxlength="120"]').first().fill("Home Assistant B");
    await page.locator('[data-config="baseUrl"]').fill(B.url);
    const field = page.locator('[data-secret-field="token"]');
    await field.getByText("Use a saved credential").click();
    await pickCredential(field.locator('[data-credential-pick="token"]'), CRED);
    await expect(field.locator("[data-credential-lock]")).toContainText("Saving here asks you to allow");
    await shot(page, "screens/r4-setup-picker-elsewhere-light.png");
    await page.locator("[data-save-button]").click();
    const sheet = page.locator('[data-sheet="credential-origin-confirm"], [role="dialog"]').filter({ hasText: `Also allow ${CRED} on ${B.url}?` });
    await expect(sheet).toBeVisible();
    await shot(page, "screens/r4-origin-confirm-light.png");
    await page.locator("[data-origin-cancel]").click();
    // Round 5: a cancelled confirm is a neutral note, not an error box.
    await expect(page.locator("[data-info-note]")).toContainText(`Not saved. ${CRED} is still locked to ${A.url}.`);
    await page.locator("[data-save-button]").click();
    await page.locator("[data-origin-confirm]").click();
    const stepUp = page.getByRole("dialog").filter({ hasText: "Confirm it is you" });
    await expect(stepUp).toBeVisible();
    await stepUp.getByLabel("Password").fill(OWNER.password);
    await shot(page, "screens/r4-origin-step-up-light.png");
    await stepUp.getByRole("button", { name: "Confirm" }).click();
    await expect(page).toHaveURL(/\/integrations\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    const after = ((await (await page.request.get("/api/integrations/credentials")).json()) as typeof list).credentials.find((c) => c.id === cred.id)!;
    expect(after.lockedOrigins).toEqual([A.url, B.url]);
    log("after confirm and step-up", after);
    await ctx.close();
  });

  test("a member never sees the owner's credentials; the owner sees the member's (criterion 8)", async ({ browser }) => {
    const mctx = await browser.newContext({ storageState: await memberState(), baseURL: ORIGIN });
    const m = await mctx.newPage();
    captureTraffic(m, "r4-member");
    const mine = await m.request.post("/api/integrations/credentials", { data: { name: "Member token", kind: "token", values: { token: FAKE.npmGood } }, headers: H });
    expect(mine.status()).toBe(201);
    const listed = await (await m.request.get("/api/integrations/credentials")).text();
    expect(listed).not.toContain(CRED);
    expect(listed).toContain("Member token");
    await m.goto("/integrations/credentials");
    await expect(m.getByText(CRED)).toHaveCount(0);
    await m.goto("/integrations/new/home-assistant");
    await m.locator('[data-secret-field="token"]').getByText("Use a saved credential").click();
    await expect(m.locator('[data-credential-pick="token"] option', { hasText: CRED })).toHaveCount(0);
    await mctx.close();
    const ctx = await themedContext(browser, "daylight");
    expect(await (await ctx.request.get("/api/integrations/credentials")).text()).toContain("Member token");
    await ctx.close();
  });

  test("rotate, and delete refused while in use with the integrations listed (criteria 28, 30; V4 list)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "r4-rotate-delete");
    await page.goto("/integrations/credentials");
    const win = page.locator(`[data-credential-name-label="${CRED}"]`);
    await win.locator("[data-rotate]").click();
    await win.locator('[data-rotate-form] [data-credential-value="token"]').fill(FAKE.ha);
    await win.locator("[data-rotate-save]").click();
    await expect(page.getByRole("region", { name: "Notifications" }).getByText(`Rotated ${CRED}`)).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await win.locator("[data-delete-credential]").click();
    await expect(win.locator("[data-error-code]")).toContainText(`${CRED} is used by Home Assistant`);
    await expect(win.locator("[data-error-code]")).toContainText("Home Assistant B");
    await ctx.close();
  });

  test("V4: the Credentials view and the setup form's picker in light, dark and light with reduce transparency", async ({ browser }) => {
    // A second kind so the list shows more than one window.
    const seed = await themedContext(browser, "daylight");
    await seed.request.post("/api/integrations/credentials", { data: { name: "Proxmox reader", kind: "proxmox-token", values: { tokenId: "atrium@pve!r4", secret: FAKE.proxmox }, server: "https://10.0.0.4:8006" }, headers: H });
    await seed.close();
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      captureTraffic(page, `r4-screens-${v.name}`);
      await page.goto("/integrations/credentials");
      await expect(page.locator("[data-credential]")).toHaveCount(3); // the owner also sees the member's
      await shot(page, `screens/r4-credentials-view-${v.name}.png`);
      await page.locator("[data-new-credential-button]").click();
      await page.locator("[data-credential-name]").fill("New token");
      await shot(page, `screens/r4-new-credential-${v.name}.png`);
      await page.goto("/integrations/new/home-assistant");
      await page.locator('[data-config="baseUrl"]').fill(A.url);
      const field = page.locator('[data-secret-field="token"]');
      await field.getByText("Use a saved credential").click();
      await pickCredential(field.locator('[data-credential-pick="token"]'), CRED);
      await expect(field.locator("[data-credential-lock]")).toContainText(`Locked to ${A.url}`);
      await shot(page, `screens/r4-setup-picker-${v.name}.png`);
      await ctx.close();
    }
  });
});

test.describe("mobile 390x844", () => {
  test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "run once, with a mobile context"));

  test("V5: Credentials view and the setup picker fit 390px with no horizontal scroll (criterion 38)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight", { mobile: true });
    const page = await ctx.newPage();
    captureTraffic(page, "r4-mobile");
    await page.goto("/integrations/credentials");
    await expect(page.locator("[data-credential]").first()).toBeVisible();
    await noOverflow(page);
    await shot(page, "screens/r4-mobile-credentials-390x844.png");
    await page.locator("[data-new-credential-button]").click();
    await noOverflow(page);
    await shot(page, "screens/r4-mobile-new-credential-390x844.png");
    await page.goto("/integrations/new/home-assistant");
    await page.locator('[data-config="baseUrl"]').fill("http://127.0.0.1:8123");
    const field = page.locator('[data-secret-field="token"]');
    await field.getByText("Use a saved credential").click();
    await pickCredential(field.locator('[data-credential-pick="token"]'), CRED);
    await noOverflow(page);
    await shot(page, "screens/r4-mobile-setup-picker-390x844.png");
    await ctx.close();
  });
});

test.describe("locked scenario", () => {
  test.skip(process.env.ATRIUM_E2E_SCENARIO !== "locked", "locked scenario only");
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project"));

  test("with the master key gone, credentials show Secrets locked and saving or rotating is refused (criterion 37)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    await page.goto("/integrations/credentials");
    const lockedNotes = page.locator("[data-credential] [data-secrets-locked]");
    expect(await lockedNotes.count()).toBeGreaterThan(0);
    await expect(lockedNotes.first()).toHaveText("Secrets locked: the master key is missing or wrong");
    await shot(page, "screens/r4-credentials-locked-light.png");
    const create = await page.request.post("/api/integrations/credentials", { data: { name: "Locked try", kind: "token", values: { token: "atrium-v10-FAKE-locked-attempt" } }, headers: H });
    expect(create.status()).toBe(503);
    expect((await create.json()).error.message).toBe("Secrets locked: the master key is missing or wrong");
    const list = (await (await page.request.get("/api/integrations/credentials")).json()) as { credentials: { id: string }[] };
    const rot = await page.request.put(`/api/integrations/credentials/${list.credentials[0]!.id}`, { data: { values: { token: "atrium-v10-FAKE-locked-attempt" } }, headers: H });
    expect(rot.status()).toBe(503);
    await ctx.close();
  });
});
