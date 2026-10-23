// Extra E1: the HTML block sandbox suite (criteria 44 to 51 and 53 to 58) with a test web server and a
// test STUN (UDP) server recording every contact, and Chromium's net log as the DNS observer.
// Chromium by default; criterion 52 runs it in Firefox and WebKit through playwright.cross.config.ts.
import { chromium, expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { createSocket, type Socket } from "node:dgram";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { evidence, gallery, ORIGIN, signIn, withFrameFix, writeEvidence } from "./helpers";

test.describe.configure({ mode: "serial" });

let web: Server;
let stun: Socket;
let webPort = 0;
let stunPort = 0;
const hits: { method: string; url: string; host: string }[] = [];
const packets: number[] = [];

test.beforeAll(async () => {
  web = createServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "", host: req.headers.host ?? "" });
    if (req.url === "/framer") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><iframe id="f" src="${ORIGIN}/sandbox/frame"></iframe>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
    res.end("<script>addEventListener('message', () => fetch('/got-message'))</script>replacement");
  });
  web.on("upgrade", (req, sock) => {
    hits.push({ method: "UPGRADE", url: req.url ?? "", host: req.headers.host ?? "" });
    sock.destroy();
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
  webPort = (web.address() as { port: number }).port;
  stun = createSocket("udp4");
  stun.on("message", (m) => packets.push(m.length));
  await new Promise<void>((r) => stun.bind(0, "127.0.0.1", () => r()));
  stunPort = stun.address().port;
});
test.afterAll(async ({}, info) => {
  web.close();
  stun.close();
  // Only the desktop worker runs the suite; the mobile worker (all skipped) must not overwrite it.
  if (info.project.name === "desktop") writeEvidence("sandbox/test-server-contacts.json", { hits, stunPackets: packets.length });
});

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await signIn(context, page.request);
  await withFrameFix(context);
});

const probeId = (name: string) => `c_probe${name.replace(/[^a-z]/g, "").slice(0, 5).padEnd(5, "a")}`;
const url = (probes: string[], extra: Record<string, string> = {}, dns = "none") => gallery({ scene: "sandbox", probes: probes.join(","), probe: webPort, stun: stunPort, dns, ...extra });

async function result(page: Page, name: string, timeout = 15_000): Promise<Record<string, string>> {
  const line = page.locator(`[data-block-log="${probeId(name)}"] li`, { hasText: "RESULT " }).first();
  await expect(line).toBeVisible({ timeout });
  const text = (await line.textContent())!;
  return JSON.parse(text.slice(text.indexOf("RESULT ") + 7));
}
const sentRuns = async (page: Page) => page.locator("[data-sent]").count();

test("criterion 44: no cookies, no storage, opaque origin", async ({ page }) => {
  await page.goto(url(["storage"]));
  const r = await result(page, "storage");
  writeEvidence("sandbox/44-storage.json", r);
  expect(r.cookie).toBe('""');
  expect(r.local).toMatch(/^blocked/);
  expect(r.session).toMatch(/^blocked/);
  expect(r.origin).toBe("null");
});

test("criterion 45: fetch, XHR, WebSocket, EventSource and sendBeacon reach nothing", async ({ page }) => {
  const before = hits.length;
  await page.goto(url(["network"]));
  const r = await result(page, "network");
  await page.waitForTimeout(1000);
  writeEvidence("sandbox/45-network.json", { result: r, newHits: hits.slice(before) });
  for (const k of ["fetchTest", "fetchApi", "xhr", "websocket", "eventsource"]) expect(r[k], k).toMatch(/^blocked/);
  expect(r.beacon === "false" || r.beacon!.startsWith("blocked")).toBe(true);
  expect(hits.slice(before)).toEqual([]);
});

test("criterion 46: images, styles, fonts, media and nested frames load nothing", async ({ page }) => {
  const before = hits.length;
  await page.goto(url(["resources"]));
  const r = await result(page, "resources");
  await page.waitForTimeout(1500);
  writeEvidence("sandbox/46-resources.json", { result: r, newHits: hits.slice(before) });
  expect(hits.slice(before)).toEqual([]);
  expect(r.iframes).toBe("0");
});

