// Helpers for the auth e2e specs. The server must already run on the auth slot (tests/e2e/auth/serve.sh),
// which Playwright reuses; each scenario spec checks it is talking to the scenario it expects.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { hash } from "@node-rs/argon2";
import type { BrowserContext, Page } from "@playwright/test";

export { totp, secretFromUri } from "../../../src/features/auth/test/totp";

export const EVIDENCE = path.resolve(`evidence/auth/${process.env.ATRIUM_E2E_ROUND ?? "r2"}`);
mkdirSync(EVIDENCE, { recursive: true });
export const shot = (name: string) => path.join(EVIDENCE, `${name}.png`);

export const DATA_DIR = path.resolve(process.env.ATRIUM_E2E_DATA ?? "data/e2e-auth");
export const SCENARIO = process.env.ATRIUM_E2E_SCENARIO ?? "owner";

export type Variant = { name: "light" | "dark" | "light-solid"; theme: "light" | "dark"; solid: boolean };
// Design v2 section 2: shell-only screens are captured in light, dark, and light with reduce transparency.
export const VARIANTS: Variant[] = [
  { name: "light", theme: "light", solid: false },
  { name: "dark", theme: "dark", solid: false },
  { name: "light-solid", theme: "light", solid: true },
];

export async function applyVariant(context: BrowserContext, v: Variant, baseURL: string) {
  const url = baseURL;
  await context.addCookies([
    { name: "atrium_theme", value: v.theme, url },
    ...(v.solid ? [{ name: "atrium_transparency", value: "reduce", url }] : []),
  ]);
}

let n = 1;
/** A fresh client address per test, so the per-IP sign-in limit of one test never blocks another. */
export function freshIp(): string {
  n += 1;
  return `198.51.${100 + Math.floor(Math.random() * 50)}.${(n % 250) + 1}`;
}

export function db() {
  return new Database(path.join(DATA_DIR, "atrium.db"));
}

export async function addUser(email: string, role: "member" | "viewer", password: string) {
  const d = db();
  try {
    const existing = d.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string } | undefined;
    if (existing) return existing.id;
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

export async function signInUI(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Worst-case text contrast on the page: each text node's colour against its composited background. */
export async function minContrast(page: Page): Promise<{ ratio: number; text: string }> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const over = (top: number[], bottom: number[]) => {
      const a = top[3]!;
      return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1);
    };
    const bgOf = (el: Element | null): number[] => {
      const layers: number[][] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let acc = parse(getComputedStyle(document.body).backgroundColor);
      if (acc[3] < 1) acc = [255, 255, 255, 1];
      for (const l of layers.reverse()) acc = over(l, acc) as [number, number, number, number];
      return acc;
    };
    let worst = { ratio: 21, text: "" };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      if (!el || !t.textContent?.trim()) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[aria-hidden=true]")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if ((el as HTMLButtonElement).disabled || el.closest("button:disabled")) continue; // WCAG exempts disabled controls
      const bg = bgOf(el);
      const fg = over(parse(cs.color), bg);
      const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (l1! + 0.05) / (l2! + 0.05);
      if (ratio < worst.ratio) worst = { ratio, text: t.textContent.trim().slice(0, 40) };
    }
    return worst;
  });
}

/** Tabs through the page and records each focused control: focus ring width and target size. */
export async function tabAudit(page: Page, max = 20, scope?: string) {
  const seen: { tag: string; label: string; outline: string; w: number; h: number; inScope: boolean }[] = [];
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate((scope) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute("aria-label") || el.textContent || (el as HTMLInputElement).name || "").trim().slice(0, 40),
        outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineOffset}`,
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: el.matches(":focus-visible"),
        // Round 5: /account now sits inside the shell, so its tab order starts with app-shell's top bar.
        inScope: scope ? !!el.closest(scope) : true,
      };
    }, scope);
    if (!info) break;
    if (seen.some((s) => s.tag === info.tag && s.label === info.label)) break;
    seen.push(info);
  }
  return seen;
}
