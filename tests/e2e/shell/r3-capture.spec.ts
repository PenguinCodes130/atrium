// app-shell round 3 evidence (re-run in round 4: helpers.ts now writes to evidence/app-shell/r4): V4 screenshots (shell screens in light, dark and light with reduce
// transparency; viewed app with the switcher in Control Room, Dusk and Solid), V5 phone, V6
// recordings, V7 frame timing (measured, not judged on this GPU-less host), V10 network responses.
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { renameSync } from "node:fs";
import { emulateReducedTransparency, evidence, fresh, go, markSwept, ORIGIN, previewUrl, setPrefCookies, signIn, writeEvidence } from "./helpers";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop project");

const SHELL_SCREENS: [string, string][] = [
  ["apps-interim-home", "/"],
  ["integrations", "/integrations"],
  ["integrations-add", "/integrations/new"],
  ["integrations-credentials", "/integrations/credentials"],
  ["settings-coming", "/settings"],
  ["glow-grid", previewUrl({ scene: "glow" })],
  ["windows", previewUrl({ scene: "widgets", approvals: 3 })],
  ["components", previewUrl({ scene: "buttons" })],
  ["loading", previewUrl({ scene: "loading" })],
  ["error", previewUrl({ scene: "error" })],
  ["not-found", "/this-room-is-missing"],
  ["sign-in-with-authshell", previewUrl({ scene: "signin" })],
];

test("V4 shell screens in light, dark and light with reduce transparency; sign-in as auth renders it today", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(240_000);
  for (const [label, scheme, rt] of [["light", "light", false], ["dark", "dark", false], ["light-reduce-transparency", "light", true]] as const) {
    const { ctx, page } = await fresh(browser, { colorScheme: scheme }, rt ? { transparency: true } : {});
    for (const [name, url] of SHELL_SCREENS) {
      await go(page, url);
      await page.waitForTimeout(700);
      await page.screenshot({ path: evidence(`v4/shell-${name}-${label}.png`) });
    }
    await ctx.close();
    const anon = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 800 }, colorScheme: scheme });
    if (rt) await setPrefCookies(anon, ORIGIN, { transparency: true });
    const p2 = await anon.newPage();
    await go(p2, "/sign-in");
    await p2.screenshot({ path: evidence(`v4/shell-sign-in-as-auth-renders-it-${label}.png`) });
    await anon.close();
  }
  // reduce transparency by the system setting too
  const { ctx, page } = await fresh(browser);
  await emulateReducedTransparency(page);
  await go(page, previewUrl({ scene: "app", draft: 1 }));
  await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: evidence("v4/app-controlRoom-switcher-open-system-reduce-transparency.png") });
  await ctx.close();
});

test("V4 viewed app with the switcher in Control Room, Dusk and Solid", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(120_000);
  for (const theme of ["controlRoom", "dusk", "solid"] as const) {
    const { ctx, page } = await fresh(browser, { colorScheme: theme === "dusk" ? "dark" : "light" });
    await go(page, previewUrl({ scene: "app", theme }));
    await page.waitForTimeout(600);
    await page.screenshot({ path: evidence(`v4/app-${theme}-switcher.png`) });
    await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
    await page.mouse.move(900, 300);
    await page.waitForTimeout(600);
    await page.screenshot({ path: evidence(`v4/app-${theme}-switcher-open.png`) });
    await page.keyboard.press("Escape");
    await go(page, previewUrl({ scene: "app", theme, draft: 1 }));
    await page.locator("[data-open-confirm]").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: evidence(`v4/app-${theme}-draft-bar-and-confirm.png`) });
    await ctx.close();
  }
});

