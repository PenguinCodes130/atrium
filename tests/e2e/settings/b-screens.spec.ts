// V4, V5, V8 and AC 46: every settings screen in light, dark and light with reduce transparency, at
// 390x844, and with reduced motion; keyboard focus ring, 44px touch targets, text contrast and no
// horizontal scroll at 390px. Also the theme sample canvases in Control Room, Dusk and Solid (A1.7).
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { OWNER, VARIANTS, context, ev, minContrast, shot } from "./helpers";

test.setTimeout(300_000);
const TABS = ["general", "appearance", "themes", "users", "security", "backups", "notifications", "agents"];

test("shell screens in three variants (V4)", async ({ browser }) => {
  test.skip(test.info().project.name !== "desktop", "desktop captures");
  const contrast: Record<string, { ratio: number; text: string }> = {};
  for (const v of VARIANTS) {
    const ctx = await context(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    for (const t of TABS) {
      await page.goto(`/settings/${t}`);
      await expect(page.locator(`[data-settings-tab="${t}"]`)).toBeVisible();
      if (t === "themes") await expect(page.locator("[data-theme-window]").first()).toBeVisible();
      await shot(page, `${t}-${v}`);
      contrast[`${t}-${v}`] = await minContrast(page);
    }
    await ctx.close();
  }
  writeFileSync(ev("contrast.json"), JSON.stringify(contrast, null, 2));
  for (const [k, c] of Object.entries(contrast)) expect(c.ratio, `${k}: "${c.text}"`).toBeGreaterThanOrEqual(4.5);
});

test("390x844: no horizontal scroll, 44px targets (V5, AC 46)", async ({ browser }) => {
  test.skip(test.info().project.name !== "mobile", "phone captures");
  const report: Record<string, { scrollW: number; small: string[] }> = {};
  const ctx = await context(browser, OWNER, { mobile: true });
  const page = await ctx.newPage();
  for (const t of TABS) {
    await page.goto(`/settings/${t}`);
    await expect(page.locator(`[data-settings-tab="${t}"]`)).toBeVisible();
    await shot(page, `${t}-mobile`);
    report[t] = await page.evaluate(() => {
      const small: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("[data-settings-screen] :is(a, button, input, select, textarea, summary, [role=radio], [role=switch])")) {
        const r = el.getBoundingClientRect();
        if (!r.width || el.closest(".sr-only,[aria-hidden=true],[data-atrium-canvas]") || (el as HTMLInputElement).type === "file") continue;
        if (r.height < 43.5 && !(el.closest("label") && el.closest("label")!.getBoundingClientRect().height >= 43.5)) small.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(r.height)}px`);
      }
      return { scrollW: document.documentElement.scrollWidth, small };
    });
  }
  // The folded theme editor on a phone.
  await page.goto("/settings/themes");
  await page.locator("[data-new-theme]").click();
  await page.waitForURL(/\/settings\/themes\/(t-|new)/); // r2 low L8: New theme opens an unsaved editor at /new
  await expect(page.locator("[data-basics]")).toBeVisible();
  await shot(page, "theme-editor-mobile");
  report["theme-editor"] = { scrollW: await page.evaluate(() => document.documentElement.scrollWidth), small: [] };
  writeFileSync(ev("mobile.json"), JSON.stringify(report, null, 2));
  for (const [k, r] of Object.entries(report)) {
    expect(r.scrollW, `${k} scroll width`).toBeLessThanOrEqual(390);
    expect(r.small, `${k} small targets`).toEqual([]);
  }
  await ctx.close();
});

test("keyboard alone reaches the settings controls with the 2px focus ring (AC 46)", async ({ browser }) => {
  test.skip(test.info().project.name !== "desktop", "desktop");
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  const out: Record<string, { label: string; outline: string }[]> = {};
  for (const t of ["general", "appearance", "themes", "backups"]) {
    await page.goto(`/settings/${t}`);
    await expect(page.locator(`[data-settings-tab="${t}"]`)).toBeVisible();
    await page.locator("[data-screen-tabs]").focus().catch(() => undefined);
    await page.locator(`[data-screen-tabs] a[aria-current="page"]`).focus();
    const seen: { label: string; outline: string }[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      seen.push(await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        if (!el || !el.closest("[data-settings-screen]")) return { label: "(outside settings)", outline: "skip" };
        const cs = getComputedStyle(el);
        return { label: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("data-field") || el.tagName).trim().slice(0, 32), outline: `${cs.outlineStyle} ${cs.outlineWidth}` };
      }));
    }
    out[t] = seen;
    await page.screenshot({ path: ev("screens", `${t}-keyboard-focus.png`) });
  }
  writeFileSync(ev("keyboard.json"), JSON.stringify(out, null, 2));
  for (const [t, seen] of Object.entries(out)) {
    const inside = seen.filter((s) => s.outline !== "skip");
    expect(inside.length, `${t} reachable controls`).toBeGreaterThan(2);
    for (const s of inside) expect(s.outline, `${t} ${s.label}`).toMatch(/solid 2px/);
  }
});

test("reduced motion (V8) and the theme samples in Control Room, Dusk and Solid (V4 user themes)", async ({ browser }) => {
  test.skip(test.info().project.name !== "desktop", "desktop");
  const ctx = await context(browser, OWNER, { reducedMotion: true });
  const page = await ctx.newPage();
  for (const t of ["themes", "backups", "general"]) {
    await page.goto(`/settings/${t}`);
    await shot(page, `${t}-reduced-motion`);
  }
  await page.goto("/settings/themes");
  for (const id of ["control-room", "dusk", "solid"]) {
    await page.locator(`[data-theme-window="${id}"] [data-theme-sample]`).screenshot({ path: ev("screens", `sample-${id}.png`) });
  }
  await ctx.close();
  // The in-app Reduce motion switch alone gives the same result as the system setting.
  const ctx2 = await context(browser, OWNER);
  await ctx2.addCookies([{ name: "atrium_motion", value: "reduce", url: "http://127.0.0.1:3116" }]);
  const p2 = await ctx2.newPage();
  await p2.goto("/settings/themes");
  expect(await p2.evaluate(() => document.documentElement.getAttribute("data-motion"))).toBe("reduce");
  await shot(p2, "themes-reduce-motion-switch");
  await ctx2.close();
});
