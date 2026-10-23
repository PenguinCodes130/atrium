// Wave 2.6 builder ease, media part (stages/02-subsystem-spec/output/builder-ease-spec.md 3.1, criteria
// 1, 3 to 8 and the uploads parts of 29 and 30), through the real screens (V11): the Image and Video
// inspectors' MediaField (Upload, Your uploads), the published viewer, a guest link and reduced motion.
// Served by tests/e2e/settings/serve.sh on the settings slot (port 3116) with a FRESH data folder.
// Evidence: evidence/builder-ease-media/r1/. Test-only passwords; none are real credentials.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { APP, MEMBER, ORIGIN, OWNER, VIEWER, addUser, stateFor } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

const EVIDENCE = path.join(APP, `evidence/builder-ease-media/${process.env.ATRIUM_E2E_EVIDENCE_ROUND ?? "r1"}`);
const ev = (...p: string[]) => {
  const f = path.join(EVIDENCE, ...p);
  mkdirSync(path.dirname(f), { recursive: true });
  return f;
};
const log = (name: string, data: unknown) => appendFileSync(ev("logs", "e2e.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), name, data })}\n`);

const MEDIA = path.join(APP, "tests/e2e/settings/media");
const MP4 = readFileSync(path.join(MEDIA, "loop.mp4"));
const WEBM = readFileSync(path.join(MEDIA, "loop.webm"));
const GIF = readFileSync(path.join(MEDIA, "anim.gif"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d3b5f00000000049454e44ae426082", "hex");
const H = { origin: ORIGIN };
const RUN = Date.now().toString(36).slice(-4);

type Node = { id: string; type: string; props: Record<string, unknown>; slot?: Record<string, number>; children?: Node[] };
type Draft = { rev: number; doc: { pages: { id: string; root: Node }[] } };

async function api(who: { email: string; password: string }): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN, storageState: await stateFor(who), extraHTTPHeaders: H });
}
async function upload(c: APIRequestContext, name: string, mimeType: string, buffer: Buffer, accept: string) {
  return c.post("/api/settings/uploads", { multipart: { file: { name, mimeType, buffer }, accept } });
}
async function draft(id: string): Promise<Draft> {
  return (await (await api(OWNER)).get(`/api/apps/${id}/draft`)).json() as Promise<Draft>;
}
async function newApp(slug: string, kids: Node[]): Promise<string> {
  const c = await api(OWNER);
  const r = await c.post("/api/apps", { data: { name: `Media ${slug}`, slug } });
  if (!r.ok()) throw new Error(`create failed: ${await r.text()}`);
  const id = (await r.json()).app.id as string;
  const d = await draft(id);
  const ops = kids.map((n, i) => ({ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { slot: { x: (i % 2) * 6, y: Math.floor(i / 2) * 30, w: 6, h: 30 }, ...n } }));
  const o = await c.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops } });
  if (!o.ok()) throw new Error(`ops failed: ${await o.text()}`);
  return id;
}
async function publish(id: string) {
  const c = await api(OWNER);
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note: "media" } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}
async function untilDraft(id: string, ok: (d: Draft) => boolean, ms = 5000): Promise<Draft> {
  const t0 = Date.now();
  for (;;) {
    const d = await draft(id);
    if (ok(d) || Date.now() - t0 > ms) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const nodeIn = (d: Draft, id: string) => d.doc.pages[0]!.root.children!.find((k) => k.id === id)!;

async function ctxFor(browser: Browser, who: { email: string; password: string } | null, opts: { reducedMotion?: "reduce"; viewport?: { width: number; height: number }; mobile?: boolean; theme?: "light" | "dark" } = {}) {
  const ctx = await browser.newContext({
    baseURL: ORIGIN,
    ...(who ? { storageState: await stateFor(who) } : {}),
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}),
    colorScheme: opts.theme ?? "light",
  });
  await ctx.addCookies([
    { name: "atrium_theme", value: opts.theme ?? "light", url: ORIGIN },
    { name: "atrium_swept", value: "1", url: ORIGIN },
  ]);
  return ctx;
}
async function openBuilder(page: Page, slug: string, select: string) {
  await page.goto(`/build/${slug}`);
  await expect(page.locator("[data-builder-bar]")).toBeVisible();
  await page.locator('[data-left-tab="layers"]').click();
  await page.locator(`[data-layer="${select}"]`).click();
  await expect(page.locator(`[data-selected-outline="${select}"]`)).toBeVisible();
}
/** The state of the first video under `scope`: playing, muted, looping, and how far along it is. */
async function videoState(page: Page, scope: string) {
  return page.locator(`${scope} video`).first().evaluate((v: HTMLVideoElement) => ({ paused: v.paused, muted: v.muted, loop: v.loop, time: v.currentTime, ready: v.readyState, w: v.videoWidth }));
}
async function expectPlaying(page: Page, scope: string) {
  await expect.poll(async () => (await videoState(page, scope)).time, { timeout: 8000 }).toBeGreaterThan(0.2);
  const s = await videoState(page, scope);
  expect(s.paused).toBe(false);
  expect(s.muted).toBe(true);
  expect(s.loop).toBe(true);
  return s;
}

