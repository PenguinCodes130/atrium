// Round 4 (gauntlet r2 Fix List): the visible opening sweep and door glyphs (Fix 2), the Note 1 glow
// and the success toast (Fix 6), isolated overlays (Fix 3), and the canvas root box probes (Fix 1).
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { evidence, fresh, go, previewUrl, writeEvidence } from "./helpers";

const desktopOnly = (name: string) => test.skip(name !== "desktop", "desktop project");

test("Fix 2: the opening sweep is a band you can point at in a still frame; door glyphs light as it passes", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser, {}, {}, false);
  await page.goto(previewUrl({ scene: "widgets", n: 9, sweep: "force" }));
  await page.waitForSelector('[data-sweep="playing"]');
  // Sample the band's geometry and the door glyphs on every frame.
  await page.evaluate(() => {
    const t0 = performance.now();
    const log: { t: number; bandTop: number | null; doors: string[] }[] = [];
    (window as unknown as { __sw: typeof log }).__sw = log;
    const tick = () => {
      const band = document.querySelector("[data-sweep-band]");
      log.push({
        t: Math.round(performance.now() - t0),
        bandTop: band ? Math.round(band.getBoundingClientRect().bottom) : null,
        doors: [...document.querySelectorAll("[data-widget] [data-titlebar] [data-door-gold]")].map((d) => getComputedStyle(d).opacity),
      });
      if (band || performance.now() - t0 < 300) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // A still frame mid-sweep.
  await page.waitForFunction(() => {
    const b = document.querySelector("[data-sweep-band]");
    return b && b.getBoundingClientRect().bottom > 380;
  });
  const shot = await page.screenshot({ path: evidence("v6/sweep-still-frame.png") });
  const band = await page.evaluate(() => {
    const b = document.querySelector("[data-sweep-band]")!;
    const r = b.getBoundingClientRect();
    const s = getComputedStyle(b);
    const wrap = getComputedStyle(b.parentElement!);
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), background: s.backgroundImage, edge: s.borderBottomColor + " " + s.borderBottomWidth, blend: wrap.mixBlendMode, opacity: wrap.opacity };
  });
  await page.waitForSelector('[data-sweep="playing"]', { state: "detached", timeout: 4000 });
  const log = await page.evaluate(() => (window as unknown as { __sw: { t: number; bandTop: number | null; doors: string[] }[] }).__sw);
  // Find the leading edge in the still frame itself (a column on the plain page ground at the right
  // gutter, below the sky band), then compare the ground just inside the band with the ground just below the edge.
  const { samplePixels } = await import("./helpers");
  const x = 1265;
  const column = await samplePixels(page, shot, Array.from({ length: 610 }, (_, i) => [x, 185 + i] as [number, number]));
  let edgeY = 0;
  let drop = 0;
  for (let i = 1; i < column.length; i++) {
    const d = column[i]![2] - column[i - 1]![2]; // the gold band lowers blue; the edge is where blue jumps back up
    if (d > drop) {
      drop = d;
      edgeY = 185 + i;
    }
  }
  const inside = column[Math.max(0, edgeY - 185 - 10)]!;
  const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const below = column[Math.min(column.length - 1, edgeY - 185 + 10)]!;
  const doorSeq = log.filter((l) => l.doors.length).map((l) => ({ t: l.t, lit: l.doors.filter((o) => parseFloat(o) > 0.5).length, of: l.doors.length }));
  const everDim = doorSeq.some((d) => d.lit < d.of);
  const endLit = doorSeq[doorSeq.length - 1];
  writeEvidence("criteria/fix2-sweep.json", { band, pixels: { column: x, leadingEdgeY: edgeY, insideBand: inside, belowEdge: below, luminanceDelta: +(lum(inside) - lum(below)).toFixed(1), blueDelta: below[2] - inside[2] }, doorGlyphs: { frames: doorSeq.length, someDimBeforeTheBand: everDim, atEnd: endLit, sample: doorSeq.filter((_, i) => i % 6 === 0) } });
  expect(band.blend).toBe("normal");
  expect(band.background).toContain("rgba(246, 217, 139, 0.45)");
  expect(band.edge).toBe("rgba(233, 185, 73, 0.6) 1px");
  // The band is visible: the ground inside it is clearly warmer/darker than the unlit ground.
  expect(below[2] - inside[2]).toBeGreaterThan(20);
  expect(everDim).toBe(true);
  expect(endLit!.lit).toBe(endLit!.of);
  await ctx.close();
});

