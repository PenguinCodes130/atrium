// Wave 2.10c lead round (app-builder, PWA): a new published version gives the app a new service worker
// (`/a/<slug>/sw.js` carries the version). The operator publishes and reopens apps all the time, so a new
// version must never stall a navigation, and an open page must still get the new version. These tests
// publish several times and reopen the app page after each, with service workers enabled, the way
// components' j-final item 4 stalled (240 s, `evidence/components/w210c-r1/logs/jfinal-probe.log`).
// Variant "plain": no request routing. Variant "routed": a context route on a path the page does not use
// for its own document, as j-final has (Playwright request interception on). The worker's own state
// changes are logged through CDP (ServiceWorker domain) for the report.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { api, contextFor, OWNER, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project");

const STAGE = process.env.ATRIUM_E2E_W210C_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder/w210c-r1/sw", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const RUN = Date.now().toString(36).slice(-4);
const owner = () => api(OWNER);
const THEMES = ["control-room", "dusk", "solid", "daylight", "control-room", "dusk"];

async function makeApp(slug: string): Promise<string> {
  const r = await (await owner()).post("/api/apps", { data: { name: `SW ${slug}`, slug, template: "homelab" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app.id as string;
}
async function setThemeAndPublish(id: string, themeId: string, note: string) {
  const c = await owner();
  const d = await (await c.get(`/api/apps/${id}/draft`)).json();
  const o = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: [{ op: "theme.set", theme: { themeId } }, { op: "app.update", patch: { name: `SW ${note}` } }] } });
  if (!o.ok()) throw new Error(`ops: ${await o.text()}`);
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const p = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note } });
  if (!p.ok()) throw new Error(`publish: ${await p.text()}`);
  return (await p.json()) as { version?: number };
}
async function swLog(ctx: BrowserContext, page: Page, lines: string[]) {
  const cdp = await ctx.newCDPSession(page);
  const t0 = Date.now();
  cdp.on("ServiceWorker.workerVersionUpdated", (e: { versions: { versionId: string; scriptURL: string; status: string; runningStatus: string; controlledClients?: string[] }[] }) => {
    for (const v of e.versions) lines.push(`${Date.now() - t0}ms v${v.versionId} ${v.status}/${v.runningStatus} clients=${v.controlledClients?.length ?? 0}`);
  });
  await cdp.send("ServiceWorker.enable");
}

// "quick": the next publish and navigation follow each page load at once, so a navigation lands while the
// new worker is installing or activating (the window j-final hit). "fulfill": j-final's own route, which
// fetches and fulfills the matched requests.
for (const variant of ["plain", "routed", "quick", "quick-fulfill", "jfinal"] as const) {
  test(`SW update (${variant}): publishing six times and reopening the app after each never stalls a navigation; the page shows the newest version`, async ({ browser }) => {
    const slug = `sw-${variant.replace(/[^a-z]/g, "").slice(0, 6)}-${RUN}`;
    const id = await makeApp(slug);
    await setThemeAndPublish(id, "control-room", "first");
    const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0]!, viewport: { width: 1440, height: 900 } });
    if (variant === "routed") await ctx.route("**/sandbox/frame*", (r) => r.continue());
    if (variant === "quick-fulfill" || variant === "jfinal") await ctx.route("**/sandbox/frame*", async (r) => { const res = await r.fetch(); await r.fulfill({ response: res }); });
    const quick = variant.startsWith("quick") || variant === "jfinal";
    // "jfinal": j-final item 4's exact order: Control Room light then dark (no publish between), then one
    // publish per theme, the colour scheme switched before each open, 400 ms after the canvas shows.
    const steps: { theme: string; scheme: "light" | "dark"; publish: boolean }[] = variant === "jfinal"
      ? [{ theme: "control-room", scheme: "light", publish: false }, { theme: "control-room", scheme: "dark", publish: false }, { theme: "dusk", scheme: "light", publish: true }, { theme: "solid", scheme: "light", publish: true }, { theme: "daylight", scheme: "light", publish: true }, { theme: "control-room", scheme: "light", publish: true }]
      : THEMES.map((theme, i) => ({ theme, scheme: "light" as const, publish: i > 0 }));
    const page = await ctx.newPage();
    const lines: string[] = [];
    await swLog(ctx, page, lines);
    // Every request the context sees (the page's and the workers'), with when it ended, for the report.
    const t0 = Date.now();
    const tag = (r: import("@playwright/test").Request) => `${r.serviceWorker() ? "sw" : "page"} ${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`;
    ctx.on("request", (r) => lines.push(`${Date.now() - t0}ms req ${tag(r)}`));
    ctx.on("requestfinished", (r) => lines.push(`${Date.now() - t0}ms done ${tag(r)}`));
    ctx.on("requestfailed", (r) => lines.push(`${Date.now() - t0}ms FAILED ${tag(r)} ${r.failure()?.errorText ?? ""}`));
    const times: { theme: string; ms: number; controlled: boolean; workers: number }[] = [];
    try {
      let last = "first";
      for (const [i, { theme, scheme, publish }] of steps.entries()) {
        if (publish) { last = `v ${i}`; await setThemeAndPublish(id, theme, last); }
        await page.emulateMedia({ colorScheme: scheme });
        lines.push(`--- goto ${i} (${theme}), workers ${ctx.serviceWorkers().length}`);
        const t = Date.now();
        await page.goto(`/a/${slug}`, { timeout: 20_000 });
        await expect(page.locator("[data-atrium-canvas]")).toBeVisible({ timeout: 15_000 });
        // The page shows the version just published (not a copy an old worker held back): its app name.
        await expect(page).toHaveTitle(`SW ${last}`, { timeout: 10_000 });
        const controlled = await page.evaluate(() => !!navigator.serviceWorker?.controller);
        times.push({ theme, ms: Date.now() - t, controlled, workers: ctx.serviceWorkers().length });
        // Give the page time to register the new worker and hand it the files (atrium-cache), as a person does.
        await page.waitForTimeout(variant === "jfinal" ? 400 : quick ? 150 : 1500);
      }
    } finally {
      writeFileSync(out(`${variant}-${test.info().repeatEachIndex}.json`), JSON.stringify({ times, sw: lines }, null, 2));
      await ctx.close();
    }
    expect(times).toHaveLength(steps.length);
    for (const x of times) expect(x.ms, `navigation for ${x.theme}`).toBeLessThan(10_000);
  });
}
