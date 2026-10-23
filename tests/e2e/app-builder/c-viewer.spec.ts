// app-builder e2e, part C: preview, controls, publish, versions, settings, guests, containment, install
// (criteria 17 to 23, 26 to 28, 31, 33, 35 to 41, 47, 48; V4 app themes, V5, V6 publish glow, V10).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addUser, api, auditCount, captureTraffic, contextFor, controlRunCount, ev, FAKE_HA_TOKEN, fakeHa, log, OWNER, PEOPLE, saveText, SHELL_VARIANTS, userId, type FakeHa } from "./helpers";

test.describe.configure({ mode: "serial" });
// Each test makes its own contexts and phone widths (as in round 1, run on the desktop project only); a
// second pass on the mobile project would meet the first pass's apps in the same slot database.
test.skip(({ isMobile }) => isMobile, "desktop project; phone widths are set per test");

let ha: FakeHa;
let haId = "";
let appId = "";
const SLUG = "lounge";
const LAMP = "k_lampctrlaa";
const allBodies: { url: string; body: string }[] = [];

async function owner() {
  return api(OWNER);
}
async function draftOf(id = appId) {
  return (await (await owner()).get(`/api/apps/${id}/draft`)).json() as Promise<{ rev: number; doc: { pages: { id: string; slug: string; root: { id: string; children?: { id: string; type: string; props: Record<string, unknown> }[] } }[]; controls: { id: string; label: string }[] } }>;
}
async function ops(list: unknown[], id = appId) {
  const d = await draftOf(id);
  const r = await (await owner()).post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
  return r.json();
}
async function publish(note: string, id = appId) {
  const c = await owner();
  const review = await (await c.get(`/api/apps/${id}/review`)).json();
  const r = await c.post(`/api/apps/${id}/publish`, { data: { expectRev: review.rev, note } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
  return r.json() as Promise<{ version: number }>;
}
function track(page: Page, name: string) {
  const t = captureTraffic(page, name);
  page.on("close", () => { for (const b of t.bodies) allBodies.push({ url: b.url, body: b.body }); });
  return t;
}

test.beforeAll(async ({}, info) => {
  if (info.project.name !== "desktop") return; // the tests skip on other projects (see the skip above)
  for (const p of Object.values(PEOPLE)) await addUser(p);
  ha = await fakeHa();
  const c = await owner();
  const created = await (await c.post("/api/integrations", { data: { packageId: "home-assistant", name: "Home Assistant", config: { baseUrl: ha.url }, secrets: { token: FAKE_HA_TOKEN }, untested: true } })).json();
  haId = created.id;
  expect(haId).toBeTruthy();
  const app = await (await c.post("/api/apps", { data: { name: "Lounge", slug: SLUG, template: "guest-room", mappings: { ha: haId } } })).json();
  appId = app.app.id;
  const d = await draftOf();
  const root = d.doc.pages[0]!.root;
  const toggle = root.children!.find((n) => n.type === "toggle")!;
  const button = root.children!.find((n) => n.type === "button")!;
  const lampCtl = d.doc.controls.find((x) => x.label === "Lamp")!;
  const sceneCtl = d.doc.controls.find((x) => x.label === "Evening scene")!;
  await ops([
    { op: "node.remove", nodeId: button.id },
    { op: "control.remove", controlId: sceneCtl.id },
    { op: "control.remove", controlId: lampCtl.id },
    { op: "control.set", control: { id: LAMP, label: "Bedroom lamp", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: "light.lamp" } }, cooldownMs: 250 } },
    { op: "node.update", nodeId: toggle.id, patch: { props: { label: "Bedroom lamp", control: LAMP, state: { $bind: '{{ ha.find("entity_id", "light.lamp").state == "on" }}' } } } },
    { op: "source.set", source: { name: "ha", integrationId: haId, endpointId: "states", refreshSec: 10 } },
  ]);
  await publish("first");
  await (await owner()).put(`/api/apps/${appId}/access`, { data: { view: { userIds: [userId(PEOPLE.watcher.email)] }, edit: "owner", guests: true } });
});

