// Round 3 (gauntlet w2-r2 Fix List, approved 2026-10-19): each test proves one item's pass condition in
// the real product (the builder at /build, the viewer at /a, /library), with the round 2 customisation
// critic's 24 hostile node CSS variants plus the new bypasses. Evidence goes to
// evidence/components/<ATRIUM_E2E_EVIDENCE_ROUND>/fixes/.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { evidence, ORIGIN, signIn, withFrameFix, writeEvidence } from "./helpers";

const H = { origin: ORIGIN };
type Doc = { pages: { id: string; slug: string; root: { id: string; children?: { id: string; type: string; props: Record<string, unknown> }[] } }[] };

async function ensureApp(req: APIRequestContext, slug: string, name: string, template?: string): Promise<string> {
  const tiles = ((await (await req.get("/api/apps")).json()).tiles ?? []) as { app: { id: string; slug: string } }[];
  const hit = tiles.find((t) => t.app.slug === slug);
  if (hit) return hit.app.id;
  const r = await req.post("/api/apps", { data: { name, slug, ...(template ? { template } : {}) }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).app.id as string;
}
async function draft(req: APIRequestContext, appId: string): Promise<{ rev: number; doc: Doc }> {
  return (await req.get(`/api/apps/${appId}/draft`)).json();
}
async function ops(req: APIRequestContext, appId: string, list: unknown[]) {
  const d = await draft(req, appId);
  const r = await req.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function setNodes(req: APIRequestContext, appId: string, nodes: Record<string, unknown>[]) {
  const d = await draft(req, appId);
  const root = d.doc.pages[0]!.root;
  if (!(root.children ?? []).length && !nodes.length) return;
  await ops(req, appId, [...(root.children ?? []).map((c) => ({ op: "node.remove", nodeId: c.id })), ...nodes.map((node) => ({ op: "node.add", parentId: root.id, node }))]);
}
async function publish(req: APIRequestContext, appId: string, note = "components r3") {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function openBuilder(page: Page, slug: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-canvas-root] [data-atrium-canvas]")).toBeVisible();
}
async function selectLayer(page: Page, id: string) {
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${id}"]`).click();
  await expect(page.locator(`[data-inspector][data-node-id="${id}"]`)).toBeVisible();
}
const nodeProp = async (req: APIRequestContext, appId: string, id: string, key: string) => {
  const d = await draft(req, appId);
  const walk = (n: { id: string; props?: Record<string, unknown>; children?: unknown[] }): unknown => {
    if (n.id === id) return n.props ? (Object.prototype.hasOwnProperty.call(n.props, key) ? n.props[key] : "(unset)") : "(unset)";
    for (const c of (n.children ?? []) as typeof n[]) {
      const hit = walk(c);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(d.doc.pages[0]!.root as never);
};

// ---------- the hostile variants (customisation critic, w2-r2: s2, s3, s5 probes) plus new bypasses ----------

const BIG = "position:absolute;inset:-2000px;background:rgba(255,0,0,.6);z-index:2147483647;";
const R1_STAR = `* { position: absolute; top: -2000px; left: -2000px; width: 6000px; height: 6000px; background: rgba(255,0,0,0.35); z-index: 2147483647; }
:scope { position: fixed; inset: 0; box-shadow: 0 0 0 3000px rgba(255,0,0,.4); }
:scope ~ * { display: none; }
[data-node="c_r3plainaaa"] { display: none; }
.anything + .other { color: red; }`;
export const VARIANTS: Record<string, string> = {
  // The critic's 24 (containment.json, containment-display.json, containment-var.json).
  r1_star_absolute: R1_STAR,
  fixed_desc: "* { position: fixed; inset: 0; background: rgba(255,0,0,.6); z-index: 2147483647; }",
  sticky_desc: "* { position: sticky; top: 0; height: 4000px; background: rgba(255,0,0,.6); }",
  transform_desc: "[data-slot] { transform: scale(40); background: rgba(255,0,0,.6); }",
  filter_shadow_desc: "[data-slot] { filter: drop-shadow(0 0 0 red) drop-shadow(400px 400px 0 red); box-shadow: 0 0 0 3000px rgba(255,0,0,.6); outline: 3000px solid rgba(255,0,0,.5); }",
  pseudo_scope: `:scope::before { content: ""; ${BIG} } :scope::after { content: ""; ${BIG} }`,
  scope_transform: ":scope { transform: scale(30); background: red; }",
  scope_not_transform: ":scope:not(.zz) { scale: 30; z-index: 99; box-shadow: 0 0 0 3000px red; }",
  media_scope_transform: "@media (min-width: 1px) { :scope { transform: scale(30); outline: 3000px solid red; } }",
  guard_override: `:scope { overflow: visible !important; isolation: auto !important; position: static !important; contain: none !important; } * { ${BIG} }`,
  all_revert: `:scope { all: revert-layer !important; } * { ${BIG} }`,
  display_contents: `:scope { display: contents !important; } * { ${BIG} }`,
  keyframes_scale: ":scope { animation: cuatk 1ms forwards; } @keyframes cuatk { to { scale: 30; z-index: 2147483647; } }",
  keyframes_shadow: ":scope { animation: cush 1ms forwards; } @keyframes cush { to { box-shadow: 0 0 0 3000px rgba(255,0,0,.6); outline: 3000px solid rgba(255,0,0,.5); margin: -300px; } }",
  scope_height: ":scope { height: 4000px; min-height: 4000px; background: rgba(255,0,0,.6); }",
  scope_padding: ":scope { padding-bottom: 3000px; background: rgba(255,0,0,.6); }",
  scope_grid: ":scope { grid-row: 1 / 60; grid-column: 1 / -1; order: -1; background: rgba(255,0,0,.6); }",
  scope_blend: ":scope { mix-blend-mode: difference; backdrop-filter: invert(1); }",
  display_inline: `:scope { display: inline; } * { ${BIG} }`,
  display_table_row: `:scope { display: table-row; } * { ${BIG} }`,
  display_ruby: `:scope { display: ruby-text; } * { ${BIG} }`,
  display_contents_plain: ":scope { display: contents; } [data-slot] { position: absolute; inset: -3000px; background: rgba(255,0,0,.5); z-index: 5; }",
  var_fixed: "[data-slot] { --theme-cu-pos: fixed; position: var(--theme-cu-pos); inset: 0; background: rgba(255,0,0,.55); z-index: 2147483647; }",
  var_fixed_fallback: "[data-slot] { position: var(--user-nope, fixed); inset: 0; background: rgba(255,0,0,.55); z-index: 2147483647; }",
  // New bypass attempts (round 3).
  env_fixed: "[data-slot] { position: env(atrium-nope, fixed); inset: 0; background: rgba(255,0,0,.55); z-index: 2147483647; }",
  var_display_contents: ":scope { --user-d: contents; display: var(--user-d); } [data-slot] { position: absolute; inset: -3000px; background: rgba(255,0,0,.5); z-index: 5; }",
  var_display_fallback: ":scope { display: var(--user-nope, contents) !important; } [data-slot] { position: var(--user-p, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 5; }",
  contents_and_fixed: ":scope { display: contents; } [data-slot] { position: var(--user-p, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 2147483647; }",
  shell_keyframes_spin: ":scope { animation: atr-spin 2s linear infinite; background: red; }",
  shell_keyframes_root: ":scope { animation: atr-anim-rise 60s linear infinite reverse; scale: 30; }",
  var_height: ":scope { --user-h: 4000px; height: var(--user-h); min-height: var(--user-h); block-size: var(--user-h); }",
  var_padding: ":scope { --user-p: 3000px; padding-block-end: var(--user-p); padding: 0 0 var(--user-p); }",
  desc_runaway: "[data-slot] { min-height: 6000px; padding-bottom: 4000px; background: rgba(255,0,0,.4); }",
  writing_mode: ":scope { writing-mode: vertical-rl; height: 100%; } * { position: absolute; inset: -2000px; background: rgba(255,0,0,.5); }",
  zoom_root: ":scope { zoom: 30; } [data-slot] { zoom: 30; background: rgba(255,0,0,.5); }",
  margin_negative: ":scope { margin: -400px; } [data-slot] { margin: -400px; background: rgba(255,0,0,.5); }",
  inset_var: ":scope { inset: var(--user-i, -500px); position: var(--user-q, relative); } [data-slot] { position: var(--user-r, absolute); inset: var(--user-i, -3000px); background: rgba(255,0,0,.5); z-index: 9; }",
  container_query_fixed: "@container (min-width: 1px) { [data-slot] { position: var(--user-x, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 99; } }",
  supports_fixed: "@supports (position: fixed) { [data-slot] { position: var(--user-x, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 99; } }",
  interactivity_inert: "[data-slot] { interactivity: inert; -webkit-user-modify: read-write; }",
  contain_none_var: ":scope { contain: var(--user-c, none) !important; overflow: var(--user-o, visible) !important; } [data-slot] { position: var(--user-x, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 99; }",
};
const CRITIC_24 = Object.keys(VARIANTS).slice(0, 24);

const PLAIN = "c_r3plainaaa";
const BELOW = "c_r3belowaaa";
const HOSTILE = "c_r3evilaaaa";
const STYLED = "c_r3styledaa";
const baseNodes = (css: string) => [
  { id: STYLED, type: "stat", name: "Styled", props: { value: 3, label: "Styled" }, overrideTheme: true, style: { root: { background: "#ffffff", boxShadow: "0 24px 48px rgba(0,0,0,.55)" } }, slot: { x: 0, y: 0, w: 4, h: 14 } },
  { id: PLAIN, type: "stat", name: "Plain", props: { value: 7, label: "Plain" }, slot: { x: 4, y: 0, w: 4, h: 14 } },
  { id: HOSTILE, type: "stat", name: "Hostile css", props: { value: 9, label: "Hostile" }, css, slot: { x: 8, y: 0, w: 4, h: 14 } },
  { id: BELOW, type: "stat", name: "Below", props: { value: 5, label: "Below" }, slot: { x: 0, y: 30, w: 12, h: 14 } },
];

/** Hit-tests a 40px grid (outside the hostile node's box plus 14px) and every node's centre. */
async function probe(page: Page) {
  return page.evaluate((ids) => {
    const who = (el: Element | null): string => {
      if (!el) return "none";
      const n = el.closest("[data-node]")?.getAttribute("data-node");
      if (n && n !== ids.root) return n;
      if (el.closest("[data-canvas-nav], nav, [data-builder-bar], header, aside, [data-left-panel], [data-inspector]")) return "chrome";
      return el.closest("[data-atrium-canvas]") ? "canvas" : el.tagName.toLowerCase();
    };
    const box = document.querySelector(`[data-node="${ids.hostile}"]`)!.getBoundingClientRect();
    let stolen = 0;
    let total = 0;
    for (let x = 10; x < innerWidth; x += 40)
      for (let y = 10; y < innerHeight; y += 40) {
        if (x > box.left - 14 && x < box.right + 14 && y > box.top - 14 && y < box.bottom + 14) continue;
        total++;
        if (who(document.elementFromPoint(x, y)) === ids.hostile) stolen++;
      }
    const centre = (id: string) => {
      const el = document.querySelector(`[data-node="${id}"]`);
      if (!el) return "missing";
      const r = el.getBoundingClientRect();
      return who(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    };
    const navLink = document.querySelector("[data-canvas-nav] a, [data-canvas-nav] button");
    const nr = navLink?.getBoundingClientRect();
    const hn = document.querySelector(`[data-node="${ids.hostile}"]`)!;
    const cs = getComputedStyle(hn);
    return {
      stolen,
      total,
      plain: centre(ids.plain),
      below: centre(ids.below),
      styled: centre(ids.styled),
      nav: nr ? who(document.elementFromPoint(nr.left + nr.width / 2, nr.top + nr.height / 2)) : "no nav",
      hostile: { display: cs.display, position: cs.position, contain: cs.contain, overflow: cs.overflow, height: Math.round(box.height), width: Math.round(box.width), animation: cs.animationName, zoom: cs.zoom },
      compiled: [...document.querySelectorAll(`style[data-node-css="${ids.hostile}"]`)].map((s) => s.textContent).join("\n").slice(0, 600),
    };
  }, { hostile: HOSTILE, plain: PLAIN, below: BELOW, styled: STYLED, root: "" });
}

test.describe("desktop", () => {
  // These tests publish dozens of versions in one browser; each new version installs a new app worker that
  // claims the page mid-navigation, which now and then stalls page.goto for the whole timeout. Containment
  // does not involve the offline worker, so it stays off here (the worker race is a known limit, Wave 2.9 lead).
  test.use({ serviceWorkers: "block" });
  test.beforeEach(async ({ context, page }, info) => {
    test.skip(info.project.name !== "desktop", "desktop only");
    await signIn(context, page.request);
    await withFrameFix(context);
  });

  test("Fixes 1, 2 and 9 (viewer): every hostile variant steals 0 points, nav and neighbours keep their clicks, the root keeps its box and height", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const req = page.request;
    const appId = await ensureApp(req, "r3-contain", "R3 contain");
    await setNodes(req, appId, baseNodes(""));
    await publish(req, appId);
    const results: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const [name, css] of Object.entries(VARIANTS)) {
      await ops(req, appId, [{ op: "node.update", nodeId: HOSTILE, patch: { css } }]);
      await publish(req, appId, name);
      await page.goto("/a/r3-contain");
      await expect(page.locator(`[data-node="${PLAIN}"]`)).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      const p = await probe(page);
      results[name] = { css, ...p, critic24: CRITIC_24.includes(name) };
      if (["r1_star_absolute", "display_contents", "display_contents_plain", "var_fixed", "var_fixed_fallback", "env_fixed", "contents_and_fixed", "shell_keyframes_spin", "desc_runaway", "contain_none_var"].includes(name)) await page.screenshot({ path: evidence(`fixes/containment/viewer-${name}.png`) });
      // A neighbour's centre hits the neighbour, or lies below the screen when a runaway variant made the
      // row taller (then nothing is there to hit); it is never the hostile node.
      const own = (got: string, want: string) => got === want || got === "none";
      const cap = Math.max(1.5 * 900, 1200);
      const bad = p.stolen !== 0 || !own(p.plain, PLAIN) || !own(p.below, BELOW) || !own(p.styled, STYLED) || !["chrome", "no nav"].includes(p.nav) || p.hostile.display === "contents" || p.hostile.position !== "relative" || !/layout/.test(p.hostile.contain) || p.hostile.height > cap || p.hostile.animation !== "none";
      if (bad) failures.push(`${name}: ${JSON.stringify(p)}`);
    }
    writeEvidence("fixes/fix01-02-09-viewer-containment.json", { variants: Object.keys(VARIANTS).length, critic24: CRITIC_24, results });
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("Fixes 1 and 2 (builder): a click on the plain and the lower stat selects them, and the builder chrome keeps its clicks, under the worst variants", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const req = page.request;
    const appId = await ensureApp(req, "r3-contain-b", "R3 contain builder");
    const out: Record<string, unknown> = {};
    for (const name of ["display_contents", "display_contents_plain", "var_fixed", "var_fixed_fallback", "env_fixed", "var_display_fallback", "contents_and_fixed", "shell_keyframes_spin", "r1_star_absolute", "contain_none_var"]) {
      await setNodes(req, appId, baseNodes(VARIANTS[name]!));
      await openBuilder(page, "r3-contain-b");
      await expect(page.locator(`[data-node="${PLAIN}"]`)).toBeVisible();
      await page.waitForTimeout(600);
      const p = await probe(page);
      const chrome = await page.evaluate((hostile) => {
        const hits: Record<string, boolean> = {};
        for (const sel of ["[data-builder-bar]", '[data-left-tab="layers"]', "[data-canvas-nav]"]) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          hits[sel] = !document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2)?.closest(`[data-node="${hostile}"]`);
        }
        return hits;
      }, HOSTILE);
      await page.locator(`[data-node="${PLAIN}"] [data-slot="root"]`).click();
      await expect(page.locator(`[data-inspector][data-node-id="${PLAIN}"]`)).toBeVisible();
      await page.locator(`[data-node="${BELOW}"] [data-slot="root"]`).click();
      await expect(page.locator(`[data-inspector][data-node-id="${BELOW}"]`)).toBeVisible();
      if (name === "display_contents" || name === "var_fixed") await page.screenshot({ path: evidence(`fixes/containment/builder-${name}.png`) });
      out[name] = { stolen: `${p.stolen}/${p.total}`, plain: p.plain, below: p.below, chromeKeepsClicks: chrome, clickSelects: [PLAIN, BELOW] };
      expect(p.stolen, name).toBe(0);
      expect(Object.values(chrome).every(Boolean), name).toBe(true);
    }
    writeEvidence("fixes/fix01-02-builder-containment.json", out);
  });

  test("Fix 7: a Style panel shadow renders whole outside the node's clip, the field states the reach, and too large a shadow is refused", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const req = page.request;
    const appId = await ensureApp(req, "r3-shadow", "R3 shadow");
    await setNodes(req, appId, [
      { id: STYLED, type: "stat", name: "Shadowed", props: { value: 3, label: "Soft" }, overrideTheme: true, style: { root: { background: "#ffffff", boxShadow: "0 24px 48px rgba(0,0,0,.55)" } }, slot: { x: 2, y: 0, w: 4, h: 14 } },
      { id: PLAIN, type: "stat", name: "Plain", props: { value: 7, label: "Plain" }, slot: { x: 8, y: 0, w: 4, h: 14 } },
    ]);
    await publish(req, appId);
    await page.goto("/a/r3-shadow");
    const node = page.locator(`[data-node="${STYLED}"]`);
    await expect(node).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    const look = await node.evaluate((el) => ({ nodeShadow: getComputedStyle(el).boxShadow, rootShadow: getComputedStyle(el.querySelector('[data-slot="root"]')!).boxShadow, clip: getComputedStyle(el).getPropertyValue("overflow-clip-margin") }));
    expect(look.nodeShadow).toContain("24px 48px");
    expect(look.rootShadow).toBe("none");
    expect(look.clip).toBe("12px");
    // Pixel column under the node's centre: darker than the page well past the 12px clip, fading smoothly.
    const box = (await node.boundingBox())!;
    const shot = await page.screenshot({ clip: { x: box.x, y: box.y + box.height, width: box.width, height: 90 } });
    await page.screenshot({ path: evidence("fixes/fix07-shadow-viewer.png"), clip: { x: Math.max(0, box.x - 80), y: Math.max(0, box.y - 20), width: box.width + 160, height: box.height + 120 } });
    const lum = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const x = Math.floor(img.width / 2);
      return Array.from({ length: img.height }, (_, y) => {
        const d = g.getImageData(x, y, 1, 1).data;
        return Math.round((d[0]! + d[1]! + d[2]!) / 3);
      });
    }, shot.toString("base64"));
    const pageBg = lum[lum.length - 1]!;
    // At 8, 20, 40 and 60px below the edge the shadow is still there; no jump at the old 12px clip.
    for (const y of [8, 20, 40, 60]) expect(lum[y]!, `y=${y}`).toBeLessThan(pageBg - 4);
    expect(Math.abs(lum[11]! - lum[13]!)).toBeLessThan(10);
    writeEvidence("fixes/fix07-shadow.json", { look, luminanceBelowEdge: lum, pageBg });
    // The Shadow field states the reach, and a 3000px shadow is refused with that reach named.
    await openBuilder(page, "r3-shadow");
    await selectLayer(page, STYLED);
    const style = page.locator('[data-inspector-group="style"]');
    if ((await style.getAttribute("data-open")) === null) await style.locator("h3 button").click();
    await expect(page.locator("[data-shadow-reach]")).toContainText("96px");
    await page.locator('[data-style-field="boxShadow"] [data-style-text]').fill("0 0 0 3000px red");
    await expect(page.locator('[data-style-refused="boxShadow"]')).toContainText("at most 96px");
    await page.locator('[data-style-field="boxShadow"]').screenshot({ path: evidence("fixes/fix07-shadow-field.png") });
    expect(JSON.stringify((await draft(req, appId)).doc)).not.toContain("3000px");
  });

  test("Fix 3: a half-typed binding is held, a bound field empties and survives reload, Use a fixed value keeps the literal", async ({ page }) => {
    const req = page.request;
    const appId = await ensureApp(req, "r3-bind", "R3 bind");
    const id = "c_r3bindaaaa";
    await setNodes(req, appId, [{ id, type: "stat", name: "Disk", props: { value: 41.3, label: "Disk" }, slot: { x: 0, y: 0, w: 4, h: 14 } }]);
    await openBuilder(page, "r3-bind");
    await selectLayer(page, id);
    // Wave 2.7 (data ease spec 3.1): a data widget's per-field Live data sits under More settings.
    const more = page.locator('[data-more-settings-toggle="content"]');
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    await page.locator('[data-bind-button="unit"]').click();
    const field = page.locator('[data-binding-field="unit"] textarea');
    await expect(field).toBeVisible();
    await field.click();
    await page.keyboard.type("{", { delay: 30 });
    await page.waitForTimeout(1200);
    const afterBrace = await nodeProp(req, appId, id, "unit");
    expect(JSON.stringify(afterBrace)).not.toContain('"{"');
    await expect(page.locator('[data-binding-field="unit"] [data-binding-hold]')).toContainText("not finished");
    await page.keyboard.type("{ 'GB' }}", { delay: 30 });
    await expect.poll(() => nodeProp(req, appId, id, "unit"), { timeout: 6000 }).toEqual({ $bind: "{{ 'GB' }}" });
    await page.screenshot({ path: evidence("fixes/fix03-bound.png") });
    // Empty it: an empty binding is saved, and a reload keeps it empty.
    await field.fill("");
    await expect.poll(() => nodeProp(req, appId, id, "unit"), { timeout: 6000 }).toEqual({ $bind: "" });
    await page.reload();
    await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
    await selectLayer(page, id);
    await expect(page.locator('[data-binding-field="unit"] textarea')).toHaveValue("");
    // Bind a literal, then Use a fixed value: the field becomes a plain input with that literal, also after reload.
    await page.locator('[data-binding-field="unit"] textarea').fill("{{ 'TB' }}");
    await expect.poll(() => nodeProp(req, appId, id, "unit"), { timeout: 6000 }).toEqual({ $bind: "{{ 'TB' }}" });
    await page.locator('[data-unbind="unit"]').click();
    await expect.poll(() => nodeProp(req, appId, id, "unit"), { timeout: 6000 }).toBe("TB");
    await expect(page.locator('[data-binding-field="unit"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
    await selectLayer(page, id);
    await expect(page.locator('[data-binding-field="unit"]')).toHaveCount(0);
    await expect(page.locator(`[data-node="${id}"] [data-slot="unit"]`)).toHaveText("TB");
    // A binding that reads data has no literal: unbinding empties the field (and the prop is removed).
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    await page.locator('[data-bind-button="unit"]').click();
    await page.locator('[data-binding-field="unit"] textarea').fill("{{ $now }}");
    await expect.poll(() => nodeProp(req, appId, id, "unit"), { timeout: 6000 }).toEqual({ $bind: "{{ $now }}" });
    await page.locator('[data-unbind="unit"]').click();
    await expect.poll(() => nodeProp(req, appId, id, "unit"), { timeout: 6000 }).toBe("(unset)");
    await page.screenshot({ path: evidence("fixes/fix03-unbound.png") });
    writeEvidence("fixes/fix03-bound-fields.json", { halfTypedBraceSaved: false, emptiedSaves: { $bind: "" }, survivesReload: true, useFixedValueKeeps: "TB", dataBindingUnbindsTo: "(unset)" });
  });

  test("Fix 10: a plain field holding {{ ... }} offers to bind it", async ({ page }) => {
    const req = page.request;
    const appId = await ensureApp(req, "r3-bindit", "R3 bind it");
    const id = "c_r3bindtaaa";
    await setNodes(req, appId, [{ id, type: "stat", name: "Disk", props: { value: 41.3, label: "Disk" }, slot: { x: 0, y: 0, w: 4, h: 14 } }]);
    await openBuilder(page, "r3-bindit");
    await selectLayer(page, id);
    const unit = page.locator('[data-inspector] label', { hasText: /^Unit$/ });
    const input = page.locator(`#${await unit.getAttribute("for")}`);
    await input.fill("{{ 'GB' }}");
    // Wave 2.6 (builder ease 3.2): "binding" reads "live data" on screen.
    await expect(page.locator('[data-looks-bound="unit"]')).toContainText("This looks like live data.");
    await page.locator('[data-looks-bound="unit"]').screenshot({ path: evidence("fixes/fix10-looks-bound.png") });
    await page.locator('[data-bind-it="unit"]').click();
    await expect.poll(() => nodeProp(req, appId, id, "unit"), { timeout: 6000 }).toEqual({ $bind: "{{ 'GB' }}" });
    await expect(page.locator('[data-binding-field="unit"] textarea')).toHaveValue("{{ 'GB' }}");
    await expect(page.locator(`[data-node="${id}"] [data-slot="unit"]`)).toHaveText("GB");
  });

  test("Fix 4 and 12: a stat inside a card is a well; only the card has a bar; the library card shows the saved 42 and says sample, not live", async ({ page }) => {
    const req = page.request;
    const appId = await ensureApp(req, "r3-nest", "R3 nest");
    const card = { id: "c_r3cardaaaa", type: "card", name: "Server card", props: { title: "pve1" }, children: [{ id: "c_r3cpuaaaaa", type: "stat", props: { label: "CPU", data: 42 } }, { id: "c_r3memaaaaa", type: "stat", props: { label: "Memory", value: 61, unit: "%" } }], slot: { x: 0, y: 0, w: 6, h: 30 } };
    await setNodes(req, appId, [card, { id: "c_r3soloaaaa", type: "stat", props: { label: "Solo", value: 3 }, slot: { x: 6, y: 0, w: 4, h: 14 } }]);
    await publish(req, appId);
    await page.goto("/a/r3-nest");
    await expect(page.locator('[data-node="c_r3cpuaaaaa"]')).toBeVisible({ timeout: 15_000 });
    const looks = await page.evaluate(() => {
      const css = (sel: string) => {
        const el = document.querySelector(sel)!;
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, border: s.borderTopColor, shadow: s.boxShadow };
      };
      const visibleBars = [...document.querySelectorAll(".atr-titlebar")].filter((b) => getComputedStyle(b).display !== "none").map((b) => (b as HTMLElement).innerText.replace(/\s+/g, " ").trim());
      return { inner: css('[data-node="c_r3cpuaaaaa"] [data-slot="root"]'), card: css('[data-node="c_r3cardaaaa"] > [data-slot="root"]'), solo: css('[data-node="c_r3soloaaaa"] [data-slot="root"]'), visibleBars, value: (document.querySelector('[data-node="c_r3cpuaaaaa"] [data-slot="value"]') as HTMLElement).innerText };
    });
    expect(looks.inner.shadow).toBe("none");
    expect(looks.inner.border).toBe("rgba(0, 0, 0, 0)");
    expect(looks.inner.bg).not.toBe(looks.card.bg);
    expect(looks.card.shadow).not.toBe("none");
    expect(looks.visibleBars).toHaveLength(2); // the card's and the solo stat's; none for the nested stats
    expect(looks.value).toBe("42");
    await page.locator('[data-node="c_r3cardaaaa"]').screenshot({ path: evidence("fixes/fix04-card-wells.png") });
    // The library card for the same component: one bar (the card's window), value 42, never "live".
    const nm = `r3 server card ${Date.now().toString(36)}`;
    const r = await req.post("/api/library", { data: { name: nm, node: { ...card, slot: undefined }, sources: [], controls: [] }, headers: H });
    expect(r.ok(), await r.text()).toBe(true);
    const comp = (await r.json()).component as { id: string };
    const r2 = await req.post("/api/library", { data: { name: `${nm} cpu`, node: { id: "c_r3cpstataa", type: "stat", props: { label: "CPU", data: { $bind: "{{ cpu }}" } } }, sources: ["cpu"], controls: [] }, headers: H });
    const withData = (await r2.json()).component as { id: string };
    await page.goto("/library");
    const lc = page.locator(`[data-library-card="${comp.id}"]`);
    await expect(lc).toBeVisible();
    const lib = await lc.evaluate((el) => ({
      bars: [...el.querySelectorAll("[data-titlebar], .atr-titlebar")].filter((b) => getComputedStyle(b).display !== "none").length,
      status: (el.querySelector("[data-window-status]") as HTMLElement | null)?.innerText ?? "",
      text: (el.querySelector("[data-library-preview]") as HTMLElement).innerText,
      shadows: [...el.querySelectorAll("[data-library-preview] .canvas-surface")].map((s) => getComputedStyle(s).boxShadow),
    }));
    expect(lib.bars).toBe(1);
    expect(lib.text).toContain("42");
    expect(lib.status).not.toMatch(/live/);
    expect(lib.shadows.every((s) => s === "none")).toBe(true);
    await lc.screenshot({ path: evidence("fixes/fix04-library-card.png") });
    const sampleStatus = await page.locator(`[data-library-card="${withData.id}"] [data-window-status]`).innerText();
    expect(sampleStatus).toMatch(/^sample · v1$/);
    expect(await page.locator(`[data-library-card="${withData.id}"]`).innerText()).not.toMatch(/\blive\b/);
    await page.locator(`[data-library-card="${withData.id}"]`).screenshot({ path: evidence("fixes/fix12-library-sample.png") });
    writeEvidence("fixes/fix04-12-nesting.json", { viewer: looks, library: lib, sampleStatus });
  });

  test("Fix 5: the Homelab no-data states line up on the window padding, and Connect it is an accent link", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const req = page.request;
    await ensureApp(req, "r3-homelab", "R3 homelab", "homelab");
    await openBuilder(page, "r3-homelab");
    await expect(page.locator("[data-state-unmapped]").first()).toBeVisible({ timeout: 15_000 });
    const states = await page.evaluate(() =>
      [...document.querySelectorAll("[data-state-unmapped]")].map((s) => {
        const win = s.closest('[data-slot="root"]')!.getBoundingClientRect();
        const title = s.querySelector(".atr-state-title")!.getBoundingClientRect();
        const link = s.querySelector("a")!;
        const ls = getComputedStyle(link);
        const bar = s.closest('[data-slot="root"]')!.querySelector("[data-node-titlebar]")!.getBoundingClientRect();
        return { type: s.closest("[data-node]")!.getAttribute("data-type"), inset: Math.round(title.left - win.left), drop: Math.round(title.top - (bar.height ? bar.bottom : win.top)), href: link.getAttribute("href"), text: link.innerText, color: ls.color, underline: ls.textDecorationLine, accentInk: getComputedStyle(s.closest("[data-atrium-canvas]")!).getPropertyValue("--theme-accent-ink").trim() };
      }),
    );
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states.some((s) => s.type === "table")).toBe(true);
    const insets = new Set(states.map((s) => s.inset));
    expect([...insets], JSON.stringify(states)).toHaveLength(1);
    expect([...insets][0]).toBeGreaterThanOrEqual(16);
    expect(new Set(states.map((s) => s.drop)).size, JSON.stringify(states)).toBe(1);
    for (const s of states) {
      expect(s.text).toMatch(/^Connect it\s*→$/);
      expect(s.underline).toContain("underline");
      expect(s.href).toMatch(/^\/integrations\//);
    }
    await page.screenshot({ path: evidence("fixes/fix05-homelab-states.png") });
    writeEvidence("fixes/fix05-states.json", { states });
  });

  test("Fix 6: a new chart lands landscape with a three-series sample, real-size axis text and the legend in its title bar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const req = page.request;
    const appId = await ensureApp(req, "r3-chart", "R3 chart");
    await setNodes(req, appId, []);
    await openBuilder(page, "r3-chart");
    await page.locator('[data-left-tab="insert"]').click();
    const before = JSON.stringify((await draft(req, appId)).doc);
    await page.locator('[data-insert-item="chart"]').first().click();
    // Wave 2.6: a new data widget opens the data picker; leave it on sample values.
    const picker = page.locator("[data-data-picker]");
    await picker.waitFor({ state: "visible", timeout: 2500 }).then(async () => { await page.locator("[data-pick-skip], [data-pick-cancel]").first().click(); await picker.waitFor({ state: "detached" }); }, () => undefined);
    await expect.poll(async () => JSON.stringify((await draft(req, appId)).doc) !== before, { timeout: 6000 }).toBe(true);
    const d = await draft(req, appId);
    const chart = d.doc.pages[0]!.root.children!.find((c) => c.type === "chart") as unknown as { id: string; slot: { w: number; h: number }; props: { height: number } };
    expect(chart.slot).toMatchObject({ w: 6, h: 35 }); // exact boxes (2026-10-19): 35 rows fit the chart
    const n = page.locator(`[data-node="${chart.id}"]`);
    await expect(n.locator("[data-titlebar-legend]")).toBeVisible();
    await page.waitForTimeout(400);
    const geo = await n.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const svg = el.querySelector("svg[data-chart-width]")!;
      const fig = el.querySelector("figure")!.getBoundingClientRect();
      const ticks = [...svg.querySelectorAll(".atr-axis text")].map((t) => {
        const b = (t as SVGTextElement).getBoundingClientRect();
        return { text: t.textContent, w: Math.round(b.width), h: Math.round(b.height) };
      });
      return { w: Math.round(r.width), h: Math.round(r.height), svgWidth: Number(svg.getAttribute("data-chart-width")), figWidth: Math.round(fig.width), ticks, legend: [...el.querySelectorAll("[data-titlebar-legend] li")].map((li) => (li as HTMLElement).innerText), bodyLegendShown: getComputedStyle(el.querySelector(".atr-legend")!).display !== "none" };
    });
    expect(geo.w).toBeGreaterThan(geo.h);
    expect(Math.abs(geo.svgWidth - geo.figWidth)).toBeLessThanOrEqual(2);
    for (const t of geo.ticks) expect(t.w, t.text ?? "").toBeGreaterThanOrEqual((t.text ?? "").length * 4);
    expect(geo.legend).toEqual(["node-1", "node-2", "node-3"]);
    expect(geo.bodyLegendShown).toBe(false);
    await n.screenshot({ path: evidence("fixes/fix06-new-chart.png") });
    writeEvidence("fixes/fix06-chart.json", { slot: chart.slot, height: chart.props.height, geo });
  });

  test("Fix 8: unknown /library addresses show the single-shell missing room titled Not found", async ({ page }) => {
    const out: Record<string, unknown> = {};
    const paths = ["/library/nope", "/library/a/b"];
    if (process.env.ATRIUM_E2E_NO_GALLERY === "1") paths.unshift("/library/gallery");
    for (const p of paths) {
      await page.goto(p);
      await expect(page.locator("h1", { hasText: "This room does not exist." })).toBeVisible({ timeout: 15_000 });
      const look = await page.evaluate(() => ({ topBars: document.querySelectorAll('[data-shell="topbar"]').length, skyBands: document.querySelectorAll('[data-shell="skyband"]').length, emptyRooms: document.querySelectorAll("[data-empty-room]").length, coming: document.body.innerText.includes("coming in a later update"), goToApps: !!document.querySelector("[data-go-home]"), title: document.title, gallery: !!document.querySelector("[data-gallery-scene], [data-gallery-canvas], [data-gallery-inspector]") }));
      expect(look.emptyRooms, p).toBe(1);
      expect(look.coming, p).toBe(false);
      expect(look.goToApps, p).toBe(true);
      expect(look.title, p).toContain("Not found");
      expect(look.gallery, p).toBe(false);
      expect(look.topBars, p).toBe(1);
      expect(look.skyBands, p).toBeLessThanOrEqual(1);
      await page.screenshot({ path: evidence(`fixes/fix08-${p.replace(/\//g, "_")}.png`) });
      out[p] = look;
    }
    writeEvidence(`fixes/fix08-not-found${process.env.ATRIUM_E2E_NO_GALLERY === "1" ? "-nogallery" : ""}.json`, out);
  });

  test("Fix 11: a re-run marks earlier console lines as an earlier run", async ({ page }) => {
    const req = page.request;
    const appId = await ensureApp(req, "r3-console", "R3 console");
    const id = "c_r3htmlaaaa";
    await setNodes(req, appId, [{ id, type: "html", name: "Console block", props: { html: "<p id='out'>x</p>", css: "", js: "", data: {}, controls: [], height: 100 }, slot: { x: 0, y: 0, w: 6, h: 16 } }]);
    await openBuilder(page, "r3-console");
    await selectLayer(page, id);
    await page.locator("[data-edit-code]").click();
    await page.locator('[data-code-tab="js"]').click();
    await page.locator('[data-code-editor="js"]').fill("console.info('half typed'); (");
    await expect(page.locator('[data-console] [data-log-level="error"]').first()).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-code-editor="js"]').fill("console.info('r3 block ran')");
    await expect(page.locator('[data-console] li:not([data-log-stale])', { hasText: "r3 block ran" })).toBeVisible({ timeout: 10_000 });
    const lines = await page.locator("[data-console] li").evaluateAll((ls) => ls.map((l) => ({ text: (l as HTMLElement).innerText, stale: l.hasAttribute("data-log-stale"), level: l.getAttribute("data-log-level") })));
    expect(lines.filter((l) => l.level === "error").every((l) => l.stale)).toBe(true);
    await page.locator("[data-code-window]").screenshot({ path: evidence("fixes/fix11-console.png") });
    writeEvidence("fixes/fix11-console.json", { lines });
  });

  test("Fix 13: switch rows use the mono label at the field's left edge, in sentence case", async ({ page }) => {
    const req = page.request;
    const appId = await ensureApp(req, "r3-switch", "R3 switch");
    const id = "c_r3swtchaaa";
    await setNodes(req, appId, [{ id, type: "stat", props: { value: 1, label: "One" }, overrideTheme: true, slot: { x: 0, y: 0, w: 4, h: 14 } }]);
    await openBuilder(page, "r3-switch");
    await selectLayer(page, id);
    const style = page.locator('[data-inspector-group="style"]');
    if ((await style.getAttribute("data-open")) === null) await style.locator("h3 button").click();
    const data = page.locator('[data-inspector-group="data"]');
    if ((await data.getAttribute("data-open")) === null) await data.locator("h3 button").click();
    // Wave 2.6: "Show updated" and "Phones only" sit under More settings and More style.
    for (const t of await page.locator("[data-more-settings-toggle]").all()) if ((await t.isVisible()) && (await t.getAttribute("aria-expanded")) === "false") await t.click();
    const rows = await page.locator("[data-switch-label]").evaluateAll((ls) => ls.map((l) => {
      const s = getComputedStyle(l);
      const field = l.closest("[data-inspector-group]")!.querySelector("label, [data-style-field] > span, legend")!;
      return { text: (l as HTMLElement).innerText, font: s.fontFamily, left: Math.round(l.getBoundingClientRect().left), fieldLeft: Math.round(field.getBoundingClientRect().left) };
    }));
    const texts = rows.map((r) => r.text);
    for (const t of ["Show when it was updated", "Customise the look", "Phones only"]) expect(texts).toContain(t);
    for (const r of rows) {
      expect(r.font, r.text).toMatch(/mono/i);
      expect(Math.abs(r.left - r.fieldLeft), r.text).toBeLessThanOrEqual(1);
      expect(r.text).not.toMatch(/ [A-Z]/);
    }
    await page.locator('[data-inspector-group="style"]').screenshot({ path: evidence("fixes/fix13-switch-rows.png") });
    // A click on the label toggles the switch.
    await page.locator("[data-switch-label]", { hasText: "Phones only" }).click();
    await expect(page.locator("[data-switch-field]", { hasText: "Phones only" }).locator('[role="switch"]')).toHaveAttribute("aria-checked", "true");
    writeEvidence("fixes/fix13-switch-rows.json", { rows });
  });

  test("Fix 14 and 15: a wrong-shape binding explains itself; status words stay inline", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const req = page.request;
    const appId = await ensureApp(req, "r3-shape", "R3 shape");
    await setNodes(req, appId, [
      { id: "c_r3shapeaaa", type: "status", props: { data: { $bind: "{{ 42 }}" } }, slot: { x: 0, y: 0, w: 4, h: 16 } },
      { id: "c_r3statsaaa", type: "status", props: {}, slot: { x: 4, y: 0, w: 3, h: 16 } },
    ]);
    await openBuilder(page, "r3-shape");
    const mm = page.locator('[data-node="c_r3shapeaaa"] [data-shape-mismatch]');
    await expect(mm).toContainText("This data is a single value; Status needs a status list. Try Stat.");
    await expect(page.locator('[data-node="c_r3shapeaaa"] [data-node-titlebar]')).toHaveAttribute("data-titlebar-status", "check data");
    await page.locator('[data-node="c_r3shapeaaa"]').screenshot({ path: evidence("fixes/fix14-shape-mismatch.png") });
    // The sample status rows (narrow, 3 columns): every word sits on its label's line, at the right.
    const rows = await page.locator('[data-node="c_r3statsaaa"] .atr-status li').evaluateAll((ls) => ls.map((li) => {
      const label = li.querySelector('[data-slot="label"]')!.getBoundingClientRect();
      const word = li.querySelector(".atr-state-word")!.getBoundingClientRect();
      const box = li.getBoundingClientRect();
      return { word: (li.querySelector(".atr-state-word") as HTMLElement).innerText, sameLine: Math.abs(label.top + label.height / 2 - (word.top + word.height / 2)) < 4, atRight: Math.round(box.right - word.right) <= 1 };
    }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r, JSON.stringify(r)).toMatchObject({ sameLine: true, atRight: true });
    expect(rows.map((r) => r.word)).toContain("warning");
    await page.locator('[data-node="c_r3statsaaa"]').screenshot({ path: evidence("fixes/fix15-status-inline.png") });
    writeEvidence("fixes/fix14-15.json", { mismatch: await mm.innerText(), rows });
  });
});

