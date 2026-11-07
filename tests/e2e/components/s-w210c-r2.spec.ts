// Wave 2.10c round 2, builder C (gauntlet w210c-r1 Fix List items 1 (C half), 2, 3, 10, 11, 12, 13, 18 and
// the C lows of 20). Every operator action drives the real screen the way the critics did (round 2 brief):
// Insert clicks and drags, the inspector's fields and menus, clicks, the wheel, touch swipes, Esc, the icon
// picker. The API only sets up a stand-in data source and publishes (as the Publish button would), and is
// read to check what the draft holds. Each test was recorded failing on the build from before the change
// (evidence/components/w210c-r2/failing-first/).
// Integration reads use the stand-in Prometheus (tests/e2e/fixtures/fake-prometheus.ts); test-only values.
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn } from "./helpers";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";

test.describe.configure({ timeout: Number(process.env.ATRIUM_E2E_TEST_TIMEOUT ?? 300_000) });
test.use({ actionTimeout: 15_000, trace: "off" });
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
const EV = path.resolve(here, `../../../evidence/components/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "w210c-r2"}/pass`);
const file = (name: string) => {
  const p = path.join(EV, name);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
};
const shot = (name: string) => file(`${name}.png`);
const writeEv = (name: string, data: unknown) => writeFileSync(file(name), JSON.stringify(data, null, 2));

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: Slot; children?: Node[]; name?: string; title?: string };
type Draft = { rev: number; doc: { pages: { id: string; slug: string; root: Node }[] } };

async function draft(req: APIRequestContext, id: string): Promise<Draft> {
  return (await req.get(`/api/apps/${id}/draft`)).json();
}
async function ops(req: APIRequestContext, id: string, list: unknown[]) {
  const d = await draft(req, id);
  const r = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), `ops refused: ${await r.text()}`).toBe(true);
}
async function newApp(req: APIRequestContext, slug: string, kids: Node[] = [], sources: unknown[] = []): Promise<{ id: string; rootId: string }> {
  const r = await req.post("/api/apps", { data: { name: `Round 2 ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await draft(req, id);
  const rootId = d.doc.pages[0]!.root.id;
  if (kids.length || sources.length) await ops(req, id, [...sources, ...kids.map((n) => ({ op: "node.add", parentId: rootId, node: n }))]);
  return { id, rootId };
}
async function publish(req: APIRequestContext, appId: string) {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note: "w210c-r2" }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)];
const nodes = (d: Draft) => all(d.doc.pages[0]!.root);
const find = (d: Draft, id: string) => nodes(d).find((n) => n.id === id);
async function untilDraft(req: APIRequestContext, id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(req, id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
async function select(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${id}"]`).click();
  await expect(page.locator(`[data-inspector][data-node-id="${id}"]`)).toBeVisible();
}
async function view(page: Page, slug: string) {
  await page.goto(`/a/${slug}`);
  await expect(page.locator(".atr-render-root").first()).toBeVisible({ timeout: 15_000 });
}
/** An Insert click; returns the new node's id (from the draft). Closes a data picker that opens for it. */
async function insertClick(page: Page, appId: string, type: string): Promise<string> {
  await page.locator('[data-left-tab="insert"]').click();
  const before = new Set(nodes(await draft(page.request, appId)).map((n) => n.id));
  await page.locator(`[data-insert-item="${type}"]`).first().click();
  const d = await untilDraft(page.request, appId, (x) => nodes(x).some((n) => !before.has(n.id) && n.type === type));
  await page.keyboard.press("Escape");
  return nodes(d).find((n) => !before.has(n.id) && n.type === type)!.id;
}
const centre = async (l: Locator) => {
  await l.scrollIntoViewIfNeeded();
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** A slow pointer drag, the way a person moves a mouse; `during` runs with the button still down. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<unknown>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 18; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 18, from.y + ((to.y - from.y) * i) / 18);
  await page.waitForTimeout(250);
  const seen = during ? await during() : undefined;
  await page.mouse.up();
  return seen;
}
async function phone(browser: Browser, page: Page, opts: { reducedMotion?: "reduce" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}) });
  await ctx.addCookies(await page.context().cookies());
  return { ctx, p: await ctx.newPage() };
}

