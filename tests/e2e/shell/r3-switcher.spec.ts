// app-shell round 3: the app switcher and the other surfaces drawn over a viewed app (spec v2
// criteria 2, 9, 10, 23, 44 to 47), on the preview's app scene (app-builder's /a/<slug> viewer is
// Wave 2). Also the shell's invariance to themes and app CSS (criterion 2) on the canvas-in-shell scene.
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { emulateReducedTransparency, evidence, fresh, go, hex, markSwept, ORIGIN, parseColor, previewUrl, signIn, writeEvidence } from "./helpers";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop project");
const mobileOnly = (name: string) => test.skip(name !== "mobile", "mobile project");
const toHex = (s: string) => hex(parseColor(s));

/** Reads the switcher from inside its shadow root. */
async function switcher(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector("atrium-switcher") as HTMLElement | null;
    if (!host || !host.shadowRoot) return null;
    const sr = host.shadowRoot;
    const btn = sr.querySelector<HTMLElement>("[data-switcher-button]")!;
    const face = btn.querySelector<HTMLElement>(".face")!;
    const fs = getComputedStyle(face);
    const mark = btn.querySelector("svg")!;
    const sheet = sr.querySelector<HTMLElement>("[data-switcher-sheet]");
    const b = btn.getBoundingClientRect(), f = face.getBoundingClientRect();
    return {
      inTopLayer: host.matches(":popover-open"),
      hostParent: host.parentElement?.tagName,
      button: { x: b.x, y: b.y, w: b.width, h: b.height, fromBottom: innerHeight - b.bottom },
      face: { w: f.width, h: f.height, bg: fs.backgroundColor, blur: fs.backdropFilter, border: `${fs.borderTopWidth} ${fs.borderTopColor}`, shadow: fs.boxShadow, radius: fs.borderRadius },
      mark: { h: mark.getBoundingClientRect().height, door: mark.querySelector("[data-doorway]")!.getAttribute("fill") },
      expanded: btn.getAttribute("aria-expanded"),
      sheet: sheet ? { rows: [...sheet.querySelectorAll("[data-switcher-item]")].map((a) => [a.getAttribute("data-switcher-item"), a.childNodes[0]?.textContent, a.getAttribute("href")]), bg: getComputedStyle(sheet).backgroundColor, blur: getComputedStyle(sheet).backdropFilter, shadow: getComputedStyle(sheet).boxShadow, rect: sheet.getBoundingClientRect().toJSON(), opacity: getComputedStyle(sheet).opacity } : null,
      hit: (() => { const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return el === host ? "switcher" : el?.tagName.toLowerCase(); })(),
    };
  });
}

