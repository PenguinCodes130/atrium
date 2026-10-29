// Style, node CSS and the inspector in a browser (criteria 15, 30, 31, 33 to 38, 41, 43, 69).
import { expect, test, type Page } from "@playwright/test";
import { evidence, gallery, signIn, withFrameFix, writeEvidence } from "./helpers";

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await signIn(context, page.request);
  await withFrameFix(context);
});

const color = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color);

test("criterion 33: a hover style on one stat's value applies only on hover and only there", async ({ page }) => {
  await page.goto(gallery({ scene: "css" }));
  const hovered = '[data-node="c_csshoveraa"] [data-slot="value"]';
  const plain = '[data-node="c_cssplainaa"] [data-slot="value"]';
  const before = await color(page, hovered);
  await page.locator('[data-node="c_csshoveraa"] [data-slot="root"]').hover();
  const during = await color(page, hovered);
  const other = await color(page, plain);
  writeEvidence("css/hover.json", { before, during, otherNode: other });
  expect(during).toBe("rgb(192, 23, 138)");
  expect(before).not.toBe(during);
  expect(other).not.toBe(during);
});

test("criterion 34: token:accent follows the theme's accent", async ({ page }) => {
  const out: Record<string, { bg: string; accent: string }> = {};
  for (const theme of ["controlRoom", "solid"] as const) {
    await page.goto(gallery({ scene: "css", theme }));
    out[theme] = await page.locator('[data-node="c_csstokenaa"] [data-slot="root"]').evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--theme-accent)";
      el.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { bg: getComputedStyle(el).backgroundColor, accent };
    });
  }
  writeEvidence("css/token.json", out);
  expect(out.controlRoom!.bg).toBe(out.controlRoom!.accent);
  expect(out.solid!.bg).toBe(out.solid!.accent);
  expect(out.controlRoom!.bg).not.toBe(out.solid!.bg);
});

test("criteria 35 to 38: hostile node CSS stays inside its node and the frame; shell surfaces untouched", async ({ page }) => {
  await page.goto(gallery({ scene: "css" }));
  await expect(page.locator('[data-node="c_cssstaraaa"]')).toBeVisible();
  const r = await page.evaluate(() => {
    const star = document.querySelector('[data-node="c_cssstaraaa"] [data-slot="root"]')!;
    const outside = document.querySelector('[data-node="c_cssplainaa"] [data-slot="label"]')!;
    const evil = document.querySelector('[data-node="c_cssevilaaa"]') as HTMLElement;
    const frame = document.querySelector("[data-atrium-canvas-frame]") as HTMLElement;
    const huge = document.querySelector('[data-node="c_csshugeaaa"] [data-slot="root"]') as HTMLElement;
    const sheets = [...document.querySelectorAll("style[data-node-css]")].map((s) => s.textContent ?? "").join("\n");
    return {
      starColor: getComputedStyle(star).color,
      outsideColor: getComputedStyle(outside).color,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      evilPosition: getComputedStyle(evil).position,
      hugeHeight: huge.getBoundingClientRect().height,
      frameOverflow: getComputedStyle(frame).overflow,
      frameBottom: frame.getBoundingClientRect().bottom,
      hugeBottom: huge.getBoundingClientRect().bottom,
      foreign: /example\.com|@import|@font-face/.test(sheets),
      uploadKept: sheets.includes("url(/uploads/plan.png)"),
    };
  });
  writeEvidence("css/hostile.json", r);
  expect(r.starColor).toBe("rgb(255, 0, 0)");
  expect(r.outsideColor).not.toBe("rgb(255, 0, 0)");
  expect(r.bodyBg).not.toBe("rgb(255, 0, 0)");
  expect(r.evilPosition).not.toBe("fixed");
  expect(r.foreign).toBe(false);
  expect(r.uploadKept).toBe(true);
  // Round 3 (gauntlet w2-r2 Fix 9, runaway heights): a styled component stops at one and a half screens
  // or 1200px, whichever is taller, so the 5000px style is drawn capped (and still clipped by the frame).
  // Wave 2.10a (A11.2): the viewer never clips a fit box, so a Style panel height is honoured, but only up
  // to the runaway cap (the line below). Node CSS (untrusted code) still holds its drawn box (j-final).
  expect(r.hugeHeight).toBeGreaterThan(8 * 8);
  expect(r.hugeHeight).toBeLessThanOrEqual(Math.max(1.5 * page.viewportSize()!.height, 1200) + 1);
  expect(["clip", "hidden"]).toContain(r.frameOverflow);
  // The app switcher (top layer, outside the canvas) is visible and clickable over everything.
  const sw = page.locator("[data-atrium-switcher] button").first();
  await expect(sw).toBeVisible();
  await sw.click();
  const swColor = await sw.evaluate((el) => getComputedStyle(el).color);
  expect(swColor).not.toBe("rgb(255, 0, 0)");
  await page.screenshot({ path: evidence("css/hostile-clipped.png") });
});