let prom: FakePrometheus | undefined;
let promId = "";
test.beforeAll(async () => {
  prom = await startFakePrometheus();
});
test.afterAll(async () => {
  await prom?.close();
});
test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project; phone contexts are made per test");
  await signIn(context, page.request);
  await context.addCookies([{ name: "atrium_swept", value: "1", url: ORIGIN }]);
});
async function promIntegration(req: APIRequestContext): Promise<string> {
  if (promId) return promId;
  const r = await req.post("/api/integrations", { data: { packageId: "prometheus", name: `Prometheus r2 ${RUN}`, config: { baseUrl: prom!.url, authMode: "none" }, secrets: {}, untested: true }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  promId = (await r.json()).id as string;
  return promId;
}
const machinesSource = async (req: APIRequestContext) => ({ op: "source.set", source: { name: "machines", integrationId: await promIntegration(req), endpointId: "machines-overview", refreshSec: 60 } });
const cpuStat = (id: string): Node => ({ id, type: "stat", props: { value: { $bind: "{{ $item.cpu }}" }, label: { $bind: "{{ $item.name }}" }, unit: "%" } });
const tall = (id: string, y: number): Node => ({ id, type: "text", props: { text: Array.from({ length: 50 }, (_, i) => `Line ${i + 1} below.`).join("\n") }, slot: { x: 0, y, w: 12, h: 140 } });

// ---------- item 1 (C half): the roulette is a drop zone that takes widgets ----------
test("item 1: an inserted roulette is a drop zone the builder can find; a Stat dragged from Insert onto Drop widgets here becomes its slot, highlighted on the way; in repeat mode a second widget is refused in words", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `w210c-r2-drop-${RUN}`;
  const app = await newApp(page.request, slug);
  await openBuilder(page, slug);
  const rid = await insertClick(page, app.id, "roulette");
  const zone = page.locator(`[data-canvas-root] [data-node="${rid}"] [data-drop-zone="roulette"]`).first();
  await expect(zone).toHaveAttribute("data-drop-accepts", "true");
  const target = page.locator(`[data-canvas-root] [data-node="${rid}"] [data-roulette-drop]`).first();
  await expect(target).toContainText("Drop widgets here");
  // Drag a Stat from Insert onto the drop target, slowly, and look while the button is down.
  await page.locator('[data-left-tab="insert"]').click();
  const from = await centre(page.locator('[data-insert-item="stat"]').first());
  const over = (await drag(page, from, await centre(target), async () => ({
    highlighted: await page.locator(`[data-canvas-root] [data-node="${rid}"][data-drop-over], [data-drop-into="${rid}"]`).count(),
    words: await target.textContent().catch(() => ""),
  }))) as { highlighted: number; words: string };
  await page.keyboard.press("Escape");
  const d1 = await untilDraft(page.request, app.id, (x) => (find(x, rid)?.children ?? []).length > 0);
  const kids1 = (find(d1, rid)?.children ?? []).map((c) => c.type);
  await page.screenshot({ path: shot("i1-after-drop") });
  // Repeat mode with its one template: a second drag is refused, nothing changes, a sentence says why.
  await select(page, rid);
  await page.locator(`[data-inspector][data-node-id="${rid}"] [data-field="mode"] select`).selectOption("repeat");
  await untilDraft(page.request, app.id, (x) => find(x, rid)?.props.mode === "repeat");
  await page.locator('[data-left-tab="insert"]').click();
  const zone2 = page.locator(`[data-canvas-root] [data-node="${rid}"] [data-drop-zone="roulette"]`).first();
  await expect(zone2).toHaveAttribute("data-drop-accepts", "false");
  await drag(page, await centre(page.locator('[data-insert-item="gauge"]').first()), await centre(page.locator(`[data-canvas-root] [data-node="${rid}"]`).first()));
  await page.waitForTimeout(800);
  const d2 = await draft(page.request, app.id);
  const sentence = await page.getByText(/already has (one|it)/).first().isVisible().catch(() => false);
  writeEv("i1-drop.json", { over, kids1, kids2: (find(d2, rid)?.children ?? []).map((c) => c.type), refusal: await zone2.getAttribute("data-drop-refusal"), sentence });
  expect(over.highlighted, "the roulette is highlighted while the widget is over it").toBeGreaterThan(0);
  expect(kids1, "the Stat is the roulette's slot").toEqual(["stat"]);
  expect((find(d2, rid)?.children ?? []).length, "a second template is refused").toBe(1);
  expect(sentence, "the refusal is said in words").toBe(true);
});

// ---------- item 2: the repeat-mode rows field ----------
test("item 2: in repeat mode, Rows from binds the machines' rows and adds a ready widget; a typed template is kept; a wrong one says why; the viewer turns through every machine", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `w210c-r2-rows-${RUN}`;
  const app = await newApp(page.request, slug, [], [await machinesSource(page.request)]);
  await openBuilder(page, slug);
  const rid = await insertClick(page, app.id, "roulette");
  await select(page, rid);
  const insp = page.locator(`[data-inspector][data-node-id="${rid}"]`);
  await insp.locator('[data-field="mode"] select').selectOption("repeat");
  await untilDraft(page.request, app.id, (x) => find(x, rid)?.props.mode === "repeat");
  // A data field, not a bare box: Pick data and Write a template, or the list of this app's data.
  const field = insp.locator('[data-field="items"]').first();
  await expect(field).toBeVisible();
  const offers = { pick: await field.locator('[data-pick-button="items"]').count(), template: await field.locator('[data-edit-template="items"]').count() };
  // The list names how many rows each read has once its data is in, as a person would see before choosing.
  await expect(insp.locator('[data-roulette-rows-from] option[value="machines"]')).toContainText("rows", { timeout: 20_000 });
  await insp.locator("[data-roulette-rows-from]").selectOption("machines");
  const d1 = await untilDraft(page.request, app.id, (x) => (find(x, rid)?.children ?? []).length === 1 && JSON.stringify(find(x, rid)?.props.items ?? "").includes("machines.rows"));
  const r1 = find(d1, rid)!;
  // Typing a template by hand keeps it; plain words get a sentence.
  const slug2 = `w210c-r2-rows2-${RUN}`;
  const app2 = await newApp(page.request, slug2, [], [await machinesSource(page.request)]);
  await openBuilder(page, slug2);
  const rid2 = await insertClick(page, app2.id, "roulette");
  await select(page, rid2);
  const insp2 = page.locator(`[data-inspector][data-node-id="${rid2}"]`);
  await insp2.locator('[data-field="mode"] select').selectOption("repeat");
  await untilDraft(page.request, app2.id, (x) => find(x, rid2)?.props.mode === "repeat");
  await insp2.locator('[data-edit-template="items"]').click();
  const box = insp2.locator('[data-field="items"] textarea, [data-field="items"] input').first();
  await box.click();
  await page.keyboard.type("CPU in use, every machine");
  await page.keyboard.press("Tab");
  const wrong = await insp2.locator("[data-roulette-items-wrong]").textContent({ timeout: 5000 }).catch(() => null);
  const dWrong = await untilDraft(page.request, app2.id, (x) => JSON.stringify(find(x, rid2)?.props.items ?? "").includes("CPU in use"));
  await box.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("{{ machines.rows }}");
  await page.keyboard.press("Tab");
  const dTyped = await untilDraft(page.request, app2.id, (x) => JSON.stringify(find(x, rid2)?.props.items ?? "").includes("machines.rows"));
  await page.waitForTimeout(600);
  const wrongAfter = await insp2.locator("[data-roulette-items-wrong]").count();
  await page.screenshot({ path: shot("i2-typed") });
  // The first app, published, turns through every machine.
  await publish(page.request, app.id);
  await view(page, slug);
  const r = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(r).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  const first = await page.locator(`[data-node="${rid}"] [data-slot-index="0"]`).first().textContent();
  await page.screenshot({ path: shot("i2-viewer") });
  writeEv("i2-rows.json", { offers, items: r1.props.items, template: r1.children?.[0], wrong, wrongStored: find(dWrong, rid2)?.props.items, typed: find(dTyped, rid2)?.props.items, wrongAfter, first });
  expect(offers.pick + offers.template, "Pick data or Write a template").toBeGreaterThan(0);
  expect(r1.props.items).toEqual({ $bind: "{{ machines.rows }}" });
  expect(r1.children?.[0]?.type).toBe("stat");
  expect(find(dWrong, rid2)?.props.items, "what was typed is kept").toEqual({ $bind: "CPU in use, every machine" });
  expect(wrong ?? "", "a wrong template says why").toMatch(/double braces/);
  expect(find(dTyped, rid2)?.props.items).toEqual({ $bind: "{{ machines.rows }}" });
  expect(wrongAfter).toBe(0);
  expect(first ?? "").toMatch(/ACE|%/);
});

