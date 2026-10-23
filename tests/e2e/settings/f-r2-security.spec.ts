// settings round 2, the security items of the w2-r1 gauntlet Fix List, in the real build:
//   1  backup import answers step_up_required without a fresh step-up; the screen asks first, then imports
//   2  a backup holding HTML saved as .png and a scripted SVG: the HTML is refused, the SVG sanitised
//   3  a guest and a viewer cannot use the cross-app or draft-only image signatures; signatures expire
//   4  URLs from an RSS feed: loopback and private addresses are not signed, the feed's own host is
// plus items 10 (last backup line) and 13 (plurals). Runs once, on desktop, after a-e (it replaces the
// slot's data with a backup of itself, so member and viewer passwords are restored at the end).
// A stand-in image and feed host listens on 127.0.0.1:3147. Test-only values; none are real credentials.
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { MEMBER, ORIGIN, OWNER, VIEWER, addUser, captureTraffic, context, db, ev, shot, stateFor } from "./helpers";
import { readZipLite, writeZipLite } from "./zip-lite";

test.setTimeout(240_000);
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({}, info) => test.skip(info.project.name !== "desktop" || process.env.ATRIUM_E2E_SCENARIO === "locked", "once, desktop, normal scenario"));

const STAND_IN_PORT = 3147;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d3b5f00000000049454e44ae426082", "hex");
const BACKUP_PASSWORD = "e2e-r2-backup-FAKE-pass-5521";
const H = { origin: ORIGIN };
const hits: string[] = [];
let standIn: Server;
const out: Record<string, unknown> = {};

const FEED_URLS = {
  loopback: `http://127.0.0.1:${STAND_IN_PORT}/router/reboot.cgi?SECPROBE=1`,
  lanCam: "http://192.168.1.250/snapshot.jpg",
  ownHost: `http://localhost:${STAND_IN_PORT}/own.png`,
  publicImg: "https://img.example.net/cover.png",
};

test.beforeAll(async () => {
  await addUser(MEMBER.email, "member", MEMBER.password);
  await addUser(VIEWER.email, "viewer", VIEWER.password);
  standIn = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/feed.xml") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Stand-in</title>${Object.entries(FEED_URLS).map(([k, u]) => `<item><title>${k}</title><link>${u.replace(/&/g, "&amp;")}</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`);
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((r) => standIn.listen(STAND_IN_PORT, "127.0.0.1", () => r()));
});
test.afterAll(async ({}, info) => {
  if (Object.keys(out).length) writeFileSync(ev(`r2-security-${info.project.name}.json`), JSON.stringify({ ...out, standInHits: hits }, null, 2));
  await new Promise<void>((r) => standIn.close(() => r()));
  // Item 2's import restores users without password hashes: give the test users theirs back.
  await addUser(MEMBER.email, "member", MEMBER.password);
  await addUser(VIEWER.email, "viewer", VIEWER.password);
});

async function api(who: { email: string; password: string }): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN, storageState: await stateFor(who), extraHTTPHeaders: H });
}
function expireStepUps() {
  const d = db();
  // Test slot only: end every step-up window, and reset the step-up attempt counter this spec uses up.
  try { d.prepare("UPDATE session SET step_up_at = NULL").run(); d.prepare("DELETE FROM auth_rate_limit WHERE key LIKE 'stepUp%' OR key = 'signInAccount:owner@atrium.test'").run(); } finally { d.close(); }
}
async function stepUp(a: APIRequestContext) {
  const d = db();
  try { d.prepare("DELETE FROM auth_rate_limit WHERE key LIKE 'stepUp%' OR key = 'signInAccount:owner@atrium.test'").run(); } finally { d.close(); }
  const r = await a.post("/api/auth/atrium/step-up", { data: { method: "password", password: OWNER.password } });
  expect(r.status(), await r.text()).toBeLessThan(300);
}
/** A component id: c_ plus 10 base32 characters (a-z, 2-7). */
const cid = () => `c_${[...randomBytes(10)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("")}`;
const qOf = (p: string) => new URLSearchParams(p.slice(p.indexOf("?") + 1));

