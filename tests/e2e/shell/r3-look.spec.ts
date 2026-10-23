// app-shell round 3 (design v4, spec v2): tokens, type, shape, windows, frame, sky band, buttons,
// switches, toasts, rooms, system screens, logo, contrast and focus. Evidence: evidence/app-shell/r3/.
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { BLACK, PALETTE, WHITE, contrast, evidence, fresh, go, hex, hexDelta, markSwept, ORIGIN, over, parseColor, previewUrl, samplePixels, signIn, tokenColors, writeEvidence } from "./helpers";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop project");
const mobileOnly = (name: string) => test.skip(name !== "mobile", "mobile project");

async function css(page: Page, selector: string, props: string[]) {
  return page.locator(selector).first().evaluate((el, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])), props);
}
async function box(page: Page, selector: string) {
  return (await page.locator(selector).first().boundingBox())!;
}
const toHex = (s: string) => hex(parseColor(s));
/** Tailwind 4 composes inset, ring and shadow layers; keep only the visible ones. */
const visibleShadow = (s: string) => (s === "none" ? "none" : s.split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => !x.startsWith("rgba(0, 0, 0, 0)")).join(", ") || "none");

test("C1 palette in light and dark matches design v4 (tokens and sampled pixels); the override wins", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const names = { bg: "--bg", bgHi: "--bg-hi", bgSunk: "--bg-sunk", fg: "--fg", fg2: "--fg-2", fg3: "--fg-3", titlebar: "--titlebar", accent: "--accent", accentHi: "--accent-hi", accentInk: "--accent-ink", sky: "--sky", skyInk: "--sky-ink", ok: "--ok", warn: "--warn", warnInk: "--warn-ink", bad: "--bad" } as const;
  const out: Record<string, unknown> = {};
  // system light and dark, then the override against the opposite system preference
  for (const [label, scheme, pref] of [["light", "light", undefined], ["dark", "dark", undefined], ["override-dark-on-light-system", "light", "dark"], ["override-light-on-dark-system", "dark", "light"]] as const) {
    const { ctx, page } = await fresh(browser, { colorScheme: scheme }, pref ? { theme: pref } : {});
    await go(page, previewUrl({ scene: "widgets", n: 3 }));
    const mode = (pref ?? scheme) as "light" | "dark";
    const tokens = await tokenColors(page, Object.values(names));
    const got = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, toHex(tokens[n]!)]));
    // pixel samples: page background, a window body, a title bar, the active tab, the sky band (left edge)
    const png = await page.screenshot({ path: evidence(`screens/c1-${label}.png`) });
    const win = await box(page, '[data-widget="1"] [data-window-body]');
    const bar = await box(page, '[data-widget="1"] [data-titlebar]');
    const band = await box(page, "[data-sky-band]");
    const tab = await box(page, '[data-shell="tabs"] [data-tab="apps"]');
    const pts: [number, number][] = [[640, 205], [win.x + win.width - 30, win.y + win.height - 10], [bar.x + bar.width / 2, bar.y + 3], [band.x + 4, band.y + 4], [tab.x + 3, tab.y + 3]];
    const px = (await samplePixels(page, png, pts)).map(([r, g, b]) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase());
    const want = PALETTE[mode];
    const sampled = { pageBg: px[0], windowBody: px[1], titleBar: px[2], skyBandLeft: px[3] };
    out[label] = { mode, tokens: got, sampled };
    for (const k of Object.keys(names) as (keyof typeof names)[]) expect(hexDelta(got[k]!, want[k]), `${label} ${k}`).toBeLessThanOrEqual(1);
    expect(hexDelta(px[0]!, want.bg), `${label} page background pixel`).toBeLessThanOrEqual(2);
    expect(hexDelta(px[1]!, want.bgHi), `${label} window body pixel`).toBeLessThanOrEqual(2);
    expect(hexDelta(px[2]!, want.titlebar), `${label} title bar pixel`).toBeLessThanOrEqual(2);
    // the band's left edge is the sky colour under a 0.22 grain (multiply in light, overlay in dark): close, not exact
    expect(hexDelta(px[3]!, want.sky), `${label} sky band pixel`).toBeLessThanOrEqual(48);
    await ctx.close();
  }
  writeEvidence("criteria/c1-palette.json", out);
});

test("C3 C4 type scale at 1280 and 390; tabular numbers; phone gutters and padding; no horizontal scroll", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const want: Record<string, [number, number, number, number, "ui" | "mono"]> = {
    display: [72, 64, 600, -0.04, "ui"], "title-1": [44, 42, 600, -0.04, "ui"], "title-2": [30, 32, 600, -0.035, "ui"], "title-3": [20, 24, 600, -0.02, "ui"],
    "body-lg": [18, 25, 500, -0.015, "ui"], body: [15, 22, 400, -0.01, "ui"], label: [12, 16, 400, -0.01, "mono"], caption: [11, 15, 400, 0, "mono"], readout: [36, 36, 600, -0.05, "ui"],
  };
  const out: Record<string, unknown> = {};
  for (const width of [1280, 390]) {
    const { ctx, page } = await fresh(browser, { viewport: { width, height: 844 } });
    await go(page, previewUrl({ scene: "buttons" }));
    const got = await page.locator("[data-type]").evaluateAll((els) =>
      Object.fromEntries(els.map((e) => {
        const cs = getComputedStyle(e);
        return [e.getAttribute("data-type"), { size: parseFloat(cs.fontSize), line: parseFloat(cs.lineHeight), weight: +cs.fontWeight, tracking: (parseFloat(cs.letterSpacing) || 0) / parseFloat(cs.fontSize), family: cs.fontFamily, numeric: cs.fontVariantNumeric }];
      })),
    );
    const phone = width < 640;
    for (const [k, [size, line, weight, tracking, fam]] of Object.entries(want)) {
      const g = got[k] as { size: number; line: number; weight: number; tracking: number; family: string; numeric: string };
      const exp = phone && k === "display" ? [44, 42] : phone && k === "title-1" ? [32, 32] : phone && k === "title-2" ? [24, 26] : [size, line];
      expect(g.size, `${width} ${k} size`).toBe(exp[0]);
      expect(g.line, `${width} ${k} line`).toBe(exp[1]);
      expect(g.weight, `${width} ${k} weight`).toBe(weight);
      expect(Math.abs(g.tracking - tracking), `${width} ${k} tracking`).toBeLessThan(0.002);
      expect(g.family, `${width} ${k} family`).toMatch(fam === "mono" ? /Geist Mono/ : /Inter Tight/);
    }
    expect((got.table as { numeric: string }).numeric).toContain("tabular-nums");
    expect((got.readout as { numeric: string }).numeric).toContain("tabular-nums");
    const layout = await page.evaluate(() => {
      const body = document.querySelector("[data-window-body]")!;
      const cs = getComputedStyle(body);
      const main = document.querySelector("[data-buttons-scene]")!;
      return { windowPadding: cs.paddingLeft, gutter: getComputedStyle(main).paddingLeft, scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
    });
    expect(layout.windowPadding).toBe(phone ? "16px" : "20px");
    expect(layout.gutter).toBe(phone ? "16px" : "40px");
    expect(layout.scrollW).toBeLessThanOrEqual(layout.innerW);
    out[width] = { type: got, layout };
    await page.screenshot({ path: evidence(`screens/c3-type-${width}.png`), fullPage: true });
    await ctx.close();
  }
  writeEvidence("criteria/c3-c4-type.json", out);
});

