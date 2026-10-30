// Wave 2.6 builder ease, the inspector side (stages/02-subsystem-spec/output/builder-ease-spec.md 3.2 and
// 3.3; criteria 9, 10, 11, 12, 14 and the inspector side of 1 and 6), through the real builder screen
// (V11): written labels and hints on every field of every built-in component, simple sets with the
// rest under a remembered "More settings", "Customise the look", Layout presets and fields, grid columns
// that keep children in place, data chips and the Data sentence, typo'd sources, and media fields.
// Served by tests/e2e/components/serve.sh (port 3114). Evidence: evidence/components/<round>/ease/.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { BUILT_IN_TYPES } from "../../../src/features/components/catalogue/schemas";
import { fieldsFor } from "../../../src/features/components/inspector/fields";
import { FIELD_WORDS, HIDDEN_FIELDS } from "../../../src/features/components/inspector/labels";
import { FAKE_HA_TOKEN, fakeHa, type FakeHa } from "../app-builder/helpers";
import { evidence, signIn, writeEvidence } from "./helpers";

test.describe.configure({ timeout: 240_000 });

const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: { x: number; y: number; w: number; h: number }; children?: Node[]; name?: string; overrideTheme?: boolean };
type Draft = { rev: number; doc: { dataSources: { name: string }[]; pages: { id: string; root: Node }[] } };
const shot = (name: string) => evidence("ease", `${name}.png`);

let ha: FakeHa | undefined;
let haId = "";
let deadId = "";

async function draft(req: APIRequestContext, id: string): Promise<Draft> {
  return (await req.get(`/api/apps/${id}/draft`)).json();
}
async function ops(req: APIRequestContext, id: string, list: unknown[]) {
  const d = await draft(req, id);
  const r = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function newApp(req: APIRequestContext, slug: string, kids: Node[], extra: unknown[] = []): Promise<{ id: string; rootId: string }> {
  const r = await req.post("/api/apps", { data: { name: `Ease ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await draft(req, id);
  const rootId = d.doc.pages[0]!.root.id;
  const list = [...extra, ...kids.map((n, i) => ({ op: "node.add", parentId: rootId, node: { slot: { x: 0, y: i * 20, w: 6, h: 18 }, ...n } }))];
  if (list.length) await ops(req, id, list);
  return { id, rootId };
}
async function untilDraft(req: APIRequestContext, id: string, ok: (d: Draft) => boolean, ms = 5000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(req, id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const find = (n: Node, id: string): Node | undefined => (n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean));
async function open(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
}
async function select(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${id}"]`).click();
  await expect(page.locator(`[data-inspector][data-node-id="${id}"]`)).toBeVisible();
}
const inspector = (page: Page) => page.locator("[data-inspector-groups]");
async function openGroup(page: Page, name: string) {
  const g = page.locator(`[data-inspector-group="${name}"]`).first();
  if (name === "layout" || name === "sources") {
    if (!(await g.evaluate((d) => (d as HTMLDetailsElement).open))) await g.locator("> summary").click();
  } else if ((await g.getAttribute("data-open")) === null) await g.locator("h3 button").click();
  return g;
}
/** Every field key the inspector shows right now. */
async function shownKeys(page: Page): Promise<string[]> {
  return inspector(page).evaluate((root) => {
    const out = new Set<string>();
    for (const e of root.querySelectorAll("[data-field]")) out.add(e.getAttribute("data-field")!);
    for (const e of root.querySelectorAll("[data-fields]")) for (const k of e.getAttribute("data-fields")!.split(" ")) out.add(k);
    return [...out].sort();
  });
}
async function setFolds(page: Page, open: boolean) {
  for (const t of await inspector(page).locator("[data-more-settings-toggle]").all()) {
    if (!(await t.isVisible())) continue; // inside a closed group (Layout, Style)
    if ((await t.getAttribute("aria-expanded")) !== String(open)) await t.click({ timeout: 5000 });
  }
}

test.beforeAll(async () => {
  ha = await fakeHa();
});
test.afterAll(async () => { await ha?.close(); });

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project; the phone width is set per test");
  await signIn(context, page.request);
  if (!haId) {
    const mk = async (name: string, baseUrl: string) => {
      const r = await page.request.post("/api/integrations", { data: { packageId: "home-assistant", name, config: { baseUrl }, secrets: { token: FAKE_HA_TOKEN }, untested: true }, headers: H });
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()).id as string;
    };
    haId = await mk(`Home Assistant ${RUN}`, ha!.url);
    deadId = await mk(`Broken HA ${RUN}`, "http://127.0.0.1:9");
  }
});

