// Wave 2.9 direct data (A10.1): managed sources. Pure rules (names, canonical params, reuse, refresh
// from components, removal) and the two places that run them: the builder's draft client (follow-up ops in
// the same undo step) and the server's applyDraftOps (follow-up ops in the same DraftChange). Real temp
// SQLite for the server part, with a Home Assistant integration row (its endpoints give the timings).
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppDocument, ComponentNode, DataSourceDef, DraftOp } from "@/core/contracts";
import { blankDocument, findNode, newId } from "../doc";
import { applyOpsToDoc } from "../ops";
import { canonicalParams, ensureManaged, managedName, MANAGED_NAME, normaliseOps, nodeRefresh, refreshChoices, type ReadTiming } from "../managed";
import { DraftClient, type SendResult } from "@/features/builder/draft-client";
import { owner, seedIntegration, seedUsers, setupAppsDb } from "./harness";

vi.mock("@/features/apps/deps", async () => ({ ...(await import("./harness")).fakeDeps }));

const stat = (over: Partial<ComponentNode> = {}): ComponentNode => ({ id: newId("c"), type: "stat", props: { label: "" }, slot: { x: 0, y: 0, w: 3, h: 16 }, ...over });
const bound = (name: string, over: Partial<ComponentNode> = {}) => stat({ props: { data: { $bind: `{{ ${name} }}` } }, ...over });
const timing: ReadTiming = (s) => (s.endpointId === "cpu" ? { defaultRefreshSec: 30, minRefreshSec: 10 } : s.endpointId === "slow" ? { defaultRefreshSec: 300, minRefreshSec: 60 } : null);
const CPU = { integrationId: "i1", endpointId: "cpu", params: { machine: "pve1" }, label: "CPU in use, pve1", defaultRefreshSec: 30, minRefreshSec: 10 };

function doc(nodes: ComponentNode[], sources: DataSourceDef[] = []): AppDocument {
  const d = blankDocument("T");
  d.pages[0]!.root.children = nodes;
  d.dataSources = sources;
  return d;
}
const managed = (name: string, over: Partial<DataSourceDef> = {}): DataSourceDef => ({ name, integrationId: "i1", endpointId: "cpu", params: { machine: "pve1" }, refreshSec: 30, managed: true, ...over });

describe("managed names and params", () => {
  it("names are d_ plus 8 lowercase base32 characters, valid source names, unique in the app", () => {
    let n = 0;
    const seq = () => [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5][n++ % 16]!;
    const first = managedName([], seq);
    expect(first).toBe("d_aaaaaaaa");
    n = 0;
    expect(managedName(["d_aaaaaaaa"], seq)).toBe("d_qqqqqqqq");
    for (let i = 0; i < 50; i++) expect(managedName([])).toMatch(MANAGED_NAME);
  });
  it("canonical params sort keys and drop empty values and schema defaults", () => {
    const schema = { properties: { hours: { type: "number", default: 6 }, machine: { type: "string" } } };
    expect(JSON.stringify(canonicalParams({ machine: "pve1", hours: 6, x: "" }, schema))).toBe(JSON.stringify({ machine: "pve1" }));
    expect(Object.keys(canonicalParams({ z: 1, a: 2 }))).toEqual(["a", "z"]);
  });
});