/** Every element with a corner radius or a backdrop blur on the current screen. */
async function shapeSweep(page: Page) {
  return page.evaluate(() => {
    const rounded: { el: string; radius: string; w: number; h: number }[] = [];
    const blurred: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll<HTMLElement>("*")) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (cs.borderRadius && cs.borderRadius !== "0px" && cs.display !== "none") rounded.push({ el: `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 3).join(".") : ""}${[...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `[${a.name}]`).join("")}`, radius: cs.borderRadius, w: Math.round(r.width), h: Math.round(r.height) });
        const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter;
        if (bf && bf !== "none") blurred.push(`${el.tagName.toLowerCase()}${[...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `[${a.name}]`).join("")}`);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return { rounded, blurred };
  });
}

test("C5 C9 every shell window, button, input, badge, tab and sheet is square; no blur anywhere in the shell", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  const out: Record<string, unknown> = {};
  const screens: [string, () => Promise<void>][] = [
    ["apps", () => go(page, "/").then(() => undefined)],
    ["integrations", () => go(page, "/integrations").then(() => undefined)],
    ["integrations-new", () => go(page, "/integrations/new").then(() => undefined)],
    ["windows", () => go(page, previewUrl({ scene: "widgets" })).then(() => undefined)],
    ["buttons", () => go(page, previewUrl({ scene: "buttons" })).then(() => undefined)],
    ["toast", async () => { await go(page, previewUrl({ scene: "toasts" })); await page.locator('[data-raise="info"]').click(); await page.waitForTimeout(500); }],
    ["account-menu", async () => { await go(page, "/"); await page.locator("[data-account-trigger]").click(); await page.waitForTimeout(400); }],
    ["palette-sheet", async () => { await go(page, "/"); await page.keyboard.press("Control+k"); await page.waitForTimeout(600); }],
    ["not-found", () => go(page, "/no-such-room").then(() => undefined)],
    ["error", () => go(page, previewUrl({ scene: "error" })).then(() => undefined)],
    ["loading", () => go(page, previewUrl({ scene: "loading" })).then(() => undefined)],
  ];
  for (const [name, open] of screens) {
    await open();
    const s = await shapeSweep(page);
    out[name] = s;
    // Only round things allowed: status dots, live dots and avatars (rounded-full, at most 40px).
    const bad = s.rounded.filter((r) => !(r.radius.includes("e+") || parseFloat(r.radius) >= Math.min(r.w, r.h) / 2) || Math.max(r.w, r.h) > 40);
    expect(bad, `${name}: square surfaces`).toEqual([]);
    expect(s.blurred, `${name}: no blur in the shell`).toEqual([]);
  }
  writeEvidence("criteria/c5-c9-shape-and-blur-sweep.json", out);
});

test("C6 C7 C8 windows: 28px title bar, door glyph, mono path, 1px border, 6px hard shadow (ink light, gold dark); menus 3px; sheets soft plus window; no shadow inside a window", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const scheme of ["light", "dark"] as const) {
    const { ctx, page } = await fresh(browser, { colorScheme: scheme });
    await go(page, previewUrl({ scene: "widgets" }));
    const w = await page.locator('[data-widget="1"]').evaluate((el) => {
      const bar = el.querySelector("[data-titlebar]")!;
      const title = el.querySelector("[data-window-title]")!;
      const cs = getComputedStyle(el);
      return { barHeight: bar.getBoundingClientRect().height, door: !!bar.querySelector('[data-door="lit"]'), titleFont: getComputedStyle(title).fontFamily, titleSize: getComputedStyle(title).fontSize, title: title.textContent, border: cs.borderTopWidth + " " + cs.borderTopStyle, shadow: cs.boxShadow, radius: cs.borderRadius };
    });
    expect(w.barHeight).toBe(28);
    expect(w.door).toBe(true);
    expect(w.titleFont).toMatch(/Geist Mono/);
    expect(w.titleSize).toBe("12px");
    expect(w.title).toContain(" / ");
    expect(w.border).toBe("1px solid");
    expect(visibleShadow(w.shadow)).toBe(scheme === "light" ? "rgb(21, 19, 15) 6px 6px 0px 0px" : "rgba(233, 185, 73, 0.9) 6px 6px 0px 0px");
    // menus and tooltips: 3px; sheets: the soft overlay plus the window shadow
    await page.locator("[data-account-trigger]").click();
    const menu = await css(page, "[data-account-menu]", ["box-shadow"]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(500);
    const sheet = await css(page, "[data-sheet]", ["box-shadow"]);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    expect(visibleShadow(menu["box-shadow"]!)).toMatch(/^rgba?\([^)]*\) 3px 3px 0px 0px$/);
    expect(visibleShadow(sheet["box-shadow"]!)).toMatch(/0px 24px 64px 0px, rgba?\([^)]*\) 6px 6px 0px 0px$/);
    // no shadowed window inside another window, on every screen with windows
    const nested: Record<string, number> = {};
    for (const url of [previewUrl({ scene: "widgets" }), previewUrl({ scene: "buttons" }), "/integrations", "/integrations/new", previewUrl({ scene: "form" })]) {
      await go(page, url);
      nested[url] = await page.evaluate(() => [...document.querySelectorAll("[data-window] [data-window], [data-window] [data-glass], [data-glass] [data-window], [data-glass] [data-glass]")].filter((e) => getComputedStyle(e).boxShadow.split(/,(?![^(]*\))/).some((x) => !x.trim().startsWith("rgba(0, 0, 0, 0)") && x.trim() !== "none")).length);
      expect(nested[url], `${url}: shadowed window inside a window`).toBe(0);
    }
    out[scheme] = { window: { ...w, shadow: visibleShadow(w.shadow) }, menuShadow: visibleShadow(menu["box-shadow"]!), sheetShadow: visibleShadow(sheet["box-shadow"]!), nestedShadowedWindows: nested };
    await ctx.close();
  }
  writeEvidence("criteria/c6-c7-c8-windows.json", out);
});

