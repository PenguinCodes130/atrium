// Wave 2 lead checks (wave-2-lead-integration-r1.md step 5) against the review build on port 3121:
// proxy headers for the sandbox frame, uploads and the image proxy; a guest's ?draft=1; sandbox libs;
// insert-from-library; the builder hiding the shell top bar; an instance rendering its pinned version.
// Server: tests/e2e/lead/serve.sh. Run: ATRIUM_E2E_SLOT=review ATRIUM_E2E_PORT=3121 pnpm exec playwright test tests/e2e/lead --project=desktop
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext, type Browser } from "@playwright/test";

const PORT = Number(process.env.ATRIUM_E2E_PORT ?? 3121);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LAN = `http://10.0.0.5:${PORT}`;
const H = { origin: ORIGIN };
const OWNER = { email: "owner@atrium.test", password: "e2e-owner-password-123" };
const SLUG = "leadcheck";
const STATE = path.resolve("test-results/lead-owner.json");

test.describe.configure({ mode: "serial" });
test.skip(PORT === 3102, "never against the live LAN copy");

let appId = "";
let libId = "";
let heading = "";

async function owner(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN, storageState: STATE, extraHTTPHeaders: H });
}
async function draft(c: APIRequestContext) {
  return (await c.get(`/api/apps/${appId}/draft`)).json() as Promise<{ rev: number; doc: { pages: { root: { id: string; children?: { id: string; type: string; props: Record<string, unknown>; libraryRef?: { version: number } }[] } }[] } }>;
}
async function ops(c: APIRequestContext, list: unknown[]) {
  const d = await draft(c);
  const r = await c.post(`/api/apps/${appId}/ops`, { data: { rev: d.rev, ops: list } });
  if (!r.ok()) throw new Error(`ops failed: ${await r.text()}`);
}
async function publish(c: APIRequestContext, note: string) {
  const review = await (await c.get(`/api/apps/${appId}/review`)).json();
  const r = await c.post(`/api/apps/${appId}/publish`, { data: { expectRev: review.rev, note } });
  if (!r.ok()) throw new Error(`publish failed: ${await r.text()}`);
}
async function ownerPage(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: STATE, viewport: { width: 1280, height: 800 } });
  return { ctx, page: await ctx.newPage() };
}

test.beforeAll(async () => {
  test.skip(test.info().project.name !== "desktop", "desktop only");
  const anon = await request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { ...H, "x-forwarded-for": "198.51.100.77" } });
  const res = await anon.post("/api/auth/sign-in/email", { data: OWNER });
  expect(res.ok(), await res.text()).toBe(true);
  mkdirSync(path.dirname(STATE), { recursive: true });
  await anon.storageState({ path: STATE });
  await anon.dispose();

  const c = await owner();
  const created = await (await c.post("/api/apps", { data: { name: "Lead check", slug: SLUG, template: "blank" } })).json();
  appId = created.app.id;
  expect(appId).toBeTruthy();
  const root = (await draft(c)).doc.pages[0]!.root.id;
  await ops(c, [{ op: "node.add", parentId: root, node: { id: "c_headpubaaa", type: "heading", props: { text: "Published words" }, slot: { x: 0, y: 0, w: 6, h: 10 } } }]); // 10 rows: exact boxes (2026-10-19) draw a 2-row slot at 0px under the cell gap
  await c.put(`/api/apps/${appId}/access`, { data: { view: "everyone", edit: "owner", guests: true } });
  await publish(c, "first");
  await ops(c, [{ op: "node.update", nodeId: "c_headpubaaa", patch: { props: { text: "Draft words" } } }]);
  heading = "Published words";
});

test("sandbox frame, shell frame-src, uploads and /api/img carry their own headers", async () => {
  const c = await owner();
  const frame = await c.get("/sandbox/frame");
  expect(frame.status()).toBe(200);
  const fh = frame.headers();
  expect(fh["content-security-policy"]).toContain("sandbox allow-scripts");
  expect(fh["content-security-policy"]).toContain(`frame-ancestors ${ORIGIN}`);
  expect(fh["x-frame-options"]).toBeUndefined();
  expect(fh["x-dns-prefetch-control"]).toBe("off");
  expect(fh["x-content-type-options"]).toBe("nosniff");

  const shell = await c.get(`/a/${SLUG}`);
  const csp = shell.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(new RegExp(`frame-src [^;]*${ORIGIN}/sandbox/frame`));
  expect(csp).toContain(`${LAN}/sandbox/frame`);

  for (const p of ["/uploads/missing-file.png", "/api/img?u=http%3A%2F%2F127.0.0.1%2Fx.png&s=bad"]) {
    const r = await c.get(p);
    expect(r.status(), p).toBeGreaterThanOrEqual(400);
    const pc = r.headers()["content-security-policy"] ?? "";
    expect(pc, p).toContain("sandbox");
    expect(pc, p).toContain("default-src 'none'");
  }
});

