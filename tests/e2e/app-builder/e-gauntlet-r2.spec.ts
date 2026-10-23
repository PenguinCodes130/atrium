// app-builder e2e, round 2: the gauntlet w2-r1 Fix List (stages/04-gauntlet/output/app-builder-gauntlet-r1.md),
// one test per item, each proving its pass condition. Evidence goes to evidence/app-builder/<round>/
// (ATRIUM_E2E_EVIDENCE_ROUND=r2). Self-contained: its own apps (slugs r2-*), its own fake Home Assistant.
import { expect, test, type Page } from "@playwright/test";
import { addUser, api, contextFor, db, ev, FAKE_HA_TOKEN, fakeHa, log, OWNER, PEOPLE, saveText, SHELL_VARIANTS, skipPicker, userId, type FakeHa } from "./helpers";
import { readZipEntries } from "./zip-read";

// Each test makes its own apps, so one failure does not stop the rest (one worker runs them in order).
test.describe.configure({ mode: "default" });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

let ha: FakeHa;
let haId = "";
const LIGHT = SHELL_VARIANTS[0]!;

async function owner() {
  return api(OWNER);
}
type Doc = { rev: number; doc: { pages: { id: string; slug: string; root: { id: string; children?: { id: string; type: string; props: Record<string, unknown>; slot?: { x: number; y: number; w: number; h: number } }[] } }[]; controls: { id: string; label: string }[]; dataSources: { name: string; integrationId: string }[] } };
async function draftOf(id: string): Promise<Doc> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function ops(id: string, list: unknown[]) {
  const d = await draftOf(id);
  const r = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
}
async function publish(id: string, note = "r2") {
  const c = await owner();
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
  return (await r.json()) as { version: number };
}
async function create(body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  const r = await (await owner()).post("/api/apps", { data: body });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  return (await r.json()).app;
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
}
/** Picks an option in the shared square SelectMenu (settings' controls.tsx) by its value. */
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  for (const p of Object.values(PEOPLE)) await addUser(p);
  ha = await fakeHa();
  const c = await owner();
  const existing = ((await (await c.get("/api/integrations")).json()).integrations ?? []) as { id: string; name: string }[];
  haId = existing.find((i) => i.name === "Home Assistant r2")?.id ?? (await (await c.post("/api/integrations", { data: { packageId: "home-assistant", name: "Home Assistant r2", config: { baseUrl: ha.url }, secrets: { token: FAKE_HA_TOKEN }, untested: true } })).json()).id;
  expect(haId).toBeTruthy();
});
test.afterAll(async () => {
  await ha?.close();
});

// ---------- Item 1 (security) ----------
test("item 1: viewers, members without edit and guests never read control run details through versions or export; editors do", async ({ browser }) => {
  const SECRET = "light.secprobe_door_4821";
  const app = await create({ name: "Sec viewdoc", slug: "r2-sec-viewdoc" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", params: { domain: "lock" }, refreshSec: 10 } },
    { op: "control.set", control: { id: "k_secdooraaa", label: "Front door", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: SECRET } } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_secdoornod", type: "button", props: { label: "Front door", control: "k_secdooraaa" }, slot: { x: 0, y: 0, w: 4, h: 8 } } },
    { op: "chrome.update", patch: { css: ":scope { --secprobe-chrome: 1 }" } },
  ]);
  await publish(app.id);
  await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: { userIds: [userId(PEOPLE.viewer.email), userId(PEOPLE.watcher.email)] }, edit: { userIds: [userId(PEOPLE.editor.email)] }, guests: true } });
  const result: Record<string, unknown> = {};
  const check = async (label: string, c: Awaited<ReturnType<typeof api>> | import("@playwright/test").APIRequestContext, expectSecret: boolean) => {
    const v = await c.get(`/api/apps/${app.id}/versions/1`);
    const vText = await v.text();
    const x = await c.get(`/api/apps/${app.id}/export`);
    const xBody = x.ok() ? Buffer.from(await x.body()) : Buffer.alloc(0);
    const xText = x.ok() ? readZipEntries(xBody).map((e) => e.text).join("\n") : await x.text();
    result[label] = { versions: v.status(), versionsHasSecret: vText.includes(SECRET), versionsHasChromeCss: vText.includes("secprobe-chrome"), export: x.status(), exportHasSecret: xText.includes(SECRET), exportHasParams: xText.includes('"domain"') };
    if (expectSecret) {
      expect(v.status(), label).toBe(200);
      expect(vText.includes(SECRET), label).toBe(true);
      expect(xText.includes(SECRET), label).toBe(true);
    } else {
      expect(vText.includes(SECRET), label).toBe(false);
      expect(vText.includes("secprobe-chrome"), label).toBe(false);
      expect(xText.includes(SECRET), label).toBe(false);
      expect(xText.includes('"domain"'), label).toBe(false);
    }
  };
  await check("viewer (role viewer)", await api(PEOPLE.viewer), false);
  await check("member without edit", await api(PEOPLE.watcher), false);
  await check("editor (member in the edit list)", await api(PEOPLE.editor), true);
  await check("owner", await owner(), true);
  // The guest: a real guest cookie from a link.
  const link = await (await (await owner()).post("/api/auth/atrium/guest-links", { data: { appId: app.id, label: "r2 sec guest" } })).json();
  const g = await contextFor(browser, null);
  const gp = await g.newPage();
  await gp.goto(new URL(link.url).pathname);
  await gp.waitForURL(/\/a\/r2-sec-viewdoc/);
  await check("guest", gp.request, false);
  await g.close();
  saveText("security/viewer-reads.json", JSON.stringify(result, null, 2));
});