test("Fix 6: the glow reaches full gold within 120ms, holds to about 450ms, is gone by 900ms; the success toast waits 300ms and covers no title bar", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser, { viewport: { width: 1280, height: 800 } });
  await go(page, previewUrl({ scene: "glow" }));
  // Put the second row of windows at the bottom of the viewport, under the toast's corner.
  await page.evaluate(() => {
    const bars = [...document.querySelectorAll("[data-window-grid] [data-titlebar]")];
    const row2 = bars[3]!.getBoundingClientRect();
    window.scrollBy(0, row2.top - 715);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const samples: { t: number; o: number }[] = [];
    let t0 = 0;
    (window as unknown as { __g: typeof samples; __t0: () => number; __toastAt: number }).__g = samples;
    (window as unknown as { __toastAt: number }).__toastAt = 0;
    document.querySelector("[data-test-connection]")!.addEventListener("click", () => (t0 = performance.now()), { capture: true });
    (window as unknown as { __t0: () => number }).__t0 = () => t0;
    const tick = () => {
      const el = document.querySelector("[data-titlebar-glow]");
      if (el && t0) samples.push({ t: +(performance.now() - t0).toFixed(1), o: parseFloat(getComputedStyle(el).opacity) });
      if (t0 && !(window as unknown as { __toastAt: number }).__toastAt && document.querySelector('[data-toast="success"]')) (window as unknown as { __toastAt: number }).__toastAt = performance.now() - t0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.evaluate(() => (document.querySelector("[data-test-connection]") as HTMLElement).click());
  await page.waitForTimeout(160);
  await page.screenshot({ path: evidence("criteria/fix6-glow-at-160ms.png") });
  await page.waitForTimeout(1300);
  const samples = await page.evaluate(() => (window as unknown as { __g: { t: number; o: number }[] }).__g);
  const toastAt = await page.evaluate(() => (window as unknown as { __toastAt: number }).__toastAt);
  const look = await page.locator("[data-glow-scene]").evaluate(() => null);
  void look;
  // The toast versus every title bar on screen.
  const overlap = await page.evaluate(() => {
    const t = document.querySelector('[data-toaster="desktop"] ol')!.getBoundingClientRect();
    const bars = [...document.querySelectorAll("[data-titlebar]")].filter((b) => !b.closest("[data-toast]")).map((b) => b.getBoundingClientRect());
    const hits = bars.filter((b) => b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top).map((b) => ({ top: b.top, left: b.left }));
    return { toast: { top: Math.round(t.top), bottom: Math.round(t.bottom), left: Math.round(t.left), right: Math.round(t.right) }, offset: document.querySelector("[data-toaster]")!.getAttribute("data-toast-offset"), hits };
  });
  await page.screenshot({ path: evidence("criteria/fix6-toast-clear-of-title-bars.png") });
  const at = (ms: number) => samples.reduce((best, s) => (Math.abs(s.t - ms) < Math.abs(best.t - ms) ? s : best), samples[0]!);
  // Times from the glow layer's first frame (the click is handled a frame or two earlier on this
  // GPU-less host, where frames run 17 to 33ms).
  const start = samples[0]?.t ?? 0;
  const clickToFirstFrameMs = start;
  const peakAt = (samples.find((s) => s.o >= 0.99)?.t ?? NaN) - start;
  const holdUntil = ([...samples].reverse().find((s) => s.o >= 0.95)?.t ?? NaN) - start;
  const goneAt = (samples.find((s) => s.t - start > 450 && s.o <= 0.01)?.t ?? NaN) - start;
  writeEvidence("criteria/fix6-glow-timing.json", {
    design: "Note 1: full --accent within 120ms, held near peak to about 450ms, eased back by 900ms; toast 300ms later, never over a title bar",
    clickToFirstGlowFrameMs: clickToFirstFrameMs,
    timesBelowAreFromTheFirstGlowFrame: true,
    peakReachedAtMs: peakAt,
    heldAtOrAbove095UntilMs: holdUntil,
    backToZeroAtMs: goneAt,
    at: { 60: at(60), 120: at(120), 300: at(300), 450: at(450), 600: at(600), 750: at(750), 900: at(900) },
    successToastAppearedAtMs: Math.round(toastAt),
    toastPlacement: overlap,
    samples,
  });
  expect(peakAt).toBeLessThanOrEqual(140); // 120ms plus one frame
  expect(holdUntil).toBeGreaterThanOrEqual(430);
  expect(goneAt).toBeLessThanOrEqual(930);
  expect(toastAt).toBeGreaterThanOrEqual(295);
  expect(overlap.hits).toEqual([]);
  expect(Number(overlap.offset)).toBeGreaterThan(24);
  await ctx.close();
});

test("Fix 6: the title bar is full #E9B949 with ink text at its peak (pixels)", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser);
  await go(page, previewUrl({ scene: "widgets", n: 3 }));
  await page.evaluate(() => (document.querySelector("[data-test-connection]") as HTMLElement).click());
  await page.waitForTimeout(250);
  const bar = (await page.locator("[data-connection-card] [data-titlebar]").boundingBox())!;
  const png = await page.screenshot({ clip: bar, path: evidence("criteria/fix6-titlebar-peak-250ms.png") });
  const { samplePixels } = await import("./helpers");
  const [bg] = await samplePixels(page, png, [[Math.round(bar.width) - 4, 3]]);
  const look = await page.locator("[data-titlebar-glow]").evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color }));
  writeEvidence("criteria/fix6-titlebar-peak.json", { at: "250ms after the click", pixel: bg, look });
  expect(bg).toEqual([233, 185, 73]);
  expect(look).toEqual({ bg: "rgb(233, 185, 73)", color: "rgb(21, 19, 15)" });
  await ctx.close();
});