test.afterAll(async () => {
  await ha?.close();
});

test("?draft=1 shows the draft with the preview bar to an editor and the published version to a non-editor (criterion 17)", async ({ browser }) => {
  await ops([{ op: "node.update", nodeId: (await draftOf()).doc.pages[0]!.root.children!.find((n) => n.type === "heading")!.id, patch: { props: { text: "Welcome (draft)", level: 1 } } }]);
  const o = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0] });
  const op = await o.newPage();
  track(op, "draft-preview-owner");
  await op.goto(`/a/${SLUG}?draft=1`);
  await expect(op.locator("[data-draft-preview-bar] .msg, [data-draft-preview-bar] p")).toHaveText(/Draft preview · rev \d+ · controls here are real/);
  await expect(op.getByText("Welcome (draft)")).toBeVisible();
  await op.screenshot({ path: ev("screens", "draft-preview-light.png") });
  await o.close();
  const w = await contextFor(browser, PEOPLE.watcher);
  const wp = await w.newPage();
  await wp.goto(`/a/${SLUG}?draft=1`);
  await expect(wp.getByText("Welcome", { exact: true })).toBeVisible();
  await expect(wp.getByText("Welcome (draft)")).toHaveCount(0);
  await expect(wp.locator("[data-draft-preview-bar]")).toHaveCount(0);
  await w.close();
});

test("a draft preview click asks first; cancel runs nothing; a draft-only control says Not published yet (criterion 18)", async ({ browser }) => {
  const runs = controlRunCount(appId);
  const services = ha.services.length;
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0] });
  const page = await ctx.newPage();
  await page.goto(`/a/${SLUG}?draft=1`);
  await page.getByRole("switch", { name: "Bedroom lamp" }).click();
  await expect(page.locator("[data-confirm-title]")).toHaveText("Draft preview: run Bedroom lamp for real?");
  await page.screenshot({ path: ev("screens", "draft-confirm-light.png") });
  await page.locator("[data-confirm-cancel]").click();
  await page.waitForTimeout(500);
  expect(controlRunCount(appId)).toBe(runs);
  expect(ha.services.length).toBe(services);
  // A control that exists only in the draft.
  const root = (await draftOf()).doc.pages[0]!.root.id;
  await ops([
    { op: "control.set", control: { id: "k_porchctlaa", label: "Porch", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: "light.porch" } } } },
    { op: "node.add", parentId: root, node: { id: "c_porchbtnaa", type: "button", props: { label: "Porch", control: "k_porchctlaa" }, slot: { x: 0, y: 30, w: 4, h: 6 } } },
  ]);
  await page.reload();
  await page.getByRole("button", { name: "Porch" }).click();
  await expect(page.locator("[data-confirm-title]")).toHaveText("Draft preview: run Porch for real?");
  await expect(page.locator("[data-control-confirm] .text")).toHaveText("Not published yet");
  await page.locator("[data-confirm-cancel]").click();
  await page.waitForTimeout(300);
  expect(controlRunCount(appId)).toBe(runs);
  // Confirming runs it for real, with the draft flag.
  await page.getByRole("switch", { name: "Bedroom lamp" }).click();
  await page.locator("[data-confirm-run]").click();
  await expect.poll(() => ha.services.length, { timeout: 5000 }).toBe(services + 1);
  expect(ha.services.at(-1)).toMatchObject({ path: "/api/services/light/toggle", body: { entity_id: "light.lamp" } });
  await ctx.close();
});

