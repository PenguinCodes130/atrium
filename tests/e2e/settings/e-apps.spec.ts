// AC 12, 17, 18, 19 with app-builder's real code (whole-tree build): a new app starts on Control Room;
// saving a saved theme changes the draft preview and leaves the published viewer identical; "Update
// apps using this theme" and the delete refusal name the app.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, request, test } from "@playwright/test";
import { ORIGIN, OWNER, context, ev, stateFor } from "./helpers";

test.setTimeout(120_000);

test("theme lifecycle across a real app (AC 12, 17, 18, 19)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const api = await request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
  const probe = await api.get("/api/apps");
  test.skip(probe.status() === 404, "app-builder is not in this build");
  const out: Record<string, unknown> = {};
  const cr = (await (await api.get("/api/settings/themes/control-room")).json()).theme;
  const created = await api.post("/api/settings/themes", { data: { theme: { ...cr, name: `E2E live ${randomBytes(2).toString("hex")}` } } });
  expect(created.status()).toBe(201);
  const theme = await created.json();
  const slug = `theme-probe-${randomBytes(3).toString("hex")}`;
  const app = await api.post("/api/apps", { data: { name: "Theme probe", slug, template: "blank" } });
  expect(app.status(), await app.text()).toBe(201);
  const { app: a } = await app.json();
  let draft = await (await api.get(`/api/apps/${a.id}/draft`)).json();
  out.newAppTheme = draft.doc.theme;
  expect(draft.doc.theme).toEqual({ themeId: "control-room" });
  const ops = await api.post(`/api/apps/${a.id}/ops`, { data: { rev: draft.rev, ops: [{ op: "theme.set", theme: { themeId: theme.id } }] } });
  expect(ops.status(), await ops.text()).toBe(200);
  draft = await (await api.get(`/api/apps/${a.id}/draft`)).json();
  const pub = await api.post(`/api/apps/${a.id}/publish`, { data: { expectRev: draft.rev, note: "theme probe" } });
  expect(pub.status(), await pub.text()).toBe(200);
  // Save the theme with a new accent.
  const saved = await api.put(`/api/settings/themes/${theme.id}`, { data: { theme: { ...theme.theme, tokens: { ...theme.theme.tokens, color: { ...theme.theme.tokens.color, accent: "#2F6FB0" } } }, rev: theme.rev } });
  expect(saved.status()).toBe(200);
  out.usedBy = (await saved.json()).usedBy;
  expect((await saved.json()).usedBy).toEqual([{ appId: a.id, slug, name: "Theme probe", draft: true, published: true }]);
  // The published viewer keeps its copy; the draft preview follows the saved theme.
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  const accentOf = async (url: string) => {
    await page.goto(url);
    const c = page.locator("[data-atrium-canvas]").first();
    await expect(c).toBeVisible();
    return (await c.evaluate((el) => getComputedStyle(el).getPropertyValue("--theme-accent"))).trim();
  };
  out.publishedAccent = await accentOf(`/a/${slug}`);
  await page.screenshot({ path: ev("screens", "app-published-after-theme-save.png") });
  out.draftAccent = await accentOf(`/a/${slug}?draft=1`);
  await page.screenshot({ path: ev("screens", "app-draft-after-theme-save.png") });
  expect(String(out.publishedAccent).toUpperCase()).toBe("#E9B949");
  expect(String(out.draftAccent).toUpperCase()).toBe("#2F6FB0");
  // Delete is refused naming the app; "Update apps using this theme" lists it.
  const del = await api.delete(`/api/settings/themes/${theme.id}`);
  out.deleteRefused = { status: del.status(), body: await del.json() };
  expect(del.status()).toBe(409);
  expect((await del.json()).error.message).toContain("Theme probe");
  const upd = await api.post(`/api/settings/themes/${theme.id}/update-apps`, { data: {} });
  out.updateApps = await upd.json();
  expect((out.updateApps as { updated: { name: string }[] }).updated.map((u) => u.name)).toEqual(["Theme probe"]);
  out.publishedAccentAfterUpdate = await accentOf(`/a/${slug}`);
  expect(String(out.publishedAccentAfterUpdate).toUpperCase()).toBe("#E9B949");
  writeFileSync(ev("apps-theme-lifecycle.json"), JSON.stringify(out, null, 2));
  await api.dispose();
  await ctx.close();
});
