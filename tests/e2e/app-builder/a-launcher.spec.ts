// app-builder e2e, part A: the launcher, creating apps, tiles, and the not-found rules
// (criteria 1 to 6, 32, 38; V4 and V5 for the launcher). Run with the slot server from serve.sh.
import { expect, test } from "@playwright/test";
import { addUser, api, auditCount, contextFor, ev, log, OWNER, PEOPLE, SHELL_VARIANTS, userId } from "./helpers";

test.describe.configure({ mode: "serial" });
// Each test makes its own contexts and phone widths (as in round 1, run on the desktop project only); a
// second pass on the mobile project would meet the first pass's apps in the same slot database.
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return; // the tests skip on other projects (see the skip above)
  for (const p of Object.values(PEOPLE)) await addUser(p);
});

test("an empty launcher shows the first-app room, not the interim home (criterion 2; V4, V5)", async ({ browser }) => {
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator("[data-launcher-empty] [data-room-title]")).toHaveText("Build your first app.");
    await expect(page.getByText("Start from a template, or ask an agent to build one.")).toBeVisible();
    await expect(page.locator("[data-new-app]")).toHaveText("New app");
    await expect(page.locator("[data-start-template]")).toHaveText("Start from a template");
    await expect(page.locator("[data-interim-home], [data-interim-note]")).toHaveCount(0);
    await page.screenshot({ path: ev("screens", `launcher-empty-${v.name}.png`), fullPage: true });
    await ctx.close();
  }
  const m = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: SHELL_VARIANTS[0] });
  const mp = await m.newPage();
  await mp.goto("/");
  await expect(mp.locator("[data-launcher-empty]")).toBeVisible();
  await mp.screenshot({ path: ev("screens", "mobile-launcher-empty.png"), fullPage: true });
  await m.close();
});

test("creating Guest room from the template asks for the mapping, opens the builder, one app.created (criterion 4)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0] });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-new-app]").click();
  await page.locator("[data-new-app-name]").fill("Guest room");
  await page.locator('[data-template-option="guest-room"]').click();
  await expect(page.locator("[data-template-mapping]")).toBeVisible();
  await expect(page.locator('[data-map-integration="ha"]')).toBeVisible();
  await page.screenshot({ path: ev("screens", "new-app-sheet-mapping-light.png") });
  await page.locator("[data-create-app]").click();
  await page.waitForURL(/\/build\/guest-room/);
  const c = await api(OWNER);
  const tiles = (await (await c.get("/api/apps")).json()).tiles as { app: { id: string; slug: string; publishedVersion?: number } }[];
  const app = tiles.find((t) => t.app.slug === "guest-room")!.app;
  expect(app.publishedVersion).toBeUndefined();
  expect(auditCount("app.created", app.id)).toBe(1);
  log("created guest-room", app);
  await ctx.close();
});

test("a taken, long or invalid slug is refused at the slug field and nothing is created (criterion 5)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto("/");
  const c = await api(OWNER);
  const before = ((await (await c.get("/api/apps")).json()).tiles as unknown[]).length;
  for (const [slug, msg] of [["guest-room", /already taken/], ["a".repeat(41), /at most 40/], ["Bad_Slug", /lowercase letters, digits and hyphens/]] as const) {
    await page.locator("[data-new-app-tile]").click();
    await page.locator("[data-new-app-name]").fill("Another");
    // Wave 2.10b F1: the start page is preselected once a service is connected; this test is about the slug.
    await page.locator('[data-template-option="blank"]').click();
    await page.locator("[data-new-app-slug]").fill(slug);
    await page.locator("[data-create-app]").click();
    await expect(page.locator('[data-field="URL name"] [data-field-error]')).toHaveText(msg);
    await page.keyboard.press("Escape");
  }
  expect(((await (await c.get("/api/apps")).json()).tiles as unknown[]).length).toBe(before);
  await ctx.close();
});

test("a viewer sees no New app and a direct create is refused (criterion 1)", async ({ browser }) => {
  const c = await api(OWNER);
  const r = await c.post("/api/apps", { data: { name: "Shared", slug: "shared" } });
  const shared = (await r.json()).app as { id: string };
  await c.put(`/api/apps/${shared.id}/access`, { data: { view: "everyone", edit: { userIds: [userId(PEOPLE.editor.email), userId(PEOPLE.viewer.email)] }, guests: false } });
  const ctx = await contextFor(browser, PEOPLE.viewer, { variant: SHELL_VARIANTS[0] });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.locator("[data-greeting]")).toHaveText(/^Good (morning|afternoon|evening), Vic\.$/);
  await expect(page.locator("[data-app-tile]")).toHaveCount(1);
  await expect(page.locator('[data-app-tile="shared"]')).toBeVisible();
  await expect(page.locator("[data-new-app-tile], [data-new-app]")).toHaveCount(0);
  const v = await api(PEOPLE.viewer);
  const refused = await v.post("/api/apps", { data: { name: "Mine", slug: "mine" } });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.message).toMatch(/Only owners and members/);
  // Criterion 32: a viewer in the edit list can open the app's address but not its builder.
  for (const path of ["/build/shared", "/build/shared/versions", "/build/shared/settings"]) {
    await page.goto(path);
    await expect(page.locator("[data-room-title]")).toHaveText("This room does not exist.");
  }
  await ctx.close();
});