test.describe("mobile", () => {
  test.beforeEach(async ({ context, page }, info) => {
    test.skip(info.project.name !== "mobile", "mobile only");
    await signIn(context, page.request);
  });

  test("Fix 5 (touch): Connect it is at least 44px tall; the no-data states keep the phone padding", async ({ page }) => {
    const req = page.request;
    await ensureApp(req, "r3-homelab-m", "R3 homelab mobile", "homelab");
    await page.goto("/build/r3-homelab-m");
    await expect(page.locator("[data-state-unmapped] a").first()).toBeVisible({ timeout: 20_000 });
    const links = await page.locator("[data-state-unmapped] a").evaluateAll((ls) => ls.map((l) => {
      const r = l.getBoundingClientRect();
      const s = l.closest("[data-state-unmapped]")!;
      const win = s.closest('[data-slot="root"]')!.getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width), inset: Math.round(s.querySelector(".atr-state-title")!.getBoundingClientRect().left - win.left) };
    }));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.h).toBeGreaterThanOrEqual(44);
      expect(l.inset).toBeGreaterThanOrEqual(12);
    }
    await page.screenshot({ path: evidence("fixes/fix05-mobile.png") });
    writeEvidence("fixes/fix05-mobile.json", { links, overflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) });
  });

  test("Fixes 1 and 2 (phone): display: contents and position through var() steal nothing at 390px", async ({ page }) => {
    const req = page.request;
    const appId = await ensureApp(req, "r3-contain-m", "R3 contain mobile");
    const out: Record<string, unknown> = {};
    for (const name of ["display_contents_plain", "var_fixed_fallback", "contents_and_fixed"]) {
      await setNodes(req, appId, baseNodes(VARIANTS[name]!));
      await publish(req, appId, name);
      await page.goto("/a/r3-contain-m");
      await expect(page.locator(`[data-node="${PLAIN}"]`)).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      const p = await probe(page);
      out[name] = p;
      expect(p.stolen, name).toBe(0);
    }
    await page.screenshot({ path: evidence("fixes/containment/mobile-contents_and_fixed.png") });
    writeEvidence("fixes/fix01-02-mobile.json", out);
  });
});
