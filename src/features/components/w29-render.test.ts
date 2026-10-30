// Wave 2.9 server-rendered checks (react-dom/server): the service tile in its states (fresh, loading,
// stale, failed, down, a link tile with a response time), the group's columns and phone column, the
// resource bar with the clock and search, bookmarks, the chart with lines on two axes and the cap, a
// guest's chart lines from "<nodeId>:lines.<i>.data", and the inspector's list editors.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppDocument, ComponentNode, RenderContext, ShapedData } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));

const { RenderNode } = await import("./render/render-node");
const { RenderDeviceProvider } = await import("./render/context");
const { InspectorPanels } = await import("./inspector/inspector");
const { resolveGuestValues } = await import("./page");

type Src = Record<string, { state: "fresh" | "stale" | "failed" | "empty"; data?: ShapedData; refreshSec: number; fetchedAt?: string; error?: { code: string; message: string } }>;
function ctx(mode: RenderContext["mode"], sources: Src = {}, extra: Record<string, unknown> = {}): RenderContext {
  const $data: Record<string, ShapedData | undefined> = {};
  for (const [k, v] of Object.entries(sources)) $data[k] = v.data;
  return {
    mode, principal: { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_aaaaaaaaaa", version: "draft",
    values: { $data, $sources: sources, $page: { id: "p_aaaaaaaaaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: "user" }, ...extra } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const render = (node: ComponentNode, c: RenderContext, device: "desktop" | "mobile" = "desktop") => renderToStaticMarkup(h(RenderDeviceProvider, { device, children: h(RenderNode, { node, ctx: c }) }));
const b = (t: string) => ({ $bind: t });
const fresh = (data: ShapedData, extra: Partial<Src[string]> = {}): Src[string] => ({ state: "fresh", data, refreshSec: 30, ...extra });
const status = (state: "up" | "down", detail: string): ShapedData => ({ kind: "status", items: [{ label: "x", state, detail }] });
const T0 = Date.UTC(2026, 9, 23, 10);
const ser = (name: string, vals: number[], format: string): ShapedData => ({ kind: "series", format, series: [{ name, display: `CPU ${name}`, points: vals.map((v, i) => [T0 + i * 60_000, v]) }] }) as ShapedData;

const tile = (props: ComponentNode["props"]): ComponentNode => ({ id: "c_tileaaaaaa", type: "service-tile", props: { icon: "docker", name: "Portainer", description: "Docker management", newTab: true, ...props } });

describe("service tile", () => {
  const stats = [{ label: "Running", value: b("{{ c.value }}") }, { label: "Mem", value: 479 * 1024 ** 2, format: "bytes" }] as ComponentNode["props"][string];
  it("draws icon, name, description, the badge in words and the stats; the whole tile is the link, in a new tab with noopener", () => {
    const m = render(tile({ href: "https://portainer.example.test", status: b("{{ h }}"), stats, integrationId: "i_hiddenref" }), ctx("view", { h: fresh(status("up", "running")), c: fresh({ kind: "stat", value: 42, label: "x" }) }));
    expect(m).toContain('data-icon="docker"');
    expect(m).toContain("Portainer");
    expect(m).toContain("Docker management");
    expect(m).toMatch(/data-slot="badge"[^>]*data-tone="ok"/);
    expect(m).toContain(">Running<");
    expect(m).toContain(">42<");
    expect(m).toContain("479");
    expect(m).toContain("MB");
    expect(m).toMatch(/<a [^>]*href="https:\/\/portainer.example.test"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(m).not.toContain("i_hiddenref");
  });
  it("newTab off keeps the same tab; an unsafe address is not a link", () => {
    expect(render(tile({ href: "https://a.test", newTab: false }), ctx("view"))).not.toContain('target="_blank"');
    const bad = render(tile({ href: "javascript:alert(1)" }), ctx("view"));
    expect(bad).not.toContain("<a ");
    expect(bad).not.toContain("javascript:");
  });
  it("down: the badge says Down (or Stopped) and the last stats stay, faded", () => {
    const m = render(tile({ status: b("{{ h }}"), stats }), ctx("view", { h: fresh(status("down", "stopped")), c: fresh({ kind: "stat", value: 41, label: "x" }) }));
    expect(m).toMatch(/data-badge-state="down"/);
    expect(m).toContain(">Stopped<");
    expect(m).toMatch(/class="atr-tile-stats"[^>]*data-down=""/);
    expect(m).toContain(">41<");
  });
  it("a link tile shows the response time; loading shows quiet placeholders; stale and failed show their marks", () => {
    expect(render(tile({ status: b("{{ r }}") }), ctx("view", { r: fresh(status("up", "12 ms")) }))).toContain(">12 ms<");
    const loading = render(tile({ status: b("{{ h }}"), stats }), ctx("view", {}));
    expect(loading).toContain('data-badge-state="loading"');
    expect(loading).toContain("atr-placeholder");
    const stale = render(tile({ status: b("{{ h }}") }), ctx("view", { h: { state: "stale", data: status("up", "running"), refreshSec: 30 } }));
    expect(stale).toContain('data-state-mark="stale"');
    const failed = render(tile({ status: b("{{ h }}") }), ctx("view", { h: { state: "failed", data: status("up", "running"), refreshSec: 30, error: { code: "timeout", message: "Timed out reaching it" } } }));
    expect(failed).toContain('data-state-mark="failed"');
    expect(failed).toContain("Timed out reaching it");
    // Empty: no status read, no badge.
    expect(render(tile({}), ctx("view"))).not.toContain('data-slot="badge"');
  });
  it("an uploaded icon is a picture; an unknown name falls back to a plain glyph", () => {
    expect(render(tile({ icon: "/uploads/logo.png" }), ctx("view"))).toContain('src="/uploads/logo.png"');
    expect(render(tile({ icon: "nosuch" }), ctx("view"))).toContain('data-icon="unknown"');
  });
});

describe("group", () => {
  const group: ComponentNode = { id: "c_groupaaaaa", type: "group", props: { title: "Media", columns: 3, collapsible: true }, children: [tile({ name: "A" }), { ...tile({ name: "B" }), id: "c_tilebbbbbb" }] };
  it("flows children into equal columns in order, one column on phones, with a fold button", () => {
    const d = render(group, ctx("view"));
    expect(d).toContain(">Media<");
    expect(d).toContain("repeat(3, minmax(0, 1fr))");
    expect(d.indexOf('data-group-item="c_tileaaaaaa"')).toBeLessThan(d.indexOf('data-group-item="c_tilebbbbbb"'));
    expect(d).toMatch(/data-group-fold[^>]*|aria-expanded="true"/);
    expect(render(group, ctx("view"), "mobile")).toContain("repeat(1, minmax(0, 1fr))");
  });
  it("an empty group asks for tiles in the builder only", () => {
    const empty: ComponentNode = { id: "c_groupaaaaa", type: "group", props: { title: "X" }, children: [] };
    expect(render(empty, ctx("edit"))).toContain("Drag tiles here");
    expect(render(empty, ctx("view"))).not.toContain("Drag tiles here");
  });
});

describe("resource bar and bookmarks", () => {
  it("draws items with formatted values and a bar from percent, a clock and an https search box", () => {
    const n: ComponentNode = { id: "c_rbaraaaaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: b("{{ cpu }}"), percent: b("{{ cpu.value }}") }, { icon: "disk", label: "Free", value: 1.22 * 1024 ** 4, format: "bytes" }], clock: true, search: true, searchUrl: "https://duckduckgo.com/?q={q}" } };
    const m = render(n, ctx("view", { cpu: fresh({ kind: "stat", value: 32.4, format: "percent", label: "x" }) }));
    expect(m).toContain("32.4%");
    expect(m).toContain("1.2 TB");
    expect(m).toContain('aria-valuenow="32"');
    expect(m).toContain("data-bar-clock");
    expect(m).toContain('role="search"');
  });
  it("a new bar shows sample readings only while editing", () => {
    const n: ComponentNode = { id: "c_rbaraaaaaa", type: "resource-bar", props: { items: [], clock: false, search: false } };
    expect(render(n, ctx("edit"))).toContain("Sample readings");
    expect(render(n, ctx("view"))).not.toContain("Sample readings");
  });
  it("bookmarks: two letters or an icon, the name, the domain, http and https only", () => {
    const n: ComponentNode = { id: "c_bookmarksa", type: "bookmarks", props: { items: [{ name: "You Tube", href: "https://www.youtube.com/" }, { name: "Mail", href: "https://mail.example.test", icon: "mail" }, { name: "Bad", href: "javascript:alert(1)" }], columns: 2 } };
    const m = render(n, ctx("view"));
    expect(m).toContain(">YT<");
    expect(m).toContain("youtube.com");
    expect(m).toContain('data-icon="mail"');
    expect(m).not.toContain("javascript:");
    expect(m).toContain("data-inert-link");
    expect(m).toContain("repeat(2, minmax(0, 1fr))");
    expect(render(n, ctx("view"), "mobile")).toContain("repeat(1, minmax(0, 1fr))");
  });
});

describe("chart lines", () => {
  const chart: ComponentNode = { id: "c_chartaaaaa", type: "chart", props: { kind: "line", lines: [{ data: b("{{ a }}") }, { data: b("{{ c }}"), label: "Second" }, { data: b("{{ n }}") }, { data: b("{{ t }}") }] } };
  const src: Src = { a: fresh(ser("pve1", [1, 2, 3], "percent")), c: fresh(ser("pve2", [4, 5, 6], "percent")), n: fresh(ser("pve1", [1000, 2000, 3000], "bytesPerSec")), t: fresh(ser("pve1", [40, 41, 42], "celsius")) };
  it("draws named lines on two axes and refuses the third unit in one sentence", () => {
    const m = render(chart, ctx("view", src));
    expect(m).toContain('data-axes="2"');
    expect(m).toContain('data-series-label="CPU pve1"');
    expect(m).toContain('data-series-label="Second"');
    expect(m.match(/data-axis-right/g)?.length).toBe(3);
    expect(m).toContain('data-third-unit="3"');
    expect(m).toContain("A chart shows at most two units");
    expect(m).toContain("3 series");
  });
  it("an existing single-source chart is unchanged", () => {
    const m = render({ id: "c_oldchartaa", type: "chart", props: { data: b("{{ a }}") } }, ctx("view", src));
    expect(m).not.toContain("data-lines-chart");
    expect(m).toContain('data-series="pve1"');
  });
  it("loading lines show the loading state; a guest reads <nodeId>:lines.<i>.data", () => {
    expect(render(chart, ctx("view", {}))).toContain('aria-label="Loading"');
    const docu: AppDocument = { format: "atrium-app", formatVersion: 1, app: { name: "G", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, dataSources: ["a", "c", "n", "t"].map((name) => ({ name, integrationId: "i", endpointId: name, refreshSec: 30 })), controls: [], pages: [{ id: "p_aaaaaaaaaa", slug: "h", title: "H", inNav: true, root: { id: "c_rootaaaaaa", type: "stack", props: {}, children: [chart] } }] };
    const guest = resolveGuestValues(docu, "p_aaaaaaaaaa", Object.fromEntries(Object.entries(src).map(([k, v]) => [k, v.data!])));
    const g = render(chart, { ...ctx("view"), principal: { kind: "guest", guestLinkId: "g", appId: "a", label: "x", via: "guest-link" }, values: { $data: {}, $guest: guest, $page: { id: "p", slug: "p", title: "p" }, $app: { id: "a", slug: "a", name: "a" }, $user: { kind: "guest" } } as never });
    expect(g).toContain('data-series-label="Second"');
    expect(g).toContain('data-axes="2"');
  });
});

describe("inspector list editors", () => {
  const docu = (n: ComponentNode): AppDocument => ({ format: "atrium-app", formatVersion: 1, app: { name: "G", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, dataSources: [{ name: "a", integrationId: "i", endpointId: "a", refreshSec: 30 }], controls: [], pages: [{ id: "p_aaaaaaaaaa", slug: "h", title: "H", inNav: true, root: { id: "c_rootaaaaaa", type: "grid", props: {}, children: [n] } }] });
  const panel = (n: ComponentNode, pick = true) => renderToStaticMarkup(h(InspectorPanels, { node: n, doc: docu(n), onChange: () => {}, ctx: ctx("edit"), ...(pick ? { onConnectData: () => {} } : {}) }));
  it("a tile has Numbers with Pick data per entry and the icon picker; integrationId is never a field", () => {
    const m = panel(tile({ stats: [{ label: "Running", value: 3 }], integrationId: "i_x" }));
    expect(m).toContain("data-stats-editor");
    expect(m).toContain('data-pick-button="stats.0.value"');
    // Wave 2.10b F6: the icon field is the visual grid picker's button (it was a menu of names).
    expect(m).toContain('data-icon-pick="icon"');
    expect(m).toContain("data-connect-data");
    expect(m).not.toContain('data-field="integrationId"');
    expect(m).toContain("Add a number");
  });
  it("a chart with lines lists them with colour, Hide and Add a line; its single Series field is gone", () => {
    const m = panel({ id: "c_chartaaaaa", type: "chart", props: { lines: [{ data: b("{{ a }}"), label: "One", color: "series2" }] } });
    expect(m).toContain('data-lines-row="0"');
    expect(m).toContain('data-lines-color="lines.0.color"');
    expect(m).toContain('data-lines-hide="0"');
    expect(m).toContain("data-lines-add");
    expect(m).not.toContain('data-field="data"');
  });
  it("the resource bar and bookmarks have their own editors", () => {
    expect(panel({ id: "c_rbaraaaaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: 1 }] } })).toContain('data-pick-button="items.0.percent"');
    const bm = panel({ id: "c_bookmarksa", type: "bookmarks", props: { items: [{ name: "x", href: "ftp://x" }] } });
    expect(bm).toContain("data-bookmarks-editor");
    expect(bm).toContain('data-bookmark-refused="0"');
  });
});
