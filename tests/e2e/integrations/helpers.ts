// Integrations e2e helpers: a cached owner session, evidence paths, traffic capture and fake services.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { OWNER } from "../fixtures";

export const PORT = Number(process.env.ATRIUM_E2E_PORT ?? 3113);
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// The round whose evidence folder a run writes to (round 8: ATRIUM_INT_ROUND=r8, so older rounds stay as they were).
export const EVIDENCE = path.join(APP, `evidence/integrations/${process.env.ATRIUM_INT_ROUND ?? "r6"}`);
export const DATA_DIR = path.join(APP, process.env.ATRIUM_E2E_SCENARIO === "locked" ? "data/e2e-integrations-locked" : "data/e2e-integrations");
const STATE = path.join(APP, "test-results/integrations-owner-state.json");

export function ev(...parts: string[]): string {
  const p = path.join(EVIDENCE, ...parts);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/** Signs the owner in once and reuses the session (sign-in is rate limited to 5 per minute). */
export async function ownerState(): Promise<string> {
  if (existsSync(STATE)) {
    const ctx = await request.newContext({ baseURL: ORIGIN, storageState: STATE });
    const ok = (await ctx.get("/api/integrations")).status() === 200;
    await ctx.dispose();
    if (ok) return STATE;
  }
  const ctx = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN } });
  const res = await ctx.post("/api/auth/sign-in/email", { data: OWNER });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()} ${await res.text()}`);
  mkdirSync(path.dirname(STATE), { recursive: true });
  await ctx.storageState({ path: STATE });
  await ctx.dispose();
  return STATE;
}

export type Theme = "daylight" | "dusk" | "solid";
/** Shell screens: Daylight = light, Dusk = dark, Solid = light with reduce transparency (design v2 section 2). */
export async function themedContext(browser: Browser, theme: Theme, opts: { mobile?: boolean; reducedMotion?: boolean; video?: string; storageState?: string } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    storageState: opts.storageState ?? (await ownerState()),
    baseURL: ORIGIN,
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    colorScheme: theme === "dusk" ? "dark" : "light",
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
    ...(opts.video ? { recordVideo: { dir: opts.video, size: { width: 1280, height: 800 } } } : {}),
  });
  await ctx.addCookies([
    { name: "atrium_theme", value: theme === "dusk" ? "dark" : "light", url: ORIGIN },
    { name: "atrium_swept", value: "1", url: ORIGIN },
    ...(theme === "solid" ? [{ name: "atrium_transparency", value: "reduce", url: ORIGIN }] : []),
  ]);
  return ctx;
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
  page.on("request", (q) => {
    if (!q.url().startsWith(ORIGIN)) return;
    // Request bodies legitimately carry typed secrets once (write-only fields); only responses are graded.
    appendFileSync(file, `>>> ${q.method()} ${q.url()}\n`);
  });
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Full-page screenshot once the page is quiet (no pending requests, skeletons gone). */
export async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  await page.locator("[data-skeleton]").first().waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  await page.screenshot({ path: ev(name), fullPage: true });
}

/** A member account in this slot's own database (same recipe as the auth e2e helpers). Test-only password. */
export const MEMBER = { email: "member@atrium.test", password: "e2e-member-password-456" };
const MEMBER_STATE = path.join(APP, "test-results/integrations-member-state.json");

export async function memberState(): Promise<string> {
  const { default: Database } = await import("better-sqlite3");
  const { hash } = await import("@node-rs/argon2");
  const { randomUUID } = await import("node:crypto");
  const d = new Database(path.join(DATA_DIR, "atrium.db"));
  try {
    const existing = d.prepare("SELECT id FROM user WHERE email = ?").get(MEMBER.email) as { id: string } | undefined;
    if (!existing) {
      const id = randomUUID();
      const now = Date.now();
      d.prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, "member", MEMBER.email, 1, "member", 0, now, now);
      const h = await hash(MEMBER.password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
      d.prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, h, now, now);
      d.prepare("INSERT OR IGNORE INTO allowlist (id, pattern, role, created_at) VALUES (?,?,?,?)").run(randomUUID(), MEMBER.email, "member", now);
    }
  } finally {
    d.close();
  }
  if (existsSync(MEMBER_STATE)) {
    const ctx = await request.newContext({ baseURL: ORIGIN, storageState: MEMBER_STATE });
    const ok = (await ctx.get("/api/integrations")).status() === 200;
    await ctx.dispose();
    if (ok) return MEMBER_STATE;
  }
  const ctx = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN } });
  const res = await ctx.post("/api/auth/sign-in/email", { data: MEMBER });
  if (!res.ok()) throw new Error(`member sign-in failed: ${res.status()} ${await res.text()}`);
  await ctx.storageState({ path: MEMBER_STATE });
  await ctx.dispose();
  return MEMBER_STATE;
}

/** Design v4 / A1.7 shell variants: light, dark, and light with reduce transparency. */
export const SHELL_VARIANTS: { name: "light" | "dark" | "light-solid"; theme: Theme }[] = [
  { name: "light", theme: "daylight" },
  { name: "dark", theme: "dusk" },
  { name: "light-solid", theme: "solid" },
];

/** Picks a saved credential by name; option labels also carry the lock, such as "Name (not locked yet)" (r6). */
export async function pickCredential(select: Locator, name: string) {
  const option = select.locator("option").filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`) }).first();
  const value = await option.getAttribute("value", { timeout: 5_000 });
  if (!value) throw new Error(`no saved credential option named ${name}`);
  await select.selectOption(value);
}

/** The owner's step-up sheet, when it opens (it does not within 10 minutes of the last one). */
export async function stepUpIfAsked(page: Page): Promise<boolean> {
  const stepUp = page.locator('[data-sheet="step-up"]');
  if (await stepUp.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) {
    await stepUp.getByLabel("Password").fill(OWNER.password);
    await stepUp.getByRole("button", { name: "Confirm" }).click();
    return true;
  }
  return false;
}

/** Round 6: a first lock or a new server asks "Lock X to <server>?" or "Also allow"; confirm, then the step-up if asked. */
export async function confirmLockAndStepUp(page: Page): Promise<boolean> {
  await page.locator("[data-origin-confirm]").click();
  return stepUpIfAsked(page);
}

/** Test-only: ends every step-up window in this slot's database, so a test that needs the step-up prompt gets it whatever ran before. */
export async function expireStepUps() {
  const { default: Database } = await import("better-sqlite3");
  const d = new Database(path.join(DATA_DIR, "atrium.db"));
  try { d.prepare("UPDATE session SET step_up_at = NULL").run(); } finally { d.close(); }
}

/** Wave 2.7 (A8.1): hand-typed reads (Custom PromQL) sit under a folded Advanced group; open it. */
export async function openAdvanced(page: Page) {
  const adv = page.locator('details[data-endpoint-group="Advanced"]');
  await adv.waitFor({ timeout: 10_000 });
  if (!(await adv.evaluate((d) => (d as HTMLDetailsElement).open))) await adv.locator("summary").click();
}
