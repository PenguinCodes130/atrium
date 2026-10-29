// Wave 2.10a round 2, builder S: the gauntlet r1 Fix List items 3, 4, 5, 8 and 10 (settings halves) and
// the settings lows, through the real theme editor and the real app viewer. Each test does what the
// critic did (stages/04-gauntlet/output/critics-w210a-r1/) and asserts the Fix List's pass state.
//   3  the preview shows its whole sample at 390 and 1440 px, stays one tap away on a phone, Side by side
//      without wrap or crop, title bars and control sizes as the real app, 44 px on touch, nav hover.
//   4  Compact shortens title bars and nav items (tokens for tiles too); Gap and Padding show the values
//      in force.
//   5  radius stops per design Note 3 (Comfortable 0 to 20, Compact 0 to 16, step 2, then Pill), every
//      stop visibly different.
//   8  saving a theme used by published apps says so, with a button opening each app's review.
//   10 phone nav on one line; Boxed tabs joined to the rule.
//   Lows: Make a dark set shows the Editing switch; dark colours in hex; New theme saves nothing until
//   saved; contrast over an image wallpaper says what it measured against.
// Test-only values; none are real credentials.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { OWNER, context, ev } from "./helpers";
import { THEMES, api, emptyPage, frostedTheme, openEditor, openGroup, publish, radio, rid, saveTheme, tag, themeFrom } from "./w210a-fixtures";

test.setTimeout(300_000);

const sha = (b: Buffer) => createHash("sha1").update(b).digest("hex");

/** An app on this theme with the given nav pages and the probe widgets: a titled card, button, toggle, select. */
async function probeApp(a: APIRequestContext, themeId: string, pages: string[] = ["Home", "Rack", "Power"], name = "Homelab"): Promise<{ id: string; slug: string }> {
  const slug = `w210r2-${randomBytes(3).toString("hex")}`;
  const created = await a.post("/api/apps", { data: { name, slug, template: "blank" } });
  expect(created.status(), await created.text()).toBe(201);
  const app = (await created.json()).app;
  const d = await (await a.get(`/api/apps/${app.id}/draft`)).json();
  const first = d.doc.pages[0];
  const root = first.root.id as string;
  const ops: unknown[] = [
    { op: "theme.set", theme: { themeId } },
    { op: "page.update", pageId: first.id, patch: { title: pages[0] } },
    ...pages.slice(1).map((t, i) => ({ op: "page.add", page: emptyPage(t, `p${i + 2}`) })),
    { op: "node.add", parentId: root, node: { id: rid("c"), type: "card", title: "Rack", props: { title: "Rack" }, slot: { x: 0, y: 0, w: 6, h: 20 }, children: [{ id: rid("c"), type: "stat", props: { value: 42, label: "CPU" } }] } },
    { op: "node.add", parentId: root, node: { id: rid("c"), type: "button", props: { label: "Run scene" }, slot: { x: 6, y: 0, w: 3, h: 8 } } },
    { op: "node.add", parentId: root, node: { id: rid("c"), type: "toggle", props: { label: "Fans", state: true }, slot: { x: 9, y: 0, w: 3, h: 8 } } },
    { op: "node.add", parentId: root, node: { id: rid("c"), type: "select", props: { label: "Room", value: "living", options: [{ label: "Living room", value: "living" }, { label: "Kitchen", value: "kitchen" }] }, slot: { x: 6, y: 8, w: 6, h: 10 } } },
  ];
  const r = await a.post(`/api/apps/${app.id}/ops`, { data: { rev: d.rev, ops } });
  expect(r.status(), await r.text()).toBe(200);
  await publish(a, app.id);
  return { id: app.id, slug };
}