test("criteria 9 and 10: every field of every built-in component has its written label and hint; each group opens on its simple set and More settings shows every field", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const types = BUILT_IN_TYPES;
  const kids: Node[] = types.map((t, i) => ({ id: `c_ease${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}aaaa`, type: t, name: `Ease ${t}`, props: t === "html" ? { html: "<p>x</p>", css: "", js: "", data: {}, controls: [], height: "auto", libs: [], images: [] } : {} }));
  const slug = `ease-all-${RUN}`;
  await newApp(page.request, slug, kids);
  await open(page, slug);
  const report: Record<string, { simple: string[]; all: string[] }> = {};
  for (const k of kids) {
    const type = k.type as (typeof types)[number];
    await select(page, k.id);
    await setFolds(page, false);
    // A service tile's integrationId is a builder reference, never shown or typed (A10.7).
    // Wave 2.10b F6: the icon's px Size and Fill are no longer shown either (labels.ts HIDDEN_FIELDS).
    const want = fieldsFor(type).map((f) => f.key).filter((k) => !HIDDEN_FIELDS.has(`${type}.${k}`)).sort();
    const simpleWant = fieldsFor(type).filter((f) => f.simple).map((f) => f.key);
    const simple = await shownKeys(page);
    // Folded: the simple set only (html's Edit code stands for its html, css and js).
    for (const s of simpleWant) expect(simple, `${type}: simple ${s}`).toContain(s);
    for (const s of simple) expect(simpleWant.includes(s) || (type === "html" && ["css", "js", "controls"].includes(s)) || ["button", "toggle", "slider", "select"].includes(type) && s === "control", `${type}: ${s} should be under More settings`).toBe(true);
    await setFolds(page, true);
    const all = await shownKeys(page);
    expect(all, `${type}: More settings shows every field`).toEqual(want);
    // Criterion 9: each field's written label shows (never the generated one), with its hint.
    const words = (FIELD_WORDS as unknown as Record<string, { fields: Record<string, { label: string; hint: string }> }>)[type]!.fields;
    const text = await inspector(page).innerText();
    for (const key of want) {
      if (type === "html" && ["css", "js"].includes(key)) continue; // edited in the code window behind Edit code
      expect(text, `${type}.${key} label`).toContain(words[key]!.label);
      // Wave 2.10b F4: a setting that cannot show its effect now shows its reason in place of the hint.
      if (!(type === "html" && key === "html") && !text.includes(words[key]!.hint)) {
        const reason = await inspector(page).locator(`[data-field="${key}"] [data-field-reason]`).count();
        expect(reason, `${type}.${key}: its hint or a reason in its place`).toBeGreaterThan(0);
      }
    }
    report[type] = { simple, all };
  }
  writeEvidence("ease/fields-per-type.json", report);
  // More settings is remembered per person: open after a reload.
  await page.reload();
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await select(page, kids.find((k) => k.type === "stat")!.id);
  await expect(page.locator('[data-more-settings="content"]').first()).toHaveAttribute("data-open", "");
});