test("C44 C45 the switcher: a 36px square on floating glass at the bottom left with the 18px lit mark; its sheet lists the other apps, Edit this app and Back to Atrium", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, previewUrl({ scene: "app", theme: "controlRoom" }));
  await expect(page.locator("atrium-switcher")).toHaveCount(1);
  const s = (await switcher(page))!;
  expect(s.inTopLayer).toBe(true);
  expect(s.hostParent).toBe("BODY");
  expect(s.face.w).toBe(36);
  expect(s.face.h).toBe(36);
  expect(s.face.radius).toBe("0px");
  expect(s.face.blur).toContain("blur(18px)");
  expect(s.face.border).toBe("1px rgb(21, 19, 15)");
  expect(s.mark.h).toBe(18);
  expect(s.mark.door).toBe("#E9B949");
  expect(s.button.x).toBeLessThanOrEqual(12);
  expect(s.button.fromBottom).toBeLessThanOrEqual(12);
  expect(s.hit).toBe("switcher");
  await page.screenshot({ path: evidence("switcher/c44-closed.png") });
  await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
  await page.waitForTimeout(500);
  const o = (await switcher(page))!;
  expect(o.expanded).toBe("true");
  expect(o.sheet!.rows).toEqual([["app", "Family", "/a/family"], ["app", "Guest room", "/a/guest-room"], ["edit", "Edit this app", "/build/homelab"], ["home", "Back to Atrium", "/"]]);
  expect(o.sheet!.blur).toContain("blur(18px)");
  expect(o.sheet!.shadow).toContain("0px 24px 64px");
  await page.screenshot({ path: evidence("switcher/c45-sheet-open.png") });
  // no "Edit this app" for a user who cannot edit
  await go(page, previewUrl({ scene: "app", edit: 0 }));
  await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
  await page.waitForTimeout(400);
  const viewer = (await switcher(page))!;
  expect(viewer.sheet!.rows.map((r) => r[0])).toEqual(["app", "app", "home"]);
  // choosing each row goes to that place
  const dest: Record<string, string> = {};
  for (const [kind, want] of [["home", "/"], ["edit", "/build/homelab"], ["app", "/a/family"]] as const) {
    await go(page, previewUrl({ scene: "app" }));
    await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
    await page.waitForTimeout(300);
    await page.locator("atrium-switcher").locator(`[data-switcher-item="${kind}"]`).first().click();
    await page.waitForURL((u) => u.pathname === want, { timeout: 8000 });
    dest[kind] = new URL(page.url()).pathname;
  }
  // a guest gets no switcher; no shell screen shows one
  await go(page, previewUrl({ scene: "app", viewer: "guest" }));
  const guest = await page.locator("atrium-switcher").count();
  const shellScreens: Record<string, number> = {};
  for (const url of ["/", "/integrations", previewUrl({ scene: "widgets" })]) {
    await go(page, url);
    shellScreens[url] = await page.locator("atrium-switcher").count();
    expect(shellScreens[url], url).toBe(0);
  }
  expect(guest).toBe(0);
  writeEvidence("switcher/c44-c45-switcher.json", { closed: s, open: o.sheet, viewerWithoutEdit: viewer.sheet!.rows, destinations: dest, guestSwitchers: guest, shellScreens, hooksUnregistered: "with the Wave 1 hooks unregistered the server slot gives only Back to Atrium (unit test r3.test.ts)" });
});

test("C46 an app whose CSS hides, reddens, zeroes and stacks every element still shows the switcher and its sheet unchanged and operable", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, previewUrl({ scene: "app" }));
  const base = (await switcher(page))!;
  await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
  await page.waitForTimeout(500);
  const baseOpen = (await switcher(page))!;
  const baseClip = await page.screenshot({ clip: { x: 0, y: 400, width: 340, height: 400 } });
  // 1. The hostile theme, chrome and component CSS through the real path (the server-side scoper).
  await go(page, previewUrl({ scene: "app", css: "hostile" }));
  const scoped = (await switcher(page))!;
  await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
  await page.waitForTimeout(500);
  const scopedOpen = (await switcher(page))!;
  await page.screenshot({ path: evidence("switcher/c46-hostile-scoped.png") });
  // 2. Worse than possible: the same rules injected raw into the document, unscoped and !important.
  await go(page, previewUrl({ scene: "app" }));
  await page.addStyleTag({
    content: `* { visibility: hidden !important; color: red !important; background: red !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; opacity: 0 !important; transform: scale(0) !important; filter: blur(20px) !important; position: fixed !important; inset: 0 !important; clip-path: inset(50%) !important; }
      atrium-switcher, [data-atrium-switcher], :popover-open { display: none !important; }
      [data-atrium-canvas] { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; }
      html, body { visibility: visible !important; width: auto !important; height: auto !important; opacity: 1 !important; transform: none !important; filter: none !important; clip-path: none !important; position: static !important; }`,
  });
  await page.waitForTimeout(300);
  const raw = (await switcher(page))!;
  await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
  await page.waitForTimeout(500);
  const rawOpen = (await switcher(page))!;
  const rawClip = await page.screenshot({ clip: { x: 0, y: 400, width: 340, height: 400 } });
  await page.screenshot({ path: evidence("switcher/c46-hostile-raw-unscoped.png") });
  for (const [label, closed, open] of [["scoped", scoped, scopedOpen], ["raw", raw, rawOpen]] as const) {
    expect(closed.hit, `${label}: switcher on top at its centre`).toBe("switcher");
    expect(closed.button, `${label}: position`).toEqual(base.button);
    expect(closed.face, `${label}: look`).toEqual(base.face);
    expect(open.sheet!.rows, `${label}: sheet rows`).toEqual(baseOpen.sheet!.rows);
    expect(open.sheet!.rect, `${label}: sheet position`).toEqual(baseOpen.sheet!.rect);
    expect(open.sheet!.opacity, `${label}: sheet visible`).toBe("1");
  }
  // operable: Back to Atrium still navigates
  await page.locator("atrium-switcher").locator('[data-switcher-item="home"]').click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 8000 });
  writeEvidence("switcher/c46-hostile.json", {
    hostileCss: "preview-css.ts `hostile` (through scopeCustomCss) and a raw unscoped !important sheet hitting every element",
    baseline: { closed: base, open: baseOpen.sheet },
    scoped: { closed: scoped, open: scopedOpen.sheet },
    rawUnscoped: { closed: raw, open: rawOpen.sheet },
    rawPixelsEqualBaseline: rawClip.equals(baseClip),
    note: "The raw sheet also repaints the app behind the translucent glass, so pixels may differ through the blur; geometry, computed styles and hit-testing are identical.",
    operable: "Back to Atrium navigated to /",
  });
});

