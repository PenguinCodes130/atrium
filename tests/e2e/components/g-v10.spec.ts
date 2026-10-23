// V10 capture: every response the components surfaces send (gallery pages including the guest scene,
// the library API and export file, the frame document) and every block log message, saved for the
// grep in v10-grep.mjs. Saved under evidence/components/r1/v10/captured/.
import { expect, test } from "@playwright/test";
import { evidence, gallery, ORIGIN, signIn, withFrameFix } from "./helpers";
import { writeFileSync } from "node:fs";

test("V10 capture of components traffic", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await signIn(context, page.request);
  await withFrameFix(context);
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (!r.url().startsWith(ORIGIN) || r.url().includes("/_next/static/")) return;
    try { bodies.push(`== ${r.url()}\n${await r.text()}`); } catch { /* redirects have no body */ }
  });
  for (const scene of ["all", "guest", "states", "sandbox"]) {
    await page.goto(gallery({ scene, probes: "storage,network" }));
    await page.waitForTimeout(2500);
  }
  bodies.push(`== block logs\n${await page.locator("[data-block-log]").allTextContents()}`);
  await page.goto(`${ORIGIN}/library`);
  const list = await (await page.request.get(`${ORIGIN}/api/library`)).text();
  bodies.push(`== /api/library\n${list}`);
  const first = JSON.parse(list).components[0];
  if (first) bodies.push(`== export\n${await (await page.request.get(`${ORIGIN}/api/library/${first.id}/export`)).text()}`);
  bodies.push(`== frame\n${await (await page.request.get(`${ORIGIN}/sandbox/frame`)).text()}`);
  writeFileSync(evidence("v10/captured/traffic.txt"), bodies.join("\n\n"));
  expect(bodies.length).toBeGreaterThan(5);
});
