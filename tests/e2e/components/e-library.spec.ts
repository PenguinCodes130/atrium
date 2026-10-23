// The /library screen and API (criteria 59, 62 to 66) against the slot's database.
import { expect, test } from "@playwright/test";
import { evidence, ORIGIN, signIn, withFrameFix, writeEvidence } from "./helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await signIn(context, page.request);
  await withFrameFix(context);
});

const card = {
  id: "c_cardaaaaaa", type: "card", name: "Server card", props: { title: "pve1" },
  children: [
    { id: "c_statcpuaaa", type: "stat", props: { data: { $bind: "{{ cpu }}" } } },
    { id: "c_buttonaaaa", type: "button", props: { label: "Restart", control: "k_xxxxxxxxxx" } },
  ],
};
const codeBlock = { id: "c_htmlaaaaaa", type: "html", name: "Mini chart", props: { html: "<b>hi</b>", data: { v: { $bind: "{{ cpu.value }}" } }, controls: [], height: "auto" } };
const body = (node: unknown, extra: Record<string, unknown> = {}) => ({ name: (node as { name: string }).name, node, sources: ["cpu"], controls: [{ id: "k_xxxxxxxxxx", label: "Restart pve1" }], ...extra });

test("criterion 62 empty state, then 59 save v1 and v2, and the grid with the code tag and actions", async ({ page }) => {
  await page.goto(`${ORIGIN}/library`);
  const list = await (await page.request.get(`${ORIGIN}/api/library`)).json();
  if (!list.components.length) {
    await expect(page.locator("[data-library-empty]")).toHaveText("Nothing saved yet. Select a component in the builder and choose Save to library.");
    await page.screenshot({ path: evidence("library/empty.png"), fullPage: true });
  }
  const v1 = await (await page.request.post(`${ORIGIN}/api/library`, { data: body(card), headers: { origin: ORIGIN } })).json();
  expect(v1.component.version).toBe(1);
  expect(v1.component.params.map((p: { kind: string }) => p.kind).sort()).toEqual(["control", "data"]);
  const v2 = await (await page.request.post(`${ORIGIN}/api/library`, { data: body(card, { componentId: v1.component.id }), headers: { origin: ORIGIN } })).json();
  expect(v2.component.version).toBe(2);
  const code = await (await page.request.post(`${ORIGIN}/api/library`, { data: body(codeBlock), headers: { origin: ORIGIN } })).json();
  writeEvidence("library/saved.json", { v1: v1.component, v2: { id: v2.component.id, version: v2.component.version }, code: { id: code.component.id, containsCode: code.component.containsCode } });
  await page.goto(`${ORIGIN}/library`);
  const c = page.locator(`[data-library-card="${code.component.id}"]`);
  await expect(c.locator("[data-contains-code]")).toHaveText("contains code");
  await expect(page.locator(`[data-library-card="${v1.component.id}"] [data-contains-code]`)).toHaveCount(0);
  for (const a of ["[data-library-use]", "[data-library-export]", "[data-library-delete]"]) await expect(c.locator(a)).toBeVisible();
  await expect(page.locator(`[data-library-card="${v1.component.id}"] [data-library-preview] [data-type="stat"]`)).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: evidence("library/grid.png"), fullPage: true });
});

test("criteria 63 to 65: export without the creator, import marked imported with the code notice, malformed refused, delete", async ({ page }) => {
  const list = (await (await page.request.get(`${ORIGIN}/api/library`)).json()).components as { id: string; name: string; containsCode: boolean }[];
  const code = list.find((x) => x.containsCode)!;
  const exp = await page.request.get(`${ORIGIN}/api/library/${code.id}/export`);
  const file = await exp.text();
  writeEvidence("library/export.atrium-component", file);
  expect(exp.headers()["content-disposition"]).toContain(".atrium-component");
  expect(file).not.toContain("createdBy");

  await page.goto(`${ORIGIN}/library`);
  // Regression r3 (test race, seen once in a full run): files set before the screen hydrates fire no onChange,
  // so the review never opened. Re-set the file until the review shows; the notice text check below is unchanged.
  await expect(async () => {
    await page.locator("[data-library-file]").setInputFiles({ name: "x.atrium-component", mimeType: "application/json", buffer: Buffer.from(file) });
    await expect(page.locator("[data-library-import-review]")).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15000 });
  await expect(page.locator("[data-contains-code-notice]")).toHaveText("Contains code. It runs in the sandbox and sees only the data you give it.");
  await page.screenshot({ path: evidence("library/import-review.png"), fullPage: true });
  await page.locator("[data-library-import-confirm]").click();
  await expect(page.locator("[data-library-card]").filter({ hasText: "imported" }).first()).toBeVisible();

  const count = (await (await page.request.get(`${ORIGIN}/api/library`)).json()).components.length;
  await page.locator("[data-library-file]").setInputFiles({ name: "bad.atrium-component", mimeType: "application/json", buffer: Buffer.from('{"format":"atrium-component","formatVersion":1,"name":"x"}') });
  await expect(page.locator("[data-library-error]")).toContainText("not valid");
  expect((await (await page.request.get(`${ORIGIN}/api/library`)).json()).components.length).toBe(count);

  const imported = (await (await page.request.get(`${ORIGIN}/api/library`)).json()).components.find((x: { source: string }) => x.source === "imported");
  await page.locator(`[data-library-card="${imported.id}"] [data-library-delete]`).click();
  await page.locator(`[data-library-card="${imported.id}"] [data-library-delete-confirm] button`).first().click();
  await expect(page.locator(`[data-library-card="${imported.id}"]`)).toHaveCount(0);
});

test("criterion 66: no session, no library", async ({ playwright }) => {
  const anon = await playwright.request.newContext();
  const api = await anon.get(`${ORIGIN}/api/library`);
  const screen = await anon.get(`${ORIGIN}/library`, { maxRedirects: 0 });
  writeEvidence("library/66-anon.json", { api: api.status(), screen: screen.status(), location: screen.headers()["location"] });
  expect(api.status()).toBe(401);
  expect([302, 303, 307]).toContain(screen.status());
  await anon.dispose();
});
