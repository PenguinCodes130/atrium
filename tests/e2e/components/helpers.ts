// components e2e helpers (Wave 2 round 1): sign-in, the gallery route, evidence paths, and the
// network-layer stand-in for the pending proxy fix on /sandbox/frame (shared file request SFR-1).
import type { BrowserContext, Page, Route } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER } from "../fixtures";
import { frameHeaders } from "../../../src/features/components/sandbox/frame-doc";

const here = path.dirname(fileURLToPath(import.meta.url));
// ATRIUM_E2E_EVIDENCE_ROUND (default r1) picks the evidence folder, so earlier rounds stay as they were.
export const EVIDENCE = path.resolve(here, `../../../evidence/components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}`);
export function evidence(...parts: string[]): string {
  const p = path.join(EVIDENCE, ...parts);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
export function writeEvidence(name: string, data: unknown) {
  writeFileSync(evidence(name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

export const PORT = Number(process.env.ATRIUM_E2E_PORT ?? 3114);
export const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION_FILE = path.resolve(here, "../../../test-results/components-session.json");

export async function signIn(ctx: BrowserContext, request: Page["request"]) {
  if (existsSync(SESSION_FILE)) {
    await ctx.addCookies(JSON.parse(readFileSync(SESSION_FILE, "utf8")));
    const check = await request.get(`${ORIGIN}/api/auth/get-session`);
    if (check.ok() && (await check.text()).includes(OWNER.email)) return;
    await ctx.clearCookies();
  }
  const res = await request.post(`${ORIGIN}/api/auth/sign-in/email`, { data: { email: OWNER.email, password: OWNER.password }, headers: { origin: ORIGIN } });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()}`);
  mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify((await ctx.cookies()).filter((c) => c.name.startsWith("atrium.session"))), { mode: 0o600 });
}

export function gallery(q: Record<string, string | number | undefined> = {}): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) s.set(k, String(v));
  return `${ORIGIN}/library/gallery?${s.toString()}`;
}

/**
 * SFR-1 stand-in: the proxy currently replaces the frame's own headers with the shell CSP and
 * X-Frame-Options DENY. Until auth applies the fix, the sandbox suite serves the real frame body with
 * exactly the headers the frame route sets (frameHeaders), as the fixed proxy will.
 */
export async function withFrameFix(target: Page | BrowserContext) {
  await target.route("**/sandbox/frame*", async (route: Route) => {
    const res = await route.fetch();
    const body = await res.text();
    const origin = new URL(route.request().url()).origin;
    await route.fulfill({ status: res.status(), headers: frameHeaders(origin), body });
  });
}
