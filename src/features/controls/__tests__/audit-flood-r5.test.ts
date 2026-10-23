// Gauntlet round 2 security finding 2 (Fix List item 2): refused control runs must not grow the
// audit log without limit. Replays app/evidence/gauntlet/r2/security/controls-audit-flood.txt: 60
// refused runs in a row, each with a 15 KB input under the 16 KB cap, before Wave 2 (no app-access
// hook, refused not_available) and with a hook that cannot open the app (refused cannotOpen).
// Before/after audit sizes go to evidence/integrations/r6/security/controls-audit-flood.jsonl.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "@/features/integrations/__tests__/db-harness";
import { appOf, hookDouble, member, owner, type DoubleState } from "./harness";

setupTestDb();

const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/controls-audit-flood.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
const record = (test: string, data: unknown) => appendFileSync(EVIDENCE, `${JSON.stringify({ test, ...(data as object) })}\n`);

let run: typeof import("../run");
let limits: typeof import("../limits");
let hooks: typeof import("@/core/hooks");
let route: typeof import("../route");
let db: typeof import("@/core/db");

const BASE = { appId: "app-1", nodeId: "c_node00001", controlId: "k_lamp000001" };
/** A 15 KB input object, under the 16 KB cap: 15 keys of about 1 KB each. */
const BIG = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`field_${i}`, "x".repeat(1000)]));

function auditSize(): { n: number; bytes: number } {
  const r = db.sqlite().prepare("select count(*) as n, coalesce(sum(length(detail)), 0) as bytes from audit_log where event = 'control.run'").get() as { n: number; bytes: number };
  return r;
}

beforeAll(async () => {
  run = await import("../run");
  limits = await import("../limits");
  hooks = await import("@/core/hooks");
  route = await import("../route");
  db = await import("@/core/db");
});

let clock = 0;
beforeEach(() => {
  hooks.resetAppAccess();
  clock = 5_000_000;
  limits.resetControlLimits(() => clock); // a still clock: every request lands in the same minute
  db.sqlite().prepare("delete from audit_log").run();
});

async function flood(p: typeof owner, n = 60) {
  const before = auditSize();
  const statuses: Record<string, number> = {};
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const out = await run.runControl({ principal: p }, { ...BASE, input: BIG });
    statuses[out.status] = (statuses[out.status] ?? 0) + 1;
  }
  return { before, statuses, ms: Math.round(performance.now() - t0), after: auditSize() };
}

describe("finding 2: refused control runs (controls-audit-flood.txt)", () => {
  it("the input really is about 15 KB and under the cap", () => {
    expect(JSON.stringify(BIG).length).toBeGreaterThan(15_000);
    expect(JSON.stringify(BIG).length).toBeLessThan(16 * 1024);
  });

  it("60 refused runs before Wave 2: at most the refusal limit plus one entry, each a bounded summary, then 429", async () => {
    const r = await flood(owner);
    record("60 refused runs, hook unregistered", r);
    expect(r.statuses["403"]).toBe(limits.REFUSALS_PER_MINUTE);
    expect(r.statuses["429"]).toBe(60 - limits.REFUSALS_PER_MINUTE);
    expect(r.after.n - r.before.n).toBeLessThanOrEqual(limits.REFUSALS_PER_MINUTE + 1);
    // The critic measured about 15 KB stored per refusal (911,047 bytes for 60). Now under 1 KB each.
    expect(r.after.bytes - r.before.bytes).toBeLessThan((limits.REFUSALS_PER_MINUTE + 1) * 1024);
    const rows = db.sqlite().prepare("select detail from audit_log where event = 'control.run'").all() as { detail: string }[];
    for (const row of rows) expect(row.detail).not.toContain("x".repeat(100));
    const first = JSON.parse(rows[0]!.detail);
    expect(first).toMatchObject({ refused: "not_available", input: { type: "object", keyCount: 15 } });
    expect(first.input.bytes).toBeGreaterThan(15_000);
    expect(first.input.keys).toContain("field_0");
  });

  it("the same with a hook that cannot open the app (cannotOpen), which persists past Wave 2", async () => {
    const state: DoubleState = { app: appOf(), controls: new Map(), draftControls: new Map(), openable: () => false, editable: () => false };
    hooks.registerAppAccess(hookDouble(state));
    const r = await flood(member);
    record("60 refused runs, cannot open", r);
    expect(r.statuses["429"]).toBe(60 - limits.REFUSALS_PER_MINUTE);
    expect(r.after.n - r.before.n).toBeLessThanOrEqual(limits.REFUSALS_PER_MINUTE + 1);
    expect(r.after.bytes - r.before.bytes).toBeLessThan((limits.REFUSALS_PER_MINUTE + 1) * 1024);
  });

  it("the 429 carries Retry-After, the limit is per principal, and it lifts after a minute", async () => {
    await flood(owner, limits.REFUSALS_PER_MINUTE);
    const over = await run.runControl({ principal: owner }, BASE);
    expect(over).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(over.retryAfterSec).toBeGreaterThan(0);
    // Another person is not affected.
    expect((await run.runControl({ principal: member }, BASE)).status).toBe(403);
    clock += 61_000;
    expect((await run.runControl({ principal: owner }, BASE)).status).toBe(403);
  });

  it("an unresolvable bearer at the route is refused and writes nothing", async () => {
    // An unresolvable bearer is refused and not audited (no principal); the gate still answers 403.
    const res = await route.handleControlRun(new Request("http://127.0.0.1:3113/api/controls/run", { method: "POST", headers: { origin: "http://127.0.0.1:3113", authorization: "Bearer atr_pat_FAKE-test-token", "content-type": "application/json" }, body: JSON.stringify(BASE) }));
    expect(res.status).toBe(403);
    expect(auditSize().n).toBe(0);
  });
});
