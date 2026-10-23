// Gauntlet w2-r3, operator-approved final pass (app-builder): a guest gets source-free bindings
// resolved at page load and in the offline snapshot (item 4 in the merged report: "%" vs 41.3), and the
// review warns when a control maps a parameter its command never sends (item 3: the toggle sent an
// empty body). Real temp SQLite; components' guest resolver is real; the rest is the local fake.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandDef, CustomCommand } from "@/core/contracts";
import { editor, guestOf, owner, seedIntegration, seedUsers, setupAppsDb, viewer } from "./harness";

const PARAMS = { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] };
const EMPTY: CommandDef = { id: "lamp.empty", label: "Lamp (empty body)", description: "", params: PARAMS, risk: "low" };
const SENDS: CommandDef = { id: "lamp.sends", label: "Lamp (sends on)", description: "", params: PARAMS, risk: "low" };
const record = (def: CommandDef, body: unknown): CustomCommand => ({ id: def.id, label: def.label, description: "", method: "POST", path: "/lamp", params: PARAMS, risk: "low", ...(body !== undefined ? { body } : {}) }) as CustomCommand;
vi.mock("@/features/integrations/commands", async (orig) => {
  const real = await orig<typeof import("@/features/integrations/commands")>();
  return {
    ...real,
    commandCatalog: (row: Parameters<typeof real.commandCatalog>[0]) =>
      new Map([...real.commandCatalog(row), [EMPTY.id, { def: EMPTY, custom: record(EMPTY, undefined) }], [SENDS.id, { def: SENDS, custom: record(SENDS, { on: "{{ params.on }}" }) }]]) as ReturnType<typeof real.commandCatalog>,
  };
});
vi.mock("@/features/apps/deps", async () => {
  const lib = await import("@/features/library/server");
  const components = await import("@/features/components");
  return { ...(await import("./harness")).fakeDeps, resolveGuestValues: components.resolveGuestValues, libraryForDoc: lib.libraryForDoc, getLibrary: lib.getLibrary, importLibrary: lib.importLibrary, toComponentFile: lib.toComponentFile, parseComponentFile: lib.parseComponentFile, CONTAINS_CODE_NOTICE: lib.CONTAINS_CODE_NOTICE };
});

setupAppsDb();

let svc: typeof import("../service");
let versions: typeof import("@/features/versions/service");
let repo: typeof import("../repo");
let load: typeof import("../load");
let checks: typeof import("../checks");
let gv: typeof import("../guest-values");
let cp: typeof import("../control-params");
let haId = "";

beforeAll(async () => {
  await seedUsers();
  haId = await seedIntegration(owner);
  svc = await import("../service");
  versions = await import("@/features/versions/service");
  repo = await import("../repo");
  load = await import("../load");
  checks = await import("../checks");
  gv = await import("../guest-values");
  cp = await import("../control-params");
});

async function statApp(slug: string, withUnmapped: boolean) {
  const { app } = withUnmapped ? svc.createApp(owner, { name: "Homelab", slug, template: "homelab", mappings: {} }) : svc.createApp(owner, { name: "Stat", slug });
  const d = repo.getDraft(app.id)!;
  svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_freestatab", type: "stat", props: { data: { $bind: "{{ 41.27 | round(1) }}" }, unit: "%", label: "CPU" }, slot: { x: 0, y: 60, w: 4, h: 8 } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_freetextab", type: "text", props: { text: { $bind: "Page {{ $page.title | upper }}" } }, slot: { x: 4, y: 60, w: 4, h: 4 } } },
    { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_nowtextabc", type: "text", props: { text: { $bind: "{{ $now | date }}" } }, slot: { x: 8, y: 60, w: 4, h: 4 } } },
  ] });
  const review = versions.reviewDraft(owner, app.id);
  await versions.publishDraft(owner, app.id, { expectRev: review.rev });
  svc.updateAccess(owner, app.id, { view: "everyone", edit: "owner", guests: true });
  return repo.getApp(app.id)!;
}