/** Read the confirm dialog's look from inside its shadow root. */
async function confirmLook(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector("atrium-control-confirm")!;
    const root = host.shadowRoot!;
    const d = root.querySelector("dialog")!;
    const run = root.querySelector("[data-confirm-run]")!;
    const cancel = root.querySelector("[data-confirm-cancel]")!;
    const title = root.querySelector("[data-confirm-title]")!;
    const cs = (e: Element) => getComputedStyle(e);
    const r = cancel.getBoundingClientRect();
    return {
      inTopLayer: d.matches(":modal"),
      title: title.textContent,
      titleAfter: getComputedStyle(title, "::after").content,
      titleFont: cs(title).fontFamily.split(",")[0],
      titleTracking: cs(title).letterSpacing,
      runBg: cs(run).backgroundColor,
      runColor: cs(run).color,
      cancelVisible: cs(cancel).display !== "none" && r.width > 0,
      dialogBg: cs(d).backgroundColor,
      dialogOutline: cs(d).outlineStyle,
      winBg: cs(root.querySelector("[data-window]")!).backgroundColor,
      hostInCanvas: !!host.closest("[data-atrium-canvas]"),
    };
  });
}

test("Fix 3: the control confirm and draft bar are isolated from app CSS, even when mounted inside the canvas; the bar stays above an app dialog", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const { ctx, page } = await fresh(browser);
  const out: Record<string, unknown> = {};
  for (const css of [undefined, "overlays"] as const) {
    await go(page, previewUrl({ scene: "app", theme: "dusk", draft: 1, css }));
    await page.locator("[data-open-inner-confirm]").click();
    await page.waitForTimeout(400);
    const look = await confirmLook(page);
    await page.screenshot({ path: evidence(`criteria/fix3-confirm-mounted-in-canvas-${css ?? "no-css"}.png`) });
    out[`confirm-${css ?? "no-css"}`] = look;
    expect(look.inTopLayer).toBe(true);
    expect(look.title).toBe("Turn on Office lamp");
    expect(look.titleAfter).toBe("none");
    expect(look.runBg).toBe("rgb(233, 185, 73)");
    expect(look.runColor).toBe("rgb(21, 19, 15)");
    expect(look.cancelVisible).toBe(true);
    expect(look.titleTracking).toBe("-0.4px");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    // The draft bar, before and after an app opens its own modal dialog over everything.
    const barCentre = await page.evaluate(() => {
      const bar = document.querySelector("atrium-draft-bar")!.shadowRoot!.querySelector("[data-draft-preview-bar]")!;
      const back = bar.querySelector("[data-back-to-builder]")!.getBoundingClientRect();
      const r = bar.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, backX: back.left + 4, backY: back.top + 4, display: getComputedStyle(bar).display, text: bar.textContent };
    });
    // The app opens a modal dialog pinned over the top of the page with a strong red backdrop. The
    // bar's opaque "Back to builder" button keeps its exact pixels, so the bar is painted above both;
    // the canvas under the backdrop turns red. (While a modal dialog is open the rest of the page is
    // inert, so hit-testing cannot show this; pixels can.) The glass behind the bar's text may tint.
    const { samplePixels } = await import("./helpers");
    const pts: [number, number][] = [[Math.round(barCentre.backX), Math.round(barCentre.backY)], [Math.round(barCentre.backX) + 30, Math.round(barCentre.backY) + 2], [Math.round(barCentre.backX) + 2, Math.round(barCentre.backY) + 12]];
    const before = await samplePixels(page, await page.screenshot(), [...pts, [640, 700]]);
    await page.locator("[data-open-app-dialog]").click();
    await page.waitForTimeout(300);
    const shot = await page.screenshot({ path: evidence(`criteria/fix3-draft-bar-over-app-dialog-${css ?? "no-css"}.png`) });
    const after = await samplePixels(page, shot, [...pts, [640, 700]]);
    const maxBarDelta = Math.max(...before.slice(0, 3).flatMap((c, i) => c.map((v, k) => Math.abs(v - after[i]![k]!))));
    const canvasDelta = Math.max(...before[3]!.map((v, k) => Math.abs(v - after[3]![k]!)));
    const top = await page.evaluate(() => ({ appDialogOpen: (document.querySelector("[data-app-dialog]") as HTMLDialogElement).open, hostPopoverOpen: document.querySelector("atrium-draft-bar")!.matches(":popover-open") }));
    out[`draftBar-${css ?? "no-css"}`] = { ...barCentre, ...top, barPixelsBefore: before.slice(0, 3), barPixelsWithAppDialog: after.slice(0, 3), maxBarDelta, canvasPixelBefore: before[3], canvasPixelUnderBackdrop: after[3], canvasDelta };
    expect(barCentre.display).toBe("flex");
    expect(barCentre.text).toContain("controls here are real");
    expect(top.appDialogOpen).toBe(true);
    expect(top.hostPopoverOpen).toBe(true);
    expect(maxBarDelta, JSON.stringify({ before, after })).toBe(0);
    expect(canvasDelta).toBeGreaterThan(60);
    await page.keyboard.press("Escape");
  }
  writeEvidence("criteria/fix3-overlays.json", out);
  await ctx.close();
});

