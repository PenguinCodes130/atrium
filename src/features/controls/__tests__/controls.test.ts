// Control runs (spec v2 sections 3.4, criteria 19 to 28; architecture v3 section 6.2, A1.4), all
// against a double of the app-access hook and a local fake Home Assistant. Every response and
// what the fake saw are written to evidence/integrations/r6/security/controls.jsonl.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ControlDef, Principal } from "@/core/contracts";
import { setupTestDb } from "@/features/integrations/__tests__/db-harness";
import { appOf, fakeHomeAssistant, guest, HA_TOKEN, hookDouble, member, node, owner, type DoubleState, type FakeHa } from "./harness";

setupTestDb();

const EVIDENCE = path.resolve(__dirname, "../../../../evidence/integrations/r6/security/controls.jsonl");
mkdirSync(path.dirname(EVIDENCE), { recursive: true });
writeFileSync(EVIDENCE, "");
const record = (test: string, data: unknown) => appendFileSync(EVIDENCE, `${JSON.stringify({ test, ...(data as object) })}\n`);

let svc: typeof import("@/features/integrations/service");
let hooks: typeof import("@/core/hooks");
let run: typeof import("../run");
let limits: typeof import("../limits");
let runners: typeof import("../runners");
let route: typeof import("../route");
let repo: typeof import("../repo");
let db: typeof import("@/core/db");
let ha: FakeHa;
let haId: string;
let state: DoubleState;

const lampToggle = (over: Partial<ControlDef> = {}): ControlDef => ({ id: "k_lamp000001", label: "Bedroom lamp", run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: "light.lamp" } }, ...over });

function place(control: ControlDef, n: ReturnType<typeof node>, version = 3) {
  state.controls.set(`${control.id}|${n.id}`, { control, node: n, version });
}

async function click(p: Principal | null, body: Record<string, unknown>) {
  const out = await run.runControl({ principal: p }, body);
  return out;
}

function auditRows(): { event: string; result: string; actorKind: string; actorUserId: string | null; actorGuestLabel: string | null; detail: Record<string, unknown> | null }[] {
  return db.sqlite().prepare("select event, result, actor_kind as actorKind, actor_user_id as actorUserId, actor_guest_label as actorGuestLabel, detail from audit_log where event = 'control.run' order by at").all().map((r) => {
    const row = r as { detail: string | null } & Record<string, unknown>;
    return { ...row, detail: row.detail ? JSON.parse(row.detail) : null } as never;
  });
}
const runRows = () => db.sqlite().prepare("select * from control_run order by at").all() as Record<string, unknown>[];
const clearTables = () => { db.sqlite().prepare("delete from audit_log").run(); db.sqlite().prepare("delete from control_run").run(); };

beforeAll(async () => {
  svc = await import("@/features/integrations/service");
  hooks = await import("@/core/hooks");
  run = await import("../run");
  limits = await import("../limits");
  runners = await import("../runners");
  route = await import("../route");
  repo = await import("../repo");
  db = await import("@/core/db");
  ha = await fakeHomeAssistant();
  const i = svc.createIntegration(owner, { packageId: "home-assistant", name: "Home Assistant", config: { baseUrl: ha.url }, secrets: { token: HA_TOKEN }, untested: true });
  haId = i.id;
});
afterAll(async () => { await ha.close(); });

beforeEach(() => {
  hooks.resetAppAccess();
  runners.resetControlRunners();
  // A clock that moves 1 s per check, so cooldowns never get in the way unless a test wants them.
  let t = 1_000_000;
  limits.resetControlLimits(() => (t += 1000));
  state = { app: appOf(), controls: new Map(), draftControls: new Map(), openable: () => true, editable: (p) => p.kind === "user" && p.role === "owner" };
  ha.calls.length = 0;
  clearTables();
});

const register = () => hooks.registerAppAccess(hookDouble(state));
const BASE = { appId: "app-1", nodeId: "c_node00001", controlId: "k_lamp000001" };

