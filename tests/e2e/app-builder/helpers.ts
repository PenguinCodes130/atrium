// app-builder e2e helpers. The server runs from tests/e2e/app-builder/serve.sh on the app-builder slot
// (port 3115). Users are seeded straight into the slot database (argon2 hashes, like auth's helpers),
// the fake Home Assistant runs in the test process, and API calls carry the Origin header.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { hash } from "@node-rs/argon2";
import { request, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

export const PORT = Number(process.env.ATRIUM_E2E_PORT ?? 3115);
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const H = { origin: ORIGIN };
// ATRIUM_E2E_DATA_DIR lets another slot run these specs against its own server and data folder.
export const DATA_DIR = path.resolve(process.env.ATRIUM_E2E_DATA_DIR ?? "data/e2e-app-builder");
// ATRIUM_E2E_EVIDENCE_ROUND (default r1) picks the evidence folder, so earlier rounds stay as they were.
export const EVIDENCE = path.resolve(`evidence/app-builder/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}`);
mkdirSync(EVIDENCE, { recursive: true });
export const ev = (...p: string[]) => { const f = path.join(EVIDENCE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
export const log = (name: string, data: unknown) => appendFileSync(ev("logs", "e2e.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), name, data })}\n`);

export const OWNER = { email: "owner@atrium.test", password: "e2e-owner-password-123" };
export const PEOPLE = {
  editor: { email: "erin@atrium.test", password: "e2e-member-password-123", role: "member" as const, name: "Erin" },
  watcher: { email: "wes@atrium.test", password: "e2e-member-password-456", role: "member" as const, name: "Wes" },
  viewer: { email: "vic@atrium.test", password: "e2e-viewer-password-789", role: "viewer" as const, name: "Vic" },
};
/** Test-only token for the fake Home Assistant. */
export const FAKE_HA_TOKEN = "atrium-ab-FAKE-ha-token-5e7d2c1a9f03";

export function db() {
  return new Database(path.join(DATA_DIR, "atrium.db"));
}

export async function addUser(p: { email: string; password: string; role: "member" | "viewer"; name: string }): Promise<string> {
  const d = db();
  try {
    const existing = d.prepare("SELECT id FROM user WHERE email = ?").get(p.email) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = Date.now();
    d.prepare("INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, p.name, p.email, 1, p.role, 0, now, now);
    const h = await hash(p.password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    d.prepare("INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, "credential", id, h, now, now);
    d.prepare("INSERT OR IGNORE INTO allowlist (id, pattern, role, created_at) VALUES (?,?,?,?)").run(randomUUID(), p.email, p.role, now);
    return id;
  } finally {
    d.close();
  }
}

export function userId(email: string): string {
  const d = db();
  try {
    return (d.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string }).id;
  } finally {
    d.close();
  }
}

let ipN = 10;
const states = new Map<string, string>();
/** A signed-in storage state per person (sign-in is rate limited, so each person signs in once). */
export async function stateFor(who: { email: string; password: string }): Promise<string> {
  const file = path.resolve(`test-results/app-builder-${PORT === 3115 ? "" : `${PORT}-`}${who.email}.json`);
  if (states.has(who.email) && existsSync(file)) return file;
  const ctx = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { ...H, "x-forwarded-for": `198.51.100.${ipN++}` } });
  const res = await ctx.post("/api/auth/sign-in/email", { data: { email: who.email, password: who.password } });
  if (!res.ok()) throw new Error(`sign-in failed for ${who.email}: ${res.status()} ${await res.text()}`);
  mkdirSync(path.dirname(file), { recursive: true });
  await ctx.storageState({ path: file });
  await ctx.dispose();
  states.set(who.email, file);
  return file;
}

export async function api(who: { email: string; password: string }): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN, storageState: await stateFor(who), extraHTTPHeaders: H });
}

export type Variant = { name: string; theme: "light" | "dark"; solid: boolean };
export const SHELL_VARIANTS: Variant[] = [
  { name: "light", theme: "light", solid: false },
  { name: "dark", theme: "dark", solid: false },
  { name: "light-solid", theme: "light", solid: true },
];

export async function contextFor(browser: Browser, who: { email: string; password: string } | null, opts: { variant?: Variant; viewport?: { width: number; height: number }; reducedMotion?: "reduce" | "no-preference"; recordVideo?: string; mobile?: boolean } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    baseURL: ORIGIN,
    ...(who ? { storageState: await stateFor(who) } : {}),
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}),
    ...(opts.recordVideo ? { recordVideo: { dir: opts.recordVideo, size: opts.viewport ?? { width: 1280, height: 800 } } } : {}),
    ...(opts.variant ? { colorScheme: opts.variant.theme } : {}),
  });
  if (opts.variant) {
    await ctx.addCookies([
      { name: "atrium_theme", value: opts.variant.theme, url: ORIGIN },
      { name: "atrium_swept", value: "1", url: ORIGIN },
      ...(opts.variant.solid ? [{ name: "atrium_transparency", value: "reduce", url: ORIGIN }] : []),
    ]);
  }
  return ctx;
}