let slug = "";
let appId = "";
let usedVideo = "";
let otherVideo = "";

test.beforeAll(async () => {
  await addUser(MEMBER.email, "member", MEMBER.password);
  await addUser(VIEWER.email, "viewer", VIEWER.password);
});

test("Your uploads is empty with nothing of its kind uploaded, and Upload puts a PNG on the canvas with no path typed (criteria 1, 6 empty state)", async ({ browser }) => {
  slug = `media-${RUN}`;
  // Earlier settings specs upload pictures (branding, themes), so the empty state is checked on a Video's
  // list: no video exists before this file's own uploads, whatever ran first.
  appId = await newApp(slug, [{ id: "c_mimageaaaa", type: "image", props: { alt: "Picture" } }, { id: "c_mvideoempt", type: "video", props: { alt: "Nothing yet" } }]);
  const ctx = await ctxFor(browser, OWNER);
  const page = await ctx.newPage();
  await openBuilder(page, slug, "c_mvideoempt");
  const videoField = page.locator('[data-media-field="video"]');
  await videoField.locator("[data-media-library]").click();
  const sheet = page.locator('[data-sheet="media-library"]');
  await expect(sheet.locator("[data-media-empty]")).toHaveText("Nothing uploaded yet. Upload a picture or video to use it anywhere in your apps.");
  await page.screenshot({ path: ev("screens", "your-uploads-empty.png") });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.locator(`[data-layer="c_mimageaaaa"]`).click();
  const field = page.locator('[data-media-field="image"]');
  await expect(field).toBeVisible();
  const t0 = Date.now();
  await field.locator("[data-media-input]").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG });
  const img = page.locator('[data-canvas-root] [data-node="c_mimageaaaa"] img');
  await expect(img).toHaveAttribute("src", /^\/uploads\/[a-z0-9]{20}\.png$/, { timeout: 2000 });
  const ms = Date.now() - t0;
  log("png on canvas", { ms });
  expect(ms).toBeLessThan(2000);
  await expect(field.locator('[data-media-thumb="image"]')).toBeVisible();
  const d = await untilDraft(appId, (x) => typeof nodeIn(x, "c_mimageaaaa").props.src === "string");
  expect(String(nodeIn(d, "c_mimageaaaa").props.src)).toMatch(/^\/uploads\/[a-z0-9]{20}\.png$/);
  await page.screenshot({ path: ev("screens", "image-uploaded.png") });
  await ctx.close();
});