// ---------- Item 2 (and 13) ----------
test("item 2: Homelab with skipped integrations shows No data: connect ..., publishes with one warning per source, review problems select their component; Family wall is composed", async ({ browser }) => {
  const app = await create({ name: "R2 homelab", slug: "r2-homelab", template: "homelab", mappings: {} });
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await openBuilder(page, app.slug);
    const canvas = page.locator("[data-canvas-root]");
    await expect(canvas.getByText("No data: connect Docker").first()).toBeVisible();
    await expect(canvas.getByText("No data: connect Proxmox VE")).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await canvas.getByText(/There is no data source named|position \d/).count()).toBe(0);
    expect(await canvas.locator('[role="status"][aria-label="Loading"]').count()).toBe(0);
    await page.screenshot({ path: ev("screens", `item2-homelab-builder-${v.name}.png`) });
    await ctx.close();
  }
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator("[data-publish]").click();
  await expect(page.locator("[data-review]")).toBeVisible();
  await expect(page.locator('[data-review-problem="error"]')).toHaveCount(0);
  await expect(page.locator('[data-review-problem="warning"]').filter({ hasText: "until you connect" })).toHaveCount(3);
  await expect(page.locator("[data-publish-confirm]")).toBeEnabled();
  await page.screenshot({ path: ev("screens", "item2-review-warnings.png") });
  const target = await page.locator("[data-review-problem-select]").first().getAttribute("data-review-problem-select");
  await page.locator("[data-review-problem-select]").first().click();
  await expect(page.locator("[data-review]")).toHaveCount(0);
  await expect(page.locator(`[data-selected-outline="${target}"]`)).toBeVisible();
  await page.screenshot({ path: ev("screens", "item2-review-selects-component.png") });
  await page.locator("[data-publish]").click();
  await page.locator("[data-publish-confirm]").click();
  await expect(page.locator("[data-publish-glow], [data-publish-check]").first()).toBeAttached();
  await page.goto(`/a/${app.slug}`);
  await expect(page.getByText("No data: connect Docker").first()).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await page.getByText(/There is no data source named|position \d/).count()).toBe(0);
  expect(await page.locator('[role="status"][aria-label="Loading"]').count()).toBe(0);
  await page.screenshot({ path: ev("screens", "item2-homelab-published.png") });
  // Family wall: a composed page across the canvas, not a corner clock.
  const wall = await create({ name: "R2 wall", slug: "r2-wall", template: "family-wall" });
  await openBuilder(page, wall.slug);
  const frame = await page.locator("[data-canvas-root] [data-atrium-canvas]").boundingBox();
  const boxes = await page.locator("[data-canvas-root] [data-node]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
  const right = Math.max(...boxes.filter((b) => b.w < 2000).map((b) => b.x + b.w));
  log("item2 family wall", { frame, right, nodes: boxes.length });
  expect(right).toBeGreaterThan(frame!.x + frame!.width * 0.85);
  await page.screenshot({ path: ev("screens", "item2-family-wall.png") });
  await ctx.close();
});

