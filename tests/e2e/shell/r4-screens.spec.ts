// Round 4 (gauntlet r2 Fix List) screens: one left edge and the shared header (Fixes 4, 5), the crumb
// and instance name (9), the top bar tabs (8), the coming room and New app (11), landscape (10).
import { expect, test, type Page } from "@playwright/test";
import { evidence, markSwept, previewUrl, setPrefCookies, signIn, writeEvidence } from "./helpers";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop project");

async function go(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/** Left edges of the band's mark, the band crumb, the screen title and the first content block. */
async function edges(page: Page) {
  return page.evaluate(() => {
    const left = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().left) : null;
    };
    const h1 = document.querySelector("main h1");
    const firstWindow = document.querySelector("main [data-window], main [data-skeleton]");
    return {
      mark: left('[data-sky-mark] svg[data-mark="lit"]'),
      crumb: left("[data-sky-path]"),
      title: h1 ? Math.round(h1.getBoundingClientRect().left) : null,
      titleClass: h1?.className ?? null,
      firstWindow: firstWindow ? Math.round(firstWindow.getBoundingClientRect().left) : null,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

const SCREENS: [string, string][] = [
  ["home", "/"],
  ["integrations", "/integrations"],
  ["add-integration", "/integrations/new"],
  ["credentials", "/integrations/credentials"],
  ["setup-prometheus", "/integrations/new/prometheus"],
  ["not-found", "/nope-r4"],
  ["settings-coming", "/settings"],
  ["preview-windows", previewUrl({ scene: "widgets", n: 6 })],
  ["preview-loading", previewUrl({ scene: "loading" })],
  ["preview-error", previewUrl({ scene: "error" })],
];

test("Fix 4 and 5: every shell screen has one left edge (band mark, crumb, title, content) and its h1 is the shared header or a room", async ({ page, context, baseURL }, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(180_000);
  await signIn(page);
  await markSwept(context, baseURL!);
  const out: Record<string, Record<string, unknown>> = {};
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, url] of SCREENS) {
      await go(page, url);
      const e = await edges(page);
      out[`${name}@${width}`] = e;
      await page.screenshot({ path: evidence(`screens/edge-${name}-${width}.png`) });
      expect(e.scrollWidth, name).toBe(e.innerWidth);
      // the band's mark is at the shell content column's left edge
      const column = Math.max(0, (width - 1024) / 2) + 40;
      expect(e.mark, name).toBe(column);
      if (e.titleClass !== null) expect(e.titleClass, name).toMatch(/\btype-(title-1|display)\b/);
    }
  }
  writeEvidence("criteria/fix4-fix5-left-edges.json", out);
});

test("Fix 4: no h1 on a shell screen uses any style but the shared header (type-title-1) or a room (type-display)", async ({ page, context, baseURL }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, baseURL!);
  const found: Record<string, { cls: string; size: string; text: string }[]> = {};
  for (const [name, url] of SCREENS) {
    await go(page, url);
    found[name] = await page.evaluate(() => [...document.querySelectorAll("main h1")].map((h) => ({ cls: h.className, size: getComputedStyle(h).fontSize, text: (h.textContent ?? "").slice(0, 60) })));
  }
  writeEvidence("criteria/fix4-h1-audit.json", found);
  const bad = Object.entries(found).flatMap(([name, hs]) => hs.filter((h) => !/\btype-(title-1|display)\b/.test(h.cls)).map((h) => `${name}: "${h.text}" (${h.cls})`));
  expect(bad, "h1 elements with another style").toEqual([]);
});

test("Fix 9: the crumb links back and the instance name is readable", async ({ page, context, baseURL }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, baseURL!);
  await go(page, "/integrations/new");
  const crumbs = await page.locator("[data-sky-path] [data-crumb]").evaluateAll((els) => els.map((e) => ({ text: e.textContent, href: e.getAttribute("href"), current: e.getAttribute("aria-current") })));
  const clock = await page.locator("[data-instance]").textContent();
  writeEvidence("criteria/fix9-crumb.json", { url: "/integrations/new", crumbs, clock });
  expect(crumbs[0]).toEqual({ text: "Atrium", href: "/", current: null });
  expect(crumbs[1]).toMatchObject({ text: "integrations", href: "/integrations" });
  expect(clock).toBe("Atrium");
  await page.locator('[data-sky-path] [data-crumb="1"]').click();
  await expect(page).toHaveURL(/\/integrations$/);
  await page.locator('[data-sky-path] [data-crumb="0"]').click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator("[data-sky-band]").screenshot({ path: evidence("screens/fix9-band-crumb.png") });
});

test("Fix 8: tabs without a route have full-contrast text and a soon tag in the tooltip; Settings opens /settings (round 5)", async ({ page, context, baseURL }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, baseURL!);
  await go(page, "/");
  const tabs = await page.locator('[data-shell="tabs"] [data-tab]').evaluateAll((els) =>
    els.map((e) => { const b = e.querySelector("[data-tab-box]")!; return { key: e.getAttribute("data-tab"), soon: e.hasAttribute("data-unavailable"), href: e.getAttribute("href"), color: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor, border: getComputedStyle(b).borderTopColor }; }),
  );
  const ink = await page.evaluate(() => getComputedStyle(document.querySelector('[data-tab="integrations"] [data-tab-box]')!).color);
  for (const t of tabs.filter((x) => x.soon)) expect(t.color, t.key!).toBe(ink);
  expect(tabs.find((t) => t.key === "settings")).toMatchObject({ soon: false, href: "/settings" });
  // Wave 2: /library shipped, so the tooltip is checked on Approvals (still Wave 3).
  await page.locator('[data-shell="tabs"] [data-tab="approvals"]').hover();
  const tip = page.locator("[data-tooltip]");
  await expect(tip).toBeVisible();
  const tipText = await tip.innerText();
  const tag = await tip.locator("[data-tip-tag]").textContent();
  await page.locator('[data-shell="topbar"]').screenshot({ path: evidence("screens/fix8-topbar-soon-tooltip.png") });
  writeEvidence("criteria/fix8-tabs.json", { tabs, liveTabText: ink, tooltip: tipText, tag });
  expect(tag).toBe("soon");
});

