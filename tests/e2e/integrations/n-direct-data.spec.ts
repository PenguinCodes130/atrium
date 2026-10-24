// Wave 2.9 direct data, integrations side (Amendment 10 A10.3 to A10.6; direct data spec 3.2, 3.5,
// 3.7, criteria 2, 8, 9, 14), through the real integration form (Open address and Kind, V11), the
// built-in Atrium integration's page (reachability and this server's stats), and the catalogue and
// peek routes the builder's picker calls, against the stand-in Prometheus and Docker. The reachability
// stand-in listens on this machine's own network address (found at run time; loopback is refused by
// design). Normal scenario only. Evidence: evidence/integrations/$ATRIUM_INT_ROUND.
import os from "node:os";
import { createServer, type Server } from "node:http";
import { expect, request, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { captureTraffic, memberState, ORIGIN, ownerState, shot, SHELL_VARIANTS, themedContext } from "./helpers";
import { ALL_FAKE_SECRETS, fakeDocker, type Fake } from "./fakes";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "direct data runs in the normal scenario");
test.describe.configure({ mode: "serial" });

let prom: FakePrometheus;
let docker: Fake;
let promId = "";
let dockerId = "";
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
let site: Server | undefined;
let siteUrl = "";

test.beforeAll(async () => {
  prom = await startFakePrometheus();
  docker = await fakeDocker();
  if (lan) {
    site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>FAKE e2e site</title>"); });
    await new Promise<void>((r) => site!.listen(0, lan, () => r()));
    siteUrl = `http://${lan}:${(site.address() as { port: number }).port}`;
  }
});
test.afterAll(async () => {
  await prom?.close();
  await docker?.close();
  await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
});

async function api(state?: string) {
  return request.newContext({ baseURL: ORIGIN, storageState: state ?? (await ownerState()), extraHTTPHeaders: { origin: ORIGIN } });
}

test("the integration form takes an Open address and a Kind, and keeps them (A10.5)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "connect once, on desktop");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "direct-data-form");
  await page.goto(`/integrations/new/docker?endpoint=${encodeURIComponent(`tcp://127.0.0.1:${docker.port}`)}`);
  // Docker's own API address is not a web page, so its Open address starts empty; the kind is the package's.
  await expect(page.locator("[data-open-url]")).toHaveValue("");
  await expect(page.locator("[data-service-kind]")).toHaveValue("containers");
  await page.locator("[data-open-url]").fill("10.0.0.5:9000");
  await page.locator("[data-open-url]").blur();
  await expect(page.locator("[data-open-url]")).toHaveValue("http://10.0.0.5:9000");
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-save-button]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/);
  dockerId = page.url().split("/").pop()!;
  await expect(page.locator("[data-open-url]")).toHaveValue("http://10.0.0.5:9000/");
  await expect(page.locator("[data-service-kind]")).toHaveValue("containers");
  // Change both on the saved integration, save, reload: they stay.
  await page.locator("[data-service-kind]").selectOption("media");
  await page.locator("[data-open-url]").fill("http://10.0.0.6:8096");
  await page.locator("[data-save-button]").click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(page.locator("[data-service-kind]")).toHaveValue("media");
  await expect(page.locator("[data-open-url]")).toHaveValue("http://10.0.0.6:8096/");
  // A credential in the address is refused under the field, in words.
  await page.locator("[data-open-url]").fill("http://user:pw@10.0.0.6:8096");
  await page.locator("[data-save-button]").click();
  await expect(page.getByText("The Open address must be a full http:// or https:// address")).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(page.locator("[data-open-url]")).toHaveValue("http://10.0.0.6:8096/");
  await shot(page, "screens/direct-data-form-daylight.png");
  const a = await api();
  const view = await (await a.get(`/api/integrations/${dockerId}`)).json();
  expect(view).toMatchObject({ kind: "media", openUrl: "http://10.0.0.6:8096/" });
  // Back to containers for the catalogue test.
  expect((await a.patch(`/api/integrations/${dockerId}`, { data: { kind: "containers", shared: true } })).status()).toBe(200);
  await a.dispose();

  // Prometheus with no Open address typed: it defaults to the configured base address at creation.
  await page.goto(`/integrations/new/prometheus?baseUrl=${encodeURIComponent(prom.url)}`);
  await expect(page.locator("[data-service-kind]")).toHaveValue("monitoring");
  await page.locator("[data-test-button]").click();
  await expect(page.locator("[data-test-success]")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-save-button]").click();
  await page.waitForURL(/\/integrations\/[0-9a-f-]{36}$/);
  promId = page.url().split("/").pop()!;
  await expect(page.locator("[data-open-url]")).toHaveValue(`${prom.url}/`);
  await ctx.close();
});

