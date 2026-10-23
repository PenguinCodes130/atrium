// Final pass (operator decision 2026-10-19 after gauntlet w2-r3: a narrow scope cut, then accept). One
// viewer pass re-runs EVERY hostile node CSS variant so far: the round 2 critic's 24, the round 3 build's
// own bypasses, the round 3 critic's set (evidence/gauntlet/w2-r3/customisation/s2-containment.mjs) and the
// new forms for this pass (theme tokens through wrappers, siblings through wrappers, borders, layouts).
// For each it measures stolen clicks AND painted area outside the node's slot (pixel diff against a
// no-CSS baseline: outside the node when nothing moved, else the nav and every neighbour's own crop),
// sibling computed style, and page push. Then the worst variants in the builder, the inspector's refusals,
// and canvas word gaps on the Homelab template. Evidence: evidence/components/<round>/final/.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { evidence, signIn, withFrameFix, writeEvidence } from "./helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const H = { origin: `http://127.0.0.1:${Number(process.env.ATRIUM_E2E_PORT ?? 3114)}` };
type Node = { id: string; type: string; css?: string; style?: unknown; children?: Node[]; props?: Record<string, unknown> };
type Doc = { pages: { id: string; slug: string; root: Node }[] };

async function ensureApp(req: APIRequestContext, slug: string, name: string, template?: string): Promise<string> {
  const tiles = ((await (await req.get("/api/apps")).json()).tiles ?? []) as { app: { id: string; slug: string } }[];
  const hit = tiles.find((t) => t.app.slug === slug);
  if (hit) return hit.app.id;
  const r = await req.post("/api/apps", { data: { name, slug, ...(template ? { template } : {}) }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).app.id as string;
}
const draft = async (req: APIRequestContext, appId: string): Promise<{ rev: number; doc: Doc }> => (await req.get(`/api/apps/${appId}/draft`)).json();
async function ops(req: APIRequestContext, appId: string, list: unknown[]) {
  const d = await draft(req, appId);
  const r = await req.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: list }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
}
async function publish(req: APIRequestContext, appId: string, note = "components r4 final") {
  const review = await (await req.get(`/api/apps/${appId}/review`)).json();
  const r = await req.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note }, headers: H });
  expect(r.ok(), await r.text()).toBe(true);
  return review as { problems: { code: string; message: string }[] };
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
async function openGroup(page: Page, name: string) {
  const g = page.locator(`[data-inspector-group="${name}"]`);
  if ((await g.getAttribute("data-open")) === null) await g.locator("h3 button").click();
  return g;
}
const findNode = (n: Node, id: string): Node | undefined => (n.id === id ? n : (n.children ?? []).map((c) => findNode(c, id)).find(Boolean));

// ---------- the page under attack ----------

const STYLED = "c_r4styledaa"; // Style panel shadow 0 24px 48px (drawn by the node box, legitimately)
const PLAIN = "c_r4plainaaa";
const HOSTILE = "c_r4evilaaaa"; // most variants
const TOKEN = "c_r4tokenaaa"; // Style panel node-box shadow in a theme colour (token:accent)
const STACK = "c_r4stackaaa"; // horizontal stack: ATTACK then VICTIM
const ATTACK = "c_r4attackaa";
const VICTIM = "c_r4victimaa";
const SECTION = "c_r4sectionx";
const SECCHILD = "c_r4seckidaa";
const LAST = "c_r4lastaaaa";
const ROOT = "(page root)";
const CSS_TARGETS = [HOSTILE, TOKEN, STACK, ATTACK, SECTION];

const pageNodes = (): Node[] => [
  { id: STYLED, type: "stat", name: "Styled", props: { value: 3, label: "Styled" }, overrideTheme: true, style: { root: { background: "#ffffff", boxShadow: "0 24px 48px rgba(0,0,0,.55)" } }, slot: { x: 0, y: 0, w: 3, h: 14 } } as Node,
  { id: PLAIN, type: "stat", name: "Plain", props: { value: 7, label: "Plain" }, slot: { x: 3, y: 0, w: 3, h: 14 } } as Node,
  { id: HOSTILE, type: "stat", name: "Hostile", props: { value: 9, label: "Hostile" }, slot: { x: 6, y: 0, w: 3, h: 14 } } as Node,
  { id: TOKEN, type: "stat", name: "Token shadow", props: { value: 4, label: "Token" }, overrideTheme: true, style: { root: { boxShadow: "0 8px 16px token:accent" } }, slot: { x: 9, y: 0, w: 3, h: 14 } } as Node,
  { id: STACK, type: "stack", name: "Row", props: { direction: "horizontal", align: "stretch" }, slot: { x: 0, y: 18, w: 8, h: 16 }, children: [
    { id: ATTACK, type: "stat", props: { value: 1, label: "Attacker" } },
    { id: VICTIM, type: "stat", props: { value: 2, label: "Victim" } },
  ] } as Node,
  { id: SECTION, type: "section", name: "Section", props: { title: "Section" }, slot: { x: 8, y: 18, w: 4, h: 22 }, children: [{ id: SECCHILD, type: "stat", props: { value: 6, label: "In section" } }] } as Node,
  { id: LAST, type: "stat", name: "Last", props: { value: 5, label: "Last" }, slot: { x: 0, y: 44, w: 12, h: 14 } } as Node,
];

// ---------- every hostile variant ----------