/** Where every part of a sample sits against the sample's own box. */
async function sampleFit(sample: Locator) {
  return sample.evaluate((s) => {
    const box = s.getBoundingClientRect();
    const parts = [...s.querySelectorAll<HTMLElement>("[data-sample-card], [data-sample-button], [data-sample-toggle], [data-sample-select], [data-canvas-nav]")];
    const nav = s.querySelector<HTMLElement>("[data-canvas-nav]");
    const items = nav ? [...nav.querySelectorAll<HTMLElement>("a[data-app-nav-item]")] : [];
    return {
      box: { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right), height: Math.round(box.height) },
      scrollOver: s.scrollHeight - s.clientHeight,
      cut: parts
        .map((p) => ({ what: p.getAttribute("data-sample-card") !== null ? "card" : [...p.attributes].map((x) => x.name).find((n) => n.startsWith("data-sample") || n === "data-canvas-nav") ?? p.tagName, r: p.getBoundingClientRect() }))
        .filter(({ r }) => r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.left < box.left - 0.5)
        .map(({ what, r }) => `${what} ${Math.round(r.top)}-${Math.round(r.bottom)} x ${Math.round(r.left)}-${Math.round(r.right)}`),
      navLines: new Set(items.map((i) => Math.round(i.getBoundingClientRect().top))).size,
      navCropped: nav ? nav.scrollWidth - nav.clientWidth > 1 || items.some((i) => i.getBoundingClientRect().right > nav.getBoundingClientRect().right + 0.5) : false,
    };
  });
}

const schemeRadio = (page: Page, name: string) => page.locator('[data-preview] [data-field="preview.scheme"]').getByRole("radio", { name, exact: true });

// ---- Item 3 ----

test("3a: the preview shows its whole sample at 1440 and 390 px, in Light, Dark and Side by side", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `r2 whole ${tag()}`, (t) => { t.mode = "auto"; });
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const size of ["1440", "390"] as const) {
    const c = size === "390" ? await context(browser, OWNER, { mobile: true }) : await context(browser, OWNER);
    const page = await c.newPage();
    if (size === "1440") await page.setViewportSize({ width: 1440, height: 900 });
    await openEditor(page, id);
    // On a phone the preview may sit behind a Preview button: open it if there is one.
    const opener = page.locator("[data-preview-open]");
    if (size === "390" && (await opener.count()) && (await opener.isVisible())) await opener.click();
    for (const mode of ["Light", "Dark", "Side by side"]) {
      await schemeRadio(page, mode).click();
      await page.waitForTimeout(150);
      const samples = page.locator("[data-preview] [data-theme-sample]");
      const n = await samples.count();
      for (let i = 0; i < n; i++) {
        const f = await sampleFit(samples.nth(i));
        out[`${size}/${mode}/${i}`] = f;
        if (f.scrollOver > 1) problems.push(`${size} ${mode} #${i}: content is ${f.scrollOver}px taller than the sample box`);
        if (f.cut.length) problems.push(`${size} ${mode} #${i}: cut off: ${f.cut.join("; ")}`);
        if (f.navLines > 1) problems.push(`${size} ${mode} #${i}: the nav wraps onto ${f.navLines} lines`);
        if (f.navCropped) problems.push(`${size} ${mode} #${i}: the nav is cropped`);
      }
      await page.locator("[data-preview]").screenshot({ path: ev("screens", `3a-${size}-${mode.replace(/ /g, "-").toLowerCase()}.png`) });
    }
    await c.close();
  }
  // V4: the four test themes (Control Room, Dusk, Solid, the frosted custom theme) at 390 and 1440 px.
  for (const th of THEMES) {
    const tid = await th.make(a);
    for (const size of ["1440", "390"] as const) {
      const c = size === "390" ? await context(browser, OWNER, { mobile: true }) : await context(browser, OWNER);
      const page = await c.newPage();
      if (size === "1440") await page.setViewportSize({ width: 1440, height: 900 });
      await openEditor(page, tid);
      if (size === "390") await page.locator("[data-preview-open]").tap();
      const f = await sampleFit(page.locator("[data-preview] [data-theme-sample]").first());
      out[`${th.label}/${size}`] = f;
      if (f.scrollOver > 1 || f.cut.length || f.navLines > 1 || f.navCropped) problems.push(`${th.label} ${size}: ${JSON.stringify(f)}`);
      await page.locator("[data-preview]").screenshot({ path: ev("screens", `3a-v4-${th.label}-${size}.png`) });
      await c.close();
    }
  }
  out.problems = problems;
  writeFileSync(ev("3a-whole-sample.json"), JSON.stringify(out, null, 2));
  expect(problems).toEqual([]);
  await a.dispose();
});

