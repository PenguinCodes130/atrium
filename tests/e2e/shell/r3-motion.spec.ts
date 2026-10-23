// app-shell round 3 motion (design v4 section 3 and 4; spec v2 criteria 24 to 32, plus the in-force
// v1 criteria 20 and 28): sweep once per session over 1200ms, 30ms stagger, title bar glow, reduced
// motion, drift, and an audit that only transform and opacity animate (no animated shadows).
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { evidence, fresh, go, previewUrl, writeEvidence } from "./helpers";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop project");

/** Records every inline-style property that changes while `run` executes (document and shadow roots). */
async function auditStyles(page: Page, run: () => Promise<void>) {
  await page.evaluate(() => {
    const changed: Record<string, number> = {};
    const parse = (s: string | null) => Object.fromEntries((s ?? "").split(";").map((d) => d.split(":").map((x) => x.trim())).filter((p) => p[0]).map((p) => [p[0], p.slice(1).join(":")]));
    const obs = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type !== "attributes" || m.attributeName !== "style") continue;
        const el = m.target as HTMLElement;
        if (el === document.body) continue; // Radix toggles pointer-events on <body> while a dialog is open
        const a = parse(m.oldValue);
        const b = parse(el.getAttribute("style"));
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k] && !k.startsWith("--radix")) changed[k] = (changed[k] ?? 0) + 1;
      }
    });
    const opts = { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ["style"] };
    obs.observe(document.documentElement, opts);
    const host = document.querySelector("atrium-switcher");
    if (host?.shadowRoot) obs.observe(host.shadowRoot, opts);
    (window as unknown as { __audit: () => Record<string, number> }).__audit = () => {
      obs.disconnect();
      return changed;
    };
  });
  await run();
  return page.evaluate(() => (window as unknown as { __audit: () => Record<string, number> }).__audit());
}
const ALLOWED = new Set(["transform", "opacity", "will-change", "transform-origin", "pointer-events"]);