test("C11 C12 C13 at 1280: 52px top bar with a hairline, mark, Atrium, boxed tabs in order, Ctrl K, clock, account; no sidebar; active tab ink; approvals badge", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser);
  await go(page, "/integrations");
  const r = await page.evaluate(() => {
    const bar = document.querySelector('[data-shell="topbar"]')!;
    const cs = getComputedStyle(bar);
    const items = [...bar.querySelectorAll("[data-brand] [data-wordmark] svg, [data-wordmark-text], [data-tab], [data-search-hint], [data-clock], [data-account-trigger]")].map((e) => ({ what: e.getAttribute("data-tab") ?? (e.hasAttribute("data-wordmark-text") ? "Atrium" : e.hasAttribute("data-search-hint") ? "ctrl-k" : e.hasAttribute("data-clock") ? "clock" : e.hasAttribute("data-account-trigger") ? "account" : "mark"), x: Math.round(e.getBoundingClientRect().x), h: Math.round(e.getBoundingClientRect().height), text: (e.textContent ?? "").trim() }));
    // Round 5: [data-tab] is the 44px hit area (the tab stop); the 32px box inside it ([data-tab-box]) carries the look.
    const tabs = [...bar.querySelectorAll<HTMLElement>("[data-tab]")].map((t) => { const b = t.querySelector<HTMLElement>("[data-tab-box]")!; const s = getComputedStyle(b); return { key: t.getAttribute("data-tab"), label: t.querySelector("[data-tab-label]")?.textContent, hit: t.getBoundingClientRect().height, h: b.getBoundingClientRect().height, border: s.borderTopWidth, bg: s.backgroundColor, color: s.color, active: t.getAttribute("aria-current") === "page" }; });
    return { height: bar.getBoundingClientRect().height, borderBottom: `${cs.borderBottomWidth} ${cs.borderBottomColor}`, items, tabs, sidebar: document.querySelectorAll('[data-shell="sidebar"], [data-shell="rail"]').length, markHeight: bar.querySelector("[data-brand] [data-wordmark] svg")!.getBoundingClientRect().height };
  });
  expect(r.height).toBe(52);
  expect(r.borderBottom).toBe("1px rgba(21, 19, 15, 0.16)");
  expect(r.sidebar).toBe(0);
  expect(r.markHeight).toBe(24);
  const order = r.items.sort((a, b) => a.x - b.x).map((i) => i.what);
  expect(order).toEqual(["mark", "Atrium", "apps", "integrations", "approvals", "library", "audit", "settings", "ctrl-k", "clock", "account"]);
  expect(r.tabs.map((t) => t.label)).toEqual(["Apps", "Integrations", "Approvals", "Library", "Audit", "Settings"]);
  for (const t of r.tabs) {
    expect(t.h, `${t.key} height`).toBe(32);
    expect(t.hit, `${t.key} tab stop height`).toBeGreaterThanOrEqual(44);
    expect(t.border, `${t.key} border`).toBe("1px");
  }
  const active = r.tabs.filter((t) => t.active);
  expect(active.map((t) => t.key)).toEqual(["integrations"]);
  expect(toHex(active[0]!.bg)).toBe("#15130F");
  expect(toHex(active[0]!.color)).toBe("#F3EFE4");
  // Round 4 (Fix 9): an IP host reads as "Atrium".
  expect(r.items.find((i) => i.what === "clock")!.text).toMatch(/Atrium\s*\d\d:\d\d/);
  expect(r.items.find((i) => i.what === "ctrl-k")!.text).toBe("CtrlK");
  await page.screenshot({ path: evidence("screens/c11-topbar-1280.png"), clip: { x: 0, y: 0, width: 1280, height: 60 } });
  // C13: badge with pending proposals (fed through the shell nav), none without
  await go(page, previewUrl({ scene: "widgets", approvals: 3 }));
  await expect(page.locator('[data-shell="tabs"] [data-tab="approvals"] [data-badge]')).toHaveText("3");
  await page.screenshot({ path: evidence("screens/c13-approvals-badge.png"), clip: { x: 0, y: 0, width: 1280, height: 60 } });
  await go(page, previewUrl({ scene: "widgets", approvals: 0 }));
  await expect(page.locator('[data-shell="tabs"] [data-tab="approvals"] [data-badge]')).toHaveCount(0);
  writeEvidence("criteria/c11-c12-c13-topbar.json", { ...r, order, badgeWith3: "3", badgeWith0: "none", hookUnregistered: "badge hidden (unit test r3.test.ts)" });
  await ctx.close();
});

test("C14 at 1000px the clock hides and tabs keep labels; at 800px tabs are icons with mono labels under them", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const width of [1000, 800]) {
    const { ctx, page } = await fresh(browser, { viewport: { width, height: 700 } });
    await go(page, "/integrations");
    const r = await page.evaluate(() => {
      const t = document.querySelector<HTMLElement>('[data-tab="audit"] [data-tab-box]')!;
      const icon = t.querySelector("svg")!;
      const label = t.querySelector("[data-tab-label]")!;
      return { clockVisible: getComputedStyle(document.querySelector("[data-clock]")!).display !== "none", iconVisible: getComputedStyle(icon).display !== "none", labelVisible: getComputedStyle(label).display !== "none", labelBelowIcon: label.getBoundingClientRect().top >= icon.getBoundingClientRect().bottom - 1, flexDirection: getComputedStyle(t).flexDirection, labelFont: getComputedStyle(label).fontFamily, scrollW: document.documentElement.scrollWidth };
    });
    out[width] = r;
    expect(r.clockVisible).toBe(false);
    expect(r.labelVisible).toBe(true);
    if (width === 1000) expect(r.iconVisible).toBe(false);
    else {
      expect(r.iconVisible).toBe(true);
      expect(r.labelBelowIcon).toBe(true);
      expect(r.labelFont).toMatch(/Geist Mono/);
    }
    expect(r.scrollW).toBeLessThanOrEqual(width);
    await page.screenshot({ path: evidence(`screens/c14-topbar-${width}.png`), clip: { x: 0, y: 0, width, height: 180 } });
    await ctx.close();
  }
  writeEvidence("criteria/c14-tablet.json", out);
});