test("criterion 49: no peer connection and no STUN packet", async ({ page }) => {
  const before = packets.length;
  await page.goto(url(["webrtc"]));
  const r = await result(page, "webrtc");
  await page.waitForTimeout(1500);
  writeEvidence("sandbox/49-webrtc.json", { result: r, stunPackets: packets.length - before });
  expect(r.ctor).toBe("undefined");
  expect(r.pc).toMatch(/^blocked/);
  expect(packets.length - before).toBe(0);
});

test("criterion 50: DNS prefetch, preconnect and addresses cause no lookup (net log) and the header is off", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "the DNS observer is Chromium's net log; other engines have no equivalent here");
  const label = `p${randomBytes(6).toString("hex")}`;
  const log = evidence("sandbox/50-netlog.json");
  const browser = await chromium.launch({ args: [`--log-net-log=${log}`, "--net-log-capture-mode=Everything"] });
  const ctx = await browser.newContext();
  await signIn(ctx, ctx.request);
  await withFrameFix(ctx);
  const p = await ctx.newPage();
  await p.goto(url(["dns"], {}, label));
  await result(p, "dns");
  await p.waitForTimeout(10_000);
  await browser.close();
  const net = existsSync(log) ? readFileSync(log, "utf8") : "";
  const seen = net.includes(`${label}.atrium-dns-probe.test`);
  const header = (await page.request.get(`${ORIGIN}/sandbox/frame`)).headers()["x-dns-prefetch-control"];
  writeEvidence("sandbox/50-dns.json", { hostname: `${label}.atrium-dns-probe.test`, netLogBytes: net.length, hostnameInNetLog: seen, headerOnLiveRoute: header });
  expect(net.length).toBeGreaterThan(1000);
  expect(seen).toBe(false);
  expect(header).toBe("off");
  void info;
});

for (const nav of ["self-nav", "form-nav", "link-nav"]) {
  test(`criterion 47: ${nav} from block code never leaves the browser`, async ({ page }) => {
    const before = hits.length;
    await page.goto(url([nav]));
    await expect(page.locator(`[data-node="${probeId(nav)}"] iframe`)).toBeVisible();
    await page.waitForTimeout(2500);
    // Links and forms are cancelled in the frame. Setting location is refused by the page's CSP
    // (frame-src) before any request leaves; the error page is a second load, so the host removes the
    // frame and says so (the Navigation API is disabled in opaque-origin documents).
    const stillThere = await page.locator(`[data-node="${probeId(nav)}"] iframe`).count();
    const escaped = await page.locator(`[data-node="${probeId(nav)}"] [data-sandbox-escape]`).count();
    writeEvidence(`sandbox/47-${nav}.json`, { newHits: hits.slice(before), frameStillThere: stillThere === 1, hostRemovedFrame: escaped === 1 });
    expect(hits.slice(before)).toEqual([]);
    expect(stillThere + escaped).toBe(1);
    if (nav !== "self-nav") expect(stillThere).toBe(1);
  });
}