test("3b: on a phone the preview is in view or one tap away while editing", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `r2 phone ${tag()}`);
  const c = await context(browser, OWNER, { mobile: true });
  const page = await c.newPage();
  await openEditor(page, id);
  await openGroup(page, "chrome");
  const pills = radio(page, "chrome.style", "Pills", "pills");
  await pills.scrollIntoViewIfNeeded();
  await pills.tap();
  const sample = page.locator("[data-preview] [data-theme-sample]").first();
  const inView = async () => sample.evaluate((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 0.5; });
  const out: Record<string, unknown> = { inViewAfterTap: await inView() };
  if (!out.inViewAfterTap) {
    const opener = page.locator("[data-preview-open]");
    out.opener = (await opener.count()) ? await opener.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height, w: r.width, vh: window.innerHeight }; }) : null;
    writeFileSync(ev("3b-phone-preview.json"), JSON.stringify(out, null, 2));
    await page.screenshot({ path: ev("screens", "3b-phone-after-tap.png") });
    await expect(opener, "a Preview button in reach").toBeInViewport();
    await opener.tap();
    await page.waitForTimeout(400);
    out.inViewAfterOpen = await inView();
  }
  // The field the person just tapped stays reachable with the preview open.
  out.pillsInView = await pills.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
  out.sampleStyle = await sample.locator("[data-atrium-canvas]").getAttribute("data-canvas-chrome");
  await page.screenshot({ path: ev("screens", "3b-phone-preview-open.png") });
  writeFileSync(ev("3b-phone-preview.json"), JSON.stringify(out, null, 2));
  expect(out.inViewAfterTap || out.inViewAfterOpen, "the whole sample is on screen").toBe(true);
  expect(out.sampleStyle).toBe("pills");
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sw, "no sideways scroll").toBeLessThanOrEqual(0);
  await c.close();
  await a.dispose();
});

async function controlSizes(scope: Locator, sel: { titlebar: string; button: string; toggle: string; select: string }) {
  return scope.evaluate((root, s) => {
    const h = (q: string) => { const el = root.querySelector<HTMLElement>(q); if (!el) return null; const r = el.getBoundingClientRect(); return r.height > 0 ? Math.round(r.height) : 0; };
    return { titlebar: h(s.titlebar), button: h(s.button), toggle: h(s.toggle), select: h(s.select) };
  }, sel);
}
const PREVIEW_SEL = { titlebar: "[data-sample-card] .atr-titlebar", button: "[data-sample-button]", toggle: "[data-sample-toggle]", select: "[data-sample-select]" };
const VIEWER_SEL = { titlebar: ".atr-card .atr-titlebar", button: ".atr-button", toggle: ".atr-toggle", select: ".atr-select select" };