// ---------- Item 3 ----------
test("item 3: the app file ships its library components; a second instance imports and relinks them with the contains-code notice", async ({ browser }) => {
  const c = await owner();
  const saved = await c.post("/api/library", { data: { name: "R2 code card", node: { id: "c_r2codecard", type: "html", props: { html: "<p>hello</p>", data: {}, controls: [] } }, sources: [], controls: [] } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const comp = (await saved.json()) as { id: string; version: number; component?: { id: string; version: number } };
  const compId = comp.component?.id ?? comp.id;
  const compVersion = comp.component?.version ?? comp.version;
  const app = await create({ name: "R2 shared", slug: "r2-shared" });
  const d = await draftOf(app.id);
  await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2instance", type: `lib:${compId}`, name: "R2 code card", props: {}, libraryRef: { componentId: compId, version: compVersion }, slot: { x: 0, y: 0, w: 6, h: 12 } } }]);
  await publish(app.id);
  const zip = Buffer.from(await (await c.get(`/api/apps/${app.id}/export`)).body());
  const entries = readZipEntries(zip);
  const paths = entries.map((e) => e.path);
  expect(paths).toContain(`library/${compId}@${compVersion}.json`);
  saveText("logs/item3-export-paths.json", JSON.stringify(paths, null, 2));
  // "A second instance": the component is not on this one any more.
  const conn = db();
  conn.prepare("DELETE FROM library_version WHERE component_id = ?").run(compId);
  conn.prepare("DELETE FROM library_component WHERE id = ?").run(compId);
  conn.close();
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.locator("[data-import-app]").click();
  await page.locator("[data-import-file]").setInputFiles({ name: "r2-shared.atrium-app.zip", mimeType: "application/zip", buffer: zip });
  await page.locator("[data-import-check]").click();
  await expect(page.locator("[data-import-library]")).toContainText("R2 code card");
  await expect(page.locator("[data-import-code-notice]")).toContainText("Contains code");
  await page.screenshot({ path: ev("screens", "item3-import-library.png") });
  await page.locator("[data-import-confirm]").click();
  await page.waitForURL(/\/build\/r2-shared-?\d*$/);
  const slug = new URL(page.url()).pathname.split("/")[2]!;
  const imported = ((await (await c.get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[]).find((t) => t.app.slug === slug)!.app.id;
  const review = await (await c.get(`/api/apps/${imported}/review`)).json();
  expect((review.problems as { code: string }[]).filter((p) => p.code === "library.missing")).toEqual([]);
  await expect(page.locator("[data-canvas-root]").getByText("This library component is missing")).toHaveCount(0);
  await page.screenshot({ path: ev("screens", "item3-imported-builder.png") });
  await ctx.close();
});

// ---------- Item 4 ----------
test("item 4: start_url, scope and address agree; after one visit the worker controls /a/<slug>; offline reload shows the frame, strip and last values", async ({ browser }) => {
  const app = await create({ name: "R2 porch", slug: "r2-porch" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", refreshSec: 10 } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2porchtxt", type: "text", props: { text: { $bind: '{{ ha.rows | count }} lights known' } }, slot: { x: 0, y: 0, w: 6, h: 6 } } },
  ]);
  await publish(app.id);
  const m = await (await (await owner()).get(`/a/${app.slug}/manifest.webmanifest`)).json();
  expect([m.start_url, m.scope]).toEqual([`/a/${app.slug}`, `/a/${app.slug}`]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto(`/a/${app.slug}/`);
  expect(new URL(page.url()).pathname).toBe(`/a/${app.slug}`); // the canonical address
  await expect(page.getByText("48 lights known")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 15_000 });
  const controlled = await page.evaluate(() => ({ controller: !!navigator.serviceWorker.controller, scope: navigator.serviceWorker.controller?.scriptURL }));
  await page.waitForTimeout(2500); // the page hands its files to the worker and saves its last values
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.locator("[data-app-page]")).toBeVisible();
  await expect(page.locator("[data-app-offline]")).toBeVisible();
  await expect(page.getByText("48 lights known")).toBeVisible();
  await page.screenshot({ path: ev("screens", "item4-offline-reload.png") });
  saveText("logs/item4-pwa.json", JSON.stringify({ manifest: m, controlled }, null, 2));
  await ctx.setOffline(false);
  await ctx.close();
});

// ---------- Item 5 ----------
test("item 5: the publish glow lights the bar beneath a legible name (Note 1 curve), a check pops in, the toast follows 300ms later", async ({ browser }) => {
  const app = await create({ name: "R2 glow", slug: "r2-glow" });
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, recordVideo: ev("video", "publish-glow") });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator("[data-insert-item=text]").first().click();
  await page.waitForTimeout(800);
  await page.locator("[data-publish]").click();
  await expect(page.locator("[data-publish-confirm]")).toBeEnabled();
  await page.evaluate(() => {
    const w = window as unknown as { __glow: { t: number; op: number; color: string; check: boolean; toast: boolean }[] };
    w.__glow = [];
    const t0 = performance.now();
    const tick = () => {
      const strip = document.querySelector("[data-publish-glow]");
      const title = document.querySelector("[data-builder-title]");
      w.__glow.push({ t: performance.now() - t0, op: strip ? Number(getComputedStyle(strip).opacity) : -1, color: title ? getComputedStyle(title).color : "", check: !!document.querySelector("[data-publish-check]"), toast: !!document.body.innerText.match(/Published v\d/) });
      if (performance.now() - t0 < 1600) requestAnimationFrame(tick);
    };
    document.querySelector("[data-publish-confirm]")!.addEventListener("click", () => requestAnimationFrame(tick), { once: true });
  });
  await page.locator("[data-publish-confirm]").click();
  await page.waitForTimeout(400);
  await page.locator("[data-builder-bar]").screenshot({ path: ev("screens", "item5-glow-bar.png") });
  await page.waitForTimeout(1500);
  const samples = (await page.evaluate(() => (window as unknown as { __glow: unknown[] }).__glow)) as { t: number; op: number; color: string; check: boolean; toast: boolean }[];
  saveText("perf/item5-glow-samples.json", JSON.stringify(samples, null, 2));
  const lit = samples.filter((s) => s.op >= 0);
  const start = lit[0]!.t;
  const peak = lit.find((s) => s.op >= 0.95);
  expect(peak, "reaches full gold").toBeTruthy();
  expect(peak!.t - start).toBeLessThanOrEqual(200);
  expect(lit.filter((s) => s.t - start >= 160 && s.t - start <= 420).every((s) => s.op >= 0.95)).toBe(true);
  const accentFg = await page.evaluate(() => { const e = document.createElement("span"); e.style.color = "var(--accent-fg)"; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; });
  expect(samples.filter((s) => s.op >= 0.95).every((s) => s.color === accentFg)).toBe(true);
  expect(samples.some((s) => s.check)).toBe(true);
  const toastAt = samples.find((s) => s.toast)?.t ?? 9999;
  expect(toastAt - start).toBeGreaterThanOrEqual(280);
  await ctx.close();
});

