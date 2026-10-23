// Renders the brand PNGs from the SVGs with Chromium screenshots, and the logo fidelity evidence.
// Run from app/: node tests/e2e/shell/brand/render_brand.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "../../../..");
const BRAND = path.join(APP, "public/brand");
const EVID = path.join(APP, "evidence/app-shell/r1/logo");
const logo = fs.readFileSync(path.join(APP, "../logo.png")).toString("base64");
const svg = (name) => fs.readFileSync(path.join(BRAND, name), "utf8");
const dataUri = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;
const paths = JSON.parse(fs.readFileSync(path.join(__dirname, "mark-paths.json"), "utf8"));

(async () => {
  const browser = await chromium.launch();
  const shot = async (html, w, h, out, { scheme = "light", transparent = false, scale = 1 } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: scale });
    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><html><body style="margin:0;${transparent ? "background:transparent" : ""}">${html}</body></html>`);
    await page.waitForTimeout(100);
    await page.screenshot({ path: out, omitBackground: transparent });
    await ctx.close();
  };
  const markOnly = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1020 691" width="1020" height="691" style="position:absolute;left:112.5px;top:279.5px">${["L", "R", "D"].map((k) => `<path fill="${fill}" d="${paths[k]}"/>`).join("")}</svg>`;
  const ref = `<img src="data:image/png;base64,${logo}" width="1254" height="1254" style="position:absolute;left:0;top:0">`;

  // 1. Fidelity: traced mark in translucent red over logo.png at the same size.
  await shot(`<div style="position:relative;width:1254px;height:1254px;background:#fff">${ref}<div style="opacity:.55">${markOnly("#ff2a2a")}</div></div>`, 1254, 1254, path.join(EVID, "mark-overlay-on-logo.png"));
  // 2. Difference: white mark with mix-blend-mode difference; agreement is white, any mismatch is dark.
  await shot(`<div style="position:relative;width:1254px;height:1254px;background:#fff;isolation:isolate">${ref}<div style="mix-blend-mode:difference">${markOnly("#fff")}</div></div>`, 1254, 1254, path.join(EVID, "mark-difference.png"));
  // 3. Traced mark alone at the same size (for side by side).
  await shot(`<div style="position:relative;width:1254px;height:1254px;background:#fff">${markOnly("#232323")}</div>`, 1254, 1254, path.join(EVID, "mark-traced.png"));

  // App icons: 192 and 512, light (Daylight) and dark (Dusk).
  for (const [src, suffix] of [["icon-source-light.svg", ""], ["icon-source-dark.svg", "-dark"]]) {
    for (const size of [192, 512]) {
      await shot(`<img src="${dataUri(svg(src))}" width="${size}" height="${size}" style="display:block">`, size, size, path.join(BRAND, `icon${suffix}-${size}.png`));
    }
  }
  // Favicons: 16 and 32 PNG from favicon.svg (light scheme), transparent background.
  for (const size of [16, 32]) {
    await shot(`<img src="${dataUri(svg("favicon.svg"))}" width="${size}" height="${size}" style="display:block">`, size, size, path.join(BRAND, `favicon-${size}.png`), { transparent: true });
  }
  // Evidence: favicons at 1x and enlarged 8x (pixelated), light and dark; full mark at 32px for comparison.
  for (const scheme of ["light", "dark"]) {
    const bg = scheme === "dark" ? "#141210" : "#FBFAF7";
    const fav = dataUri(svg("favicon.svg"));
    const mark = dataUri(svg("mark.svg"));
    await shot(
      `<div style="background:${bg};padding:24px;display:flex;gap:32px;align-items:flex-end;font:12px sans-serif;color:${scheme === "dark" ? "#ddd" : "#333"}">
        <figure style="margin:0"><img src="${fav}" width="16" height="16"><figcaption>16px</figcaption></figure>
        <figure style="margin:0"><img src="${fav}" width="32" height="32"><figcaption>32px</figcaption></figure>
        <figure style="margin:0"><img src="${fav}" width="16" height="16" style="width:128px;height:128px;image-rendering:pixelated"><figcaption>16px at 8x</figcaption></figure>
        <figure style="margin:0"><img src="${fav}" width="32" height="32" style="width:256px;height:256px;image-rendering:pixelated"><figcaption>32px at 8x (gap closed, doorway kept)</figcaption></figure>
        <figure style="margin:0"><img src="${mark}" width="47" height="32" style="width:376px;height:256px;image-rendering:pixelated"><figcaption>full mark at 32px tall, 8x (gap visible)</figcaption></figure>
      </div>`,
      900, 340, path.join(EVID, `favicons-${scheme}.png`), { scheme },
    );
  }
  // Evidence: app icons side by side.
  await shot(
    `<div style="background:#888;padding:24px;display:flex;gap:24px;align-items:flex-end">
      ${["icon-192.png", "icon-512.png", "icon-dark-192.png", "icon-dark-512.png"].map((f) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(BRAND, f)).toString("base64")}" width="${f.includes("512") ? 256 : 192}" style="border-radius:22%">`).join("")}
    </div>`,
    1040, 320, path.join(EVID, "app-icons.png"),
  );
  // Evidence: wordmark and mark variants in both schemes.
  for (const scheme of ["light", "dark"]) {
    const bg = scheme === "dark" ? "#141210" : "#FBFAF7";
    await shot(
      `<div style="background:${bg};padding:40px;display:flex;flex-direction:column;gap:40px">
        <img src="${dataUri(svg("wordmark.svg"))}" height="200" style="height:200px;width:auto;align-self:flex-start" data-wordmark>
        <div style="display:flex;gap:48px"><img src="${dataUri(svg("mark.svg"))}" height="160" style="height:160px"><img src="${dataUri(svg("mark-lit.svg"))}" height="160" style="height:160px"></div>
      </div>`,
      1100, 520, path.join(EVID, `wordmark-and-marks-${scheme}.png`), { scheme },
    );
  }
  await browser.close();
  console.log("rendered");
})();