test("3c: the preview draws title bars and controls at the real app's sizes, 44 px on touch, and its nav hovers", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `r2 sizes ${tag()}`); // Control Room: title bars on
  const app = await probeApp(a, id);
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  const c = await context(browser, OWNER);
  const page = await c.newPage();
  for (const density of ["comfortable", "compact"] as const) {
    await saveTheme(a, id, (t) => { t.tokens.space.density = density; });
    await publish(a, app.id);
    await openEditor(page, id);
    const prev = await controlSizes(page.locator("[data-preview] [data-theme-sample]").first(), PREVIEW_SEL);
    await page.locator("[data-preview]").screenshot({ path: ev("screens", `3c-preview-${density}.png`) });
    await page.goto(`/a/${app.slug}`);
    await expect(page.locator(".atr-button").first()).toBeVisible();
    const view = await controlSizes(page.locator("[data-atrium-canvas]").first(), VIEWER_SEL);
    await page.screenshot({ path: ev("screens", `3c-viewer-${density}.png`) });
    out[density] = { preview: prev, viewer: view };
    if (!prev.titlebar) problems.push(`${density}: the preview card has no title bar (viewer ${view.titlebar}px)`);
    for (const k of ["titlebar", "button", "toggle", "select"] as const) if (prev[k] !== null && view[k] !== null && Math.abs((prev[k] ?? 0) - (view[k] ?? 0)) > 1) problems.push(`${density}: preview ${k} ${prev[k]}px, viewer ${view[k]}px`);
  }
  await c.close();
  // Touch: the preview's controls are 44 px, as the viewer gives them.
  const phone = await context(browser, OWNER, { mobile: true });
  const pp = await phone.newPage();
  await openEditor(pp, id);
  const opener = pp.locator("[data-preview-open]");
  if ((await opener.count()) && (await opener.isVisible())) await opener.tap();
  const touch = await controlSizes(pp.locator("[data-preview] [data-theme-sample]").first(), PREVIEW_SEL);
  out.touchPreview = touch;
  if ((touch.button ?? 0) < 44) problems.push(`touch: the preview button is ${touch.button}px, the viewer gives 44`);
  await phone.close();
  writeFileSync(ev("3c-sizes.json"), JSON.stringify(out, null, 2));
  // Hover: the pointer reaches the preview's nav, so Pills' 8% hover fill shows.
  await saveTheme(a, id, (t) => { t.tokens.chrome.style = "pills"; });
  const hc = await context(browser, OWNER);
  const hp = await hc.newPage();
  await openEditor(hp, id);
  const item = hp.locator("[data-preview] [data-canvas-nav] a[data-app-nav-item]:not([aria-current])").first();
  const before = await item.evaluate((el) => getComputedStyle(el).backgroundColor);
  const box = (await item.boundingBox())!;
  await hp.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await hp.waitForTimeout(100);
  const hover = await item.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { hit: hit === el || el.contains(hit), bg: getComputedStyle(el).backgroundColor, hitTag: hit?.tagName, hitAttrs: hit ? [...hit.attributes].map((x) => x.name).join(" ") : "" }; });
  out.hover = { before, ...hover };
  if (!hover.hit) problems.push(`hover: the pointer lands on ${hover.hitTag} ${hover.hitAttrs}, not the nav item`);
  if (hover.bg === before) problems.push("hover: the Pills item shows no hover fill");
  await hc.close();
  out.problems = problems;
  writeFileSync(ev("3c-sizes.json"), JSON.stringify(out, null, 2));
  expect(problems).toEqual([]);
  await a.dispose();
});

// ---- Item 4 ----