// ---------- items 3 and 10: one cylinder, Note 2's numbers ----------
async function cylinderApp(req: APIRequestContext, slug: string, theme?: string) {
  const rid = "c_r2cylroula";
  const roul: Node = { id: rid, type: "roulette", name: "CPU per machine", props: { mode: "repeat", items: { $bind: "{{ machines.rows }}" }, advance: { scroll: true, arrows: true, dots: true } }, slot: { x: 0, y: 0, w: 4, h: 30 }, children: [cpuStat("c_r2cylstata")] };
  const app = await newApp(req, slug, [roul, tall("c_r2cyltalla", 32)], [await machinesSource(req)]);
  if (theme) await ops(req, app.id, [{ op: "theme.set", theme: { themeId: theme } }]);
  await publish(req, app.id);
  return rid;
}
/** Every face's place against the stage, and its content's opacity and scale. */
const facesNow = (page: Page, rid: string) =>
  page.evaluate((id) => {
    const root = document.querySelector(`[data-node="${id}"] .atr-roulette`)!;
    const stage = root.querySelector(".atr-roulette-stage")!.getBoundingClientRect();
    const midY = stage.top + stage.height / 2;
    return {
      current: root.getAttribute("data-current"),
      faces: Array.from(root.querySelectorAll<HTMLElement>("[data-face]")).map((f) => {
        const r = f.getBoundingClientRect();
        const inner = f.querySelector<HTMLElement>("[data-face-in]") ?? f;
        const cs = getComputedStyle(inner);
        const m = cs.transform.match(/matrix\(([^,]+),/);
        const visible = Math.max(0, Math.min(r.bottom, stage.bottom) - Math.max(r.top, stage.top));
        return { slot: f.getAttribute("data-slot-index"), transform: getComputedStyle(f).transform, opacity: Number(cs.opacity) * Number(getComputedStyle(f).opacity), scale: m ? Number(m[1]) : 1, visiblePx: Math.round(visible), coversMiddle: r.top <= midY && r.bottom >= midY, text: (f.textContent ?? "").replace(/\s+/g, " ").trim() };
      }),
    };
  }, rid);

test("items 3 and 10: a repeat-mode roulette is a real cylinder: at rest only the front face is in the stage, neighbours at 60% and 0.92 scale, 36 degrees apart; mid-turn the face over the middle is never see-through; Solid crossfades", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210c-r2-cyl-${RUN}`;
  const rid = await cylinderApp(page.request, slug);
  await view(page, slug);
  const r = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(r).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  await page.waitForTimeout(900);
  const rest = await facesNow(page, rid);
  await r.screenshot({ path: shot("i3-rest") });
  // Turn with Next and watch every frame for 700 ms.
  await page.locator(`[data-node="${rid}"] [data-roulette-next]`).click();
  const frames = await page.evaluate(async (id) => {
    const out: { t: number; middle: number[] }[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 700) {
      await new Promise((res) => requestAnimationFrame(() => res(null)));
      const root = document.querySelector(`[data-node="${id}"] .atr-roulette`)!;
      const stage = root.querySelector(".atr-roulette-stage")!.getBoundingClientRect();
      const midY = stage.top + stage.height / 2;
      const middle = Array.from(root.querySelectorAll<HTMLElement>("[data-face]")).filter((f) => { const b = f.getBoundingClientRect(); return b.top <= midY && b.bottom >= midY; }).map((f) => Number(getComputedStyle(f.querySelector("[data-face-in]") ?? f).opacity));
      out.push({ t: Math.round(performance.now() - t0), middle });
    }
    return out;
  }, rid);
  await page.waitForTimeout(500);
  const after = await facesNow(page, rid);
  // Solid: no motion in the theme, so the crossfade, with no see-through neighbours.
  const slugS = `w210c-r2-cyls-${RUN}`;
  const ridS = await cylinderApp(page.request, slugS, "solid");
  await view(page, slugS);
  const rs = page.locator(`[data-node="${ridS}"] .atr-roulette`).first();
  await expect(rs).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  await page.waitForTimeout(600);
  const solid = { motion: await rs.getAttribute("data-motion"), faces: (await facesNow(page, ridS)).faces };
  await rs.screenshot({ path: shot("i10-solid") });
  writeEv("i3-i10-cylinder.json", { rest, after, frames, solid });
  const front = rest.faces.find((f) => f.slot === rest.current)!;
  const others = rest.faces.filter((f) => f.slot !== rest.current);
  expect(front.opacity).toBe(1);
  expect(front.visiblePx).toBeGreaterThan(50);
  for (const f of others) {
    expect(f.transform, "every face sits on the drum's radius").not.toBe("none");
    expect(f.visiblePx, `neighbour ${f.slot} stays out of the stage at rest`).toBeLessThanOrEqual(2);
    expect(f.opacity).toBeCloseTo(0.6, 1);
    expect(f.scale).toBeCloseTo(0.92, 2);
  }
  expect(after.current).toBe("1");
  const seeThrough = frames.filter((f) => f.middle.some((o) => o < 0.95));
  expect(seeThrough, "no frame shows a see-through face over the middle").toEqual([]);
  expect(solid.motion).toBe("fade");
  expect(solid.faces.filter((f) => f.slot !== "0").every((f) => f.opacity === 0)).toBe(true);
});

// ---------- item 11: swipe on touch ----------
async function swipe(p: Page, x: number, y0: number, y1: number) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 8 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
test("item 11: on a phone, a swipe over an untapped roulette scrolls the page; after a tap, a swipe along it turns it one slot and the page stays", async ({ page, browser }) => {
  const slug = `w210c-r2-swipe-${RUN}`;
  const rid = await cylinderApp(page.request, slug);
  const { ctx, p } = await phone(browser, page);
  await p.goto(`${ORIGIN}/a/${slug}`);
  const r = p.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(r).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  const scrollY = () => p.evaluate(() => (document.scrollingElement?.scrollTop ?? 0) + Math.max(0, ...[...document.querySelectorAll("main, [data-app-scroll]")].map((e) => e.scrollTop)));
  const b = (await r.boundingBox())!;
  const y0 = await scrollY();
  await swipe(p, b.x + b.width / 2, b.y + b.height * 0.7, b.y + b.height * 0.2);
  await p.waitForTimeout(600);
  const before = { current: await r.getAttribute("data-current"), pageMoved: (await scrollY()) - y0 };
  await p.evaluate(() => { window.scrollTo(0, 0); for (const e of document.querySelectorAll("main, [data-app-scroll]")) e.scrollTop = 0; });
  await p.waitForTimeout(300);
  const b2 = (await r.boundingBox())!;
  await p.touchscreen.tap(b2.x + b2.width / 2, b2.y + 30);
  await expect(r).toHaveAttribute("data-engaged", "");
  const y1 = await scrollY();
  await swipe(p, b2.x + b2.width / 2, b2.y + b2.height * 0.7, b2.y + b2.height * 0.2);
  await p.waitForTimeout(700);
  const up = { current: await r.getAttribute("data-current"), pageMoved: (await scrollY()) - y1 };
  await swipe(p, b2.x + b2.width / 2, b2.y + b2.height * 0.2, b2.y + b2.height * 0.7);
  await p.waitForTimeout(700);
  const down = { current: await r.getAttribute("data-current") };
  await p.screenshot({ path: shot("i11-phone") });
  await ctx.close();
  writeEv("i11-swipe.json", { before, up, down });
  expect(before.current, "no turn before a tap").toBe("0");
  expect(up.current, "a swipe up turns to the next slot").toBe("1");
  expect(Math.abs(up.pageMoved), "the page stays while it is engaged").toBeLessThanOrEqual(2);
  expect(down.current, "a swipe down turns back").toBe("0");
});

// ---------- item 12: the cut badge ----------
const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
test("item 12: Content is cut sits clear of the widget's own controls and of the resize handles, stays whole and its Fit is the thing under the pointer, in a small box too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const slug = `w210c-r2-badge-${RUN}`;
  const rid = "c_r2badgerou";
  const roul: Node = { id: rid, type: "roulette", props: { mode: "slots", advance: { scroll: true, arrows: true, dots: true } }, slot: { x: 0, y: 0, w: 4, h: 14 }, children: ["One", "Two", "Three"].map((t, i) => ({ id: `c_r2badgesl${"abc"[i]}`, type: "text", props: { text: Array.from({ length: 6 }, (_, k) => `Slot ${t} line ${k + 1}`).join("\n") } })) };
  const small: Node = { id: "c_r2badgetxt", type: "text", props: { text: "This is a long paragraph that cannot fit in a tiny box. ".repeat(6) }, slot: { x: 6, y: 0, w: 2, h: 4 } };
  await newApp(page.request, slug, [roul, small, tall("c_r2badgetal", 30)]);
  await openBuilder(page, slug);
  const res: Record<string, unknown> = {};
  for (const id of [rid, small.id]) {
    await select(page, id);
    await page.waitForTimeout(500);
    const badge = page.locator(`[data-canvas-root] [data-cut-badge="${id}"], [data-canvas-root] [data-node="${id}"] > .atr-cut-badge`).first();
    await expect(badge).toBeVisible({ timeout: 8000 });
    const bb = (await badge.boundingBox())!;
    const handles = await page.locator("[data-resize-handle]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 }; }));
    const controls = await page.locator(`[data-canvas-root] [data-node="${id}"] :is(.atr-roulette-arrow, .atr-roulette-dot, .atr-roulette-count)`).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    // Whole: every word and the Fit button lie inside the badge's own box, which is not clipped by the node.
    const whole = await badge.evaluate((e, nid) => { const b = e.getBoundingClientRect(); const inNode = !!e.closest(`[data-node="${nid}"]`); return !inNode && Array.from(e.children).every((k) => { const a = k.getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1; }); }, id);
    const ghosts = id === rid ? await page.locator(`[data-canvas-root] [data-node="${id}"] [data-face]`).evaluateAll((els) => { const st = els[0]!.closest(".atr-roulette-stage")!.getBoundingClientRect(); return els.filter((f) => f.getAttribute("aria-hidden") === "true").map((f) => { const inner = f.querySelector("[data-node]")!.getBoundingClientRect(); const fr = f.getBoundingClientRect(); const vis = Math.max(0, Math.min(fr.bottom, inner.bottom, st.bottom) - Math.max(fr.top, inner.top, st.top)); return Math.round(vis); }); }) : [];
    const fit = badge.locator("[data-cut-fit]");
    const fc = await centre(fit);
    const onTop = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[data-cut-fit]"), fc);
    res[id] = { ghosts, bb, onHandle: handles.some((h) => overlap(bb, h)), onControl: controls.some((c) => overlap(bb, c)), whole, onTop, text: await badge.textContent() };
    await page.screenshot({ path: shot(`i12-${id === rid ? "roulette" : "small"}`) });
  }
  writeEv("i12-badge.json", res);
  expect(((res[rid] as { ghosts: number[] }).ghosts).every((px) => px <= 2), "no neighbour's text shows through the front slot").toBe(true);
  for (const v of Object.values(res) as { onHandle: boolean; onControl: boolean; whole: boolean; onTop: boolean }[]) {
    expect(v.onControl, "not over the widget's own controls").toBe(false);
    expect(v.onHandle, "not under a resize handle").toBe(false);
    expect(v.whole, "whole").toBe(true);
    expect(v.onTop, "Fit can be clicked").toBe(true);
  }
});

// ---------- item 13: scroll kinds ----------
test("item 13: a Repeat whose rows arrive later shows the drawn thumb and a full ring; a table keeps its header and fades where rows continue; at rest a cue says how to scroll; the end of an engaged table keeps the wheel off the page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210c-r2-scroll-${RUN}`;
  const rep: Node = { id: "c_r2screpxaa", type: "repeat", title: "Repeat", props: { items: { $bind: "{{ machines.rows }}" }, columns: 1 }, slot: { x: 0, y: 0, w: 3, h: 26 }, children: [cpuStat("c_r2screpsta")] };
  const table: Node = { id: "c_r2sctablea", type: "table", name: "Machines", props: { data: { $bind: "{{ machines }}" } }, slot: { x: 4, y: 0, w: 5, h: 22 } };
  await newApp(page.request, slug, [rep, table, tall("c_r2sctallaa", 30)], [await machinesSource(page.request)]).then((a) => publish(page.request, a.id));
  await view(page, slug);
  const repNode = page.locator(`[data-node="${rep.id}"]`).first();
  await expect(repNode.locator('[data-slot="item"]').first()).toBeVisible({ timeout: 20_000 });
  const tNode = page.locator(`[data-node="${table.id}"]`).first();
  await expect(tNode.locator("tbody tr").first()).toBeVisible({ timeout: 20_000 });
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(1000);
  const restCue = { rep: await repNode.locator("[data-scroll-cue]").isVisible(), table: await tNode.locator("[data-scroll-cue]").isVisible(), fade: await tNode.locator("[data-scroll-port]").evaluate((e) => getComputedStyle(e).maskImage || (getComputedStyle(e) as unknown as { webkitMaskImage: string }).webkitMaskImage) };
  // The Repeat: hover shows the thumb; a click engages it with a ring on all four sides.
  const rb = (await repNode.boundingBox())!;
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.waitForTimeout(400);
  const thumb = await repNode.locator(":scope > [data-scroll-thumb]").evaluate((e) => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, opacity: Number(getComputedStyle(e).opacity) }));
  await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.waitForTimeout(300);
  const ring = await repNode.evaluate((e) => { const cs = getComputedStyle(e, "::after"); return { content: cs.content, top: cs.borderTopWidth, bottom: cs.borderBottomWidth, left: cs.borderLeftWidth, right: cs.borderRightWidth, z: cs.zIndex }; });
  await repNode.screenshot({ path: shot("i13-repeat-engaged") });
  await page.keyboard.press("Escape");
  // The table: engage, scroll, the header stays; at the end, more wheel does not move the page.
  const tb = (await tNode.boundingBox())!;
  await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
  const headTop0 = (await tNode.locator("thead th").first().boundingBox())!.y;
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(400);
  const headTop1 = (await tNode.locator("thead th").first().boundingBox())!.y;
  const pageY = () => page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(60); }
  await page.waitForTimeout(400);
  const yEnd = await pageY();
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(60); }
  await page.waitForTimeout(500);
  const pageMoved = (await pageY()) - yEnd;
  await tNode.screenshot({ path: shot("i13-table-scrolled") });
  // After Esc: no 2px ring across the rows (item 20 low).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const afterEsc = await tNode.evaluate((e) => Array.from(e.querySelectorAll<HTMLElement>("*")).filter((x) => { const cs = getComputedStyle(x); return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2; }).length);
  const thumbFade = await repNode.locator(":scope > [data-scroll-thumb]").evaluate((e) => getComputedStyle(e).transitionDuration);
  writeEv("i13-scroll.json", { restCue, thumb, ring, headTop0, headTop1, pageMoved, afterEsc, thumbFade });
  expect(restCue.rep && restCue.table, "a cue at rest").toBe(true);
  expect(restCue.fade, "the cut edge fades").toContain("gradient");
  expect(thumb.h).toBeGreaterThan(10);
  expect(thumb.opacity).toBe(1);
  expect([ring.top, ring.bottom, ring.left, ring.right]).toEqual(["1px", "1px", "1px", "1px"]);
  expect(Math.abs(headTop1 - headTop0), "the header stays").toBeLessThanOrEqual(1);
  expect(pageMoved, "the page stays while the table is engaged").toBe(0);
  expect(afterEsc).toBe(0);
  expect(thumbFade).toBe("0.12s");
});

