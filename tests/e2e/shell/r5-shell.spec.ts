// app-shell round 5 (Wave 2 touch-ups, approved 2026-10-18):
//   3. every top bar tab stop is at least 44px tall on desktop; the 32px boxes of design v4 stay.
//   4. every account and settings link points at /settings/...; one name, "Users and security"; the
//      band crumbs on /settings/users and /settings/security read settings / users and security.
//   5. the band grain is toned down: compared with the landing page's sky from its saved capture
//      (evidence/gauntlet/r3/premium-feel/landing-light.png; the live landing on :3132 is not touched).
// Run: ATRIUM_SHELL_ROUND=r5 ATRIUM_E2E_SLOT=app-shell ATRIUM_E2E_PORT=3112 pnpm exec playwright test tests/e2e/shell/r5-shell.spec.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { evidence, fresh, go, writeEvidence } from "./helpers";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop project");
const LANDING_PNG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evidence/gauntlet/r3/premium-feel/landing-light.png");

test("3: every top bar tab stop is at least 44px tall at 1440, 1280, 1000 and 800; tab boxes stay 32px from 900px up", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const out: Record<string, unknown> = {};
  for (const width of [1440, 1280, 1000, 800]) {
    const { ctx, page } = await fresh(browser, { viewport: { width, height: 800 } });
    await go(page, "/integrations");
    // Walk the keyboard from the skip link through the top bar.
    await page.locator("body").focus();
    const stops: { el: string; w: number; h: number; inBar: boolean; outline: string }[] = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const s = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const r = a.getBoundingClientRect();
        const cs = getComputedStyle(a);
        return { el: a.getAttribute("data-tab") ?? a.getAttribute("aria-label") ?? a.textContent?.trim().slice(0, 20) ?? a.tagName, w: Math.round(r.width), h: Math.round(r.height), inBar: !!a.closest('[data-shell="topbar"]'), outline: `${cs.outlineWidth} ${cs.outlineStyle}` };
      });
      if (s.inBar) stops.push(s);
    }
    const boxes = await page.locator('[data-shell="tabs"] [data-tab-box]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    out[width] = { stops, boxes };
    expect(stops.length, `${width}: tab stops in the top bar`).toBeGreaterThanOrEqual(width >= 640 ? 9 : 3);
    for (const s of stops) {
      expect(s.h, `${width}: ${s.el} height`).toBeGreaterThanOrEqual(44);
      expect(Math.min(s.w, s.h), `${width}: ${s.el} size`).toBeGreaterThanOrEqual(44);
      expect(s.outline, `${width}: ${s.el} ring`).toBe("2px solid");
    }
    for (const h of boxes) expect(h).toBe(width >= 900 ? 32 : 44);
    if (width === 1280) {
      await page.keyboard.press("Shift+Tab");
      await page.screenshot({ path: evidence("screens/r5-topbar-focus-1280.png"), clip: { x: 0, y: 0, width: 1280, height: 64 } });
    }
    await ctx.close();
  }
  writeEvidence("criteria/r5-topbar-44.json", out);
});

test("4: the account menu says Users and security and opens /settings/security; Settings opens /settings", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser);
  await go(page, "/integrations");
  await expect(page.locator('[data-shell="tabs"] [data-tab="settings"]')).toHaveAttribute("href", "/settings");
  await page.locator("[data-account-trigger]").click();
  const link = page.locator("[data-account-link]");
  await expect(link).toHaveText("Users and security");
  await expect(link).toHaveAttribute("href", "/settings/security");
  await page.screenshot({ path: evidence("screens/r5-account-menu.png"), clip: { x: 880, y: 0, width: 400, height: 360 } });
  const all = await page.locator('a[href^="/account"]').count();
  expect(all, "links to /account anywhere in the shell").toBe(0);
  await ctx.close();
});

test("4: the palette fallback has one Users and security row (found by 2fa, allowlist, authenticator or sessions) and a Settings row", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser);
  await go(page, "/integrations");
  await page.keyboard.press("Control+k");
  const sheet = page.locator('[data-sheet="palette-fallback"]');
  await expect(sheet).toBeVisible();
  const input = sheet.getByRole("combobox").or(sheet.locator("input")).first();
  for (const q of ["2fa", "allowlist", "authenticator", "sessions"]) {
    await input.fill(q);
    await expect(sheet.getByRole("option")).toHaveText(["Users and security"]);
  }
  await input.fill("settings");
  await expect(sheet.getByRole("option").first()).toHaveText("Settings");
  await input.fill("users");
  await page.screenshot({ path: evidence("screens/r5-palette-users-and-security.png") });
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => u.pathname === "/settings/security");
  await ctx.close();
});