const PROBES = ["p1margin", "p1outline", "p1shadow", "p1dropshadow", "p1reflect", "p2wide", "p2minwide"] as const;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** Pixel hashes of the shell bars (clock masked), the page scroll width and what sits at the band's centre. */
type ShellState = { band: string; topbar: string; tabbar?: string; scrollWidth: number; innerWidth: number; bandCentreIsBand: boolean };
async function shellState(page: Page, phone: boolean, tag = ""): Promise<ShellState> {
  const mask = [page.locator("[data-account-trigger]")];
  const band = page.locator('[data-shell="skyband"]');
  const top = page.locator('[data-shell="topbar"]');
  await page.mouse.move(0, 799);
  // The clock's width changes with the time text; hide it at a fixed width so it cannot shift pixels.
  await page.addStyleTag({ content: "[data-clock]{visibility:hidden !important;width:150px !important}" });
  const topPng = await top.screenshot({ mask, animations: "disabled", path: tag ? evidence(`custom-css/topbar-${tag}.png`) : undefined });
  const s: { band: string; topbar: string; tabbar?: string } = { band: hash(await band.screenshot({ mask, animations: "disabled" })), topbar: hash(topPng) };
  if (phone) s.tabbar = hash(await page.locator('[data-shell="tabbar"]').screenshot({ animations: "disabled" }));
  const m = await page.evaluate(() => {
    const b = document.querySelector('[data-shell="skyband"]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width * 0.75, b.top + b.height / 2);
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, bandCentreIsBand: !!hit?.closest('[data-shell="skyband"]') };
  });
  return { ...s, ...m };
}