test("the uploads API takes MP4 and WebM, refuses a renamed program from its bytes, and lists for editors only (criteria 4, 5, 29)", async () => {
  const owner = await api(OWNER);
  const mp4 = await upload(owner, "loop.mp4", "video/mp4", MP4, "video");
  expect(mp4.status()).toBe(201);
  expect(await mp4.json()).toMatchObject({ mime: "video/mp4", kind: "video", name: "loop.mp4" });
  const webm = await upload(owner, "loop.webm", "video/webm", WEBM, "media");
  expect(webm.status()).toBe(201);
  usedVideo = (await webm.json()).path;
  // A second distinct WebM (different bytes) the app will not use.
  const other = await upload(owner, "other.webm", "video/webm", Buffer.concat([WEBM, Buffer.from([0])]), "video");
  otherVideo = (await other.json()).path;
  // Criterion 5: a program renamed .mp4 is refused from its bytes.
  const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "binary"), Buffer.alloc(4096, 0x41)]);
  const bad = await upload(owner, "movie.mp4", "video/mp4", exe, "video");
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error.message).toBe("This file type is not allowed. Upload a video (MP4 or WebM).");
  // Criterion 29 (uploads part): the listing answers owners and members, newest first, and not found for viewers.
  const list = await (await owner.get("/api/settings/uploads?kind=video")).json();
  expect(list.items.map((i: { name: string }) => i.name)).toEqual(["other.webm", "loop.webm", "loop.mp4"]);
  expect(JSON.stringify(list)).not.toMatch(/createdBy|created_by|userId/);
  const member = await api(MEMBER);
  expect((await member.get("/api/settings/uploads?kind=image")).status()).toBe(200);
  const viewer = await api(VIEWER);
  const v = await viewer.get("/api/settings/uploads");
  expect(v.status()).toBe(404);
  expect((await upload(viewer, "x.webm", "video/webm", WEBM, "video")).status()).toBe(403);
  const anon = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: H });
  const a = await anon.get("/api/settings/uploads");
  log("listing access", { viewer: v.status(), anonymous: a.status() });
  expect([401, 404]).toContain(a.status());
  // A7.1: a single byte range answers 206, inline, with the upload sandbox headers.
  const r = await owner.get(usedVideo, { headers: { range: "bytes=0-99" } });
  expect(r.status()).toBe(206);
  expect(r.headers()["content-range"]).toBe(`bytes 0-99/${WEBM.length}`);
  expect(r.headers()["accept-ranges"]).toBe("bytes");
  expect(r.headers()["content-disposition"]).toBe("inline");
  expect(r.headers()["content-type"]).toBe("video/webm");
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
  expect(r.headers()["content-security-policy"]).toContain("sandbox");
  expect((await r.body()).length).toBe(100);
  expect((await owner.get(usedVideo, { headers: { range: `bytes=${WEBM.length}-` } })).status()).toBe(416);
  const full = await owner.get(usedVideo);
  expect(full.status()).toBe(200);
  expect((await full.body()).equals(WEBM)).toBe(true);
});

test("a 30 MB video is refused in the inspector before it uploads, and Your uploads picks a video newest first (criteria 4, 6)", async ({ browser }) => {
  const c = await api(OWNER);
  const d = await draft(appId);
  const add = await c.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_mvideoaaaa", type: "video", props: { alt: "Test pattern" }, slot: { x: 6, y: 0, w: 6, h: 30 } } }] } });
  expect(add.ok()).toBe(true);
  const ctx = await ctxFor(browser, OWNER);
  const page = await ctx.newPage();
  await openBuilder(page, slug, "c_mvideoaaaa");
  await expect(page.locator('[data-canvas-root] [data-node="c_mvideoaaaa"] [data-video-placeholder]')).toBeVisible();
  const field = page.locator('[data-media-field="video"]');
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/settings/uploads")) posts.push(r.url());
  });
  const huge = Buffer.alloc(30 * 1024 * 1024);
  MP4.copy(huge);
  await field.locator("[data-media-input]").setInputFiles({ name: "huge.mp4", mimeType: "video/mp4", buffer: huge });
  await expect(field.locator("[data-media-message]")).toHaveText("Videos can be at most 25 MB. This one is 30.0 MB.");
  expect(posts).toEqual([]);
  await page.screenshot({ path: ev("screens", "video-too-large.png") });
  // Your uploads: newest first, search by name, picking sets the video.
  await field.locator("[data-media-library]").click();
  const sheet = page.locator('[data-sheet="media-library"]');
  const items = sheet.locator("[data-media-item]");
  await expect(items).toHaveCount(3);
  expect(await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-media-item")))).toEqual(["other.webm", "loop.webm", "loop.mp4"]);
  await sheet.locator("[data-media-search]").fill("loop.w");
  await expect(items).toHaveCount(1);
  await page.screenshot({ path: ev("screens", "your-uploads-videos.png") });
  await items.first().click();
  await expect(sheet).toBeHidden();
  const dd = await untilDraft(appId, (x) => nodeIn(x, "c_mvideoaaaa").props.src === usedVideo);
  expect(nodeIn(dd, "c_mvideoaaaa").props.src).toBe(usedVideo);
  // Criterion 3 (edit mode part): the picked video plays muted and looping on the canvas.
  await expectPlaying(page, '[data-canvas-root] [data-node="c_mvideoaaaa"]');
  await page.screenshot({ path: ev("screens", "video-edit-mode.png") });
  await ctx.close();
});

