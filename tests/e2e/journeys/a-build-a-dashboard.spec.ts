// Journey: build a dashboard the way Tristan does, end to end, through the real screens (shared/verification.md
// V12). Runs on a fresh server after every change: tests/e2e/journeys/serve.sh, then
//   ATRIUM_E2E_SLOT=journeys ATRIUM_E2E_PORT=3117 pnpm exec playwright test tests/e2e/journeys --project=desktop
// Only the integration is set up through the API (the Home Assistant stand-in); everything else is clicks,
// drags and typing. Wave 2.5: the data is connected with the data picker. Evidence: evidence/journeys/<ATRIUM_E2E_EVIDENCE_ROUND>/.
import path from "node:path";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { api, byHand, contextFor, FAKE_HA_TOKEN, fakeHa, OWNER, SHELL_VARIANTS, type FakeHa } from "../app-builder/helpers";

test.describe.configure({ mode: "serial", timeout: 300_000 });
test.use({ actionTimeout: 15_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; the phone part sets its own width");

const EVIDENCE = path.resolve(`evidence/journeys/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}`);
const shot = (name: string) => { mkdirSync(EVIDENCE, { recursive: true }); return path.join(EVIDENCE, `${name}.png`); };
const RUN = Date.now().toString(36).slice(-4);
const NAME = `Journey ${RUN}`;
const SLUG = `journey-${RUN}`;

type Node = { id: string; type: string; slot?: { x: number; y: number; w: number; h: number }; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; slug: string; title: string; root: Node }[] } };

let ha: FakeHa | undefined;
let haId = "";
let appId = "";

async function draft(): Promise<Draft> {
  return (await (await api(OWNER)).get(`/api/apps/${appId}/draft`)).json();
}
async function untilDraft(ok: (d: Draft) => boolean, ms = 5000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft();
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const kids = (d: Draft) => d.doc.pages[0]!.root.children ?? [];
/** Wave 2.6: a new data widget opens the data picker; leave it on sample values. */
async function skipPicker(page: Page): Promise<void> {
  const picker = page.locator("[data-data-picker]");
  try { await picker.waitFor({ state: "visible", timeout: 2500 }); } catch { return; }
  const skip = page.locator("[data-pick-skip]");
  if (await skip.count()) await skip.click();
  else await page.locator("[data-pick-cancel]").click();
  await picker.waitFor({ state: "detached", timeout: 5000 });
}
/** Clicks an Insert item and returns the node it added. */
async function insert(page: Page, type: string): Promise<Node> {
  await page.locator('[data-left-tab="insert"]').click();
  const before = new Set(kids(await draft()).map((k) => k.id));
  await page.locator(`[data-insert-item="${type}"]`).first().click();
  await skipPicker(page);
  const d = await untilDraft((x) => kids(x).some((k) => !before.has(k.id)));
  const n = kids(d).find((k) => !before.has(k.id));
  expect(n, `${type} was added to the page`).toBeTruthy();
  return n!;
}
async function hidden(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-canvas-root] .atr-grid[data-fixed-rows] > .atr-cell > [data-node] > [data-slot="root"]')]
    .filter((e) => e.scrollHeight - e.clientHeight > 1).map((e) => e.parentElement!.dataset.type!));
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  ha = await fakeHa();
  const r = await (await api(OWNER)).post("/api/integrations", { data: { packageId: "home-assistant", name: "Home Assistant", config: { baseUrl: ha.url }, secrets: { token: FAKE_HA_TOKEN }, untested: true } });
  if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
  haId = (await r.json()).id;
});
test.afterAll(async () => { await ha?.close(); });