// Settings r2 (gauntlet w2-r1 item 14): the crumb now matches the active tab.
test("4: crumbs on /settings/users and /settings/security read <instance> / settings / <tab>", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser);
  const out: Record<string, string[]> = {};
  for (const p of ["/settings/users", "/settings/security"]) {
    await go(page, p);
    // The tab crumb comes from the page title, which the settings header sets after hydration: poll for it.
    const read = async () => (await page.locator("[data-crumb-list] li").allInnerTexts()).map((t) => t.replace(/\//g, "").trim()).filter(Boolean);
    await expect.poll(async () => (await read()).slice(1), { timeout: 5_000 }).toEqual(["settings", p.endsWith("users") ? "Users" : "Security"]);
    out[p] = await read();
    await expect(page.locator("[data-crumb-list] a", { hasText: "settings" })).toHaveAttribute("href", "/settings");
    await page.locator("[data-sky-band]").screenshot({ path: evidence(`screens/r5-crumb-${p.split("/").pop()}.png`) });
  }
  writeEvidence("criteria/r5-crumbs.json", out);
  await ctx.close();
});

// ---- 5: grain ----------------------------------------------------------------------------------

/** High-pass luminance std (pixel minus its 5x5 box mean) and the largest horizontal autocorrelation
 *  of that signal at offsets 3 to 599px, computed in the page from a PNG. */
async function grain(page: Page, png: Buffer, clip: { x: number; y: number; w: number; h: number }, maxOffset = 600) {
  return page.evaluate(
    async ({ b64, clip, maxOffset }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = clip.w;
      c.height = clip.h;
      const g = c.getContext("2d")!;
      g.drawImage(img, clip.x, clip.y, clip.w, clip.h, 0, 0, clip.w, clip.h);
      const d = g.getImageData(0, 0, clip.w, clip.h).data;
      const W = clip.w, H = clip.h;
      const L = new Float64Array(W * H);
      for (let i = 0; i < W * H; i++) L[i] = 0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!;
      const hp = new Float64Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let s = 0, n = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx)); s += L[yy * W + xx]!; n++; }
          hp[y * W + x] = L[y * W + x]! - s / n;
        }
      let m = 0;
      for (const v of hp) m += v;
      m /= hp.length;
      let v2 = 0;
      for (const v of hp) v2 += (v - m) ** 2;
      v2 /= hp.length;
      let best = 0, at = 0;
      for (let o = 3; o < Math.min(maxOffset, W - 50); o++) {
        let s = 0, n = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x + o < W; x++) { s += (hp[y * W + x]! - m) * (hp[y * W + x + o]! - m); n++; }
        const r = s / n / v2;
        if (r > best) { best = r; at = o; }
      }
      return { std: +Math.sqrt(v2).toFixed(2), maxAutocorr: +best.toFixed(2), at };
    },
    { b64: png.toString("base64"), clip, maxOffset },
  );
}

test("5: band grain within 20% of the landing sky's (saved capture), no repeat above 0.3 under 600px, light and dark", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(180_000);
  const landing = readFileSync(LANDING_PNG);
  const out: Record<string, unknown> = {};
  let land: Awaited<ReturnType<typeof grain>> | null = null;
  for (const mode of ["light", "dark"] as const) {
    const { ctx, page } = await fresh(browser, { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" }, { theme: mode });
    await go(page, "/integrations");
    const band = (await page.locator("[data-sky-band]").boundingBox())!;
    expect(await page.locator("[data-sky-band]").getAttribute("data-sky-band")).toBe("static");
    // Hide the mark and crumb so only the sky is measured.
    await page.addStyleTag({ content: "[data-sky-band] > :not([data-sky-speckle]) { visibility: hidden !important; }" });
    const png = await page.screenshot({ clip: { x: 0, y: band.y + 8, width: 1440, height: 104 }, path: evidence(`grain/r5-band-${mode}-1x.png`) });
    const calc = await ctx.newPage();
    const blue = await grain(calc, png, { x: 10, y: 0, w: 390, h: 104 });
    const full = await grain(calc, png, { x: 0, y: 0, w: 1440, h: 104 });
    land ??= await grain(calc, landing, { x: 870, y: 290, w: 240, h: 110 });
    out[mode] = { blueRegion: blue, wholeBand: full, landingBlueRegion: land, ratio: +(blue.std / land.std).toFixed(2) };
    expect(blue.std / land.std, `${mode} blue-region grain vs the landing's`).toBeGreaterThanOrEqual(0.8);
    expect(blue.std / land.std, `${mode} blue-region grain vs the landing's`).toBeLessThanOrEqual(1.2);
    expect(full.maxAutocorr, `${mode}: largest autocorrelation under 600px (at ${full.at}px)`).toBeLessThanOrEqual(0.3);
    await ctx.close();
  }
  writeEvidence("criteria/r5-grain.json", { method: "luminance minus its 5x5 box mean; std, and the largest horizontal autocorrelation at offsets 3 to 599px; landing from the saved r3 capture, blue region x 870 to 1110, y 290 to 400", ...out });
});
