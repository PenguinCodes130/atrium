// Settings e2e helpers (round 1). The server runs from the isolated build on the settings slot
// (tests/e2e/settings/serve.sh); Playwright reuses it. Test-only passwords; none are real credentials.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { hash } from "@node-rs/argon2";
import { request, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { OWNER } from "../fixtures";

export { OWNER };
export const PORT = Number(process.env.ATRIUM_E2E_PORT ?? 3116);
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// ATRIUM_E2E_EVIDENCE_ROUND (default r1) picks the evidence folder, so earlier rounds stay as they were.
export const EVIDENCE = path.join(APP, `evidence/settings/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}`);
export const DATA_DIR = path.join(APP, process.env.ATRIUM_E2E_SCENARIO === "locked" ? "data/e2e-settings-locked" : "data/e2e-settings");
export const MEMBER = { email: "member@atrium.test", password: "e2e-member-password-123" };
export const VIEWER = { email: "viewer@atrium.test", password: "e2e-viewer-password-123" };

export function ev(...parts: string[]): string {
  const p = path.join(EVIDENCE, ...parts);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

export function db() {
  return new Database(path.join(DATA_DIR, "atrium.db"));
}

export async function addUser(email: string, role: "member" | "viewer", password: string) {
  const d = db();
  try {
    const existing = d.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string } | undefined;
    if (existing) {
      // r2: a backup import (f-r2 spec) keeps users but never their password hashes; give the test
      // password back so later specs can sign in again.
      if (!d.prepare("SELECT 1 FROM account WHERE user_id = ? AND provider_id = 'credential'").get(existing.id)) {
        const now = Date.now();
        const h = await hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
        d.prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), existing.id, "credential", existing.id, h, now, now);
      }
      return existing.id;
    }
    const id = randomUUID();
    const now = Date.now();
    d.prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, email.split("@")[0], email, 1, role, 0, now, now);
    const h = await hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    d.prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, h, now, now);
    d.prepare("INSERT OR IGNORE INTO allowlist (id, pattern, role, created_at) VALUES (?,?,?,?)").run(randomUUID(), email, role, now);
    return id;
  } finally {
    d.close();
  }
}

let ipN = 10;
const freshIp = () => `198.51.100.${(ipN++ % 240) + 10}`;

/** Signs a person in once per run and reuses the session (sign-in is rate limited). */
export async function stateFor(who: { email: string; password: string }): Promise<string> {
  const file = path.join(APP, `test-results/settings-${who.email.split("@")[0]}-state${process.env.ATRIUM_E2E_SCENARIO === "locked" ? "-locked" : ""}.json`);
  if (existsSync(file)) {
    const ctx = await request.newContext({ baseURL: ORIGIN, storageState: file });
    const ok = (await ctx.get("/api/settings/preferences")).status() === 200;
    await ctx.dispose();
    if (ok) return file;
  }
  const ctx = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN, "x-forwarded-for": freshIp() } });
  const res = await ctx.post("/api/auth/sign-in/email", { data: who });
  if (!res.ok()) throw new Error(`sign-in failed for ${who.email}: ${res.status()} ${await res.text()}`);
  mkdirSync(path.dirname(file), { recursive: true });
  await ctx.storageState({ path: file });
  await ctx.dispose();
  return file;
}

export type Variant = "light" | "dark" | "light-solid";
export const VARIANTS: Variant[] = ["light", "dark", "light-solid"];

export async function context(browser: Browser, who: { email: string; password: string }, opts: { variant?: Variant; mobile?: boolean; reducedMotion?: boolean } = {}): Promise<BrowserContext> {
  const v = opts.variant ?? "light";
  const ctx = await browser.newContext({
    storageState: await stateFor(who),
    baseURL: ORIGIN,
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    colorScheme: v === "dark" ? "dark" : "light",
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  await ctx.addCookies([
    { name: "atrium_theme", value: v === "dark" ? "dark" : "light", url: ORIGIN },
    { name: "atrium_swept", value: "1", url: ORIGIN },
    ...(v === "light-solid" ? [{ name: "atrium_transparency", value: "reduce", url: ORIGIN }] : []),
  ]);
  return ctx;
}

/** Full-page screenshot once the page is quiet. */
export async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(250);
  await page.screenshot({ path: ev("screens", `${name}.png`), fullPage: true });
}

/** Records every response body from Atrium's own origin for the V10 grep. */
export function captureTraffic(page: Page, name: string) {
  const file = ev("traffic", `${name}.txt`);
  writeFileSync(file, "");
  page.on("response", async (r) => {
    if (!r.url().startsWith(ORIGIN)) return;
    let body = "";
    try { body = (await r.body()).toString("utf8"); } catch { body = "(no body)"; }
    appendFileSync(file, `### ${r.request().method()} ${r.url()} ${r.status()}\n${body}\n`);
  });
}

/** Worst text contrast on screen (each text node against its composited background). */
export async function minContrast(page: Page): Promise<{ ratio: number; text: string }> {
  return page.evaluate(() => {
    const parse = (c: string): number[] => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const lum = (c: number[]) => [0, 1, 2].map((i) => { const s = c[i]! / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const over = (t: number[], b: number[]) => [0, 1, 2].map((i) => t[i]! * t[3]! + b[i]! * (1 - t[3]!)).concat(1);
    const bgOf = (el: Element | null) => {
      const layers: number[][] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3]! > 0) layers.push(c);
        if (c[3]! >= 1) break;
      }
      let acc = parse(getComputedStyle(document.body).backgroundColor);
      if (acc[3]! < 1) acc = [255, 255, 255, 1];
      for (const l of layers.reverse()) acc = over(l, acc);
      return acc;
    };
    let worst = { ratio: 21, text: "" };
    const walker = document.createTreeWalker(document.querySelector("[data-settings-screen]") ?? document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      if (!el || !t.textContent?.trim()) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[aria-hidden=true],[data-atrium-canvas],.sr-only,option")) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || (el as HTMLButtonElement).disabled || el.closest("button:disabled")) continue;
      const bg = bgOf(el);
      const fg = over(parse(cs.color), bg);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (a! + 0.05) / (b! + 0.05);
      if (ratio < worst.ratio) worst = { ratio, text: t.textContent.trim().slice(0, 40) };
    }
    return worst;
  });
}