test("criterion 11 and Style: Customise the look changes nothing until a style is set; the short set first, the rest under More style; Code and conditions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `ease-style-${RUN}`;
  const id = "c_easestylea";
  await newApp(page.request, slug, [{ id, type: "stat", props: { label: "CPU", value: 41, unit: "%" } }]);
  await open(page, slug);
  await select(page, id);
  const node = page.locator(`[data-canvas-root] [data-node="${id}"]`);
  const look = () => node.evaluate((el) => [el, ...el.querySelectorAll("*")].map((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderTopWidth, c.borderTopColor, c.borderRadius, c.padding, c.boxShadow, c.fontSize].join("|"); }).join("\n"));
  const before = await look();
  const shotBefore = await node.screenshot();
  const style = await openGroup(page, "style");
  await expect(style.getByRole("switch", { name: "Customise the look" })).toBeVisible();
  await expect(style).toContainText("Off: follows the app's theme. On: your settings below win.");
  await style.getByRole("switch", { name: "Customise the look" }).click();
  await expect(page.locator("[data-style-panel]")).toBeVisible();
  await page.waitForTimeout(800);
  expect(await look()).toBe(before);
  expect((await node.screenshot()).equals(shotBefore)).toBe(true);
  // The short set, in plain words; Part, When and the rest sit under More style.
  const common = page.locator("[data-style-common]");
  for (const t of ["Background", "Text colour", "Corners", "Padding", "Border", "Shadow", "Text size"]) await expect(common).toContainText(t);
  await expect(page.locator("[data-style-slot]")).toHaveCount(0);
  await page.locator("[data-style-more-toggle]").click();
  await expect(page.locator("[data-style-slot]")).toBeVisible();
  await expect(page.locator('[data-style-field="mixBlendMode"]')).toBeVisible();
  await page.locator("[data-style-more-toggle]").click();
  // A style set now applies.
  await common.locator('[data-style-field="background"] [data-swatch="accent"]').click();
  await expect.poll(look, { timeout: 4000 }).not.toBe(before);
  await page.screenshot({ path: shot("style-short-set") });
  const adv = await openGroup(page, "advanced");
  await expect(adv.locator("h3")).toHaveText("Code and conditions");
  await expect(adv.locator("[data-css-box]")).toBeVisible();
});

test("Layout: Fit to content and width presets first; Left, Top, Width and Height with units under More settings", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `ease-layout-${RUN}`;
  const id = "c_easelayout";
  const long = "A long note. ".repeat(60);
  const app = await newApp(page.request, slug, [{ id, type: "text", props: { text: long }, slot: { x: 0, y: 0, w: 3, h: 6 } }, { id: "c_easebelowa", type: "text", props: { text: "Below" }, slot: { x: 0, y: 6, w: 3, h: 6 } }]);
  await open(page, slug);
  await select(page, id);
  const layout = await openGroup(page, "layout");
  await expect(layout.locator("[data-layout-fields]")).toHaveCount(0);
  await layout.locator('[data-layout-preset="Half"]').click();
  let d = await untilDraft(page.request, app.id, (x) => find(x.doc.pages[0]!.root, id)?.slot?.w === 6);
  expect(find(d.doc.pages[0]!.root, id)!.slot!.w).toBe(6);
  await expect(layout.locator('[data-layout-preset="Half"]')).toHaveAttribute("aria-checked", "true");
  await layout.locator('[data-layout-preset="Quarter"]').click();
  await untilDraft(page.request, app.id, (x) => find(x.doc.pages[0]!.root, id)?.slot?.w === 3);
  await layout.locator("[data-layout-fit]").click();
  d = await untilDraft(page.request, app.id, (x) => (find(x.doc.pages[0]!.root, id)?.slot?.h ?? 0) > 6);
  const grown = find(d.doc.pages[0]!.root, id)!.slot!.h;
  expect(grown).toBeGreaterThan(6);
  expect(find(d.doc.pages[0]!.root, "c_easebelowa")!.slot!.y).toBeGreaterThanOrEqual(grown);
  await layout.locator('[data-more-settings-toggle="layout"]').click();
  for (const t of ["Left in columns", "Top in px", "Width in columns", "Height in px"]) await expect(layout.getByLabel(t)).toBeVisible();
  await layout.locator('[data-layout-field="x"]').fill("2.5");
  await layout.locator('[data-layout-field="x"]').press("Enter");
  d = await untilDraft(page.request, app.id, (x) => find(x.doc.pages[0]!.root, id)?.slot?.x === 2.5);
  expect(find(d.doc.pages[0]!.root, id)!.slot!.x).toBe(2.5);
  await expect(layout.locator('[data-layout-field="h"]')).toHaveValue(String(grown * 8));
  await page.screenshot({ path: shot("layout-more") });
});