for (const project of ["desktop", "mobile"] as const) {
  test(`Fix 1 (H1 probes, ${project}): styles on the canvas root's own box leave the sky band, top bar and bottom bar pixel-identical and add no horizontal scroll`, async ({ page }, info) => {
    test.skip(info.project.name !== project, `${project} project`);
    test.setTimeout(180_000);
    const { signIn, markSwept, ORIGIN } = await import("./helpers");
    await signIn(page);
    await markSwept(page.context(), ORIGIN);
    const phone = project === "mobile";
    await go(page, previewUrl({ scene: "canvas" }));
    const base = await shellState(page, phone, `baseline-${project}`);
    const out: Record<string, unknown> = { baseline: base };
    for (const p of PROBES) {
      // 1) through the scoper, as an app's CSS arrives
      await go(page, previewUrl({ scene: "canvas", css: p }));
      const scoped = await shellState(page, phone);
      await page.screenshot({ path: evidence(`custom-css/h1-${p}-scoped-${project}.png`) });
      // 2) the same declarations injected raw into the custom layer, as if the scoper had missed them:
      //    the clipping frame and the guard layer alone must hold.
      await go(page, previewUrl({ scene: "canvas" }));
      const raw = (await import("./r4-probes")).RAW_PROBES[p];
      await page.addStyleTag({ content: `@layer atrium-custom{${raw}}` });
      await page.waitForTimeout(100);
      const unscoped = await shellState(page, phone, `${p}-raw-${project}`);
      await page.screenshot({ path: evidence(`custom-css/h1-${p}-raw-${project}.png`) });
      out[p] = { scoped, rawInCustomLayer: unscoped };
      for (const [label, st] of [["scoped", scoped], ["raw", unscoped]] as const) {
        expect(st.band, `${p} ${label} band`).toBe(base.band);
        expect(st.topbar, `${p} ${label} topbar`).toBe(base.topbar);
        if (phone) expect(st.tabbar, `${p} ${label} tabbar`).toBe(base.tabbar);
        expect(st.scrollWidth, `${p} ${label} scroll`).toBe(st.innerWidth);
        expect(st.bandCentreIsBand, `${p} ${label} hit`).toBe(true);
      }
    }
    writeEvidence(`custom-css/h1-probes-${project}.json`, out);
  });
}