test("the catalogue finds reads from two services by words, ranks fitting ones first, and peeks live values within 3 s (A10.4, criterion 2)", async () => {
  test.skip(!promId || !dockerId, "needs the connected services");
  const a = await api();
  let t = Date.now();
  const r = await a.get(`/api/data/catalogue?${new URLSearchParams({ q: "cpu pve1", fits: "stat", integrationId: promId })}`);
  expect(r.status()).toBe(200);
  const cat = await r.json() as { items: { key: string; label: string; integrationId: string; endpointId: string; params: Record<string, string>; thing?: { label: string }; history?: { endpointId: string }; shape: string }[]; fits: boolean[]; services: { integrationId: string; kind: string; openUrl?: string; headline: { label: string }[] }[]; pending: string[] };
  expect(Date.now() - t).toBeLessThan(3000);
  const first = cat.items[0]!;
  expect(first).toMatchObject({ label: "CPU in use", integrationId: promId, endpointId: "machine-cpu", thing: { label: "pve1" }, shape: "stat", history: { endpointId: "h:machine-cpu" } });
  expect(cat.fits[0]).toBe(true);
  // Two services for one word ("containers": Docker's and the Prometheus cAdvisor reads, which this
  // stand-in has no data for, so they show only with all=1), and services carry the tiles' facts.
  const run = await (await a.get("/api/data/catalogue?q=containers&all=1&limit=200")).json() as typeof cat;
  const hidden = await (await a.get("/api/data/catalogue?q=containers&limit=200")).json() as typeof cat;
  expect(hidden.items.every((i) => i.integrationId !== promId)).toBe(true);
  const seen = new Set(run.items.map((i) => i.integrationId));
  expect(seen.has(dockerId) && seen.has(promId)).toBe(true);
  const d = run.services.find((s) => s.integrationId === dockerId)!;
  expect(d).toMatchObject({ kind: "containers", openUrl: "http://10.0.0.6:8096/" });
  expect(d.headline.map((h) => h.label)).toEqual(["Running", "Stopped", "Total"]);
  expect(run.services.find((s) => s.integrationId === "atrium")).toBeTruthy();
  expect(cat.services.map((s) => s.integrationId)).toEqual([promId]);
  t = Date.now();
  const pk = await a.post("/api/data/peek", { data: { items: [
    { integrationId: promId, endpointId: first.endpointId, params: first.params },
    { integrationId: dockerId, endpointId: "running", params: {} },
    { integrationId: promId, endpointId: "h:machine-cpu", params: { machine: first.params.machine, hours: 1 } },
  ] } });
  expect(Date.now() - t).toBeLessThan(3000);
  const vals = (await pk.json() as { values: { key: string; data?: { kind: string; value?: number; series?: unknown[] } }[] }).values;
  expect(vals[0]).toMatchObject({ key: first.key, data: { kind: "stat", value: 34.6 } });
  expect(vals[1]!.data).toMatchObject({ kind: "stat", value: 2 });
  expect(vals[2]!.data?.kind).toBe("series");
  // Never config or secrets.
  const text = JSON.stringify(cat) + JSON.stringify(run) + JSON.stringify(vals);
  expect(text).not.toContain("baseUrl");
  expect(text).not.toContain(`tcp://127.0.0.1:${docker.port}`);
  for (const s of ALL_FAKE_SECRETS) expect(text).not.toContain(s);
  await a.dispose();
});

test("the catalogue follows the sharing rule: a member sees shared services only (A6.1)", async () => {
  test.skip(!promId || !dockerId, "needs the connected services");
  const m = await api(await memberState());
  const r = await (await m.get("/api/data/catalogue?q=cpu&limit=200")).json() as { items: { integrationId: string }[]; services: { integrationId: string }[] };
  // Docker is shared, Prometheus is not.
  expect(r.services.map((s) => s.integrationId)).toContain(dockerId);
  expect(r.services.map((s) => s.integrationId)).not.toContain(promId);
  expect(r.items.some((i) => i.integrationId === promId)).toBe(false);
  await m.dispose();
  const anon = await request.newContext({ baseURL: ORIGIN });
  expect((await anon.get("/api/data/catalogue")).status()).toBe(401);
  await anon.dispose();
});