test("grid columns: changing a grid from 12 to 24 columns keeps every child where it was", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `ease-cols-${RUN}`;
  const grid = "c_easegridaa";
  await newApp(page.request, slug, [{ id: grid, type: "grid", props: { minRows: 20 }, slot: { x: 0, y: 0, w: 12, h: 40 }, children: [
    { id: "c_easekidaaa", type: "text", props: { text: "One" }, slot: { x: 2, y: 0, w: 4, h: 8 } },
    { id: "c_easekidbbb", type: "text", props: { text: "Two" }, slot: { x: 6, y: 0, w: 6, h: 8 } },
  ] }]);
  const appId = ((await (await page.request.get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[]).find((t) => t.app.slug === slug)!.app.id;
  await open(page, slug);
  const box = async (k: string) => (await page.locator(`[data-canvas-root] [data-node="${k}"]`).boundingBox())!;
  const a0 = await box("c_easekidaaa");
  const b0 = await box("c_easekidbbb");
  await select(page, grid);
  const content = await openGroup(page, "content");
  if ((await content.locator('[data-more-settings="content"]').getAttribute("data-open")) === null) await content.locator('[data-more-settings-toggle="content"]').click();
  await content.locator('[data-field="columns"] select').selectOption("24");
  const d = await untilDraft(page.request, appId, (x) => find(x.doc.pages[0]!.root, grid)?.props.columns === 24);
  const g = find(d.doc.pages[0]!.root, grid)!;
  expect(g.props.columns).toBe(24);
  expect(find(g, "c_easekidaaa")!.slot).toEqual({ x: 4, y: 0, w: 8, h: 8 });
  expect(find(g, "c_easekidbbb")!.slot).toEqual({ x: 12, y: 0, w: 12, h: 8 });
  await page.waitForTimeout(500);
  const a1 = await box("c_easekidaaa");
  const b1 = await box("c_easekidbbb");
  for (const [p, q] of [[a0, a1], [b0, b1]] as const) {
    expect(Math.abs(p.x - q.x)).toBeLessThan(3);
    expect(Math.abs(p.width - q.width)).toBeLessThan(3);
  }
  // One undo puts it back.
  await page.keyboard.press("Control+z");
  await untilDraft(page.request, appId, (x) => find(x.doc.pages[0]!.root, grid)?.props.columns !== 24);
});

test("criteria 12 and 14: a bound stat shows a data chip and the Data sentence; Edit as template; the chip opens the picker; a typo'd source names the closest; a failing source shows when it was last read", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `ease-data-${RUN}`;
  const stat = "c_easestatbb";
  const text = "c_easetextbb";
  const dead = "c_easedeadbb";
  const sources = [
    { op: "source.set", source: { name: "lights", integrationId: haId, endpointId: "states", refreshSec: 10 } },
    { op: "source.set", source: { name: "broken", integrationId: deadId, endpointId: "areas", refreshSec: 60 } },
  ];
  await newApp(page.request, slug, [
    { id: stat, type: "stat", props: { label: "Lights", value: { $bind: "{{ lights.rows | count }}" } } },
    { id: text, type: "text", props: { text: "Hello" } },
    { id: dead, type: "text", props: { text: { $bind: "{{ broken.rows | count }}" } } },
  ], sources);
  await open(page, slug);
  await select(page, stat);
  const data = await openGroup(page, "data");
  // Criterion 12: the sentence names the source in words and its refresh; the field shows a chip with the value.
  await expect(data.locator("[data-data-sentence-text]")).toHaveText(`Shows the number of rows in lights, from Home Assistant ${RUN}, refreshed every 10 seconds.`, { timeout: 10_000 });
  const chip = data.locator('[data-data-chip="value"]');
  await expect(chip.locator("[data-chip-line]")).toHaveText(`Number of rows in lights · 48 · Home Assistant ${RUN}, every 10 s`, { timeout: 10_000 });
  await expect(data.locator('[data-binding-field="value"]')).toHaveCount(0);
  await page.screenshot({ path: shot("data-chip-light") });
  await data.locator('[data-edit-template="value"]').click();
  await expect(data.locator('[data-binding-field="value"] textarea')).toHaveValue("{{ lights.rows | count }}");
  await data.locator('[data-show-chip="value"]').click();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator("[data-data-picker]")).toBeVisible();
  await page.locator("[data-pick-cancel]").click();
  await expect(page.locator("[data-data-picker]")).toHaveCount(0);
  // Criterion 14: a typo'd source is named, with the closest real name.
  await select(page, text);
  const content = await openGroup(page, "content");
  await content.locator('[data-bind-button="text"]').click();
  await content.locator('[data-binding-field="text"] textarea').fill("{{ lightz.rows | count }}");
  await expect(content.locator("[data-binding-hold]")).toContainText("There is no data source called lightz. Did you mean lights?");
  await expect(content.locator('[data-binding-field="text"] [data-live-value]')).toHaveText("There is no data source called lightz. Did you mean lights?", { timeout: 3000 });
  await content.locator('[data-binding-field="text"] textarea').fill("{{ lights.rows | count }}");
  // The box stays a box while the person types (no chip mid-edit); the words come back with Show in words.
  await expect(content.locator('[data-binding-field="text"] textarea')).toBeVisible();
  await expect(content.locator('[data-show-chip="text"]')).toBeVisible();
  await expect(content.locator('[data-unbind="text"]')).toHaveText("Type it in");
  // Stale: a failing source shows its mark and when it was last read.
  await select(page, dead);
  const c2 = await openGroup(page, "content");
  await expect(c2.locator('[data-data-chip="text"]')).toHaveAttribute("data-chip-state", "failed", { timeout: 20_000 });
  await expect(c2.locator("[data-chip-stale]")).toContainText(/Failing: (Last read|Not read yet)/);
  await expect(c2.locator("[data-data-sentence-text]")).toContainText("Shows the number of rows in broken");
  await page.screenshot({ path: shot("data-chip-failing") });
});