test("V5 phone screenshots at 390x844", async ({ page, context }, info) => {
  test.skip(info.project.name !== "mobile", "mobile project");
  test.setTimeout(120_000);
  await signIn(page);
  await markSwept(context, ORIGIN);
  for (const [name, url] of [...SHELL_SCREENS, ["app-switcher", previewUrl({ scene: "app" })] as [string, string]]) {
    await go(page, url);
    await page.waitForTimeout(600);
    await page.screenshot({ path: evidence(`v5/phone-390-${name}.png`) });
  }
  await go(page, previewUrl({ scene: "app" }));
  await page.locator("atrium-switcher").locator("[data-switcher-button]").tap();
  await page.waitForTimeout(600);
  await page.screenshot({ path: evidence("v5/phone-390-app-switcher-open.png") });
  await go(page, "/");
  await page.locator('[data-tab="more"]').tap();
  await page.waitForTimeout(600);
  await page.screenshot({ path: evidence("v5/phone-390-more-sheet.png") });
  await context.addCookies([{ name: "atrium_theme", value: "dark", url: ORIGIN }]);
  for (const [name, url] of [["apps-interim-home", "/"], ["integrations", "/integrations"]] as const) {
    await go(page, url);
    await page.screenshot({ path: evidence(`v5/phone-390-${name}-dark.png`) });
  }
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(390);
});

async function frameTimes(page: Page, run: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __ft: number[]; __ftOn: boolean };
    w.__ft = [];
    w.__ftOn = true;
    let last = 0;
    const tick = (t: number) => {
      w.__ft.push(t - last);
      last = t;
      if (w.__ftOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame((t) => {
      last = t;
      requestAnimationFrame(tick);
    });
  });
  await run();
  const ft = await page.evaluate(() => {
    const w = window as unknown as { __ft: number[]; __ftOn: boolean };
    w.__ftOn = false;
    return w.__ft;
  });
  const sorted = [...ft].sort((a, b) => a - b);
  const pct = (p: number) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(2);
  return { frames: ft.length, meanMs: +(ft.reduce((a, b) => a + b, 0) / ft.length).toFixed(2), p95Ms: pct(0.95), maxMs: +Math.max(...ft).toFixed(2), over16_7: ft.filter((v) => v > 16.7).length, over17_5: ft.filter((v) => v > 17.5).length, raw: ft.map((v) => +v.toFixed(2)) };
}

test("V7 frame timing during the sweep, the glow, the switcher sheet and a button press (measured; no GPU here, so no verdict)", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(120_000);
  const out: Record<string, unknown> = {};
  const { ctx, page } = await fresh(browser, {}, {}, false);
  await page.goto(previewUrl({ scene: "widgets", n: 9, sweep: "force" }));
  await page.waitForSelector('[data-sweep="playing"]');
  out.sweep = await frameTimes(page, async () => {
    await page.waitForSelector('[data-sweep="playing"]', { state: "detached", timeout: 4000 });
  });
  await page.waitForTimeout(500);
  out.glow = await frameTimes(page, async () => {
    await page.locator("[data-test-connection]").click();
    await page.waitForTimeout(1000);
  });
  await page.waitForTimeout(6000);
  out.buttonPress = await frameTimes(page, async () => {
    const b = (await page.locator("[data-lift-toggle]").boundingBox())!;
    await page.mouse.move(b.x + 5, b.y + 5);
    await page.mouse.down();
    await page.waitForTimeout(350);
    await page.mouse.up();
    await page.waitForTimeout(350);
  });
  out.idleBaseline = await frameTimes(page, () => page.waitForTimeout(1000));
  await page.goto(previewUrl({ scene: "app" }));
  await page.waitForTimeout(800);
  out.switcherSheetOpen = await frameTimes(page, async () => {
    await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
    await page.waitForTimeout(600);
  });
  await ctx.close();
  const gl = await (async () => {
    const c = await browser.newContext();
    const p = await c.newPage();
    const r = await p.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      const i = gl?.getExtension("WEBGL_debug_renderer_info");
      return gl ? String(gl.getParameter(i ? i.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : "no webgl";
    });
    await c.close();
    return r;
  })();
  writeEvidence("v7/frame-timing.json", { method: "requestAnimationFrame deltas in headless Chromium (Playwright 1.64), 1280x800, during each animation", renderer: gl, ...out });
  const summary = Object.fromEntries(Object.entries(out).map(([k, v]) => { const s = v as { frames: number; meanMs: number; p95Ms: number; maxMs: number; over16_7: number; over17_5: number }; return [k, { frames: s.frames, meanMs: s.meanMs, p95Ms: s.p95Ms, maxMs: s.maxMs, framesOver16_7: s.over16_7, framesOver17_5: s.over17_5 }]; }));
  writeEvidence("v7/frame-timing-summary.json", { renderer: gl, verdict: "reported, not judged: no GPU compositing on this host (design v4 section 3, spec v2 criterion 27)", ...summary });
  expect(Object.keys(summary).length).toBe(5);
});