test("C47 keyboard: Tab reaches the switcher, Enter and Space open it, Esc closes and returns focus; focus ring on button and rows", async ({ page, context }, info) => {
  desktopOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, previewUrl({ scene: "app" }));
  const focusIsButton = () => page.evaluate(() => { const h = document.querySelector("atrium-switcher")!; return document.activeElement === h && Boolean(h.shadowRoot!.activeElement?.hasAttribute("data-switcher-button")); });
  let reached = false;
  for (let i = 0; i < 20 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await focusIsButton();
  }
  expect(reached).toBe(true);
  const ring = await page.evaluate(() => { const f = document.querySelector("atrium-switcher")!.shadowRoot!.querySelector(".face")!; const s = getComputedStyle(f); return `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor} ${s.outlineOffset}`; });
  expect(ring).toBe("2px solid rgb(142, 100, 22) 3px");
  await page.screenshot({ path: evidence("switcher/c47-focus.png"), clip: { x: 0, y: 700, width: 200, height: 100 } });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const openFocus = await page.evaluate(() => document.querySelector("atrium-switcher")!.shadowRoot!.activeElement?.getAttribute("data-switcher-item"));
  expect(openFocus).toBe("app");
  const rowRing = await page.evaluate(() => { const a = document.querySelector("atrium-switcher")!.shadowRoot!.activeElement!; const s = getComputedStyle(a); return `${s.outlineWidth} ${s.outlineStyle}`; });
  expect(rowRing).toBe("2px solid");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  expect((await switcher(page))!.sheet).toBeNull();
  expect(await focusIsButton()).toBe(true);
  await page.keyboard.press(" ");
  await page.waitForTimeout(400);
  expect((await switcher(page))!.sheet).not.toBeNull();
  await page.keyboard.press("Escape");
  writeEvidence("switcher/c47-keyboard.json", { tabReachesSwitcher: true, ring, enterOpensAndFocusesFirstRow: openFocus, rowRing, escClosesAndReturnsFocus: true, spaceOpens: true });
});

