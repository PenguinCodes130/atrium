// Wave 2.10a round 3 (components half): gauntlet r2 recheck H1. A published "Card for each" (a repeat whose
// template is a card) whose drawn box is shorter than its cards need at the viewer's width is never cut and
// never scrolls inside itself: the viewer grows it, as it grows any fit box. Recorded failing first on the
// round 2 code (evidence/lead/w210a-r3/failing-first/). Served by tests/e2e/components/serve.sh (port 3114).
// Test-only values; the machine names and readings are made up.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn } from "./helpers";

test.describe.configure({ timeout: 240_000 });
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}`;
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);
const STAGE = process.env.ATRIUM_E2E_W210_STAGE ?? "pass";
const EV = path.resolve(here, `../../../evidence/lead/w210a-r3/${STAGE}`);
const file = (name: string) => {
  const p = path.join(EV, name);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
};

type Slot = { x: number; y: number; w: number; h: number };
type Node = { id: string; type: string; props: Record<string, unknown>; slot?: Slot; children?: Node[]; name?: string };

async function ops(req: APIRequestContext, id: string, list: unknown[]) {
  const d = await (await req.get(`/api/apps/${id}/draft`)).json();
  const r = await req.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function newApp(req: APIRequestContext, slug: string, kids: Node[]): Promise<string> {
  const r = await req.post("/api/apps", { data: { name: `R3 ${slug}`, slug }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  const id = (await r.json()).app.id as string;
  const d = await (await req.get(`/api/apps/${id}/draft`)).json();
  await ops(req, id, kids.map((n) => ({ op: "node.add", parentId: d.doc.pages[0].root.id, node: n })));
  return id;
}
async function publish(req: APIRequestContext, appId: string) {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note: "w210a-r3" }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop project; the phone width is set per test");
  await signIn(context, page.request);
  await page.context().addCookies([{ name: "atrium_swept", value: "1", url: ORIGIN }]);
});

const NAMES = ["ACE", "firefly", "minipc-ubuntu", "Pelican", "pve1", "pve2", "pve3", "RP5-2", "RP5-3"];
const ROWS = NAMES.map((name, i) => ({ name, cpu: 7.8 + i * 3.1, mem: 41.2 + i, disk: 52.3 - i, load: 0.41 + i / 10, up: `${3 + i} d 4 h` }));
const FIELDS = [["cpu", "CPU"], ["mem", "Memory"], ["disk", "Disk (/)"], ["load", "Load (5 min)"], ["up", "Uptime"]] as const;
/** A Card for each as Insert > Card for each and the data picker build it, with literal rows. */
function cardForEach(id: string, h: number): Node {
  const stats: Node[] = FIELDS.map(([k, label], i) => ({ id: `c_r3st${"abcde"[i]}${id.slice(-5)}`, type: "stat", props: { value: { $bind: `{{ $item.${k} }}` }, label, decimals: 1 }, slot: { x: (i % 2) * 6, y: Math.floor(i / 2) * 14, w: 6, h: 14 } }));
  const grid: Node = { id: "c_r3gridaaaa", type: "grid", props: { minRows: 1, gap: 8 }, children: stats };
  const card: Node = { id: "c_r3cardaaaa", type: "card", name: "Card for each row", props: { title: { $bind: "{{ $item.name }}" }, padded: true }, children: [grid] };
  return { id, type: "repeat", name: "Card for each", props: { items: ROWS, columns: 3, gap: 12, max: 50, empty: "Nothing reported yet" }, slot: { x: 0, y: 0, w: 12, h }, children: [card] };
}

async function measure(page: Page, id: string) {
  return page.locator(`[data-node="${id}"]`).first().evaluate((n) => {
    const r = n.querySelector<HTMLElement>(".atr-repeat")!;
    const nb = n.getBoundingClientRect();
    const cards = [...r.querySelectorAll<HTMLElement>(":scope > [data-slot=item]")];
    const lastBottom = Math.max(...cards.map((c) => c.getBoundingClientRect().bottom));
    // Anything inside a card cut by its own box (a stat whose value or label is clipped).
    const cut = [...r.querySelectorAll<HTMLElement>("[data-slot=root]")].filter((e) => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== "visible").length;
    return { node: Math.round(nb.height), nodeBottom: Math.round(nb.bottom), client: r.clientHeight, scroll: r.scrollHeight, overflowY: getComputedStyle(r).overflowY, cards: cards.length, lastBottom: Math.round(lastBottom), cut };
  });
}

test("H1: a published Card for each drawn shorter than its cards need grows in the viewer at 1440, 1280 and 390: no inner scroll, the last row of cards whole", async ({ page, browser }) => {
  const slug = `r3-cards-${RUN}`;
  const id = "c_r3repeataa";
  // 30 rows (240px) is far less than 9 cards at 3 across need at any width.
  const app = await newApp(page.request, slug, [cardForEach(id, 30), { id: "c_r3belowaaa", type: "text", props: { text: "Below the cards" }, slot: { x: 0, y: 30, w: 12, h: 6 } }]);
  await publish(page.request, app);
  const out: Record<string, unknown> = {};
  for (const w of [1440, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`/a/${slug}`);
    await expect(page.locator(`[data-node="${id}"] [data-slot=item]`).nth(8)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const m = await measure(page, id);
    const below = (await page.locator('[data-node="c_r3belowaaa"]').first().boundingBox())!;
    out[`viewer${w}`] = { ...m, belowTop: Math.round(below.y) };
    await page.screenshot({ path: file(`h1-viewer-${w}.png`), fullPage: true });
  }
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await phone.addCookies(await page.context().cookies());
  const p = await phone.newPage();
  await p.goto(`${ORIGIN}/a/${slug}`);
  await expect(p.locator(`[data-node="${id}"] [data-slot=item]`).nth(8)).toBeAttached({ timeout: 15_000 });
  await p.waitForTimeout(800);
  out.viewer390 = await measure(p, id);
  await p.screenshot({ path: file("h1-viewer-390.png"), fullPage: true });
  await phone.close();
  writeFileSync(file("h1-repeat.json"), JSON.stringify(out, null, 2));
  for (const [k, v] of Object.entries(out) as [string, Awaited<ReturnType<typeof measure>> & { belowTop?: number }][]) {
    expect(v.cards, k).toBe(9);
    expect(v.scroll, `${k}: the repeat holds ${v.scroll}px of cards in ${v.client}px (overflow ${v.overflowY})`).toBeLessThanOrEqual(v.client + 1);
    expect(v.lastBottom, `${k}: the last card ends at ${v.lastBottom}, its box at ${v.nodeBottom}`).toBeLessThanOrEqual(v.nodeBottom + 1);
    expect(v.cut, `${k}: parts cut inside the cards`).toBe(0);
    if (v.belowTop !== undefined) expect(v.belowTop, `${k}: what is below moves down past the cards`).toBeGreaterThanOrEqual(v.lastBottom);
  }
});