test("C15 C16 at 390x844: top bar has only mark, search and account; bottom bar 60px plus safe area on raised paper; sky band 72px with the 40px mark", async ({ page, context }, info) => {
  mobileOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, "/integrations");
  const r = await page.evaluate(() => {
    const bar = document.querySelector('[data-shell="topbar"]')!;
    const visible = (e: Element | null) => !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
    const shown = [...bar.querySelectorAll("a, button")].filter((e) => visible(e) && !e.closest('[data-shell="tabs"]')).map((e) => e.getAttribute("aria-label"));
    const tb = document.querySelector('[data-shell="tabbar"]')!;
    const tcs = getComputedStyle(tb);
    const band = document.querySelector("[data-sky-band]")!.getBoundingClientRect();
    const mark = document.querySelector("[data-sky-mark] svg")!.getBoundingClientRect();
    return {
      topbarControls: shown, tabsVisible: visible(bar.querySelector('[data-shell="tabs"]')), clockVisible: visible(bar.querySelector("[data-clock]")),
      tabbar: { height: tb.getBoundingClientRect().height, heightRule: (tb as HTMLElement).style.height, bg: tcs.backgroundColor, borderTop: `${tcs.borderTopWidth} ${tcs.borderTopColor}`, labels: [...tb.querySelectorAll("[data-tab-label]")].map((l) => l.textContent) },
      band: { top: band.top, height: band.height, bottom: band.bottom }, topbarBottom: bar.getBoundingClientRect().bottom, mark: { height: mark.height, left: mark.left, bottom: mark.bottom },
      scrollW: document.documentElement.scrollWidth,
    };
  });
  expect(r.topbarControls).toEqual(["Atrium, apps", "Search (Ctrl K)", expect.stringMatching(/^Account/)]);
  expect(r.tabsVisible).toBe(false);
  expect(r.clockVisible).toBe(false);
  expect(r.tabbar.height).toBe(60);
  expect(r.tabbar.heightRule).toContain("env(safe-area-inset-bottom");
  expect(toHex(r.tabbar.bg)).toBe("#FBF9F3");
  expect(r.tabbar.borderTop).toBe("1px rgba(21, 19, 15, 0.16)");
  expect(r.tabbar.labels).toEqual(["Apps", "Integrations", "Approvals", "More"]);
  expect(r.band.height).toBe(72);
  expect(r.band.top).toBe(r.topbarBottom);
  expect(r.mark.height).toBe(40);
  expect(r.mark.left).toBe(16);
  expect(Math.abs(r.mark.bottom - r.band.bottom)).toBeLessThanOrEqual(1.5);
  expect(r.scrollW).toBeLessThanOrEqual(390);
  await page.screenshot({ path: evidence("screens/c15-c16-phone-390.png") });
  // the More sheet: Library, Audit, Settings and the account
  await page.locator('[data-tab="more"]').click();
  const sheet = page.locator('[data-sheet="more"]');
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(500);
  // Wave 2: Library is live (components' /library, lead integration item C); Audit is still coming.
  expect(await sheet.locator("[data-nav]").allTextContents()).toEqual(["Library", "Auditsoon", "Settings"]);
  await expect(sheet.locator("[data-more-account]")).toBeVisible();
  await page.screenshot({ path: evidence("screens/c15-phone-more-sheet.png") });
  writeEvidence("criteria/c15-c16-phone.json", r);
});

test("C16 C17 sky band: 120px under the top bar on every shell screen with the 40px mark at the gutter; never in the builder", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  const out: Record<string, unknown> = {};
  for (const url of ["/", "/integrations", "/integrations/new", previewUrl({ scene: "widgets" }), "/no-such-room"]) {
    await go(page, url);
    out[url] = await page.evaluate(() => {
      const band = document.querySelector("[data-sky-band]");
      if (!band) return null;
      const b = band.getBoundingClientRect();
      const m = band.querySelector("[data-sky-mark] svg")!.getBoundingClientRect();
      return { top: b.top, height: b.height, width: b.width, topbarBottom: document.querySelector('[data-shell="topbar"]')!.getBoundingClientRect().bottom, markHeight: m.height, markLeft: m.left, markBottomGap: b.bottom - m.bottom, doorway: band.querySelector("[data-doorway]")!.getAttribute("fill") };
    });
    const r = out[url] as { top: number; height: number; width: number; topbarBottom: number; markHeight: number; markLeft: number; markBottomGap: number; doorway: string };
    expect(r, url).not.toBeNull();
    expect(r.height).toBe(120);
    expect(r.top).toBe(r.topbarBottom);
    expect(r.markHeight).toBe(40);
    // Round 4 (Fix 5): the mark sits at the shell content column's left edge (the gutter on phones and
    // narrow screens; centred with the 1024px column on wide ones).
    expect(r.markLeft).toBe(Math.max(0, (r.width - 1024) / 2) + 40);
    expect(Math.abs(r.markBottomGap)).toBeLessThanOrEqual(1.5);
    expect(r.doorway).toBe("var(--accent)");
  }
  // the builder never shows it (app-builder's /build route is not built yet: its not-found renders in the frame there)
  await go(page, "/build/homelab");
  expect(await page.locator("[data-sky-band]").count()).toBe(0);
  out["/build/homelab"] = "no sky band";
  writeEvidence("criteria/c16-c17-sky-band.json", { ...out, viewedApps: "the /a/<slug> route group renders outside the shell layout (architecture v3 section 2); it does not exist until app-builder (Wave 2), so the viewed-app half of C17 is SKIPPED in e2e. The app preview scene has no band of its own (it covers the shell)." });
});

test("C18 with reduced motion or no graphics acceleration the sky band is the static gradient with grain; screenshots 5s apart are identical", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const [label, opts, prefs] of [["no-gpu-host", {}, {}], ["reduced-motion-system", { reducedMotion: "reduce" as const }, {}], ["reduce-transparency-switch", {}, { transparency: true }]] as const) {
    const { ctx, page } = await fresh(browser, opts, prefs);
    await go(page, "/integrations");
    const band = page.locator("[data-sky-band]");
    await expect(band).toHaveAttribute("data-sky-band", "static");
    const clip = (await band.boundingBox())!;
    const a = await page.screenshot({ clip });
    await page.waitForTimeout(5000);
    const b = await page.screenshot({ clip });
    out[label] = { mode: await band.getAttribute("data-sky-band"), identical: a.equals(b), grain: await band.evaluate((e) => getComputedStyle(e, "::after").backgroundImage.startsWith("url(")) };
    expect(a.equals(b), label).toBe(true);
    await ctx.close();
  }
  // With the shader forced on (diagnostic cookie), the band mounts the WebGL grain gradient.
  const { ctx, page } = await fresh(browser);
  await ctx.addCookies([{ name: "atrium_sky", value: "shader", url: ORIGIN }]);
  await go(page, "/integrations");
  await expect(page.locator("[data-sky-band]")).toHaveAttribute("data-sky-band", "shader");
  await expect(page.locator("[data-sky-shader] canvas")).toHaveCount(1, { timeout: 5000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: evidence("screens/c18-sky-band-shader-forced.png"), clip: { x: 0, y: 0, width: 1280, height: 200 } });
  out.shaderForced = { mounted: true, note: "software WebGL on this host; normal pages detect it and use the static band" };
  await ctx.close();
  writeEvidence("criteria/c18-sky-static.json", out);
});