test("Fix 11: New app says apps arrive with the app builder and links to Integrations; an unbuilt room (/audit, round 5: settings ships in Wave 2) is a coming room", async ({ page, context, baseURL }, info) => {
  desktopOnly(info.project.name);
  // Round 5: "/" is app-builder's launcher now, so the interim home's New app note is gone with it.
  test.skip(true, "the interim home was replaced by app-builder's launcher (Wave 2); the coming room is checked in r5-shell");
  await signIn(page);
  await markSwept(context, baseURL!);
  await go(page, "/");
  const note = await page.locator("[data-interim-note]").innerText();
  await page.locator("[data-new-app]").click();
  const t = page.locator('[data-toast="info"]').first();
  await expect(t).toBeVisible();
  await page.screenshot({ path: evidence("screens/fix11-new-app.png") });
  const toastText = await t.innerText();
  await t.getByRole("button", { name: "Open Integrations" }).click();
  await expect(page).toHaveURL(/\/integrations$/);
  await go(page, "/audit");
  const room = await page.locator("[data-empty-room]").innerText();
  await page.screenshot({ path: evidence("screens/fix11-audit-coming.png") });
  const primary = await page.locator("[data-go-home]").getAttribute("href");
  writeEvidence("criteria/fix11-coming.json", { note, toastText, auditRoom: room, auditPrimary: primary });
  expect(note).toMatch(/Apps arrive with the app builder/);
  expect(toastText).toMatch(/Apps arrive with the app builder/);
  expect(room).toMatch(/Audit is coming in a later update/);
  expect(room).not.toMatch(/does not exist/);
  expect(primary).toBe("/");
});

test("Fix 10: landscape phone 844x390: top bar plus band at most 30% of the height, touch controls 44px, side safe areas", async ({ browser, baseURL }, info) => {
  desktopOnly(info.project.name);
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await signIn(page);
  await markSwept(ctx, baseURL!);
  const out: Record<string, unknown> = {};
  for (const [name, url] of [["integrations", "/integrations"], ["home", "/"]] as const) {
    await go(page, url);
    out[name] = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const bar = r('[data-shell="topbar"]');
      const band = r('[data-shell="skyband"]');
      const controls = [...document.querySelectorAll('[data-shell="topbar"] a, [data-shell="topbar"] button')]
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => {
          const b = e.getBoundingClientRect();
          return { label: e.getAttribute("aria-label") ?? e.textContent?.trim().slice(0, 20), w: Math.round(b.width), h: Math.round(b.height) };
        });
      return { topbar: bar.height, band: band.height, share: +((bar.height + band.height) / window.innerHeight).toFixed(3), controls, keysShown: getComputedStyle(document.querySelector("[data-search-keys]")!).display, scrollWidth: document.documentElement.scrollWidth };
    });
    await page.screenshot({ path: evidence(`screens/fix10-landscape-${name}.png`) });
  }
  // Side safe areas: Chromium reports env(safe-area-inset-*) as 0 here, so read the rule itself.
  const pad = await page.evaluate(() => {
    const rules: string[] = [];
    for (const sh of [...document.styleSheets]) {
      try {
        for (const r of [...sh.cssRules]) if (r.cssText.includes(".screen-x") || r.cssText.includes("[data-sky-column]")) rules.push(r.cssText);
      } catch {
        /* cross-origin */
      }
    }
    return rules.filter((r) => r.includes("safe-area-inset")).slice(0, 3);
  });
  out.screenColumnSafeAreaRules = pad;
  expect(pad.length).toBeGreaterThan(0);
  writeEvidence("criteria/fix10-landscape.json", out);
  for (const k of ["integrations", "home"]) {
    const o = out[k] as { share: number; controls: { w: number; h: number; label: string }[]; keysShown: string; scrollWidth: number };
    expect(o.share, k).toBeLessThanOrEqual(0.3);
    for (const c of o.controls) {
      expect(c.w, c.label).toBeGreaterThanOrEqual(44);
      expect(c.h, c.label).toBeGreaterThanOrEqual(44);
    }
    expect(o.keysShown).toBe("none");
    expect(o.scrollWidth).toBe(844);
  }
  await ctx.close();
});

test("Fix 4 and 5 at 390: one left edge on phones too", async ({ page, context, baseURL }, info) => {
  test.skip(info.project.name !== "mobile", "mobile project");
  await signIn(page);
  await markSwept(context, baseURL!);
  await setPrefCookies(context, baseURL!, {});
  const out: Record<string, unknown> = {};
  for (const [name, url] of [["integrations", "/integrations"], ["home", "/"], ["settings-coming", "/settings"], ["preview-windows", previewUrl({ scene: "widgets", n: 3 })]] as const) {
    await go(page, url);
    const e = await edges(page);
    out[name] = e;
    await page.screenshot({ path: evidence(`screens/edge-${name}-390.png`) });
    expect(e.mark, name).toBe(16);
    expect(e.scrollWidth, name).toBe(390);
  }
  writeEvidence("criteria/fix5-left-edges-390.json", out);
});