describe("who may run a control (criteria 19, 20)", () => {
  const req = (headers: Record<string, string>, url = "http://127.0.0.1:3113/api/controls/run") =>
    new Request(url, { method: "POST", headers: { origin: "http://127.0.0.1:3113", "content-type": "application/json", ...headers }, body: JSON.stringify(BASE) });

  beforeEach(() => { register(); place(lampToggle(), node("button", { control: "k_lamp000001" })); });

  it.each([
    ["an MCP bearer token", { authorization: "Bearer atr_oat_FAKE-test-token" }],
    ["a personal access token", { authorization: "Bearer atr_pat_FAKE-test-token" }],
    ["any Authorization header", { authorization: "Basic dGVzdDp0ZXN0" }],
    ["a render session cookie", { cookie: "atrium.render=FAKE-ticket" }],
    ["a render-mode page", { "x-atrium-render": "1" }],
  ])("refuses %s and runs nothing", async (what, headers) => {
    const res = await route.handleControlRun(req(headers));
    const body = await res.json();
    record(`refuse ${what}`, { status: res.status, body, haCalls: ha.calls.length });
    expect(res.status).toBe(403);
    expect(body).toMatchObject({ ok: false, code: "forbidden" });
    expect(ha.calls).toHaveLength(0);
    expect(runRows()).toHaveLength(0);
  });

  it("refuses a referer in render mode and a request from another origin", async () => {
    const r1 = await route.handleControlRun(req({ referer: "http://127.0.0.1:3113/a/home?draft=1&render=1" }));
    const r2 = await route.handleControlRun(req({ origin: "http://evil.example" }));
    expect([r1.status, r2.status]).toEqual([403, 403]);
    expect((await r2.json()).message).toMatch(/did not come from this Atrium/);
    expect(ha.calls).toHaveLength(0);
  });

  it("refuses a run with no session and no guest cookie (criterion 20)", async () => {
    const res = await route.handleControlRun(req({}));
    const body = await res.json();
    record("no session", { status: res.status, body });
    expect(res.status).toBe(403);
    expect(body.code).toBe("forbidden");
    expect(ha.calls).toHaveLength(0);
    // The core refuses a missing principal too, whatever reaches it.
    expect((await click(null, BASE)).status).toBe(403);
  });

  it("refuses agent principals even if one reached the runner", async () => {
    const out = await click({ kind: "builtin-agent", userId: "u-owner", role: "owner", conversationId: "c1" }, BASE);
    expect(out.body).toMatchObject({ ok: false, code: "forbidden" });
    expect(ha.calls).toHaveLength(0);
  });
});

describe("before Wave 2 (criterion 21)", () => {
  it("with the hook unregistered every run is refused as not available, nothing runs and no run is recorded", async () => {
    const out = await click(owner, BASE);
    record("hook unregistered", { status: out.status, body: out.body, haCalls: ha.calls.length, runRows: runRows().length });
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ ok: false, code: "not_available" });
    expect(ha.calls).toHaveLength(0);
    expect(runRows()).toHaveLength(0);
    // The refusal itself is audited (A1.4).
    expect(auditRows()).toEqual([expect.objectContaining({ result: "error", detail: expect.objectContaining({ refused: "not_available" }) })]);
  });
});