const BIG = "position:absolute;inset:-2000px;background:rgba(255,0,0,.6);z-index:2147483647;";
const R1_HOSTILE = readFileSync(path.resolve(here, "../../../evidence/gauntlet/w2-r3/customisation/r1-probes/hostile-node.css"), "utf8");
type Variant = { target: string; css?: string; style?: Record<string, unknown>; set: "critic-r2" | "build-r3" | "critic-r3" | "final" };
const v = (set: Variant["set"], target: string, css: string): Variant => ({ target, css, set });
const VARIANTS: Record<string, Variant> = {
  // The round 2 critic's 24 (also in the round 3 critic's set).
  r1_star_absolute: v("critic-r2", HOSTILE, R1_HOSTILE),
  fixed_desc: v("critic-r2", HOSTILE, "* { position: fixed; inset: 0; background: rgba(255,0,0,.6); z-index: 2147483647; }"),
  sticky_desc: v("critic-r2", HOSTILE, "* { position: sticky; top: 0; height: 4000px; background: rgba(255,0,0,.6); }"),
  transform_desc: v("critic-r2", HOSTILE, "[data-slot] { transform: scale(40); background: rgba(255,0,0,.6); }"),
  filter_shadow_desc: v("critic-r2", HOSTILE, "[data-slot] { filter: drop-shadow(0 0 0 red) drop-shadow(400px 400px 0 red); box-shadow: 0 0 0 3000px rgba(255,0,0,.6); outline: 3000px solid rgba(255,0,0,.5); }"),
  pseudo_scope: v("critic-r2", HOSTILE, `:scope::before { content: ""; ${BIG} } :scope::after { content: ""; ${BIG} }`),
  scope_transform: v("critic-r2", HOSTILE, ":scope { transform: scale(30); background: red; }"),
  scope_not_transform: v("critic-r2", HOSTILE, ":scope:not(.zz) { scale: 30; z-index: 99; box-shadow: 0 0 0 3000px red; }"),
  media_scope_transform: v("critic-r2", HOSTILE, "@media (min-width: 1px) { :scope { transform: scale(30); outline: 3000px solid red; } }"),
  guard_override: v("critic-r2", HOSTILE, `:scope { overflow: visible !important; isolation: auto !important; position: static !important; contain: none !important; } * { ${BIG} }`),
  all_revert: v("critic-r2", HOSTILE, `:scope { all: revert-layer !important; } * { ${BIG} }`),
  display_contents: v("critic-r2", HOSTILE, `:scope { display: contents !important; } * { ${BIG} }`),
  keyframes_scale: v("critic-r2", HOSTILE, ":scope { animation: cuatk 1ms forwards; } @keyframes cuatk { to { scale: 30; z-index: 2147483647; } }"),
  keyframes_shadow: v("critic-r2", HOSTILE, ":scope { animation: cush 1ms forwards; } @keyframes cush { to { box-shadow: 0 0 0 3000px rgba(255,0,0,.6); outline: 3000px solid rgba(255,0,0,.5); margin: -300px; } }"),
  scope_height: v("critic-r2", HOSTILE, ":scope { height: 4000px; min-height: 4000px; background: rgba(255,0,0,.6); }"),
  scope_padding: v("critic-r2", HOSTILE, ":scope { padding-bottom: 3000px; background: rgba(255,0,0,.6); }"),
  scope_grid: v("critic-r2", HOSTILE, ":scope { grid-row: 1 / 60; grid-column: 1 / -1; order: -1; background: rgba(255,0,0,.6); }"),
  scope_blend: v("critic-r2", HOSTILE, ":scope { mix-blend-mode: difference; backdrop-filter: invert(1); }"),
  display_inline: v("critic-r2", HOSTILE, `:scope { display: inline; } * { ${BIG} }`),
  display_table_row: v("critic-r2", HOSTILE, `:scope { display: table-row; } * { ${BIG} }`),
  display_ruby: v("critic-r2", HOSTILE, `:scope { display: ruby-text; } * { ${BIG} }`),
  display_contents_plain: v("critic-r2", HOSTILE, ":scope { display: contents; } [data-slot] { position: absolute; inset: -3000px; background: rgba(255,0,0,.5); z-index: 5; }"),
  var_fixed: v("critic-r2", HOSTILE, "[data-slot] { --theme-cu-pos: fixed; position: var(--theme-cu-pos); inset: 0; background: rgba(255,0,0,.55); z-index: 2147483647; }"),
  var_fixed_fallback: v("critic-r2", HOSTILE, "[data-slot] { position: var(--user-nope, fixed); inset: 0; background: rgba(255,0,0,.55); z-index: 2147483647; }"),
  // The round 3 build's own bypass attempts.
  env_fixed: v("build-r3", HOSTILE, "[data-slot] { position: env(atrium-nope, fixed); inset: 0; background: rgba(255,0,0,.55); z-index: 2147483647; }"),
  var_display_contents: v("build-r3", HOSTILE, ":scope { --user-d: contents; display: var(--user-d); } [data-slot] { position: absolute; inset: -3000px; background: rgba(255,0,0,.5); z-index: 5; }"),
  var_display_fallback: v("build-r3", HOSTILE, ":scope { display: var(--user-nope, contents) !important; } [data-slot] { position: var(--user-p, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 5; }"),
  contents_and_fixed: v("build-r3", HOSTILE, ":scope { display: contents; } [data-slot] { position: var(--user-p, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 2147483647; }"),
  shell_keyframes_spin: v("build-r3", HOSTILE, ":scope { animation: atr-spin 2s linear infinite; background: red; }"),
  shell_keyframes_root: v("build-r3", HOSTILE, ":scope { animation: atr-anim-rise 60s linear infinite reverse; scale: 30; }"),
  var_height: v("build-r3", HOSTILE, ":scope { --user-h: 4000px; height: var(--user-h); min-height: var(--user-h); block-size: var(--user-h); }"),
  var_padding: v("build-r3", HOSTILE, ":scope { --user-p: 3000px; padding-block-end: var(--user-p); padding: 0 0 var(--user-p); }"),
  desc_runaway: v("build-r3", HOSTILE, "[data-slot] { min-height: 6000px; padding-bottom: 4000px; background: rgba(255,0,0,.4); }"),
  writing_mode: v("build-r3", HOSTILE, ":scope { writing-mode: vertical-rl; height: 100%; } * { position: absolute; inset: -2000px; background: rgba(255,0,0,.5); }"),
  zoom_root: v("build-r3", HOSTILE, ":scope { zoom: 30; } [data-slot] { zoom: 30; background: rgba(255,0,0,.5); }"),
  margin_negative: v("build-r3", HOSTILE, ":scope { margin: -400px; } [data-slot] { margin: -400px; background: rgba(255,0,0,.5); }"),
  inset_var: v("build-r3", HOSTILE, ":scope { inset: var(--user-i, -500px); position: var(--user-q, relative); } [data-slot] { position: var(--user-r, absolute); inset: var(--user-i, -3000px); background: rgba(255,0,0,.5); z-index: 9; }"),
  container_query_fixed: v("build-r3", HOSTILE, "@container (min-width: 1px) { [data-slot] { position: var(--user-x, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 99; } }"),
  supports_fixed: v("build-r3", HOSTILE, "@supports (position: fixed) { [data-slot] { position: var(--user-x, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 99; } }"),
  interactivity_inert: v("build-r3", HOSTILE, "[data-slot] { interactivity: inert; -webkit-user-modify: read-write; }"),
  contain_none_var: v("build-r3", HOSTILE, ":scope { contain: var(--user-c, none) !important; overflow: var(--user-o, visible) !important; } [data-slot] { position: var(--user-x, fixed); inset: 0; background: rgba(255,0,0,.5); z-index: 99; }"),
  // The round 3 critic's 31 new ones (s2-containment.mjs).
  theme_shadow_var: v("critic-r3", HOSTILE, ":scope { --theme-shadow: 0 0 0 3000px rgba(255,0,0,.6); }"),
  theme_shadow_var_offset: v("critic-r3", HOSTILE, ":scope { --theme-shadow: -700px -300px 0 400px rgba(255,0,0,.85); --theme-radius: 0px; }"),
  border_huge: v("critic-r3", HOSTILE, ":scope { border-bottom: 3000px solid rgba(255,0,0,.6); }"),
  border_contentbox: v("critic-r3", HOSTILE, ":scope { box-sizing: content-box; border-bottom: 5000px solid rgba(255,0,0,.6); }"),
  container_display_contents: v("critic-r3", HOSTILE, `@container (min-width: 0px) { :scope { display: contents; } } [data-slot] { ${BIG} }`),
  supports_translate: v("critic-r3", HOSTILE, "@supports (display: block) { :scope { translate: 600px 0; rotate: 45deg; } }"),
  var_translate_root: v("critic-r3", HOSTILE, ":scope { --user-t: 600px 0; translate: var(--user-t); --user-d: contents; display: var(--user-d) !important; }"),
  layer_wrap: v("critic-r3", HOSTILE, `@layer x { * { ${BIG} } }`),
  scope_at: v("critic-r3", HOSTILE, `@scope (.atr-render-root) { * { ${BIG} } }`),
  has_sel: v("critic-r3", HOSTILE, `[data-slot]:has(*) { ${BIG} }`),
  where_scope: v("critic-r3", HOSTILE, `:where(:scope) * { ${BIG} }`),
  clip_mask_root: v("critic-r3", HOSTILE, `:scope { clip-path: inset(-3000px); -webkit-mask-box-image: linear-gradient(red,red) 1; -webkit-mask-box-image-outset: 3000px; } [data-slot] { ${BIG} }`),
  reflect_desc: v("critic-r3", HOSTILE, "[data-slot] { -webkit-box-reflect: right 0; background: red; }"),
  backdrop_desc: v("critic-r3", HOSTILE, '[data-slot]::after { content: ""; position: absolute; inset: -3000px; backdrop-filter: invert(1); }'),
  scroll_timeline: v("critic-r3", HOSTILE, "[data-slot] { animation: cus linear both; animation-timeline: scroll(root); background: red; } @keyframes cus { from { translate: -3000px 0; scale: 40; } to { translate: 3000px 0; } }"),
  view_timeline: v("critic-r3", HOSTILE, "[data-slot] { animation: cuv linear both; animation-timeline: view(); background: red; } @keyframes cuv { from { scale: 40; } to { scale: 40; } }"),
  position_area: v("critic-r3", HOSTILE, "[data-slot] { position: absolute; position-area: span-all; inset: -3000px; background: rgba(255,0,0,.6); }"),
  content_visibility: v("critic-r3", HOSTILE, ":scope { content-visibility: auto; contain-intrinsic-size: auto 20000px; }"),
  font_size_root: v("critic-r3", HOSTILE, ":scope { font-size: 400px; }"),
  after_runaway: v("critic-r3", HOSTILE, ':scope::after { content: ""; display: block; height: 20000px; background: rgba(255,0,0,.3); }'),
  border_image_desc: v("critic-r3", HOSTILE, "[data-slot] { border: 10px solid; border-image: linear-gradient(red,red) 1; border-image-outset: 3000px; }"),
  outline_offset_desc: v("critic-r3", HOSTILE, "[data-slot] { outline: 20px solid red; outline-offset: 2000px; }"),
  css_wide: v("critic-r3", HOSTILE, `:scope { display: revert-layer !important; position: revert-layer !important; contain: revert !important; overflow: unset !important; } [data-slot] { ${BIG} }`),
  all_unset: v("critic-r3", HOSTILE, `:scope { all: unset !important; } [data-slot] { ${BIG} }`),
  comment_fixed: v("critic-r3", HOSTILE, "[data-slot] { Position: /*x*/ FIXED; inset: 0; background: rgba(255,0,0,.55); z-index: 99; }"),
  sib_not: v("critic-r3", ATTACK, ":scope:not(.zz) ~ * { opacity: .05; translate: 0 -2000px; scale: 3; filter: blur(8px); }"),
  sib_plus: v("critic-r3", ATTACK, ":scope:is(*) + * { visibility: hidden; }"),
  sib_where: v("critic-r3", ATTACK, ":scope:where(.atr-node) ~ .atr-node [data-slot] { color: red; background: red; }"),
  sib_cover: v("critic-r3", ATTACK, ":scope:not(.zz) ~ * { pointer-events: none; } :scope:not(.zz) ~ * [data-slot] { pointer-events: none; }"),
  section_runaway: v("critic-r3", SECTION, ':scope::after { content: ""; display: block; height: 20000px; background: rgba(255,0,0,.3); }'),
  section_body_runaway: v("critic-r3", SECTION, ".atr-section-body { min-height: 20000px; }"),
  // New for this pass: theme tokens through wrappers and through a Style panel token shadow.
  theme_shadow_media: v("final", HOSTILE, "@media (min-width: 1px) { :scope:not(.q) { --theme-shadow: 0 0 0 3000px rgba(255,0,0,.6) } }"),
  theme_shadow_supports_container: v("final", HOSTILE, "@supports (display: block) { @container (min-width: 0px) { :scope { --THEME-SHADOW: 0 0 0 3000px rgba(255,0,0,.6) !important } } }"),
  theme_shadow_desc: v("final", HOSTILE, "[data-slot] { --theme-shadow: 0 0 0 3000px rgba(255,0,0,.6); box-shadow: var(--theme-shadow); }"),
  theme_accent_inject: v("final", TOKEN, ":scope { --theme-accent: rgba(255,0,0,.6), 0 0 0 3000px rgba(255,0,0,.6); }"),
  theme_accent_inject_media: v("final", TOKEN, "@media (min-width: 1px) { :scope { --theme-accent: red, -900px 0 0 800px rgba(255,0,0,.8) } }"),
  user_var_shadow: v("final", HOSTILE, ":scope { --user-s: 0 0 0 3000px red; box-shadow: var(--user-s); outline: var(--user-s); }"),
  // Siblings through every wrapper.
  sib_media: v("final", ATTACK, "@media (min-width: 1px) { :scope:is(*) ~ * { visibility: hidden } }"),
  sib_supports_container: v("final", ATTACK, "@supports (display: block) { @container (min-width: 0px) { :scope:not(.q) + * { opacity: 0 } } }"),
  sib_upper: v("final", ATTACK, ":SCOPE:WHERE(*) ~ * { visibility: hidden }"),
  sib_attr_string: v("final", ATTACK, ':scope[data-type="stat"] ~ * { visibility: hidden } :scope[title="a ~ b"] + * { visibility: hidden }'),
  sib_nested: v("final", ATTACK, ":scope { & ~ * { visibility: hidden } }"),
  sib_layer: v("final", ATTACK, "@layer q { :scope:is(*) ~ * { visibility: hidden } }"),
  sib_scope_at: v("final", ATTACK, "@scope ([data-node]) { :scope ~ * { visibility: hidden } }"),
  sib_is_scope: v("final", ATTACK, ":is(:scope) ~ * { visibility: hidden } :where(:scope:not(.x)) + * { visibility: hidden }"),
  sib_has: v("final", ATTACK, ":scope:has(~ *) { opacity: 0 } :scope ~ * { opacity: 0 }"),
  sib_list: v("final", ATTACK, ".x, :scope:not(.y) ~ *, :scope:nth-child(1)~* { visibility: hidden }"),
  // Borders on the node box.
  border_var: v("final", HOSTILE, ":scope { --user-b: 3000px; border-bottom: var(--user-b) solid red; }"),
  border_logical: v("final", HOSTILE, ":scope { border-block-end: 3000px solid red; }"),
  border_webkit_after: v("final", HOSTILE, ":scope { -webkit-border-after: 3000px solid red; }"),
  border_media_width: v("final", HOSTILE, "@media (min-width: 1px) { :scope:not(.x) { border-width: 0 0 3000px; border-style: solid; box-sizing: content-box !important } }"),
  // Layouts: their CSS is ignored; their Style panel sizes are bounded.
  stack_runaway: v("final", STACK, ':scope::after { content: ""; display: block; height: 20000px } [data-slot] { min-height: 20000px }'),
  stack_theme_shadow: v("final", STACK, ":scope { --theme-shadow: 0 0 0 3000px red } [data-slot] { --theme-shadow: 0 0 0 3000px red }"),
  root_grid_runaway: v("final", ROOT, ':scope::after { content: ""; display: block; height: 20000px } .atr-grid, [data-slot] { min-height: 20000px }'),
  section_style_panel: { target: SECTION, set: "final", style: { root: { minHeight: "20000px", padding: "0 0 9000px", margin: "0 0 5000px", borderWidth: "900px" }, title: { fontSize: "3000px", lineHeight: "9000px" } } },
};