test("V6 recordings: opening sweep, connection glow, switcher sheet opening, button press", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(120_000);
  const dir = evidence("v6/raw");
  for (const [name, run] of [
    ["opening-sweep", async (p: Page) => { await go(p, previewUrl({ scene: "widgets", n: 9, sweep: "force" })); await p.waitForTimeout(2400); }],
    ["connection-glow", async (p: Page) => { await go(p, previewUrl({ scene: "widgets", n: 6 })); await p.waitForTimeout(600); await p.locator("[data-test-connection]").click(); await p.waitForTimeout(1800); }],
    ["switcher-sheet", async (p: Page) => { await go(p, previewUrl({ scene: "app" })); await p.waitForTimeout(600); await p.locator("atrium-switcher").locator("[data-switcher-button]").click(); await p.waitForTimeout(900); await p.keyboard.press("Escape"); await p.waitForTimeout(700); }],
    ["button-press", async (p: Page) => { await go(p, previewUrl({ scene: "buttons" })); await p.waitForTimeout(500); for (const k of ["primary", "secondary", "ink"]) { const b = (await p.locator(`[data-btn="${k}"]`).boundingBox())!; await p.mouse.move(b.x + 10, b.y + 10); await p.mouse.down(); await p.waitForTimeout(500); await p.mouse.up(); await p.waitForTimeout(400); } }],
  ] as const) {
    const ctx = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
    const page = await ctx.newPage();
    await signIn(page);
    if (name !== "opening-sweep") await markSwept(ctx, ORIGIN);
    await run(page);
    const video = page.video()!;
    await ctx.close();
    renameSync(await video.path(), evidence(`v6/raw/${name}.webm`));
  }
});

test("V10 captured network responses carry no secret names or values", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { existsSync, readFileSync } = await import("node:fs");
  const names = ["BETTER_AUTH_SECRET", "ATRIUM_MASTER_KEY", "ATRIUM_OWNER_PASSWORD", "ATRIUM_TEST_NPM_TOKEN", "ATRIUM_TEST_PROXMOX_TOKEN", "ATRIUM_TEST_PFSENSE_KEY", "ATRIUM_TEST_KUMA_TOKEN", "ATRIUM_N8N_WEBHOOK_TOKEN", "ATRIUM_N8N_SIGNING_SECRET", "VAPID_PRIVATE_KEY"];
  const values = ["e2e-owner-password-123", "e2e-only-not-a-real-secret-0123456789abcdef"];
  const mk = "data/e2e-app-shell/master.key";
  if (existsSync(mk)) values.push(readFileSync(mk, "utf8").trim());
  const { ctx, page } = await fresh(browser);
  const bodies: { url: string; bytes: number; hits: string[] }[] = [];
  page.on("response", async (r) => {
    try {
      const b = await r.text();
      const hits = [...names.filter((n) => b.includes(n)), ...values.filter((v) => b.includes(v)).map((_, i) => `secret value #${i + 1}`)];
      bodies.push({ url: r.url(), bytes: b.length, hits });
    } catch {
      /* redirects and aborted requests have no body */
    }
  });
  for (const url of ["/", "/integrations", previewUrl({ scene: "widgets", approvals: 3 }), previewUrl({ scene: "app", draft: 1 }), previewUrl({ scene: "toasts" }), previewUrl({ scene: "error" }), "/this-room-is-missing"]) {
    await page.goto(url);
    await page.waitForTimeout(1200);
  }
  await ctx.close();
  const hits = bodies.filter((b) => b.hits.length);
  writeEvidence("v10/network-responses.json", { responses: bodies.length, withHits: hits, all: bodies.map((b) => ({ url: b.url, bytes: b.bytes, hits: b.hits.length })) });
  expect(bodies.length).toBeGreaterThan(10);
  expect(hits).toEqual([]);
});
