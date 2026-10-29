// settings round 3, the w2-r2 gauntlet Fix List in the real build (with the round 3 shared file
// requests applied in the scratch copy for items 5 and 8 and the auth and integrations notes):
//   1  (security) the own-host exception matches the integration's origin: another port, another
//      scheme, a redirect to another port and other spellings of loopback are not signed or fetched
//   2  RangeField sliders have a track (200px or more at 390) and drag with a pointer and a finger
//   3  colour swatches paint the real colour (oklch included; checkerboard under alpha)
//   4  "Use on an app" from Themes and the editor; "Used by" links to the app's Look
//   5  the instance accent reaches every Atrium screen (root layout)
//   6  Save theme stays in reach on a 390px phone at any scroll position, groups open
//   7  theme editor folds: chevron on pop, body on sheet, instant under reduced motion, no words
//   8  two-word labels read as two words (word spacing), display tracking -0.04em
//   9  one Primary per view on General; the five accents on one even row
//  plus the auth notes (invite form first, no native selects on /settings/users) and the integrations
//  note (the Custom API next step).
// A stand-in feed and image host listens on 127.0.0.1:3148, and "another service on the same machine"
// on 127.0.0.1:3149. Test-only values; none are real credentials.
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ORIGIN, OWNER, context, ev, stateFor } from "./helpers";

test.setTimeout(240_000);
test.describe.configure({ mode: "serial" });
test.beforeEach(async () => test.skip(process.env.ATRIUM_E2E_SCENARIO === "locked", "normal scenario"));

const OWN_PORT = 3148;
const OTHER_PORT = 3149;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d3b5f00000000049454e44ae426082", "hex");
const out: Record<string, unknown> = {};
const hits: string[] = [];
let own: Server | null = null;
let other: Server | null = null;

test.afterAll(async ({}, info) => {
  if (Object.keys(out).length) writeFileSync(ev(`r3-${info.project.name}.json`), JSON.stringify({ ...out, standInHits: hits }, null, 2));
  await Promise.all([own, other].map((s) => (s ? new Promise<void>((r) => s.close(() => r())) : undefined)));
  own = other = null;
});