test("the published viewer plays the video muted and looping; reduced motion keeps it on its first frame with a play button, and shows the GIF note (criteria 3, 7; V4, V8)", async ({ browser }) => {
  const owner = await api(OWNER);
  const gif = await (await upload(owner, "anim.gif", "image/gif", GIF, "image")).json();
  const d = await draft(appId);
  const add = await owner.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_mgifaaaaaa", type: "image", props: { src: gif.path, alt: "Animated" }, slot: { x: 0, y: 30, w: 6, h: 30 } } }] } });
  expect(add.ok()).toBe(true);
  // V4: the published app in the three user-app themes (architecture A1.7).
  for (const theme of ["control-room", "dusk", "solid"]) {
    const dd = await draft(appId);
    const t = await owner.post(`/api/apps/${appId}/ops`, { data: { rev: dd.rev, ops: [{ op: "theme.set", theme: { themeId: theme } }] } });
    expect(t.ok()).toBe(true);
    await publish(appId);
    const ctx = await ctxFor(browser, OWNER);
    const page = await ctx.newPage();
    await page.goto(`/a/${slug}`);
    const s = await expectPlaying(page, '[data-node="c_mvideoaaaa"]');
    log(`viewer ${theme}`, s);
    await expect(page.locator('[data-node="c_mvideoaaaa"] [data-video-play]')).toHaveCount(0);
    await page.screenshot({ path: ev("screens", `viewer-video-${theme}.png`) });
    await ctx.close();
  }
  // Reduced motion: paused on the first frame, a play button, and pressing it plays.
  const rm = await ctxFor(browser, OWNER, { reducedMotion: "reduce" });
  const page = await rm.newPage();
  await page.goto(`/a/${slug}`);
  const play = page.locator('[data-node="c_mvideoaaaa"] [data-video-play]');
  await expect(play).toBeVisible();
  await expect.poll(async () => (await videoState(page, '[data-node="c_mvideoaaaa"]')).ready, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(800);
  const still = await videoState(page, '[data-node="c_mvideoaaaa"]');
  log("reduced motion", still);
  expect(still.paused).toBe(true);
  expect(still.time).toBe(0);
  await page.screenshot({ path: ev("screens", "viewer-video-reduced-motion.png") });
  await play.click();
  await expectPlaying(page, '[data-node="c_mvideoaaaa"]');
  await expect(play).toHaveCount(0);
  // The GIF note under an animated picture in the builder, with reduced motion on.
  const b = await rm.newPage();
  await openBuilder(b, slug, "c_mgifaaaaaa");
  await expect(b.locator("[data-media-gif-note]")).toHaveText("Animated pictures keep playing for people with reduced motion on. Use a Video if you want it to pause.");
  await b.screenshot({ path: ev("screens", "gif-note-reduced-motion.png") });
  await rm.close();
  // Without reduced motion, no note.
  const plain = await ctxFor(browser, OWNER);
  const p2 = await plain.newPage();
  await openBuilder(p2, slug, "c_mgifaaaaaa");
  await expect(p2.locator('[data-media-field="image"]')).toBeVisible();
  await expect(p2.locator("[data-media-gif-note]")).toHaveCount(0);
  await plain.close();
});

test("a guest sees the video the published version uses and is refused one it does not (criterion 8)", async ({ browser }) => {
  const owner = await api(OWNER);
  const access = await owner.put(`/api/apps/${appId}/access`, { data: { view: "owner", edit: "owner", guests: true } });
  expect(access.ok()).toBe(true);
  const made = await owner.post("/api/auth/atrium/guest-links", { data: { appId, label: "Media guest" } });
  const link = await made.json();
  log("guest link", { status: made.status(), hasUrl: typeof link.url === "string" });
  const g = await ctxFor(browser, null, { viewport: { width: 390, height: 844 }, mobile: true });
  const page = await g.newPage();
  await page.goto(new URL(link.url).pathname);
  await page.waitForURL(new RegExp(`/a/${slug}`));
  await expectPlaying(page, '[data-node="c_mvideoaaaa"]');
  await page.screenshot({ path: ev("screens", "guest-video-390.png"), fullPage: true });
  const used = await page.request.get(usedVideo, { headers: { range: "bytes=0-" } });
  expect(used.status()).toBe(206);
  const notUsed = await page.request.get(otherVideo);
  expect(notUsed.status()).toBe(404);
  const ranged = await page.request.get(otherVideo, { headers: { range: "bytes=0-10" } });
  expect(ranged.status()).toBe(404);
  // The guest is refused the uploads listing too (criterion 29).
  const list = await page.request.get("/api/settings/uploads");
  log("guest", { used: used.status(), notUsed: notUsed.status(), list: list.status() });
  expect(list.status()).not.toBe(200);
  expect(await list.text()).not.toContain("/uploads/");
  await g.close();
});

test("at 390px the media field's controls are at least 44px tall and nothing scrolls sideways (criterion 30, uploads part; V5)", async ({ browser }) => {
  const ctx = await ctxFor(browser, OWNER, { viewport: { width: 390, height: 844 }, mobile: true });
  const page = await ctx.newPage();
  await page.goto(`/build/${slug}`);
  // Under 900px the builder shows one view at a time: Canvas, Layers, Edit.
  await expect(page.locator("[data-narrow-tab]")).toHaveText(["Canvas", "Layers", "Edit"]);
  await page.locator("[data-narrow-tab]", { hasText: "Layers" }).click();
  await page.locator('[data-layer="c_mvideoaaaa"]').click();
  await page.locator("[data-narrow-tab]", { hasText: "Edit" }).click();
  const field = page.locator('[data-media-field="video"]');
  await expect(field).toBeVisible();
  await field.scrollIntoViewIfNeeded();
  for (const sel of ["[data-media-upload]", "[data-media-library]", "[data-media-paste] > summary"]) {
    const box = await field.locator(sel).boundingBox();
    log("390 control", { sel, h: box?.height });
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ev("screens", "media-field-390.png") });
  await field.locator("[data-media-library]").click();
  const sheet = page.locator('[data-sheet="media-library"]');
  await expect(sheet.locator("[data-media-item]").first()).toBeVisible();
  await page.waitForTimeout(600); // the bottom sheet's slide-in
  const item = await sheet.locator("[data-media-item]").first().boundingBox();
  expect(item!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: ev("screens", "your-uploads-390.png") });
  await ctx.close();
});