test("4: Compact shortens title bars and nav items, gives tile tokens, and the fields show the values in force", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `r2 density ${tag()}`);
  const app = await probeApp(a, id);
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  const c = await context(browser, OWNER);
  const page = await c.newPage();
  const measure = async () => page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>("[data-atrium-canvas]")!;
    const cs = getComputedStyle(canvas);
    const nav = canvas.querySelector<HTMLElement>("[data-canvas-nav]")!;
    const item = nav.querySelector<HTMLElement>("a[data-app-nav-item]")!;
    const tb = canvas.querySelector<HTMLElement>(".atr-card .atr-titlebar");
    return {
      titlebar: tb ? Math.round(tb.getBoundingClientRect().height) : null,
      nav: Math.round(nav.getBoundingClientRect().height),
      navItem: Math.round(item.getBoundingClientRect().height),
      tokens: Object.fromEntries(["--theme-titlebar-h", "--theme-nav-item-h", "--theme-nav-pad-y", "--theme-tile-pad-y", "--theme-tile-pad-x", "--theme-tile-gap"].map((k) => [k, cs.getPropertyValue(k).trim()])),
    };
  });
  for (const density of ["comfortable", "compact"] as const) {
    await saveTheme(a, id, (t) => { t.tokens.space.density = density; for (const s of ["boxed-tabs"]) t.tokens.chrome.style = s; });
    await publish(a, app.id);
    await page.goto(`/a/${app.slug}`);
    await expect(page.locator(".atr-button").first()).toBeVisible();
    out[density] = await measure();
    await page.screenshot({ path: ev("screens", `4-viewer-${density}.png`) });
  }
  const comfy = out.comfortable as Awaited<ReturnType<typeof measure>>;
  const compact = out.compact as Awaited<ReturnType<typeof measure>>;
  if (compact.titlebar !== 19) problems.push(`title bar at Compact is ${compact.titlebar}px, not 19 (Comfortable ${comfy.titlebar})`);
  if (!(compact.navItem < comfy.navItem)) problems.push(`nav item at Compact is ${compact.navItem}px, Comfortable ${comfy.navItem}px`);
  if (!(compact.nav < comfy.nav)) problems.push(`nav bar at Compact is ${compact.nav}px, Comfortable ${comfy.nav}px`);
  for (const k of ["--theme-nav-item-h", "--theme-tile-pad-y", "--theme-tile-pad-x", "--theme-tile-gap"]) {
    const a1 = parseFloat(comfy.tokens[k] ?? ""), a2 = parseFloat(compact.tokens[k] ?? "");
    if (!(a2 < a1)) problems.push(`token ${k}: comfortable "${comfy.tokens[k]}", compact "${compact.tokens[k]}"`);
  }
  // The editor's Gap and Padding fields show the values in force at Compact.
  await openEditor(page, id);
  await openGroup(page, "shape");
  out.gapField = await page.locator('[data-range="space.gapPx"]').innerText();
  out.padField = await page.locator('[data-range="space.padPx"]').innerText();
  await page.locator('[data-group="shape"]').screenshot({ path: ev("screens", "4-fields-compact.png") });
  if (!/16 px at Compact/.test(String(out.gapField))) problems.push(`Gap field reads "${String(out.gapField).replace(/\s+/g, " ")}"`);
  if (!/13 px at Compact/.test(String(out.padField))) problems.push(`Padding field reads "${String(out.padField).replace(/\s+/g, " ")}"`);
  out.problems = problems;
  writeFileSync(ev("4-density.json"), JSON.stringify(out, null, 2));
  expect(problems).toEqual([]);
  await c.close();
  await a.dispose();
});

// ---- Item 5 ----

