// Round 7 (security-close item 4, M1): the three new save-time path messages in the Custom API
// "Add a command" form (ui/commands.tsx), the only place a person types a custom endpoint path
// (by-example endpoints take URL.pathname, which cannot hold a backslash, a control character or
// another address). Each message must show in place under the form, be readable, and wrap with no
// horizontal scroll at 390px. Screens in light, dark and light-solid at desktop and 390x844 go to
// evidence/integrations/r7/screens. Local stand-ins only; nothing is sent to them on save.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { APP, ORIGIN, themedContext, type Theme } from "./helpers";
import { fakeRecorder, type Recorder } from "./fakes";

const SCREENS = path.join(APP, `evidence/integrations/${process.env.ATRIUM_INT_ROUND ?? "r7"}/screens`);
const H = { origin: ORIGIN };

const CASES: { name: string; path: (b: string) => string; message: string }[] = [
  { name: "backslash", path: () => "/api\\lamp", message: "The path cannot contain a backslash (\\). Use / between parts of the path." },
  { name: "control", path: () => "/api\tlamp", message: "The path cannot contain a control character such as a tab or a line break." },
  { name: "origin", path: (b) => `/${b}/x`, message: "The path must stay on the integration's address. Put the full address in the base URL, not in the path." },
];
const SIZES = [{ name: "desktop", mobile: false }, { name: "390", mobile: true }] as const;
// Light and dark at both sizes; light with reduce transparency (the third V4 shell variant) too.
const THEMES: { name: "light" | "dark" | "light-solid"; theme: Theme }[] = [{ name: "light", theme: "daylight" }, { name: "dark", theme: "dusk" }, { name: "light-solid", theme: "solid" }];

/** WCAG contrast of the message text against the callout background (both read from computed style). */
async function contrast(page: Page): Promise<{ ratio: number; fontPx: number }> {
  return page.locator("[data-add-command] [role=alert] p.type-body").evaluate((p) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    let el: Element | null = p;
    let bg = "rgba(0, 0, 0, 0)";
    while (el) { const c = getComputedStyle(el).backgroundColor; const a = rgb(c)[3]; if (a === undefined || a > 0.9) { bg = c; break; } el = el.parentElement; }
    const fg = lum(rgb(getComputedStyle(p).color));
    const b = lum(rgb(bg));
    return { ratio: (Math.max(fg, b) + 0.05) / (Math.min(fg, b) + 0.05), fontPx: parseFloat(getComputedStyle(p).fontSize) };
  });
}

test.describe("round 7: save-time path messages in the Custom API command form", () => {
  test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario");
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project; phone sizes are set per test"));

  let a: Recorder;
  let b: Recorder;
  test.beforeAll(async () => { a = await fakeRecorder(); b = await fakeRecorder(); mkdirSync(SCREENS, { recursive: true }); });
  test.afterAll(async () => { await a?.close(); await b?.close(); });

  test("each message shows in place, is readable and wraps at 390px, in light, dark and light-solid; nothing is saved or sent (r7 known issue 1)", async ({ browser }) => {
    test.setTimeout(240_000);
    const setup = await themedContext(browser, "daylight");
    const created = await (await setup.request.post("/api/integrations", { data: { packageId: "custom-api", name: "Path check API", config: { baseUrl: a.url }, secrets: {}, untested: true }, headers: H })).json() as { id: string };
    expect(created.id).toBeTruthy();
    await setup.close();

    for (const c of CASES) {
      for (const s of SIZES) {
        for (const t of THEMES) {
          const ctx = await themedContext(browser, t.theme, { mobile: s.mobile });
          const page = await ctx.newPage();
          await page.goto(`/integrations/${created.id}`);
          await page.locator("#cmd-id").fill("lamp.toggle");
          await page.locator("#cmd-label").fill("Toggle the lamp");
          await page.locator("#cmd-path").fill(c.path(b.url));
          await page.locator("#cmd-params").fill('{ "type": "object", "properties": {} }');
          await page.locator("[data-add-command] button[type=submit]").click();

          // In place: the callout sits inside the form, above the submit button.
          const alert = page.locator("[data-add-command] [role=alert]");
          await expect(alert).toBeVisible();
          await expect(alert).toContainText(c.message);
          const box = (await alert.boundingBox())!;
          const btn = (await page.locator("[data-add-command] button[type=submit]").boundingBox())!;
          expect(box.y + box.height).toBeLessThanOrEqual(btn.y + 1);

          // Wraps: no horizontal page scroll, the callout fits the viewport, the text does not overflow.
          const vw = s.mobile ? 390 : 1280;
          const layout = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
          expect(layout.sw, `page scrollWidth at ${vw}px`).toBeLessThanOrEqual(layout.cw);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(vw);
          const msg = alert.locator("p.type-body");
          const over = await msg.evaluate((p) => p.scrollWidth - p.clientWidth);
          expect(over, "message text overflows its box").toBeLessThanOrEqual(0);
          if (s.mobile) expect((await msg.boundingBox())!.height, "message wraps onto more than one line at 390px").toBeGreaterThan(30);

          // Readable: body-size text with at least 4.5:1 contrast on its background.
          const { ratio, fontPx } = await contrast(page);
          expect(fontPx).toBeGreaterThanOrEqual(14);
          expect(ratio, `contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
          test.info().annotations.push({ type: "measure", description: `${c.name} ${s.name} ${t.name}: contrast ${ratio.toFixed(2)}:1, ${fontPx}px, scrollWidth ${layout.sw}/${layout.cw}` });

          // Nothing was saved.
          await expect(page.locator("[data-pending-commands]")).toHaveCount(0);

          await alert.scrollIntoViewIfNeeded();
          await page.waitForTimeout(250);
          await page.screenshot({ path: path.join(SCREENS, `r7-path-${c.name}-${s.name}-${t.name}.png`) });
          await ctx.close();
        }
      }
    }
    expect(a.hits, "requests to the base stand-in on save").toHaveLength(0);
    expect(b.hits, "requests to the other address on save").toHaveLength(0);
  });
});