// ---------- Item 6 ----------
test("item 6: a source added in this session is live on the canvas within about a second, with no reload", async ({ browser }) => {
  const app = await create({ name: "R2 stale", slug: "r2-stale" });
  const d = await draftOf(app.id);
  await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2staletxt", type: "text", props: { text: "waiting" }, slot: { x: 0, y: 0, w: 6, h: 6 } } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_r2staletxt"]').click();
  // Wave 2.5: the source is added through the data picker (the old form is gone); named "lamps" there.
  await page.locator('[data-pick-button="text"]').click();
  await page.locator(`[data-pick-integration="${haId}"]`).click();
  await page.locator('[data-pick-endpoint="states"]').click();
  await page.locator("[data-pick-more-settings-toggle]").click();
  await page.locator("[data-pick-name]").fill("lamps");
  await page.locator("[data-pick-name]").press("Enter");
  await page.locator("[data-pick-done]").click();
  await expect(page.locator('[data-source="lamps"]')).toBeAttached();
  await page.locator('[data-bind-button="text"]').click();
  const t0 = Date.now();
  await page.locator('[data-binding-field="text"] textarea').fill("{{ lamps.rows | count }} lamps");
  await expect(page.locator("[data-canvas-root]").getByText("48 lamps")).toBeVisible({ timeout: 4000 });
  const ms = Date.now() - t0;
  log("item6 live after", { ms });
  expect(await page.locator("[data-canvas-root]").getByText(/There is no data source named/).count()).toBe(0);
  saveText("logs/item6-live-ms.json", JSON.stringify({ msFromTypingToValue: ms, debounceMs: 300 }, null, 2));
  await page.screenshot({ path: ev("screens", "item6-live-source.png") });
  await ctx.close();
});

// ---------- Item 7 ----------
test("item 7: Look in the builder bar; Customise makes an app-owned copy in 4 actions; an inline copy offers Save as a theme", async ({ browser }) => {
  const app = await create({ name: "R2 look", slug: "r2-look" });
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  const actions: string[] = [];
  await page.locator("[data-builder-look]").click(); actions.push("Look");
  await page.locator("[data-look-customise-open]").click(); actions.push("Customise");
  await page.locator("[data-look-accent]").fill("#22c55e"); actions.push("accent");
  await page.locator("[data-look-save]").click(); actions.push("Use on this app");
  await expect(page.locator("[data-look-inline]")).toBeVisible();
  await expect(page.locator("[data-look-save-theme]")).toBeVisible();
  await page.screenshot({ path: ev("screens", "item7-look-inline.png") });
  await page.waitForTimeout(800);
  const theme = (await draftOf(app.id)).doc as unknown as { theme: { inline?: { tokens: { color: { accent: string } } } } };
  expect(theme.theme.inline?.tokens.color.accent.toLowerCase()).toBe("#22c55e");
  expect(actions.length).toBeLessThanOrEqual(5);
  await page.locator("[data-look-save-theme]").click();
  await expect.poll(async () => ((await draftOf(app.id)).doc as unknown as { theme: { themeId?: string } }).theme.themeId ?? "").toMatch(/.+/);
  log("item7 actions", actions);
  await ctx.close();
});