test("a 20 MB MP4 uploads through the Video inspector, and a 26 MB one is refused naming the limit (criterion 4)", async ({ browser }) => {
  // Needs next.config.ts `experimental.proxyClientMaxBodySize` above 25 MB (shared file request): the
  // proxy otherwise cuts every request body at 10 MB and the form cannot be read.
  const ctx = await ctxFor(browser, OWNER);
  const page = await ctx.newPage();
  await openBuilder(page, slug, "c_mvideoaaaa");
  const field = page.locator('[data-media-field="video"]');
  const big = Buffer.alloc(20 * 1024 * 1024);
  MP4.copy(big);
  const answer = page.waitForResponse((r) => r.url().includes("/api/settings/uploads") && r.request().method() === "POST", { timeout: 60_000 });
  await field.locator("[data-media-input]").setInputFiles({ name: "twenty.mp4", mimeType: "video/mp4", buffer: big });
  const r = await answer;
  log("20 MB upload", { status: r.status() });
  expect(r.status()).toBe(201);
  await expect(field.locator("[data-media-message]")).toHaveText("");
  const d = await untilDraft(appId, (x) => String(nodeIn(x, "c_mvideoaaaa").props.src).endsWith(".mp4"));
  expect(String(nodeIn(d, "c_mvideoaaaa").props.src)).toMatch(/^\/uploads\/[a-z0-9]{20}\.mp4$/);
  // Past the browser check (a request sent straight to the server): refused with the limit and the size.
  const over = Buffer.alloc(Math.round(25.5 * 1024 * 1024));
  MP4.copy(over);
  const o = await upload(await api(OWNER), "over.mp4", "video/mp4", over, "video");
  log("25.5 MB upload", { status: o.status(), body: (await o.text()).slice(0, 300) });
  expect(o.status()).toBe(413);
  expect((await o.json()).error.message).toBe("Videos can be at most 25 MB. This one is 25.5 MB.");
  await ctx.close();
});