test("a draft preview page whose HTML block calls a control on load runs nothing (criterion 19)", async ({ browser }) => {
  const runs = controlRunCount(appId);
  const services = ha.services.length;
  const root = (await draftOf()).doc.pages[0]!.root.id;
  await ops([{ op: "node.add", parentId: root, node: { id: "c_htmlautoaa", type: "html", name: "Auto runner", props: { html: "<p id=s>block</p>", js: `atrium.control("${LAMP}", {}).then((r) => { document.getElementById("s").textContent = "result " + JSON.stringify(r); });`, data: {}, controls: [LAMP], height: 60 }, slot: { x: 0, y: 40, w: 6, h: 8 } } }]);
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/a/${SLUG}?draft=1`);
  await page.waitForTimeout(2500);
  const confirmOpen = await page.locator("[data-control-confirm][open]").count();
  log("html block on load", { confirmOpen, runsBefore: runs, runsAfter: controlRunCount(appId), servicesBefore: services, servicesAfter: ha.services.length });
  if (confirmOpen) await page.locator("[data-confirm-cancel]").click();
  expect(controlRunCount(appId)).toBe(runs);
  expect(ha.services.length).toBe(services);
  await ctx.close();
  await ops([{ op: "node.remove", nodeId: "c_htmlautoaa" }]);
});

test("an agent preview render draws controls disabled and a click runs nothing (criterion 20)", async ({ browser }) => {
  const runs = controlRunCount(appId);
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/a/${SLUG}?draft=1&render=1`);
  const sw = page.getByRole("switch", { name: "Bedroom lamp" });
  await expect(sw).toBeVisible();
  const disabled = await sw.evaluate((el) => (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true");
  await sw.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  log("agent render", { disabled, confirm: await page.locator("[data-control-confirm][open]").count() });
  expect(disabled).toBe(true);
  expect(await page.locator("[data-control-confirm][open]").count()).toBe(0);
  expect(controlRunCount(appId)).toBe(runs);
  await page.screenshot({ path: ev("screens", "agent-render.png") });
  await ctx.close();
});

test("the publish review lists diff, authors, controls and problems; an error disables Publish; publishing shows v-next (criteria 21, 23; V4, V6 glow)", async ({ browser }) => {
  const root = (await draftOf()).doc.pages[0]!.root.id;
  // A button left pointing at a control removed later: refused at publish, not at edit time.
  await ops([
    { op: "control.set", control: { id: "k_missingctl", label: "Soon gone", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: "light.lamp" } } } },
    { op: "node.add", parentId: root, node: { id: "c_brokenbtna", type: "button", props: { label: "Broken", control: "k_missingctl" }, slot: { x: 6, y: 30, w: 4, h: 6 } } },
  ]);
  await ops([{ op: "control.remove", controlId: "k_missingctl" }]);
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await page.goto(`/build/${SLUG}`);
    await page.locator("[data-publish]").click();
    await expect(page.locator("[data-review]")).toBeVisible();
    await expect(page.locator('[data-review-control="Porch"]')).toContainText("home-assistant · light.toggle light.porch");
    await expect(page.locator('[data-review-author="person"]')).toContainText("owner");
    await expect(page.locator('[data-review-problem="error"]').first()).toBeVisible();
    await expect(page.locator("[data-publish-confirm]")).toBeDisabled();
    await expect(page.locator("[data-review-note]")).toBeVisible();
    await page.screenshot({ path: ev("screens", `publish-review-blocked-${v.name}.png`) });
    await ctx.close();
  }
  await ops([{ op: "node.remove", nodeId: "c_brokenbtna" }]);
  const before = (await (await owner().then((c) => c.get(`/api/apps/${appId}/versions`))).json()).versions.length as number;
  const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[0], recordVideo: ev("video", "publish") });
  const page = await ctx.newPage();
  await page.goto(`/build/${SLUG}`);
  await page.locator("[data-publish]").click();
  await expect(page.locator("[data-publish-confirm]")).toBeEnabled();
  await page.locator("[data-review-note]").fill("Porch button");
  await page.screenshot({ path: ev("screens", "publish-review-light.png") });
  await page.locator("[data-publish-confirm]").click();
  await expect(page.locator("[data-publish-glow]")).toBeAttached();
  await page.waitForTimeout(1200);
  const versions = (await (await owner().then((c) => c.get(`/api/apps/${appId}/versions`))).json()).versions as { version: number; note?: string; by: string }[];
  expect(versions.length).toBe(before + 1);
  expect(versions[0]).toMatchObject({ note: "Porch button", by: "owner" });
  expect(auditCount("app.published", appId)).toBeGreaterThanOrEqual(2);
  await ctx.close();
  const w = await contextFor(browser, PEOPLE.watcher);
  const wp = await w.newPage();
  await wp.goto(`/a/${SLUG}`);
  await expect(wp.getByRole("button", { name: "Porch" })).toBeVisible();
  await w.close();
});