// ---------- item 18: the icon picker on a phone ----------
test("item 18: on a phone, after Get icon the picker keeps its title in view and shows the whole failure sentence", async ({ page, browser }) => {
  const slug = `w210c-r2-pick-${RUN}`;
  const icon: Node = { id: "c_r2pickicon", type: "icon", props: { name: "server", scale: 50 }, slot: { x: 0, y: 0, w: 1.375, h: 10 } };
  await newApp(page.request, slug, [icon]);
  const { ctx, p } = await phone(browser, page);
  await p.goto(`${ORIGIN}/build/${slug}`);
  await expect(p.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  await p.locator(`[data-canvas-root] [data-node="${icon.id}"]`).first().tap();
  await p.locator('[data-narrow-tab="edit"]').tap();
  await p.locator('[data-inspector] [data-icon-pick="name"]').tap();
  const sheet = p.locator('[data-sheet="icon-picker"]');
  await expect(sheet).toBeVisible();
  await p.waitForTimeout(500);
  const h0 = (await sheet.boundingBox())!.height;
  await p.locator("[data-icon-picker] [data-icon-from-website]").tap();
  await p.locator("[data-icon-picker] [data-website-url]").tap();
  await p.locator("[data-icon-picker] [data-website-url]").fill("http://127.0.0.1:9");
  await p.locator("[data-icon-picker] [data-website-fetch]").tap();
  const err = p.locator("[data-icon-picker] [data-favicon-error]");
  await expect(err).toBeVisible({ timeout: 12_000 });
  await p.waitForTimeout(400);
  const sb = (await sheet.boundingBox())!;
  const title = (await sheet.getByRole("heading", { name: "Choose an icon" }).boundingBox())!;
  const eb = (await err.boundingBox())!;
  const errOnTop = await p.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[data-favicon-error]"), { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 });
  await p.screenshot({ path: shot("i18-phone-picker") });
  await ctx.close();
  writeEv("i18-picker.json", { h0, sheet: sb, title, err: eb, errOnTop });
  expect(sb.height, "the sheet keeps its height").toBeGreaterThanOrEqual(h0 - 1);
  expect(title.y, "the title stays inside the sheet").toBeGreaterThanOrEqual(sb.y - 0.5);
  expect(eb.y + eb.height, "the whole sentence shows").toBeLessThanOrEqual(sb.y + sb.height + 0.5);
  expect(errOnTop).toBe(true);
});

// ---------- item 20: the C lows ----------
test("item 20 (C lows): nine dots in a 4-column roulette stay on one line or become a count; five quick wheel notches turn five slots; a reduced-motion dot jump crossfades; the arrows can be styled with states; the scroll menu has one default; the icon picker's three sources are rows and a website icon is named after its site; a phone table fades where it continues", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const slug = `w210c-r2-lows-${RUN}`;
  const rid = await cylinderApp(page.request, slug);
  await view(page, slug);
  const r = page.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(r).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  const dots = await page.locator(`[data-node="${rid}"] [data-roulette-dot]`).evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
  const count = await page.locator(`[data-node="${rid}"] [data-roulette-count]`).count();
  // Five quick notches after a click.
  const b = (await r.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + 30);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(40); }
  await page.waitForTimeout(900);
  const afterWheel = await r.getAttribute("data-current");
  // Reduced motion: a far dot jump fades in.
  const rm = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await rm.addCookies(await page.context().cookies());
  const q = await rm.newPage();
  await q.goto(`${ORIGIN}/a/${slug}`);
  const qr = q.locator(`[data-node="${rid}"] .atr-roulette`).first();
  await expect(qr).toHaveAttribute("data-count", "9", { timeout: 20_000 });
  const jump = q.locator(`[data-node="${rid}"] [data-roulette-dot="6"]`);
  const hasDot = await jump.count();
  if (hasDot) await jump.click();
  else { await qr.focus(); await q.keyboard.press("End"); }
  const target = hasDot ? "6" : "8";
  await q.waitForTimeout(90);
  const midFade = await q.locator(`[data-node="${rid}"] [data-slot-index="${target}"]`).first().evaluate((e) => Number(getComputedStyle(e).opacity));
  await q.waitForTimeout(400);
  const endFade = await q.locator(`[data-node="${rid}"] [data-slot-index="${target}"]`).first().evaluate((e) => Number(getComputedStyle(e).opacity));
  await rm.close();
  // The builder: Part offers the arrows, When offers states; the scroll menu has one default.
  const slugB = `w210c-r2-lowsb-${RUN}`;
  const table: Node = { id: "c_r2lowtable", type: "table", props: { data: { $bind: "{{ machines }}" } }, slot: { x: 4, y: 0, w: 5, h: 22 } };
  const roulB: Node = { id: "c_r2lowroula", type: "roulette", props: { mode: "slots" }, slot: { x: 0, y: 0, w: 4, h: 28 }, children: [{ id: "c_r2lowslota", type: "heading", props: { text: "One" } }, { id: "c_r2lowslotb", type: "heading", props: { text: "Two" } }] };
  const icon: Node = { id: "c_r2lowiconx", type: "icon", props: { name: "server", scale: 50 }, slot: { x: 10, y: 0, w: 1.375, h: 10 } };
  const appB = await newApp(page.request, slugB, [table, roulB, icon], [await machinesSource(page.request)]);
  await openBuilder(page, slugB);
  await select(page, roulB.id);
  // Open Style, then More style, as a person would to reach Part and When.
  await page.locator('[data-inspector-group="style"] > h3 button').click();
  await page.getByRole("switch", { name: /Customise the look/ }).click();
  await page.locator("[data-style-more-toggle]").first().click();
  await page.waitForTimeout(300);
  const partOptions = await page.locator(`[data-inspector="${roulB.id}"] select, [data-inspector][data-node-id="${roulB.id}"] select`).evaluateAll((els) => els.flatMap((s) => Array.from((s as HTMLSelectElement).options).map((o) => o.textContent ?? "")));
  await select(page, table.id);
  // The scroll setting may sit under a More fold: open the folds, then read the menu that offers "After a click".
  for (let i = 0; i < 6; i++) {
    const closed = page.locator(`[data-inspector][data-node-id="${table.id}"] button[aria-expanded="false"]`).filter({ visible: true });
    if (!(await closed.count())) break;
    await closed.first().click();
    await page.waitForTimeout(120);
  }
  const scrollMenu = (await page.locator(`[data-inspector][data-node-id="${table.id}"] select`).evaluateAll((els) => els.map((s) => Array.from((s as HTMLSelectElement).options).map((o) => o.textContent ?? "")))).find((o) => o.some((t) => /After a click/.test(t))) ?? [];
  // The icon picker: three sources, each on its own row; a website icon keeps its site's name.
  const site = await startSite();
  await select(page, icon.id);
  await page.locator(`[data-inspector][data-node-id="${icon.id}"] [data-icon-pick="name"]`).click();
  const rows = await page.locator("[data-icon-picker] [data-icon-entries] > *").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  await page.locator("[data-icon-picker] [data-icon-from-website]").click();
  await page.locator("[data-icon-picker] [data-website-url]").fill(site.url);
  await page.locator("[data-icon-picker] [data-website-fetch]").click();
  await page.locator("[data-icon-picker] [data-favicon-use]").click({ timeout: 12_000 });
  await untilDraft(page.request, appB.id, (x) => String(find(x, icon.id)?.props.name ?? "").startsWith("/uploads/"));
  const iconWords = await page.locator(`[data-inspector][data-node-id="${icon.id}"] [data-icon-pick="name"]`).getAttribute("aria-label");
  const hint = await page.locator(`[data-inspector][data-node-id="${icon.id}"] [data-icon-field="name"] [data-field-hint]`).textContent().catch(() => "");
  await site.close();
  await page.screenshot({ path: shot("i20-builder") });
  // A phone table wider than its box fades on the side that continues.
  await publish(page.request, appB.id);
  const { ctx, p } = await phone(browser, page);
  await p.goto(`${ORIGIN}/a/${slugB}`);
  const wrap = p.locator(`[data-node="${table.id}"] .atr-table-wrap`).first();
  await expect(wrap).toBeVisible({ timeout: 20_000 });
  await p.waitForTimeout(800);
  const side = await wrap.evaluate((e) => ({ over: e.scrollWidth - e.clientWidth, more: e.hasAttribute("data-more-right") }));
  await p.screenshot({ path: shot("i20-phone-table") });
  await ctx.close();
  writeEv("i20-lows.json", { dots, count, afterWheel, midFade, endFade, partOptions, scrollMenu, rows, iconWords, hint, side });
  expect(dots <= 1 || count === 1, "dots on one line, or a count").toBe(true);
  expect(afterWheel, "five notches, five slots").toBe("5");
  expect(midFade, "the far slot fades in").toBeGreaterThan(0.05);
  expect(midFade).toBeLessThan(0.95);
  expect(endFade).toBe(1);
  expect(partOptions).toContain("Arrow buttons");
  expect(partOptions).toContain("Pointer over");
  expect(scrollMenu.filter((o) => /default/i.test(o)).length, "one default in the scroll menu").toBe(1);
  expect(new Set(rows).size, "From a website and Upload on their own rows").toBe(rows.length);
  expect(iconWords ?? "").toMatch(/from the website/);
  expect(hint ?? "").toMatch(/website/);
  if (side.over > 1) expect(side.more, "a sideways cue").toBe(true);
});

// A stand-in website with one PNG icon, served by this test on loopback (FAKE).
async function startSite(): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const { deflateSync, crc32 } = await import("node:zlib");
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((32 * 3 + 1) * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) raw.set([30 + x * 5, 90, 200 - y * 4], y * (32 * 3 + 1) + 1 + x * 3);
  const icon = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/fake-e2e-icon.png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(icon); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><head><title>FAKE e2e site</title><link rel="icon" type="image/png" sizes="32x32" href="/fake-e2e-icon.png"></head><body>FAKE</body></html>');
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((res) => server.close(() => res())) };
}