test("item 1: import needs a fresh step-up (API), checked before the file is read", async () => {
  expireStepUps();
  const a = await api(OWNER);
  const file = { name: "b.atrium", mimeType: "application/octet-stream", buffer: Buffer.from("PK\u0003\u0004 not a backup") };
  const stale = await a.post("/api/settings/backup/import", { multipart: { file, replace: "1" } });
  const staleBody = await stale.json();
  out.importWithoutStepUp = { status: stale.status(), code: staleBody.error?.code };
  expect(stale.status()).toBe(403);
  expect(staleBody.error.code).toBe("step_up_required");
  // The probe the screen sends first answers the same.
  expect((await a.post("/api/settings/backup/import?check=1")).status()).toBe(403);
  await stepUp(a);
  const probe = await a.post("/api/settings/backup/import?check=1");
  expect(probe.status()).toBe(204);
  // After the step-up the file is read and checked (a damaged file is refused for being damaged).
  const after = await a.post("/api/settings/backup/import", { multipart: { file, replace: "1" } });
  const afterBody = await after.json();
  out.importAfterStepUp = { status: after.status(), code: afterBody.error?.code };
  expect(afterBody.error.code).toBe("damaged");
  // Members still cannot import at all.
  const m = await api(MEMBER);
  expect((await m.post("/api/settings/backup/import", { multipart: { file } })).status()).toBe(403);
  await m.dispose();
  await a.dispose();
});