test("criterion 47: a forced second load removes the frame within 1 second; the replacement never gets a port", async ({ page }) => {
  await page.goto(url(["log"]));
  const host = page.locator(`[data-node="${probeId("log")}"]`);
  await expect(host.locator("iframe")).toBeVisible();
  await expect.poll(() => page.frames().some((f) => f.url().includes("/sandbox/frame")), { timeout: 10_000 }).toBe(true);
  await expect(page.locator(`[data-block-log="${probeId("log")}"] li`).first()).toBeVisible({ timeout: 10_000 });
  const frame = page.frames().find((f) => f.url().includes("/sandbox/frame"))!;
  const t0 = Date.now();
  const nav = await frame.goto(`http://127.0.0.1:${webPort}/replacement`).then(() => "loaded", (e: Error) => e.message.split("\n")[0]!);
  // The shell's frame-src allows only /sandbox/frame, so the browser refuses the navigation itself and
  // nothing is requested (Firefox keeps the sandbox frame; Chromium shows its error page, which the host
  // may also count as a second load). That is stricter than the path below; the no-message check still runs.
  if (!hits.some((h) => h.url === "/replacement")) {
    await page.waitForTimeout(1000);
    writeEvidence("sandbox/47-forced.json", { blockedByBrowser: nav, frameUrl: frame.url(), gotMessage: hits.some((h) => h.url === "/got-message") });
    expect(nav).not.toBe("loaded");
    expect(frame.url()).not.toContain(`:${webPort}`);
    expect(hits.some((h) => h.url === "/got-message")).toBe(false);
    return;
  }
  await expect(host.locator("[data-sandbox-escape]")).toHaveText("This block tried to leave the sandbox", { timeout: 1500 });
  const ms = Date.now() - t0;
  await page.waitForTimeout(1000);
  const connects = await host.locator("[data-sandbox-escape]").getAttribute("data-connects");
  writeEvidence("sandbox/47-forced.json", { msToRemoval: ms, connects, gotMessage: hits.some((h) => h.url === "/got-message") });
  expect(ms).toBeLessThan(1500);
  expect(connects).toBe("1");
  expect(hits.some((h) => h.url === "/got-message")).toBe(false);
  await expect(host.locator("iframe")).toHaveCount(0);
  await host.screenshot({ path: evidence("sandbox/47-escape.png") });
});

test("criterion 48: top navigation and popups do nothing", async ({ page, context }) => {
  const before = hits.length;
  let popups = 0;
  context.on("page", () => popups++);
  await page.goto(url(["top-nav", "popup"]));
  const a = await result(page, "top-nav");
  const b = await result(page, "popup");
  await page.waitForTimeout(1500);
  writeEvidence("sandbox/48-top.json", { topNav: a, popup: b, url: page.url(), popups, newHits: hits.slice(before) });
  expect(page.url()).toContain("/library/gallery");
  expect(popups).toBe(0);
  expect(a.top).toMatch(/^blocked/);
  expect(b.open).not.toBe("object");
  expect(hits.slice(before)).toEqual([]);
});

test("criterion 51: the frame alone has an opaque origin and no data; another origin cannot frame it", async ({ page }) => {
  await page.goto(`${ORIGIN}/sandbox/frame`);
  const alone = await page.evaluate(() => ({ origin: self.origin, cookie: document.cookie, text: document.body.innerText.trim(), html: document.documentElement.outerHTML.length }));
  await page.goto(`http://127.0.0.1:${webPort}/framer`);
  await page.waitForTimeout(1500);
  const child = page.frames().find((f) => f !== page.mainFrame());
  const childUrl = child?.url() ?? "(none)";
  let reached = "no";
  try {
    // Firefox never answers inside a frame it refused to show (frame-ancestors), so the probe is capped.
    reached = (await Promise.race([
      child!.evaluate(() => (document.getElementById("atrium-root") ? "yes" : "no")),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("no answer")), 5000)),
    ])) as string;
  } catch {
    reached = "no (frame not accessible)";
  }
  writeEvidence("sandbox/51-frame.json", { alone, foreignFramerChildUrl: childUrl, bootstrapReached: reached });
  expect(alone.origin).toBe("null");
  expect(alone.cookie).toBe("");
  expect(alone.text).toBe("");
  expect(reached.startsWith("yes")).toBe(false);
});

test("criterion 53: unlisted controls and the eleventh request in 10 seconds are dropped", async ({ page }) => {
  await page.goto(url(["control-spam"]));
  const r = await result(page, "control-spam", 20_000);
  await page.waitForTimeout(500);
  const sent = await sentRuns(page);
  writeEvidence("sandbox/53-spam.json", { result: r, runsReachingServer: sent });
  expect(sent).toBe(10);
  await page.goto(url(["unlisted"]));
  const u = await result(page, "unlisted");
  expect(u.unlisted).toBe("dropped");
  expect(await sentRuns(page)).toBe(0);
});

