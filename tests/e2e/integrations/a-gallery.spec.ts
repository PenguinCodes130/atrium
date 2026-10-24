// Gallery, detection and the empty state. Start the slot first with tests/e2e/integrations/serve.sh.
import { test, expect } from "../fixtures";
import { captureTraffic, themedContext, type Theme, shot } from "./helpers";
import { fakeHomeApi, fakePlain } from "./fakes";

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");

// The live Prometheus, e.g. ATRIUM_TEST_PROM_URL=http://<host>:9090 (the real address stays outside git).
const LIVE_PROM = process.env.ATRIUM_TEST_PROM_URL;

test.describe("gallery and detection", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project; mobile shots are taken explicitly"));

  test("empty state shows the gallery: eight official packages, Home Assistant included, Custom API last, and the first-service line (criteria 6, empty state)", async ({ browser }) => {
    for (const theme of ["daylight", "dusk", "solid"] as Theme[]) {
      const ctx = await themedContext(browser, theme);
      const page = await ctx.newPage();
      captureTraffic(page, `gallery-${theme}`);
      await page.goto("/integrations");
      await expect(page.locator("[data-empty-line]")).toHaveText("Connect your first service");
      const cards = page.locator("[data-gallery-card]");
      await expect(cards).toHaveCount(9);
      expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-gallery-card")))).toEqual(["prometheus", "npm", "pfsense", "rss", "proxmox", "docker", "uptime-kuma", "home-assistant", "custom-api"]);
      await shot(page, `screens/gallery-${theme}.png`);
      await ctx.close();
    }
  });

  test("the search box filters the gallery by name", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    await page.goto("/integrations/new");
    await page.locator("[data-gallery-search]").fill("proxm");
    await expect(page.locator("[data-gallery-card]")).toHaveCount(1);
    await expect(page.locator('[data-gallery-card="proxmox"]')).toBeVisible();
    await ctx.close();
  });

  test("pasting the live Prometheus address highlights Prometheus within 10 seconds (criterion 7, live)", async ({ browser }) => {
    test.skip(!LIVE_PROM, "needs ATRIUM_TEST_PROM_URL");
    const prom = LIVE_PROM!;
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    captureTraffic(page, "detect-prometheus");
    await page.goto("/integrations/new");
    await page.locator("#detect-url").fill(prom);
    const start = Date.now();
    await page.locator("[data-detect-button]").click();
    await expect(page.locator('[data-gallery-card="prometheus"]')).toHaveAttribute("data-match", "true", { timeout: 10_000 });
    const took = Date.now() - start;
    // Fix List item 8: a match panel with a primary "Set up Prometheus" button; the card keeps its description.
    await expect(page.locator("[data-detect-match]")).toContainText(`This looks like Prometheus at ${prom}`);
    await expect(page.locator('[data-detect-setup="prometheus"]')).toHaveText("Set up Prometheus");
    await expect(page.locator('[data-detect-setup="prometheus"]')).toHaveAttribute("href", `/integrations/new/prometheus?baseUrl=${encodeURIComponent(prom)}`);
    await expect(page.locator('[data-gallery-card="prometheus"]')).toContainText("Your machines' CPU, memory, disks and network"); // Wave 2.7 description
    await expect(page.locator('[data-gallery-card="prometheus"] [data-match-note]')).toBeVisible();
    await expect(page.locator('[data-gallery-card="prometheus"] a')).toHaveAttribute("href", `/integrations/new/prometheus?baseUrl=${encodeURIComponent(prom)}`);
    test.info().annotations.push({ type: "detect-ms", description: String(took) });
    await shot(page, "screens/detect-prometheus-daylight.png");
    await ctx.close();
  });

  test("a URL serving an OpenAPI spec shows its endpoints as a tick list with method and path (criterion 8)", async ({ browser }) => {
    const api = await fakeHomeApi();
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    await page.goto("/integrations/new");
    await page.locator("#detect-url").fill(api.url);
    await page.locator("[data-detect-button]").click();
    await expect(page.locator("[data-openapi]")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-openapi-endpoint="GET /api/stats"]')).toBeVisible();
    await expect(page.locator('[data-openapi-endpoint="GET /api/history"]')).toBeVisible();
    await expect(page.locator("[data-openapi]")).toContainText("Suggested shape: stat");
    await shot(page, "screens/openapi-ticklist-daylight.png");
    await ctx.close();
    await api.close();
  });

  test("a URL with no match and no spec shows the message and the set-up-by-example button (criterion 9)", async ({ browser }) => {
    const plain = await fakePlain();
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    await page.goto("/integrations/new");
    await page.locator("#detect-url").fill(plain.url);
    await page.locator("[data-detect-button]").click();
    await expect(page.locator("[data-no-match]")).toContainText("No known app or API spec found here", { timeout: 10_000 });
    await expect(page.locator("[data-no-match]").getByRole("link", { name: "Set it up by example" })).toBeVisible();
    await ctx.close();
    await plain.close();
  });

  test("detection refuses link-local and metadata addresses (criterion 38, UI)", async ({ browser }) => {
    const ctx = await themedContext(browser, "daylight");
    const page = await ctx.newPage();
    await page.goto("/integrations/new");
    for (const u of ["http://169.254.169.254", "http://[fe80::1]", "http://[fd00:ec2::254]"]) {
      await page.locator("#detect-url").fill(u);
      await page.locator("[data-detect-button]").click();
      await expect(page.locator("[data-error-code]")).toContainText("This integration is not allowed to reach that address");
      await expect(page.locator("[data-error-heading]")).toHaveText("Not permitted");
    }
    await ctx.close();
  });
});

test("gallery at mobile width 390x844 (V5)", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile", "mobile project");
  const ctx = await themedContext(browser, "daylight", { mobile: true });
  const page = await ctx.newPage();
  await page.goto("/integrations/new");
  await expect(page.locator("[data-gallery-card]")).toHaveCount(9);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, "screens/mobile-gallery-390x844.png");
  await ctx.close();
});