// ---------- Item 8 ----------
test("item 8: after a publish, one label edit gives exactly one review line and no phantom theme change", async ({ browser }) => {
  const app = await create({ name: "R2 blank", slug: "r2-blank" });
  const d = await draftOf(app.id);
  await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2diskstat", type: "stat", props: { label: "Disk free" }, slot: { x: 0, y: 0, w: 3, h: 12 } } }]);
  await publish(app.id);
  await ops(app.id, [{ op: "node.update", nodeId: "c_r2diskstat", patch: { props: { label: "Disk free (NAS)" } } }]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator("[data-publish]").click();
  await expect(page.locator("[data-review]")).toBeVisible();
  await expect(page.locator("[data-review] [data-diff-line]")).toHaveCount(1);
  await expect(page.locator("[data-review] [data-diff-line]")).toContainText("Changed stat Disk free (NAS)");
  await expect(page.locator("[data-review]").getByText("Changed the theme")).toHaveCount(0);
  await page.screenshot({ path: ev("screens", "item8-one-line.png") });
  await ctx.close();
});

// ---------- Item 9 ----------
test("item 9: App look has a style panel for bar, item and active item; removed CSS is listed and the review warns", async ({ browser }) => {
  const app = await create({ name: "R2 css", slug: "r2-css" });
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator("[data-builder-look]").click();
  await expect(page.locator("[data-chrome-style-target]")).toHaveText(["Bar", "Item", "Active item"]);
  await page.locator('[data-chrome-style-target="active"]').click();
  await page.locator('[data-chrome-style-field="borderRadius"]').fill("6");
  await page.locator("summary", { hasText: "Advanced: navigation CSS" }).click();
  await page.locator("[data-chrome-css-input]").fill(":scope { position: fixed; top: -900px; left: 0; width: 100vw }");
  await page.locator("[data-chrome-css-save]").click();
  await expect(page.locator("[data-chrome-removed] li").first()).toContainText("Removed:");
  await page.screenshot({ path: ev("screens", "item9-removed-lines.png") });
  await page.waitForTimeout(600);
  const style = ((await draftOf(app.id)).doc as unknown as { chrome: { style?: { item?: { states?: { active?: { borderRadius?: number } } } } } }).chrome.style;
  expect(style?.item?.states?.active?.borderRadius).toBe(6);
  await page.keyboard.press("Escape");
  await page.locator("[data-publish]").click();
  await expect(page.locator('[data-review-problem="warning"]').filter({ hasText: /CSS rules? (was|were) removed/ })).toBeVisible();
  await page.screenshot({ path: ev("screens", "item9-review-warning.png") });
  await ctx.close();
});

// ---------- Item 10 ----------
test("item 10: the draft preview bar does not cover the app's title or navigation", async ({ browser }) => {
  const app = await create({ name: "R2 preview", slug: "r2-preview", template: "homelab", mappings: {} });
  for (const v of [SHELL_VARIANTS[1]!, LIGHT]) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await page.goto(`/a/${app.slug}?draft=1`);
    await expect(page.locator("[data-draft-preview-bar]")).toBeVisible();
    const bar = await page.locator("[data-draft-preview-bar]").boundingBox();
    const frame = await page.locator("[data-draft-offset] [data-atrium-canvas]").first().boundingBox();
    log(`item10 ${v.name}`, { bar, frame });
    expect(frame!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
    await page.screenshot({ path: ev("screens", `item10-draft-preview-${v.name}.png`) });
    await ctx.close();
  }
});

// ---------- Item 11 ----------
test("item 11: under 900px a reduced edit mode can select, edit content, reorder in Layers and publish", async ({ browser }) => {
  const app = await create({ name: "R2 phone", slug: "r2-phone" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2phonehdg", type: "heading", props: { text: "Hello", level: 1 }, slot: { x: 0, y: 0, w: 12, h: 8 } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2phonetxt", type: "text", props: { text: "Second" }, slot: { x: 0, y: 8, w: 12, h: 6 } } },
  ]);
  const ctx = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto(`/build/${app.slug}`);
  await expect(page.locator("[data-narrow-tabs]")).toBeVisible();
  await page.locator('[data-canvas-root] [data-node="c_r2phonehdg"]').click();
  await expect(page.locator('[data-selected-outline="c_r2phonehdg"]')).toBeVisible();
  await page.screenshot({ path: ev("screens", "item11-phone-select.png") });
  await page.locator('[data-narrow-tab="edit"]').click();
  await page.locator('[data-builder-inspector] [data-inspector-group="content"]').locator("textarea, input").first().fill("Hello from a phone");
  await page.screenshot({ path: ev("screens", "item11-phone-edit.png") });
  await page.locator('[data-narrow-tab="layers"]').click();
  await page.locator('[data-layer="c_r2phonehdg"]').click();
  await page.locator('[data-layer="c_r2phonehdg"] [data-layer-down]').click();
  await page.screenshot({ path: ev("screens", "item11-phone-layers.png") });
  await page.waitForTimeout(900);
  const after = await draftOf(app.id);
  const kids = after.doc.pages[0]!.root.children!;
  expect(kids.map((k) => k.id)).toEqual(["c_r2phonetxt", "c_r2phonehdg"]);
  expect(kids.find((k) => k.id === "c_r2phonehdg")!.props.text).toBe("Hello from a phone");
  await page.locator("[data-publish]").click();
  await page.locator("[data-publish-confirm]").click();
  await expect.poll(async () => ((await (await owner()).get(`/api/apps/${app.id}/versions`)).json()).then((j) => j.versions.length)).toBe(1);
  await ctx.close();
});

// ---------- Items 12, 13, 21 ----------
test("items 12, 13, 21: the apple touch icon resolves for owner and guest; guest room controls are 56px at 390; theme-color meta matches the manifest with a dark variant", async ({ browser }) => {
  const app = await create({ name: "R2 guest room", slug: "r2-guestroom", template: "guest-room", mappings: { ha: haId } });
  const d = await draftOf(app.id);
  const lamp = d.doc.controls.find((x) => x.label === "Lamp")!;
  const scene = d.doc.controls.find((x) => x.label === "Evening scene")!;
  await ops(app.id, [
    { op: "control.set", control: { id: lamp.id, label: "Lamp", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: "light.lamp" } }, cooldownMs: 500 } },
    { op: "control.set", control: { id: scene.id, label: "Evening scene", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: "light.porch" } }, cooldownMs: 1000 } },
  ]);
  await publish(app.id);
  await (await owner()).put(`/api/apps/${app.id}/access`, { data: { view: "owner", edit: "owner", guests: true } });
  const link = await (await (await owner()).post("/api/auth/atrium/guest-links", { data: { appId: app.id, label: "r2 room guest" } })).json();
  const out: Record<string, unknown> = {};
  for (const who of ["owner", "guest"] as const) {
    const ctx = who === "owner" ? await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: LIGHT }) : await contextFor(browser, null, { viewport: { width: 390, height: 844 }, mobile: true });
    const page = await ctx.newPage();
    if (who === "guest") { await page.goto(new URL(link.url).pathname); await page.waitForURL(/\/a\/r2-guestroom/); } else await page.goto(`/a/${app.slug}`);
    await expect(page.getByRole("switch", { name: "Lamp" })).toBeVisible();
    const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
    const icon = await page.request.get(href!);
    const buf = Buffer.from(await icon.body());
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");
    expect(pngSize(buf)).toEqual({ w: 192, h: 192 });
    const heights = await page.evaluate(() => [...document.querySelectorAll('[role="switch"], [data-app-page] button')].map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0));
    const switchRow = await page.getByRole("switch", { name: "Lamp" }).evaluate((e) => Math.round((e.closest("[data-node]") as HTMLElement).getBoundingClientRect().height));
    const sceneBtn = await page.getByRole("button", { name: "Evening scene" }).evaluate((e) => Math.round(e.getBoundingClientRect().height));
    const metas = await page.locator('meta[name="theme-color"]').evaluateAll((els) => els.map((e) => ({ media: e.getAttribute("media"), content: e.getAttribute("content") })));
    out[who] = { href, size: pngSize(buf), heights, switchRow, sceneBtn, metas };
    expect(switchRow).toBeGreaterThanOrEqual(56);
    expect(sceneBtn).toBeGreaterThanOrEqual(56);
    if (who === "owner") {
      const m = await (await page.request.get(`/a/${app.slug}/manifest.webmanifest`)).json();
      // Round 3 (w2-r2 item 12): a light app emits one theme-color, the manifest's; the dark variant is
      // only for apps that render a dark set in dark mode (f-gauntlet-r3 "item 12").
      expect(metas.map((x) => x.content)).toEqual([m.theme_color]);
      out.manifestThemeColor = m.theme_color;
    }
    await page.screenshot({ path: ev("screens", `item13-guestroom-${who}-390.png`), fullPage: true });
    await ctx.close();
  }
  saveText("logs/items-12-13-21.json", JSON.stringify(out, null, 2));
});