const CAP = Math.max(1.5 * 900, 1200);
const LAYOUT_TARGETS = new Set([STACK, SECTION, ROOT]);

/** Positions, hits and computed styles in the live page. */
async function probe(page: Page, target: string, rootId: string, builder = false) {
  return page.evaluate(
    ({ target, rootId, builder, victim }) => {
      const who = (el: Element | null): string => {
        if (!el) return "none";
        const n = el.closest("[data-node]")?.getAttribute("data-node");
        if (n && n !== rootId) return n;
        if (el.closest("[data-canvas-nav], nav, [data-builder-bar], header, aside, [data-left-panel], [data-inspector]")) return "chrome";
        return el.closest("[data-atrium-canvas]") ? "canvas" : el.tagName.toLowerCase();
      };
      const rects: Record<string, number[]> = {};
      const centres: Record<string, string> = {};
      for (const n of document.querySelectorAll("[data-node]")) {
        const id = n.getAttribute("data-node")!;
        if (id === rootId) continue;
        const r = n.getBoundingClientRect();
        rects[id] = [r.x, r.y, r.width, r.height].map(Math.round);
        const cy = r.y + Math.min(r.height / 2, 40);
        centres[id] = cy > innerHeight ? "offscreen" : who(document.elementFromPoint(r.x + r.width / 2, cy));
      }
      const tEl = target === "(page root)" ? null : document.querySelector(`[data-node="${target}"]`);
      const box = tEl?.getBoundingClientRect();
      let stolen = 0;
      let total = 0;
      if (box) {
        for (let x = 10; x < innerWidth; x += 40)
          for (let y = 10; y < innerHeight; y += 40) {
            if (x > box.left - 14 && x < box.right + 14 && y > box.top - 14 && y < box.bottom + 14) continue;
            total++;
            if (document.elementFromPoint(x, y)?.closest(`[data-node="${target}"]`)) stolen++;
          }
      }
      const nav = document.querySelector(builder ? "[data-builder-bar]" : "[data-canvas-nav]");
      const nr = nav?.getBoundingClientRect();
      const navLink = document.querySelector("[data-canvas-nav] a, [data-canvas-nav] [data-app-title]");
      const lr = navLink?.getBoundingClientRect();
      const style = (el: Element | null) => {
        if (!el) return null;
        const s = getComputedStyle(el);
        return { opacity: s.opacity, visibility: s.visibility, transform: s.transform, translate: s.translate, scale: s.scale, filter: s.filter, pointerEvents: s.pointerEvents, boxShadow: s.boxShadow, borderBottom: s.borderBottomWidth, boxSizing: s.boxSizing, themeShadow: s.getPropertyValue("--theme-shadow").trim(), themeAccent: s.getPropertyValue("--theme-accent").trim() };
      };
      const vEl = document.querySelector(`[data-node="${victim}"]`);
      const vRoot = vEl?.querySelector('[data-slot="root"]') ?? null;
      return {
        rects,
        centres,
        stolen,
        total,
        navRect: nr ? [nr.x, nr.y, nr.width, nr.height].map(Math.round) : null,
        navHit: lr ? who(document.elementFromPoint(lr.x + lr.width / 2, lr.y + lr.height / 2)) : "no nav",
        target: style(tEl),
        targetHeight: box ? Math.round(box.height) : null,
        victim: { box: style(vEl), root: vRoot ? { ...style(vRoot), color: getComputedStyle(vRoot).color, background: getComputedStyle(vRoot).backgroundColor } : null },
        scrollHeight: document.scrollingElement!.scrollHeight,
        emitted: [...document.querySelectorAll("style[data-node-css]")].map((s) => s.textContent ?? "").join("\n").slice(0, 1200),
      };
    },
    { target, rootId, builder, victim: VICTIM },
  );
}
type Probe = Awaited<ReturnType<typeof probe>>;