describe("item 4: a guest sees source-free bindings resolved", () => {
  it("sourceFree accepts constants and page facts, refuses data sources, $data, $now, $item and $sources", () => {
    expect(gv.sourceFree("{{ 41.27 | round(1) }}")).toBe(true);
    expect(gv.sourceFree("Page {{ $page.title | upper }}")).toBe(true);
    for (const t of ["{{ cpu.value }}", "{{ $data.cpu }}", "{{ $now | date }}", "{{ $item.name }}", "{{ $sources.cpu.state }}", "{{ $input }}", "{{ $viewer.name }}"]) expect(gv.sourceFree(t), t).toBe(false);
  });

  for (const withUnmapped of [false, true]) {
    it(`page ${withUnmapped ? "with" : "without"} unconnected sources: the guest's load and offline snapshot carry 41.3, the page title, and nothing data-bound`, async () => {
      const app = await statApp(`r4-free-${withUnmapped ? "u" : "p"}`, withUnmapped);
      for (const snapshot of [false, true]) {
        const s = await load.loadView(app.slug, undefined, guestOf(app.id), { draft: false, render: false, snapshot });
        expect(s.kind).toBe("ok");
        if (s.kind !== "ok") continue;
        const g = s.rendered.guestStatus ?? {};
        expect(g["c_freestatab:data"]).toBe(41.3);
        expect(String(g["c_freetextab:text"])).toMatch(/^Page [A-Z]+$/);
        expect(g["c_nowtextabc:text"]).toBeUndefined(); // the clock ticks on the client
        // Only source-free values and the calm unconnected statuses: no value from a data source.
        for (const [k, v] of Object.entries(g)) if (!k.startsWith("c_free")) expect(k.endsWith(":$status") && (v as { message?: string }).message === "Not connected yet", k).toBe(true);
        if (withUnmapped) expect(Object.keys(g).filter((k) => k.endsWith(":$status")).length).toBe(3);
      }
    });
  }

  it("signed-in viewers are unchanged (they resolve on the client) and snapshots for them still use the guest projection", async () => {
    const app = await statApp("r4-free-v", false);
    const s = await load.loadView(app.slug, undefined, viewer, { draft: false, render: false });
    expect(s.kind === "ok" && s.rendered.guestStatus).toBeFalsy();
    const snap = await load.loadView(app.slug, undefined, editor, { draft: false, render: false, snapshot: true });
    expect(snap.kind === "ok" && (snap.rendered.guestStatus ?? {})["c_freestatab:data"]).toBe(41.3);
  });
});

describe("item 3: the review warns when a control maps a parameter the command never sends", () => {
  const lamp = (commandId: string, params: Record<string, unknown>) => ({ id: "k_lampr4aaaa", label: "Desk lamp", run: { kind: "command" as const, integrationId: haId, commandId, params: params as never } });
  it("unsentParams: only record commands drop params; mapped and not in the body", () => {
    expect(cp.sentParamNames({ on: "{{ params.on }}", x: ["{{params.level}}"] }).sort()).toEqual(["level", "on"]);
    expect(cp.unsentParams(EMPTY, { body: undefined }, { on: { $bind: "{{ $input }}" } }).map((r) => r.name)).toEqual(["on"]);
    expect(cp.unsentParams(EMPTY, { body: { on: "{{ params.on }}" } }, { on: { $bind: "{{ $input }}" } })).toEqual([]);
    expect(cp.unsentParams(EMPTY, undefined, { on: { $bind: "{{ $input }}" } })).toEqual([]); // a code package gets every param
    expect(cp.unsentParams(EMPTY, { body: undefined }, {})).toEqual([]); // unmapped is param_missing's job
  });
  it("checkControl: a warning naming the parameter and the fix, while editing and when publishing; none when the body sends it", () => {
    for (const publishing of [false, true]) {
      const out = checks.checkControl(lamp(EMPTY.id, { on: { $bind: "{{ $input }}" } }), owner, { publishing });
      expect(out.map((p) => `${p.severity}|${p.code}|${p.where.field}`)).toEqual(["warning|control.param_unsent|run.params.on"]);
      expect(out[0]!.message).toBe("Desk lamp sets on, but the command Lamp (empty body) never sends it: its body has no {{ params.on }}.");
      expect(out[0]!.fix).toContain('{"on": "{{ params.on }}"}');
    }
    expect(checks.checkControl(lamp(SENDS.id, { on: { $bind: "{{ $input }}" } }), owner, { publishing: true })).toEqual([]);
  });
  it("the publish review lists it as a warning on the toggle; publishing stays possible", async () => {
    const { app } = svc.createApp(owner, { name: "Lamp", slug: "r4-lamp" });
    const d = repo.getDraft(app.id)!;
    svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [
      { op: "control.set", control: lamp(EMPTY.id, { on: { $bind: "{{ $input }}" } }) },
      { op: "node.add", parentId: d.doc.pages[0]!.root.id, node: { id: "c_lampr4togg", type: "toggle", props: { label: "Desk lamp", control: "k_lampr4aaaa" }, slot: { x: 0, y: 0, w: 4, h: 8 } } },
    ] });
    const review = versions.reviewDraft(owner, app.id);
    expect(review.problems.find((x) => x.code === "control.param_unsent")).toMatchObject({ severity: "warning", where: { nodeId: "c_lampr4togg" } });
    expect(review.canPublish).toBe(true);
  });
});
