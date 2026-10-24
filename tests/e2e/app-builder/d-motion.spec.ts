// app-builder e2e, part D: frame timing for drag and the edit-mode switch (V7), and reduced motion on the
// launcher (criterion 49, V8). Runs after parts A to C on the same slot data.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, ev, log, OWNER, saveText } from "./helpers";

test.describe.configure({ mode: "serial" });
// Each test makes its own contexts and phone widths (as in round 1, run on the desktop project only); a
// second pass on the mobile project would meet the first pass's apps in the same slot database.
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

async function frames(page: Page, act: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __f: number[]; __run: boolean };
    w.__f = [];
    w.__run = true;
    let last = performance.now();
    const tick = (t: number) => { w.__f.push(t - last); last = t; if (w.__run) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await act();
  return page.evaluate(() => {
    const w = window as unknown as { __f: number[]; __run: boolean };
    w.__run = false;
    const f = w.__f.slice(1);
    const sorted = [...f].sort((a, b) => a - b);
    return { frames: f.length, p50: sorted[Math.floor(f.length / 2)] ?? 0, p95: sorted[Math.floor(f.length * 0.95)] ?? 0, over: f.filter((x) => x > 16.7).length };
  });
}

test("frame timing while dragging and switching edit mode (V7)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto("/build/lounge");
  await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
  const gpu = await page.evaluate(() => { const c = document.createElement("canvas").getContext("webgl"); const d = c?.getExtension("WEBGL_debug_renderer_info"); return d ? String(c!.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "none"; });
  await page.locator('[data-insert-item="text"]').first().scrollIntoViewIfNeeded();
  const item = (await page.locator('[data-insert-item="text"]').first().boundingBox())!;
  const drag = await frames(page, async () => {
    await page.mouse.move(item.x + 20, item.y + 10);
    await page.mouse.down();
    for (let i = 0; i < 40; i++) { await page.mouse.move(item.x + 300 + i * 12, item.y + 200 + (i % 10) * 9); await page.waitForTimeout(16); }
    await page.keyboard.press("Escape");
    await page.mouse.move(5, 5);
    await page.mouse.up();
  });
  const edit = await frames(page, async () => {
    await page.locator("[data-edit-toggle]").click();
    await page.waitForTimeout(500);
    await page.locator("[data-edit-toggle]").click();
    await page.waitForTimeout(500);
  });
  const out = { renderer: gpu, drag, edit, note: "Measured in headless Chromium on this VM; the renderer line shows whether GPU compositing was available." };
  log("frame timing", out);
  saveText("perf/frame-timing.json", JSON.stringify(out, null, 2));
  await ctx.close();
});

test("reduced motion: launcher tiles appear together (criterion 49, V8)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { reducedMotion: "reduce" });
  await ctx.clearCookies();
  const fresh = await contextFor(browser, OWNER, { reducedMotion: "reduce" });
  const page = await fresh.newPage();
  await page.goto("/");
  await page.waitForTimeout(60);
  const opacities = await page.locator("[data-app-tile]").evaluateAll((els) => els.map((e) => Number(getComputedStyle(e.closest("[data-settle-item], div") as Element).opacity)));
  log("reduced motion tile opacity at 60ms", opacities);
  await page.screenshot({ path: ev("screens", "reduced-motion-launcher.png"), fullPage: true });
  expect(opacities.every((o) => o === opacities[0])).toBe(true);
  await fresh.close();
  await ctx.close();
});