test("C47 the switcher's hit area is at least 44 x 44 on touch", async ({ page, context }, info) => {
  mobileOnly(info.project.name);
  await signIn(page);
  await markSwept(context, ORIGIN);
  await go(page, previewUrl({ scene: "app" }));
  const s = (await switcher(page))!;
  expect(s.button.w).toBeGreaterThanOrEqual(44);
  expect(s.button.h).toBeGreaterThanOrEqual(44);
  await page.locator("atrium-switcher").locator("[data-switcher-button]").tap();
  await page.waitForTimeout(500);
  const rows = await page.evaluate(() => [...document.querySelector("atrium-switcher")!.shadowRoot!.querySelectorAll("[data-switcher-item]")].map((a) => a.getBoundingClientRect().height));
  for (const h of rows) expect(h).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: evidence("switcher/c47-phone-sheet-390.png") });
  writeEvidence("switcher/c47-touch.json", { button: s.button, rowHeights: rows });
});

test("C9 C10 C23 floating glass only over apps: switcher, sheet, draft bar, confirm and toasts; opaque with reduce transparency (system, switch)", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const [label, prefs, system] of [["normal", {}, false], ["switch", { transparency: true }, false], ["system", {}, true]] as const) {
    for (const scheme of ["light", "dark"] as const) {
      const { ctx, page } = await fresh(browser, { colorScheme: scheme }, prefs);
      if (system) await emulateReducedTransparency(page);
      await go(page, previewUrl({ scene: "app", draft: 1 }));
      await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
      await page.mouse.move(700, 300); // off the button: its hover state is opaque paper
      await page.waitForTimeout(400);
      const sw = (await switcher(page))!;
      await page.keyboard.press("Escape");
      await page.locator("[data-open-confirm]").click();
      await page.waitForTimeout(300);
      const dialog = await page.locator("dialog[open][data-control-confirm] [data-window]").evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, blur: getComputedStyle(e).backdropFilter, topLayer: (e.closest("dialog") as HTMLDialogElement).matches(":modal"), shadow: getComputedStyle(e).boxShadow }));
      await page.locator("dialog[open] [data-confirm-run]").click();
      const toast = page.locator("[data-toast]").first();
      await expect(toast).toBeVisible();
      await page.waitForTimeout(400);
      const t = await toast.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, blur: getComputedStyle(e).backdropFilter }));
      const bar = await page.locator("[data-draft-preview-bar]").evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, blur: getComputedStyle(e).backdropFilter, h: e.getBoundingClientRect().height, text: e.textContent }));
      if (label === "normal") await page.screenshot({ path: evidence(`switcher/c9-float-glass-${scheme}.png`) });
      else await page.screenshot({ path: evidence(`switcher/c10-opaque-${label}-${scheme}.png`) });
      const fill = scheme === "light" ? "rgba(251, 249, 243, 0.86)" : "rgba(29, 26, 21, 0.86)";
      const opaque = scheme === "light" ? "#FBF9F3" : "#1D1A15";
      for (const [what, v] of [["switcher", sw.face], ["sheet", sw.sheet!], ["dialog", dialog], ["toast", t], ["draft bar", bar]] as const) {
        if (label === "normal") {
          expect((v as { bg: string }).bg, `${scheme} ${what} fill`).toBe(fill);
          expect((v as { blur: string }).blur, `${scheme} ${what} blur`).toContain("blur(18px)");
        } else {
          expect(toHex((v as { bg: string }).bg), `${label} ${scheme} ${what} opaque`).toBe(opaque);
          expect(parseColor((v as { bg: string }).bg).a, `${label} ${scheme} ${what} alpha`).toBe(1);
        }
      }
      expect(dialog.topLayer).toBe(true);
      expect(bar.h).toBe(36);
      expect(bar.text).toContain("Draft preview · rev 42 · controls here are real");
      out[`${label}-${scheme}`] = { switcher: sw.face, sheet: { bg: sw.sheet!.bg, blur: sw.sheet!.blur }, dialog, toast: t, draftBar: bar };
      await ctx.close();
    }
  }
  writeEvidence("switcher/c9-c10-c23-float-glass.json", { ...out, noBlurSupport: "the @supports not (backdrop-filter) fallback rules are in globals.css (.glass-float) and the switcher's own sheet; Chromium supports blur, so that path is checked by rule, as in r1 and r2" });
});

