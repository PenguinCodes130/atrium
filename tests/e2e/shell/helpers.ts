// app-shell e2e helpers (round 3, design v4): sign-in, the preview route, evidence paths, colour maths.
import type { BrowserContext, Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER } from "../fixtures";

// Round 5: ATRIUM_SHELL_ROUND=r5 writes a new round folder, so earlier evidence stays as it was.
export const EVIDENCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../../evidence/app-shell/${process.env.ATRIUM_SHELL_ROUND ?? "r4"}`);
export function evidence(...parts: string[]): string {
  const p = path.join(EVIDENCE, ...parts);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
export function writeEvidence(name: string, data: unknown) {
  writeFileSync(evidence(name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

/** Sign in as the e2e owner through Better Auth (the auth proxy is default-deny). */
export const ORIGIN = `http://127.0.0.1:${process.env.ATRIUM_E2E_PORT ?? 3102}`;
// Sign-in is rate limited (10 per account per hour), so the session cookie is reused across tests
// from a file under test-results/ (never evidence).
const SESSION_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-results/app-shell-session.json");
export async function signIn(page: Page) {
  const ctx = page.context();
  if (existsSync(SESSION_FILE)) {
    await ctx.addCookies(JSON.parse(readFileSync(SESSION_FILE, "utf8")));
    const check = await page.request.get("/api/auth/get-session");
    if (check.ok() && (await check.text()).includes(OWNER.email)) return;
    await ctx.clearCookies();
  }
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: OWNER.email, password: OWNER.password },
    headers: { origin: ORIGIN },
  });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()}`);
  mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify((await ctx.cookies()).filter((c) => c.name.startsWith("atrium.session"))), { mode: 0o600 });
}

export type PreviewOpts = {
  scene?: string;
  theme?: "controlRoom" | "daylight" | "dusk" | "solid";
  n?: number;
  approvals?: number;
  drafts?: number;
  sweep?: "force";
  drift?: string;
  toasts?: number;
  css?: string;
  font?: string;
  viewer?: "user" | "guest";
  edit?: 0 | 1;
  draft?: 1;
};
export function previewUrl(o: PreviewOpts = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return `/__shell-preview${s ? `?${s}` : ""}`;
}

/** Mark the sweep as already played this session so screens render lit. */
export async function markSwept(context: BrowserContext, baseURL: string) {
  await context.addCookies([{ name: "atrium_swept", value: "1", url: baseURL }]);
}
export async function setPrefCookies(context: BrowserContext, baseURL: string, prefs: { theme?: "light" | "dark"; motion?: boolean; transparency?: boolean }) {
  const c = [];
  if (prefs.theme) c.push({ name: "atrium_theme", value: prefs.theme, url: baseURL });
  if (prefs.motion) c.push({ name: "atrium_motion", value: "reduce", url: baseURL });
  if (prefs.transparency) c.push({ name: "atrium_transparency", value: "reduce", url: baseURL });
  if (c.length) await context.addCookies(c);
}

/** Emulate prefers-reduced-transparency through CDP (Playwright has no option for it). */
export async function emulateReducedTransparency(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  return cdp;
}

// ---- Colour maths (OKLCH and sRGB, WCAG relative luminance) ----
export type RGBA = { r: number; g: number; b: number; a: number }; // 0..1 sRGB-encoded

export function oklchToRgb(L: number, C: number, h: number, a = 1): RGBA {
  const hr = (h * Math.PI) / 180;
  return oklabToRgb(L, C * Math.cos(hr), C * Math.sin(hr), a);
}
export function oklabToRgb(L: number, A: number, B: number, a = 1): RGBA {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const enc = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  };
  return { r: enc(lin[0]!), g: enc(lin[1]!), b: enc(lin[2]!), a };
}

/** CIE Lab (D50, as Chromium serialises computed colours) to sRGB. */
export function labToRgb(L: number, A: number, B: number, a = 1): RGBA {
  const e = 216 / 24389, k = 24389 / 27;
  const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
  const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const yr = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
  const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  const [X, Y, Z] = [xr * 0.3457 / 0.3585, yr, zr * (1 - 0.3457 - 0.3585) / 0.3585];
  // Bradford D50 -> D65
  const X65 = 0.9554734527042182 * X - 0.023098536874261423 * Y + 0.0632593086610217 * Z;
  const Y65 = -0.028369706963208136 * X + 1.0099954580058226 * Y + 0.021041398966943008 * Z;
  const Z65 = 0.012314001688319899 * X - 0.020507696433477912 * Y + 1.3303659366080753 * Z;
  const lin = [3.2409699419045226 * X65 - 1.537383177570094 * Y65 - 0.4986107602930034 * Z65, -0.9692436362808796 * X65 + 1.8759675015077202 * Y65 + 0.04155505740717559 * Z65, 0.05563007969699366 * X65 - 0.20397695888897652 * Y65 + 1.0569715142428786 * Z65];
  const enc = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  };
  return { r: enc(lin[0]!), g: enc(lin[1]!), b: enc(lin[2]!), a };
}

/** Raw (specified) values of custom properties on :root. */
export async function rawTokens(page: Page, names: string[]): Promise<Record<string, string>> {
  return page.evaluate((names) => Object.fromEntries(names.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()])), names);
}

/** Parse a computed CSS colour string (oklch, oklab, rgb, color(srgb)). */
export function parseColor(s: string): RGBA {
  const num = (v: string) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v));
  const inner = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")).replace(/,/g, " ");
  const [main, alpha] = inner.split("/").map((x) => x.trim());
  const parts = main!.split(/\s+/).filter(Boolean);
  const a = alpha !== undefined ? num(alpha) : 1;
  if (s.startsWith("oklch")) return oklchToRgb(num(parts[0]!), parseFloat(parts[1]!), parseFloat(parts[2]!) || 0, a);
  if (s.startsWith("oklab")) return oklabToRgb(num(parts[0]!), parseFloat(parts[1]!), parseFloat(parts[2]!), a);
  if (s.startsWith("lab")) return labToRgb(parseFloat(parts[0]!), parseFloat(parts[1]!), parseFloat(parts[2]!), a);
  if (s.startsWith("color(srgb")) return { r: +parts[1]!, g: +parts[2]!, b: +parts[3]!, a };
  if (s.startsWith("rgb")) return { r: +parts[0]! / 255, g: +parts[1]! / 255, b: +parts[2]! / 255, a: parts[3] !== undefined ? +parts[3] : a };
  throw new Error(`unparsed colour ${s}`);
}

export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a + bottom.a * (1 - top.a);
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / (a || 1);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}
/** Alpha compositing in linear light (the method design v2 section 6 used for its glass numbers). */
export function overLinear(top: RGBA, bottom: RGBA): RGBA {
  const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const mix = (t: number, b: number) => enc(dec(t) * top.a + dec(b) * (1 - top.a));
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}
export const sameColor = (a: string, b: string, tol = 1) => {
  const x = parseColor(a), y = parseColor(b);
  return [x.r - y.r, x.g - y.g, x.b - y.b].every((d) => Math.abs(d * 255) <= tol) && Math.abs(x.a - y.a) < 0.01;
};
export const WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };
export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

export function luminance(c: RGBA): number {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
export function contrast(fg: RGBA, bg: RGBA): number {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function to255(c: RGBA): [number, number, number] {
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}

/** Read computed colours for CSS custom properties on :root (resolved through a probe element). */
export async function tokenColors(page: Page, names: string[]): Promise<Record<string, string>> {
  return page.evaluate((names) => {
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    const out: Record<string, string> = {};
    for (const n of names) {
      probe.style.color = `var(${n})`;
      out[n] = getComputedStyle(probe).color;
    }
    probe.remove();
    return out;
  }, names);
}

/** Pixel at (x, y) of a PNG screenshot buffer, via the browser's own decoder. */
export async function samplePixels(page: Page, png: Buffer, points: [number, number][]): Promise<[number, number, number][]> {
  return page.evaluate(
    async ({ b64, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return points.map(([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!] as [number, number, number];
      });
    },
    { b64: png.toString("base64"), points },
  );
}

/** Navigate and wait until streamed segments are swapped in (loading.tsx streams the page). */
export async function go(page: Page, url: string) {
  const res = await page.goto(url);
  await page.waitForFunction(() => !document.querySelector('div[hidden][id^="S:"]') && (location.protocol === "about:" || document.documentElement.hasAttribute("data-hydrated")));
  await page.waitForLoadState("load");
  // Screenshots compare pixels: wait until the self-hosted fonts have swapped in.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return res;
}

/** Design v4 palette (section 1), light and dark. */
export const PALETTE = {
  light: { bg: "#F3EFE4", bgHi: "#FBF9F3", bgSunk: "#E9E3D3", fg: "#15130F", fg2: "#3B372F", fg3: "#5F5A4F", titlebar: "#15130F", accent: "#E9B949", accentHi: "#F6D98B", accentInk: "#8E6416", sky: "#A9C8E4", skyInk: "#2D5A85", ok: "#2F7A4D", warn: "#B5770C", warnInk: "#8F5C05", bad: "#B23B25" },
  dark: { bg: "#15130F", bgHi: "#1D1A15", bgSunk: "#2A261F", fg: "#F3EFE4", fg2: "#CFC8B8", fg3: "#A39C8C", titlebar: "#2A261F", accent: "#E9B949", accentHi: "#F6D98B", accentInk: "#F0C962", sky: "#2D5A85", skyInk: "#7FA8CF", ok: "#5DBB82", warn: "#E0A23A", warnInk: "#E0A23A", bad: "#F07A62" },
} as const;
export function hex(c: RGBA): string {
  return "#" + to255(c).map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}
export function hexToRgba(h: string, a = 1): RGBA {
  const x = h.replace("#", "");
  return { r: parseInt(x.slice(0, 2), 16) / 255, g: parseInt(x.slice(2, 4), 16) / 255, b: parseInt(x.slice(4, 6), 16) / 255, a };
}
/** Max channel difference between two hex colours, 0..255. */
export function hexDelta(a: string, b: string): number {
  const x = to255(hexToRgba(a)), y = to255(hexToRgba(b));
  return Math.max(...x.map((v, i) => Math.abs(v - y[i]!)));
}
/** Colour of the pixel at (x, y) in a fresh viewport screenshot, as #RRGGBB. */
export async function pixelAt(page: Page, x: number, y: number): Promise<string> {
  const png = await page.screenshot();
  const [r, g, b] = (await samplePixels(page, png, [[Math.round(x), Math.round(y)]]))[0]!;
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** A new signed-in desktop context (light unless told otherwise), with optional shell preference cookies. */
export async function fresh(browser: import("@playwright/test").Browser, opts: import("@playwright/test").BrowserContextOptions = {}, prefs: Parameters<typeof setPrefCookies>[2] = {}, swept = true) {
  const ctx = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  await signIn(page);
  await setPrefCookies(ctx, ORIGIN, prefs);
  if (swept) await markSwept(ctx, ORIGIN);
  return { ctx, page };
}