/** Pixel diff of two same-size screenshots: outside the excluded rects, and per named crop pair. */
async function pixelDiff(scratch: Page, base: Buffer, cur: Buffer, exclude: number[][], crops: { name: string; a: number[]; b: number[] }[]) {
  return scratch.evaluate(
    async ({ a64, b64, exclude, crops }) => {
      const load = async (b: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height);
      };
      const A = await load(a64);
      const B = await load(b64);
      const W = A.width;
      const Ht = A.height;
      const diff = (ax: number, ay: number, bx: number, by: number) => {
        const i = (ay * W + ax) * 4;
        const j = (by * W + bx) * 4;
        return Math.abs(A.data[i]! - B.data[j]!) + Math.abs(A.data[i + 1]! - B.data[j + 1]!) + Math.abs(A.data[i + 2]! - B.data[j + 2]!) > 60;
      };
      let changed = 0;
      let counted = 0;
      for (let y = 0; y < Ht; y += 3)
        for (let x = 0; x < W; x += 3) {
          if (exclude.some(([ex, ey, ew, eh]) => x > ex! - 14 && x < ex! + ew! + 14 && y > ey! - 14 && y < ey! + eh! + 14)) continue;
          counted++;
          if (diff(x, y, x, y)) changed++;
        }
      const out: Record<string, number> = {};
      const red: Record<string, number> = {};
      for (const c of crops) {
        const w = Math.min(c.a[2]!, c.b[2]!) - 8;
        const h = Math.min(c.a[3]!, c.b[3]!) - 8;
        let n = 0;
        let d = 0;
        let r = 0;
        for (let y = 4; y < h; y += 2)
          for (let x = 4; x < w; x += 2) {
            const ax = c.a[0]! + x, ay = c.a[1]! + y, bx = c.b[0]! + x, by = c.b[1]! + y;
            if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= W || bx >= W || ay >= Ht || by >= Ht) continue;
            n++;
            if (diff(ax, ay, bx, by)) d++;
            const j = (by * W + bx) * 4;
            // The attack colour (every hostile variant paints red); the shell and themes never use pure red.
            if (B.data[j]! > 180 && B.data[j + 1]! < 90 && B.data[j + 2]! < 90) r++;
          }
        out[c.name] = n ? Math.round((10000 * d) / n) / 100 : 0;
        red[c.name] = n ? Math.round((10000 * r) / n) / 100 : 0;
      }
      return { outsidePct: counted ? Math.round((10000 * changed) / counted) / 100 : 0, crops: out, red };
    },
    { a64: base.toString("base64"), b64: cur.toString("base64"), exclude, crops },
  );
}

