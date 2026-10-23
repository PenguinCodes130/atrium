// Round 3 (integrations spec v2): the Home Assistant package, the Commands list, "This integration
// can change", the Shared switch with its confirm, the read-only view for a member, and the
// control-run and app-page stream routes refusing an app that does not exist (Wave 2 hooks live). A local fake
// Home Assistant only; no real one is ever called. Test-only secrets; none are real.
import Database from "better-sqlite3";
import { appendFileSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { captureTraffic, DATA_DIR, ev, memberState, ORIGIN, SHELL_VARIANTS, shot, themedContext } from "./helpers";
import { FAKE, fakeHa, type FakeHa } from "./fakes";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");

let ha: FakeHa;
test.beforeAll(async () => { ha = await fakeHa(); });
test.afterAll(async () => { await ha.close(); });

const LOG = ev("security/http-r3.jsonl");
writeFileSync(LOG, "");
const log = (step: string, data: unknown) => appendFileSync(LOG, `${JSON.stringify({ step, data })}\n`);
const H = { origin: ORIGIN };

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test.describe("desktop", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project"));

  test("Home Assistant setup: secret hint, connection test with version, and everything it can change (criteria 16, 17; V4)", async ({ browser }) => {
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      captureTraffic(page, `r3-ha-setup-${v.name}`);
      await page.goto("/integrations/new/home-assistant");
      await expect(page.getByText("In Home Assistant, open your profile, then Security, then Create token")).toBeVisible();
      const can = page.locator("[data-can-change]");
      await expect(can).toBeVisible();
      await expect(can.locator("[data-command]")).toHaveCount(8);
      await expect(can.locator('[data-command="script.turn_on"] [data-owner-only]')).toBeVisible();
      await expect(can.locator('[data-command="script.turn_on"] [data-risk="medium"]')).toBeVisible();
      await expect(can.locator('[data-risk="low"]')).toHaveCount(7);
      if (v.name === "light") {
        await page.locator('[data-config="baseUrl"]').fill(ha.url);
        await page.locator('[data-secret="token"]').fill(FAKE.ha);
        await page.locator("[data-test-button]").click();
        await expect(page.locator("[data-test-success]")).toContainText("2026.10.1", { timeout: 10_000 });
      }
      await shot(page, `screens/r3-ha-setup-${v.name}.png`);
      await ctx.close();
    }
  });

  test("detection offers Home Assistant for a URL whose /api/ answers 401 and whose manifest names it (behaviour behind criterion 31, fake)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const r = await ctx.request.post("/api/integrations/detect", { data: { url: ha.url }, headers: H });
    const body = await r.json();
    log("detect fake ha", body);
    expect(body.matches).toContain("home-assistant");
    await ctx.close();
  });

  test("an integration's Commands list, the Shared switch off by default, and its confirm when switched off (criteria 12, 17; A1.1; V4)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const created = await (await ctx.request.post("/api/integrations", { data: { packageId: "home-assistant", name: "Home Assistant", config: { baseUrl: ha.url }, secrets: { token: FAKE.ha }, untested: true }, headers: H })).json();
    expect(created.shared).toBe(false);
    await ctx.close();
    for (const v of SHELL_VARIANTS) {
      const c = await themedContext(browser, v.theme);
      const page = await c.newPage();
      captureTraffic(page, `r3-ha-detail-${v.name}`);
      await page.goto(`/integrations/${created.id}`);
      const list = page.locator("[data-commands]");
      await expect(list.locator("[data-command]")).toHaveCount(8);
      await expect(list.locator('[data-command="light.toggle"] [data-command-id]')).toHaveText("light.toggle");
      await expect(list.locator('[data-command="light.toggle"] [data-command-target]')).toContainText("states");
      await expect(page.locator("[data-shared-switch] [role=switch]")).toHaveAttribute("aria-checked", "false");
      await page.locator("[data-commands-panel]").scrollIntoViewIfNeeded();
      await shot(page, `screens/r3-commands-list-${v.name}.png`);
      await c.close();
    }
    const c = await themedContext(browser, "daylight");
    const page = await c.newPage();
    captureTraffic(page, "r3-sharing");
    await page.goto(`/integrations/${created.id}`);
    await page.locator("[data-shared-switch] [role=switch]").click();
    await expect(page.locator("[data-shared-switch] [role=switch]")).toHaveAttribute("aria-checked", "true");
    await page.locator("[data-shared-switch] [role=switch]").click();
    const dlg = page.locator("[data-unshare-dialog]");
    await expect(dlg).toBeVisible();
    // Wave 2: app-builder's appsFor hook is live, so the confirm knows the apps and says none that others can edit use it.
    await expect(dlg.locator("[data-affected-apps]")).toContainText("No apps that others can edit use it.");
    await shot(page, "screens/r3-unshare-confirm-light.png");
    await dlg.locator("[data-unshare-confirm]").click();
    await expect(page.locator("[data-shared-switch] [role=switch]")).toHaveAttribute("aria-checked", "false");
    const d = new Database(`${DATA_DIR}/atrium.db`, { readonly: true });
    const audits = d.prepare("select detail from audit_log where event = 'integration.updated' and target_id = ?").all(created.id) as { detail: string }[];
    d.close();
    log("sharing audit", audits);
    expect(audits.map((a) => JSON.parse(a.detail))).toEqual([{ shared: true }, { shared: false }]);
    await c.close();
  });

  test("Custom API: 'This integration only reads', then a command added as a draft under 'This integration can change', then published (criteria 3, 15; V4)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const created = await (await ctx.request.post("/api/integrations", { data: { packageId: "custom-api", name: "Lamp API", config: { baseUrl: ha.url }, secrets: {}, untested: true }, headers: H })).json();
    // A credential-looking header is refused (criterion 3).
    const refused = await ctx.request.post(`/api/integrations/${created.id}/commands`, { data: { id: "lamp.on", label: "Lamp on", description: "x", method: "POST", path: "/api/services/light/turn_on", headers: { "X-API-Key": "abc123456" }, params: { type: "object", properties: {} }, risk: "low" }, headers: H });
    log("credential header refused", { status: refused.status(), body: await refused.json() });
    expect(refused.status()).toBe(400);
    await ctx.close();
    for (const v of SHELL_VARIANTS) {
      const c = await themedContext(browser, v.theme);
      const page = await c.newPage();
      await page.goto(`/integrations/${created.id}`);
      await expect(page.locator("[data-only-reads]")).toHaveText("This integration only reads");
      await page.locator("[data-commands-panel]").scrollIntoViewIfNeeded();
      await shot(page, `screens/r3-only-reads-${v.name}.png`);
      await c.close();
    }
    const c = await themedContext(browser, "daylight");
    const page = await c.newPage();
    captureTraffic(page, "r3-add-command");
    await page.goto(`/integrations/${created.id}`);
    await page.locator("#cmd-id").fill("lamp.toggle");
    await page.locator("#cmd-label").fill("Toggle the lamp");
    await page.locator("#cmd-path").fill("/api/services/light/toggle");
    await page.locator("#cmd-body").fill('{ "entity_id": "light.lamp" }');
    await page.locator("#cmd-params").fill('{ "type": "object", "properties": {} }');
    await page.locator("[data-add-command] button[type=submit]").click();
    const pending = page.locator("[data-pending-commands] [data-can-change]");
    await expect(pending).toBeVisible();
    await expect(pending.locator('[data-command="lamp.toggle"]')).toContainText("Toggle the lamp");
    await expect(pending.locator('[data-command="lamp.toggle"] [data-command-id]')).toHaveText("lamp.toggle");
    await expect(pending.locator('[data-command="lamp.toggle"] [data-command-request]')).toHaveText("POST /api/services/light/toggle");
    await expect(pending.locator('[data-command="lamp.toggle"] [data-risk="low"]')).toBeVisible();
    await expect(page.locator("[data-only-reads]")).toBeVisible(); // nothing is live until published
    await c.close();
    for (const v of SHELL_VARIANTS) {
      const cc = await themedContext(browser, v.theme);
      const p = await cc.newPage();
      await p.goto(`/integrations/${created.id}`);
      await p.locator("[data-pending-commands]").scrollIntoViewIfNeeded();
      await shot(p, `screens/r3-can-change-${v.name}.png`);
      await cc.close();
    }
    const c2 = await themedContext(browser, "daylight");
    const p2 = await c2.newPage();
    await p2.goto(`/integrations/${created.id}`);
    await p2.locator("[data-publish-commands]").click();
    await expect(p2.locator('[data-commands] [data-command="lamp.toggle"]')).toBeVisible();
    await expect(p2.locator("[data-pending-commands]")).toHaveCount(0);
    expect(ha.services).toHaveLength(0); // publishing runs nothing
    await c2.close();
  });

  test("a member who did not create it sees commands and Shared read-only, and is offered none of it for binding (criteria 11, 13; V4)", async ({ browser }) => {
    const owner = await themedContext(browser, "daylight");
    const created = await (await owner.request.post("/api/integrations", { data: { packageId: "home-assistant", name: "Owner HA", config: { baseUrl: ha.url }, secrets: { token: FAKE.ha }, untested: true }, headers: H })).json();
    await owner.close();
    const state = await memberState();
    for (const v of SHELL_VARIANTS) {
      const c = await themedContext(browser, v.theme, { storageState: state });
      const page = await c.newPage();
      captureTraffic(page, `r3-member-${v.name}`);
      await page.goto(`/integrations/${created.id}`);
      await expect(page.locator("[data-commands-readonly]")).toBeVisible();
      await expect(page.locator("[data-sharing-readonly]")).toBeVisible();
      await expect(page.locator("[data-shared-switch] [role=switch]")).toBeDisabled();
      await expect(page.locator("[data-add-command]")).toHaveCount(0);
      await page.locator("[data-commands-panel]").scrollIntoViewIfNeeded();
      await shot(page, `screens/r3-member-readonly-${v.name}.png`);
      if (v.name === "light") {
        const r = c.request;
        const add = await r.post(`/api/integrations/${created.id}/commands`, { data: { id: "x.y", label: "x", description: "x", method: "POST", path: "/x", params: { type: "object", properties: {} }, risk: "low" }, headers: H });
        const share = await r.patch(`/api/integrations/${created.id}`, { data: { shared: true }, headers: H });
        const cmds = await (await r.get("/api/integrations/commands")).json();
        const reads = await (await r.get("/api/integrations/bindable")).json();
        log("member", { add: add.status(), share: share.status(), commands: cmds, reads });
        expect([add.status(), share.status()]).toEqual([403, 403]);
        expect(cmds.commands.filter((x: { integrationId: string }) => x.integrationId === created.id)).toEqual([]);
        expect(reads.integrations.filter((x: { integrationId: string }) => x.integrationId === created.id)).toEqual([]);
      }
      await c.close();
    }
  });

  // Wave 2: app-builder registers the app hooks, so a run for an app that does not exist is refused as forbidden
  // ("cannot open"), not "not available". Streams and polls for it are still refused and nothing reaches Home Assistant.
  test("an app that does not exist: control runs are forbidden, app-page streams refused, bearer tokens refused, nothing reaches Home Assistant (criteria 19, 21, 29)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "r3-controls-http");
    await page.goto("/integrations");
    const out = await page.evaluate(async () => {
      const run = await fetch("/api/controls/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: "app-1", nodeId: "c_1", controlId: "k_1" }) });
      const stream = await fetch("/api/data/stream?app=app-1&page=p_1");
      const poll = await fetch("/api/data/widget/app-1:ha?page=p_1");
      return { run: [run.status, await run.json()], stream: [stream.status, stream.headers.get("content-type"), await stream.text()], poll: [poll.status, await poll.json()] };
    });
    const bearer = await ctx.request.post("/api/controls/run", { data: { appId: "app-1", nodeId: "c_1", controlId: "k_1" }, headers: { ...H, authorization: "Bearer atr_pat_FAKE-e2e" } });
    const bearerBody = await bearer.json().catch(() => ({}));
    log("not available", { ...out, bearer: [bearer.status(), bearerBody], haServiceCalls: ha.services.length });
    expect(out.run[0]).toBe(403);
    expect(out.run[1]).toMatchObject({ ok: false, code: "forbidden", message: "You cannot open this app." });
    expect(out.stream[0]).toBe(403);
    expect(out.stream[1]).not.toMatch(/event-stream/);
    expect(out.poll[0]).toBe(403);
    expect([401, 403]).toContain(bearer.status());
    expect(ha.services).toHaveLength(0);
    await ctx.close();
  });
});