test("publish is refused when the draft changed after the review opened (criterion 26)", async ({ browser }) => {
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/build/${SLUG}`);
  await page.locator("[data-publish]").click();
  await expect(page.locator("[data-publish-confirm]")).toBeEnabled();
  const before = ((await (await owner().then((c) => c.get(`/api/apps/${appId}/versions`))).json()).versions as unknown[]).length;
  await ops([{ op: "node.update", nodeId: "c_porchbtnaa", patch: { props: { label: "Porch light", control: "k_porchctlaa" } } }]);
  await page.locator("[data-publish-confirm]").click();
  await expect(page.locator("[data-review-error]")).toHaveText("The draft changed; review again");
  expect(((await (await owner().then((c) => c.get(`/api/apps/${appId}/versions`))).json()).versions as unknown[]).length).toBe(before);
  await ctx.close();
});

test("versions: timeline, side-by-side preview, diff lines by page; restore through the review (criteria 27, 28; V4)", async ({ browser }) => {
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await page.goto(`/build/${SLUG}/versions`);
    await expect(page.locator("[data-version-card]").first()).toBeVisible();
    await page.locator('[data-version-card="2"]').click();
    await expect(page.locator('[data-diff-line="added"]').first()).toBeVisible();
    await expect(page.locator("[data-version-preview]")).toHaveCount(2);
    await page.waitForTimeout(800);
    await page.screenshot({ path: ev("screens", `versions-${v.name}.png`), fullPage: true });
    await ctx.close();
  }
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/build/${SLUG}/versions`);
  await page.locator('[data-version-card="1"]').click();
  await page.locator('[data-restore="1"]').click();
  await expect(page.locator("[data-review-meta]")).toContainText("v1 against the live version");
  await expect(page.locator("[data-review-discard]")).toBeVisible();
  await page.screenshot({ path: ev("screens", "restore-review-light.png") });
  await page.locator("[data-publish-confirm]").click();
  await expect(page.locator('[data-version-card] >> text=restore').first()).toBeVisible();
  const versions = (await (await owner().then((c) => c.get(`/api/apps/${appId}/versions`))).json()).versions as { version: number; source: string; restoredFrom?: number }[];
  expect(versions[0]).toMatchObject({ source: "restore", restoredFrom: 1 });
  expect(auditCount("app.restored", appId)).toBe(1);
  await ctx.close();
  // Back to the Porch version for the rest of the run.
  const c = await owner();
  const review = await (await c.get(`/api/apps/${appId}/review?restore=2`)).json();
  await c.post(`/api/apps/${appId}/restore`, { data: { version: 2, expectRev: review.rev } });
});