test("C19 C20 C21 buttons: styles in both modes, 36px pointer, press 4px with the 2px shadow, reduced motion swaps only, disabled 40%; one primary per view", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const scheme of ["light", "dark"] as const) {
    const { ctx, page } = await fresh(browser, { colorScheme: scheme });
    await go(page, previewUrl({ scene: "buttons" }));
    const P = PALETTE[scheme];
    const styles = await page.locator("[data-btn]").evaluateAll((els) => Object.fromEntries(els.map((e) => { const s = getComputedStyle(e); return [e.getAttribute("data-btn"), { bg: s.backgroundColor, color: s.color, border: `${s.borderTopWidth} ${s.borderTopColor}`, h: e.getBoundingClientRect().height, radius: s.borderRadius, shadow: s.boxShadow, opacity: s.opacity, weight: s.fontWeight, tracking: s.letterSpacing, size: s.fontSize }]; })));
    const b = styles as Record<string, { bg: string; color: string; border: string; h: number; radius: string; shadow: string; opacity: string; weight: string; tracking: string; size: string }>;
    const ink = scheme === "light" ? "#15130F" : "#F3EFE4";
    expect(toHex(b.primary!.bg)).toBe(P.accent);
    expect(toHex(b.primary!.color)).toBe("#15130F");
    expect(visibleShadow(b.primary!.shadow)).toMatch(/3px 3px 0px 0px$/);
    expect(toHex(b.secondary!.bg)).toBe(P.bgHi);
    expect(toHex(b.secondary!.color)).toBe(ink);
    expect(toHex(b.quiet!.color)).toBe(P.fg2);
    expect(b.quiet!.bg).toBe("rgba(0, 0, 0, 0)");
    expect(toHex(b.destructive!.color)).toBe(P.bad);
    expect(b.destructive!.border).toContain("1px");
    expect(toHex(b["destructive-confirm"]!.bg)).toBe(P.bad);
    expect(toHex(b["destructive-confirm"]!.color)).toBe(scheme === "light" ? "#FBF9F3" : "#15130F");
    expect(toHex(b.ink!.bg)).toBe(scheme === "light" ? "#15130F" : P.bgHi);
    for (const [k, v] of Object.entries(b)) {
      expect(v.h, `${k} height`).toBe(36);
      expect(v.radius, `${k} radius`).toBe("0px");
      expect(v.weight, `${k} weight`).toBe("500");
      expect(v.size, `${k} size`).toBe("15px");
      // -0.01em since settings r2 SFR 6 (gauntlet w2-r1 settings item 17: body text word spacing); was -0.02em.
      expect(Math.abs(parseFloat(v.tracking) / 15 + 0.01), `${k} tracking`).toBeLessThan(0.002);
    }
    expect(b["secondary-disabled"]!.opacity).toBe("0.4");
    expect(visibleShadow(b["secondary-disabled"]!.shadow)).toBe("none");
    // hover on primary goes to pale gold
    await page.locator('[data-btn="primary"]').hover();
    await page.waitForTimeout(100);
    const hover = toHex(await page.locator('[data-btn="primary"]').evaluate((e) => getComputedStyle(e).backgroundColor));
    expect(hover).toBe("#F6D98B");
    // press: 4px right and down with the 2px shadow
    const btn = page.locator('[data-btn="primary"]');
    const bb = (await btn.boundingBox())!;
    await page.mouse.move(bb.x + 10, bb.y + 10);
    await page.mouse.down();
    await page.waitForTimeout(350);
    const pressed = await btn.evaluate((e) => ({ transform: getComputedStyle(e).transform, shadow: getComputedStyle(e).boxShadow, transition: getComputedStyle(e).transitionProperty }));
    await page.mouse.up();
    await page.waitForTimeout(350);
    const released = await btn.evaluate((e) => ({ transform: getComputedStyle(e).transform, shadow: getComputedStyle(e).boxShadow }));
    const m = pressed.transform.match(/matrix\(1, 0, 0, 1, ([\d.]+), ([\d.]+)\)/);
    expect(m, pressed.transform).not.toBeNull();
    expect(Math.abs(+m![1]! - 4)).toBeLessThan(0.05);
    expect(Math.abs(+m![2]! - 4)).toBeLessThan(0.05);
    expect(visibleShadow(pressed.shadow)).toMatch(/^rgba?\([^)]*\) 2px 2px 0px 0px$/);
    expect(pressed.transition).not.toContain("box-shadow");
    const rm = released.transform.match(/matrix\(1, 0, 0, 1, ([-\d.e]+), ([-\d.e]+)\)/);
    expect(released.transform === "none" || (rm !== null && Math.abs(+rm[1]!) < 0.05 && Math.abs(+rm[2]!) < 0.05), released.transform).toBe(true);
    out[scheme] = { styles: b, hover, pressed, released };
    await page.screenshot({ path: evidence(`screens/c19-buttons-${scheme}.png`), clip: { x: 0, y: 172, width: 1280, height: 200 } });
    await ctx.close();
  }
  // reduced motion: the shadow swaps, no movement
  const { ctx, page } = await fresh(browser, { reducedMotion: "reduce" });
  await go(page, previewUrl({ scene: "buttons" }));
  const btn = page.locator('[data-btn="primary"]');
  const bb = (await btn.boundingBox())!;
  await page.mouse.move(bb.x + 10, bb.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(200);
  out.reducedMotionPress = await btn.evaluate((e) => ({ transform: getComputedStyle(e).transform, shadow: getComputedStyle(e).boxShadow }));
  await page.mouse.up();
  expect((out.reducedMotionPress as { transform: string }).transform === "none" || (out.reducedMotionPress as { transform: string }).transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  expect((out.reducedMotionPress as { shadow: string }).shadow).toContain("2px 2px 0px 0px");
  // C21: at most one primary (gold) button per view
  const counts: Record<string, number> = {};
  for (const url of ["/", previewUrl({ scene: "buttons" }), previewUrl({ scene: "widgets" }), previewUrl({ scene: "empty" }), previewUrl({ scene: "error" }), "/no-such-room", "/integrations", "/integrations/new", previewUrl({ scene: "form" })]) {
    await go(page, url);
    counts[url] = await page.locator('[data-variant="primary"]:visible').count();
    expect(counts[url], url).toBeLessThanOrEqual(1);
  }
  out.primaryCounts = counts;
  await ctx.close();
  writeEvidence("criteria/c19-c20-c21-buttons.json", out);
});

test("C19 C38 buttons and controls are 44px on touch", async ({ page, context }, info) => {
  mobileOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, previewUrl({ scene: "buttons" }));
  const sizes = await page.locator("[data-btn], [data-switch]").evaluateAll((els) => els.map((e) => ({ k: e.getAttribute("data-btn") ?? "switch", h: e.getBoundingClientRect().height })));
  for (const s of sizes) expect(s.h, s.k).toBeGreaterThanOrEqual(44);
  writeEvidence("criteria/c19-touch-44.json", sizes);
});