describe("input checked against the published node (criteria 22, 23, 24)", () => {
  beforeEach(() => register());

  it.each([
    ["a toggle given a string", node("toggle", { control: "k_lamp000001" }), "true"],
    ["a toggle given an object that names another entity", node("toggle", { control: "k_lamp000001" }), { entityId: "lock.front_door" }],
    ["a slider below its min", node("slider", { control: "k_lamp000001", min: 0, max: 100, step: 5 }), -5],
    ["a slider above its max", node("slider", { control: "k_lamp000001", min: 0, max: 100, step: 5 }), 105],
    ["a slider off its step", node("slider", { control: "k_lamp000001", min: 0, max: 100, step: 5 }), 52],
    ["a slider given a string", node("slider", { control: "k_lamp000001", min: 0, max: 100, step: 5 }), "50"],
    ["a select value not in its options", node("select", { control: "k_lamp000001", options: [{ value: "a", label: "A" }, "b"] }), "c"],
    ["a button with input", node("button", { control: "k_lamp000001" }), 1],
  ])("refuses %s before anything runs", async (what, n, input) => {
    place(lampToggle(), n);
    const out = await click(owner, { ...BASE, input });
    record(`input ${what}`, { status: out.status, body: out.body, haCalls: ha.calls.length });
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ ok: false, code: "invalid_input" });
    expect(ha.calls).toHaveLength(0);
  });

  it("accepts each component's own input", async () => {
    const bright: ControlDef = { id: "k_lamp000001", label: "Lamp brightness", run: { kind: "command", integrationId: haId, commandId: "light.turn_on", params: { entityId: "light.lamp", brightnessPct: { $bind: "{{ $input }}" } } } };
    place(bright, node("slider", { control: "k_lamp000001", min: 0, max: 100, step: 5 }));
    expect((await click(owner, { ...BASE, input: 55 })).body).toEqual({ ok: true });
    place(bright, node("select", { control: "k_lamp000001", options: [{ value: 25, label: "Low" }, { value: 100, label: "Full" }] }));
    expect((await click(owner, { ...BASE, input: 100 })).body.ok).toBe(true);
    place(lampToggle(), node("toggle", { control: "k_lamp000001" }));
    expect((await click(owner, { ...BASE, input: true })).body.ok).toBe(true);
    expect(ha.calls.map((c) => c.body)).toEqual([{ entity_id: "light.lamp", brightness_pct: 55 }, { entity_id: "light.lamp", brightness_pct: 100 }, { entity_id: "light.lamp" }]);
  });

  it("input that tries to set the entity id never changes the target: the literal entity id is used (criterion 23)", async () => {
    const html = node("html", { html: "<b>x</b>", data: {}, controls: ["k_lamp000001"], height: "auto" });
    const ctl: ControlDef = { id: "k_lamp000001", label: "Lamp", run: { kind: "command", integrationId: haId, commandId: "light.turn_on", params: { entityId: "light.lamp", brightnessPct: { $bind: "{{ $input.brightnessPct }}" } } } };
    place(ctl, html);
    const bad = await click(owner, { ...BASE, input: { entityId: "light.porch", brightnessPct: 40 } });
    expect(bad.status).toBe(400);
    expect(ha.calls).toHaveLength(0);
    const ok = await click(owner, { ...BASE, input: { brightnessPct: 40 } });
    expect(ok.body.ok).toBe(true);
    expect(ha.calls).toEqual([expect.objectContaining({ path: "/api/services/light/turn_on", body: { entity_id: "light.lamp", brightness_pct: 40 } })]);
    // A control whose target is a binding, even $input, is refused: targets are fixed by the author.
    place({ ...ctl, run: { kind: "command", integrationId: haId, commandId: "light.toggle", params: { entityId: { $bind: "{{ $input }}" } } } }, node("select", { control: "k_lamp000001", options: ["light.porch"] }));
    const bound = await click(owner, { ...BASE, input: "light.porch" });
    record("target from input", { bad: bad.body, ok: ok.body, bound: bound.body, haCalls: ha.calls });
    expect(bound.body).toMatchObject({ ok: false, code: "invalid_input" });
    expect(ha.calls).toHaveLength(1);
  });

  it("refuses an html block run whose input fails the control's parameter schema (criterion 24)", async () => {
    const html = node("html", { html: "<b>x</b>", data: {}, controls: ["k_lamp000001"], height: "auto" });
    place({ id: "k_lamp000001", label: "Lamp", run: { kind: "command", integrationId: haId, commandId: "light.turn_on", params: { entityId: "light.lamp", brightnessPct: { $bind: "{{ $input.brightnessPct }}" } } } }, html);
    for (const input of [{ brightnessPct: 150 }, { brightnessPct: "high" }, { colour: "red" }, [1, 2], "on"]) {
      const out = await click(owner, { ...BASE, input });
      expect(out.body).toMatchObject({ ok: false, code: "invalid_input" });
    }
    // A block that does not list the control cannot run it at all.
    place(lampToggle(), node("html", { html: "", data: {}, controls: [], height: "auto" }));
    expect((await click(owner, BASE)).body).toMatchObject({ ok: false, code: "forbidden" });
    expect(ha.calls).toHaveLength(0);
  });
});