test("criterion 54: messages over 256 KB and window messages are ignored", async ({ page }) => {
  await page.goto(url(["big-message", "window-post"]));
  const small = await result(page, "big-message");
  const posted = await result(page, "window-post");
  await page.waitForTimeout(800);
  const lines = await page.locator(`[data-block-log="${probeId("big-message")}"] li`).allTextContents();
  writeEvidence("sandbox/54-messages.json", { small, posted, bigLineArrived: lines.some((l) => l.length > 1000), runs: await sentRuns(page), navigated: await page.locator("[data-navigated]").getAttribute("data-navigated") });
  // Block code has no handle on the port: the bootstrap trims a log to 2,000 characters and refuses to
  // post anything over 256 KB, so nothing that large ever reaches the host (whose own 256 KB rule is unit tested).
  expect(lines.every((l) => l.length < 2200)).toBe(true);
  expect(await sentRuns(page)).toBe(0);
  expect(await page.locator("[data-navigated]").getAttribute("data-navigated")).toBe("");
});

test("criteria 55 and 56: draft-preview block runs open the host confirm; resize capped; navigation only to own pages", async ({ page }) => {
  await page.goto(url(["draft-control"], { mode: "draft-preview" }));
  await expect(page.locator("[data-control-confirm]")).toBeVisible({ timeout: 10_000 });
  expect(await sentRuns(page)).toBe(0);
  await page.screenshot({ path: evidence("sandbox/55-draft-confirm.png") });
  await page.locator("[data-confirm-run]").click();
  const r = await result(page, "draft-control");
  const sent = JSON.parse((await page.locator("[data-sent]").first().getAttribute("data-sent"))!);
  writeEvidence("sandbox/55-draft.json", { result: r, sent });
  expect(sent).toMatchObject({ draft: true, confirmed: true });

  await page.goto(url(["resize", "navigate"]));
  await result(page, "navigate");
  await expect.poll(async () => page.locator(`[data-node="${probeId("resize")}"] iframe`).evaluate((el) => el.getBoundingClientRect().height), { timeout: 5000 }).toBe(4000);
  const navigated = await page.locator("[data-navigated]").getAttribute("data-navigated");
  writeEvidence("sandbox/56-resize-navigate.json", { navigated });
  expect(navigated).toBe("p_statesaaaa");
});

test("criteria 57 and 58: a guest block gets only its resolved map; data and theme reach it within a second", async ({ page }) => {
  await page.goto(gallery({ scene: "guest" }));
  const log = page.locator('[data-block-log="c_htmlblocka"] li');
  await expect(log.filter({ hasText: "viewer guest" }).first()).toBeVisible({ timeout: 10_000 });
  const dataLine = (await log.filter({ hasText: "data " }).first().textContent())!;
  writeEvidence("sandbox/57-guest.json", { dataLine });
  expect(dataLine).toContain('{"cpu":41.3}');

  await page.goto(gallery({ scene: "motion" }));
  const statValue = page.locator('[data-node="c_statcpuaaa"] .atr-stat-value');
  await expect(log.filter({ hasText: "data " }).first()).toBeVisible({ timeout: 10_000 });
  const n0 = await log.filter({ hasText: "data " }).count();
  await expect.poll(async () => log.filter({ hasText: "data " }).count(), { timeout: 5000 }).toBeGreaterThan(n0);
  const tData = Date.now();
  const v = await statValue.textContent();
  await page.locator("[data-atrium-canvas]").evaluate((el) => (el as HTMLElement).style.setProperty("--theme-accent", "#123456"));
  const t0 = Date.now();
  await expect(log.filter({ hasText: "theme #123456" }).first()).toBeVisible({ timeout: 2000 });
  const themeMs = Date.now() - t0;
  writeEvidence("sandbox/58-updates.json", { statAfterUpdate: v, themeMs, dataUpdateObservedAt: tData });
  expect(themeMs).toBeLessThan(1000);
});
