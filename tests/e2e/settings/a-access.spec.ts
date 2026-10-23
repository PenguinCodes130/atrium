// AC 1 to 6, 36: settings addresses, the role split, signed-out, guest-cookie-only and bearer-only
// requests, the /account redirect and the auth panels. Results go to evidence/settings/r1/access.json.
import { writeFileSync } from "node:fs";
import { expect, request, test } from "@playwright/test";
import { MEMBER, ORIGIN, OWNER, VIEWER, addUser, context, ev, stateFor } from "./helpers";

const PAGES = ["/settings/general", "/settings/appearance", "/settings/themes", "/settings/users", "/settings/security", "/settings/backups", "/settings/notifications", "/settings/agents"];
const OWNER_PAGES = ["/settings/general", "/settings/users", "/settings/backups"];
const ACTIONS: { method: "GET" | "PUT" | "POST"; path: string; owner?: boolean; body?: unknown }[] = [
  { method: "GET", path: "/api/settings/instance", owner: true },
  { method: "PUT", path: "/api/settings/instance", owner: true, body: {} },
  { method: "POST", path: "/api/settings/backup/export", owner: true, body: { includeSecrets: false } },
  { method: "POST", path: "/api/settings/backup/import", owner: true },
  { method: "GET", path: "/api/settings/backup/status", owner: true },
  { method: "GET", path: "/api/settings/themes" },
  { method: "GET", path: "/api/settings/preferences" },
];

test.beforeAll(async () => {
  await addUser(MEMBER.email, "member", MEMBER.password);
  await addUser(VIEWER.email, "viewer", VIEWER.password);
});

test("route sweep: signed out, guest cookie only, bearer only, member, viewer, owner (AC 2, 3, 36)", async () => {
  test.skip(test.info().project.name !== "desktop", "once");
  const results: Record<string, Record<string, number | string>> = {};
  const who = {
    none: await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN }, maxRedirects: 0 }),
    guestCookie: await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN, cookie: "atrium.guest=atr_gs_not-a-real-guest-session" }, maxRedirects: 0 }),
    bearer: await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { origin: ORIGIN, authorization: "Bearer atr_pat_not-a-real-token-0000000000000000000000" }, maxRedirects: 0 }),
    member: await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(MEMBER), extraHTTPHeaders: { origin: ORIGIN }, maxRedirects: 0 }),
    viewer: await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(VIEWER), extraHTTPHeaders: { origin: ORIGIN }, maxRedirects: 0 }),
    owner: await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN }, maxRedirects: 0 }),
  };
  for (const [name, ctx] of Object.entries(who)) {
    results[name] = {};
    for (const p of PAGES) {
      const r = await ctx.get(p);
      results[name]![p] = r.status() >= 300 && r.status() < 400 ? `${r.status()} ${r.headers().location}` : r.status();
      const text = r.status() === 200 ? await r.text() : "";
      if (["none", "guestCookie", "bearer"].includes(name)) expect(String(results[name]![p]), `${name} ${p}`).toMatch(/^307 \/sign-in\?next=/);
      else if (OWNER_PAGES.includes(p) && name !== "owner") expect(text, `${name} ${p}`).toContain("data-owner-only");
      else expect(r.status(), `${name} ${p}`).toBe(200);
    }
    for (const a of ACTIONS) {
      const r = await ctx.fetch(a.path, { method: a.method, ...(a.body ? { data: a.body } : {}) });
      results[name]![`${a.method} ${a.path}`] = r.status();
      if (["none", "guestCookie", "bearer"].includes(name)) expect(r.status(), `${name} ${a.method} ${a.path}`).toBe(401);
      else if (a.owner && name !== "owner") expect(r.status(), `${name} ${a.method} ${a.path}`).toBe(403);
    }
  }
  writeFileSync(ev("access.json"), JSON.stringify(results, null, 2));
  for (const c of Object.values(who)) await c.dispose();
});

test("member and viewer see Appearance, Themes, Security, Notifications and Agents only (AC 2)", async ({ browser }) => {
  test.skip(test.info().project.name !== "desktop", "once");
  for (const p of [MEMBER, VIEWER]) {
    const ctx = await context(browser, p);
    const page = await ctx.newPage();
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    const tabs = await page.locator("[data-screen-tabs] a").allTextContents();
    expect(tabs).toEqual(["Appearance", "Themes", "Security", "Notifications", "Agents"]);
    await ctx.close();
  }
});

test("each sub-tab address loads that tab directly on reload, inside the shell with Settings active (AC 1)", async ({ browser }) => {
  const ctx = await context(browser, OWNER, { mobile: test.info().project.name === "mobile" });
  const page = await ctx.newPage();
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/general$/);
  for (const p of PAGES) {
    await page.goto(p);
    await page.reload();
    const key = p.split("/").pop()!;
    await expect(page.locator(`[data-settings-tab="${key}"]`)).toBeVisible();
    await expect(page.locator("[data-screen-title]")).toHaveText("Settings");
    await expect(page.locator(`[data-screen-tabs] a[aria-current="page"]`)).toHaveText(new RegExp(key, "i"));
    if (test.info().project.name === "desktop") await expect(page.locator('[data-shell="topbar"] [data-active]')).toContainText("Settings");
  }
  await ctx.close();
});

test("/account answers a permanent redirect to /settings/security, path and query kept (AC 4)", async () => {
  test.skip(test.info().project.name !== "desktop", "once");
  const owner = await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), maxRedirects: 0 });
  const out: Record<string, string> = {};
  for (const p of ["/account", "/account/", "/account?x=1"]) {
    const r = await owner.get(p);
    out[p] = `${r.status()} ${r.headers().location ?? ""}`;
  }
  const none = await request.newContext({ baseURL: ORIGIN, maxRedirects: 0 });
  const r = await none.get("/account");
  out["signed out /account"] = `${r.status()} ${r.headers().location ?? ""}`;
  writeFileSync(ev("account-redirect.json"), JSON.stringify(out, null, 2));
  // "/account/" first meets Next's trailing-slash 308 to "/account", which then answers auth's 308.
  for (const p of ["/account", "/account?x=1"]) expect(out[p], p).toMatch(/^308 .*\/settings\/security/);
  expect(out["/account/"]).toMatch(/^308 \/account$|^308 .*\/settings\/security/);
  expect(out["/account?x=1"]).toContain("x=1");
  expect(out["signed out /account"]).toMatch(/^30[78] /);
});

test("Users shows auth's panels for the owner; Security shows password, authenticator and sessions (AC 6)", async ({ browser }) => {
  test.skip(test.info().project.name !== "desktop", "once");
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto("/settings/users");
  await expect(page.locator("[data-users-settings-panel]")).toBeVisible();
  await page.goto("/settings/security");
  await expect(page.locator("[data-security-settings-panel]")).toBeVisible();
  await ctx.close();
  const m = await context(browser, MEMBER);
  const mp = await m.newPage();
  await mp.goto("/settings/security");
  await expect(mp.locator("[data-security-settings-panel]")).toBeVisible();
  await m.close();
});
