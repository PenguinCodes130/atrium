// First-run screens. Start the slot in the scenario first:
//   tests/e2e/auth/serve.sh missing &   (or invalid)
//   ATRIUM_E2E_SCENARIO=missing ATRIUM_E2E_SLOT=auth ATRIUM_E2E_PORT=3111 pnpm exec playwright test tests/e2e/auth/setup.spec.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../fixtures";
import { EVIDENCE, SCENARIO, VARIANTS, applyVariant, db, minContrast, shot } from "./helpers";

test.skip(SCENARIO !== "missing" && SCENARIO !== "invalid", "missing or invalid scenario only");

const MESSAGE = SCENARIO === "missing" ? "Set ATRIUM_OWNER_EMAIL and restart" : "ATRIUM_OWNER_EMAIL is not a valid email address";

test(`setup-required (${SCENARIO}): every page shows only the sentence, APIs 401, nothing created (criteria 1, 2, 8)`, async ({ page, context, request, baseURL }, info) => {
  const mobile = info.project.name === "mobile";
  for (const p of ["/", "/settings", "/sign-in", "/sign-up", "/integrations/x/credentials?draft=y"]) {
    await page.goto(p);
    await expect(page).toHaveURL(/\/setup-required$/);
    await expect(page.getByRole("heading")).toHaveText(MESSAGE);
    await expect(page.locator("main input, main a, main button, main form, main textarea, main select")).toHaveCount(0);
  }
  const rows: string[] = [];
  for (const p of ["/api/pages", "/api/settings", "/api/auth/get-session", "/api/auth/sign-in/email", "/mcp"]) {
    const r = await request.get(p, { maxRedirects: 0 });
    rows.push(`${r.status()} GET ${p}`);
    expect(r.status(), p).toBe(401);
  }
  const h = await request.get("/api/health");
  rows.push(`${h.status()} GET /api/health ${await h.text()}`);
  expect(h.status()).toBe(200);
  const d = db();
  const counts = { users: (d.prepare("SELECT count(*) n FROM user").get() as { n: number }).n, allowlist: (d.prepare("SELECT count(*) n FROM allowlist").get() as { n: number }).n };
  d.close();
  rows.push(`users=${counts.users} allowlist=${counts.allowlist}`);
  expect(counts).toEqual({ users: 0, allowlist: 0 });
  if (!mobile) writeFileSync(path.join(EVIDENCE, `setup-${SCENARIO}.txt`), rows.join("\n") + "\n");

  for (const v of VARIANTS) {
    await context.clearCookies();
    await applyVariant(context, v, baseURL!);
    await page.goto("/");
    await expect(page.getByRole("heading")).toHaveText(MESSAGE);
    if (!mobile && v.name === "light") expect((await minContrast(page)).ratio).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: shot(`setup-${SCENARIO}-${v.name}${mobile ? "-mobile" : ""}`) });
  }
});