test("a guest asking for ?draft=1 sees the published version", async ({ browser }) => {
  const c = await owner();
  const link = await (await c.post("/api/auth/atrium/guest-links", { data: { appId, label: "Lead guest" } })).json();
  expect(link.url).toContain("/g/");
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  const page = await ctx.newPage();
  await page.goto(new URL(link.url).pathname);
  const r = await page.goto(`/a/${SLUG}?draft=1`);
  expect(r?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe(`/a/${SLUG}`);
  await expect(page.getByText(heading)).toBeVisible();
  await expect(page.getByText("Draft words")).toHaveCount(0);
  await ctx.close();
});

test("sandbox libs load, and an HTML block with uplot and d3 finds both globals", async ({ browser }) => {
  const c = await owner();
  for (const lib of ["uplot", "d3"]) {
    const r = await c.get(`/sandbox/lib/${lib}.js`);
    expect(r.status(), lib).toBe(200);
  }
  const root = (await draft(c)).doc.pages[0]!.root.id;
  await ops(c, [{ op: "node.add", parentId: root, node: { id: "c_htmllibaaa", type: "html", props: { html: "<p id=out>waiting</p>", js: "document.getElementById('out').textContent = 'libs:' + typeof uPlot + ':' + typeof d3;", data: {}, controls: [], height: 80, libs: ["uplot", "d3"] }, slot: { x: 0, y: 2, w: 6, h: 3 } } }]);
  const { ctx, page } = await ownerPage(browser);
  await page.goto(`/a/${SLUG}?draft=1`);
  const out = page.frameLocator('iframe[src="/sandbox/frame"]').locator("#out");
  await expect(out).toHaveText("libs:function:object", { timeout: 15_000 });
  await ctx.close();
});

test("the builder hides the shell top bar; versions keeps it", async ({ browser }) => {
  const { ctx, page } = await ownerPage(browser);
  await page.goto(`/build/${SLUG}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[data-shell="topbar"]')).toHaveCount(0);
  await page.goto(`/build/${SLUG}/versions`);
  await expect(page.locator('[data-shell="topbar"]')).toBeVisible();
  await ctx.close();
});

test("insert-from-library adds one instance, and the viewer renders its pinned version", async ({ browser }) => {
  const c = await owner();
  const node = (text: string) => ({ id: "c_libheadaaa", type: "heading", name: "Lead lib", props: { text } });
  const v1 = await (await c.post("/api/library", { data: { name: "Lead lib", node: node("Library v1 words"), sources: [], controls: [] } })).json();
  libId = v1.component?.id ?? v1.id;
  expect(libId, JSON.stringify(v1)).toBeTruthy();

  const { ctx, page } = await ownerPage(browser);
  await page.goto(`/build/${SLUG}?insert=lib:${libId}`);
  await expect.poll(async () => (await draft(c)).doc.pages[0]!.root.children!.filter((n) => n.type === `lib:${libId}`).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => new URL(page.url()).searchParams.has("insert")).toBe(false);
  await page.reload();
  await page.waitForLoadState("networkidle");
  expect((await draft(c)).doc.pages[0]!.root.children!.filter((n) => n.type === `lib:${libId}`).length).toBe(1);

  const v2 = await c.post("/api/library", { data: { name: "Lead lib", node: node("Library v2 words"), sources: [], controls: [], componentId: libId } });
  expect(v2.ok(), await v2.text()).toBe(true);
  await publish(c, "with instance");
  await page.goto(`/a/${SLUG}`);
  await expect(page.getByText("Library v1 words")).toBeVisible();
  await expect(page.getByText("Library v2 words")).toHaveCount(0);
  await ctx.close();
});