test("build a lights dashboard: create, connect data, compose, pages, fit, publish, then use it on desktop and phone", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await test.step("create an app from the launcher", async () => {
    await page.goto("/");
    await page.locator("[data-new-app], [data-new-app-tile]").first().click();
    await page.locator("[data-new-app-name]").fill(NAME);
    await page.locator("[data-new-app-slug]").fill(SLUG);
    await page.locator("[data-create-app]").click();
    await page.waitForURL(new RegExp(`/build/${SLUG}`));
    await expect(page.locator("[data-builder-bar]")).toBeVisible();
    const apps = (await (await (await api(OWNER)).get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[];
    appId = apps.find((t) => t.app.slug === SLUG)!.app.id;
  });

  let text: Node;
  await test.step("insert a text widget and connect it to the lights with the data picker, no typing", async () => {
    text = await insert(page, "text");
    await expect(page.locator(`[data-selected-outline="${text.id}"]`)).toBeVisible();
    await page.locator('[data-pick-button="text"]').click();
    await byHand(page); // Wave 2.9: the by-hand picker is one click past "What should this show?"
    await page.locator(`[data-pick-integration="${haId}"]`).click();
    await page.locator('[data-pick-endpoint="states"]').click();
    await expect(page.locator("[data-pick-sample]")).toBeVisible({ timeout: 5000 });
    // Name the source "lamps" (the published page shows "48 lamps" below).
    await page.locator("[data-pick-more-settings-toggle]").click();
    await page.locator("[data-pick-name]").fill("lamps");
    await page.locator("[data-pick-name]").press("Enter");
    const col = await page.locator("[data-pick-col]").first().getAttribute("data-pick-col");
    await page.locator(`[data-pick-col="${col}"]`).click();
    await page.locator('[data-pick-agg="count"]').click();
    await expect(page.locator(`[data-canvas-root] [data-node="${text.id}"]`)).toHaveText("48", { timeout: 3000 });
    await page.locator("[data-pick-done]").click();
    // Then a light touch in the template: add the word "lamps" (Wave 2.6: behind "Edit as template" under the data chip).
    await page.locator('[data-edit-template="text"]').click();
    await page.locator('[data-binding-field="text"] textarea').fill("{{ lamps.rows | count }} lamps");
    await expect(page.locator("[data-canvas-root]").getByText("48 lamps")).toBeVisible({ timeout: 5000 });
  });

  await test.step("insert a stat and a table; nothing they hold is hidden", async () => {
    await insert(page, "stat");
    await insert(page, "table");
    await page.waitForTimeout(600);
    expect(await hidden(page)).toEqual([]);
  });

  await test.step("drag a card from Insert onto the canvas", async () => {
    await page.locator('[data-left-tab="insert"]').click();
    const before = kids(await draft()).length;
    // The Insert list keeps its scroll from the last insert (Wave 2.9 made the Data section longer).
    await page.locator('[data-insert-item="card"]').first().scrollIntoViewIfNeeded();
    const item = (await page.locator('[data-insert-item="card"]').first().boundingBox())!;
    const canvas = (await page.locator("[data-canvas-root]").boundingBox())!;
    const to = { x: canvas.x + canvas.width * 0.75, y: canvas.y + 120 };
    await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(item.x + (to.x - item.x) * (i / 12), item.y + (to.y - item.y) * (i / 12));
    await expect(page.locator("[data-drop-ghost]")).toBeVisible();
    await page.mouse.up();
    expect(kids(await untilDraft((x) => kids(x).length > before)).length).toBe(before + 1);
  });

  await test.step("resize the text widget from its corner; the box lands where the ghost showed", async () => {
    await page.locator('[data-left-tab="layers"]').click();
    await page.locator(`[data-layer="${text.id}"]`).click();
    const start = kids(await draft()).find((k) => k.id === text.id)!.slot!;
    const h = (await page.locator('[data-resize-handle="se"]').boundingBox())!;
    await page.mouse.move(h.x + 5, h.y + 5);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(h.x + 5 + (160 * i) / 8, h.y + 5 + (48 * i) / 8);
    const ghost = (await page.locator("[data-drop-ghost]").boundingBox())!;
    await page.mouse.up();
    const d = await untilDraft((x) => kids(x).find((k) => k.id === text.id)!.slot!.w !== start.w);
    const slot = kids(d).find((k) => k.id === text.id)!.slot!;
    expect(slot.w).toBeGreaterThan(start.w);
    expect(slot.h).toBeGreaterThan(start.h);
    await page.waitForTimeout(400);
    const box = (await page.locator(`[data-canvas-root] [data-node="${text.id}"]`).boundingBox())!;
    expect(Math.abs(box.width - ghost.width)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(box.height - ghost.height)).toBeLessThanOrEqual(2.5);
  });

  await test.step("insert a heading, remove it from its drag bar, undo brings it back", async () => {
    const heading = await insert(page, "heading");
    await page.locator("[data-remove-selected]").click();
    await untilDraft((x) => !kids(x).some((k) => k.id === heading.id));
    await page.locator("[data-builder-canvas]").focus();
    await page.keyboard.press("Control+z");
    expect(kids(await untilDraft((x) => kids(x).some((k) => k.id === heading.id))).some((k) => k.id === heading.id)).toBe(true);
  });

  await test.step("add a second page from the Pages menu and come back", async () => {
    // Wave 2.10a round 2 item 13: the page opens at once with its name field focused (no browser prompt).
    await page.locator("[data-page-menu]").click();
    await page.locator("[data-page-add]").click();
    const name = page.locator("[data-page-name-input]");
    await expect(name).toBeFocused();
    await name.fill("Lights");
    await name.press("Enter");
    await page.waitForURL(new RegExp(`/build/${SLUG}/lights$`));
    await page.locator('[data-select="page"]').click();
    await page.locator('[data-select-menu="page"] [role="option"]').first().click();
    await expect(page.locator("[data-canvas-root]").getByText("48 lamps")).toBeVisible();
  });

  await test.step("fit every component, then publish with a note", async () => {
    await page.locator("[data-page-menu]").click();
    await page.locator("[data-page-fit]").click();
    expect(await hidden(page)).toEqual([]);
    await page.screenshot({ path: shot("builder-before-publish") });
    await page.locator("[data-publish]").click();
    await expect(page.locator("[data-publish-confirm]")).toBeEnabled();
    await page.locator("[data-review-note]").fill("First version");
    await page.locator("[data-publish-confirm]").click();
    await expect(page.locator("[data-publish-glow]")).toBeAttached();
    await expect.poll(async () => ((await (await (await api(OWNER)).get(`/api/apps/${appId}/versions`)).json()).versions as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
  await ctx.close();

  for (const [label, viewport, mobile] of [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]] as const) {
    await test.step(`open the published app on ${label}`, async () => {
      const v = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport, ...(mobile ? { mobile: true } : {}) });
      const p = await v.newPage();
      await p.goto(`/a/${SLUG}`);
      await expect(p.getByText("48 lamps")).toBeVisible({ timeout: 8000 });
      await expect(p.getByRole("link", { name: "Lights" }).first()).toBeAttached();
      expect(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await p.screenshot({ path: shot(`published-${label}`), fullPage: true });
      await v.close();
    });
  }
});

// Wave 2.7 (data ease spec, V12): "a card for each machine" from a Prometheus, through the real picker.
test("a card for each machine: a Repeat picks Machines overview from Prometheus and shows 9 live cards, published", async ({ browser }) => {
  const { startFakePrometheus } = await import("../fixtures/fake-prometheus");
  const prom = await startFakePrometheus();
  try {
    const c = await api(OWNER);
    const ir = await c.post("/api/integrations", { data: { packageId: "prometheus", name: `Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" }, secrets: {}, untested: true } });
    expect(ir.ok()).toBe(true);
    const promId = (await ir.json()).id as string;
    const slug = `machines-${RUN}`;
    const ar = await c.post("/api/apps", { data: { name: `Machines ${RUN}`, slug } });
    const appId = (await ar.json()).app.id as string;
    const d = await (await c.get(`/api/apps/${appId}/draft`)).json();
    await c.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: [{ op: "node.add", parentId: d.doc.pages[0].root.id, node: { id: "c_jrepeataaa", type: "repeat", props: { columns: 1, max: 50, empty: "Nothing to show" }, children: [], slot: { x: 0, y: 0, w: 12, h: 24 } } }] } });
    const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`/build/${slug}`);
    await page.locator('[data-left-tab="layers"]').click();
    await page.locator('[data-layer="c_jrepeataaa"]').click();
    await page.locator('[data-pick-button="items"]').click();
    await byHand(page); // Wave 2.9: the by-hand picker is one click past "What should this show?"
    await page.locator(`[data-pick-integration="${promId}"]`).click();
    await page.locator('[data-pick-endpoint="machines-overview"]').click();
    await expect(page.locator("[data-pick-cards]")).toBeVisible({ timeout: 5000 });
    await page.locator("[data-pick-done]").click();
    const items = page.locator('[data-canvas-root] [data-node="c_jrepeataaa"] [data-slot="item"]');
    await expect(items).toHaveCount(9, { timeout: 5000 });
    await page.waitForTimeout(1200);
    await page.locator("[data-publish]").first().click();
    await page.locator("[data-publish-confirm]").click();
    await page.waitForTimeout(1500);
    await page.goto(`/a/${slug}`);
    const viewed = page.locator('[data-node="c_jrepeataaa"] [data-slot="item"]');
    await expect(viewed).toHaveCount(9, { timeout: 8000 });
    await expect(viewed.filter({ hasText: "ACE" }).first()).toContainText("7.8");
    await page.screenshot({ path: shot("cards-for-each-machine-published"), fullPage: true });
    await ctx.close();
  } finally {
    await prom.close();
  }
});

// Wave 2.7 (media layout spec, V12): six stats across one row, then a picture rotated and captioned, by hand.
test("six stats across one row with no typing, then a picture uploaded, rotated and captioned, published", async ({ browser }) => {
  const c = await api(OWNER);
  const slug = `tiles-${RUN}`;
  const ar = await c.post("/api/apps", { data: { name: `Tiles ${RUN}`, slug } });
  appId = (await ar.json()).app.id as string;
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();

  await test.step("insert a stat, make it a Sixth, then Insert five more beside it", async () => {
    const first = await insert(page, "stat");
    await page.locator(`[data-canvas-root] [data-node="${first.id}"]`).click();
    const layout = page.locator('[data-inspector-group="layout"]').first();
    if (!(await layout.evaluate((d) => (d as HTMLDetailsElement).open))) await layout.locator("> summary").click();
    await layout.locator('[data-layout-preset="Sixth"]').click();
    await untilDraft((x) => kids(x).find((k) => k.id === first.id)?.slot?.w === 2);
    for (let i = 0; i < 5; i++) await insert(page, "stat");
    const d = await untilDraft((x) => kids(x).length === 6);
    const slots = kids(d).map((k) => k.slot!);
    expect(new Set(slots.map((s) => s.y)).size, "all six on one row").toBe(1);
    expect(slots.map((s) => s.x).sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8, 10]);
    await page.screenshot({ path: shot("six-stats-across") });
  });

  await test.step("upload a picture, rotate it right and give it a caption over the picture", async () => {
    const pic = await insert(page, "image");
    await page.locator(`[data-canvas-root] [data-node="${pic.id}"]`).click();
    const chooser = page.waitForEvent("filechooser");
    await page.locator('[data-media-field="image"] [data-media-upload]').click();
    await (await chooser).setFiles(path.resolve("tests/e2e/app-builder/media/photo.jpg"));
    await untilDraft((x) => typeof (kids(x).find((k) => k.id === pic.id) as { props?: { src?: unknown } } | undefined)?.props?.src === "string", 10_000);
    await page.locator('[data-media-rotate="right"]').click();
    await page.locator("[data-media-caption-text]").fill("The rack");
    await page.locator('[data-media-caption-at="over"]').click();
    const d = await untilDraft((x) => {
      const p = (kids(x).find((k) => k.id === pic.id) as { props?: Record<string, unknown> } | undefined)?.props;
      return p?.rotate === 90 && p?.caption === "The rack" && p?.captionAt === "over";
    });
    const props = (kids(d).find((k) => k.id === pic.id) as unknown as { props: Record<string, unknown> }).props;
    expect([props.rotate, props.caption, props.captionAt]).toEqual([90, "The rack", "over"]);
    await page.waitForTimeout(1200);
    await page.locator("[data-publish]").first().click();
    await page.locator("[data-publish-confirm]").click();
    await page.waitForTimeout(1500);
    await page.goto(`/a/${slug}`);
    await expect(page.locator(`[data-node="${pic.id}"]`)).toContainText("The rack");
    await page.screenshot({ path: shot("tiles-and-picture-published"), fullPage: true });
  });
  await ctx.close();
});

// Wave 2.8 (recipes spec, V12): import a Grafana dashboard on the integration page, turn it on, then put
// one of its reads on a page through the real picker and see the value in the published app.
test("import a Grafana dashboard and put a read on a page: a stat picks the dashboard's load read for one machine, published", async ({ browser }) => {
  const { writeFileSync } = await import("node:fs");
  const { startFakePrometheus } = await import("../fixtures/fake-prometheus");
  const prom = await startFakePrometheus();
  try {
    const c = await api(OWNER);
    const ir = await c.post("/api/integrations", { data: { packageId: "prometheus", name: `Grafana Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" }, secrets: {}, untested: true } });
    expect(ir.ok()).toBe(true);
    const promId = (await ir.json()).id as string;
    // A tiny dashboard: one stat panel on a "which machine" setting from label_values.
    const uid = `lab-load-${RUN}`;
    const dashboard = {
      title: `Lab load ${RUN}`, uid, time: { from: "now-6h" },
      templating: { list: [{ type: "query", name: "node", label: "Machine", query: "label_values(node_uname_info, instance)" }] },
      panels: [{ type: "stat", title: "Load (5 min)", description: "Five minute load average.", targets: [{ expr: 'node_load5{instance="$node"}', refId: "A" }] }],
    };
    mkdirSync(EVIDENCE, { recursive: true });
    const file = path.join(path.resolve("test-results"), `journey-grafana-${RUN}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(dashboard, null, 2));
    const recipeId = `grafana/${uid}`;
    const readId = `r:${recipeId}:load-5-min`;

    const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await test.step("import the dashboard in the integration's Recipes section and turn it on", async () => {
      await page.goto(`/integrations/${promId}`);
      await page.locator("[data-recipe-import-grafana]").click();
      await expect(page.locator("[data-grafana-sheet]")).toBeVisible();
      await page.locator("[data-grafana-file]").setInputFiles(file);
      const row = page.locator(`[data-recipe="${recipeId}"]`);
      await expect(row).toHaveAttribute("data-recipe-source", "grafana", { timeout: 15_000 });
      await expect(row).toHaveAttribute("data-recipe-status", "draft");
      await expect(page.locator("[data-check-progress]")).toHaveCount(0, { timeout: 30_000 });
      await expect(row.locator("[data-recipe-works]")).toHaveText("2 of 2 reads work on this server", { timeout: 10_000 });
      await row.locator('[role="switch"]').click();
      await expect(row).toHaveAttribute("data-recipe-status", "active");
      await page.screenshot({ path: shot("grafana-recipe-on") });
    });

    const slug = `grafana-${RUN}`;
    await test.step("create an app, insert a stat and pick the dashboard's read and a machine in the picker", async () => {
      await page.goto("/");
      await page.locator("[data-new-app], [data-new-app-tile]").first().click();
      await page.locator("[data-new-app-name]").fill(`Grafana ${RUN}`);
      await page.locator("[data-new-app-slug]").fill(slug);
      await page.locator("[data-create-app]").click();
      await page.waitForURL(new RegExp(`/build/${slug}`));
      await expect(page.locator("[data-builder-bar]")).toBeVisible();
      await page.locator('[data-left-tab="insert"]').click();
      await page.locator('[data-insert-item="stat"]').first().click();
      await expect(page.locator("[data-data-picker]")).toBeVisible();
      await byHand(page); // Wave 2.9: the by-hand picker is one click past "What should this show?"
      await page.locator(`[data-pick-integration="${promId}"]`).click();
      const read = page.locator(`[data-pick-endpoint="${readId}"]`);
      await expect(read).toBeVisible();
      await expect(read.locator("[data-pick-endpoint-from]")).toHaveText(`Lab load ${RUN}, from Grafana`);
      await read.click();
      await page.locator('[data-pick-thing="10.77.99.8:9100"]').click();
      await expect(page.locator("[data-pick-sample]")).toContainText("0.41", { timeout: 8000 });
      await page.locator("[data-pick-use]").click();
      await expect(page.locator('[data-canvas-root] [data-type="stat"] [data-slot="value"]').first()).toContainText("0.4", { timeout: 8000 });
      await page.locator("[data-pick-done]").click();
      await expect(page.locator("[data-data-picker]")).toHaveCount(0);
      await page.screenshot({ path: shot("grafana-read-in-builder") });
    });

    await test.step("publish and see the value in the viewer", async () => {
      await page.waitForTimeout(1200);
      await page.locator("[data-publish]").first().click();
      await page.locator("[data-publish-confirm]").click();
      await expect(page.locator("[data-publish-glow]")).toBeAttached();
      await page.goto(`/a/${slug}`);
      await expect(page.locator('[data-type="stat"] [data-slot="value"]').first()).toContainText("0.4", { timeout: 8000 });
      await page.screenshot({ path: shot("grafana-read-published"), fullPage: true });
    });
    await ctx.close();
  } finally {
    await prom.close();
  }
});

test("a start page from three services, then a CPU chart for every machine, published (Wave 2.9 journey)", async ({ browser }) => {
  const { startFakePrometheus } = await import("../fixtures/fake-prometheus");
  const { fakeDocker } = await import("../integrations/fakes");
  const prom = await startFakePrometheus();
  const docker = await fakeDocker();
  try {
    const c = await api(OWNER);
    const mk = async (data: Record<string, unknown>) => {
      const r = await c.post("/api/integrations", { data: { secrets: {}, untested: true, ...data } });
      expect(r.ok()).toBe(true);
      return (await r.json()).id as string;
    };
    const promId = await mk({ packageId: "prometheus", name: `Start Prometheus ${RUN}`, config: { baseUrl: prom.url, authMode: "none" } });
    const dockerId = await mk({ packageId: "docker", name: `Start Docker ${RUN}`, config: { endpoint: `tcp://127.0.0.1:${docker.port}` } });
    // Home Assistant is the one beforeAll connected; earlier journeys left other services, unticked below.
    const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[1], viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    let slug = "";
    await test.step("New app > Start page with the three services ticked", async () => {
      await page.goto("/");
      await page.locator("[data-new-app], [data-new-app-tile]").first().click();
      await page.locator("[data-new-app-name]").fill(`Start ${RUN}`);
      await page.locator('[data-template-option="start-page"]').click();
      const mine = [promId, dockerId, haId];
      for (const x of mine) await expect(page.locator(`[data-start-service="${x}"]`)).toHaveAttribute("aria-checked", "true");
      for (const other of await page.locator("[data-start-service]").all()) {
        if (mine.includes((await other.getAttribute("data-start-service"))!)) continue;
        if ((await other.getAttribute("aria-checked")) === "true") await other.click();
        await expect(other).toHaveAttribute("aria-checked", "false");
      }
      await page.locator("[data-create-app]").click();
      await page.waitForURL(/\/build\//);
      slug = page.url().split("/build/")[1]!.split(/[/?]/)[0]!;
      await expect(page.locator("[data-canvas-root] [data-type='resource-bar']")).toHaveCount(1, { timeout: 8000 });
      const tiles = page.locator("[data-canvas-root] [data-type='service-tile']");
      await expect(tiles).toHaveCount(3, { timeout: 8000 });
      for (const name of [`Start Prometheus ${RUN}`, `Start Docker ${RUN}`, "Home Assistant"]) await expect(tiles.filter({ hasText: name })).toHaveCount(1, { timeout: 8000 });
      await page.screenshot({ path: shot("start-page-made") });
    });
    await test.step("insert a chart, pick CPU for one machine, then Also for: Every machine", async () => {
      await page.locator('[data-left-tab="insert"]').click();
      await page.locator('[data-insert-item="chart"]').click();
      const picker = page.locator("[data-show-picker]");
      await expect(picker).toHaveAttribute("data-mode", "line");
      await page.locator("[data-show-search]").fill("cpu");
      const item = page.locator(`[data-show-item][data-show-integration="${promId}"][data-show-endpoint="machine-cpu"][data-show-thing-value="10.77.99.8:9100"]`).first();
      await expect(item).toBeVisible({ timeout: 3000 });
      await item.click();
      await expect(picker).toHaveCount(0);
      const g = page.locator('section[data-inspector-group="data"]');
      await expect(g).toBeVisible();
      if ((await g.getAttribute("data-open")) === null) await g.locator("h3 > button").click();
      await page.locator('[data-also-for="*"]').click();
      await expect(page.locator('[data-chart-line="1"] [data-chart-line-words]')).toContainText("9 lines", { timeout: 15_000 });
      await expect.poll(async () => (await page.locator("[data-canvas-root] [data-type='chart'] [data-legend-line]").allTextContents()).length, { timeout: 10_000 }).toBeGreaterThan(1);
      await page.screenshot({ path: shot("start-page-every-machine-chart") });
    });
    await test.step("publish and see the start page and the chart in the viewer", async () => {
      await page.waitForTimeout(1200);
      await page.locator("[data-publish]").first().click();
      await page.locator("[data-publish-confirm]").click();
      await expect(page.locator("[data-publish-glow]")).toBeAttached();
      await page.goto(`/a/${slug}`);
      await expect(page.locator("[data-type='resource-bar']")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("[data-type='service-tile']")).toHaveCount(3);
      await expect.poll(async () => (await page.locator("[data-type='chart'] [data-legend-line]").allTextContents()).length, { timeout: 10_000 }).toBeGreaterThan(1);
      await page.screenshot({ path: shot("start-page-published"), fullPage: true });
    });
    await ctx.close();
  } finally {
    await prom.close();
    await docker.close();
  }
});