describe("sharing (spec 3.1, criterion 4)", () => {
  it("the same read and thing reuses one managed source; another thing gets its own", () => {
    const d = doc([]);
    const a = ensureManaged(d, CPU);
    expect(a.created).toBe(true);
    const after = applyOpsToDoc(d, a.ops);
    if (!after.ok) throw new Error("apply");
    expect(after.doc.dataSources[0]).toMatchObject({ name: a.name, managed: true, label: "CPU in use, pve1", refreshSec: 30, params: { machine: "pve1" } });
    // Params in another order, with an empty extra, are the same read.
    const again = ensureManaged(after.doc, { ...CPU, params: { extra: "", machine: "pve1" } });
    expect(again).toEqual({ name: a.name, ops: [], created: false });
    const other = ensureManaged(after.doc, { ...CPU, params: { machine: "pve2" } });
    expect(other.created).toBe(true);
    expect(other.name).not.toBe(a.name);
    // An unmanaged source with the same read is never reused (it belongs to the person).
    const mine = doc([], [{ name: "cpu", integrationId: "i1", endpointId: "cpu", params: { machine: "pve1" }, refreshSec: 30 }]);
    expect(ensureManaged(mine, CPU).created).toBe(true);
  });
  it("changing one of two components sharing a source leaves the other bound to it", () => {
    const one = bound("d_aaaaaaaa");
    const two = bound("d_aaaaaaaa");
    const d = doc([one, two], [managed("d_aaaaaaaa")]);
    const pve2 = ensureManaged(d, { ...CPU, params: { machine: "pve2" } });
    const r = applyOpsToDoc(d, [...pve2.ops, { op: "node.update", nodeId: one.id, patch: { props: { data: { $bind: `{{ ${pve2.name} }}` } } } }]);
    if (!r.ok) throw new Error("apply");
    expect(normaliseOps(r.doc, timing)).toEqual([]);
    expect(findNode(r.doc, two.id)!.node.props.data).toEqual({ $bind: "{{ d_aaaaaaaa }}" });
    expect(r.doc.dataSources.map((s) => s.name)).toEqual(["d_aaaaaaaa", pve2.name]);
  });
});

describe("refresh from components (spec 3.3, criterion 5)", () => {
  it("runs at the fastest of its components, each without a setting counting as the read's default", () => {
    const d = doc([bound("d_aaaaaaaa", { refreshSec: 60 }), bound("d_aaaaaaaa", { refreshSec: 300 })], [managed("d_aaaaaaaa", { refreshSec: 30 })]);
    expect(normaliseOps(d, timing)).toEqual([{ op: "source.set", source: managed("d_aaaaaaaa", { refreshSec: 60 }) }]);
    const withDefault = doc([bound("d_aaaaaaaa", { refreshSec: 300 }), bound("d_aaaaaaaa")], [managed("d_aaaaaaaa", { refreshSec: 300 })]);
    expect(normaliseOps(withDefault, timing)).toEqual([{ op: "source.set", source: managed("d_aaaaaaaa", { refreshSec: 30 }) }]);
  });
  it("never runs below the read's minimum, and uses the default when no component sets one", () => {
    const d = doc([bound("d_aaaaaaaa", { refreshSec: 2 })], [managed("d_aaaaaaaa", { refreshSec: 30 })]);
    expect(normaliseOps(d, timing)).toEqual([{ op: "source.set", source: managed("d_aaaaaaaa", { refreshSec: 10 }) }]);
    const slow = doc([bound("d_bbbbbbbb")], [managed("d_bbbbbbbb", { endpointId: "slow", refreshSec: 10 })]);
    expect(normaliseOps(slow, timing)).toEqual([{ op: "source.set", source: managed("d_bbbbbbbb", { endpointId: "slow", refreshSec: 300 }) }]);
  });
  it("an unknown read keeps its interval unless a component sets one", () => {
    const d = doc([bound("d_cccccccc")], [managed("d_cccccccc", { endpointId: "gone", refreshSec: 45 })]);
    expect(normaliseOps(d, timing)).toEqual([]);
    const set = doc([bound("d_cccccccc", { refreshSec: 120 })], [managed("d_cccccccc", { endpointId: "gone", refreshSec: 45 })]);
    expect(normaliseOps(set, timing)).toEqual([{ op: "source.set", source: managed("d_cccccccc", { endpointId: "gone", refreshSec: 120 }) }]);
  });
  it("the Data line's interval and the menu's choices respect the minimum", () => {
    expect(nodeRefresh({}, managed("d_aaaaaaaa", { refreshSec: 10 }), { defaultRefreshSec: 30, minRefreshSec: 10 })).toBe(30);
    expect(nodeRefresh({ refreshSec: 300 }, managed("d_aaaaaaaa"), { defaultRefreshSec: 30, minRefreshSec: 10 })).toBe(300);
    expect(refreshChoices(10).map((c) => c.sec)).toEqual([10, 30, 60, 300, 3600]);
    expect(refreshChoices(10).every((c) => !c.disabled)).toBe(true);
    // F5: presets faster than the read allows stay listed, disabled.
    expect(refreshChoices(30).map((c) => [c.sec, c.disabled])).toEqual([[10, true], [30, false], [60, false], [300, false], [3600, false]]);
    expect(refreshChoices(30).map((c) => c.label)).toEqual(["Every 10 s", "Every 30 s", "Every 1 min", "Every 5 min", "Every 1 hour"]);
    // A minimum between presets is offered too, as the fastest allowed.
    const c15 = refreshChoices(15);
    expect(c15.map((c) => [c.sec, c.disabled])).toEqual([[10, true], [15, false], [30, false], [60, false], [300, false], [3600, false]]);
    expect(c15[1]!.label).toBe("Every 15 s (fastest allowed)");
    expect(refreshChoices(5)[0]).toEqual({ sec: 10, label: "Every 10 s", disabled: false });
  });
});