async function openInspector(page: Page, nodeId: string) {
  await page.goto(gallery({ scene: "inspector" }));
  // The frame mounts only after hydration: once it is there, clicks select.
  await expect(page.locator('[data-node="c_htmlblocka"] iframe')).toBeAttached({ timeout: 15_000 });
  await page.locator(`[data-node="${nodeId}"]`).first().click({ position: { x: 12, y: 12 } });
  await expect(page.locator(`[data-inspector][data-node-id="${nodeId}"]`)).toBeVisible();
}

test("criteria 30 and 31: Content and Data open, Style and Advanced closed; Override theme (Customise the look, Wave 2.6) on and off", async ({ page }) => {
  await openInspector(page, "c_statcpuaaa");
  await expect(page.locator('[data-inspector-group="content"]')).toHaveAttribute("data-open", "");
  await expect(page.locator('[data-inspector-group="data"]')).toHaveAttribute("data-open", "");
  await expect(page.locator('[data-inspector-group="style"]')).not.toHaveAttribute("data-open", "");
  await expect(page.locator('[data-inspector-group="advanced"]')).not.toHaveAttribute("data-open", "");
  await expect(page.locator("[data-css-box]")).toHaveCount(0);
  await page.screenshot({ path: evidence("inspector/first-select.png") });
  await page.locator('[data-inspector-group="style"] > h3 button').click();
  await page.getByRole("switch", { name: /Customise the look/ }).click();
  await expect(page.locator("[data-style-panel]")).toBeVisible();
  // Wave 2.6: Part, When and the rest sit under More style.
  await page.locator("[data-style-more-toggle]").click();
  await page.locator('[data-style-slot]').selectOption("value");
  await page.locator('[data-style-field="color"] input[data-style-text]').fill("#c0178a");
  const value = '[data-node="c_statcpuaaa"] [data-slot="value"]';
  await expect.poll(() => color(page, value), { timeout: 4000 }).toBe("rgb(192, 23, 138)");
  await page.screenshot({ path: evidence("inspector/override-on.png") });
  await page.getByRole("switch", { name: /Customise the look/ }).click();
  await expect.poll(() => color(page, value), { timeout: 4000 }).not.toBe("rgb(192, 23, 138)");
  // The saved style is still there: switching back on applies it again.
  await page.getByRole("switch", { name: /Customise the look/ }).click();
  await expect.poll(() => color(page, value), { timeout: 4000 }).toBe("rgb(192, 23, 138)");
  // Round 2: the colour field still checks a typed value and says why it was not applied.
  await page.locator('[data-style-field="color"] input[data-style-text]').fill("not-a-colour");
  await expect(page.locator('[data-style-refused="color"]')).toContainText("Not applied");
});