test.describe("mobile 390x844 (V5)", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "mobile", "mobile project"));

  test("Commands list and 'This integration can change' at phone width", async ({ browser }) => {
    const owner = await themedContext(browser, "daylight");
    const created = await (await owner.request.post("/api/integrations", { data: { packageId: "home-assistant", name: "Phone HA", config: { baseUrl: ha.url }, secrets: { token: FAKE.ha }, untested: true }, headers: H })).json();
    const custom = await (await owner.request.post("/api/integrations", { data: { packageId: "custom-api", name: "Phone API", config: { baseUrl: ha.url }, secrets: {}, untested: true }, headers: H })).json();
    await owner.request.post(`/api/integrations/${custom.id}/commands`, { data: { id: "lamp.toggle", label: "Toggle the lamp", description: "Toggles it", method: "POST", path: "/api/services/light/toggle", body: { entity_id: "light.lamp" }, params: { type: "object", properties: {} }, risk: "low" }, headers: H });
    await owner.close();
    const c = await themedContext(browser, "daylight", { mobile: true });
    const page = await c.newPage();
    await page.goto(`/integrations/${created.id}`);
    await expect(page.locator("[data-commands] [data-command]")).toHaveCount(8);
    await noOverflow(page);
    await page.locator("[data-commands-panel]").scrollIntoViewIfNeeded();
    await shot(page, "screens/r3-mobile-commands-390x844.png");
    await page.goto(`/integrations/${custom.id}`);
    await expect(page.locator("[data-pending-commands] [data-can-change]")).toBeVisible();
    await noOverflow(page);
    await page.locator("[data-pending-commands]").scrollIntoViewIfNeeded();
    await shot(page, "screens/r3-mobile-can-change-390x844.png");
    await page.goto("/integrations/new/home-assistant");
    await expect(page.locator("[data-can-change] [data-command]")).toHaveCount(8);
    await noOverflow(page);
    await shot(page, "screens/r3-mobile-ha-setup-390x844.png");
    await c.close();
  });
});