test("C22 switch: 44 x 24 square track, 1px ink border, off thumb left on raised paper, on thumb right on gold, role switch with aria-checked", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, previewUrl({ scene: "buttons" }));
  const read = () => page.locator("[data-switch-row]").evaluateAll((els) => els.map((e) => {
    const t = e.querySelector("[data-switch-track]")!;
    const th = e.querySelector("[data-switch-thumb]")!;
    const tr = t.getBoundingClientRect(), hr = th.getBoundingClientRect();
    const s = getComputedStyle(t);
    return { role: e.getAttribute("role"), checked: e.getAttribute("aria-checked"), w: tr.width, h: tr.height, radius: s.borderRadius, border: `${s.borderTopWidth} ${s.borderTopColor}`, bg: s.backgroundColor, thumbSide: hr.left - tr.left < tr.right - hr.right ? "left" : "right" };
  }));
  const before = await read();
  await page.locator("[data-switch-row]").nth(1).click();
  await page.waitForTimeout(400);
  const after = await read();
  for (const s of [...before, ...after]) {
    expect(s.role).toBe("switch");
    expect(s.w).toBe(44);
    expect(s.h).toBe(24);
    expect(s.radius).toBe("0px");
    expect(s.border).toBe("1px rgb(21, 19, 15)");
    expect(s.thumbSide).toBe(s.checked === "true" ? "right" : "left");
    expect(toHex(s.bg)).toBe(s.checked === "true" ? "#E9B949" : "#FBF9F3");
  }
  expect(before[1]!.checked).toBe("false");
  expect(after[1]!.checked).toBe("true");
  await page.locator("[data-tone-sample=\"paper\"]").screenshot({ path: evidence("screens/c22-switches.png") });
  writeEvidence("criteria/c22-switch.json", { before, after });
});

test("C23 toasts are windows titled toast · <kind>, 360px on desktop", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, previewUrl({ scene: "toasts" }));
  await page.locator('[data-raise="success"]').click();
  const t = page.locator("[data-toast]").first();
  await expect(t).toBeVisible();
  await page.waitForTimeout(500);
  const r = await t.evaluate((e) => ({ title: e.querySelector("[data-window-title]")?.textContent, w: e.getBoundingClientRect().width, shadow: getComputedStyle(e).boxShadow, blur: getComputedStyle(e).backdropFilter }));
  expect(r.title).toBe("toast · success");
  expect(r.w).toBe(360);
  expect(r.blur).toBe("none");
  await page.screenshot({ path: evidence("screens/c23-toast-desktop.png") });
  writeEvidence("criteria/c23-toast.json", { shell: r, overApp: "see r3-switcher.spec.ts (C9 C10 float glass toast)" });
});

test("C33 C34 empty rooms: the sky block, the 96px lit mark with the door glow, display line, lead, Primary and Secondary", async ({ page, context, browser }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  const out: Record<string, unknown> = {};
  for (const [label, url, title, body, primary] of [
    // Round 5: the launcher at "/" is app-builder's now (Wave 2); its empty state is judged in app-builder's suite.
    ["page", previewUrl({ scene: "empty" }), "This room is waiting for light.", "Add a component to bring live data onto this page.", "Add a component"],
  ] as const) {
    await go(page, url);
    const r = await page.locator("[data-empty-room]").evaluate((e) => {
      const t = e.querySelector("[data-room-title]")!;
      const ts = getComputedStyle(t);
      const mark = e.querySelector('svg[data-mark="lit"]')!;
      return { bg: getComputedStyle(e).backgroundColor, width: e.getBoundingClientRect().width, title: t.textContent, titleSize: ts.fontSize, titleLine: ts.lineHeight, body: e.querySelector("[data-room-body]")?.textContent, markHeight: mark.getBoundingClientRect().height, doorGlow: !!mark.querySelector("[data-door-glow]"), doorAnim: getComputedStyle(mark.querySelector("[data-door-glow]")!).animationDuration, buttons: [...e.querySelectorAll("[data-variant]")].map((b) => [b.getAttribute("data-variant"), b.textContent]) };
    });
    out[label] = r;
    expect(toHex(r.bg)).toBe("#A9C8E4");
    expect(r.width).toBe(1280);
    expect(r.title).toBe(title);
    expect([r.titleSize, r.titleLine]).toEqual(["72px", "64px"]);
    expect(r.body).toBe(body);
    expect(r.markHeight).toBe(96);
    expect(r.doorGlow).toBe(true);
    expect(r.doorAnim).toBe("4.8s");
    expect(r.buttons).toEqual([["primary", primary], ["secondary", "Start from a template"]]);
    await page.screenshot({ path: evidence(`screens/c33-c34-room-${label}.png`) });
  }
  // dark: the lead sentence on the dark sky is primary text (fg-2 there is under 4.5:1)
  const { ctx: dctx, page: dp } = await fresh(browser, { colorScheme: "dark" });
  await go(dp, previewUrl({ scene: "empty" }));
  out.darkLeadColor = await dp.locator("[data-room-body]").evaluate((e) => getComputedStyle(e).color);
  expect(toHex(out.darkLeadColor as string)).toBe("#F3EFE4");
  await dctx.close();
  writeEvidence("criteria/c33-c34-rooms.json", out);
});

test("C35 C36 C37 C38 loading windows with a 1.6s shimmer; the offline ink strip; the error window; not found and Go to Apps", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  const out: Record<string, unknown> = {};
  await go(page, previewUrl({ scene: "loading" }));
  out.loading = await page.evaluate(() => {
    const w = document.querySelector("[data-skeleton]")!;
    const bar = w.querySelector("[data-skeleton-bar]")!;
    return { titleBarHeight: w.firstElementChild!.getBoundingClientRect().height, bars: w.querySelectorAll("[data-skeleton-bar]").length, barBg: getComputedStyle(bar).backgroundColor, shimmer: getComputedStyle(bar, "::after").animationDuration, frameVisible: !!document.querySelector('[data-shell="topbar"]') };
  });
  expect(out.loading).toMatchObject({ titleBarHeight: 28, shimmer: "1.6s", frameVisible: true });
  expect(toHex((out.loading as { barBg: string }).barBg)).toBe("#E9E3D3");
  await page.screenshot({ path: evidence("screens/c35-loading.png") });
  // offline
  await go(page, previewUrl({ scene: "widgets" }));
  await context.setOffline(true);
  const strip = page.locator("[data-offline-banner]");
  await expect(strip).toHaveText("You're offline. Showing the last data Atrium had.");
  const s = await strip.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color, width: e.getBoundingClientRect().width, top: e.getBoundingClientRect().top, topbarBottom: document.querySelector('[data-shell="topbar"]')!.getBoundingClientRect().bottom }));
  await page.screenshot({ path: evidence("screens/c36-offline.png") });
  await context.setOffline(false);
  await expect(strip).toHaveCount(0, { timeout: 3000 });
  out.offline = s;
  expect(toHex(s.bg)).toBe("#15130F");
  expect(s.width).toBe(1280);
  expect(s.top).toBe(s.topbarBottom);
  // error
  await go(page, previewUrl({ scene: "error" }));
  out.error = await page.locator("[data-error-window]").evaluate((e) => ({ title: e.querySelector("[data-window-title]")!.textContent, h: document.querySelector("[data-error-screen] h1")!.textContent, primary: e.querySelector('[data-variant="primary"]')!.textContent, idFont: getComputedStyle(e.querySelector("[data-error-id]")!).fontSize, id: e.querySelector("[data-error-id] code")!.textContent }));
  const er = out.error as { title: string; h: string; primary: string; idFont: string; id: string };
  expect(er.title).toBe(`error · ${er.id}`);
  expect(er.h).toBe("Something went wrong in this room");
  expect(er.primary).toBe("Try again");
  expect(er.idFont).toBe("11px");
  await page.screenshot({ path: evidence("screens/c37-error.png") });
  // not found
  const res = await go(page, "/no-such-room");
  expect(res?.status()).toBe(404);
  await expect(page.locator("[data-room-title]")).toHaveText("This room does not exist.");
  await page.screenshot({ path: evidence("screens/c38-not-found.png") });
  await page.locator("[data-go-home]").click();
  await page.waitForURL(`${ORIGIN}/`);
  out.notFound = { status: 404, goToApps: "/" };
  writeEvidence("criteria/c35-c38-system-screens.json", out);
});