const ancestorsOf: Record<string, string[]> = { [ATTACK]: [STACK], [VICTIM]: [STACK], [SECCHILD]: [SECTION] };
const descendantsOf: Record<string, string[]> = { [STACK]: [ATTACK, VICTIM], [SECTION]: [SECCHILD] };

async function setVariant(req: APIRequestContext, appId: string, rootId: string, name: string, vr: Variant | null) {
  const list: unknown[] = [];
  for (const id of [...CSS_TARGETS, rootId]) {
    const target = vr?.target === ROOT ? rootId : vr?.target;
    list.push({ op: "node.update", nodeId: id, patch: { css: id === target && vr?.css ? vr.css : null } });
  }
  // The section's Style panel attempt (and its reset).
  list.push({ op: "node.update", nodeId: SECTION, patch: vr?.style ? { overrideTheme: true, style: vr.style } : { overrideTheme: null, style: null } });
  await ops(req, appId, list);
  return publish(req, appId, name);
}

async function prepare(req: APIRequestContext, slug: string) {
  const appId = await ensureApp(req, slug, "R4 final");
  const d = await draft(req, appId);
  const root = d.doc.pages[0]!.root;
  await ops(req, appId, [...(root.children ?? []).map((c) => ({ op: "node.remove", nodeId: c.id })), ...pageNodes().map((node) => ({ op: "node.add", parentId: root.id, node })), { op: "node.update", nodeId: root.id, patch: { css: null } }]);
  return { appId, rootId: root.id };
}

