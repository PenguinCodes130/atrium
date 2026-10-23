// Auth e2e, round 5, fix list item 1 (gauntlet r3 security): the open redirect off sign-in and step-up.
// "owner" scenario. Run once against the round 4 build (it must fail there) and again after the fix:
//   tests/e2e/auth/serve.sh owner &   then
//   ATRIUM_E2E_ROUND=r5 ATRIUM_E2E_SCENARIO=owner ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 \
//     pnpm exec playwright test tests/e2e/auth/round5-redirect.spec.ts
// The "foreign" host is evil.example, answered by a Playwright route, so nothing leaves this machine.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { request as pwRequest } from "@playwright/test";
import { test, expect, OWNER } from "../fixtures";
import { EVIDENCE, SCENARIO, db, freshIp } from "./helpers";

test.skip(SCENARIO !== "owner", "owner scenario only");
test.describe.configure({ mode: "default" });
test.setTimeout(120_000);

// What a browser would put in the address bar: each is the raw query value after `next=`.
const VARIANTS: [string, string][] = [
  ["tab", "/%09/evil.example/phish"],
  ["newline", "/%0a/evil.example/phish"],
  ["carriage return", "/%0d/evil.example/phish"],
  ["backslash", "/%5Cevil.example/phish"],
  ["tab then backslash", "/%09%5Cevil.example/phish"],
  ["double-encoded tab", "/%2509/evil.example/phish"],
  ["double-encoded newline", "/%250a/evil.example/phish"],
  ["double-encoded backslash", "/%255C%255Cevil.example/phish"],
];

const log: string[] = [];
const note = (line: string) => log.push(`[${test.info().project.name}] ${line}`);
let ownerState: string | undefined;

test.beforeAll(async ({ baseURL }) => {
  const d = db();
  try {
    d.prepare("DELETE FROM auth_rate_limit").run();
  } finally {
    d.close();
  }
  const ctx = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": freshIp(), origin: baseURL! } });
  const r = await ctx.post("/api/auth/sign-in/email", { data: OWNER });
  expect(r.status()).toBe(200);
  ownerState = path.resolve(`test-results/auth/r5-redirect-owner-${Date.now()}.json`);
  await ctx.storageState({ path: ownerState });
  await ctx.dispose();
});

test.afterAll(() => {
  writeFileSync(path.join(EVIDENCE, "fix1-redirect-e2e.txt"), log.join("\n") + "\n", { flag: "a" });
});

test("signed in: /sign-in?next=<each variant> answers a redirect to / on this origin, never a 500", async ({ baseURL }) => {
  test.skip(test.info().project.name !== "desktop", "HTTP check, once");
  const ctx = await pwRequest.newContext({ baseURL, storageState: ownerState, extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
  try {
    for (const [name, raw] of VARIANTS) {
      const r = await ctx.get(`/sign-in?next=${raw}`, { maxRedirects: 0 });
      const loc = r.headers()["location"] ?? "";
      note(`GET /sign-in?next=${raw} (${name}) -> ${r.status()} Location ${JSON.stringify(loc)}`);
      expect.soft(r.status(), name).toBe(307);
      expect.soft(loc, name).toBe("/");
    }
    for (const [name, raw] of VARIANTS) {
      const r = await ctx.get(`/step-up?next=${raw}`, { maxRedirects: 0 });
      note(`GET /step-up?next=${raw} (${name}) -> ${r.status()}`);
      expect.soft(r.status(), name).toBe(200);
      const html = await r.text();
      // Next's router payload echoes the address of the page itself (the "c" and "q" fields carry
      // "?next=%2F%09%2Fevil.example..."), which is not a link. What matters is that no link, form or
      // redirect target on the page points there.
      expect.soft(html, name).not.toMatch(/(?:href|action|formaction|content)="[^"]*evil\.example/i);
      expect.soft(html.replace(/next=[^"\\&\s]*/g, ""), name).not.toContain("evil.example");
    }
  } finally {
    await ctx.dispose();
  }
});

test("signed out: after a correct password the browser stays on this Atrium for every variant", async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== "desktop", "one browser run is enough; the form is the same on phones");
  for (const [name, raw] of VARIANTS.slice(0, 4)) {
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
    const page = await context.newPage();
    let foreign = 0;
    // Match the foreign host only: a regex on the whole URL also caught this Atrium's own
    // /sign-in?next=...evil.example... page load (round 5 finding; it skewed the before-fix browser run).
    await context.route((url) => url.hostname === "evil.example" || url.hostname.endsWith(".evil.example"), (route) => {
      foreign += 1;
      return route.fulfill({ status: 200, body: "stand-in foreign page" });
    });
    const res = await page.goto(`/sign-in?next=${raw}`);
    expect.soft(res?.status(), name).toBe(200);
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 15_000 });
    const landed = new URL(page.url());
    note(`signed out, next=${raw} (${name}): landed on ${landed.origin}${landed.pathname}, foreign requests ${foreign}`);
    expect.soft(landed.origin, name).toBe(new URL(baseURL!).origin);
    expect.soft(foreign, name).toBe(0);
    await context.close();
  }
});

test("step-up page: Cancel stays on this Atrium for every variant", async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== "desktop", "once");
  for (const [name, raw] of VARIANTS.slice(0, 4)) {
    const context = await browser.newContext({ storageState: ownerState, extraHTTPHeaders: { "x-forwarded-for": freshIp() } });
    const page = await context.newPage();
    let foreign = 0;
    // Match the foreign host only: a regex on the whole URL also caught this Atrium's own
    // /sign-in?next=...evil.example... page load (round 5 finding; it skewed the before-fix browser run).
    await context.route((url) => url.hostname === "evil.example" || url.hostname.endsWith(".evil.example"), (route) => {
      foreign += 1;
      return route.fulfill({ status: 200, body: "stand-in foreign page" });
    });
    await page.goto(`/step-up?next=${raw}`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/step-up"), { timeout: 15_000 });
    const landed = new URL(page.url());
    note(`step-up Cancel, next=${raw} (${name}): landed on ${landed.origin}${landed.pathname}, foreign requests ${foreign}`);
    expect.soft(landed.origin, name).toBe(new URL(baseURL!).origin);
    expect.soft(foreign, name).toBe(0);
    await context.close();
  }
});