// ---------- Items 14, 16, 22 ----------
test("items 14, 16, 22: audience labels are 44px on touch; the guest link form appears right after saving; one disabled-button style", async ({ browser }) => {
  const app = await create({ name: "R2 settings", slug: "r2-settings" });
  const d = await draftOf(app.id);
  await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2settxtaa", type: "text", props: { text: "x" }, slot: { x: 0, y: 0, w: 4, h: 6 } } }]);
  await publish(app.id);
  const phone = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: SHELL_VARIANTS[1] });
  const pp = await phone.newPage();
  await pp.goto(`/build/${app.slug}/settings`);
  await expect(pp.locator("[data-access-option]").first()).toBeVisible();
  const labels = await pp.locator("[data-access-option]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  log("item14 audience label heights", labels);
  expect(labels.length).toBe(6);
  expect(labels.every((h) => h >= 44)).toBe(true);
  await pp.screenshot({ path: ev("screens", "item14-audience-390-dark.png"), fullPage: true });
  await phone.close();
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto(`/build/${app.slug}/settings`);
  // 22: the disabled Save name and Save audience share one style at 40% opacity with no shadow.
  const look = async (sel: string) => page.locator(sel).evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, color: s.color, opacity: s.opacity, shadow: s.boxShadow, border: s.borderColor }; });
  const a = await look("[data-save-name]");
  const b = await look("[data-save-access]");
  log("item22 disabled styles", { a, b });
  expect(a).toEqual(b);
  expect(a.opacity).toBe("0.4");
  expect(a.shadow === "none" || /^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/.test(a.shadow)).toBe(true); // no visible shadow
  await page.screenshot({ path: ev("screens", "item22-disabled-light.png") });
  // 16: guests on, Save audience: the Label, Expires and PIN form is there without a reload.
  await page.getByRole("switch", { name: /Guest links/ }).click();
  await page.locator("[data-save-access]").click();
  await expect(page.getByRole("button", { name: "Create guest link" })).toBeVisible({ timeout: 5000 });
  await expect(page.locator("[data-guests-off]")).toHaveCount(0);
  await page.screenshot({ path: ev("screens", "item16-guest-form-after-save.png"), fullPage: true });
  await ctx.close();
});

// ---------- Item 15 ----------
test("item 15 (Wave 2.5, the data picker replaces the form): a bad name or bad JSON keeps what was typed, says what is wrong, and changes nothing", async ({ browser }) => {
  const app = await create({ name: "R2 sources", slug: "r2-sources" });
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  await page.locator("[data-add-source]").click();
  await page.locator(`[data-pick-integration="${haId}"]`).click();
  await page.locator('[data-pick-endpoint="states"]').click();
  await expect.poll(async () => (await draftOf(app.id)).doc.dataSources?.length ?? 0).toBe(1);
  await page.locator("[data-pick-more-settings-toggle]").click();
  // A name that breaks the naming rule is refused with the rule, and the source keeps its name.
  await page.locator("[data-pick-name]").fill("Bad Name");
  await page.locator("[data-pick-name]").press("Enter");
  await expect(page.getByText("That name cannot be used", { exact: true })).toBeVisible();
  await expect(page.locator("[data-pick-name]")).toHaveValue("entities");
  // Bad JSON settings keep the last valid values and say so; the picker stays open.
  await page.locator("[data-pick-params-json] [role=switch]").click();
  await page.locator("[data-pick-params-json-text]").fill("{domain: light");
  await page.locator("[data-pick-params-json] [role=switch]").click();
  await expect(page.getByText("That JSON is not valid", { exact: true })).toBeVisible();
  await expect(page.locator("[data-data-picker]")).toBeVisible();
  await page.screenshot({ path: ev("screens", "item15-picker-errors.png") });
  const d = await draftOf(app.id) as unknown as { doc: { dataSources: { name: string; params?: unknown }[] } };
  expect(d.doc.dataSources.map((x) => x.name)).toEqual(["entities"]);
  expect(d.doc.dataSources[0]!.params).toBeUndefined();
  await page.locator("[data-pick-done]").click();
  await expect(page.locator('[data-source="entities"]')).toBeAttached();
  await ctx.close();
});

