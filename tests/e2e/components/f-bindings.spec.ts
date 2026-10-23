// Criterion 17 (server and browser give identical results on the shared corpus) and 18 (no per-second
// re-render on a page that does not read $now), plus the data states (28) in a browser.
import { expect, test } from "@playwright/test";
import { CORPUS, corpusScope } from "../../../src/features/components/bindings/corpus";
import { evaluateTemplate } from "../../../src/features/components/bindings/evaluate";
import { evidence, gallery, signIn, writeEvidence } from "./helpers";

test.beforeEach(async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await signIn(context, page.request);
});

test("criterion 17: the corpus gives identical results in Node and in the browser", async ({ page }) => {
  await page.goto(gallery({ scene: "bindings" }));
  const pre = page.locator('[data-corpus-result="ready"]');
  await expect(pre).toBeVisible();
  const browser = JSON.parse((await pre.textContent())!);
  const node = JSON.parse(JSON.stringify(CORPUS.map((t) => evaluateTemplate(t, corpusScope()))));
  const diffs = CORPUS.map((t, i) => ({ t, node: node[i], browser: browser[i] })).filter((x) => JSON.stringify(x.node) !== JSON.stringify(x.browser));
  writeEvidence("bindings/corpus-compare.json", { templates: CORPUS.length, diffs });
  expect(CORPUS.length).toBeGreaterThanOrEqual(50);
  expect(diffs).toEqual([]);
});

test("criterion 18: no per-second re-render without $now", async ({ page }) => {
  await page.goto(gallery({ scene: "states" }));
  await expect(page.locator('[data-type="stat"]').first()).toBeVisible();
  await page.waitForTimeout(1000);
  const mutations = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let n = 0;
        const mo = new MutationObserver((l) => (n += l.length));
        mo.observe(document.querySelector(".atr-render-root")!, { subtree: true, childList: true, characterData: true, attributes: true });
        setTimeout(() => {
          mo.disconnect();
          resolve(n);
        }, 3500);
      }),
  );
  writeEvidence("bindings/no-tick.json", { mutationsIn3500ms: mutations });
  expect(mutations).toBe(0);
});

test("criteria 26 to 28: states in the browser, with the failed message on hover and on keyboard focus", async ({ page }) => {
  await page.goto(gallery({ scene: "states" }));
  await expect(page.locator('[data-node="c_stunsharea"]')).toContainText("No data: this integration is no longer shared");
  await expect(page.locator('[data-node="c_stloadinga"] [aria-label="Loading"]')).toBeVisible();
  await expect(page.locator('[data-node="c_stemptyaaa"]')).toContainText("No data yet");
  await expect(page.locator('[data-node="c_ststaleaaa"] [data-state-mark="stale"]')).toBeVisible();
  const tip = page.locator('[data-node="c_stfailedaa"] [role="tooltip"]');
  await expect(tip).toBeHidden();
  await page.locator('[data-node="c_stfailedaa"] [data-state-mark="failed"]').hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Timed out reaching the Docker proxy");
  await expect(tip).toContainText("Check that the socket proxy is running.");
  await page.mouse.move(0, 0);
  await page.locator('[data-node="c_stfailedaa"] [data-state-mark="failed"]').focus();
  await expect(tip).toBeVisible();
  await page.screenshot({ path: evidence("states/states.png"), fullPage: true });
  await page.goto(gallery({ scene: "unavailable" }));
  await expect(page.locator('[data-node="c_stfreshaaa"]')).toContainText("Not available yet");
  await expect(page.locator('[data-node="c_stoggleaaa"] [role="switch"]')).toBeDisabled();
  await page.screenshot({ path: evidence("states/unavailable.png"), fullPage: true });
});