async function openSystem(page: Page) {
  await page.goto("/integrations");
  await page.locator("[data-system-integration] a").click();
  await page.waitForURL(/\/integrations\/atrium$/);
}

test("the built-in Atrium integration checks an address on the network, refuses this server itself, and shows this server's CPU (A10.6, criterion 9)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  test.skip(!lan, "this machine has no network address for the stand-in site");
  const ctx = await themedContext(browser, "daylight");
  const page = await ctx.newPage();
  captureTraffic(page, "direct-data-system");
  await openSystem(page);
  await expect(page.locator("[data-system-note]")).toBeVisible();
  await expect(page.locator("[data-delete]")).toHaveCount(0);
  const reach = page.locator('[data-endpoint="reach"]');
  await reach.locator('[data-param="url"]').fill(siteUrl);
  await reach.locator("[data-preview-button]").click();
  await expect(reach.locator("[data-count-up]")).toHaveText("1 up", { timeout: 10_000 });
  await expect(reach.locator("[data-status-detail]")).toHaveText(/^\d+ ms$/);
  // A port nothing listens on is down, in words.
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, lan, () => r()));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>((r) => closed.close(() => r()));
  await reach.locator('[data-param="url"]').fill(`http://${lan}:${port}`);
  await reach.locator("[data-preview-button]").click();
  await expect(reach.locator("[data-status-detail]")).toHaveText("Nothing is listening at that address.", { timeout: 10_000 });
  await expect(reach.locator("[data-count-down]")).toHaveText("1 down");
  // This server itself is refused.
  await reach.locator('[data-param="url"]').fill("http://127.0.0.1:3113");
  await reach.locator("[data-preview-button]").click();
  await expect(reach.locator("[data-status-detail]")).toContainText("does not check addresses on this server itself", { timeout: 10_000 });
  await shot(page, "screens/direct-data-system-reach-daylight.png");
  const host = page.locator('[data-endpoint="host"]');
  await host.locator("[data-preview-button]").click();
  await expect(host.locator("[data-stat-value]")).toHaveText(/%/, { timeout: 10_000 });
  // Service health offers the services this person may use.
  const health = page.locator('[data-endpoint="health"]');
  const sel = health.locator('select[data-param="integrationId"]');
  await expect(sel).toHaveAttribute("data-choices-state", "ready", { timeout: 10_000 });
  const names = await sel.locator("option").allTextContents();
  expect(names.some((n) => n.includes("Docker"))).toBe(true);
  await ctx.close();
});

test("the system integration cannot be removed, turned off or unshared (A10.6)", async () => {
  const a = await api();
  expect((await a.delete("/api/integrations/atrium")).status()).toBe(403);
  expect((await a.patch("/api/integrations/atrium", { data: { status: "disabled" } })).status()).toBe(403);
  expect((await a.patch("/api/integrations/atrium", { data: { shared: false } })).status()).toBe(403);
  const v = await (await a.get("/api/integrations/atrium")).json();
  expect(v).toMatchObject({ id: "atrium", packageId: "atrium/system", status: "active", shared: true, system: true });
  await a.dispose();
});

test("form and built-in integration in three themes and at 390 px", async ({ browser }, info) => {
  if (!dockerId) {
    // The mobile project runs after desktop in a fresh module: find the Docker integration it connected.
    const a = await api();
    const list = (await (await a.get("/api/integrations")).json() as { integrations: { id: string; packageId: string; kind?: string }[] }).integrations;
    dockerId = list.filter((i) => i.packageId === "docker" && i.kind === "containers").at(-1)?.id ?? "";
    await a.dispose();
  }
  test.skip(!dockerId, "needs the connected Docker");
  const mobile = info.project.name === "mobile";
  for (const v of mobile ? [SHELL_VARIANTS[0]!] : SHELL_VARIANTS) {
    const ctx = await themedContext(browser, v.theme, { mobile });
    const page = await ctx.newPage();
    await page.goto(`/integrations/${dockerId}`);
    await expect(page.locator("[data-open-url]")).toBeVisible();
    if (mobile) {
      const box = await page.locator("[data-service-kind]").boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
    await page.locator("[data-open-url]").scrollIntoViewIfNeeded();
    await shot(page, `screens/direct-data-form-${mobile ? "390" : v.name}.png`);
    await ctx.close();
  }
});