describe("limits (criteria 25, 26)", () => {
  beforeEach(() => register());

  it("refuses the 31st run within one minute by one principal on one app, audited once", async () => {
    let t = 2_000_000;
    limits.resetControlLimits(() => (t += 300)); // two checks per run: 0.6 s per run, all 32 inside one minute
    place(lampToggle(), node("button", { control: "k_lamp000001" }));
    const results: number[] = [];
    for (let i = 0; i < 32; i++) results.push((await click(owner, BASE)).status);
    record("31st run", { statuses: results, haCalls: ha.calls.length });
    expect(results.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(results[30]).toBe(429);
    expect(results[31]).toBe(429);
    expect(ha.calls).toHaveLength(30);
    const refusals = auditRows().filter((r) => r.detail?.refused === "rate_limited");
    expect(refusals).toHaveLength(1); // A1.4: only the first rate-limit refusal per principal per minute
    // Another principal on the same app still has its own budget.
    expect((await click(member, BASE)).status).toBe(200);
  });

  it("does not run a second click inside the cooldown, and answers 429 with Retry-After", async () => {
    let t = 5_000_000;
    limits.resetControlLimits(() => t);
    place(lampToggle({ cooldownMs: 2000 }), node("button", { control: "k_lamp000001" }));
    expect((await click(owner, BASE)).status).toBe(200);
    t += 1500;
    const second = await click(member, BASE); // cooldown is per control: another viewer is held too
    record("cooldown", { second, haCalls: ha.calls.length });
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ ok: false, code: "rate_limited" });
    expect(second.retryAfterSec).toBe(1);
    expect(ha.calls).toHaveLength(1);
    t += 600;
    expect((await click(owner, BASE)).status).toBe(200);
    // A cooldown below 250 ms is raised to 250 ms.
    expect(limits.cooldownOf(10)).toBe(250);
    expect(limits.cooldownOf(undefined)).toBe(500);
  });

  it("never has more than 2 runs of one control in flight; a third waits its turn", async () => {
    const slow = await fakeHomeAssistant({ delayMs: 300 });
    try {
      const i = svc.createIntegration(owner, { packageId: "home-assistant", name: "Slow HA", config: { baseUrl: slow.url }, secrets: { token: HA_TOKEN }, untested: true });
      place({ ...lampToggle(), run: { kind: "command", integrationId: i.id, commandId: "light.toggle", params: { entityId: "light.lamp" } } }, node("button", { control: "k_lamp000001" }));
      const outs = await Promise.all([click(owner, BASE), click(member, BASE), click({ ...member, userId: "u-3" }, BASE)]);
      record("concurrency", { statuses: outs.map((o) => o.status), peak: slow.peak(), calls: slow.calls.length });
      expect(outs.map((o) => o.status)).toEqual([200, 200, 200]);
      expect(slow.calls).toHaveLength(3);
      expect(slow.peak()).toBe(2);
    } finally {
      await slow.close();
    }
  });

  it("a click that waits more than 5 seconds gets busy", async () => {
    const l = new limits.ControlLimits();
    expect(await l.acquire("a|k")).toBe(true);
    expect(await l.acquire("a|k")).toBe(true);
    const t0 = Date.now();
    expect(await l.acquire("a|k", 200)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    l.release("a|k");
    expect(await l.acquire("a|k", 200)).toBe(true);
  });
});