describe("removal", () => {
  it("removes managed sources nothing binds, and never unmanaged ones", () => {
    const d = doc([bound("d_aaaaaaaa")], [managed("d_aaaaaaaa"), managed("d_zzzzzzzz"), { name: "old", integrationId: "i1", endpointId: "cpu", refreshSec: 30 }]);
    expect(normaliseOps(d, timing)).toEqual([{ op: "source.remove", name: "d_zzzzzzzz" }]);
  });
  it("counts bindings inside chart lines, tile stats, phone props and visibility rules", () => {
    const chart: ComponentNode = { id: newId("c"), type: "chart", props: { lines: [{ data: { $bind: "{{ d_aaaaaaaa }}" }, label: "pve1" }] } };
    const tile: ComponentNode = { id: newId("c"), type: "service-tile", props: { stats: [{ label: "Running", value: { $bind: "{{ d_bbbbbbbb.rows | count }}" } }] } };
    const phone = stat({ responsive: { mobile: { props: { data: { $bind: "{{ d_cccccccc }}" } } } } });
    const vis = stat({ visibleWhen: { $bind: "{{ d_dddddddd.value > 1 }}" } });
    const d = doc([chart, tile, phone, vis], ["d_aaaaaaaa", "d_bbbbbbbb", "d_cccccccc", "d_dddddddd"].map((n) => managed(n, { params: { machine: n } })));
    expect(normaliseOps(d, () => ({ defaultRefreshSec: 30, minRefreshSec: 10 }))).toEqual([]);
  });
});