test("items 1, 2, 10, 13: export shows its time at once; import asks for the step-up first; hostile uploads refused or sanitised", async ({ browser }) => {
  const ctx = await context(browser, OWNER);
  const page = await ctx.newPage();
  captureTraffic(page, "r2-backups");
  const calls: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/settings/backup/import")) calls.push(`${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`); });
  // Item 10: an export updates the status line without a reload.
  const a = await api(OWNER);
  await stepUp(a);
  await page.goto("/settings/backups");
  const before = (await page.locator("[data-last-export]").textContent()) ?? "";
  await page.locator("[data-without-secrets]").click();
  await page.waitForTimeout(1100); // the line shows seconds: make sure the new time differs
  const download = page.waitForEvent("download");
  await page.locator("[data-export-backup]").click();
  await download;
  await expect(page.locator("[data-last-export]")).toContainText("Last backup made");
  await expect(page.locator("[data-last-export]")).not.toHaveText(before);
  out.lastExport = { before, after: await page.locator("[data-last-export]").textContent() };
  await shot(page, "r2-export-status-updated");
  // Item 13: no "1 <plural>" anywhere in the replace warning.
  const warning = (await page.locator("[data-replace-confirm]").textContent()) ?? "";
  out.replaceWarning = warning;
  expect(warning).not.toMatch(/\b1 (other users|apps|integrations|saved credentials|saved themes|uploads|library components)\b/);

  // Item 2: a backup of this instance (with its secrets) plus the critic's two hostile files.
  const exp = await a.post("/api/settings/backup/export", { data: { includeSecrets: true, password: BACKUP_PASSWORD, passwordAgain: BACKUP_PASSWORD, includeAudit: true } });
  expect(exp.status()).toBe(200);
  const files = readZipLite(Buffer.from(await exp.body()));
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as { tables: { name: string; rows: number }[] };
  const rows = JSON.parse(files.get("data/upload.json")?.toString("utf8") ?? "[]") as Record<string, unknown>[];
  const tag = randomBytes(4).toString("hex").replace(/[0-9]/g, "a");
  const htmlFile = `h${tag}hhhhhhhhhhhhhhh.png`.slice(0, 20) + ".png";
  const svgFile = `s${tag}sssssssssssssss.svg`.slice(0, 20) + ".svg";
  const now = Date.now();
  rows.push(
    { id: `r2html${tag}`, file: htmlFile, name: "cat.png", mime: "text/html", kind: "image", size: 90, sha256: "x", created_by_id: rows[0]?.created_by_id ?? "x", created_at: now },
    { id: `r2svg${tag}`, file: svgFile, name: "logo.svg", mime: "image/svg+xml", kind: "image", size: 120, sha256: "y", created_by_id: rows[0]?.created_by_id ?? "x", created_at: now },
  );
  files.set("data/upload.json", Buffer.from(JSON.stringify(rows)));
  const t = manifest.tables.find((x) => x.name === "upload");
  if (t) t.rows = rows.length;
  else manifest.tables.push({ name: "upload", rows: rows.length });
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  files.set(`uploads/${htmlFile}`, Buffer.from("<!doctype html><html><body><script>parent.alert(document.cookie)</script></body></html>"));
  files.set(`uploads/${svgFile}`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="4" height="4"/></svg>'));
  const hostile = writeZipLite(files);

  // Item 1 in the screen: with a stale step-up the sheet opens before any file is sent.
  expireStepUps();
  await page.reload();
  calls.length = 0;
  await page.locator("[data-backup-file]").setInputFiles({ name: "hostile.atrium", mimeType: "application/octet-stream", buffer: hostile });
  await expect(page.locator("[data-file-name]")).toHaveText("hostile.atrium");
  await page.locator("[data-import-password]").fill(BACKUP_PASSWORD);
  await page.locator("[data-replace-confirm] [role=checkbox]").click();
  await page.locator("[data-import-backup]").click();
  const sheet = page.locator('[data-sheet="step-up"]');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("import a backup");
  expect(calls).toEqual(["POST /api/settings/backup/import?check=1"]);
  await shot(page, "r2-import-step-up-first");
  await sheet.getByLabel("Password").fill(OWNER.password);
  await sheet.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("[data-import-status]")).toContainText("Backup restored.", { timeout: 60_000 });
  await expect(page.locator("[data-import-status]")).toContainText("1 upload failed the upload checks and was not restored.");
  await expect(page.locator("[data-uploads-refused]")).toContainText(htmlFile);
  out.importCalls = [...calls];
  expect(calls).toEqual(["POST /api/settings/backup/import?check=1", "POST /api/settings/backup/import?check=1", "POST /api/settings/backup/import"]);
  await shot(page, "r2-import-uploads-refused");
  // Served types come from the bytes: the HTML is gone, the SVG has no script.
  const a2 = await api(OWNER);
  const html = await a2.get(`/uploads/${htmlFile}`);
  const svg = await a2.get(`/uploads/${svgFile}`);
  const svgText = await svg.text();
  out.restoredUploads = { html: html.status(), svg: { status: svg.status(), type: svg.headers()["content-type"], body: svgText } };
  expect(html.status()).toBe(404);
  expect(svg.status()).toBe(200);
  expect(svg.headers()["content-type"]).toBe("image/svg+xml");
  expect(svgText).not.toMatch(/script|onload/i);
  // Secrets were sealed again under this instance's key (the import used the password).
  const d = db();
  try { out.secretsAfterImport = (d.prepare("SELECT COUNT(*) AS n FROM secret").get() as { n: number }).n; } finally { d.close(); }
  await a.dispose();
  await a2.dispose();
  await ctx.close();
});