test("5: the radius slider offers only stops a control can show, then Pill, each visibly different", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  const c = await context(browser, OWNER);
  const page = await c.newPage();
  const expected = { comfortable: ["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "Pill"], compact: ["0", "2", "4", "6", "8", "10", "12", "14", "16", "Pill"] };
  for (const density of ["comfortable", "compact"] as const) {
    const id = await themeFrom(a, "control-room", `r2 radius ${density} ${tag()}`, (t) => { t.tokens.space.density = density; });
    await openEditor(page, id);
    await openGroup(page, "shape");
    const thumb = page.locator('[data-slider="shape.controlRadiusPx"] [role="slider"]');
    const button = page.locator("[data-preview] [data-sample-button]").first();
    await thumb.focus();
    await page.keyboard.press("Home");
    const steps: { text: string; radius: string; px: string }[] = [];
    for (let i = 0; i < 16; i++) {
      if (i > 0) await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(80);
      const text = await page.locator('[data-range="shape.controlRadiusPx"] input[data-field]').inputValue();
      if (steps.length && steps[steps.length - 1]!.text === text) break;
      steps.push({ text, radius: await button.evaluate((el) => getComputedStyle(el).borderTopLeftRadius), px: sha(await button.screenshot()) });
    }
    out[density] = steps;
    const texts = steps.map((s) => s.text);
    if (JSON.stringify(texts) !== JSON.stringify(expected[density])) problems.push(`${density}: stops ${texts.join(",")}`);
    // Every numeric stop draws its own corner. Pill on a pointer button is the same shape as the last
    // stop (half the height is already fully round, design Note 3); it is rounder on taller controls.
    const numeric = steps.filter((s) => s.text !== "Pill");
    const looks = new Set(numeric.map((s) => s.px)).size;
    if (looks !== numeric.length) problems.push(`${density}: ${looks} distinct button looks for ${numeric.length} numeric stops`);
    const pill = steps.find((s) => s.text === "Pill");
    if (pill && pill.radius !== "999px") problems.push(`${density}: Pill draws ${pill.radius}`);
    // A stored value above the last stop reads and draws as Pill.
    await saveTheme(a, id, (t) => { t.tokens.shape.controlRadiusPx = density === "compact" ? 18 : 22; });
    await openEditor(page, id);
    await openGroup(page, "shape");
    const shown = await page.locator('[data-range="shape.controlRadiusPx"] input[data-field]').inputValue();
    const drawn = await page.locator("[data-preview] [data-sample-button]").first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    out[`${density}/stored-above`] = { shown, drawn };
    if (shown !== "Pill" || drawn !== "999px") problems.push(`${density}: a stored ${density === "compact" ? 18 : 22} shows "${shown}" and draws ${drawn}`);
  }
  out.problems = problems;
  writeFileSync(ev("5-radius-stops.json"), JSON.stringify(out, null, 2));
  expect(problems).toEqual([]);
  await c.close();
  await a.dispose();
});

// ---- Item 8 ----

test("8: saving a theme used by a published app says so, with a button opening the app's review", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `r2 used ${tag()}`);
  const app = await probeApp(a, id);
  const c = await context(browser, OWNER);
  const page = await c.newPage();
  await openEditor(page, id);
  await openGroup(page, "chrome");
  await radio(page, "chrome.style", "Pills", "pills").click();
  await page.locator("[data-save-theme]").click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText(/^Saved /)).toBeVisible();
  const notice = page.locator("[data-published-apps]");
  await expect(notice).toBeVisible({ timeout: 5000 });
  await expect(notice).toContainText("Used by 1 published app: publish it to show this");
  await notice.screenshot({ path: ev("screens", "8-published-notice.png") });
  const link = notice.locator(`[data-review-app="${app.slug}"]`);
  await expect(link).toHaveAttribute("href", `/build/${app.slug}?review=1`);
  await link.click();
  await expect(page.locator("[data-review]")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: ev("screens", "8-review-opened.png") });
  await c.close();
  await a.dispose();
});

// ---- Item 10 ----

