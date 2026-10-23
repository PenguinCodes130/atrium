// V4, V5, V8 and E3 for components: the every-type page in the three app themes, the library screen
// and inspector in the shell's light, dark and reduce-transparency looks, phone width, reduced motion.
import { expect, test } from "@playwright/test";
import { evidence, gallery, ORIGIN, signIn, withFrameFix, writeEvidence } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, page }) => {
  await signIn(context, page.request);
  await withFrameFix(context);
});

for (const theme of ["controlRoom", "dusk", "solid"] as const) {
  test(`V4 every catalogue type in ${theme}`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "desktop themes");
    await page.goto(gallery({ scene: "all", theme }));
    await expect(page.locator('[data-type="stat"]').first()).toBeVisible();
    await page.waitForTimeout(1200);
    const types = await page.locator("[data-node]").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-type")))]);
    writeEvidence(`v4/types-${theme}.json`, types);
    expect(types.length).toBeGreaterThanOrEqual(26);
    await page.screenshot({ path: evidence(`v4/every-type-${theme}.png`), fullPage: true });
  });
}

test("V5 every-type page and library at 390x844", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phone width");
  await page.goto(gallery({ scene: "all", theme: "controlRoom" }));
  await expect(page.locator('[data-type="stat"]').first()).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator(".atr-render-root")).toHaveAttribute("data-device", "mobile");
  await page.screenshot({ path: evidence("v5/every-type-390.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  writeEvidence("v5/horizontal-overflow.json", { overflow });
  expect(overflow).toBeLessThanOrEqual(1);
  await page.goto(`${ORIGIN}/library`);
  await page.screenshot({ path: evidence("v5/library-390.png"), fullPage: true });
});

for (const look of ["light", "dark", "light-reduce-transparency"] as const) {
  test(`V4 library and inspector in the shell ${look}`, async ({ page, context }, info) => {
    test.skip(info.project.name !== "desktop", "desktop");
    if (look === "dark") await page.emulateMedia({ colorScheme: "dark" });
    if (look === "light-reduce-transparency") await context.addCookies([{ name: "atrium_transparency", value: "reduce", url: ORIGIN }]);
    await page.goto(`${ORIGIN}/library`);
    await expect(page.locator("[data-screen-title]")).toHaveText("Library");
    await page.screenshot({ path: evidence(`v4/library-${look}.png`), fullPage: true });
    await page.goto(gallery({ scene: "inspector" }));
    await expect(page.locator('[data-node="c_htmlblocka"] iframe')).toBeAttached({ timeout: 15_000 });
    await page.locator('[data-node="c_statcpuaaa"]').click({ position: { x: 12, y: 12 } });
    await expect(page.locator("[data-inspector]")).toBeVisible();
    await page.screenshot({ path: evidence(`v4/inspector-${look}.png`), fullPage: true });
  });
}

test("V8 reduced motion: a stat count, a chart update and a new component", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(gallery({ scene: "motion" }));
  await expect(page.locator('[data-type="chart"]').first()).toBeVisible();
  const before = await page.locator('[data-node="c_statcpuaaa"] .atr-stat-value').textContent();
  await page.waitForTimeout(2300);
  // Under reduced motion the value swaps at once: sample right after the tick and it is already final.
  const after = await page.locator('[data-node="c_statcpuaaa"] .atr-stat-value').textContent();
  const plot = await page.locator("[data-chart-plot]").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  await page.locator("[data-add-component]").click();
  const added = page.locator("[data-new-node]").last();
  await expect(added).toBeVisible();
  const style = await added.evaluate((el) => (el as HTMLElement).style.transform || "none");
  writeEvidence("v8/reduced-motion.json", { before, after, chartTransition: plot, newNodeTransform: style });
  expect(before).not.toBe(after);
  expect(plot === "0s" || plot === "").toBe(true);
  expect(["none", "translateY(0px)", "translateY(0px) translateZ(0px)"]).toContain(style);
  await page.screenshot({ path: evidence("v8/reduced-motion.png"), fullPage: true });
});

test("E3 accessibility basics of the every-type page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  await page.goto(gallery({ scene: "all" }));
  await expect(page.locator('[data-type="stat"]').first()).toBeVisible();
  // axe-core is not installed (shared file request); these are the scan's serious rules checked by hand.
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector(".atr-render-root")!;
    for (const el of root.querySelectorAll("button, a[href], input, select, [role=switch], [role=tab]")) {
      const name = (el.getAttribute("aria-label") || el.textContent || "").trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) || (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent?.trim());
      if (!name) out.push(`no accessible name: ${el.outerHTML.slice(0, 80)}`);
    }
    for (const img of root.querySelectorAll("img")) if (!img.hasAttribute("alt")) out.push("img without alt");
    for (const f of root.querySelectorAll("iframe")) if (!f.getAttribute("title")) out.push("iframe without title");
    const ids = [...root.querySelectorAll("[id]")].map((e) => e.id);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dup.length) out.push(`duplicate ids: ${dup.join(",")}`);
    return out;
  });
  writeEvidence("e3/a11y-basics.json", { issues });
  expect(issues).toEqual([]);
});