/** Pass or the reasons it fails, for one variant against the baseline. */
function judge(name: string, vr: Variant, base: Probe, p: Probe, px: { outsidePct: number; crops: Record<string, number>; red: Record<string, number> }, builder: boolean): string[] {
  const bad: string[] = [];
  const target = vr.target;
  if (p.stolen !== 0) bad.push(`stole ${p.stolen}/${p.total} clicks`);
  if (!builder && p.navHit !== "chrome") bad.push(`nav hit ${p.navHit}`);
  const skip = new Set([target, ...(ancestorsOf[target] ?? []), ...(descendantsOf[target] ?? [])]);
  for (const [id, hit] of Object.entries(p.centres)) {
    if (skip.has(id)) continue;
    // A container's centre may land on its own child.
    if (hit !== id && hit !== "offscreen" && !(ancestorsOf[id] ?? []).includes(hit) && !(descendantsOf[id] ?? []).includes(hit)) bad.push(`${id} centre hits ${hit}`);
  }
  const moved = Object.entries(base.rects).some(([id, r]) => !skip.has(id) && (p.rects[id] ?? []).some((x, i) => Math.abs(x - r[i]!) > 1));
  // Paint: with nothing moved, nothing outside the node changes; otherwise every neighbour's own crop and the nav are unchanged.
  if (!moved && px.outsidePct > 0.05) bad.push(`${px.outsidePct}% of pixels outside the node changed`);
  for (const [crop, pct] of Object.entries(px.crops)) if (pct > 0.5) bad.push(`${crop} crop ${pct}% changed`);
  for (const [crop, pct] of Object.entries(px.red)) if (pct > 0.1) bad.push(`${crop} crop ${pct}% red`);
  // Siblings keep their computed style.
  if (JSON.stringify(p.victim) !== JSON.stringify(base.victim)) bad.push(`victim style changed: ${JSON.stringify(p.victim)}`);
  // Page push: the last row moves by at most the cap; layouts take no node CSS, so nothing moves at all.
  const lastDy = (p.rects[LAST]?.[1] ?? 0) - (base.rects[LAST]?.[1] ?? 0);
  if (lastDy > CAP) bad.push(`last row moved ${lastDy}px (cap ${CAP})`);
  if (p.scrollHeight - base.scrollHeight > CAP) bad.push(`page grew ${p.scrollHeight - base.scrollHeight}px`);
  if (LAYOUT_TARGETS.has(target) && Math.abs(lastDy) > 1) bad.push(`layout ${name} moved the last row ${lastDy}px`);
  if (p.targetHeight !== null && !LAYOUT_TARGETS.has(target) && p.targetHeight > CAP) bad.push(`target ${p.targetHeight}px tall`);
  // The node box never paints with a value its CSS set.
  if (p.target && base.target && (p.target.themeShadow !== base.target.themeShadow || p.target.themeAccent !== base.target.themeAccent)) bad.push(`node box tokens changed: ${p.target.themeShadow} / ${p.target.themeAccent}`);
  if (p.target && /3000px|800px/.test(p.target.boxShadow)) bad.push(`node box shadow ${p.target.boxShadow}`);
  if (/--theme-[a-z-]+\s*:/i.test(p.emitted)) bad.push("emitted CSS writes --theme-*");
  if (/\]\s*(:[^\s{,]*)?\s*[+~]/.test(p.emitted.replace(/\[data-slot[^\]]*\]\s*[+~]/g, ""))) bad.push("emitted CSS has a sibling selector after the node root");
  return bad;
}

function crops(base: Probe, p: Probe, target: string, builder: boolean) {
  const skip = new Set([target, ...(ancestorsOf[target] ?? []), ...(descendantsOf[target] ?? [])]);
  const out: { name: string; a: number[]; b: number[] }[] = [];
  if (base.navRect && p.navRect) out.push({ name: builder ? "builder-bar" : "nav", a: base.navRect, b: p.navRect });
  for (const [id, r] of Object.entries(base.rects)) {
    const c = p.rects[id];
    if (skip.has(id) || !c || c[1]! + Math.min(c[3]!, r[3]!) > 900 || c[1]! < 0) continue;
    out.push({ name: id, a: r, b: c });
  }
  return out;
}