describe("workflow controls (criterion 27)", () => {
  beforeEach(() => register());

  it("returns 'Workflow controls arrive with actions' and contacts nothing", async () => {
    place({ id: "k_lamp000001", label: "Movie night", run: { kind: "workflow", actionId: "movie-night" } }, node("button", { control: "k_lamp000001" }));
    const out = await click(owner, BASE);
    record("workflow", { out, haCalls: ha.calls.length });
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ ok: false, code: "not_available", message: "Workflow controls arrive with actions" });
    expect(ha.calls).toHaveLength(0);
  });

  it("hands a workflow control to the registered runner", async () => {
    const seen: string[] = [];
    runners.registerControlRunner("workflow", async (ctx) => { seen.push(ctx.control.run.actionId); return { ok: true, message: "Sent" }; });
    place({ id: "k_lamp000001", label: "Movie night", run: { kind: "workflow", actionId: "movie-night" } }, node("button", { control: "k_lamp000001" }));
    expect((await click(owner, BASE)).body).toEqual({ ok: true, message: "Sent" });
    expect(seen).toEqual(["movie-night"]);
  });
});

describe("records and audit (criterion 28)", () => {
  beforeEach(() => register());

  it("each run writes one control run record and one control.run audit entry with control id, label, version, input and duration", async () => {
    place({ id: "k_lamp000001", label: "Lamp brightness", run: { kind: "command", integrationId: haId, commandId: "light.turn_on", params: { entityId: "light.lamp", brightnessPct: { $bind: "{{ $input }}" } } } }, node("slider", { control: "k_lamp000001", min: 0, max: 100, step: 1 }), 7);
    const out = await click(member, { ...BASE, input: 30 });
    expect(out.body.ok).toBe(true);
    const runs = runRows();
    const entries = auditRows();
    record("records", { runs, entries });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ app_id: "app-1", version: 7, control_id: "k_lamp000001", by_kind: "user", by_user_id: "u-member", result: "ok" });
    expect(JSON.parse(runs[0]!.input as string)).toBe(30);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ result: "ok", actorKind: "user", actorUserId: "u-member" });
    expect(entries[0]!.detail).toMatchObject({ controlId: "k_lamp000001", label: "Lamp brightness", version: 7, input: 30 });
    expect(typeof entries[0]!.detail!.durationMs).toBe("number");
  });

  it("a guest's entry carries the link label and no user id; a failure records the error message", async () => {
    place(lampToggle(), node("button", { control: "k_lamp000001" }));
    expect((await click(guest, BASE)).body.ok).toBe(true);
    // A failure: the device answers 401 because the integration's token is wrong.
    const bad = svc.createIntegration(owner, { packageId: "home-assistant", name: "Broken HA", config: { baseUrl: ha.url }, secrets: { token: "atrium-r3-FAKE-wrong-token" }, untested: true });
    place({ ...lampToggle(), run: { kind: "command", integrationId: bad.id, commandId: "light.toggle", params: { entityId: "light.lamp" } } }, node("button", { control: "k_lamp000001" }));
    const failed = await click(guest, BASE);
    const entries = auditRows();
    record("guest", { failed, entries });
    expect(entries.map((e) => [e.actorKind, e.actorUserId, e.actorGuestLabel, e.result])).toEqual([["guest", null, "Guest room, Sam", "ok"], ["guest", null, "Guest room, Sam", "error"]]);
    expect(entries[1]!.detail!.error).toMatch(/refused/);
    expect(failed.body).toMatchObject({ ok: false });
    expect(runRows().map((r) => [r.by_kind, r.by_user_id, r.by_guest_link_id, r.by_label, r.result])).toEqual([["guest", null, "gl-1", "Guest room, Sam", "ok"], ["guest", null, "gl-1", "Guest room, Sam", "error"]]);
  });

  it("a guest can only run controls on its own app, and never a draft", async () => {
    place(lampToggle(), node("button", { control: "k_lamp000001" }));
    expect((await click({ ...guest, appId: "app-2" }, BASE)).body).toMatchObject({ code: "forbidden" });
    expect((await click(guest, { ...BASE, draft: true, confirmed: true })).body).toMatchObject({ code: "forbidden" });
    expect(ha.calls).toHaveLength(0);
  });
});