test("C39 C40 C41 C42 sign-in, integrations, marks and the wordmark", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  // The real sign-in screen (auth owns its layout), signed out.
  const anon = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 800 } });
  const ap = await anon.newPage();
  await go(ap, "/sign-in");
  const sweep = await shapeSweep(ap);
  out.signInReal = {
    skyBand: await ap.locator("[data-sky-band]").count(),
    authShell: await ap.locator("[data-auth-shell]").count(),
    litMark72: await ap.locator('svg[data-mark="lit"]').evaluateAll((m) => m.filter((e) => e.getBoundingClientRect().height === 72).length),
    rounded: sweep.rounded.filter((r) => Math.max(r.w, r.h) > 40),
    blurred: sweep.blurred,
    primary: await ap.locator('[data-variant="primary"]').evaluate((e) => getComputedStyle(e).backgroundColor),
  };
  await ap.screenshot({ path: evidence("screens/c39-sign-in-real.png") });
  await anon.close();
  const sr = out.signInReal as { rounded: unknown[]; blurred: unknown[]; primary: string };
  expect(sr.rounded).toEqual([]);
  expect(sr.blurred).toEqual([]);
  expect(toHex(sr.primary)).toBe("#E9B949");
  // With auth's layout mounting AuthShell (shared file request), via the preview stand-in.
  const { ctx, page } = await fresh(browser);
  await go(page, previewUrl({ scene: "signin" }));
  out.signInWithAuthShell = await page.locator("[data-signin-preview]").evaluate((e) => ({ skyBand: !!e.querySelector("[data-sky-band]"), mark: e.querySelector('svg[data-mark="lit"]')!.getBoundingClientRect().height, glow: !!e.querySelector('svg[data-mark="lit"] [data-door-glow]'), window: !!e.querySelector("[data-window] [data-titlebar]") }));
  expect(out.signInWithAuthShell).toEqual({ skyBand: true, mark: 72, glow: true, window: true });
  await page.screenshot({ path: evidence("screens/c39-sign-in-with-authshell.png") });
  // C40 integrations: Integrations tab active, the band, square hard-shadow surfaces, no rounding or frost
  await go(page, "/integrations");
  const sw = await shapeSweep(page);
  out.integrations = {
    activeTab: await page.locator('[data-shell="tabs"] [data-tab][aria-current="page"]').getAttribute("data-tab"),
    skyBand: await page.locator("[data-sky-band]").count(),
    hardShadows: await page.evaluate(() => [...document.querySelectorAll("main [data-glass], main [data-window]")].map((e) => getComputedStyle(e).boxShadow)),
    titleBars: await page.locator("main [data-titlebar]").count(),
    rounded: sw.rounded.filter((r) => Math.max(r.w, r.h) > 40),
    blurred: sw.blurred,
  };
  const ig = out.integrations as { activeTab: string; skyBand: number; rounded: unknown[]; blurred: unknown[] };
  expect(ig.activeTab).toBe("integrations");
  expect(ig.skyBand).toBe(1);
  expect(ig.rounded).toEqual([]);
  expect(ig.blurred).toEqual([]);
  // C41: gold doorway on the top bar, sign-in and switcher marks; no outline, shadow or gradient on the bands
  await go(page, "/");
  out.marks = await page.evaluate(() => [...document.querySelectorAll('svg[data-mark="lit"]')].map((m) => ({ h: m.getBoundingClientRect().height, door: getComputedStyle(m.querySelector("[data-doorway]")!).fill, bands: [...m.querySelectorAll("path:not([data-doorway]):not([data-door-glow])")].map((p) => ({ stroke: getComputedStyle(p).stroke, filter: getComputedStyle(p).filter, fill: getComputedStyle(p).fill })), svgFilter: getComputedStyle(m).filter, shadow: getComputedStyle(m).boxShadow })));
  for (const m of out.marks as { door: string; bands: { stroke: string; filter: string; fill: string }[]; svgFilter: string }[]) {
    expect(toHex(m.door)).toBe("#E9B949");
    expect(m.svgFilter).toBe("none");
    for (const b of m.bands) {
      expect(b.stroke).toBe("none");
      expect(b.filter).toBe("none");
      expect(b.fill.startsWith("rgb")).toBe(true);
    }
  }
  // C42: the wordmark
  out.wordmark = await page.locator("[data-wordmark-text]").evaluate((e) => { const s = getComputedStyle(e); return { family: s.fontFamily, weight: s.fontWeight, tracking: parseFloat(s.letterSpacing) / parseFloat(s.fontSize), size: s.fontSize }; });
  const wm = out.wordmark as { family: string; weight: string; tracking: number };
  expect(wm.family).toMatch(/Inter Tight/);
  expect(wm.weight).toBe("600");
  expect(Math.abs(wm.tracking + 0.04)).toBeLessThan(0.002);
  await ctx.close();
  writeEvidence("criteria/c39-c42-signin-integrations-marks.json", out);
});

test("C43 favicons and app icons: gap closed, gold doorway; 192 and 512 in ink on paper and paper on ink, square", async ({ page }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const f of ["icon-192.png", "icon-512.png", "icon-dark-192.png", "icon-dark-512.png", "favicon-16.png", "favicon-32.png"]) {
    const res = await page.request.get(`/brand/${f}`);
    expect(res.status(), f).toBe(200);
    const buf = await res.body();
    const size = f.includes("512") ? 512 : f.includes("192") ? 192 : f.includes("32") ? 32 : 16;
    const pts: [number, number][] = f.startsWith("icon") ? [[2, 2], [size - 3, size - 3], [Math.round(size / 2), Math.round(size * 0.62)]] : [[Math.round(size / 2), Math.round(size * 0.72)]];
    await page.setContent("<html><body></body></html>");
    const px = (await samplePixels(page, buf, pts)).map(([r, g, b]) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase());
    out[f] = px;
  }
  const near = (a: string, b: string) => hexDelta(a, b) <= 6;
  for (const f of ["icon-192.png", "icon-512.png"]) {
    expect(near((out[f] as string[])[0]!, "#F3EFE4"), `${f} corner paper`).toBe(true);
    expect(near((out[f] as string[])[1]!, "#F3EFE4"), `${f} corner paper (square)`).toBe(true);
    expect(near((out[f] as string[])[2]!, "#E9B949"), `${f} doorway gold`).toBe(true);
  }
  for (const f of ["icon-dark-192.png", "icon-dark-512.png"]) {
    expect(near((out[f] as string[])[0]!, "#15130F"), `${f} corner ink`).toBe(true);
    expect(near((out[f] as string[])[2]!, "#E9B949"), `${f} doorway gold`).toBe(true);
  }
  writeEvidence("criteria/c43-icons.json", { samples: out, eyeCheck: "logo/favicons-and-marks-light.png, logo/favicons-and-marks-dark.png, logo/app-icons.png" });
});

