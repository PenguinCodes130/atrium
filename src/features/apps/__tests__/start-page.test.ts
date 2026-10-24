// Wave 2.9 direct data: the start page's ops (A10.8, spec 3.7, criterion 10), the builder's pick and
// chart-line ops (spec 3.2, 3.4), and the guest values a published start page and a multi-line chart give
// (A10.2, criterion 13). Pure parts first; the guest part runs on a real temp SQLite through the resolver.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppDocument, CatalogueItem, ComponentNode, DataSourceDef } from "@/core/contracts";
import { blankDocument, findNode, newId } from "../doc";
import { applyOpsToDoc } from "../ops";
import { normaliseOps } from "../managed";
import { KIND_ORDER, startPageOps, startPageTarget, type StartPlan } from "../start-page";
import { addLineOps, axisGroups, barItemOps, bindItemOps, headlineTemplate, lineRead, setAtPath, thirdUnitRefusal, tileOps } from "@/features/builder/direct-data";
import { owner, seedIntegration, seedUsers, setupAppsDb } from "./harness";

vi.mock("@/features/apps/deps", async () => {
  const components = await import("@/features/components");
  return { ...(await import("./harness")).fakeDeps, resolveGuestValues: components.resolveGuestValues, sourcesUsed: components.sourcesUsed };
});

const info: StartPlan["info"] = (_i, endpointId) => ({ label: endpointId === "containers" ? "Containers" : endpointId, shape: endpointId === "containers" ? "table" : "stat", defaultRefreshSec: 30, minRefreshSec: 10 });
const plan = (over: Partial<StartPlan> = {}): StartPlan => ({
  services: [
    { integrationId: "i_media", name: "Jellyfin", packageId: "custom-api", kind: "media", headline: [], openUrl: "http://media.e2e.test:8096/" },
    { integrationId: "i_docker", name: "Docker", packageId: "docker", kind: "containers", headline: [
      { label: "Running", endpointId: "containers", value: 'rows | filter("state", "running") | count' },
      { label: "Stopped", endpointId: "containers", value: 'rows | filter("state", "exited") | count' },
      { label: "Total", endpointId: "containers", value: "rows | count" },
    ] },
    { integrationId: "i_prom", name: "Prometheus", packageId: "prometheus", kind: "monitoring", headline: [{ label: "Targets up", endpointId: "targets-up", value: "value" }] },
  ],
  links: [{ name: "Router", href: "http://router.e2e.test/" }],
  bar: { integrationId: "atrium", thingLabel: "this server", items: [
    { endpointId: "host", params: { measure: "cpu" }, label: "CPU", icon: "cpu", percent: true, readLabel: "CPU", defaultRefreshSec: 30, minRefreshSec: 10 },
    { endpointId: "host", params: { measure: "memory" }, label: "Memory", icon: "memory", percent: true, readLabel: "Memory", defaultRefreshSec: 30, minRefreshSec: 10 },
  ] },
  info,
  ...over,
});