describe("drafts and the current document (A1.4; behaviour behind criteria 36 and 37)", () => {
  beforeEach(() => register());

  it("a draft run needs confirmed: true, and only an editor gets the draft; it records version 0 and draftRev", async () => {
    state.draftControls.set("k_lamp000001|c_node00001", { control: lampToggle({ label: "Draft lamp" }), node: node("button", { control: "k_lamp000001" }) });
    expect((await click(owner, { ...BASE, draft: true })).body).toMatchObject({ code: "forbidden", message: run.MESSAGES.draftConfirm });
    expect((await click(member, { ...BASE, draft: true, confirmed: true })).body).toMatchObject({ code: "forbidden", message: run.MESSAGES.draftEditors });
    expect(ha.calls).toHaveLength(0);
    expect((await click(owner, { ...BASE, draft: true, confirmed: true })).body.ok).toBe(true);
    expect(runRows()[0]).toMatchObject({ version: 0 });
    expect(auditRows().at(-1)!.detail).toMatchObject({ version: 0, draftRev: 12, label: "Draft lamp" });
  });

  it("a control removed from the published document is refused on the next click", async () => {
    place(lampToggle(), node("button", { control: "k_lamp000001" }));
    expect((await click(owner, BASE)).body.ok).toBe(true);
    state.controls.clear();
    expect((await click(owner, BASE)).body).toMatchObject({ ok: false, code: "forbidden", message: run.MESSAGES.missing });
    expect(ha.calls).toHaveLength(1);
  });

  it("a viewer who cannot open the app is refused", async () => {
    place(lampToggle(), node("button", { control: "k_lamp000001" }));
    state.openable = (p) => p.kind === "user" && p.userId === "u-owner";
    expect((await click(member, BASE)).body).toMatchObject({ code: "forbidden", message: run.MESSAGES.cannotOpen });
    expect(ha.calls).toHaveLength(0);
  });

  it("an unshared integration in an app others can edit refuses with not_shared (A1.1)", async () => {
    state.app = appOf({ access: { view: "everyone", edit: "everyone", guests: false } });
    place(lampToggle(), node("button", { control: "k_lamp000001" }));
    const out = await click(owner, BASE);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ ok: false, code: "not_shared", message: "No data: this integration is no longer shared" });
    svc.updateIntegration(owner, haId, { shared: true });
    expect((await click(owner, BASE)).body.ok).toBe(true);
    svc.updateIntegration(owner, haId, { shared: false });
  });

  it("a command the package does not declare is refused even if a document names it", async () => {
    place({ ...lampToggle(), run: { kind: "command", integrationId: haId, commandId: "lock.unlock", params: { entityId: "lock.front_door" } } }, node("button", { control: "k_lamp000001" }));
    const out = await click(owner, BASE);
    expect(out.body).toMatchObject({ ok: false, code: "forbidden" });
    expect(ha.calls).toHaveLength(0);
  });
});

describe("secrets never in results (criterion 9)", () => {
  it("no control response, run record or audit entry contains the token", async () => {
    register();
    place(lampToggle(), node("button", { control: "k_lamp000001" }));
    const outs = [await click(owner, BASE), await click(guest, { ...BASE, input: { token: HA_TOKEN } })];
    const text = JSON.stringify({ outs, runs: runRows(), audit: db.sqlite().prepare("select * from audit_log").all(), list: repo.listControlRuns("app-1") });
    record("no secrets", { hits: text.includes(HA_TOKEN) ? 1 : 0 });
    expect(text.includes(HA_TOKEN)).toBe(false);
  });
});