test("C28 the sweep plays once per session over 1200ms on the first paint, input works during it; a second load renders lit", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser, {}, {}, false);
  await page.addInitScript(() => {
    const log: number[] = [];
    (window as unknown as { __band: number[] }).__band = log;
    const tick = () => {
      if (document.querySelector('[data-sweep="playing"]')) log.push(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await go(page, previewUrl({ scene: "widgets", n: 6 }));
  const band = page.locator('[data-sweep="playing"]');
  await page.locator('[data-widget="1"] [data-widget-control]').click();
  await expect(page.locator('[data-widget="1"] [data-widget-control]')).toHaveAttribute("data-clicks", "1");
  await expect(band).toHaveCount(0, { timeout: 4000 });
  const frames = await page.evaluate(() => (window as unknown as { __band: number[] }).__band);
  const visibleMs = Math.round(frames[frames.length - 1]! - frames[0]!);
  const timing = await page.evaluate(() => document.documentElement.getAttribute("data-swept"));
  expect(timing).toBe("1");
  expect(visibleMs).toBeGreaterThan(1000);
  expect(visibleMs).toBeLessThan(1400);
  await page.reload();
  await page.waitForTimeout(300);
  await expect(page.locator("[data-sweep]")).toHaveCount(0);
  const ops = await page.locator("[data-settle]").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
  expect(ops.every((o) => o === "1")).toBe(true);
  writeEvidence("criteria/c28-sweep-once.json", { bandVisibleMs: visibleMs, designMs: 1200, clickDuringSweepRegistered: true, secondLoadReplayed: false, note: "band visible from the first to the last rendered frame (rAF sampling)" });
  await ctx.close();
});

test("C29 with 15 windows, 1 to 12 start 30ms apart and 13 to 15 start with the 12th", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser, { viewport: { width: 1280, height: 2600 } }, {}, false);
  await page.addInitScript(() => {
    const delays: Record<string, number> = {};
    (window as unknown as { __delays: typeof delays }).__delays = delays;
    const tick = () => {
      document.querySelectorAll<HTMLElement>("[data-settle]").forEach((el, i) => {
        const d = el.getAttribute("data-settle-delay");
        if (d !== null && delays[i] === undefined) delays[i] = Number(d);
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await go(page, previewUrl({ scene: "widgets", n: 15 }));
  await page.waitForTimeout(2200);
  const d = await page.evaluate(() => (window as unknown as { __delays: Record<string, number> }).__delays);
  const planned = Array.from({ length: 15 }, (_, i) => d[i]!);
  const diffs = planned.slice(1).map((v, i) => v - planned[i]!);
  writeEvidence("criteria/c29-stagger.json", { plannedDelaysMs: planned, diffsMs: diffs });
  for (let i = 0; i < 11; i++) {
    expect(diffs[i]).toBeGreaterThanOrEqual(29);
    expect(diffs[i]).toBeLessThanOrEqual(31);
  }
  expect(planned.slice(11)).toEqual([planned[11], planned[11], planned[11], planned[11]]);
  await ctx.close();
});

test("C30 a passed connection test flashes the title bar gold with ink text and back over 900ms while the check draws in; a reload does not replay", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser);
  await go(page, previewUrl({ scene: "widgets" }));
  await page.evaluate(() => {
    const samples: [number, number][] = [];
    (window as unknown as { __glow: typeof samples }).__glow = samples;
    const tick = () => {
      const el = document.querySelector("[data-titlebar-glow]");
      if (el) {
        samples.push([performance.now(), parseFloat(getComputedStyle(el).opacity)]);
        const s = getComputedStyle(el);
        (window as unknown as { __glowLook: unknown }).__glowLook = { bg: s.backgroundColor, color: s.color };
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator("[data-test-connection]").click();
  await expect(page.locator("[data-connection-card] [data-status-check]")).toBeVisible();
  await page.waitForTimeout(1300);
  const samples = await page.evaluate(() => (window as unknown as { __glow: [number, number][] }).__glow);
  const look = await page.evaluate(() => (window as unknown as { __glowLook: { bg: string; color: string } }).__glowLook);
  const lit = samples.filter(([, o]) => o > 0.0005);
  const span = lit.length ? Math.round(lit[lit.length - 1]![0] - lit[0]![0]) : 0;
  const peak = Math.max(...samples.map(([, o]) => o));
  expect(look.bg).toBe("rgb(233, 185, 73)");
  expect(look.color).toBe("rgb(21, 19, 15)");
  expect(span).toBeGreaterThan(600);
  expect(span).toBeLessThan(960);
  expect(peak).toBeGreaterThan(0.8);
  expect(samples[samples.length - 1]![1]).toBeLessThan(0.02);
  await page.reload();
  await page.waitForTimeout(800);
  await expect(page.locator("[data-titlebar-glow]")).toHaveCount(0);
  writeEvidence("criteria/c30-glow.json", { litSpanMs: span, peakOpacity: peak, look, samples: samples.length, reloadReplayed: false });
  await ctx.close();
});

for (const mode of ["system", "in-app"] as const) {
  test(`C31 reduced motion (${mode}): lit first paint, static 1.5s gold outline, whole type-in, instant switches, steady doorway, no shimmer, instant springs`, async ({ browser }, info) => {
    desktopOnly(info.project.name);
    const { ctx, page } = await fresh(browser, mode === "system" ? { reducedMotion: "reduce" } : {}, mode === "in-app" ? { motion: true } : {}, false);
    const out: Record<string, unknown> = {};
    // no sweep, lit first paint, staggered items together
    await go(page, previewUrl({ scene: "widgets", n: 15 }));
    out.sweepBand = await page.locator("[data-sweep]").count();
    out.settleOpacities = [...new Set(await page.locator("[data-settle]").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity)))];
    expect(out.sweepBand).toBe(0);
    expect(out.settleOpacities).toEqual(["1"]);
    // the glow becomes a static gold outline for 1.5s
    await page.locator("[data-test-connection]").click();
    const ring = page.locator("[data-glow-ring]");
    await expect(ring).toHaveCount(1);
    const t0 = Date.now();
    out.ringOutline = await ring.evaluate((e) => getComputedStyle(e).outline);
    await expect(ring).toHaveCount(0, { timeout: 3000 });
    out.ringMs = Date.now() - t0;
    out.titlebarGlow = await page.locator("[data-titlebar-glow]").count();
    expect(out.ringOutline).toBe("rgb(233, 185, 73) solid 2px");
    expect(out.ringMs as number).toBeGreaterThan(1200);
    expect(out.ringMs as number).toBeLessThan(2000);
    expect(out.titlebarGlow).toBe(0);
    // type-in shows the whole text at once; switches swap instantly; door glow steady; no shimmer
    await go(page, previewUrl({ scene: "buttons" }));
    out.typeIn = await page.locator("[data-type-in]").getAttribute("data-type-in");
    expect(out.typeIn).toBe("done");
    await page.locator("[data-switch-row]").nth(1).click();
    await page.waitForTimeout(30);
    out.switchThumbTransform = await page.locator("[data-switch-row]").nth(1).locator("[data-switch-thumb]").evaluate((e) => getComputedStyle(e).transform);
    expect(out.switchThumbTransform).toBe("matrix(1, 0, 0, 1, 20, 0)");
    // Round 5: "/" is app-builder's launcher now; the empty room (app-shell's) is on the preview route.
    await go(page, previewUrl({ scene: "empty" }));
    out.door = await page.locator("[data-empty-room] [data-door-glow]").evaluate((e) => ({ animation: getComputedStyle(e).animationName, opacity: getComputedStyle(e).opacity }));
    expect(out.door).toEqual({ animation: "none", opacity: "1" });
    await go(page, previewUrl({ scene: "loading" }));
    out.shimmer = await page.locator("[data-skeleton-bar]").first().evaluate((e) => getComputedStyle(e, "::after").animationName);
    expect(out.shimmer).toBe("none");
    // springs are instant with a 120ms crossfade: the palette sheet is in place at once
    await go(page, "/");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(40);
    out.sheetTransform = await page.locator("[data-sheet]").evaluate((e) => getComputedStyle(e).transform);
    expect(out.sheetTransform === "none" || out.sheetTransform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: evidence(`reduced-motion/${mode}-apps.png`) });
    await go(page, previewUrl({ scene: "widgets" }));
    await page.screenshot({ path: evidence(`reduced-motion/${mode}-windows.png`) });
    writeEvidence(`reduced-motion/c31-${mode}.json`, out);
    await ctx.close();
  });
}

test("C32 drift over the app canvas: #A9C8E4 0.14 at 07:00, none at 12:00, #E9B949 0.16 at 17:00, #8E6416 0.10 at 23:00; never over the shell, switcher or dialogs", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser);
  const got: Record<string, unknown> = {};
  for (const [t, strength, color] of [["07:00", "0.14", "rgb(169, 200, 228)"], ["12:00", "0", null], ["17:00", "0.16", "rgb(233, 185, 73)"], ["23:00", "0.1", "rgb(142, 100, 22)"]] as const) {
    await go(page, previewUrl({ scene: "app", theme: "controlRoom", drift: t }));
    const d = page.locator("[data-drift]");
    await expect(d).toHaveAttribute("data-drift-strength", strength);
    const r = await d.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, opacity: getComputedStyle(e).opacity, blend: getComputedStyle(e).mixBlendMode, inCanvas: !!e.closest("[data-atrium-canvas]") }));
    got[t] = r;
    if (color) expect(r.bg).toBe(color);
    expect(r.inCanvas).toBe(true);
    if (t === "17:00") await page.screenshot({ path: evidence("screens/c32-drift-golden-hour.png") });
  }
  // every drift overlay is inside the app canvas; the switcher lives in the top layer above it
  const outside = await page.evaluate(() => [...document.querySelectorAll("[data-drift]")].filter((e) => !e.closest("[data-atrium-canvas]")).length);
  expect(outside).toBe(0);
  await go(page, previewUrl({ scene: "app", theme: "solid", drift: "17:00" }));
  await expect(page.locator("[data-drift]")).toHaveCount(0);
  writeEvidence("criteria/c32-drift.json", { overlays: got, solidTheme: "no drift (lightDrift off)", overlaysOutsideCanvas: outside, shellAndSwitcher: "the shell has no canvas; the switcher and the confirm dialog are in the top layer" });
  await ctx.close();
});

