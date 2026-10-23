// Design v4 brand assets (section 5): writes public/brand/*.svg in the v4 palette and renders the PNG
// favicons and app icons with Chromium; evidence goes to evidence/app-shell/r3/logo/.
//   mark.svg      one colour: ink #15130F (paper #F3EFE4 in dark), doorway the same colour
//   mark-lit.svg  the lit variant: doorway gold #E9B949
//   favicon.svg   16/32px: the band gap closed (a stroke in the band colour), lit doorway
//   icon-*.png    192 and 512: lit mark in ink on paper #F3EFE4; icon-dark-*: paper on ink #15130F; square
// The paths are the r1 trace (mark-paths.json). wordmark.svg (outlined r1 text) is left unchanged.
// Run from app/: node tests/e2e/shell/brand/make_brand_v4.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "../../../..");
const BRAND = path.join(APP, "public/brand");
const EVID = path.join(APP, "evidence/app-shell/r3/logo");
fs.mkdirSync(EVID, { recursive: true });
const P = JSON.parse(fs.readFileSync(path.join(__dirname, "mark-paths.json"), "utf8"));
const INK = "#15130F", PAPER = "#F3EFE4", GOLD = "#E9B949";
const W = 1020, H = 691;

const scheme = (band, door) => `<style>.b{fill:${band}}.d{fill:${door}}@media (prefers-color-scheme:dark){.b{fill:${PAPER}}${door === band ? `.d{fill:${PAPER}}` : ""}}</style>`;
const bands = (cls = "b") => `<path class="${cls}" d="${P.L}"/><path class="${cls}" d="${P.R}"/>`;
const write = (name, s) => fs.writeFileSync(path.join(BRAND, name), s + "\n");
const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><title>Atrium</title>`;
write("mark.svg", head + scheme(INK, INK) + bands() + `<path class="d" d="${P.D}"/></svg>`);
write("mark-lit.svg", head + scheme(INK, GOLD) + bands() + `<path class="d" d="${P.D}"/></svg>`);
const S = 1100;
write(
  "favicon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-(S - W) / 2} ${-(S - H) / 2} ${S} ${S}" width="32" height="32"><title>Atrium</title>` +
    `<style>.g{fill:${INK};stroke:${INK};stroke-width:22;stroke-linejoin:round}.d{fill:${GOLD}}@media (prefers-color-scheme:dark){.g{fill:${PAPER};stroke:${PAPER}}}</style>` +
    bands("g") + `<path class="d" d="${P.D}"/></svg>`,
);
const icon = (bg, fg) => {
  const size = 512, mw = size * 0.62, sc = mw / W, tx = (size - mw) / 2, ty = (size - H * sc) / 2 + size * 0.02;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${bg}"/><g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${sc.toFixed(5)})"><path fill="${fg}" d="${P.L}"/><path fill="${fg}" d="${P.R}"/><path fill="${GOLD}" d="${P.D}"/></g></svg>`;
};
write("icon-source-light.svg", icon(PAPER, INK));
write("icon-source-dark.svg", icon(INK, PAPER));

const svg = (name) => fs.readFileSync(path.join(BRAND, name), "utf8");
const dataUri = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;
const browser = await chromium.launch();
const shot = async (html, w, h, out, { colorScheme = "light", transparent = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0;${transparent ? "background:transparent" : ""}">${html}</body></html>`);
  await page.waitForTimeout(100);
  await page.screenshot({ path: out, omitBackground: transparent });
  await ctx.close();
};
for (const [src, suffix] of [["icon-source-light.svg", ""], ["icon-source-dark.svg", "-dark"]])
  for (const size of [192, 512]) await shot(`<img src="${dataUri(svg(src))}" width="${size}" height="${size}" style="display:block">`, size, size, path.join(BRAND, `icon${suffix}-${size}.png`));
for (const size of [16, 32]) await shot(`<img src="${dataUri(svg("favicon.svg"))}" width="${size}" height="${size}" style="display:block">`, size, size, path.join(BRAND, `favicon-${size}.png`), { transparent: true });
for (const colorScheme of ["light", "dark"]) {
  const bg = colorScheme === "dark" ? INK : PAPER;
  const fav = dataUri(svg("favicon.svg"));
  await shot(
    `<div style="background:${bg};padding:24px;display:flex;gap:32px;align-items:flex-end;font:12px monospace;color:${colorScheme === "dark" ? PAPER : INK}">
      <figure style="margin:0"><img src="${fav}" width="16" height="16"><figcaption>16px</figcaption></figure>
      <figure style="margin:0"><img src="${fav}" width="32" height="32"><figcaption>32px</figcaption></figure>
      <figure style="margin:0"><img src="${fav}" width="16" height="16" style="width:128px;height:128px;image-rendering:pixelated"><figcaption>16px at 8x</figcaption></figure>
      <figure style="margin:0"><img src="${fav}" width="32" height="32" style="width:256px;height:256px;image-rendering:pixelated"><figcaption>32px at 8x: gap closed, gold doorway</figcaption></figure>
      <figure style="margin:0"><img src="${dataUri(svg("mark-lit.svg"))}" height="160" style="height:160px"><figcaption>lit mark</figcaption></figure>
      <figure style="margin:0"><img src="${dataUri(svg("mark.svg"))}" height="160" style="height:160px"><figcaption>one colour</figcaption></figure>
    </div>`,
    1100, 340, path.join(EVID, `favicons-and-marks-${colorScheme}.png`), { colorScheme },
  );
}
await shot(
  `<div style="background:#888;padding:24px;display:flex;gap:24px;align-items:flex-end">${["icon-192.png", "icon-512.png", "icon-dark-192.png", "icon-dark-512.png"].map((f) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(BRAND, f)).toString("base64")}" width="${f.includes("512") ? 256 : 192}">`).join("")}</div>`,
  1040, 320, path.join(EVID, "app-icons.png"),
);
await browser.close();
console.log("brand v4 written");
