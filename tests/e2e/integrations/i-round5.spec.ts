// Round 5 (Fix List r2, integrations-gauntlet-r2.md): the shell Window on Commands and Sharing,
// readable title bars, rename and remove a server on a credential (step-up when in use), the
// picker's New credential sheet that keeps the setup form, Delete that refuses before any confirm,
// Save endpoint off after a failed Try it, distinguishable range chart series, and the phone fixes
// (44px switch, chips and links, sticky Picks bar, growing curl box). Local fakes only; test-only
// secrets, none real. Screens go to evidence/integrations/r6/screens/.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import type { Page } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { captureTraffic, openAdvanced, DATA_DIR, ev, ORIGIN, pickCredential, SHELL_VARIANTS, shot, themedContext } from "./helpers";
import { FAKE, fakeHa, fakeHomeApi, type FakeHa, type HomeApi } from "./fakes";

const LOG = ev("security/http-r5.jsonl");
const log = (step: string, data: unknown) => appendFileSync(LOG, `${JSON.stringify({ step, data })}\n`);
const H = { origin: ORIGIN };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** A fake Prometheus: build info, one target, an instant query and a range query of three CPU modes. */
async function fakeProm(): Promise<{ url: string; close: () => Promise<void> }> {
  const s: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const now = Math.floor(Date.now() / 1000);
    if (u.pathname === "/api/v1/status/buildinfo") return send({ status: "success", data: { version: "3.14.0" } });
    if (u.pathname === "/api/v1/targets") return send({ status: "success", data: { activeTargets: [{ labels: { job: "node", instance: "10.0.0.8:9100" }, health: "up" }] } });
    if (u.pathname === "/api/v1/query") return send({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [now, "15"] }] } });
    if (u.pathname === "/api/v1/query_range") {
      const modes = ["iowait", "softirq", "user"];
      return send({ status: "success", data: { resultType: "matrix", result: modes.map((mode, i) => ({ metric: { __name__: "node_cpu", cpu: "0", host: "ACE", instance: "10.0.0.8:9100", job: "node", mode }, values: Array.from({ length: 30 }, (_, k) => [now - (30 - k) * 60, String((i + 1) * 0.004 + Math.sin(k / 4 + i) * 0.002)]) })) } });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

async function stepUpIfAsked(page: Page) {
  const stepUp = page.locator('[data-sheet="step-up"]');
  if (await stepUp.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) {
    await stepUp.getByLabel("Password").fill(OWNER.password);
    await stepUp.getByRole("button", { name: "Confirm" }).click();
    return true;
  }
  return false;
}

function audits(event: string, targetId: string): Record<string, unknown>[] {
  const d = new Database(`${DATA_DIR}/atrium.db`, { readonly: true });
  try {
    return (d.prepare("select detail from audit_log where event = ? and target_id = ? order by at").all(event, targetId) as { detail: string }[]).map((r) => JSON.parse(r.detail));
  } finally { d.close(); }
}

test.describe("normal scenario", () => {
  test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
  test.describe.configure({ mode: "serial" });
  let A: FakeHa;
  let B: FakeHa;
  let api: HomeApi;
  let prom: Awaited<ReturnType<typeof fakeProm>>;
  let haId = "";
  let haSlug = "";
  let promId = "";
  test.beforeAll(async ({ browser }) => {
    writeFileSync(LOG, "");
    A = await fakeHa(); B = await fakeHa(); api = await fakeHomeApi(); prom = await fakeProm();
    const ctx = await themedContext(browser, "daylight");
    const ha = await (await ctx.request.post("/api/integrations", { data: { packageId: "home-assistant", name: "Kitchen HA", config: { baseUrl: A.url }, secrets: { token: FAKE.ha }, untested: true }, headers: H })).json();
    haId = ha.id;
    haSlug = String(ha.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); // "kitchen-ha" (or "kitchen-ha-2" on a re-run)
    promId = (await (await ctx.request.post("/api/integrations", { data: { packageId: "prometheus", name: "Lab Prom", config: { baseUrl: prom.url }, secrets: {}, untested: true }, headers: H })).json()).id;
    await ctx.request.post(`/api/integrations/${promId}/test`, { data: { secrets: {} }, headers: H });
    await ctx.close();
  });
  test.afterAll(async () => { await A.close(); await B.close(); await api.close(); await prom.close(); });

  test("items 3 and 7: readable title bars with status; Commands and Sharing are shell windows (V4)", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "desktop project");
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      captureTraffic(page, `r5-titles-${v.name}`);
      await page.goto("/integrations");
      const card = page.locator(`[data-integration-card="${haId}"]`);
      await expect(card.locator("[data-window-title]")).toHaveText(`integrations / home-assistant · ${haSlug}`);
      await expect(card.locator("[data-window-status]")).toHaveText("untested");
      await expect(page.locator(`[data-integration-card="${promId}"] [data-window-status]`)).toHaveText(/^up \d+ms$/);
      for (const t of await page.locator("[data-window-title]").allTextContents()) expect(t).not.toMatch(UUID);
      await shot(page, `screens/r5-integrations-${v.name}.png`);

      await page.goto(`/integrations/${haId}`);
      await expect(page.locator("[data-setup-form] [data-window-title]").first()).toHaveText(`integrations / home-assistant · ${haSlug} / connection`);
      for (const sel of ["[data-commands]", "[data-sharing]"]) {
        const w = page.locator(sel);
        await expect(w).toHaveAttribute("data-window", "paper");
        await expect(w.locator("[data-door]")).toHaveCount(1);
        const bar = await w.locator("[data-titlebar]").evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, font: getComputedStyle(el).fontSize, h: el.getBoundingClientRect().height }));
        const cardBar = await page.locator("[data-setup-form] [data-titlebar]").first().evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bar.bg).toBe(cardBar); // the same --titlebar fill as every other window (dark: not paper-white)
        expect(bar.font).toBe("12px");
        // r6: polled; in a full run the bar can be measured before layout settles (seen once as 0).
        await expect.poll(() => w.locator("[data-titlebar]").evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(28);
        expect(await w.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
      }
      await expect(page.locator("[data-commands] [data-window-title]")).toHaveText(`integrations / home-assistant · ${haSlug} / commands`);
      for (const t of await page.locator("[data-window-title]").allTextContents()) { expect(t).not.toMatch(UUID); expect(t).not.toContain("/ new /"); }
      await shot(page, `screens/r5-detail-${v.name}.png`);
      await ctx.close();
    }
  });

  test("item 9: range chart series differ by colour and dash; the legend shows only the varying label (V4)", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "desktop project");
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      await page.goto(`/integrations/${promId}`);
      await openAdvanced(page);
      const range = page.locator('[data-endpoint="range"]');
      await range.locator('[data-param="query"]').fill('rate(node_cpu_seconds_total{mode!="idle"}[5m])');
      await range.locator("[data-preview-button]").click();
      await expect(range.locator("[data-series-name]")).toHaveText(["ACE iowait", "ACE softirq", "ACE user"], { timeout: 10_000 }); // Wave 2.7: friendly machine name plus the varying label
      const lines = await range.locator("[data-series-line]").evaluateAll((els) => els.map((e) => ({ stroke: getComputedStyle(e).stroke, dash: e.getAttribute("stroke-dasharray") ?? "solid" })));
      expect(new Set(lines.map((l) => l.stroke)).size).toBe(3);
      expect(new Set(lines.map((l) => l.dash)).size).toBe(3);
      await range.scrollIntoViewIfNeeded();
      await range.screenshot({ path: ev(`screens/r5-range-chart-${v.name}.png`) });
      await ctx.close();
    }
  });

  test("item 4: rename, and remove a server from a credential in use (step-up), then reads fail until allowed again", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "desktop project");
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "r5-credential-remove");
    page.on("dialog", (d) => { throw new Error(`native dialog: ${d.message()}`); });
    const cred = await (await ctx.request.post("/api/integrations/credentials", { data: { name: "Typo token", kind: "token", values: { token: FAKE.ha }, server: A.url }, headers: H })).json();
    // Locked to A and B, used by an integration on B (the typo case from usability r2).
    await ctx.request.post("/api/integrations", { data: { packageId: "home-assistant", name: "HA on A", config: { baseUrl: A.url }, secrets: {}, credentials: { token: cred.id }, untested: true }, headers: H });
    const onB = await page.request.post("/api/integrations", { data: { packageId: "home-assistant", name: "HA on B", config: { baseUrl: B.url }, secrets: {}, credentials: { token: cred.id }, untested: true, confirmOrigins: true }, headers: H });
    let bId: string;
    if (onB.status() === 403) {
      // No fresh step-up on this session yet: do it once through the UI path below instead.
      await page.goto("/integrations/new/home-assistant");
      await page.locator('input[maxlength="120"]').first().fill("HA on B");
      await page.locator('[data-config="baseUrl"]').fill(B.url);
      const field = page.locator('[data-secret-field="token"]');
      await field.getByText("Use a saved credential").click();
      await pickCredential(field.locator('[data-credential-pick="token"]'), "Typo token");
      await page.locator("[data-save-button]").click();
      await page.locator("[data-origin-confirm]").click();
      await stepUpIfAsked(page);
      await expect(page).toHaveURL(/\/integrations\/[0-9a-f-]{36}$/, { timeout: 15_000 });
      bId = page.url().split("/").at(-1)!;
    } else bId = (await onB.json()).id;

    await page.goto("/integrations/credentials");
    const win = page.locator('[data-credential-name-label="Typo token"]');
    await expect(win.locator("[data-window-title]")).toHaveText("integrations / credentials / typo-token");
    // Rename.
    await win.locator("[data-rename]").click();
    await win.locator("[data-rename-input]").fill("Kitchen token");
    await win.locator("[data-rename-save]").click();
    const renamed = page.locator('[data-credential-name-label="Kitchen token"]');
    await expect(renamed).toBeVisible();
    // Remove B: confirm sheet, then the step-up (the credential is in use).
    await renamed.locator(`[data-remove-origin="${B.url}"]`).click();
    const sheet = page.locator('[data-sheet="credential-remove-origin"]');
    await expect(sheet).toContainText(`Remove ${B.url} from Kitchen token?`);
    await expect(sheet.locator("[data-remove-affects]")).toContainText("HA on B");
    await shot(page, "screens/r5-credential-remove-confirm-light.png");
    await sheet.locator("[data-remove-confirm-button]").click();
    const asked = await stepUpIfAsked(page);
    await expect(renamed.locator("[data-credential-origins]")).toHaveText(new RegExp(`^${A.url.replace(/[.:/]/g, "\\$&")}\\s*Remove$`));
    const entries = audits("credential.updated", cred.id);
    log("credential.updated entries", { stepUpPrompted: asked, entries });
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ renamedFrom: "Typo token", credential: "Kitchen token" }), expect.objectContaining({ origin: B.url, removedOrigins: [B.url] })]));
    await shot(page, "screens/r5-credential-after-remove-light.png");
    // The integration on B now fails Not permitted, and B never gets the token.
    const hitsBefore = B.hits.length;
    const t = await (await page.request.post(`/api/integrations/${bId}/test`, { data: { secrets: {} }, headers: H })).json();
    log("read on removed server", t);
    expect(t).toMatchObject({ ok: false, heading: "Not permitted", error: { code: "permission" } });
    expect(B.hits.length).toBe(hitsBefore);
    // Allowed again on its connection form: Save asks "Also allow", then (maybe) the step-up.
    await page.goto(`/integrations/${bId}`);
    await page.locator("[data-save-button]").click();
    await expect(page.locator('[data-sheet="credential-origin-confirm"]')).toContainText(`Also allow Kitchen token on ${B.url}?`);
    await page.locator("[data-origin-confirm]").click();
    await stepUpIfAsked(page);
    await expect.poll(async () => ((await (await page.request.get("/api/integrations/credentials")).json()) as { credentials: { id: string; lockedOrigins: string[] }[] }).credentials.find((c) => c.id === cred.id)?.lockedOrigins, { timeout: 10_000 }).toEqual([A.url, B.url]);
    await ctx.close();
  });

  test("item 5: Delete in use is refused straight away; an unused one is confirmed in the app's own dialog", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "desktop project");
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    page.on("dialog", (d) => { throw new Error(`native dialog: ${d.message()}`); });
    await ctx.request.post("/api/integrations/credentials", { data: { name: "Spare token", kind: "token", values: { token: FAKE.npmGood } }, headers: H });
    await page.goto("/integrations/credentials");
    const used = page.locator('[data-credential-name-label="Kitchen token"]');
    await used.locator("[data-delete-credential]").click();
    await expect(used.locator("[data-error-code]")).toContainText("Kitchen token is used by");
    await expect(page.locator('[data-sheet="credential-delete"]')).toHaveCount(0);
    const spare = page.locator('[data-credential-name-label="Spare token"]');
    await expect(spare.locator("[data-next-step]")).toContainText("Pick it when you add an integration");
    await spare.locator("[data-delete-credential]").click();
    const sheet = page.locator('[data-sheet="credential-delete"]');
    await expect(sheet).toContainText("Delete Spare token?");
    await shot(page, "screens/r5-credential-delete-confirm-light.png");
    await sheet.locator("[data-delete-confirm-button]").click();
    await expect(page.locator('[data-credential-name-label="Spare token"]')).toHaveCount(0);
    await ctx.close();
  });

  test("items 5 and 11: the picker's New credential sheet keeps the setup form and picks the new one; a bare host:port server", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "desktop project");
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      captureTraffic(page, `r5-picker-sheet-${v.name}`);
      await page.goto("/integrations/new/proxmox");
      await page.locator('input[maxlength="120"]').first().fill("My PVE");
      await page.locator('[data-config="baseUrl"]').fill("https://10.77.99.20:8006");
      const field = page.locator('[data-secret-field="token"]');
      await field.getByText("Use a saved credential").click();
      const empty = field.locator("[data-no-saved]");
      if (await empty.isVisible()) await expect(empty).toContainText("No saved Proxmox API token yet.");
      await field.locator("[data-new-credential-inline]").click();
      const sheet = page.locator('[data-sheet="new-credential-sheet"]');
      await expect(sheet).toContainText("New Proxmox API token");
      await expect(sheet.locator("[data-credential-kind-fixed]")).toHaveText("Kind: Proxmox API token");
      const name = `PVE reader ${v.name}`;
      await sheet.locator("[data-credential-name]").fill(name);
      await sheet.locator('[data-credential-value="tokenId"]').fill("atrium@pve!r5");
      await sheet.locator('[data-credential-value="secret"]').fill(FAKE.proxmox);
      await sheet.locator("[data-credential-server]").fill(v.name === "light" ? "10.77.99.20:8006" : "");
      await shot(page, `screens/r5-picker-new-credential-sheet-${v.name}.png`);
      await sheet.locator("[data-credential-save]").click();
      await expect(sheet).toHaveCount(0);
      // The form kept what was typed, and the new credential is picked.
      await expect(page.locator('input[maxlength="120"]').first()).toHaveValue("My PVE");
      await expect(page.locator('[data-config="baseUrl"]')).toHaveValue("https://10.77.99.20:8006");
      // r6: option labels carry the lock, "Name (server)".
      await expect(field.locator('[data-credential-pick="token"] option:checked')).toHaveText(new RegExp(`^${name} \\(`));
      await shot(page, `screens/r5-setup-picked-${v.name}.png`);
      if (v.name === "light") {
        const list = (await (await page.request.get("/api/integrations/credentials")).json()) as { credentials: { name: string; lockedOrigins: string[] }[] };
        expect(list.credentials.find((c) => c.name === name)!.lockedOrigins).toEqual(["http://10.77.99.20:8006"]);
      }
      expect(await page.content()).not.toContain(FAKE.proxmox);
      await ctx.close();
    }
  });

  test("item 8: the gallery tiles and the setup form on the screen's left edge with a provides window (V4)", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "desktop project");
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      await page.goto("/integrations/new");
      const tile = page.locator('[data-gallery-card="prometheus"] > div');
      await expect(page.locator('[data-gallery-card="prometheus"] .type-title-3')).toHaveCSS("font-size", "20px");
      await expect(page.locator('[data-gallery-card="custom-api"] [data-tile-description]')).toContainText("component");
      await expect(page.locator('[data-gallery-card="custom-api"] [data-tile-description]')).not.toContainText("widget");
      await tile.hover();
      await expect(tile).toHaveAttribute("data-tile-state", "hover");
      await shot(page, `screens/r5-gallery-${v.name}.png`);
      await page.goto("/integrations/new/prometheus");
      const title = await page.locator("[data-screen-title]").boundingBox();
      const form = await page.locator("[data-setup-form]").boundingBox();
      expect(Math.abs((title?.x ?? 0) - (form?.x ?? 99))).toBeLessThanOrEqual(1);
      await expect(page.locator("[data-provides]")).toContainText("Machines overview"); // Wave 2.7: reads in groups
      // One primary: Test connection until a test passes, Save after.
      await expect(page.locator("[data-test-button]")).toHaveAttribute("data-variant", "primary");
      // Round 6 (premium r3 low): no Save at all before a test, so no third save-ish control.
      await expect(page.locator("[data-save-button]")).toHaveCount(0);
      await shot(page, `screens/r5-setup-${v.name}.png`);
      await ctx.close();
    }
  });

  test("item 6: after a failed Try it, Save endpoint is off until a Try it on the current address succeeds", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "desktop project");
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    await page.goto("/integrations/new/by-example");
    await page.locator("[data-try-input]").fill(`${api.url}/api/open`);
    await page.locator("[data-try-button]").click();
    await page.locator('[data-tree-leaf="$.load"]').click();
    await page.locator('[data-role-picker] [data-role="value"]').click();
    await expect(page.locator("[data-picks] li")).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator("[data-save-endpoint]")).toBeEnabled();
    await page.locator("[data-try-input]").fill(`${api.url}/api/bad`);
    await page.locator("[data-try-button]").click();
    await expect(page.locator("[data-error-code]")).toBeVisible();
    await expect(page.locator("[data-stale-response]")).toContainText(`${api.url}/api/open`);
    await expect(page.locator("[data-save-endpoint]")).toBeDisabled();
    await expect(page.locator("[data-save-why]")).toContainText("The last Try it failed");
    await shot(page, "screens/r5-by-example-failed-light.png");
    await page.locator("[data-try-input]").fill(`${api.url}/api/open`);
    await page.locator("[data-try-button]").click();
    await expect(page.locator("[data-stale-response]")).toHaveCount(0);
    await expect(page.locator("[data-save-endpoint]")).toBeEnabled();
    await ctx.close();
  });

  test("items 10 and 11 at 390px: 44px switch row, chips and used-by links; sticky Picks bar; the curl box grows (V5)", async ({ browser }, info) => {
    test.skip(info.project.name !== "mobile", "mobile project");
    const ctx = await themedContext(browser, "daylight", { mobile: true });
    const page = await ctx.newPage();
    await page.goto(`/integrations/${haId}`);
    await expect(page.locator("[data-shared-switch] [role=switch]")).toBeVisible();
    const sw = await page.locator("[data-shared-switch] [role=switch]").boundingBox();
    expect(sw!.height).toBeGreaterThanOrEqual(44);
    await page.locator("[data-sharing]").scrollIntoViewIfNeeded();
    await shot(page, "screens/r5-mobile-detail-390x844.png");
    await page.goto(`/integrations/${promId}`);
    await openAdvanced(page);
    await expect(page.locator("[data-example]").first()).toBeVisible();
    const chips = await page.locator("[data-example]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, cut: e.scrollWidth > e.clientWidth + 1 }; }));
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) { expect(c.w).toBeGreaterThanOrEqual(44); expect(c.h).toBeGreaterThanOrEqual(44); expect(c.cut).toBe(false); }
    await shot(page, "screens/r5-mobile-chips-390x844.png");
    await page.goto("/integrations/credentials");
    await expect(page.locator("[data-credentials-list], [data-credentials-empty]").first()).toBeVisible();
    const links = await page.locator("[data-used-by-link]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    for (const h of links) expect(h).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await shot(page, "screens/r5-mobile-credentials-390x844.png");
    await page.goto("/integrations/new/by-example");
    await page.locator("[data-try-input]").fill(`curl -H 'Accept: application/json' -H 'Accept-Language: en-GB' ${api.url}/api/open?format=json&units=metric&detail=full`);
    const box = await page.locator("[data-try-input]").evaluate((el) => ({ h: el.getBoundingClientRect().height, sh: el.scrollHeight }));
    expect(box.h).toBeGreaterThanOrEqual(100);
    expect(box.sh - box.h).toBeLessThanOrEqual(2);
    await shot(page, "screens/r5-mobile-curl-390x844.png");
    await page.locator("[data-try-button]").click();
    await page.locator('[data-tree-leaf="$.load"]').click();
    await page.locator('[data-role-picker] [data-role="value"]').click();
    const bar = page.locator("[data-picks-bar]");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(/Picks \(\d+\)/);
    const vb = await bar.boundingBox();
    expect(vb!.y + vb!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: ev("screens/r5-mobile-picks-bar-390x844.png") });
    await bar.locator("[data-picks-review]").click();
    await expect(page.locator("[data-proposal]")).toBeInViewport({ ratio: 0.1 });
    await ctx.close();
  });
});