test("a viewed app in Control Room, Dusk and Solid; mobile viewer (V4, V5)", async ({ browser }) => {
  for (const theme of ["control-room", "dusk", "solid"]) {
    await ops([{ op: "theme.set", theme: { themeId: theme } }]);
    await publish(`theme ${theme}`);
    const ctx = await contextFor(browser, PEOPLE.watcher);
    const page = await ctx.newPage();
    await page.goto(`/a/${SLUG}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: ev("screens", `app-${theme}.png`) });
    await ctx.close();
  }
  await ops([{ op: "theme.set", theme: { themeId: "control-room" } }]);
  await publish("back to control room");
  const m = await contextFor(browser, PEOPLE.watcher, { viewport: { width: 390, height: 844 }, mobile: true });
  const mp = await m.newPage();
  await mp.goto(`/a/${SLUG}`);
  await mp.waitForTimeout(800);
  await mp.screenshot({ path: ev("screens", "mobile-viewer.png"), fullPage: true });
  await m.close();
});

test("the app's own nav lists exactly the in-nav pages; a hidden page opens by link (criterion 37)", async ({ browser }) => {
  await ops([
    { op: "chrome.update", patch: { layout: "topbar" } },
    { op: "page.add", page: { id: "p_lightsaaaa", slug: "lights", title: "Lights", inNav: true, root: { id: "c_lightsroot", type: "grid", props: {}, children: [] } } },
    { op: "page.add", page: { id: "p_secretaaaa", slug: "secret", title: "Secret", inNav: false, root: { id: "c_secretroot", type: "grid", props: {}, children: [{ id: "c_secrettext", type: "text", props: { text: "Hidden page" }, slot: { x: 0, y: 0, w: 6, h: 6 } }] } } },
  ]);
  await publish("pages");
  const ctx = await contextFor(browser, PEOPLE.watcher);
  const page = await ctx.newPage();
  await page.goto(`/a/${SLUG}`);
  await expect(page.locator("[data-app-nav-item]")).toHaveText(["Room", "Lights"]);
  await page.goto(`/a/${SLUG}/secret`);
  await expect(page.getByText("Hidden page")).toBeVisible();
  await page.goto(`/a/${SLUG}/nope`);
  await expect(page.locator("[data-app-page=missing] [data-room-title]")).toHaveText("This room does not exist.");
  await ctx.close();
});

test("hostile chrome CSS leaves every pixel outside the app canvas unchanged, in the viewer and the builder (criterion 36)", async ({ browser }) => {
  let n = 0;
  // The draft status text (rev and change count) changes with every edit; give its mask box a fixed size.
  const pin = (page: Page) => page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => setTimeout(r, 300)); const el = document.querySelector<HTMLElement>("[data-draft-status]"); if (el) { el.style.width = "420px"; el.style.flex = "none"; } });
  const hash = async (page: Page) => (await pin(page), createHash)("sha256").update(await page.screenshot({ path: ev("screens", `containment-masked-${++n}.png`), animations: "disabled", mask: [page.locator("[data-atrium-canvas-frame]"), page.locator("[data-draft-status]"), page.locator("[data-clock]"), page.locator("[data-draft-preview-bar] .msg")], maskColor: "#ff00ff" })).digest("hex");
  const hostile = ":scope nav, [data-canvas-nav] { position: absolute; top: -600px; left: -50vw; width: 200vw; height: 1200px; background: rgb(255, 0, 0); z-index: 2147483647; box-shadow: 0 0 0 4000px red; } :scope { margin: -400px; outline: 999px solid red; }";
  const shots: Record<string, string> = {};
  for (const where of ["viewer", "builder"] as const) {
    // The viewer half uses the published version (the draft bar's rev would change between shots).
    const url = where === "viewer" ? `/a/${SLUG}` : `/build/${SLUG}`;
    await ops([{ op: "chrome.update", patch: { css: null } }]);
    if (where === "viewer") await publish("containment baseline");
    // Reduce transparency: Atrium's floating glass over the app is opaque, so only what the app paints is compared.
    const ctx = await contextFor(browser, OWNER, { variant: SHELL_VARIANTS[2] });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.mouse.move(1, 1);
    await page.waitForTimeout(800);
    shots[`${where}-before`] = await hash(page);
    await ops([{ op: "chrome.update", patch: { css: hostile } }]);
    if (where === "viewer") await publish("hostile chrome css");
    await page.reload();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(800);
    shots[`${where}-after`] = await hash(page);
    await page.screenshot({ path: ev("screens", `hostile-css-${where}.png`) });
    await ctx.close();
  }
  // Exact hashes, plus a pixel count: differences over 48 in a channel (anti-aliasing at layer edges is below that).
  const diff = async (a: number, b: number) => {
    const p = await browser.newPage();
    const [x, y] = [readFileSync(ev("screens", `containment-masked-${a}.png`)).toString("base64"), readFileSync(ev("screens", `containment-masked-${b}.png`)).toString("base64")];
    const r = await p.evaluate(async ([x, y]) => {
      const load = (s: string) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = `data:image/png;base64,${s}`; });
      const [i, j] = await Promise.all([load(x!), load(y!)]);
      const px = (img: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d")!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const d1 = px(i), d2 = px(j);
      let big = 0, red = 0;
      for (let k = 0; k < d1.length; k += 4) {
        const m = Math.max(Math.abs(d1[k]! - d2[k]!), Math.abs(d1[k + 1]! - d2[k + 1]!), Math.abs(d1[k + 2]! - d2[k + 2]!));
        if (m > 48) big++;
        if (d2[k]! > 200 && d2[k + 1]! < 60 && d2[k + 2]! < 60) red++;
      }
      return { big, red, size: [i.width, i.height] };
    }, [x, y]);
    await p.close();
    return r;
  };
  const result = { hashes: shots, viewer: await diff(1, 2), builder: await diff(3, 4) };
  log("containment", result);
  saveText("logs/containment.json", JSON.stringify(result, null, 2));
  expect(shots["viewer-after"]).toBe(shots["viewer-before"]);
  expect(result.builder.big).toBe(0);
  expect(result.builder.red).toBe(0);
  expect(result.viewer.red).toBe(0);
  await ops([{ op: "chrome.update", patch: { css: null } }]);
  await publish("chrome css removed");
});

test("each app serves its own manifest with its name, 192 and 512 icons, start and scope at /a/<slug> (criterion 47; round 2 item 4: the canonical address)", async () => {
  const c = await owner();
  const other = await (await c.post("/api/apps", { data: { name: "Garage", slug: "garage" } })).json();
  await (async () => { const d = await draftOf(other.app.id); await c.post(`/api/apps/${other.app.id}/ops`, { data: { rev: d.rev, ops: [{ op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_garagetxta", type: "text", props: { text: "Garage" }, slot: { x: 0, y: 0, w: 4, h: 6 } } }] } }); })();
  await publish("first", other.app.id);
  const manifests = [];
  for (const slug of [SLUG, "garage"]) {
    const r = await c.get(`/a/${slug}/manifest.webmanifest`);
    expect(r.status()).toBe(200);
    const m = await r.json();
    manifests.push(m);
    expect(m.start_url).toBe(`/a/${slug}`);
    expect(m.scope).toBe(`/a/${slug}`);
    expect(m.id).toBe(`/a/${slug}/`);
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(["192x192", "512x512"]);
    const sw = await c.get(`/a/${slug}/sw.js`);
    expect(sw.status()).toBe(200);
    expect(sw.headers()["service-worker-allowed"]).toBe(`/a/${slug}`);
  }
  expect(manifests.map((m) => m.name)).toEqual(["Lounge", "Garage"]);
  saveText("logs/manifests.json", JSON.stringify(manifests, null, 2));
});

test("guests: resolved values only, fixed targets, nothing else reachable, installable while the link lives (criteria 39, 40, 41, 48; V5)", async ({ browser }) => {
  const c = await owner();
  const link = await (await c.post("/api/auth/atrium/guest-links", { data: { appId, label: "Guest room, Sam" } })).json();
  expect(link.url).toContain("/g/");
  const token = new URL(link.url).pathname;
  const g = await contextFor(browser, null, { viewport: { width: 390, height: 844 }, mobile: true });
  const page = await g.newPage();
  const traffic = track(page, "guest");
  await page.goto(token);
  await page.waitForURL(new RegExp(`/a/${SLUG}`));
  await expect(page.getByRole("switch", { name: "Bedroom lamp" })).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: ev("screens", "mobile-guest-app.png"), fullPage: true });
  // Criterion 39: no response holds any other entity's id or state.
  const leaked = traffic.bodies.filter((b) => /light\.secret_room_|light\.porch|Hidden \d/.test(b.body));
  log("guest leak check", { responses: traffic.bodies.length, leaked: leaked.map((l) => l.url) });
  saveText("network/guest-bodies.json", JSON.stringify(traffic.bodies.map((b) => ({ url: b.url, status: b.status, body: b.body.slice(0, 4000) })), null, 2));
  expect(leaked).toEqual([]);
  // Criterion 40: a run carrying another target never reaches it.
  const before = ha.services.length;
  const doc = await (await c.get(`/api/apps/${appId}/draft`)).json();
  const toggleId = doc.doc.pages.find((p: { slug: string }) => p.slug === "room").root.children.find((n: { type: string }) => n.type === "toggle").id;
  const bad = await page.request.post("/api/controls/run", { data: { appId, nodeId: toggleId, controlId: LAMP, input: { entityId: "light.secret_room_01" } }, headers: { origin: page.url().replace(/\/a\/.*$/, "") } });
  expect(bad.status()).toBe(400);
  const ok = await page.request.post("/api/controls/run", { data: { appId, nodeId: toggleId, controlId: LAMP, input: true }, headers: { origin: page.url().replace(/\/a\/.*$/, "") } });
  log("guest runs", { bad: await bad.json(), ok: await ok.json() });
  expect(ok.status()).toBe(200);
  expect(ha.services.slice(before).map((s) => (s.body as { entity_id: string }).entity_id)).toEqual(["light.lamp"]);
  // Criterion 41: no other app, no draft, no builder, no launcher. The published version already holds
  // "Welcome (draft)" (published by the theme test above), so a draft-only heading is set for this check.
  // Since the Wave 2 lead integration (item A, A4) a guest asking for ?draft=1 gets the published page (200),
  // never the draft and never the draft preview bar.
  const heading = (await draftOf()).doc.pages[0]!.root.children!.find((n) => n.type === "heading")!.id;
  await ops([{ op: "node.update", nodeId: heading, patch: { props: { text: "Unpublished guest probe", level: 1 } } }]);
  for (const p of ["/a/garage", `/a/${SLUG}?draft=1`, `/build/${SLUG}`, "/", "/api/apps"]) {
    const r = await page.request.get(p, { maxRedirects: 0 });
    const body = await r.text();
    log("guest reach", { p, status: r.status(), location: r.headers().location ?? null });
    expect(body).not.toContain("Garage");
    expect(body).not.toContain("Unpublished guest probe");
    expect(body).not.toContain("data-draft-preview-bar");
    if (p === `/a/${SLUG}?draft=1`) expect(r.status()).toBe(200);
    expect(r.status() === 200 && p !== "/api/apps" ? body.includes("data-builder") || body.includes("data-launcher") : false).toBe(false);
  }
  await ops([{ op: "node.update", nodeId: heading, patch: { props: { text: "Welcome (draft)", level: 1 } } }]);
  // Criterion 48: the manifest and worker answer while the link lives; after revoke, the expired screen.
  expect((await page.request.get(`/a/${SLUG}/manifest.webmanifest`)).status()).toBe(200);
  const revoke = await c.post(`/api/auth/atrium/guest-links/${link.link.id}/revoke`, { data: {} });
  expect(revoke.ok()).toBe(true);
  await page.goto(`/a/${SLUG}`);
  await expect(page.getByText("This link has expired or was turned off")).toBeVisible();
  await g.close();
});

test("settings: audience saved and audited; guests off ends links for good; delete after typing the name (criteria 31, 33, 35; V4)", async ({ browser }) => {
  const c = await owner();
  for (const v of SHELL_VARIANTS) {
    const ctx = await contextFor(browser, OWNER, { variant: v });
    const page = await ctx.newPage();
    await page.goto(`/build/${SLUG}/settings`);
    await expect(page.locator("[data-settings-audience]")).toBeVisible();
    await page.screenshot({ path: ev("screens", `settings-${v.name}.png`), fullPage: true });
    await ctx.close();
  }
  const link = await (await c.post("/api/auth/atrium/guest-links", { data: { appId, label: "Second guest" } })).json();
  const ctx = await contextFor(browser, OWNER);
  const page = await ctx.newPage();
  await page.goto(`/build/${SLUG}/settings`);
  const audits = auditCount("app.access_changed", appId);
  await page.locator('[data-access-set="view"] [data-access-mode="everyone"]').check();
  page.once("dialog", (d) => { log("guests off confirm", d.message()); void d.accept(); });
  await page.locator("[data-guests-switch] [role=switch], [role=switch]").first().click();
  await page.locator("[data-save-access]").click();
  await expect.poll(() => auditCount("app.access_changed", appId)).toBe(audits + 1);
  const g = await contextFor(browser, null);
  const gp = await g.newPage();
  await gp.goto(new URL(link.url).pathname);
  await expect(gp.getByText("This link has expired or was turned off")).toBeVisible();
  await c.put(`/api/apps/${appId}/access`, { data: { view: "everyone", edit: "owner", guests: true } });
  await gp.goto(new URL(link.url).pathname);
  await expect(gp.getByText("This link has expired or was turned off")).toBeVisible();
  await g.close();
  // Delete Garage (step-up needed: the owner signed in with a password just now, so the step-up sheet asks again).
  const garage = ((await (await c.get("/api/apps")).json()).tiles as { app: { id: string; slug: string } }[]).find((t) => t.app.slug === "garage")!.app;
  await page.goto("/build/garage/settings");
  await page.locator("[data-delete-confirm]").fill("Garage");
  await page.locator("[data-delete-app]").click();
  const sheet = page.locator('[data-sheet="step-up"], [data-name="step-up"]').first();
  // The delete answers step_up_required and the sheet opens after a step-up status read, so wait for the
  // sheet or the launcher instead of checking once (the single isVisible() raced the sheet when this file
  // runs alone, e2e regression r1).
  await expect.poll(async () => (await sheet.isVisible().catch(() => false)) || new URL(page.url()).pathname === "/", { timeout: 10_000 }).toBe(true);
  if (await sheet.isVisible().catch(() => false)) {
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: /Confirm|Continue/ }).first().click();
  }
  await page.waitForURL(/\/$/, { timeout: 10000 }).catch(() => {});
  const gone = ((await (await c.get("/api/apps")).json()).tiles as { app: { slug: string } }[]).every((t) => t.app.slug !== "garage");
  log("delete garage", { gone, deletedAudits: auditCount("app.deleted", garage.id) });
  expect(gone).toBe(true);
  expect(auditCount("app.deleted", garage.id)).toBe(1);
  await ctx.close();
});

test("V10: no secret in the client bundle or any captured response", async () => {
  const hits: string[] = [];
  const dir = path.resolve(".next-app-builder/static");
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|css|html|json)$/.test(f)) { const t = readFileSync(p, "utf8"); if (t.includes(FAKE_HA_TOKEN) || t.includes("e2e-owner-password")) hits.push(p); } } };
  walk(dir);
  for (const b of allBodies) if (b.body.includes(FAKE_HA_TOKEN) || b.body.includes("e2e-owner-password") || b.body.includes("e2e-only-not-a-real-secret")) hits.push(b.url);
  saveText("logs/v10.json", JSON.stringify({ bundleDir: dir, responsesChecked: allBodies.length, hits }, null, 2));
  expect(hits).toEqual([]);
});
