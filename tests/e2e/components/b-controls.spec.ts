// Controls in a browser (criteria 19 to 23): toggle settle and spring back, one slider run on release,
// a select option, a button with no input, the draft-preview confirm, render mode disabled.
import { expect, test, type Page } from "@playwright/test";
import { evidence, gallery, signIn, writeEvidence } from "./helpers";

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await signIn(context, page.request);
});

const sent = async (page: Page) => (await page.locator("[data-sent]").evaluateAll((els) => els.map((e) => JSON.parse(e.getAttribute("data-sent")!)))) as { controlId: string; input?: unknown; draft?: boolean; confirmed?: boolean }[];
const toggle = (page: Page) => page.locator('[data-node="c_toggleaaaa"] [role="switch"]');

test("criterion 19: a toggle settles when the stream confirms, and springs back with the server's message", async ({ page }) => {
  await page.goto(gallery({ scene: "all" }));
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-busy", "true");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  // The fake server answers at 300ms and the stream confirms at 900ms: then it settles (no longer busy).
  await expect(toggle(page)).not.toHaveAttribute("aria-busy", "true", { timeout: 3000 });
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-node="c_toggleaaaa"] [data-control-announce]')).toHaveText(/Done|Desk lamp on/);

  await page.goto(gallery({ scene: "all", answer: "refuse" }));
  await toggle(page).click();
  const t0 = Date.now();
  await expect(page.locator('[data-node="c_toggleaaaa"] [data-control-message]')).toHaveText("No data: this integration is no longer shared");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  const ms = Date.now() - t0;
  writeEvidence("controls/toggle-refused.json", { msAfterClickIncludingFakeLatency300: ms });
  expect(ms).toBeLessThan(1300);
  await page.locator('[data-node="c_toggleaaaa"]').screenshot({ path: evidence("controls/toggle-refused.png") });
});

test("criterion 20: one slider run on release with its number, a select option, a button with no input", async ({ page }) => {
  await page.goto(gallery({ scene: "all" }));
  const slider = page.locator('[data-node="c_slideraaaa"] input[type=range]');
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.05), box.y + box.height / 2);
  await page.mouse.up();
  await page.locator('[data-node="c_selectaaaa"] select').selectOption("cool");
  await page.locator('[data-node="c_buttonaaaa"] button').click();
  await page.locator("[data-confirm-run]").click(); // the control's own confirm text
  await expect(page.locator("[data-sent]")).toHaveCount(3);
  const runs = await sent(page);
  writeEvidence("controls/runs.json", runs);
  const slide = runs.filter((r) => r.controlId === "k_dimmeraaaa");
  expect(slide).toHaveLength(1);
  expect(typeof slide[0]!.input).toBe("number");
  expect(runs.find((r) => r.controlId === "k_modeaaaaaa")!.input).toBe("cool");
  expect("input" in runs.find((r) => r.controlId === "k_sceneaaaaa")!).toBe(false);
});

test("criterion 21: in a draft preview every run opens the host confirm first", async ({ page }) => {
  await page.goto(gallery({ scene: "all", mode: "draft-preview" }));
  await toggle(page).click();
  const dialog = page.locator("[data-control-confirm]");
  await expect(dialog).toBeVisible();
  await expect(page.locator("[data-confirm-title]")).toHaveText("Draft preview: run Desk lamp for real?");
  await page.screenshot({ path: evidence("controls/draft-confirm.png") });
  expect(await sent(page)).toHaveLength(0);
  await page.locator("[data-confirm-run]").click();
  await expect(page.locator("[data-sent]")).toHaveCount(1);
  expect((await sent(page))[0]).toMatchObject({ draft: true, confirmed: true });
  await page.locator('[data-node="c_buttonaaaa"] button').click();
  await page.locator("[data-confirm-cancel]").click();
  await page.waitForTimeout(500);
  expect(await sent(page)).toHaveLength(1);
});

test("criterion 22: in render mode every control is disabled and sends nothing", async ({ page }) => {
  await page.goto(gallery({ scene: "all", mode: "agent-render" }));
  for (const id of ["c_toggleaaaa", "c_buttonaaaa"]) await expect(page.locator(`[data-node="${id}"] button`)).toBeDisabled();
  await expect(page.locator('[data-node="c_slideraaaa"] input')).toBeDisabled();
  await expect(page.locator('[data-node="c_selectaaaa"] select')).toBeDisabled();
  // Regression r3 (test race, seen once in a full run): the forced click hit the switch while it had no box
  // yet ("Element is not visible"). Wait until it is drawn; the disabled checks and "sends nothing" are unchanged.
  await expect(toggle(page)).toBeVisible();
  await toggle(page).click({ force: true });
  await page.waitForTimeout(500);
  expect(await sent(page)).toHaveLength(0);
});

test("criterion 23: names, switch role and polite announcements", async ({ page }) => {
  await page.goto(gallery({ scene: "all" }));
  await expect(page.getByRole("switch", { name: "Desk lamp" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Bed lamp" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Mode" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Movie scene" })).toBeVisible();
  await expect(page.locator('[data-node="c_toggleaaaa"] [aria-live="polite"]')).toHaveCount(1);
});