test("item 3: image signatures name an app and a level; a guest and a viewer cannot use cross-app or draft-only paths", async ({ browser }) => {
  // Item 2's import keeps users but not their password hashes.
  await addUser(VIEWER.email, "viewer", VIEWER.password);
  await addUser(MEMBER.email, "member", MEMBER.password);
  const a = await api(OWNER);
  test.skip((await a.get("/api/apps")).status() === 404, "app-builder is not in this build");
  const mk = async (name: string) => {
    const slug = `${name}-${randomBytes(3).toString("hex")}`;
    const r = await a.post("/api/apps", { data: { name, slug, template: "blank" } });
    expect(r.status(), await r.text()).toBe(201);
    const id = (await r.json()).app.id as string;
    let d = await (await a.get(`/api/apps/${id}/draft`)).json();
    const root = d.doc.pages[0].root.id;
    const img = (nid: string, file: string) => ({ op: "node.add", parentId: root, node: { id: nid, type: "image", props: { src: `http://127.0.0.1:${STAND_IN_PORT}/${slug}-${file}.png`, alt: file } } });
    const r1 = await a.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: [img(`${cid()}`, "published")] } });
    expect(r1.status(), await r1.text()).toBe(200);
    d = await (await a.get(`/api/apps/${id}/draft`)).json();
    const rv = await (await a.get(`/api/apps/${id}/review`)).json();
    expect((await a.post(`/api/apps/${id}/publish`, { data: { expectRev: rv.rev, note: "r2" } })).status()).toBe(200);
    d = await (await a.get(`/api/apps/${id}/draft`)).json();
    const r2 = await a.post(`/api/apps/${id}/ops`, { data: { rev: d.rev, ops: [img(`${cid()}`, "draft")] } });
    expect(r2.status(), await r2.text()).toBe(200);
    return { id, slug };
  };
  const guestApp = await mk("r2-guest");
  const other = await mk("r2-other");
  expect((await a.put(`/api/apps/${guestApp.id}/access`, { data: { view: "everyone", edit: "owner", guests: true } })).status()).toBeLessThan(300);
  expect((await a.put(`/api/apps/${other.id}/access`, { data: { view: "owner", edit: "owner", guests: false } })).status()).toBeLessThan(300);
  // Signed paths as the owner sees them: published (viewer page) and draft (render, editors only).
  const ownerCtx = await context(browser, OWNER);
  const op = await ownerCtx.newPage();
  const publishedPath = async (slug: string) => {
    await op.goto(`/a/${slug}`);
    const src = op.locator('img[src*="/api/img"]').first();
    await expect(src).toBeVisible();
    return (await src.getAttribute("src"))!;
  };
  const draftPath = async (id: string, slug: string) => {
    const r = await (await a.get(`/api/apps/${id}/render`)).json();
    return Object.entries(r.signedUrls as Record<string, string>).find(([u]) => u.includes(`${slug}-draft`))![1];
  };
  const paths = {
    otherPublished: await publishedPath(other.slug),
    otherDraft: await draftPath(other.id, other.slug),
    guestPublished: await publishedPath(guestApp.slug),
    guestDraft: await draftPath(guestApp.id, guestApp.slug),
  };
  await op.screenshot({ path: ev("screens", "r2-owner-signed-image.png") });
  out.signedPaths = paths;
  expect(qOf(paths.otherPublished).get("a")).toBe(other.id);
  expect(qOf(paths.otherPublished).get("v")).toBe("g");
  expect(qOf(paths.otherDraft).get("v")).toBe("e");
  const e = Number(qOf(paths.otherPublished).get("e")) * 1000;
  expect(e - Date.now()).toBeGreaterThan(23 * 3600_000);
  expect(e - Date.now()).toBeLessThanOrEqual(25 * 3600_000);
  // A guest of r2-guest.
  const link = await a.post("/api/auth/atrium/guest-links", { data: { appId: guestApp.id, label: "r2 guest" } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  const token = JSON.stringify(await link.json()).match(/atr_g_[A-Za-z0-9_-]+/)![0];
  const g = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: H });
  const entry = await g.get(`/g/${token}`, { maxRedirects: 0 });
  expect([302, 303, 307]).toContain(entry.status());
  const v = await api(VIEWER);
  const results: Record<string, number> = {};
  const check = async (who: string, ctxReq: APIRequestContext, key: keyof typeof paths, want: number) => {
    const r = await ctxReq.get(paths[key]);
    results[`${who} ${key}`] = r.status();
    expect(r.status(), `${who} ${key}`).toBe(want);
    if (want === 403) expect((await r.json()).error.code).toBe("image_not_allowed");
  };
  await check("guest", g, "otherPublished", 403);
  await check("guest", g, "otherDraft", 403);
  await check("guest", g, "guestDraft", 403);
  await check("guest", g, "guestPublished", 200);
  await check("viewer", v, "otherPublished", 403);
  await check("viewer", v, "otherDraft", 403);
  await check("viewer", v, "guestDraft", 403);
  await check("viewer", v, "guestPublished", 200);
  await check("owner", a, "otherDraft", 200);
  // A tampered app id or an expiry moved forward is not this Atrium's signature.
  const tampered = paths.guestPublished.replace(`a=${guestApp.id}`, `a=${other.id}`);
  const r1 = await a.get(tampered);
  results["owner tampered app"] = r1.status();
  expect((await r1.json()).error.code).toBe("bad_signature");
  const q = qOf(paths.guestPublished);
  q.set("e", String(Number(q.get("e")) + 3600));
  const r2 = await a.get(`/api/img?${q}`);
  results["owner moved expiry"] = r2.status();
  expect((await r2.json()).error.code).toBe("bad_signature");
  out.imageAccess = results;
  await g.dispose();
  await v.dispose();
  await a.dispose();
  await ownerCtx.close();
});

