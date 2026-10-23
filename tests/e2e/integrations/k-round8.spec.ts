// Round 8 (Wave 2 touch-ups):
//   item 6: Series `total` (Amendment A4.1): a Prometheus range preview on a stand-in that holds 312
//           series says "20 of 312 series".
//   item 8: path error copy ends without " (at path)" and is tied to the Path field: the field is
//           marked invalid, its aria-describedby names the message, and focus moves to it.
// Local stand-ins only. Screens go to evidence/integrations/r8/screens.
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { test, expect } from "../fixtures";
import { APP, openAdvanced, ORIGIN, SHELL_VARIANTS, themedContext } from "./helpers";
import { fakeRecorder, type Recorder } from "./fakes";

const SCREENS = path.join(APP, "evidence/integrations/r8/screens");
const H = { origin: ORIGIN };

test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project; phone sizes are set per test"));
test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

/** A stand-in Prometheus whose range query holds `n` series. */
async function fakePrometheus(n: number): Promise<{ url: string; close: () => Promise<void> }> {
  const s: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/api/v1/status/buildinfo") return send({ status: "success", data: { version: "3.14.0" } });
    if (u.pathname === "/api/v1/targets") return send({ status: "success", data: { activeTargets: [] } });
    if (u.pathname === "/api/v1/query") return send({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1792288597, String(n)] }] } });
    if (u.pathname === "/api/v1/query_range") {
      const end = Number(u.searchParams.get("end") ?? 0);
      return send({ status: "success", data: { resultType: "matrix", result: Array.from({ length: n }, (_, i) => ({ metric: { __name__: "node_cpu_seconds_total", cpu: String(i % 8), instance: `host-${Math.floor(i / 8)}:9100`, mode: "idle" }, values: [[end - 600, String(i)], [end - 300, String(i + 1)], [end, String(i + 2)]] })) } });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

test("item 6: a Prometheus range preview says '20 of 312 series' (A4.1 total), in light, dark and light-solid", async ({ browser }) => {
  test.setTimeout(120_000);
  const prom = await fakePrometheus(312);
  try {
    const setup = await themedContext(browser, "daylight");
    const created = await (await setup.request.post("/api/integrations", { data: { packageId: "prometheus", name: "Prometheus 312", config: { baseUrl: prom.url }, secrets: {}, untested: true }, headers: H })).json() as { id: string };
    await setup.close();
    for (const v of SHELL_VARIANTS) {
      const ctx = await themedContext(browser, v.theme);
      const page = await ctx.newPage();
      await page.goto(`/integrations/${created.id}`);
      await openAdvanced(page);
      const range = page.locator('[data-endpoint="range"]');
      await range.locator('[data-example="up"]').click();
      await range.locator("[data-preview-button]").click();
      await expect(range.locator("[data-series-count]")).toHaveText("20 of 312 series", { timeout: 15_000 });
      await expect(range.locator("[data-series-chart] svg[role=img]")).toHaveAttribute("aria-label", /^Line chart of 20 of 312 series/);
      await expect(range.locator("[data-series-more]")).toContainText("Drawing 5 of them.");
      await range.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SCREENS, `r8-series-total-${v.name}.png`) });
      await ctx.close();
    }
  } finally {
    await prom.close();
  }
});

const PATH_CASES: { name: string; path: (b: string) => string; message: string }[] = [
  { name: "backslash", path: () => "/api\\lamp", message: "The path cannot contain a backslash (\\). Use / between parts of the path." },
  { name: "control", path: () => "/api\tlamp", message: "The path cannot contain a control character such as a tab or a line break." },
  { name: "origin", path: (b) => `/${b}/x`, message: "The path must stay on the integration's address. Put the full address in the base URL, not in the path." },
];

test.describe("item 8: path errors", () => {
  let a: Recorder;
  let b: Recorder;
  test.beforeAll(async () => { a = await fakeRecorder(); b = await fakeRecorder(); });
  test.afterAll(async () => { await a?.close(); await b?.close(); });

  test("the message ends without ' (at path)'; the Path field is marked invalid, described by the message and focused; fixing it clears the mark", async ({ browser }) => {
    test.setTimeout(180_000);
    const setup = await themedContext(browser, "daylight");
    const created = await (await setup.request.post("/api/integrations", { data: { packageId: "custom-api", name: "Path tie API", config: { baseUrl: a.url }, secrets: {}, untested: true }, headers: H })).json() as { id: string };
    await setup.close();
    for (const c of PATH_CASES) {
      for (const mobile of [false, true]) {
        for (const v of c.name === "backslash" ? SHELL_VARIANTS : SHELL_VARIANTS.slice(0, 1)) {
          const ctx = await themedContext(browser, v.theme, { mobile });
          const page = await ctx.newPage();
          await page.goto(`/integrations/${created.id}`);
          await page.locator("#cmd-id").fill("lamp.toggle");
          await page.locator("#cmd-label").fill("Toggle the lamp");
          await page.locator("#cmd-path").fill(c.path(b.url));
          await page.locator("#cmd-params").fill('{ "type": "object", "properties": {} }');
          await page.locator("[data-add-command] button[type=submit]").click();
          const alert = page.locator("[data-add-command] [role=alert]");
          await expect(alert).toBeVisible();
          await expect(alert.locator("p.type-body")).toHaveText(c.message);
          await expect(alert).not.toContainText("(at ");
          const field = page.locator("#cmd-path");
          await expect(field).toHaveAttribute("aria-invalid", "true");
          const describedBy = (await field.getAttribute("aria-describedby"))!;
          expect(describedBy).toBe(await alert.getAttribute("id"));
          await expect(field).toBeFocused();
          // Only the Path field is marked.
          for (const other of ["#cmd-id", "#cmd-label", "#cmd-desc", "#cmd-body", "#cmd-params"]) await expect(page.locator(other)).not.toHaveAttribute("aria-invalid", "true");
          const border = await field.evaluate((el) => getComputedStyle(el).borderTopColor);
          test.info().annotations.push({ type: "measure", description: `${c.name} ${mobile ? "390" : "desktop"} ${v.name}: describedby=${describedBy}, focused, border ${border}` });
          await field.scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(SCREENS, `r8-path-field-${c.name}-${mobile ? "390" : "desktop"}-${v.name}.png`) });
          // Editing the Path field clears the message and the mark.
          await field.fill("/api/lamp");
          await expect(field).not.toHaveAttribute("aria-invalid", "true");
          await expect(field).not.toHaveAttribute("aria-describedby", /cmd-error/);
          await expect(alert).toHaveCount(0);
          await ctx.close();
        }
      }
    }
    expect(a.hits).toHaveLength(0);
    expect(b.hits).toHaveLength(0);
  });
});