test("v1 C28 with reduced motion the drift does not change while the page stays open", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const results: Record<string, string[]> = {};
  for (const reduced of [false, true]) {
    const { ctx, page } = await fresh(browser, reduced ? { reducedMotion: "reduce" } : {});
    await page.clock.install({ time: new Date(2026, 9, 17, 8, 55, 0) });
    await go(page, previewUrl({ scene: "app" }));
    await expect(page.locator("[data-drift]")).toHaveAttribute("data-drift-strength", "0.14");
    const before = await page.locator("[data-drift]").getAttribute("data-drift-strength");
    await page.clock.fastForward("20:00");
    await page.waitForTimeout(200);
    const after = await page.locator("[data-drift]").getAttribute("data-drift-strength");
    results[reduced ? "reduced" : "normal"] = [before!, after!];
    await ctx.close();
  }
  writeEvidence("criteria/v1-c28-drift-reduced.json", { "08:55 -> 09:15": results });
  expect(results.reduced![0]).toBe(results.reduced![1]);
  expect(results.normal![0]).not.toBe(results.normal![1]);
});

test("v1 C20 C26 animations change only transform and opacity; a press and a lift swap the shadow, never animate it", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser, {}, {}, false);
  const out: Record<string, Record<string, number>> = {};
  await go(page, previewUrl({ scene: "widgets", n: 9 }));
  out.sweep = await auditStyles(page, () => page.waitForTimeout(1800));
  out.glow = await auditStyles(page, async () => {
    await page.locator("[data-test-connection]").click();
    await page.waitForTimeout(1200);
  });
  out.lift = await auditStyles(page, async () => {
    await page.locator("[data-lift-toggle]").click();
    await page.waitForTimeout(600);
    await page.locator("[data-lift-toggle]").click();
    await page.waitForTimeout(600);
  });
  out.press = await auditStyles(page, async () => {
    const b = (await page.locator("[data-lift-toggle]").boundingBox())!;
    await page.mouse.move(b.x + 5, b.y + 5);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(300);
  });
  out.sheet = await auditStyles(page, async () => {
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  });
  await go(page, previewUrl({ scene: "app" }));
  out.switcherSheet = await auditStyles(page, async () => {
    await page.locator("atrium-switcher").locator("[data-switcher-button]").click();
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });
  const keyframes = await page.evaluate(() => {
    const r: Record<string, string[]> = {};
    for (const sheet of [...document.styleSheets]) for (const rule of [...sheet.cssRules]) if (rule instanceof CSSKeyframesRule && rule.name.startsWith("atrium-")) r[rule.name] = [...rule.cssRules].flatMap((k) => [...(k as CSSKeyframeRule).style]);
    return r;
  });
  // no CSS transition on box-shadow anywhere in the shell
  await go(page, previewUrl({ scene: "buttons" }));
  const shadowTransitions = await page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => /box-shadow|all/.test(getComputedStyle(e).transitionProperty) && getComputedStyle(e).transitionDuration !== "0s").length);
  writeEvidence("criteria/v1-c20-c26-style-audit.json", { method: "MutationObserver on inline style attributes (document and the switcher's shadow root) during each animation; property -> number of changes", allowed: [...ALLOWED], ...out, keyframes, elementsWithShadowTransitions: shadowTransitions });
  for (const [name, props] of Object.entries(out)) for (const p of Object.keys(props)) expect(ALLOWED.has(p), `${name}: ${p}`).toBe(true);
  for (const [name, props] of Object.entries(keyframes)) for (const p of props) expect(["transform", "opacity"], `${name}: ${p}`).toContain(p);
  expect(shadowTransitions).toBe(0);
  await ctx.close();
});