test("C2 Control Room, Dusk, Solid, Daylight and app CSS leave the top bar, sky band, toasts, sheets and switcher unchanged", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  // Reduced motion freezes the clock's live dot, so pixel hashes compare only what themes could change.
  const { ctx, page } = await fresh(browser, { reducedMotion: "reduce" });
  const shell: Record<string, string> = {};
  const styles: Record<string, unknown> = {};
  const cases: [string, Parameters<typeof previewUrl>[0]][] = [["controlRoom", { scene: "canvas", theme: "controlRoom" }], ["dusk", { scene: "canvas", theme: "dusk" }], ["solid", { scene: "canvas", theme: "solid" }], ["daylight", { scene: "canvas", theme: "daylight" }], ["css-all", { scene: "canvas", css: "all" }], ["css-hostile", { scene: "canvas", css: "hostile" }]];
  for (const [label, opts] of cases) {
    await go(page, previewUrl(opts));
    await expect(page.locator('[data-shell="topbar"] [data-account-trigger]')).toHaveText("T"); // the preview's user has applied
    // the avatar letter is user data, not theme-reachable; it is masked (its glyph raster varies by a few pixels run to run)
    const top = await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 52 + 120 }, mask: [page.locator('[data-shell="topbar"] [data-account-trigger]'), page.locator('[data-clock]')], path: evidence(`screens/c2-top-${label}.png`) });
    shell[label] = top.toString("base64").length + ":" + (await import("node:crypto")).createHash("sha256").update(top).digest("hex").slice(0, 16);
    await page.locator("[data-test-connection]").dispatchEvent("click");
    await page.waitForTimeout(500);
    const toast = await page.locator("[data-toast]").first().evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, border: s.borderTopColor, shadow: s.boxShadow, font: s.fontFamily, w: e.getBoundingClientRect().width }; });
    await page.evaluate(() => (document.querySelector("[data-toast] button[aria-label^='Dismiss']") as HTMLButtonElement | null)?.click());
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(500);
    const sheet = await page.locator("[data-sheet]").evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, border: s.borderLeftColor, shadow: s.boxShadow, font: s.fontFamily, w: e.getBoundingClientRect().width }; });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    styles[label] = { toast, sheet };
    if (label !== "controlRoom") await page.screenshot({ path: evidence(`screens/c2-canvas-in-shell-${label}.png`) });
  }
  const app: Record<string, unknown> = {};
  for (const theme of ["controlRoom", "dusk", "solid", "daylight"] as const) {
    // the switcher over each theme, with reduce transparency so its pixels are comparable
    const c2 = await fresh(browser, { reducedMotion: "reduce" }, { transparency: true });
    await go(c2.page, previewUrl({ scene: "app", theme }));
    const sw = (await switcher(c2.page))!;
    // the 36px face itself (the 4px of hit area around it is transparent and shows the app)
    const px = await c2.page.screenshot({ clip: { x: sw.button.x + 4, y: sw.button.y + 4, width: 36, height: 36 }, path: evidence(`switcher/c2-face-over-${theme}.png`) });
    app[theme] = { switcher: sw.face, pixels: (await import("node:crypto")).createHash("sha256").update(px).digest("hex").slice(0, 16) };
    await c2.ctx.close();
  }
  writeEvidence("criteria/c2-theme-invariance.json", { topBarAndSkyBandPixels: shell, toastAndSheetStyles: styles, switcherOverApps: app });
  expect(new Set(Object.values(shell)).size, "top bar and sky band pixels identical").toBe(1);
  expect(new Set(Object.values(styles).map((v) => JSON.stringify(v))).size, "toast and sheet styles identical").toBe(1);
  expect(new Set(Object.values(app).map((v) => JSON.stringify(v))).size, "switcher identical over every theme").toBe(1);
  await ctx.close();
});
