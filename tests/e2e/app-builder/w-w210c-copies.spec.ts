// Wave 2.10c builder A (app-builder): R1, per-copy changes inside a Repeat (Tristan's try-out round 1 item;
// builder brief R1). With one copy selected on the canvas, the inspector offers "This copy only" beside
// "Every copy"; an edit there writes `copyOverrides` on the repeat as one history entry, the copy shows a
// "Changed" mark, "Reset this copy" takes it away, and RowHint says which mode is on. The render half
// (merging the override for that row) is components' (C). Stand-in: the 9-machine fake Prometheus
// (tests/e2e/fixtures); never a real service. Evidence: evidence/app-builder/w210c-r1/<stage>/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakePrometheus, type FakePrometheus } from "../fixtures/fake-prometheus";
import { api, contextFor, OWNER, SHELL_VARIANTS } from "./helpers";

test.describe.configure({ timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

type Node = { id: string; type: string; props: Record<string, unknown>; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; root: Node }[] } };

const STAGE = process.env.ATRIUM_E2E_W210C_STAGE ?? "pass";
const out = (...p: string[]) => { const f = path.resolve("evidence/app-builder/w210c-r1", STAGE, ...p); mkdirSync(path.dirname(f), { recursive: true }); return f; };
const note = (name: string, data: unknown) => writeFileSync(out(`${name}.json`), JSON.stringify(data, null, 2));
const RUN = Date.now().toString(36).slice(-4);
const LIGHT = SHELL_VARIANTS[0]!;
const owner = () => api(OWNER);
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const enc = (v: number, len: number) => Array.from({ length: len }, (_, i) => B32[Math.floor(v / 32 ** (len - 1 - i)) % 32]).join("");
const RUN_N = parseInt(RUN, 36) % 32 ** 4;
let n = 0;
const cid = () => `c_${enc(RUN_N, 4)}${enc(n++, 6)}`;

let prom: FakePrometheus | null = null;
let promId = "";
test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return;
  prom = await startFakePrometheus();
  const c = await owner();
  const r = await c.post("/api/integrations", { data: { secrets: {}, untested: true, packageId: "prometheus", name: `Prometheus copies ${RUN}`, config: { baseUrl: prom.url, authMode: "none" } } });
  if (!r.ok()) throw new Error(`integration: ${await r.text()}`);
  promId = (await r.json()).id as string;
});
test.afterAll(async () => { await prom?.close(); });

async function draft(id: string): Promise<Draft> {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json();
}
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 8000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const walk = (x: Node, f: (n: Node) => void) => { f(x); for (const k of x.children ?? []) walk(k, f); };
const nodeIn = (d: Draft, id: string): Node | undefined => { let f: Node | undefined; for (const p of d.doc.pages) walk(p.root, (x) => { if (x.id === id) f = x; }); return f; };
const overrides = (d: Draft, repeatId: string) => (nodeIn(d, repeatId)?.props.copyOverrides ?? {}) as Record<string, Record<string, { props?: Record<string, unknown>; hidden?: boolean }>>;

/** An app whose page has one repeat over every machine, each copy a stat: the machine's name and CPU. */
async function machinesApp(slug: string): Promise<{ id: string; repeat: string; stat: string }> {
  const c = await owner();
  const r = await c.post("/api/apps", { data: { name: `Copies ${slug}`, slug, template: "blank" } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  const d = await draft(id);
  const repeat = cid();
  const stat = cid();
  const ops = [
    { op: "source.set", source: { name: "hosts", integrationId: promId, endpointId: "machines-overview", refreshSec: 30 } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: repeat, type: "repeat", name: "Machines", props: { items: { $bind: "{{ hosts.rows }}" }, columns: 3, max: 50, empty: "No machines" }, slot: { x: 0, y: 0, w: 12, h: 40 }, children: [
      { id: stat, type: "stat", props: { label: { $bind: "{{ $item.name }}" }, value: { $bind: "{{ $item.cpu }}" }, unit: "%" } },
    ] } },
  ];
  const put = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops } });
  if (!put.ok()) throw new Error(`ops failed: ${await put.text()}`);
  return { id, repeat, stat };
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
}
/** The drawn copy of the stat for one machine (the canvas or the viewer). */
const copyOf = (page: Page, scope: string, stat: string, machine: string) =>
  page.locator(`${scope} [data-node="${stat}"]`).filter({ hasText: machine }).first();