// ---------- Item 17 ----------
test("item 17: Insert scrolls the new node into view and selects it with the settle outline; items show a glyph and summary; dragging lifts the component", async ({ browser }) => {
  const app = await create({ name: "R2 insert", slug: "r2-insert" });
  const d = await draftOf(app.id);
  await ops(app.id, Array.from({ length: 8 }, (_, i) => ({ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: `c_r2fill${"abcdefgh"[i]}aaa`, type: "text", props: { text: `Filler ${i}` }, slot: { x: 0, y: i * 16, w: 12, h: 16 } } })));
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, recordVideo: ev("video", "insert") });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  const items = await page.locator("[data-insert-item]").count();
  expect(await page.locator("[data-insert-item] [data-insert-glyph]").count()).toBe(items);
  expect(await page.locator("[data-insert-item] [data-insert-summary]").count()).toBeGreaterThan(items * 0.8);
  await page.screenshot({ path: ev("screens", "item17-catalogue.png") });
  await page.locator('[data-insert-item="stat"]').first().click();
  await skipPicker(page); // Wave 2.6: a new data widget opens the data picker
  const outline = page.locator("[data-selected-outline][data-settled]");
  await expect(outline).toBeVisible();
  const id = await outline.getAttribute("data-selected-outline");
  await page.waitForTimeout(900);
  const node = await page.locator(`[data-canvas-root] [data-node="${id}"]`).boundingBox();
  const canvas = await page.locator("[data-builder-canvas]").boundingBox();
  expect(node!.y).toBeGreaterThanOrEqual(canvas!.y - 1);
  expect(node!.y + Math.min(node!.height, 40)).toBeLessThanOrEqual(canvas!.y + canvas!.height + 1);
  await page.screenshot({ path: ev("screens", "item17-inserted-in-view.png") });
  // Drag: the component lifts under the pointer on the lifted shadow; only the target cell is lit.
  // The Insert list grew (Wave 2.7 Card for each); bring the item on screen before dragging it.
  await page.locator('[data-insert-item="gauge"]').first().scrollIntoViewIfNeeded();
  const src = await page.locator('[data-insert-item="gauge"]').first().boundingBox();
  await page.mouse.move(src!.x + 20, src!.y + 20);
  await page.mouse.down();
  await page.mouse.move(src!.x + 300, src!.y + 120, { steps: 8 });
  await page.mouse.move(canvas!.x + 300, canvas!.y + 200, { steps: 8 });
  await expect(page.locator("[data-drag-lifted]")).toBeVisible();
  const shadow = await page.locator("[data-drag-lifted]").evaluate((e) => getComputedStyle(e).boxShadow);
  expect(shadow).toContain("10px 10px");
  const wash = await page.locator("[data-grid-cells] > div").evaluate((e) => getComputedStyle(e).backgroundImage);
  expect(wash).not.toMatch(/color-mix|rgba?\(233, 185, 73/);
  await page.screenshot({ path: ev("screens", "item17-drag-lifted.png") });
  await page.mouse.up();
  await ctx.close();
});

// ---------- Items 18, 19 ----------
test("items 18, 19: versions show a vertical timeline with the selected card raised and a one-line 'Nothing before'; phone targets are 44px", async ({ browser }) => {
  const app = await create({ name: "R2 versions", slug: "r2-versions" });
  const d = await draftOf(app.id);
  await ops(app.id, [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2vertxtaa", type: "text", props: { text: "v1" }, slot: { x: 0, y: 0, w: 4, h: 6 } } }]);
  await publish(app.id);
  await ops(app.id, [{ op: "node.update", nodeId: "c_r2vertxtaa", patch: { props: { text: "v2" } } }]);
  await publish(app.id);
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await page.goto(`/build/${app.slug}/versions`);
    await page.locator('[data-version-card="1"]').click();
    const none = await page.locator('[data-version-preview="none"]').boundingBox();
    expect(none!.height).toBeLessThanOrEqual(60);
    const shadow = await page.locator('[data-version-card="1"]').evaluate((e) => getComputedStyle(e).boxShadow);
    expect(shadow).not.toBe("none");
    expect(await page.locator("[data-version-dot]").count()).toBe(2);
    await page.screenshot({ path: ev("screens", `item18-versions-${v.name}.png`), fullPage: true });
    await ctx.close();
  }
  const phone = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: LIGHT });
  const pp = await phone.newPage();
  await pp.goto(`/build/${app.slug}`);
  // Wait for each target to be visible first: boundingBox() answers null for an element not yet shown
  // (one full-suite run of 2 read null right after goto; e2e regression r2).
  await expect(pp.locator("[data-back-to-apps]")).toBeVisible();
  await expect(pp.locator("[data-page-switcher]")).toBeVisible();
  const back = await pp.locator("[data-back-to-apps]").boundingBox();
  const select = await pp.locator("[data-page-switcher]").boundingBox();
  await pp.goto(`/build/${app.slug}/versions`);
  await expect(pp.locator("[data-compare]")).toBeVisible();
  const compare = await pp.locator("[data-compare]").boundingBox();
  log("item19 heights", { back: back!.height, select: select!.height, compare: compare!.height });
  expect([back!.height, select!.height, compare!.height].every((h) => h >= 44)).toBe(true);
  await pp.screenshot({ path: ev("screens", "item19-versions-390.png"), fullPage: true });
  await phone.close();
});