async function api(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN, storageState: await stateFor(OWNER), extraHTTPHeaders: { origin: ORIGIN } });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixtures edit a theme document loosely
type Doc = Record<string, any>;
async function themeFrom(a: APIRequestContext, base: string, name: string, patch: (t: Doc) => void = () => {}): Promise<string> {
  const dup = await a.post(`/api/settings/themes/${base}/duplicate`);
  expect(dup.status(), await dup.text()).toBeLessThan(300);
  const id = (await dup.json()).id as string;
  const cur = await (await a.get(`/api/settings/themes/${id}`)).json();
  const theme = structuredClone(cur.theme);
  theme.name = name;
  patch(theme);
  const put = await a.put(`/api/settings/themes/${id}`, { data: { theme, rev: cur.rev } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}
async function newApp(a: APIRequestContext, name: string): Promise<{ id: string; slug: string } | null> {
  if ((await a.get("/api/apps")).status() === 404) return null;
  const slug = `${name.replace(/[^a-z0-9]+/g, "-")}-${randomBytes(3).toString("hex")}`;
  const r = await a.post("/api/apps", { data: { name, slug, template: "blank" } });
  expect(r.status(), await r.text()).toBeLessThan(300);
  return { id: (await r.json()).app.id as string, slug };
}
async function publish(a: APIRequestContext, appId: string) {
  const d = await (await a.get(`/api/apps/${appId}/draft`)).json();
  const r = await a.post(`/api/apps/${appId}/publish`, { data: { expectRev: d.rev, note: "r3" } });
  expect(r.status(), await r.text()).toBe(200);
}
const qOf = (p: string) => new URLSearchParams(p.slice(p.indexOf("?") + 1));
/** A component id: c_ plus 10 base32 characters (a-z, 2-7). */
const cid = () => `c_${[...randomBytes(10)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("")}`;
/** Opens a fold in either the round 3 markup (button) or the round 2 markup (details). */
async function openGroup(page: Page, g: string) {
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
  const toggle = page.locator(`[data-group-toggle="${g}"]`);
  if (await toggle.count()) {
    if ((await page.locator(`[data-group="${g}"]`).getAttribute("data-open")) !== "true") await toggle.click();
  } else if ((await page.locator(`[data-group="${g}"]`).getAttribute("open")) === null) await page.locator(`[data-group="${g}"] summary`).click();
}
async function openAllGroups(page: Page) {
  for (const g of ["surfaces", "colours", "type", "shape", "motion", "chrome", "dark", "advanced"]) await openGroup(page, g);
  await page.waitForTimeout(600);
}

test("item 1 (security): a feed's other port, other scheme and loopback spellings are not signed; a redirect to another port is refused", async () => {
  const a = await api();
  test.skip((await a.get("/api/apps")).status() === 404, "app-builder is not in this build");
  const OTHER = `http://localhost:${OTHER_PORT}/f/own-otherport?SECPROBE=router-admin`;
  const URLS = {
    ownOrigin: `http://localhost:${OWN_PORT}/own.png`,
    ownOriginDefaultSpelled: `http://LOCALHOST:${OWN_PORT}/own-upper.png`,
    otherPort: OTHER,
    otherPortTrailingDot: `http://localhost.:${OTHER_PORT}/f/dot.png`,
    schemeSwitch: `https://localhost:${OWN_PORT}/tls.png`,
    loopbackV4: `http://127.0.0.1:${OWN_PORT}/v4.png`,
    loopbackV6: `http://[::1]:${OWN_PORT}/v6.png`,
    sixToFour: "http://[2002:7f00:1::]/x.png",
    redirectToOtherPort: `http://localhost:${OWN_PORT}/to-other-port`,
    publicImg: "https://img.example.net/cover.png",
  };
  other = createServer((req, res) => {
    hits.push(`other ${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  });
  own = createServer((req, res) => {
    hits.push(`own ${req.method} ${req.url}`);
    if (req.url === "/feed.xml") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Stand-in</title>${Object.entries(URLS).map(([k, u]) => `<item><title>${k}</title><link>${u.replace(/&/g, "&amp;")}</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`);
    }
    if (req.url === "/to-other-port") {
      res.writeHead(302, { location: OTHER });
      return res.end();
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((r) => other!.listen(OTHER_PORT, "127.0.0.1", () => r()));
  await new Promise<void>((r) => own!.listen(OWN_PORT, "127.0.0.1", () => r()));
  const integ = await a.post("/api/integrations", { data: { packageId: "rss", name: `r3 feed ${randomBytes(2).toString("hex")}`, config: { baseUrl: `http://localhost:${OWN_PORT}/feed.xml` }, secrets: {}, untested: true } });
  expect(integ.status(), await integ.text()).toBeLessThan(300);
  const integrationId = (await integ.json()).id as string;
  const app = (await newApp(a, "r3 feed"))!;
  const d = await (await a.get(`/api/apps/${app.id}/draft`)).json();
  const page = d.doc.pages[0];
  const ops = [
    { op: "source.set", source: { name: "news", integrationId, endpointId: "items", refreshSec: 300 } },
    { op: "node.add", parentId: page.root.id, node: { id: cid(), type: "text", props: { text: { $bind: "{{ news }}" } } } },
  ];
  const opsRes = await a.post(`/api/apps/${app.id}/ops`, { data: { rev: d.rev, ops } });
  expect(opsRes.status(), await opsRes.text()).toBe(200);
  const poll = await a.get(`/api/data/widget/${app.id}:news?page=${page.id}&draft=1`);
  const body = await poll.json();
  expect(poll.status(), JSON.stringify(body)).toBe(200);
  const signed = (body.signedUrls ?? {}) as Record<string, string>;
  out.item1Signed = Object.fromEntries(Object.entries(URLS).map(([k, u]) => [k, signed[u] ? qOf(signed[u]).get("n") : null]));
  // The critic's pass: the other port unsigned while the feed's own origin is still "h".
  expect(qOf(signed[URLS.ownOrigin]!).get("n")).toBe("h");
  expect(qOf(signed[URLS.ownOriginDefaultSpelled]!).get("n")).toBe("h");
  for (const k of ["otherPort", "otherPortTrailingDot", "schemeSwitch", "loopbackV4", "loopbackV6", "sixToFour"] as const) expect(signed[URLS[k]], k).toBeUndefined();
  expect(qOf(signed[URLS.publicImg]!).get("n")).toBe("p");
  // The own-origin image is fetched; a redirect from the own origin to another port is refused.
  expect((await a.get(signed[URLS.ownOrigin]!)).status()).toBe(200);
  const redirect = await a.get(signed[URLS.redirectToOtherPort]!);
  out.item1Redirect = { status: redirect.status(), body: await redirect.text() };
  expect(redirect.status()).toBe(403);
  // A hand-made "h" path for the other port is refused before any fetch (the signature does not verify).
  const forged = signed[URLS.ownOrigin]!.replace(encodeURIComponent(URLS.ownOrigin), encodeURIComponent(OTHER));
  expect((await a.get(forged)).status()).toBe(403);
  expect(hits.filter((h) => h.startsWith("other")), "the other service on the same host was never contacted").toEqual([]);
  await a.dispose();
});

test("integrations note: an endpoint's next step names the builder, not 'apps arrive soon'", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const list = await (await a.get("/api/integrations")).json().catch(() => null);
  const first = (Array.isArray(list) ? list : (list?.integrations ?? []))[0] as { id: string } | undefined;
  test.skip(!first, "no integration in this slot");
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/integrations/${first!.id}`);
  const next = page.locator("[data-next-step]").first();
  await expect(next).toBeVisible();
  out.integrationsNextStep = await next.innerText();
  expect(out.integrationsNextStep).not.toMatch(/arrive soon/);
  await ctx.close();
  await a.dispose();
});

test("item 2: every RangeField has a track, the thumb sits at the value, and dragging changes it (pointer and finger)", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const a = await api();
  const id = await themeFrom(a, "dusk", `r3 slider ${info.project.name} ${randomBytes(2).toString("hex")}`, (t) => { t.tokens.wallpaper = { ...t.tokens.wallpaper, kind: "gradient", value: "linear-gradient(180deg, #1e3c72, #2a5298)" }; });
  for (const variant of ["light", "dark"] as const) {
    const ctx = await context(browser, OWNER, { mobile, variant });
    const page = await ctx.newPage();
    await page.goto(`/settings/themes/${id}`);
    await openAllGroups(page);
    const sliders = await page.locator("[data-slider]").evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      const track = el.querySelector("[data-slider-track]")!.getBoundingClientRect();
      const thumb = el.querySelector("[data-slider-thumb]")!.getBoundingClientRect();
      const input = el.parentElement!.querySelector("input")!.getBoundingClientRect();
      return { name: el.getAttribute("data-slider"), w: Math.round(r.width), track: Math.round(track.width), thumbX: Math.round(thumb.left + thumb.width / 2 - track.left), readout: Math.round(input.width), aria: el.querySelector("[role=slider]")?.getAttribute("aria-valuenow") };
    }));
    out[`item2-${info.project.name}-${variant}`] = sliders;
    expect(sliders.length).toBeGreaterThanOrEqual(9);
    for (const s of sliders) {
      expect(s.track, `${s.name} track`).toBeGreaterThanOrEqual(mobile ? 200 : 120);
      expect(s.readout, `${s.name} readout`).toBe(80);
    }
    // Angle 180 sits in the middle of 0 to 359.
    const angle = sliders.find((s) => s.name === "wallpaper.angle")!;
    expect(Math.abs(angle.thumbX / angle.track - 180 / 359)).toBeLessThan(0.06);
    await page.locator('[data-slider="wallpaper.angle"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: ev("screens", `r3-item2-slider-${info.project.name}-${variant}.png`), clip: await clipOf(page, '[data-gradient-angle]', 24) });
    if (variant === "light") {
      const track = (await page.locator('[data-slider="wallpaper.angle"] [data-slider-track]').boundingBox())!;
      const thumb = (await page.locator('[data-slider="wallpaper.angle"] [data-slider-thumb]').boundingBox())!;
      const y = thumb.y + thumb.height / 2;
      const from = thumb.x + thumb.width / 2;
      const to = track.x + track.width * (mobile ? 0.75 : 0.25);
      if (mobile) {
        // A finger: Chromium turns these touches into the pointer events the slider listens to.
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
        for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + ((to - from) * i) / 8, y }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.move(from, y);
        await page.mouse.down();
        await page.waitForTimeout(120);
        const pressed = await page.locator('[data-slider="wallpaper.angle"] [data-slider-thumb]').evaluate((el) => getComputedStyle(el).transform);
        out.item2PressedTransform = pressed;
        expect(pressed, "the thumb grows on pop while held").not.toBe("none");
        await page.mouse.move(to, y, { steps: 8 });
        await page.mouse.up();
      }
      const value = Number(await page.locator('[data-field="wallpaper.angle"]').inputValue());
      out[`item2-drag-${info.project.name}`] = { from: 180, to: value };
      expect(Math.abs(value - (mobile ? 270 : 90))).toBeLessThanOrEqual(15);
      // The opacity slider drags too, and its readout follows.
      // Centred, so the phone's sticky Save bar at the bottom does not sit over it.
      await page.locator('[data-slider="surface.opacity"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
      const op = (await page.locator('[data-slider="surface.opacity"] [data-slider-track]').boundingBox())!;
      if (mobile) {
        const cdp = await ctx.newCDPSession(page);
        const oy = op.y + op.height / 2;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: op.x + op.width * 0.5, y: oy }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: op.x + op.width * 0.99, y: oy }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.click(op.x + op.width * 0.99, op.y + op.height / 2);
      }
      await expect(page.locator('[data-field="surface.opacity"]')).toHaveValue(/^(0\.99|1)$/);
    }
    await ctx.close();
  }
  await a.dispose();
});

async function clipOf(page: Page, sel: string, pad = 16) {
  const b = (await page.locator(sel).first().boundingBox())!;
  const vw = page.viewportSize()!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, width: Math.min(vw.width - x, b.width + pad * 2), height: Math.min(vw.height - y, b.height + pad * 2) };
}

test("item 3: colour swatches paint the real colour, on a checkerboard under alpha; the picker writes back in the author's format", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const a = await api();
  const id = await themeFrom(a, "dusk", `r3 swatch ${info.project.name} ${randomBytes(2).toString("hex")}`);
  for (const variant of ["light", "dark"] as const) {
    const ctx = await context(browser, OWNER, { mobile, variant });
    const page = await ctx.newPage();
    await page.goto(`/settings/themes/${id}`);
    await openAllGroups(page);
    const swatches = await page.locator("[data-swatch]").evaluateAll((els) => els.map((el) => {
      const text = (el.parentElement!.querySelector("input[data-field]") as HTMLInputElement).value;
      const fill = getComputedStyle(el.querySelector("[data-swatch-fill]")!).backgroundColor;
      const picker = (el.querySelector("input[type=color]") as HTMLInputElement).value;
      const checker = getComputedStyle(el.querySelector("[data-swatch-fill]")!.parentElement!).backgroundImage;
      return { path: el.getAttribute("data-swatch"), text, fill, picker, alpha: el.getAttribute("data-swatch-alpha"), checker: checker !== "none" };
    }));
    out[`item3-${info.project.name}-${variant}`] = swatches;
    // Empty fields (the Auto dark set before it is filled) paint nothing; every filled one paints its colour.
    const black = swatches.filter((s) => s.text.trim() && s.picker === "#000000" && !/^(#000|#000000|oklch\(0 )/i.test(s.text));
    expect(swatches.filter((s) => !s.text.trim()).every((s) => s.fill === "rgba(0, 0, 0, 0)"), "an empty field paints no colour").toBe(true);
    expect(black, "no swatch opens on black unless the colour is black").toEqual([]);
    const accent = swatches.find((s) => s.path === "color.accent")!;
    expect(accent.text).toMatch(/^oklch\(/);
    expect(accent.fill).not.toMatch(/^rgba?\(0, 0, 0/);
    expect(accent.picker).not.toBe("#000000");
    const border = swatches.find((s) => s.path === "surface.border.color")!;
    expect(border.text).toMatch(/\/ 0\.08\)/);
    expect(border.alpha).toBe("1");
    expect(border.checker).toBe(true);
    await page.locator("[data-basics]").screenshot({ path: ev("screens", `r3-item3-swatches-basics-${info.project.name}-${variant}.png`) });
    await page.locator('[data-group="surfaces"]').screenshot({ path: ev("screens", `r3-item3-swatches-surfaces-${info.project.name}-${variant}.png`) });
    if (variant === "light") {
      // The picker writes oklch back for an oklch value, keeping it oklch.
      await page.locator('[data-picker="color.accent"]').fill("#22c55e");
      await expect(page.locator('[data-field="color.accent"]')).toHaveValue(/^oklch\(0\.\d+ 0\.\d+ \d+(\.\d)?\)$/);
      await expect(page.locator('[data-picker="color.accent"]')).toHaveValue("#22c55e");
      // And hex stays hex.
      const ok = page.locator('[data-field="color.ok"]');
      const okBefore = await ok.inputValue();
      if (okBefore.startsWith("#")) {
        await page.locator('[data-picker="color.ok"]').fill("#123456");
        await expect(ok).toHaveValue("#123456");
      }
      out.item3Written = { accent: await page.locator('[data-field="color.accent"]').inputValue(), ok: await ok.inputValue() };
    }
    await ctx.close();
  }
  await a.dispose();
});

test("item 4: Use on an app from a theme card puts the theme on the app's draft and links to review and look", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const a = await api();
  const app = await newApp(a, `r3 use ${info.project.name}`);
  test.skip(!app, "app-builder is not in this build");
  await publish(a, app!.id);
  const themeId = await themeFrom(a, "dusk", `r3 use ${info.project.name} ${randomBytes(2).toString("hex")}`);
  const ctx = await context(browser, OWNER, { mobile });
  const page = await ctx.newPage();
  await page.goto("/settings/themes");
  const card = page.locator(`[data-theme-window="${themeId}"]`);
  await card.scrollIntoViewIfNeeded();
  let actions = 0;
  await card.locator(`[data-use-on-app="${themeId}"]`).click(); actions++;
  const sheet = page.locator('[data-sheet="use-on-app"]');
  await expect(sheet).toBeVisible();
  const choice = sheet.locator(`[role=radio][data-app="${app!.slug}"]`);
  await expect(choice).toBeVisible();
  await choice.click(); actions++;
  await page.screenshot({ path: ev("screens", `r3-item4-picker-${info.project.name}.png`) });
  await sheet.locator("[data-confirm-use-on-app]").click(); actions++;
  await expect(sheet.locator(`[data-use-on-app-done="${app!.slug}"]`)).toBeVisible();
  const draft = await (await a.get(`/api/apps/${app!.id}/draft`)).json();
  expect(draft.doc.theme).toEqual({ themeId });
  const review = sheet.locator("[data-review-publish]");
  expect(await review.getAttribute("href")).toBe(`/build/${app!.slug}?review=1`);
  await page.screenshot({ path: ev("screens", `r3-item4-done-${info.project.name}.png`) });
  out[`item4-${info.project.name}`] = { actionsToThemedDraft: actions, draftTheme: draft.doc.theme };
  // "Used by" on the card now lists the app, linking to its Look.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  const used = card.locator("[data-used-by] summary");
  await expect(used).toContainText(/Used by 1 app/);
  await used.click();
  const link = card.locator(`[data-used-by-link="${app!.slug}"]`);
  expect(await link.getAttribute("href")).toBe(`/build/${app!.slug}?look=1`);
  if (!mobile) {
    // Review and publish opens the builder's publish review (app-builder SFR), and Look its sheet.
    await page.goto(`/build/${app!.slug}?review=1`);
    const opened = await page.locator('[data-sheet="publish-review"]').waitFor({ timeout: 10_000 }).then(() => true, () => false);
    out.item4ReviewOpens = opened;
    if (opened) {
      await page.screenshot({ path: ev("screens", "r3-item4-review-opened.png") });
      expect(page.url()).not.toContain("review=1");
    }
    await page.goto(`/build/${app!.slug}?look=1`);
    out.item4LookOpens = await page.locator('[data-sheet="app-look"]').waitFor({ timeout: 10_000 }).then(() => true, () => false);
    // Use on an app is also in the editor.
    await page.goto(`/settings/themes/${themeId}`);
    await expect(page.locator(`[data-editor-side] [data-use-on-app="${themeId}"], [data-theme-editor] [data-use-on-app="${themeId}"]`).first()).toBeVisible();
  }
  await ctx.close();
  await a.dispose();
});

test("item 5: the instance accent reaches the launcher, builder, viewer, sign-in, settings and not-found screens", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const a = await api();
  const set = await a.put("/api/settings/instance", { data: { brandAccent: "sage" } });
  expect(set.status(), await set.text()).toBe(200);
  const app = await newApp(a, "r3 brand");
  if (app) await publish(a, app.id);
  const routes = ["/", "/settings/general", "/library", "/apps", "/approvals", "/audit", ...(app ? [`/build/${app.slug}`, `/a/${app.slug}`] : [])];
  const res: Record<string, unknown> = {};
  try {
    for (const variant of ["light", "dark"] as const) {
      const ctx = await context(browser, OWNER, { variant });
      const page = await ctx.newPage();
      for (const r of routes) {
        await page.goto(r);
        await page.waitForLoadState("networkidle").catch(() => undefined);
        const v = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase();
          const canvas = document.querySelector("[data-atrium-canvas]");
          const host = document.querySelector("[data-atrium-switcher]");
          const ring = host?.shadowRoot?.querySelector(".w") ? getComputedStyle(host.shadowRoot.querySelector(".w")!).getPropertyValue("--ring").trim().toLowerCase() : null;
          return { root, styles: document.querySelectorAll("style[data-instance-branding]").length, canvas: canvas ? getComputedStyle(canvas).getPropertyValue("--accent").trim().toLowerCase() : null, switcherRing: ring };
        });
        res[`${variant} ${r}`] = v;
        expect(v.root, `${variant} ${r}`).toBe("#9cc5a1");
        expect(v.styles, `${variant} ${r} one branding style`).toBe(1);
        if (v.canvas) expect(v.canvas, "a viewed app's canvas keeps its own accent").not.toBe("#9cc5a1");
        if (r === "/" || r.startsWith("/a/")) await page.screenshot({ path: ev("screens", `r3-item5-${r === "/" ? "launcher" : "viewer"}-${variant}.png`) });
      }
      await ctx.close();
    }
    const signedOut = await browser.newContext({ baseURL: ORIGIN });
    const p = await signedOut.newPage();
    await p.goto("/sign-in");
    res["signed-out /sign-in"] = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase());
    expect(res["signed-out /sign-in"]).toBe("#9cc5a1");
    await signedOut.close();
  } finally {
    out.item5 = res;
    const back = await a.put("/api/settings/instance", { data: { brandAccent: null } });
    expect(back.status()).toBe(200);
    await a.dispose();
  }
});

test("item 6: Save theme stays visible and tappable above the tab bar at any scroll position on a 390px phone", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile", "phones");
  const a = await api();
  const id = await themeFrom(a, "dusk", `r3 save ${randomBytes(2).toString("hex")}`);
  for (const variant of ["light", "dark"] as const) {
    const ctx = await context(browser, OWNER, { mobile: true, variant });
    const page = await ctx.newPage();
    await page.goto(`/settings/themes/${id}`);
    await openAllGroups(page);
    const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    const probes: Record<string, unknown>[] = [];
    for (const frac of [0, 0.15, 0.3, 0.5, 0.6, 0.8, 1]) {
      const y = Math.round(max * frac);
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(150);
      const p = await page.evaluate(() => {
        const save = document.querySelector("[data-save-theme]")!.getBoundingClientRect();
        const bar = document.querySelector('[data-shell="tabbar"]')?.getBoundingClientRect();
        const hit = document.elementFromPoint(save.left + save.width / 2, save.top + save.height / 2);
        return { scrollY: Math.round(scrollY), top: Math.round(save.top), bottom: Math.round(save.bottom), tabBarTop: bar ? Math.round(bar.top) : innerHeight, tappable: !!hit?.closest("[data-save-theme]"), h: Math.round(save.height) };
      });
      probes.push({ frac, ...p });
      expect(p.top, `scroll ${frac}`).toBeGreaterThanOrEqual(0);
      expect(p.bottom, `scroll ${frac}: above the tab bar`).toBeLessThanOrEqual(p.tabBarTop);
      expect(p.tappable, `scroll ${frac}: nothing covers it`).toBe(true);
      expect(p.h).toBeGreaterThanOrEqual(44);
      if (frac === 0.3 || frac === 0.6) await page.screenshot({ path: ev("screens", `r3-item6-save-${frac}-${variant}.png`) });
    }
    out[`item6-${variant}`] = { scrollMax: max, probes };
    // And a tap saves.
    await page.locator("[data-save-theme]").tap();
    await expect(page.getByRole("region", { name: "Notifications" }).getByText(/^Saved /)).toBeVisible();
    await ctx.close();
  }
  await a.dispose();
});

test("item 7: theme editor folds open on sheet with a chevron on pop, instantly under reduced motion, with no words", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once per motion setting");
  const a = await api();
  const id = await themeFrom(a, "control-room", `r3 fold ${randomBytes(2).toString("hex")}`);
  for (const reducedMotion of [false, true]) {
    const ctx = await context(browser, OWNER, { reducedMotion });
    const page = await ctx.newPage();
    await page.goto(`/settings/themes/${id}`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const toggle = page.locator('[data-group-toggle="surfaces"]');
    expect((await toggle.innerText()).trim()).toBe("Surfaces");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-fold-body="surfaces"]')).toBeHidden();
    const frames = await page.evaluate(async () => {
      const btn = document.querySelector('[data-group-toggle="surfaces"]') as HTMLButtonElement;
      const body = document.querySelector('[data-fold-body="surfaces"]') as HTMLElement;
      const chev = btn.querySelector("[data-fold-chevron]") as SVGElement;
      const rows: { t: number; h: number; rot: string }[] = [];
      const t0 = performance.now();
      btn.click();
      await new Promise<void>((done) => {
        const tick = () => {
          rows.push({ t: Math.round(performance.now() - t0), h: Math.round(body.getBoundingClientRect().height), rot: getComputedStyle(chev).transform });
          if (performance.now() - t0 < 700) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      return rows;
    });
    const final = frames[frames.length - 1]!.h;
    const second = frames[1] ?? frames[0]!;
    out[`item7-${reducedMotion ? "reduced" : "normal"}`] = { first: frames.slice(0, 6), final, frames: frames.length };
    expect(final).toBeGreaterThan(100);
    if (reducedMotion) expect(second.h, "instant under reduced motion").toBe(final);
    else {
      expect(frames.some((f) => f.h > 0 && f.h < final * 0.9), "the body grows over several frames").toBe(true);
      expect(frames[frames.length - 1]!.rot).not.toBe("none");
    }
    await expect(page.locator('[data-group="surfaces"]')).toHaveAttribute("data-open", "true");
    const words = await page.locator("[data-group-toggle]").allInnerTexts();
    expect(words.some((w) => /\b(open|close)\b/.test(w))).toBe(false);
    await page.screenshot({ path: ev("screens", `r3-item7-fold-${reducedMotion ? "reduced" : "normal"}.png`), clip: await clipOf(page, '[data-group="surfaces"]', 8) });
    await ctx.close();
  }
  await a.dispose();
});

test("item 8: two-word labels keep a readable word space; display tracking -0.04em", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const a = await api();
  const id = await themeFrom(a, "control-room", `r3 words ${info.project.name} ${randomBytes(2).toString("hex")}`);
  for (const variant of ["light", "dark"] as const) {
    const ctx = await context(browser, OWNER, { mobile, variant });
    const page = await ctx.newPage();
    await page.goto(`/settings/themes/${id}`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.locator("[data-editor-actions]").scrollIntoViewIfNeeded();
    // The gap between the end of the first word and the start of the second, from text ranges.
    // Wave 2.10a r2: buttons hidden at this width (the phone-only "Show preview") have no text box to measure.
    const gaps = await page.locator("[data-editor-actions] a, [data-editor-actions] button").evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).map((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Text | null = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\S\s+\S/.test(n.textContent ?? "")) { node = n as Text; break; }
      const text = (el.textContent ?? "").trim();
      if (!node) return { text, space: null, wordSpacing: getComputedStyle(el).wordSpacing };
      const t = node.textContent!;
      const sp = t.search(/\S\s/) + 1;
      const next = sp + (t.slice(sp).search(/\S/));
      const r1 = document.createRange();
      r1.setStart(node, sp - 1);
      r1.setEnd(node, sp);
      const r2 = document.createRange();
      r2.setStart(node, next);
      r2.setEnd(node, next + 1);
      const [b1, b2] = [r1.getBoundingClientRect(), r2.getBoundingClientRect()];
      return { text, space: Math.round((b2.left - b1.right) * 10) / 10, firstEnds: Math.round(b1.right * 10) / 10, secondStarts: Math.round(b2.left * 10) / 10, wordSpacing: getComputedStyle(el).wordSpacing };
    }));
    out[`item8-${info.project.name}-${variant}`] = gaps;
    for (const g of gaps.filter((x) => x.space !== null)) expect(g.space!, g.text).toBeGreaterThanOrEqual(4);
    await page.screenshot({ path: ev("screens", `r3-item8-buttons-${info.project.name}-${variant}.png`), clip: await clipOf(page, "[data-editor-actions]", 8) });
    if ((await a.get("/api/apps")).status() !== 404) {
      await page.goto("/");
      const g = await page.locator("[data-greeting]").evaluate((el) => { const cs = getComputedStyle(el); return { text: el.textContent, tracking: parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize) }; });
      out[`item8-greeting-${info.project.name}-${variant}`] = g;
      expect(Math.abs(g.tracking - -0.04)).toBeLessThan(0.002);
      await page.screenshot({ path: ev("screens", `r3-item8-launcher-${info.project.name}-${variant}.png`) });
    }
    await ctx.close();
  }
  await a.dispose();
});

test("item 9: General has no gold Primary beside another; the five accents sit on one even row", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  for (const variant of ["light", "dark"] as const) {
    const ctx = await context(browser, OWNER, { mobile, variant });
    const page = await ctx.newPage();
    await page.goto("/settings/general");
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const r = await page.evaluate(() => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const probe = document.createElement("div");
      probe.style.background = accent;
      document.body.appendChild(probe);
      const accentRgb = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const primaries = [...document.querySelectorAll("[data-settings-screen] button, [data-settings-screen] a")].filter((b) => getComputedStyle(b).backgroundColor === accentRgb && b.getBoundingClientRect().width > 0).map((b) => b.textContent);
      const options = [...document.querySelectorAll("[data-accent]")].map((o) => { const b = o.getBoundingClientRect(); return { top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; });
      return { primaries, options };
    });
    out[`item9-${info.project.name}-${variant}`] = r;
    expect(r.primaries.length).toBeLessThanOrEqual(1);
    expect(r.options).toHaveLength(5);
    expect(new Set(r.options.map((o) => o.top)).size, "one row").toBe(1);
    expect(Math.max(...r.options.map((o) => o.w)) - Math.min(...r.options.map((o) => o.w)), "even widths").toBeLessThanOrEqual(1);
    for (const o of r.options) expect(o.h).toBeGreaterThanOrEqual(44);
    await page.locator('[data-field="brandAccent"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: ev("screens", `r3-item9-general-${info.project.name}-${variant}.png`), fullPage: !mobile });
    await ctx.close();
  }
});

test("auth notes: the invite form comes first on /settings/users, with no native selects, and still invites", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  for (const variant of ["light", "dark"] as const) {
    const ctx = await context(browser, OWNER, { mobile, variant });
    const page = await ctx.newPage();
    await page.goto("/settings/users");
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const r = await page.evaluate(() => {
      const invite = document.querySelector("[data-invite-form]")!.getBoundingClientRect();
      const users = document.querySelector("#users-heading")!.getBoundingClientRect();
      const email = document.querySelector("[data-invite-form] input[name=email]")!.getBoundingClientRect();
      const native = [...document.querySelectorAll("select, input[type=radio], input[type=checkbox]")].filter((e) => { const s = getComputedStyle(e); const b = e.getBoundingClientRect(); return b.width > 4 && b.height > 4 && s.opacity !== "0" && s.appearance !== "none"; }).length;
      return { inviteTop: Math.round(invite.top + scrollY), usersTop: Math.round(users.top + scrollY), emailBottom: Math.round(email.bottom + scrollY), viewport: innerHeight, native };
    });
    out[`auth-${info.project.name}-${variant}`] = r;
    expect(r.inviteTop).toBeLessThan(r.usersTop);
    // The critic found the form 844px down; now its email field is on the first screen, unscrolled.
    expect(r.emailBottom).toBeLessThanOrEqual(r.viewport);
    expect(r.native).toBe(0);
    await page.screenshot({ path: ev("screens", `r3-auth-users-${info.project.name}-${variant}.png`) });
    if (variant === "light" && !mobile) {
      const email = `r3-invite-${randomBytes(2).toString("hex")}@atrium.test`;
      const form = page.locator("[data-invite-form]");
      await form.getByLabel("Their email").fill(email);
      await form.locator('[data-select="invite-role"]').click();
      await page.locator('[data-select-menu="invite-role"] [data-option="member"]').click();
      await form.locator('[data-select="invite-days"]').click();
      await page.locator('[data-select-menu="invite-days"] [data-option="3"]').click();
      await form.getByRole("button", { name: "Create invite link" }).click();
      await expect(page.locator("[data-one-time-url]")).toBeVisible({ timeout: 15_000 });
      out.authInvite = { email, role: "member", days: 3 };
    }
    await ctx.close();
  }
});
