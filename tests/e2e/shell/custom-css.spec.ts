// app-shell (r2 Fix List item 8, kept in r3 on the design v4 frame): the three custom CSS escapes from
// gauntlet r1 replayed against a page that holds both the shell and an app canvas. The CSS goes through
// scopeCustomCss() on the server (preview route, named samples only) and the shell must stay
// unchanged and reachable. v4 has no sidebar: the top bar and sky band are probed instead.
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { go, evidence, markSwept, ORIGIN, previewUrl, signIn, writeEvidence } from "./helpers";

test.beforeEach(async ({ page, context }) => {
  await signIn(page);
  await markSwept(context, ORIGIN);
});

const ESCAPES = {
  e1: ":root{--glass-thin-fill:oklch(0.6 0.25 25);--bg:oklch(0.6 0.25 25)}",
  e2: 'html:has([data-atrium-canvas]) [data-shell="topbar"]{display:none}',
  e3: "[data-atrium-canvas]{position:fixed;inset:0;z-index:9999}",
} as const;

/** Which shell part is hit at each point, plus the top bar's look. */
async function probe(page: Page, phone: boolean) {
  return page.evaluate((phone) => {
    const hit = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      const shell = el?.closest("[data-shell], [data-toast], [data-sheet]");
      return shell ? (shell.getAttribute("data-shell") ?? (shell.hasAttribute("data-toast") ? "toast" : `sheet:${shell.getAttribute("data-sheet")}`)) : `canvas-or-other:${el?.tagName.toLowerCase()}`;
    };
    const tb = document.querySelector('[data-shell="topbar"]');
    const cs = tb ? getComputedStyle(tb) : null;
    const canvas = document.querySelector("[data-atrium-canvas]")!;
    const cc = getComputedStyle(canvas);
    const w = innerWidth;
    return {
      topbarLook: { display: cs?.display, bg: cs?.backgroundColor },
      topbar: hit(phone ? 200 : 1265, 26),
      skyband: hit(phone ? 300 : 900, phone ? 90 : 110),
      tabbar: phone ? hit(w / 2, innerHeight - 30) : null,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      canvasRoot: { position: cc.position, zIndex: cc.zIndex, contain: cc.contain, isolation: cc.isolation, transform: cc.transform, top: canvas.getBoundingClientRect().top },
      customCss: document.querySelector("style[data-custom-css]")?.textContent ?? null,
    };
  }, phone);
}

async function overlays(page: Page) {
  // a toast (bottom right on desktop, top on phones) and a sheet must be on top and reachable
  // dispatched, not clicked: in the "all" sample a widget is styled to cover the canvas (canvas-only damage)
  await page.locator("[data-test-connection]").dispatchEvent("click");
  const t = page.locator("[data-toast]").first();
  await expect(t).toBeVisible();
  await page.waitForTimeout(450);
  const tb = (await t.boundingBox())!;
  const toastHit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest("[data-toast]"), [tb.x + tb.width / 2, tb.y + tb.height / 2]);
  await page.evaluate(() => (document.querySelector("[data-toast] button[aria-label^='Dismiss']") as HTMLButtonElement | null)?.click());
  await page.keyboard.press("Control+k");
  const sheet = page.locator('[data-sheet="palette-fallback"]');
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(450);
  const sb = (await sheet.boundingBox())!;
  const sheetHit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest("[data-sheet]"), [sb.x + sb.width / 2, sb.y + sb.height / 2]);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  return { toastHit, sheetHit };
}

for (const project of ["desktop", "mobile"] as const) {
  test(`custom CSS escapes E1 to E3 cannot reach the shell (${project})`, async ({ page }, info) => {
    test.skip(info.project.name !== project, `${project} project`);
    const phone = project === "mobile";
    const report: Record<string, unknown> = {};

    // Baseline: no custom CSS.
    await go(page, previewUrl({ scene: "canvas" }));
    const base = await probe(page, phone);
    report.baseline = base;

    // Control: the same rules injected raw (unscoped, unlayered), to show what the scoper prevents.
    // E1 and E2 break the shell when nothing parses them; E3 is pinned by the guard layer even raw.
    const control: Record<string, unknown> = {};
    for (const [name, css] of Object.entries(ESCAPES)) {
      await go(page, previewUrl({ scene: "canvas" }));
      await page.addStyleTag({ content: css });
      await page.waitForTimeout(150);
      control[name] = await probe(page, phone);
    }
    report.controlRawInjection = control;
    expect((control.e1 as typeof base).topbarLook.bg, "raw E1 repaints the top bar (control)").not.toBe(base.topbarLook.bg);
    expect((control.e2 as typeof base).topbarLook.display, "raw E2 hides the top bar (control)").toBe("none");
    expect((control.e3 as typeof base).canvasRoot.position, "the guard pins the canvas even for raw CSS").toBe("relative");

    // Through the server-side scoper (the real path): every escape fails safely.
    for (const name of ["e1", "e2", "e3", "all"] as const) {
      await go(page, previewUrl({ scene: "canvas", css: name }));
      await page.waitForTimeout(150);
      const r = await probe(page, phone);
      const o = await overlays(page);
      report[`scoped-${name}`] = { ...r, ...o };
      await page.screenshot({ path: evidence(`custom-css/${project}-scoped-${name}.png`) });
      if (phone) expect(r.tabbar, `${name}: bottom bar reachable`).toBe("tabbar");
      expect(r.topbarLook, `${name}: top bar look`).toEqual(base.topbarLook);
      expect(r.topbar, `${name}: top bar reachable`).toBe("topbar");
      expect(r.skyband, `${name}: sky band reachable`).toBe("skyband");
      expect(r.htmlBg, `${name}: page background`).toBe(base.htmlBg);
      expect(r.canvasRoot, `${name}: canvas root pinned`).toEqual(base.canvasRoot);
      expect(o, `${name}: toast and sheet on top`).toEqual({ toastHit: true, sheetHit: true });
      expect(r.customCss ?? "", `${name}: no :root, html, body or :has() survived`).not.toMatch(/:root|html|(^|[\s,}])body|:has\(/);
    }
    // E1 and E2 are removed entirely; round 4: E3 is removed too (position fixed and the root's
    // position, inset and z-index are dropped by the scoper, Fixes 1 and 13).
    expect((report["scoped-e1"] as { customCss: string | null }).customCss).toBeNull();
    expect((report["scoped-e2"] as { customCss: string | null }).customCss).toBeNull();
    expect((report["scoped-e3"] as { customCss: string | null }).customCss).toBeNull();
    writeEvidence(`custom-css/escapes-${project}.json`, report);
  });
}