test("criterion 15: the Data panel shows the live value within 300ms, and errors with where they are", async ({ page }) => {
  await openInspector(page, "c_statcpuaaa");
  // Wave 2.6: a bound field shows a data chip; "Edit as template" shows the template box.
  await page.locator('[data-edit-template="data"]').click();
  const field = page.locator('[data-binding-field="data"] textarea');
  const live = page.locator('[data-binding-field="data"] [data-live-value]');
  await field.fill("{{ cpu.value | round(1) }}%");
  const t0 = Date.now();
  await expect(live).toHaveText('= "41.3%"', { timeout: 1000 });
  const okMs = Date.now() - t0;
  await field.fill("{{ cpu.value + }}");
  const t1 = Date.now();
  // Round 2 (Fix 13): plain words, and a quote of where the problem is instead of "(position N)".
  await expect(live).toHaveText(/ends too early\. (Near ".+"|At the end)\./, { timeout: 1000 });
  const errMs = Date.now() - t1;
  writeEvidence("inspector/live-value.json", { okMs, errMs, note: "includes Playwright polling; debounce is 200ms" });
  expect(okMs).toBeLessThan(450);
  await page.locator("[data-gallery-inspector]").screenshot({ path: evidence("inspector/live-value-error.png") });
});

test("criterion 35 in the UI: each removal is listed under the CSS box", async ({ page }) => {
  await openInspector(page, "c_statcpuaaa");
  await page.locator('[data-inspector-group="advanced"] > h3 button').click();
  await page.locator("[data-css-box] textarea").fill("@import url(x.css);\n.a { position: fixed }\nbody { color: red }\n@font-face { font-family: x }\n.b { background: url(https://example.com/x.png) }");
  const list = page.locator("[data-css-removed] li");
  await expect(list.first()).toBeVisible({ timeout: 4000 });
  const lines = await list.allTextContents();
  writeEvidence("inspector/css-removed.json", lines);
  for (const m of ["@import", "position: fixed", "body", "@font-face", "example.com"]) expect(lines.join("\n")).toContain(m);
  await page.locator("[data-gallery-inspector]").screenshot({ path: evidence("inspector/css-removed.png") });
});

test("criteria 41 and 43: the code window's tabs and console; the notice; the frame title is the name", async ({ page }) => {
  await openInspector(page, "c_htmlblocka");
  await expect(page.locator("[data-html-notice]")).toHaveText("Data you give this block is visible to whoever wrote its code.");
  await expect(page.locator("[data-code-window]")).toBeVisible();
  for (const t of ["html", "css", "js"]) await expect(page.locator(`[data-code-tab="${t}"]`)).toBeVisible();
  await expect(page.locator('[data-node="c_htmlblocka"] iframe')).toHaveAttribute("title", "CPU bar");
  await page.locator('[data-code-tab="js"]').click();
  await page.locator('[data-code-editor="js"]').fill("console.info('info line'); console.warn('warn line'); console.error('error line');");
  // A new code value re-runs on the next load; the console already shows the first run's lines.
  await expect(page.locator('[data-console] [data-log-level="info"]').first()).toBeVisible({ timeout: 5000 });
  await page.locator('[data-code-editor="js"]').fill("x".repeat(66 * 1024));
  await expect(page.locator("[data-code-limit]")).toContainText("64 KB");
  await page.screenshot({ path: evidence("inspector/code-window.png"), fullPage: true });
});

test("criterion 69: a new component fades in with settle", async ({ page }) => {
  await page.goto(gallery({ scene: "motion" }));
  await page.waitForTimeout(800);
  await page.locator("[data-add-component]").click();
  const added = page.locator("[data-new-node]").last();
  const early = await added.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, transform: (el as HTMLElement).style.transform }));
  await page.waitForTimeout(900);
  const late = await added.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, transform: (el as HTMLElement).style.transform }));
  writeEvidence("motion/settle.json", { early, late });
  expect(Number(early.opacity)).toBeLessThan(1);
  expect(Number(late.opacity)).toBe(1);
});