test("media fields: an Image's Picture uploads with no path typed; the HTML block's pictures are a list with Upload, Your uploads and Remove", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `ease-media-${RUN}`;
  const img = "c_easeimgaaa";
  const html = "c_easehtmlaa";
  const app = await newApp(page.request, slug, [
    { id: img, type: "image", props: { fit: "cover", height: 120, alt: "" } },
    { id: html, type: "html", name: "Block", props: { html: "<p>x</p>", css: "", js: "", data: {}, controls: [], height: "auto", libs: [], images: [] } },
  ]);
  // A tiny real PNG (1x1).
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  await open(page, slug);
  await select(page, img);
  const content = await openGroup(page, "content");
  await expect(content.locator('[data-media-field="image"]')).toBeVisible();
  await content.locator('[data-media-field="image"] [data-media-input]').setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  const d = await untilDraft(page.request, app.id, (x) => String(find(x.doc.pages[0]!.root, img)?.props.src ?? "").startsWith("/uploads/"), 8000);
  expect(String(find(d.doc.pages[0]!.root, img)!.props.src)).toMatch(/^\/uploads\//);
  await expect(page.locator(`[data-canvas-root] [data-node="${img}"] img`)).toBeVisible({ timeout: 2000 });
  // The typed or live address still sits under "Paste an address".
  await content.locator("[data-media-paste] > summary").click();
  await expect(content.locator('[data-media-paste] [data-field="src"]')).toBeVisible();
  await select(page, html);
  const hc = await openGroup(page, "content");
  await hc.locator("[data-html-image-add] [data-media-input]").setInputFiles({ name: "plan.png", mimeType: "image/png", buffer: png });
  const d2 = await untilDraft(page.request, app.id, (x) => ((find(x.doc.pages[0]!.root, html)?.props.images as string[]) ?? []).length === 1, 8000);
  expect((find(d2.doc.pages[0]!.root, html)!.props.images as string[])[0]).toMatch(/^\/uploads\//);
  await expect(hc.locator("[data-html-image]")).toHaveCount(1);
  await hc.locator('[data-html-image-remove="0"]').click();
  await untilDraft(page.request, app.id, (x) => ((find(x.doc.pages[0]!.root, html)?.props.images as string[]) ?? []).length === 0);
  await expect(hc.locator("[data-html-image]")).toHaveCount(0);
  // Height offers Fill the page (A7.6).
  await hc.locator("[data-html-height-mode]").selectOption("fill");
  await untilDraft(page.request, app.id, (x) => find(x.doc.pages[0]!.root, html)?.props.height === "fill");
});

test("Skip for now: a picker opened at insert time offers Skip for now, which leaves the widget on sample values", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `ease-skip-${RUN}`;
  const app = await newApp(page.request, slug, []);
  await open(page, slug);
  await page.locator('[data-left-tab="insert"]').click();
  await page.locator('[data-insert-item="stat"]').first().click();
  const picker = page.locator("[data-data-picker]");
  test.skip(!(await picker.isVisible({ timeout: 4000 }).catch(() => false)), "the insert-time picker is builder C's part; not wired in this tree yet");
  await expect(page.locator("[data-pick-skip]")).toHaveText("Skip for now");
  await page.locator("[data-pick-skip]").click();
  await expect(picker).toHaveCount(0);
  const d = await draft(page.request, app.id);
  const stat = (d.doc.pages[0]!.root.children ?? []).find((n) => n.type === "stat")!;
  expect(stat).toBeTruthy();
  expect(Object.values(stat.props).some((v) => v && typeof v === "object" && "$bind" in (v as object))).toBe(false);
  expect(d.doc.dataSources).toHaveLength(0);
});