// ---------- Item 20 ----------
test("item 20: launcher tiles fill the phone width one per row and sit three or more to a row at 1440; import is a Secondary header button; hover ends on the lifted shadow", async ({ browser }) => {
  const phone = await contextFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true, variant: LIGHT });
  const pp = await phone.newPage();
  await pp.goto("/");
  await expect(pp.locator("[data-app-tile]").first()).toBeVisible();
  await pp.waitForTimeout(1200); // the opening sweep settles the tiles
  const widths = await pp.locator("[data-app-tile]").evaluateAll((els) => els.slice(0, 4).map((e) => Math.round(e.getBoundingClientRect().width)));
  const xs = await pp.locator("[data-app-tile]").evaluateAll((els) => els.slice(0, 4).map((e) => Math.round(e.getBoundingClientRect().x)));
  log("item20 phone", { widths, xs });
  expect(new Set(widths).size).toBe(1);
  expect(widths[0]!).toBeGreaterThanOrEqual(350);
  expect(new Set(xs).size).toBe(1);
  await pp.screenshot({ path: ev("screens", "item20-launcher-390.png") });
  await phone.close();
  const ctx = await contextFor(browser, OWNER, { viewport: { width: 1440, height: 900 }, variant: LIGHT });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.locator("[data-app-tile]").first()).toBeVisible();
  await page.waitForTimeout(1200);
  const firstRow = await page.locator("[data-app-tile]").evaluateAll((els) => { const r = els.map((e) => e.getBoundingClientRect()); return r.filter((x) => Math.abs(x.y - r[0]!.y) < 2).map((x) => Math.round(x.width)); });
  log("item20 desktop first row", firstRow);
  expect(firstRow.length).toBeGreaterThanOrEqual(3);
  expect(firstRow.every((w) => w === 300)).toBe(true);
  await expect(page.locator("[data-launcher-header] [data-import-app]")).toHaveAttribute("data-variant", "secondary");
  const tile = page.locator("[data-app-tile]").first();
  await tile.hover();
  await page.waitForTimeout(400);
  expect(await tile.evaluate((e) => getComputedStyle(e).boxShadow)).toContain("10px 10px");
  await page.screenshot({ path: ev("screens", "item20-launcher-1440.png") });
  await ctx.close();
});

// ---------- Shared file requests from components round 2 (lead approved) ----------
test("SFR-1 and SFR-2: the inspector shows components' header (name and type tag, library name), builder groups fold with the chevron; the Code category starts folded and opens on click or search", async ({ browser }) => {
  const c = await owner();
  const saved = (await (await c.post("/api/library", { data: { name: "R2 header card", node: { id: "c_r2hdrcarda", type: "card", props: { title: "x" }, children: [] }, sources: [], controls: [] } })).json()).component as { id: string; version: number };
  const app = await create({ name: "R2 header", slug: "r2-header" });
  const d = await draftOf(app.id);
  await ops(app.id, [
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2hdrheada", type: "heading", name: "Homelab title", props: { text: "Homelab", level: 1 }, slot: { x: 0, y: 0, w: 12, h: 8 } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_r2hdrinsta", type: `lib:${saved.id}`, props: {}, libraryRef: { componentId: saved.id, version: saved.version }, slot: { x: 0, y: 8, w: 6, h: 12 } } },
  ]);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT });
  const page = await ctx.newPage();
  await openBuilder(page, app.slug);
  // SFR-2: Code is folded; a click opens it; a search that matches opens it too.
  const fold = page.locator('[data-insert-fold="code"]');
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-insert-group="code"] [data-insert-item]')).toHaveCount(0);
  await expect(page.locator('[data-insert-group="layout"] [data-insert-item]').first()).toBeVisible();
  await fold.click();
  await expect(page.locator('[data-insert-group="code"] [data-insert-item="html"]')).toBeVisible();
  await fold.click();
  await page.locator("[data-insert-search]").fill("html");
  await expect(page.locator('[data-insert-group="code"] [data-insert-item="html"]')).toBeVisible();
  await page.screenshot({ path: ev("screens", "sfr2-code-folded-search.png") });
  // SFR-1: the header shows the name with a mono type tag, never "heading heading" or the lib: id.
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator('[data-layer="c_r2hdrheada"]').click();
  const header = page.locator("[data-builder-inspector] [data-inspector-header]");
  await expect(header).toContainText("Homelab title");
  await expect(header).not.toContainText("heading heading");
  await expect(header.locator("[data-type-tag]")).toHaveText("heading");
  await page.locator('[data-layer="c_r2hdrinsta"]').click();
  await expect(header).toContainText("R2 header card");
  await expect(header).not.toContainText("lib:");
  await expect(page.locator('[data-inspector-group="sources"] [data-fold-chevron]')).toBeVisible();
  await page.screenshot({ path: ev("screens", "sfr1-inspector-header.png") });
  await ctx.close();
});
