// Fix 12: the static sky band's grain against the landing page's sky (http://127.0.0.1:3132, read only).
// Grain is measured the same way on both: the standard deviation of luminance after removing the
// smooth gradient (pixel minus its 9x9 box mean), and how much of it survives a 2x2 average (coarse
// grain survives, fine grain averages away).
import { expect, test, type Page } from "@playwright/test";
import { evidence, markSwept, signIn, writeEvidence } from "./helpers";

const LANDING = "http://127.0.0.1:3132/";

async function grainStats(page: Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;
    const L = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = 0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!;
    const hp = (src: Float64Array, w: number, h: number) => {
      const out: number[] = [];
      for (let y = 4; y < h - 4; y++)
        for (let x = 4; x < w - 4; x++) {
          let s = 0;
          for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) s += src[(y + dy) * w + x + dx]!;
          out.push(src[y * w + x]! - s / 81);
        }
      const m = out.reduce((a, b) => a + b, 0) / out.length;
      return Math.sqrt(out.reduce((a, b) => a + (b - m) ** 2, 0) / out.length);
    };
    const fine = hp(L, W, H);
    const w2 = Math.floor(W / 2), h2 = Math.floor(H / 2);
    const L2 = new Float64Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) L2[y * w2 + x] = (L[2 * y * W + 2 * x]! + L[2 * y * W + 2 * x + 1]! + L[(2 * y + 1) * W + 2 * x]! + L[(2 * y + 1) * W + 2 * x + 1]!) / 4;
    const coarse = hp(L2, w2, h2);
    return { grainStd: +fine.toFixed(2), grainStdAt2x: +coarse.toFixed(2), survives2x: +(coarse / fine).toFixed(2) };
  }, png.toString("base64"));
}

test("Fix 12: the static band's grain is close to the landing page's sky grain", async ({ page, context, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project");
  // Round 5: this reads the live landing page on :3132, which Wave 2 builders must not touch. r5-shell
  // measures against the saved landing capture instead. Opt in with ATRIUM_E2E_LANDING=1.
  test.skip(process.env.ATRIUM_E2E_LANDING !== "1", "reads the live landing page on :3132 (opt in with ATRIUM_E2E_LANDING=1)");
  await signIn(page);
  await markSwept(context, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Landing sky (the hero shader, which also renders on this GPU-less host).
  const landing = await context.newPage();
  await landing.setViewportSize({ width: 1440, height: 900 });
  await landing.goto(LANDING);
  await landing.waitForTimeout(2500);
  const lClip = { x: 40, y: 300, width: 240, height: 100 };
  const lpng = await landing.screenshot({ clip: lClip, path: evidence("grain/landing-sky-crop.png") });
  await landing.close();
  // Shell static band, same crop size, away from the mark.
  await page.goto("/integrations");
  await page.waitForLoadState("networkidle");
  const band = await page.locator("[data-sky-band]").boundingBox();
  const sClip = { x: 700, y: band!.y + 10, width: 240, height: 100 };
  const spng = await page.screenshot({ clip: sClip, path: evidence("grain/shell-band-crop.png") });
  const mode = await page.locator("[data-sky-band]").getAttribute("data-sky-band");
  const l = await grainStats(page, lpng);
  const s = await grainStats(page, spng);
  // A side-by-side sheet at 3x, pixelated, for the eye.
  await page.setContent(`<body style="margin:0;background:#222;display:flex;gap:12px;padding:12px">
    <figure style="margin:0;color:#eee;font:12px monospace"><img src="data:image/png;base64,${lpng.toString("base64")}" style="width:720px;image-rendering:pixelated"><figcaption>landing :3132 sky (3x)</figcaption></figure>
    <figure style="margin:0;color:#eee;font:12px monospace"><img src="data:image/png;base64,${spng.toString("base64")}" style="width:720px;image-rendering:pixelated"><figcaption>shell static band (3x)</figcaption></figure></body>`);
  await page.setViewportSize({ width: 1500, height: 360 });
  await page.screenshot({ path: evidence("grain/grain-side-by-side-3x.png") });
  writeEvidence("criteria/fix12-grain.json", { method: "luminance std after a 9x9 box high-pass; survives2x = std after 2x2 averaging / std", landing: l, shellBand: s, bandMode: mode, ratio: +(s.grainStd / l.grainStd).toFixed(2) });
  expect(mode).toBe("static");
  expect(s.grainStd / l.grainStd).toBeGreaterThan(0.6);
  expect(s.grainStd / l.grainStd).toBeLessThan(1.6);
});