/** Records every response body a page receives (V10 and the guest data check). */
export function captureTraffic(page: Page, name: string): { bodies: { url: string; status: number; body: string }[] } {
  const out = { bodies: [] as { url: string; status: number; body: string }[] };
  page.on("response", async (r) => {
    try {
      const ct = r.headers()["content-type"] ?? "";
      if (!/json|text|javascript|event-stream|manifest/.test(ct)) return;
      const body = await r.text().catch(() => "");
      out.bodies.push({ url: r.url(), status: r.status(), body });
      appendFileSync(ev("network", `${name}.jsonl`), `${JSON.stringify({ url: r.url(), status: r.status(), len: body.length })}\n`);
    } catch { /* closed */ }
  });
  return out;
}

export function saveText(rel: string, text: string) {
  writeFileSync(ev(rel), text);
}

// ---- A fake Home Assistant with 48 lights (test-only) ----

export type FakeHa = { url: string; close(): Promise<void>; services: { path: string; body: unknown }[]; states(): { entity_id: string; state: string }[] };

export async function fakeHa(): Promise<FakeHa> {
  const services: FakeHa["services"] = [];
  const on = new Set<string>(["light.porch"]);
  const ids = ["light.lamp", "light.porch", ...Array.from({ length: 46 }, (_, i) => `light.secret_room_${String(i + 1).padStart(2, "0")}`)];
  const states = () => ids.map((id) => ({ entity_id: id, state: on.has(id) ? "on" : "off", attributes: { friendly_name: id === "light.lamp" ? "Bedroom lamp" : id === "light.porch" ? "Porch" : `Hidden ${id.slice(-2)}` }, last_changed: new Date().toISOString() }));
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const s = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/manifest.json") return json(res, 200, { name: "Home Assistant" });
      if (req.headers.authorization !== `Bearer ${FAKE_HA_TOKEN}`) return json(res, 401, { message: "401: Unauthorized" });
      if (u.pathname === "/api/" || u.pathname === "/api") return json(res, 200, { message: "API running." });
      if (u.pathname === "/api/config") return json(res, 200, { version: "2026.10.1", location_name: "Home" });
      if (u.pathname === "/api/states") return json(res, 200, states());
      // One entity (the data picker's "One entity" read, Wave 2.5).
      const one = /^\/api\/states\/([a-z_]+\.[a-z0-9_]+)$/.exec(u.pathname);
      if (one) { const st = states().find((x) => x.entity_id === one[1]); return st ? json(res, 200, st) : json(res, 404, { message: "Entity not found." }); }
      const m = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(u.pathname);
      if (m && req.method === "POST") {
        const body = raw ? JSON.parse(raw) : null;
        services.push({ path: u.pathname, body });
        const id = (body as { entity_id?: string })?.entity_id;
        if (id && m[2] === "toggle") { if (on.has(id)) on.delete(id); else on.add(id); }
        return json(res, 200, []);
      }
      json(res, 404, { message: "not found" });
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, services, states: () => states().map(({ entity_id, state }) => ({ entity_id, state })), close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

export function controlRunCount(appId: string): number {
  const d = db();
  try {
    return (d.prepare("SELECT COUNT(*) AS n FROM control_run WHERE app_id = ?").get(appId) as { n: number }).n;
  } catch {
    return -1;
  } finally {
    d.close();
  }
}

export function auditCount(event: string, appId: string): number {
  const d = db();
  try {
    return (d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = ? AND target_id = ?").get(event, appId) as { n: number }).n;
  } finally {
    d.close();
  }
}

/**
 * Writes an agent's draft change straight into the slot database, the way applyDraftOps records one
 * (agent tokens arrive with agent-api in Wave 4, so no agent can sign in to this build yet).
 */
export function agentAddNode(appId: string, node: Record<string, unknown>, parentId?: string): void {
  const d = db();
  try {
    const row = d.prepare("SELECT rev, doc FROM app_draft WHERE app_id = ?").get(appId) as { rev: number; doc: string };
    const doc = JSON.parse(row.doc) as { pages: { root: { id: string; children?: unknown[] } }[] };
    const root = doc.pages[0]!.root;
    const parent = parentId ?? root.id;
    (root.children ??= []).push(node);
    const rev = row.rev + 1;
    const agent = { kind: "agent", userId: "agent-user", role: "owner", via: "pat", tokenId: "t-e2e", agentName: "Claude", scopes: ["atrium:read", "atrium:edit"] };
    d.prepare("UPDATE app_draft SET rev = ?, doc = ?, updated_by = ?, updated_at = ? WHERE app_id = ?").run(rev, JSON.stringify(doc), JSON.stringify(agent), Date.now(), appId);
    d.prepare("UPDATE app SET draft_rev = ?, updated_at = ? WHERE id = ?").run(rev, Date.now(), appId);
    d.prepare("INSERT INTO app_draft_change (id, app_id, rev, by, at, ops, summary, settled) VALUES (?,?,?,?,?,?,?,0)").run(randomUUID(), appId, rev, JSON.stringify(agent), Date.now(), JSON.stringify([{ op: "node.add", parentId: parent, node }]), "Added by an agent");
  } finally {
    d.close();
  }
}

/**
 * Wave 2.6 (builder ease spec 3.3): inserting a data widget opens the data picker at once. Leaves it on
 * sample values ("Skip for now", or Cancel before that button exists) and waits for the picker to close.
 */
export async function skipPicker(page: Page): Promise<void> {
  const picker = page.locator("[data-data-picker]");
  try {
    await picker.waitFor({ state: "visible", timeout: 2500 });
  } catch {
    return;
  }
  const skip = page.locator("[data-pick-skip]");
  if (await skip.count()) await skip.click();
  else await page.locator("[data-pick-cancel]").click();
  await picker.waitFor({ state: "detached", timeout: 5000 });
}

/**
 * Wave 2.9 (direct data spec 3.1): every way into data opens "What should this show?" (the catalogue). The
 * Wave 2.5 to 2.8 picker these older tests drive is now one click away, "Set it up by hand"; this clicks it
 * and waits for that picker. Used only by tests written for the earlier flow.
 */
export async function byHand(page: Page): Promise<void> {
  const b = page.locator("[data-pick-by-hand]");
  // Insert > Card for each still opens the by-hand picker straight away (its cards step lives there).
  const old = page.locator("[data-data-picker]:not([data-show-picker])");
  await page.locator("[data-pick-by-hand], [data-data-picker]:not([data-show-picker])").first().waitFor({ state: "visible", timeout: 5000 });
  if (!(await b.isVisible()) && (await old.isVisible())) return;
  if ((await page.evaluate(() => matchMedia("(pointer: coarse)").matches))) await b.tap();
  else await b.click();
  await page.locator("[data-show-picker]").waitFor({ state: "detached", timeout: 5000 });
  await page.locator("[data-data-picker]").waitFor({ state: "visible", timeout: 5000 });
}