test("tiles show path, name, audience, pages and version; the draft dot only for editors with changes (criteria 1, 3; V4, V5)", async ({ browser }) => {
  const c = await api(OWNER);
  const apps = (await (await c.get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[];
  const shared = apps.find((t) => t.app.slug === "shared")!.app;
  const draft = await (await c.get(`/api/apps/${shared.id}/draft`)).json();
  const root = draft.doc.pages[0].root.id;
  const add = await c.post(`/api/apps/${shared.id}/ops`, { data: { rev: draft.rev, ops: [{ op: "node.add", parentId: root, node: { id: "c_tileheadaa", type: "heading", props: { text: "Shared board", level: 1 }, slot: { x: 0, y: 0, w: 12, h: 8 } } }] } });
  expect(add.ok()).toBe(true);
  const review = await (await c.get(`/api/apps/${shared.id}/review`)).json();
  expect((await c.post(`/api/apps/${shared.id}/publish`, { data: { expectRev: review.rev, note: "first" } })).ok()).toBe(true);
  const d2 = await (await c.get(`/api/apps/${shared.id}/draft`)).json();
  await c.post(`/api/apps/${shared.id}/ops`, { data: { rev: d2.rev, ops: [{ op: "node.update", nodeId: "c_tileheadaa", patch: { props: { text: "Shared board 2", level: 1 } } }] } });
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await page.goto("/");
    const tile = page.locator('[data-app-tile="shared"]');
    await expect(tile.locator("[data-window-title]")).toHaveText("apps / shared");
    await expect(tile.locator("[data-tile-name]")).toHaveText("Shared");
    await expect(tile.locator("[data-tag]")).toHaveText("members");
    await expect(tile.locator("[data-tile-pages]")).toHaveText("1 page");
    await expect(tile.locator("[data-tile-version]")).toHaveText("v1");
    await expect(tile.locator("[data-draft-dot]")).toBeVisible();
    await expect(page.locator('[data-app-tile="guest-room"] [data-tile-version]')).toHaveText("not published");
    await expect(page.locator("[data-new-app-tile]")).toBeVisible();
    await page.screenshot({ path: ev("screens", `launcher-${v.name}.png`), fullPage: true });
    await ctx.close();
  }
  const wctx = await contextFor(browser, PEOPLE.watcher);
  const wp = await wctx.newPage();
  await wp.goto("/");
  await expect(wp.locator('[data-app-tile="shared"]')).toBeVisible();
  await expect(wp.locator('[data-app-tile="shared"] [data-draft-dot]')).toHaveCount(0);
  await wctx.close();
  const m = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: SHELL_VARIANTS[0] });
  const mp = await m.newPage();
  await mp.goto("/");
  await mp.screenshot({ path: ev("screens", "mobile-launcher.png"), fullPage: true });
  await m.close();
});

test("unknown, unopenable and never-published apps share one not-found room; an editor sees Not published yet (criteria 6, 38)", async ({ browser }) => {
  const owner = await contextFor(browser, OWNER);
  const op = await owner.newPage();
  await op.goto("/a/guest-room");
  await expect(op.locator("[data-not-published] [data-room-title]")).toHaveText("Not published yet");
  await expect(op.locator("[data-open-builder]")).toHaveText("Open the builder");
  await owner.close();
  const w = await contextFor(browser, PEOPLE.watcher);
  const wp = await w.newPage();
  const texts: string[] = [];
  for (const path of ["/a/no-such-app", "/a/guest-room", "/build/guest-room", "/build/guest-room/versions", "/build/guest-room/settings", "/build/no-such-app"]) {
    const res = await wp.goto(path);
    texts.push(`${path} ${res?.status()} ${await wp.locator("[data-room-title]").first().textContent()}`);
    await expect(wp.locator("[data-room-title]").first()).toHaveText("This room does not exist.");
  }
  log("not-found sweep", texts);
  await w.close();
});