test("10: on a phone the nav sits on one line and Boxed tabs join the rule", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await themeFrom(a, "control-room", `r2 phone nav ${tag()}`);
  const app = await probeApp(a, id, ["Home", "Rack", "Media services"], "Home server dash");
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  const c = await context(browser, OWNER, { mobile: true });
  const page = await c.newPage();
  for (const s of ["bar", "boxed-tabs", "pills", "underline"] as const) {
    await saveTheme(a, id, (t) => { t.tokens.chrome.style = s; });
    await publish(a, app.id);
    await page.goto(`/a/${app.slug}`);
    const nav = page.locator("[data-canvas-nav]").first();
    await expect(nav).toBeVisible();
    const m = await nav.evaluate((n) => {
      const items = [...n.querySelectorAll<HTMLElement>("a[data-app-nav-item]")];
      const nr = n.getBoundingClientRect();
      return { navH: Math.round(nr.height), navBottom: Math.round(nr.bottom), tops: items.map((i) => Math.round(i.getBoundingClientRect().top)), bottoms: items.map((i) => Math.round(i.getBoundingClientRect().bottom)), heights: items.map((i) => Math.round(i.getBoundingClientRect().height)), sw: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    out[s] = m;
    await nav.screenshot({ path: ev("screens", `10-phone-nav-${s}.png`) });
    if (new Set(m.tops).size > 1) problems.push(`${s}: items on ${new Set(m.tops).size} lines (tops ${m.tops.join(",")})`);
    if (m.heights.some((h) => h < 44)) problems.push(`${s}: a nav item under 44px (${m.heights.join(",")})`);
    if (m.sw > 0) problems.push(`${s}: the page scrolls sideways by ${m.sw}px`);
    if (s === "boxed-tabs" && m.bottoms.some((b) => Math.abs(b - m.navBottom) > 1)) problems.push(`boxed tabs: tab bottoms ${m.bottoms.join(",")} against the rule at ${m.navBottom}`);
  }
  out.problems = problems;
  writeFileSync(ev("10-phone-nav.json"), JSON.stringify(out, null, 2));
  expect(problems).toEqual([]);
  await c.close();
  await a.dispose();
});

// ---- Lows ----

test("lows: Make a dark set shows the Editing switch, dark colours read as hex, glass over an image says what it measured", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const id = await frostedTheme(a, `r2 lows ${tag()}`);
  const c = await context(browser, OWNER);
  const page = await c.newPage();
  await openEditor(page, id);
  const out: Record<string, unknown> = {};
  // Glass over an image: the warning says what backdrop it assumed.
  out.warnings = await page.locator("[data-contrast-warning]").allInnerTexts();
  // Make a dark set from the Dark set fold, low on the page.
  await openGroup(page, "dark");
  await page.locator('[data-group="dark"]').getByRole("button", { name: "Make a dark set" }).click();
  await page.waitForTimeout(500);
  out.switchInView = await page.locator("[data-editing-scheme]").evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
  out.toast = await page.getByRole("region", { name: "Notifications" }).innerText();
  await page.screenshot({ path: ev("screens", "lows-dark-made.png") });
  await openGroup(page, "colours");
  out.darkColours = await page.locator('[data-group="colours"] input[data-field^="color."]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  await page.locator('[data-group="colours"]').screenshot({ path: ev("screens", "lows-dark-colours.png") });
  writeFileSync(ev("lows.json"), JSON.stringify(out, null, 2));
  expect(out.switchInView, "the Editing switch is on screen after Make a dark set").toBe(true);
  expect(String(out.toast)).toContain("Dark set");
  for (const v of out.darkColours as string[]) expect(v, "dark colours read as hex").toMatch(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);
  const glassWarn = (out.warnings as string[]).filter((w) => /^.?Surface text|Muted/.test(w.replace(/^▲\s*/, "")));
  for (const w of glassWarn) expect(w, "a glass warning over an image names its backdrop").toMatch(/black|white|wallpaper/i);
  await c.close();
  await a.dispose();
});

test("lows: New theme saves nothing until it is saved", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const count = async () => ((await (await a.get("/api/settings/themes")).json()).themes as unknown[]).length;
  const before = await count();
  const c = await context(browser, OWNER);
  const page = await c.newPage();
  await page.goto("/settings/themes");
  await page.locator("[data-new-theme]").click();
  await expect(page.locator("[data-theme-editor]")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const afterOpen = await count();
  await page.goto("/settings/themes");
  const afterLeave = await count();
  writeFileSync(ev("lows-new-theme.json"), JSON.stringify({ before, afterOpen, afterLeave }, null, 2));
  expect(afterOpen, "opening New theme stores nothing").toBe(before);
  expect(afterLeave).toBe(before);
  // Saving stores it once, under the name typed.
  await page.locator("[data-new-theme]").click();
  await expect(page.locator("[data-theme-editor]")).toBeVisible({ timeout: 15_000 });
  const name = `r2 new ${tag()}`;
  await page.locator('[data-field="name"]').fill(name);
  await page.locator("[data-save-theme]").click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText(`Saved ${name}`)).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/themes\/t-[a-z0-9]+$/);
  expect(await count()).toBe(before + 1);
  await c.close();
  await a.dispose();
});