test.describe("desktop", () => {
  test.beforeEach(async ({ context, page }, info) => {
    test.skip(info.project.name !== "desktop", "desktop only");
    await signIn(context, page.request);
    await withFrameFix(context);
  });

  test("items 1 to 3 (viewer): every hostile variant so far steals 0 clicks, paints nothing outside its slot, leaves siblings alone and pushes the page no further than the cap", async ({ page, context }) => {
    test.setTimeout(1_500_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const req = page.request;
    const { appId, rootId } = await prepare(req, "r4-final");
    const scratch = await context.newPage();
    const load = async () => {
      await page.goto("/a/r4-final");
      await expect(page.locator(`[data-node="${PLAIN}"]`)).toBeVisible({ timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
    };
    await setVariant(req, appId, rootId, "baseline", null);
    await load();
    const baseShot = await page.screenshot({ path: evidence("final/containment/viewer-baseline.png") });
    const baseProbes: Record<string, Probe> = {};
    const baseFor = async (target: string) => (baseProbes[target] ??= await probe(page, target, rootId));
    for (const t of [HOSTILE, TOKEN, STACK, ATTACK, SECTION, ROOT]) await baseFor(t);
    const results: Record<string, unknown> = {};
    const failures: string[] = [];
    const counts: Record<string, number> = {};
    for (const [name, vr] of Object.entries(VARIANTS)) {
      counts[vr.set] = (counts[vr.set] ?? 0) + 1;
      const review = await setVariant(req, appId, rootId, name, vr);
      await load();
      const shot = await page.screenshot({ path: evidence(`final/containment/viewer-${name}.png`) });
      const base = baseProbes[vr.target]!;
      const p = await probe(page, vr.target, rootId);
      const exclude = vr.target === ROOT ? [] : [base.rects[vr.target] ?? [0, 0, 0, 0], p.rects[vr.target] ?? [0, 0, 0, 0], ...(ancestorsOf[vr.target] ?? []).flatMap((a) => [base.rects[a]!, p.rects[a]!])];
      const px = await pixelDiff(scratch, baseShot, shot, exclude, crops(base, p, vr.target, false));
      const bad = judge(name, vr, base, p, px, false);
      results[name] = { set: vr.set, target: vr.target, css: vr.css, style: vr.style, pass: bad.length === 0, problems: bad, stolen: `${p.stolen}/${p.total}`, navHit: p.navHit, pixelsChangedOutsideNode: `${px.outsidePct}%`, crops: px.crops, redPct: px.red, lastRowMovedPx: (p.rects[LAST]?.[1] ?? 0) - (base.rects[LAST]?.[1] ?? 0), pageGrewPx: p.scrollHeight - base.scrollHeight, targetHeight: p.targetHeight, nodeBox: p.target, victim: p.victim, emitted: p.emitted, reviewWarnings: review.problems.map((x) => x.message) };
      if (bad.length) failures.push(`${name}: ${bad.join("; ")}`);
    }
    writeEvidence("final/viewer-containment.json", { variants: Object.keys(VARIANTS).length, bySet: counts, cap: CAP, failures, results });
    await setVariant(req, appId, rootId, "reset", null);
    await scratch.close();
    expect(failures, failures.join("\n")).toEqual([]);
    expect(Object.keys(VARIANTS).length).toBeGreaterThanOrEqual(24 + 16 + 31 + 20);
  });

  test("items 1 to 3 (builder): under the worst variants a click on each neighbour selects it, the builder chrome and app nav keep their clicks and paint", async ({ page, context }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const req = page.request;
    const { appId, rootId } = await prepare(req, "r4-final-b");
    const scratch = await context.newPage();
    const open = async () => {
      await openBuilder(page, "r4-final-b");
      await expect(page.locator(`[data-node="${PLAIN}"]`)).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
    };
    await setVariant(req, appId, rootId, "baseline", null);
    await open();
    const baseShot = await page.screenshot({ path: evidence("final/containment/builder-baseline.png") });
    const out: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const name of ["theme_shadow_var", "theme_shadow_var_offset", "theme_accent_inject", "theme_shadow_supports_container", "sib_not", "sib_plus", "sib_cover", "sib_media", "border_huge", "border_contentbox", "section_runaway", "stack_runaway", "display_contents", "var_fixed", "r1_star_absolute"]) {
      const vr = VARIANTS[name]!;
      await setVariant(req, appId, rootId, name, vr);
      await open();
      const shot = await page.screenshot({ path: evidence(`final/containment/builder-${name}.png`) });
      const p = await probe(page, vr.target, rootId, true);
      const chrome = await page.evaluate((target) => {
        const hits: Record<string, boolean> = {};
        for (const sel of ["[data-builder-bar]", '[data-left-tab="layers"]', "[data-canvas-nav]"]) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          hits[sel] = !document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2)?.closest(`[data-node="${target}"]`);
        }
        return hits;
      }, vr.target);
      const barRect = await page.locator("[data-builder-bar]").boundingBox();
      const navRect = await page.locator("[data-canvas-nav]").first().boundingBox();
      const r = (b: { x: number; y: number; width: number; height: number } | null) => (b ? [b.x, b.y, b.width, b.height].map(Math.round) : [0, 0, 0, 0]);
      const px = await pixelDiff(scratch, baseShot, shot, [[0, 0, 1440, 900]], [{ name: "builder-bar", a: r(barRect), b: r(barRect) }, { name: "app-nav", a: r(navRect), b: r(navRect) }]);
      // Each neighbour (and the victim, under the sibling variants) selects on click.
      const clicks: Record<string, boolean> = {};
      for (const id of [PLAIN, VICTIM, LAST, SECCHILD].filter((x) => x !== vr.target)) {
        await page.locator(`[data-node="${id}"] [data-slot="root"]`).first().click();
        clicks[id] = await page.locator(`[data-inspector][data-node-id="${id}"]`).isVisible();
      }
      const bad: string[] = [];
      if (p.stolen) bad.push(`stole ${p.stolen}/${p.total}`);
      if (!Object.values(chrome).every(Boolean)) bad.push(`chrome lost clicks ${JSON.stringify(chrome)}`);
      if (!Object.values(clicks).every(Boolean)) bad.push(`clicks ${JSON.stringify(clicks)}`);
      // The bar's own text changes between publishes ("rev 10 . since v8"), so the bar may differ a little;
      // a paint escape covers it (round 3: 63% of the viewer) and is red.
      for (const [k, pct] of Object.entries(px.crops)) if (pct > 5) bad.push(`${k} ${pct}% changed`);
      for (const [k, pct] of Object.entries(px.red)) if (pct > 0.1) bad.push(`${k} ${pct}% red`);
      if (p.victim.box?.visibility !== "visible" || p.victim.box?.opacity !== "1" || p.victim.box?.pointerEvents !== "auto") bad.push(`victim ${JSON.stringify(p.victim.box)}`);
      out[name] = { stolen: `${p.stolen}/${p.total}`, chromeKeepsClicks: chrome, clicksSelect: clicks, paint: px.crops, redPct: px.red, victim: p.victim.box, pass: bad.length === 0, problems: bad };
      if (bad.length) failures.push(`${name}: ${bad.join("; ")}`);
    }
    writeEvidence("final/builder-containment.json", { failures, results: out });
    await setVariant(req, appId, rootId, "reset", null);
    await scratch.close();
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("the inspector refuses with clear messages: node CSS lists the removed token, sibling and border lines; a layout's CSS field refuses and its Style panel caps sizes", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const req = page.request;
    const { appId } = await prepare(req, "r4-final-ui");
    await openBuilder(page, "r4-final-ui");
    // A component: the CSS field lists each removal with its reason.
    await selectLayer(page, HOSTILE);
    await openGroup(page, "advanced");
    const box = page.locator("[data-css-box] textarea").first();
    await box.fill(":scope { --theme-shadow: 0 0 0 3000px red; border-bottom: 3000px solid red }\n:scope:not(.zz) ~ * { opacity: 0 }");
    const removedList = page.locator("[data-css-removed]");
    await expect(removedList).toContainText("--theme-* tokens", { timeout: 8000 });
    await expect(removedList).toContainText("sibling selectors (+ or ~) after :scope");
    await expect(removedList).toContainText("borders on :scope are not allowed");
    await page.locator("[data-inspector]").first().screenshot({ path: evidence("final/ui/css-field-removed.png") });
    // A layout: no CSS field, a note that says why; saved CSS shows as ignored and can be removed.
    await ops(req, appId, [{ op: "node.update", nodeId: SECTION, patch: { css: ".atr-section-body { min-height: 20000px }" } }]);
    await page.reload();
    await expect(page.locator("[data-builder-bar]")).toBeVisible({ timeout: 15_000 });
    await selectLayer(page, SECTION);
    await openGroup(page, "advanced");
    await expect(page.locator("[data-css-layout-note]")).toContainText("take the Style panel only");
    await expect(page.locator("[data-css-ignored]")).toBeVisible();
    await expect(page.locator("[data-css-refused] textarea")).toHaveAttribute("readonly", "");
    await page.locator("[data-inspector]").first().screenshot({ path: evidence("final/ui/layout-css-refused.png") });
    const review = await (await req.get(`/api/apps/${appId}/review`)).json();
    expect(JSON.stringify(review.problems)).toContain("css.layout_ignored");
    await page.locator("[data-css-remove]").click();
    await expect.poll(async () => findNode((await draft(req, appId)).doc.pages[0]!.root, SECTION)?.css ?? null, { timeout: 6000 }).toBeNull();
    // The layout's Style panel: a runaway minimum height is refused and named, never saved.
    const style = await openGroup(page, "style");
    await style.locator('[role="switch"], button[aria-checked]').first().click();
    await expect(page.locator("[data-layout-style-note]")).toBeVisible();
    await page.locator("[data-style-more-toggle]").click();
    const minH = page.locator('[data-style-field="minHeight"] [data-style-number]');
    await minH.fill("20000");
    await expect(page.locator('[data-style-refused="minHeight"]')).toContainText("at most 1200px");
    await page.locator("[data-inspector]").first().screenshot({ path: evidence("final/ui/layout-style-capped.png") });
    await page.waitForTimeout(800);
    expect(JSON.stringify(findNode((await draft(req, appId)).doc.pages[0]!.root, SECTION))).not.toContain("20000");
    await minH.fill("600");
    await expect.poll(async () => JSON.stringify(findNode((await draft(req, appId)).doc.pages[0]!.root, SECTION)?.style ?? null), { timeout: 6000 }).toContain("600");
    writeEvidence("final/inspector-refusals.json", { removed: await removedList.count(), layoutNote: await page.locator("[data-layout-style-note]").textContent() });
  });

  test("item 4: canvas text keeps whole word gaps on the Homelab template in Control Room, light and dark (and the other built-in themes)", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const req = page.request;
    const appId = await ensureApp(req, "r4-homelab", "R4 Homelab", "homelab");
    const measure = async () =>
      page.evaluate(() => {
        const root = document.querySelector("[data-atrium-canvas]")!;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const gaps: { pair: string; gap: number; fontSize: number; letterSpacing: string; wordSpacing: string }[] = [];
        for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
          const text = t.data;
          for (const m of text.matchAll(/(\S+) (\S+)/g)) {
            const i = m.index!;
            const r1 = document.createRange();
            r1.setStart(t, i);
            r1.setEnd(t, i + m[1]!.length);
            const r2 = document.createRange();
            r2.setStart(t, i + m[1]!.length + 1);
            r2.setEnd(t, i + m[1]!.length + 1 + m[2]!.length);
            const a = r1.getBoundingClientRect();
            const b = r2.getBoundingClientRect();
            if (!a.width || !b.width || Math.abs(a.top - b.top) > 2) continue;
            const cs = getComputedStyle(t.parentElement!);
            gaps.push({ pair: `${m[1]} ${m[2]}`, gap: Math.round((b.left - a.right) * 100) / 100, fontSize: parseFloat(cs.fontSize), letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing });
          }
        }
        return gaps;
      });
    const out: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const theme of ["control-room", "dusk", "solid", "daylight"]) {
      await ops(req, appId, [{ op: "theme.set", theme: { themeId: theme } }]);
      await publish(req, appId, `theme ${theme}`);
      for (const scheme of ["light", "dark"] as const) {
        if (theme !== "control-room" && scheme === "dark") continue;
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto("/a/r4-homelab");
        await expect(page.locator("[data-atrium-canvas]")).toBeVisible({ timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        const gaps = await measure();
        const proxmox = gaps.find((g) => g.pair === "connect Proxmox");
        if (theme === "control-room") {
          const state = page.locator(".atr-state", { hasText: "Proxmox" }).first();
          await state.screenshot({ path: evidence(`final/word-gaps/control-room-${scheme}-nodata.png`) });
          await page.screenshot({ path: evidence(`final/word-gaps/control-room-${scheme}.png`) });
        }
        const atFourteen = gaps.filter((g) => g.fontSize >= 13 && g.fontSize <= 15);
        const min = atFourteen.length ? Math.min(...atFourteen.map((g) => g.gap)) : null;
        out[`${theme}-${scheme}`] = { proxmox, minGapAt14: min, count: gaps.length, letterSpacing: [...new Set(gaps.map((g) => g.letterSpacing))], sample: gaps.slice(0, 40) };
        if (!proxmox) failures.push(`${theme}-${scheme}: no "connect Proxmox" text`);
        else if (proxmox.gap < 4) failures.push(`${theme}-${scheme}: connect Proxmox gap ${proxmox.gap}px`);
        if (theme === "control-room" && min !== null && min < 4) failures.push(`${theme}-${scheme}: a 14px word gap of ${min}px (${JSON.stringify(atFourteen.find((g) => g.gap === min))})`);
        if (gaps.some((g) => g.fontSize <= 16 && parseFloat(g.letterSpacing) < 0 && !/heading|title/i.test(g.pair))) out[`${theme}-${scheme}-negativeTracking`] = gaps.filter((g) => parseFloat(g.letterSpacing) < 0).slice(0, 10);
      }
    }
    await page.emulateMedia({ colorScheme: null });
    await ops(req, appId, [{ op: "theme.set", theme: { themeId: "control-room" } }]);
    await publish(req, appId, "theme back");
    writeEvidence("final/word-gaps.json", { failures, results: out });
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