describe("start page ops (A10.8)", () => {
  it("fills the empty home page: a resource bar on top, then groups by kind in the fixed order, then Links", () => {
    const d = blankDocument("Start");
    const r = startPageOps(d, plan());
    expect(r.pageId).toBe(d.pages[0]!.id);
    const applied = applyOpsToDoc(d, r.ops);
    if (!applied.ok) throw new Error(applied.problems[0]!.message);
    const kids = applied.doc.pages[0]!.root.children!;
    expect(kids.map((k) => k.type)).toEqual(["resource-bar", "group", "group", "group", "group"]);
    expect(kids.slice(1).map((k) => k.props.title)).toEqual(["Containers", "Media", "Monitoring", "Links"]);
    expect(KIND_ORDER.indexOf("containers")).toBeLessThan(KIND_ORDER.indexOf("media"));
    // Groups sit side by side across the 12 columns, under the bar.
    expect(kids.slice(1).map((k) => k.slot)).toEqual([0, 3, 6, 9].map((x) => ({ x, y: 8, w: 3, h: expect.any(Number) as unknown as number })));
    // A tile per service: icon, name, address, status from atrium/health, headline stats as managed sources.
    const docker = kids[1]!.children![0]!;
    expect(docker.type).toBe("service-tile");
    expect(docker.props).toMatchObject({ icon: "pkg:docker", name: "Docker", newTab: true, integrationId: "i_docker" });
    const stats = docker.props.stats as { label: string; value: { $bind: string } }[];
    expect(stats.map((s) => s.label)).toEqual(["Running", "Stopped", "Total"]);
    const statusName = (docker.props.status as { $bind: string }).$bind.replace(/[{} ]/g, "");
    const health = applied.doc.dataSources.find((s) => s.name === statusName)!;
    expect(health).toMatchObject({ integrationId: "atrium", endpointId: "health", params: { integrationId: "i_docker" }, managed: true });
    // Three stats of one read share one managed source (one fetch).
    const statSources = new Set(stats.map((s) => /\{\{ (d_[a-z2-7]{8})/.exec(s.value.$bind)![1]));
    expect(statSources.size).toBe(1);
    expect(stats[0]!.value.$bind).toMatch(/^\{\{ d_[a-z2-7]{8}\.rows \| filter\("state", "running"\) \| count \}\}$/);
    // The media tile opens its address; the link tile reads atrium/reach for its address.
    expect(kids[2]!.children![0]!.props.href).toBe("http://media.e2e.test:8096/");
    const link = kids[4]!.children![0]!;
    const reach = applied.doc.dataSources.find((s) => s.name === (link.props.status as { $bind: string }).$bind.replace(/[{} ]/g, ""))!;
    expect(reach).toMatchObject({ integrationId: "atrium", endpointId: "reach", params: { url: "http://router.e2e.test/" }, managed: true });
    // Every source is managed, bound, and unique per read; nothing for normalisation to remove.
    expect(applied.doc.dataSources.every((s) => s.managed)).toBe(true);
    expect(normaliseOps(applied.doc, () => ({ defaultRefreshSec: 30, minRefreshSec: 10 })).filter((o) => o.op === "source.remove")).toEqual([]);
    const keys = applied.doc.dataSources.map((s) => JSON.stringify([s.integrationId, s.endpointId, s.params]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("adds a Start page when no page is empty, with a free slug", () => {
    const d = blankDocument("Start");
    d.pages[0]!.root.children = [{ id: newId("c"), type: "heading", props: { text: "Hi" }, slot: { x: 0, y: 0, w: 3, h: 8 } }];
    d.pages.push({ ...d.pages[0]!, id: newId("p"), slug: "start", title: "Start", root: { ...d.pages[0]!.root, id: newId("c") } });
    d.app.pageOrder.push(d.pages[1]!.id);
    const t = startPageTarget(d);
    expect(t.add).toBe(true);
    expect(t.page.slug).toBe("start-2");
    const r = startPageOps(d, plan({ services: [], links: [{ name: "Router", href: "http://router.e2e.test/" }] }));
    expect(r.ops.filter((o) => o.op === "page.add").length).toBe(1);
    const applied = applyOpsToDoc(d, r.ops);
    expect(applied.ok).toBe(true);
  });

  it("reuses a managed source the app already has for the same read", () => {
    const d = blankDocument("Start");
    const first = applyOpsToDoc(d, startPageOps(d, plan()).ops);
    if (!first.ok) throw new Error("apply");
    const before = first.doc.dataSources.length;
    const tile = tileOps(first.doc, plan().services[1]!, info);
    expect(tile.ops).toEqual([]);
    expect(new Set(tile.sources).size).toBe(2);
    expect(first.doc.dataSources.length).toBe(before);
  });
});

const ITEM = (over: Partial<CatalogueItem> = {}): CatalogueItem => ({
  key: "i1|cpu|{}", integrationId: "i1", integrationName: "Prometheus", packageId: "prometheus", serviceIcon: "prometheus", endpointId: "machine-cpu", label: "CPU in use",
  thing: { param: "machine", value: "10.0.0.4:9100", label: "pve1" }, params: { machine: "10.0.0.4:9100" }, shape: "stat", format: "percent", measure: "cpu",
  history: { endpointId: "h:machine-cpu", params: { machine: "10.0.0.4:9100" } }, defaultRefreshSec: 30, minRefreshSec: 10, ...over,
});

function chartDoc(props: ComponentNode["props"] = {}, sources: DataSourceDef[] = []): { d: AppDocument; id: string } {
  const d = blankDocument("C");
  const id = newId("c");
  d.pages[0]!.root.children = [{ id, type: "chart", props, slot: { x: 0, y: 0, w: 6, h: 24 } }];
  d.dataSources = sources;
  return { d, id };
}

describe("picks and chart lines (spec 3.2, 3.4)", () => {
  it("a stat pick binds the managed source of the read and thing, labelled in words", () => {
    const d = blankDocument("S");
    const id = newId("c");
    d.pages[0]!.root.children = [{ id, type: "stat", props: { label: "" }, slot: { x: 0, y: 0, w: 3, h: 16 } }];
    const r = bindItemOps(d, id, "data", ITEM(), { title: true })!;
    const applied = applyOpsToDoc(d, r.ops);
    if (!applied.ok) throw new Error("apply");
    expect(applied.doc.dataSources).toEqual([{ name: r.name, integrationId: "i1", endpointId: "machine-cpu", params: { machine: "10.0.0.4:9100" }, refreshSec: 30, label: "CPU in use, pve1", managed: true }]);
    expect(findNode(applied.doc, id)!.node).toMatchObject({ props: { data: { $bind: `{{ ${r.name} }}` } }, title: "CPU in use, pve1" });
  });
  it("a chart line binds a value read's history; a chart with one source keeps it as its first line", () => {
    const { d, id } = chartDoc({ data: { $bind: "{{ load }}" } }, [{ name: "load", integrationId: "i1", endpointId: "load", refreshSec: 30 }]);
    expect(lineRead(ITEM())!.endpointId).toBe("h:machine-cpu");
    expect(lineRead(ITEM({ history: undefined }))).toBeNull();
    const r = addLineOps(d, id, ITEM())!;
    const applied = applyOpsToDoc(d, r.ops);
    if (!applied.ok) throw new Error("apply");
    const node = findNode(applied.doc, id)!.node;
    expect(node.props.data).toBeUndefined();
    expect(node.props.lines).toEqual([{ data: { $bind: "{{ load }}" } }, { data: { $bind: `{{ ${r.name} }}` }, label: "CPU in use, pve1" }]);
    expect(applied.doc.dataSources.find((s) => s.name === r.name)).toMatchObject({ endpointId: "h:machine-cpu", params: { machine: "10.0.0.4:9100" }, managed: true });
  });
  it("lines group by format and unit; a third unit is refused in one sentence", () => {
    expect(axisGroups([{ format: "percent" }, { format: "percent" }, { format: "bytesPerSec" }]).length).toBe(2);
    expect(thirdUnitRefusal([{ format: "percent" }], { format: "celsius" }, "Temperature, pve1")).toBeNull();
    expect(thirdUnitRefusal([{ format: "percent" }, { format: "bytesPerSec" }], { format: "celsius" }, "Temperature, pve1")).toBe("This chart already shows percent and bytes per second, so Temperature, pve1 (temperature) would need a third axis.");
    expect(thirdUnitRefusal([{ format: "percent" }, { format: "bytesPerSec" }], { format: "percent" }, "Memory")).toBeNull();
  });
  it("paths into list props and headline templates", () => {
    expect(setAtPath({ stats: [{ label: "A", value: 1 }, { label: "B", value: 2 }] }, "stats.1.value", { $bind: "{{ x.value }}" })).toEqual({ stats: [{ label: "A", value: 1 }, { label: "B", value: { $bind: "{{ x.value }}" } }] });
    expect(headlineTemplate("d_abcdefgh", "value")).toBe("{{ d_abcdefgh.value }}");
    expect(headlineTemplate("d_abcdefgh", "rows | count")).toBe("{{ d_abcdefgh.rows | count }}");
    expect(headlineTemplate("d_abcdefgh", "")).toBe("{{ d_abcdefgh }}");
  });
});

describe("resource bar readings (spec 3.6)", () => {
  const eps = [
    { id: "machine-cpu", label: "CPU in use", shape: "stat", defaultRefreshSec: 30, minRefreshSec: 10, params: {} },
    { id: "machine-memory", label: "Memory in use", shape: "stat", defaultRefreshSec: 30, minRefreshSec: 10, params: {} },
    { id: "h:machine-cpu", label: "CPU in use over time", shape: "series", defaultRefreshSec: 60, minRefreshSec: 30, params: {} },
    { id: "machine-uptime", label: "Uptime", shape: "stat", defaultRefreshSec: 30, minRefreshSec: 10, params: {} },
  ];
  const measure = (e: { label: string }) => (/cpu/i.test(e.label) ? "cpu" : /memory/i.test(e.label) ? "memory" : /uptime/i.test(e.label) ? "uptime" : "other");
  it("fills CPU, memory and uptime of a machine from its first plain read of each measure, with bars for percents", () => {
    const r = barItemOps({ dataSources: [] }, "i_prom", eps, { thing: "10.0.0.4:9100", label: "pve1" }, measure, () => "machine");
    expect((r.items as { label: string }[]).map((i) => i.label)).toEqual(["CPU", "Memory", "Up"]);
    expect(r.ops.map((o) => (o.op === "source.set" ? [o.source.endpointId, o.source.params, o.source.label] : null))).toEqual([
      ["machine-cpu", { machine: "10.0.0.4:9100" }, "CPU in use, pve1"], ["machine-memory", { machine: "10.0.0.4:9100" }, "Memory in use, pve1"], ["machine-uptime", { machine: "10.0.0.4:9100" }, "Uptime, pve1"],
    ]);
    expect((r.items[0] as { percent?: unknown }).percent).toBeTruthy();
    expect((r.items[2] as { percent?: unknown }).percent).toBeUndefined();
  });
  it("uses the Atrium host's own reads with no machine", () => {
    const r = barItemOps({ dataSources: [] }, "atrium", [{ id: "host", label: "This server", shape: "stat", defaultRefreshSec: 30, minRefreshSec: 10 }], null, measure, () => null);
    expect(r.ops.map((o) => (o.op === "source.set" ? o.source.params : null))).toEqual([{ measure: "cpu" }, { measure: "memory" }, { measure: "disk" }, { measure: "uptime" }]);
  });
});

describe("guest values of a published start page and chart (A10.2, criterion 13)", () => {
  let svc: typeof import("../service");
  let versions: typeof import("@/features/versions/service");
  let resolver: typeof import("../resolver");
  let repo: typeof import("../repo");
  let haId = "";
  beforeAll(async () => {
    setupAppsDb();
    await seedUsers();
    haId = await seedIntegration(owner);
    svc = await import("../service");
    versions = await import("@/features/versions/service");
    resolver = await import("../resolver");
    repo = await import("../repo");
  });

  it("each chart line under <nodeId>:lines.<i>.data and each tile stat as a resolved value, never a whole table", async () => {
    const { app } = svc.createApp(owner, { name: "Guest start", slug: "guest-start" });
    const d = repo.getDraft(app.id)!;
    const root = d.doc.pages[0]!.root.id;
    const src = (name: string, endpointId: string): DataSourceDef => ({ name, integrationId: haId, endpointId, refreshSec: 30, managed: true });
    svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [
      { op: "source.set", source: src("d_aaaaaaaa", "history") },
      { op: "source.set", source: src("d_bbbbbbbb", "states") },
      { op: "node.add", parentId: root, node: { id: "c_guestchart", type: "chart", props: { lines: [{ data: { $bind: "{{ d_aaaaaaaa }}" }, label: "Lamp" }, { data: { $bind: "{{ d_aaaaaaaa }}" }, label: "Again", hidden: true }] }, slot: { x: 0, y: 0, w: 6, h: 24 } } },
      { op: "node.add", parentId: root, node: { id: "c_guesttilea", type: "service-tile", props: { icon: "server", name: "Lights", newTab: true, stats: [{ label: "On", value: { $bind: '{{ d_bbbbbbbb.rows | filter("state", "on") | count }}' } }] }, slot: { x: 6, y: 0, w: 3, h: 16 } } },
    ] });
    svc.updateAccess(owner, app.id, { view: "everyone", edit: "owner", guests: true });
    const d2 = repo.getDraft(app.id)!;
    await versions.publishDraft(owner, app.id, { expectRev: d2.rev, note: "start" });
    const series = { kind: "series" as const, series: [{ name: "lamp", points: [[1, 2]] as [number, number][] }] };
    const rows = Array.from({ length: 30 }, (_, i) => ({ entity_id: `light.secret_${i}`, state: i < 4 ? "on" : "off" }));
    const values = await resolver.accessResolver.guestValues(app.id, d2.doc.pages[0]!.id, { d_aaaaaaaa: series, d_bbbbbbbb: { kind: "table", columns: [], rows } });
    expect(values["c_guestchart:lines.0.data"]).toEqual(series);
    expect(values["c_guestchart:lines.1.data"]).toEqual(series);
    const stats = values["c_guesttilea:stats"] as { label: string; value: unknown }[];
    expect(stats).toEqual([{ label: "On", value: 4 }]);
    expect(JSON.stringify(values)).not.toContain("light.secret_");
  });
});

describe("agent tools apps.startPage and apps.bindData (A10.8, criterion 14)", () => {
  let tools: typeof import("../tools");
  let repo: typeof import("../repo");
  let svc: typeof import("../service");
  let haId = "";
  const { agentFor } = { agentFor: undefined as unknown as typeof import("./harness").agentFor };
  beforeAll(async () => {
    tools = await import("../tools");
    repo = await import("../repo");
    svc = await import("../service");
    haId = (await import("@/features/integrations/repo")).listIntegrationRows().find((r) => r.packageId === "home-assistant")?.id ?? (await seedIntegration(owner, "Home 2"));
  });
  const tool = (name: string) => tools.appTools.find((t) => t.name === name)! as unknown as { handler(ctx: { principal: unknown; signal: AbortSignal }, input: unknown): Promise<Record<string, unknown>>; scope: string };
  it("an agent with edit scope makes a start page and binds a read; without edit scope it is refused; answers carry no config", async () => {
    const h = await import("./harness");
    const { app } = svc.createApp(owner, { name: "Agent start", slug: "agent-start" });
    const edit = h.agentFor(owner, ["atrium:read", "atrium:edit"]);
    const readOnly = h.agentFor(owner, ["atrium:read"]);
    const signal = new AbortController().signal;
    expect(tool("apps.startPage").scope).toBe("atrium:edit");
    expect(tool("apps.bindData").scope).toBe("atrium:edit");
    await expect(tool("apps.startPage").handler({ principal: readOnly, signal }, { appId: app.id, integrationIds: [haId], links: [] })).rejects.toThrow();
    const made = await tool("apps.startPage").handler({ principal: edit, signal }, { appId: app.id, integrationIds: [haId], links: [{ name: "Router", href: "http://router.e2e.test/" }] });
    expect(made).toMatchObject({ rev: 2, pageId: expect.any(String) });
    const d = repo.getDraft(app.id)!;
    const kids = d.doc.pages[0]!.root.children!;
    expect(kids.map((k) => k.type)).toEqual(["resource-bar", "group", "group"]);
    expect(kids[1]!.props.title).toBe("Smart home");
    expect((kids[1]!.children![0]!.props.stats as { label: string }[]).map((s) => s.label)).toEqual(["Entities", "Unavailable"]);
    expect(repo.pendingChanges(app.id).at(-1)!.summary).toBe("Start page");
    // A chart line through apps.bindData: a series read binds as a line on a new chart.
    const root = d.doc.pages[0]!.root.id;
    svc.applyDraftOps({ appId: app.id, by: owner, expectRev: d.rev, ops: [{ op: "node.add", parentId: root, node: { id: "c_agentchart", type: "chart", props: {}, slot: { x: 0, y: 80, w: 6, h: 24 } } }, { op: "node.add", parentId: root, node: { id: "c_agenttable", type: "table", props: {}, slot: { x: 6, y: 80, w: 6, h: 24 } } }] });
    await expect(tool("apps.bindData").handler({ principal: readOnly, signal }, { appId: app.id, nodeId: "c_agenttable", prop: "data", itemKey: `${haId}|states|{}` })).rejects.toThrow();
    const bound = await tool("apps.bindData").handler({ principal: edit, signal }, { appId: app.id, nodeId: "c_agenttable", prop: "data", itemKey: `${haId}|states|{}`, refreshSec: 20 });
    expect(bound).toMatchObject({ source: expect.stringMatching(/^d_[a-z2-7]{8}$/), template: expect.stringMatching(/^\{\{ d_[a-z2-7]{8} \}\}$/) });
    const line = await tool("apps.bindData").handler({ principal: edit, signal }, { appId: app.id, nodeId: "c_agentchart", prop: "lines", itemKey: `${haId}|history|${JSON.stringify({ entityId: "sensor.e2e" })}` });
    const after = repo.getDraft(app.id)!;
    const chart = after.doc.pages[0]!.root.children!.find((n) => n.id === "c_agentchart")!;
    expect((chart.props.lines as { data: { $bind: string } }[])[0]!.data.$bind).toBe(line.template);
    const table = after.doc.pages[0]!.root.children!.find((n) => n.id === "c_agenttable")!;
    expect(table.refreshSec).toBe(20);
    // The table shares the tile's "Entities" read (states): the fetch runs at the faster of 20 s and the tile's default 10 s.
    expect(after.doc.dataSources.find((s) => s.name === bound.source)).toMatchObject({ managed: true, refreshSec: 10 });
    expect(after.doc.dataSources.filter((s) => s.endpointId === "states")).toHaveLength(1);
    // Nothing answered carries the integration's config (its address) or a secret field name.
    const said = JSON.stringify([made, bound, line]);
    expect(said).not.toContain("127.0.0.1:9");
    expect(said).not.toMatch(/token|secret|password/i);
    void agentFor;
  });
});