describe("one undo step (A10.1) in the builder's draft client", () => {
  it("removing the only component reading a managed source removes the source in the same edit; undo brings both back", async () => {
    const a = bound("d_aaaaaaaa");
    const d = doc([a], [managed("d_aaaaaaaa")]);
    const sent: DraftOp[][] = [];
    let rev = 1;
    const client = new DraftClient(d, 1, {
      send: async (_r, ops): Promise<SendResult> => { sent.push(ops); return { ok: true, rev: ++rev }; },
      fetchDraft: async () => ({ rev, doc: d }),
      setTimeout: (fn) => { fn(); return 0; },
      clearTimeout: () => {},
      normalise: (x) => normaliseOps(x, timing),
    });
    client.edit([{ op: "node.remove", nodeId: a.id }]);
    await client.whenSaved();
    expect(client.doc.dataSources).toEqual([]);
    expect(sent[0]).toEqual([{ op: "node.remove", nodeId: a.id }, { op: "source.remove", name: "d_aaaaaaaa" }]);
    client.undo();
    await client.whenSaved();
    expect(client.doc.dataSources).toEqual([managed("d_aaaaaaaa")]);
    expect(findNode(client.doc, a.id)).not.toBeNull();
  });
  it("a component's new refresh moves its source's interval in the same edit", () => {
    const a = bound("d_aaaaaaaa");
    const client = new DraftClient(doc([a], [managed("d_aaaaaaaa")]), 1, { send: async () => ({ ok: true, rev: 2 }), fetchDraft: async () => ({ rev: 1, doc: blankDocument("x") }), setTimeout: () => 0, clearTimeout: () => {}, normalise: (x) => normaliseOps(x, timing) });
    client.edit([{ op: "node.update", nodeId: a.id, patch: { refreshSec: 300 } }]);
    expect(client.doc.dataSources[0]!.refreshSec).toBe(300);
    client.undo();
    expect(client.doc.dataSources[0]!.refreshSec).toBe(30);
    expect(findNode(client.doc, a.id)!.node.refreshSec).toBeUndefined();
  });
});

describe("server normalisation in applyDraftOps (A10.1)", () => {
  let svc: typeof import("../service");
  let repo: typeof import("../repo");
  let haId = "";
  beforeAll(async () => {
    setupAppsDb();
    await seedUsers();
    haId = await seedIntegration(owner);
    svc = await import("../service");
    repo = await import("../repo");
  });

  it("adds the refresh and removal ops to the same DraftChange, and keeps unmanaged sources as they were", () => {
    const { app } = svc.createApp(owner, { name: "Managed", slug: "managed-a" });
    let d = repo.getDraft(app.id)!;
    const root = d.doc.pages[0]!.root.id;
    const statA = stat({ id: "c_managedaaa", props: { data: { $bind: "{{ d_aaaaaaaa }}" } }, refreshSec: 60 });
    const statB = stat({ id: "c_managedbbb", props: { data: { $bind: "{{ d_aaaaaaaa }}" } } });
    // States: default 10 s, minimum 5 s. The agent-style batch sets a wrong interval; the server fixes it.
    const r1 = svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [
      { op: "source.set", source: { name: "d_aaaaaaaa", integrationId: haId, endpointId: "states", refreshSec: 600, managed: true, label: "Lights" } },
      { op: "source.set", source: { name: "mine", integrationId: haId, endpointId: "states", refreshSec: 600 } },
      { op: "node.add", parentId: root, node: statA },
      { op: "node.add", parentId: root, node: statB },
    ] });
    expect(r1.follow).toEqual([{ op: "source.set", source: { name: "d_aaaaaaaa", integrationId: haId, endpointId: "states", refreshSec: 10, managed: true, label: "Lights" } }]);
    d = repo.getDraft(app.id)!;
    expect(d.doc.dataSources.find((s) => s.name === "d_aaaaaaaa")!.refreshSec).toBe(10);
    expect(d.doc.dataSources.find((s) => s.name === "mine")!.refreshSec).toBe(600);
    // Removing both readers removes the managed source in the same change; the unmanaged one stays.
    const r2 = svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [{ op: "node.remove", nodeId: statA.id }, { op: "node.remove", nodeId: statB.id }] });
    expect(r2.follow).toEqual([{ op: "source.remove", name: "d_aaaaaaaa" }]);
    d = repo.getDraft(app.id)!;
    expect(d.doc.dataSources.map((s) => s.name)).toEqual(["mine"]);
    const changes = repo.pendingChanges(app.id);
    const last = changes[changes.length - 1]!;
    expect(last.ops).toEqual([{ op: "node.remove", nodeId: statA.id }, { op: "node.remove", nodeId: statB.id }, { op: "source.remove", name: "d_aaaaaaaa" }]);
    expect(last.summary).not.toContain("d_aaaaaaaa");
  });
});