test("R1: This copy only changes one machine's stat; the others stay; it survives reload and publish; undo reverts it; Reset this copy", async ({ browser }) => {
  const slug = `cp-${RUN}`;
  const { id, repeat, stat } = await machinesApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const ace = copyOf(page, "[data-canvas-root]", stat, "ACE");
  const firefly = copyOf(page, "[data-canvas-root]", stat, "firefly");
  await expect(ace).toBeVisible({ timeout: 15_000 });
  await expect(firefly).toBeVisible();
  const fireflyBefore = await firefly.innerText();

  // Select the ACE copy on the canvas. Every copy is the default, and RowHint says so.
  await ace.click();
  const insp = page.locator(`[data-inspector="${stat}"]`);
  await expect(insp).toBeVisible();
  const scope = insp.locator("[data-copy-scope]");
  await expect(scope).toBeVisible();
  await expect(scope.locator('[data-copy-mode="all"]')).toHaveAttribute("aria-pressed", "true");
  await expect(insp.locator("[data-row-hint]")).toContainText("changes every copy");

  // This copy only: RowHint names the copy.
  await scope.locator('[data-copy-mode="one"]').click();
  await expect(scope.locator('[data-copy-mode="one"]')).toHaveAttribute("aria-pressed", "true");
  await expect(insp.locator("[data-row-hint]")).toContainText("only the ACE copy");
  await page.screenshot({ path: out("r1-this-copy-only.png") });

  // Change the unit in this copy only: one typed word, one history entry.
  const unit = insp.locator('[data-field="unit"] input').first();
  await unit.fill("");
  await unit.pressSequentially("pct", { delay: 100 });
  await unit.blur();
  let d = await untilDraft(id, (x) => overrides(x, repeat).ACE?.[stat]?.props?.unit === "pct");
  expect(overrides(d, repeat), "the override is stored on the repeat for ACE only").toEqual({ ACE: { [stat]: { props: { unit: "pct" } } } });
  expect(nodeIn(d, stat)!.props.unit, "the template is unchanged").toBe("%");
  await expect(page.locator("[data-builder-bar] [data-history-undo]")).toHaveAttribute("title", "Undo Change Stat in this copy");

  // The canvas: ACE shows the new unit, firefly is as it was (render half, components). The copy shows Changed.
  await expect(ace).toContainText("pct", { timeout: 8000 });
  expect(await firefly.innerText(), "the other copies stay as they were").toBe(fireflyBefore);
  await expect(page.locator("[data-copy-changed-mark]")).toHaveCount(1);
  await expect(page.locator("[data-copy-changed-mark]")).toHaveAttribute("data-copy-changed-mark", "ACE");
  await page.screenshot({ path: out("r1-changed-mark.png") });

  // Undo reverts it in one step; redo puts it back.
  await page.locator("[data-builder-bar] [data-history-undo]").click();
  d = await untilDraft(id, (x) => !overrides(x, repeat).ACE);
  expect(nodeIn(d, repeat)!.props.copyOverrides, "undo removed the override").toBeUndefined();
  await expect(ace).not.toContainText("pct");
  await page.locator("[data-builder-bar] [data-history-redo]").click();
  d = await untilDraft(id, (x) => overrides(x, repeat).ACE?.[stat]?.props?.unit === "pct");
  expect(overrides(d, repeat).ACE?.[stat]?.props?.unit).toBe("pct");

  // Reload: the override is kept.
  await page.reload();
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 20_000 });
  await expect(ace).toContainText("pct", { timeout: 15_000 });
  await expect(page.locator('[data-copy-changed-mark="ACE"]')).toHaveCount(1);
  expect(await firefly.innerText()).toBe(fireflyBefore);

  // Publish through the builder; the viewer shows ACE changed and firefly not.
  await page.locator("[data-publish]").click();
  await page.locator("[data-publish-confirm]").click();
  await expect(page.locator("[data-publish-glow], [data-publish-check]").first()).toBeAttached();
  const viewer = await ctx.newPage();
  await viewer.goto(`/a/${slug}`);
  await expect(copyOf(viewer, "body", stat, "ACE")).toContainText("pct", { timeout: 15_000 });
  await expect(copyOf(viewer, "body", stat, "firefly")).not.toContainText("pct");
  await expect(viewer.locator("[data-copy-changed-mark]"), "no builder mark for viewers").toHaveCount(0);
  await viewer.screenshot({ path: out("r1-viewer-published.png") });
  await viewer.close();

  // Reset this copy: the override goes, as one undoable step.
  await ace.click();
  await expect(insp.locator("[data-copy-reset]")).toBeVisible();
  await insp.locator("[data-copy-reset]").click();
  d = await untilDraft(id, (x) => !overrides(x, repeat).ACE);
  expect(nodeIn(d, repeat)!.props.copyOverrides).toBeUndefined();
  await expect(page.locator("[data-copy-changed-mark]")).toHaveCount(0);
  await expect(page.locator("[data-builder-bar] [data-history-undo]")).toHaveAttribute("title", "Undo Reset this copy");
  note("r1", { overrides: overrides(await draft(id), repeat), fireflyBefore });
  await ctx.close();
});

test("R1: Every copy stays the default; an edit there changes the template for all machines", async ({ browser }) => {
  const slug = `cp-all-${RUN}`;
  const { id, repeat, stat } = await machinesApp(slug);
  const ctx = await contextFor(browser, OWNER, { variant: LIGHT, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await openBuilder(page, slug);
  const ace = copyOf(page, "[data-canvas-root]", stat, "ACE");
  await expect(ace).toBeVisible({ timeout: 15_000 });
  await ace.click();
  const insp = page.locator(`[data-inspector="${stat}"]`);
  await expect(insp.locator('[data-copy-scope] [data-copy-mode="all"]')).toHaveAttribute("aria-pressed", "true");
  const unit = insp.locator('[data-field="unit"] input').first();
  await unit.fill("pc");
  await unit.blur();
  const d = await untilDraft(id, (x) => nodeIn(x, stat)?.props.unit === "pc");
  expect(nodeIn(d, stat)!.props.unit).toBe("pc");
  expect(nodeIn(d, repeat)!.props.copyOverrides).toBeUndefined();
  await ctx.close();
});