test("item 4: RSS items pointing at loopback or a LAN address are not signed; the feed's own host and public addresses are", async () => {
  const a = await api(OWNER);
  test.skip((await a.get("/api/apps")).status() === 404, "app-builder is not in this build");
  const integ = await a.post("/api/integrations", { data: { packageId: "rss", name: `r2 feed ${randomBytes(2).toString("hex")}`, config: { baseUrl: `http://localhost:${STAND_IN_PORT}/feed.xml` }, secrets: {}, untested: true } });
  expect(integ.status(), await integ.text()).toBeLessThan(300);
  const integrationId = (await integ.json()).id as string;
  const slug = `r2-feed-${randomBytes(3).toString("hex")}`;
  const app = await a.post("/api/apps", { data: { name: "r2 feed", slug, template: "blank" } });
  const appId = (await app.json()).app.id as string;
  const d = await (await a.get(`/api/apps/${appId}/draft`)).json();
  const page = d.doc.pages[0];
  const ops = [
    { op: "source.set", source: { name: "news", integrationId, endpointId: "items", refreshSec: 300 } },
    { op: "node.add", parentId: page.root.id, node: { id: `${cid()}`, type: "text", props: { text: { $bind: "{{ news }}" } } } },
  ];
  const opsRes = await a.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops } });
  expect(opsRes.status(), await opsRes.text()).toBe(200);
  const poll = await a.get(`/api/data/widget/${appId}:news?page=${page.id}&draft=1`);
  const body = await poll.json();
  expect(poll.status(), JSON.stringify(body)).toBe(200);
  const signed = (body.signedUrls ?? {}) as Record<string, string>;
  out.feedSigned = Object.fromEntries(Object.entries(FEED_URLS).map(([k, u]) => [k, signed[u] ? qOf(signed[u]).get("n") : null]));
  expect(signed[FEED_URLS.loopback]).toBeUndefined();
  expect(signed[FEED_URLS.lanCam]).toBeUndefined();
  expect(qOf(signed[FEED_URLS.ownHost]!).get("n")).toBe("h");
  expect(qOf(signed[FEED_URLS.publicImg]!).get("n")).toBe("p");
  // The own-host image is fetched through the proxy; the loopback probe URL was never requested.
  const own = await a.get(signed[FEED_URLS.ownHost]!);
  expect(own.status()).toBe(200);
  expect(hits.some((h) => h.includes("reboot.cgi"))).toBe(false);
  await a.dispose();
});