const THEMES = [
  { id: "control-room", scheme: "dark" as const },
  { id: "dusk", scheme: "dark" as const },
  { id: "solid", scheme: "light" as const },
];
test("V4 and V5: the inspector's simple and More states and a data chip in Control Room, Dusk and Solid, and at 390x844", async ({ page, context, browser }) => {
  const slug = `ease-shots-${RUN}`;
  const stat = "c_easeshotaa";
  const app = await newApp(page.request, slug, [{ id: stat, type: "stat", props: { label: "Lights", value: { $bind: "{{ lights.rows | count }}" }, unit: "on" } }], [{ op: "source.set", source: { name: "lights", integrationId: haId, endpointId: "states", refreshSec: 10 } }]);
  for (const t of THEMES) {
    await ops(page.request, app.id, [{ op: "theme.set", theme: { themeId: t.id } }]);
    await context.addCookies([{ name: "atrium_theme", value: t.scheme, url: ORIGIN }, { name: "atrium_swept", value: "1", url: ORIGIN }]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, slug);
    await select(page, stat);
    await setFolds(page, false);
    await expect(page.locator('[data-data-chip="value"] [data-chip-line]')).toContainText("48", { timeout: 10_000 });
    await page.screenshot({ path: shot(`inspector-simple-${t.id}`) });
    await setFolds(page, true);
    await page.screenshot({ path: shot(`inspector-more-${t.id}`) });
    await inspector(page).screenshot({ path: shot(`inspector-panel-${t.id}`) });
  }
  // V5: 390x844 on a touch phone, every new control at least 44px tall and nothing scrolls sideways.
  const phone = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, storageState: await context.storageState() });
  const p2 = await phone.newPage();
  await p2.goto(`/build/${slug}`);
  await p2.locator(`[data-canvas-root] [data-node="${stat}"]`).tap();
  await p2.locator('[data-narrow-tab="edit"]').tap();
  await expect(p2.locator('[data-data-chip="value"]')).toBeVisible({ timeout: 10_000 });
  for (const t of await p2.locator("[data-more-settings-toggle]").all()) if (await t.isVisible()) await t.tap();
  await p2.screenshot({ path: shot("mobile-390-inspector"), fullPage: true });
  const sizes = await p2.locator("[data-data-chip], [data-more-settings-toggle], [data-edit-template]").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => ({ what: e.getAttribute("data-more-settings-toggle") ?? e.getAttribute("data-data-chip") ?? "edit-template", h: Math.round(e.getBoundingClientRect().height) })));
  const scroll = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  writeEvidence("ease/mobile-390.json", { sidewaysScroll: scroll, sizes });
  expect(scroll).toBeLessThanOrEqual(0);
  for (const z of sizes) expect(z.h, z.what).toBeGreaterThanOrEqual(44);
  await phone.close();
});