test("C48 C49 contrast, computed from the rendered token values", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, Record<string, number>> = {};
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const scheme of ["light", "dark"] as const) {
    const { ctx, page } = await fresh(browser, { colorScheme: scheme });
    await go(page, previewUrl({ scene: "buttons" }));
    const t = await tokenColors(page, ["--bg", "--bg-hi", "--fg", "--fg-2", "--fg-3", "--accent-ink", "--sky-ink", "--ok", "--warn-ink", "--bad", "--accent", "--accent-fg", "--sky", "--titlebar", "--titlebar-fg", "--bad-confirm-fg", "--glass-float-fill"]);
    const c = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, parseColor(v)]));
    const on = (fg: string, bg: string) => r2(contrast(over(c[fg]!, c[bg]!), c[bg]!));
    const row: Record<string, number> = {};
    for (const k of ["--fg", "--fg-2", "--fg-3", "--accent-ink", "--sky-ink", "--ok", "--warn-ink", "--bad"]) row[`${k} on --bg`] = on(k, "--bg");
    row["--fg on --accent (gold)"] = on("--fg", "--accent");
    row["--fg-2 on --accent (gold)"] = on("--fg-2", "--accent");
    row["--fg on --sky"] = on("--fg", "--sky");
    row["--fg-2 on --sky"] = on("--fg-2", "--sky");
    row["title bar text on --titlebar"] = r2(contrast(over(c["--titlebar-fg"]!, c["--titlebar"]!), c["--titlebar"]!));
    row["--accent-fg on --accent"] = on("--accent-fg", "--accent");
    row["destructive confirm text on --bad"] = r2(contrast(c["--bad-confirm-fg"]!, c["--bad"]!));
    for (const [label, wall] of [["white", WHITE], ["black", BLACK]] as const) {
      const fill = over(c["--glass-float-fill"]!, wall);
      row[`float glass --fg over ${label}`] = r2(contrast(c["--fg"]!, fill));
      row[`float glass --fg-2 over ${label}`] = r2(contrast(c["--fg-2"]!, fill));
    }
    out[scheme] = row;
    await ctx.close();
  }
  writeEvidence("contrast/c48-c49-contrast.json", { method: "computed colours of the live tokens (getComputedStyle), WCAG 2 relative luminance; float glass composited in gamma space over pure white and black, as browsers blend", ...out });
  const L = out.light!, D = out.dark!;
  const min48 = { light: [16.2, 10.3, 6.0, 4.6, 6.3, 4.6, 4.9, 5.2], dark: [16.2, 11.1, 6.8, 11.7, 7.4, 7.9, 8.3, 6.8] };
  const keys = ["--fg", "--fg-2", "--fg-3", "--accent-ink", "--sky-ink", "--ok", "--warn-ink", "--bad"];
  keys.forEach((k, i) => {
    expect(L[`${k} on --bg`]!, `light ${k}`).toBeGreaterThanOrEqual(min48.light[i]! - 0.05);
    expect(D[`${k} on --bg`]!, `dark ${k}`).toBeGreaterThanOrEqual(min48.dark[i]! - 0.05);
  });
  expect(L["title bar text on --titlebar"]!).toBeGreaterThanOrEqual(13.2 - 0.05);
  expect(D["title bar text on --titlebar"]!).toBeGreaterThanOrEqual(9.9 - 0.05);
  expect(L["--accent-fg on --accent"]!).toBeGreaterThanOrEqual(10.2 - 0.05);
  expect(L["destructive confirm text on --bad"]!).toBeGreaterThanOrEqual(5.6 - 0.05);
  expect(D["destructive confirm text on --bad"]!).toBeGreaterThanOrEqual(6.8 - 0.05);
  expect(Math.min(L["float glass --fg over white"]!, L["float glass --fg over black"]!)).toBeGreaterThanOrEqual(12.8 - 0.05);
  expect(Math.min(L["float glass --fg-2 over white"]!, L["float glass --fg-2 over black"]!)).toBeGreaterThanOrEqual(8.2 - 0.05);
  expect(Math.min(D["float glass --fg over white"]!, D["float glass --fg over black"]!)).toBeGreaterThanOrEqual(9.9 - 0.05);
  expect(Math.min(D["float glass --fg-2 over white"]!, D["float glass --fg-2 over black"]!)).toBeGreaterThanOrEqual(6.8 - 0.05);
  for (const k of ["--fg on --accent (gold)", "--fg-2 on --accent (gold)", "--fg on --sky", "--fg-2 on --sky"]) expect(L[k]!, k).toBeGreaterThanOrEqual(4.5);
  // Dark: --fg-2 on the dark sky (#2D5A85) is under 4.5, so text on the dark sky is --fg only (the room lead).
  expect(D["--fg on --sky"]!).toBeGreaterThanOrEqual(4.5);
});

test("C50 keyboard focus shows a 2px accent-ink outline 3px outside; a mouse click shows none", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, "/integrations");
  const ring = () => page.evaluate(() => { const a = document.activeElement as HTMLElement; const s = getComputedStyle(a); return { el: a.getAttribute("data-tab") ?? a.getAttribute("aria-label") ?? a.tagName, outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`, offset: s.outlineOffset }; });
  const seen = [];
  await page.keyboard.press("Tab"); // skip link
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    seen.push(await ring());
  }
  for (const s of seen) {
    expect(s.outline, s.el).toBe("2px solid rgb(142, 100, 22)");
    expect(s.offset, s.el).toBe("3px");
  }
  await page.screenshot({ path: evidence("screens/c50-focus-ring.png"), clip: { x: 0, y: 0, width: 1280, height: 70 } });
  await page.locator('[data-shell="tabs"] [data-tab="apps"]').hover();
  await page.mouse.down();
  const click = await ring();
  await page.mouse.up();
  expect(click.outline.startsWith("0px") || click.outline.includes("none")).toBe(true);
  writeEvidence("criteria/c50-focus.json", { keyboard: seen, mouse: click, switcher: "see r3-switcher.spec.ts C47" });
});
