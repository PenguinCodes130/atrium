// Wave 2.9 (architecture Amendment 10: A10.2 chart lines, A10.7 new components; direct data spec 3.4 to
// 3.6): schemas and refusals, validate rules, the axis grouping, the 20-series cap and naming, nested
// bindings in lines, stats and items (evaluation, sources used, guest keys), badges, and prop paths.
import { describe, expect, it } from "vitest";
import type { AppDocument, ComponentNode, ShapedData } from "@/core/contracts";
import { propsSchemas } from "./catalogue/schemas";
import { META } from "./catalogue/meta";
import { validateNodes } from "./validate";
import { resolveGuestValues, sourcesUsed } from "./page";
import { nodeSources, nodeStatus, resolveProps, type PageScope } from "./render/resolve";
import { lineSeriesName, planLines, thirdUnitSentence, linesCountText } from "./render/lines";
import { domainOf, iconRefKind, initials, percentOf, searchHref, statText, statusBadge } from "./render/tiles-logic";
import { getPropPath, setPropPath } from "./props-path";
import { insertCatalogue, newNode } from "./insert";
import { notConnected } from "./catalogue/samples";
import { suggestedType } from "./suggest";

const b = (t: string) => ({ $bind: t });
const T0 = Date.UTC(2026, 9, 23, 10);
const ser = (name: string, vals: number[], extra: Partial<{ format: string; unit: string; display: string }> = {}): ShapedData =>
  ({ kind: "series", ...(extra.format ? { format: extra.format } : {}), ...(extra.unit ? { unit: extra.unit } : {}), series: [{ name, ...(extra.display ? { display: extra.display } : {}), points: vals.map((v, i) => [T0 + i * 60_000, v]) }] }) as ShapedData;
const many = (n: number, format = "percent"): ShapedData => ({ kind: "series", format, series: Array.from({ length: n }, (_, i) => ({ name: `n${i}`, display: `node ${i}`, points: [[T0, i], [T0 + 60_000, i * 2]] })) }) as ShapedData;

function doc(children: ComponentNode[], sources: string[]): AppDocument {
  return {
    format: "atrium-app", formatVersion: 1, app: { name: "W29", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" },
    dataSources: sources.map((name) => ({ name, integrationId: "i1", endpointId: name, refreshSec: 30, managed: true })), controls: [],
    pages: [{ id: "p_aaaaaaaaaa", slug: "home", title: "Home", inNav: true, root: { id: "c_rootaaaaaa", type: "grid", props: {}, children } }],
  };
}
const scope = (data: Record<string, ShapedData | undefined>, states: PageScope["$sources"] = {}): PageScope => ({ $data: data, $sources: states, $page: { id: "p", slug: "p", title: "p" }, $app: { id: "a", slug: "a", name: "a" }, $user: { kind: "user" } }) as PageScope;

describe("A10.7 schemas", () => {
  it("accept the amendment's shapes and the defaults", () => {
    for (const t of ["service-tile", "group", "resource-bar", "bookmarks"] as const) expect(propsSchemas[t].safeParse(META[t].defaults).success, t).toBe(true);
    expect(propsSchemas["service-tile"].safeParse({ icon: "pkg:docker", name: "Portainer", description: "x", href: "https://p.example.test", newTab: true, status: b("{{ d_aaaaaaaa }}"), stats: [{ label: "Running", value: b("{{ d_aaaaaaaa.value }}"), format: "number" }, { label: "Total", value: 45 }], integrationId: "i_xyz" }).success).toBe(true);
    expect(propsSchemas["resource-bar"].safeParse({ items: [{ icon: "cpu", label: "CPU", value: b("{{ x }}"), percent: b("{{ x.value }}"), format: "percent" }], clock: true, clockFormat: "time-12h", search: true, searchUrl: "https://example.test/search?q={q}" }).success).toBe(true);
    expect(propsSchemas.bookmarks.safeParse({ items: [{ name: "a", href: "https://a.test", icon: "/uploads/a.png" }], columns: 6 }).success).toBe(true);
    expect(propsSchemas.chart.safeParse({ lines: [{ data: b("{{ a }}"), label: "A", color: "series3", hidden: false }, { data: b("{{ b }}"), color: "#2f6fb0" }] }).success).toBe(true);
  });
  it("refuse what the amendment caps", () => {
    const stat = { label: "x", value: 1 };
    expect(propsSchemas["service-tile"].safeParse({ stats: [stat, stat, stat, stat, stat] }).success).toBe(false);
    expect(propsSchemas["resource-bar"].safeParse({ items: Array.from({ length: 9 }, () => ({ icon: "cpu", label: "x", value: 1 })) }).success).toBe(false);
    expect(propsSchemas.bookmarks.safeParse({ items: Array.from({ length: 51 }, () => ({ name: "x", href: "https://x.test" })) }).success).toBe(false);
    expect(propsSchemas.group.safeParse({ columns: 7 }).success).toBe(false);
    expect(propsSchemas.group.safeParse({ columns: 0 }).success).toBe(false);
    expect(propsSchemas.chart.safeParse({ lines: Array.from({ length: 13 }, () => ({ data: b("{{ a }}") })) }).success).toBe(false);
    expect(propsSchemas.chart.safeParse({ lines: [{ data: b("{{ a }}"), color: "red" }] }).success).toBe(false);
    expect(propsSchemas.chart.safeParse({ lines: [{ data: "{{ a }}" }] }).success).toBe(false);
    // The search address is https only, with {q}.
    expect(propsSchemas["resource-bar"].safeParse({ searchUrl: "http://example.test/?q={q}" }).success).toBe(false);
    expect(propsSchemas["resource-bar"].safeParse({ searchUrl: "https://example.test/" }).success).toBe(false);
    expect(propsSchemas["resource-bar"].safeParse({ searchUrl: "javascript:alert(1)//{q}" }).success).toBe(false);
    expect(propsSchemas["service-tile"].safeParse({ icon: "javascript:x" }).success).toBe(false);
  });
  it("every prop is described for agents and the JSON Schema carries it", () => {
    for (const t of ["service-tile", "group", "resource-bar", "bookmarks"] as const) {
      const shape = (propsSchemas[t] as unknown as { shape: Record<string, { description?: string }> }).shape;
      for (const [k, s] of Object.entries(shape)) expect(s.description, `${t}.${k}`).toBeTruthy();
    }
  });
  it("accepts and the insert catalogue: tiles and resource bar take stat and status; group and tile come first", () => {
    expect(META["service-tile"].accepts).toEqual(["stat", "status"]);
    expect(META["resource-bar"].accepts).toEqual(["stat", "status"]);
    expect(META.group.container).toBe(true);
    const groups = insertCatalogue({ kind: "user", userId: "u", role: "member", via: "session" });
    const data = groups.find((g) => g.category === "data")!.items.map((i) => i.type);
    expect(data.slice(0, 2)).toEqual(["service-tile", "resource-bar"]);
    const layout = groups.find((g) => g.category === "layout")!.items.map((i) => i.insertId ?? i.type);
    expect(layout.slice(0, 3)).toEqual(["card-for-each", "grid", "group"]);
    expect(groups.find((g) => g.category === "content")!.items.map((i) => i.type)).toContain("bookmarks");
    expect(newNode("group").children).toEqual([]);
    expect(newNode("service-tile").slot).toMatchObject({ w: 3, h: 17 });
    // Shape suggestions are unchanged by the new types.
    expect(suggestedType("status")).toBe("status");
    expect(suggestedType("series")).toBe("chart");
  });
});

describe("validate (A10.2, A10.7)", () => {
  it("refuses unsafe addresses and names unknown icons", () => {
    const d = doc([
      { id: "c_tilebadaaa", type: "service-tile", props: { name: "x", href: "javascript:alert(1)", icon: "nosuchicon" } },
      { id: "c_bookmarksa", type: "bookmarks", props: { items: [{ name: "ok", href: "https://a.test" }, { name: "bad", href: "file:///etc/passwd" }] } },
      { id: "c_rbaraaaaaa", type: "resource-bar", props: { items: [{ icon: "nope", label: "x", value: 1 }] } },
    ], []);
    const p = validateNodes(d);
    expect(p.find((x) => x.code === "tile.scheme")?.where).toMatchObject({ nodeId: "c_tilebadaaa", field: "href" });
    expect(p.find((x) => x.code === "bookmark.scheme")?.where).toMatchObject({ nodeId: "c_bookmarksa", field: "items[1].href" });
    expect(p.filter((x) => x.code === "icon.unknown").map((x) => x.where.field).sort()).toEqual(["icon", "items[0].icon"]);
    // Warnings, not errors: the address is drawn inert, and a half-typed one is never refused.
    expect(p.filter((x) => x.code === "bookmark.scheme" || x.code === "tile.scheme").every((x) => x.severity === "warning")).toBe(true);
    expect(validateNodes(doc([{ id: "c_bookmarksa", type: "bookmarks", props: { items: [{ name: "new", href: "" }] } }], [])).some((x) => x.code === "bookmark.scheme")).toBe(false);
  });
  it("checks nested bindings: an unknown source inside a stat or a line names its path", () => {
    const d = doc([
      { id: "c_tileaaaaaa", type: "service-tile", props: { name: "x", stats: [{ label: "a", value: b("{{ known.value }}") }, { label: "b", value: b("{{ ghost.value }}") }] } },
      { id: "c_chartaaaaa", type: "chart", props: { lines: [{ data: b("{{ known }}") }, { data: b("{{ ghost2 }}") }] } },
    ], ["known"]);
    const p = validateNodes(d).filter((x) => x.code === "binding.unknown_source");
    expect(p.map((x) => x.where.field).sort()).toEqual(["lines[1].data", "stats[1].value"]);
  });
  it("refuses a third unit on a chart, with the sentence and the percent offer only when it applies", () => {
    const d = doc([{ id: "c_chartaaaaa", type: "chart", props: { lines: [{ data: b("{{ cpu }}") }, { data: b("{{ net }}") }, { data: b("{{ temp }}") }] } }], ["cpu", "net", "temp"]);
    const data = { cpu: ser("pve1", [1, 2], { format: "percent" }), net: ser("pve1", [1, 2], { format: "bytesPerSec" }), temp: ser("pve1", [40, 41], { format: "celsius" }) };
    const p = validateNodes(d, { data });
    const third = p.find((x) => x.code === "chart.third_unit")!;
    expect(third.severity).toBe("error");
    expect(third.where.field).toBe("lines[2]");
    expect(third.message).toBe(thirdUnitSentence(false));
    expect(third.message).toContain("Put it on a new chart".toLowerCase());
    expect(third.message).not.toContain("percent");
    // Two units are fine.
    const two = doc([{ id: "c_chartaaaaa", type: "chart", props: { lines: [{ data: b("{{ cpu }}") }, { data: b("{{ net }}") }] } }], ["cpu", "net"]);
    expect(validateNodes(two, { data }).some((x) => x.code === "chart.third_unit")).toBe(false);
    expect(thirdUnitSentence(true)).toContain("or show all as percent");
  });
  it("warns when a chart has both lines and the single series, and when a line is not a series", () => {
    const d = doc([{ id: "c_chartaaaaa", type: "chart", props: { data: b("{{ cpu }}"), lines: [{ data: b("{{ stat }}") }] } }], ["cpu", "stat"]);
    const p = validateNodes(d, { data: { cpu: ser("a", [1]), stat: { kind: "stat", value: 3, label: "x" } } });
    expect(p.map((x) => x.code)).toEqual(expect.arrayContaining(["chart.data_ignored", "chart.line_shape"]));
  });
  it("examples of every new type pass", () => {
    for (const t of ["service-tile", "group", "resource-bar", "bookmarks", "chart"] as const)
      for (const ex of META[t].docs.examples) {
        const d = doc([ex], ["cpu", "load", "hosts", "services", "lamps"]);
        expect(validateNodes(d).filter((x) => x.severity === "error"), `${t}`).toEqual([]);
      }
  });
});

describe("chart lines (A10.2)", () => {
  it("groups axes by format and unit: first left, second right, third refused", () => {
    const plan = planLines([
      { data: ser("pve1", [10, 20], { format: "percent" }) },
      { data: ser("pve2", [30, 40], { format: "percent" }) },
      { data: ser("pve1", [1000, 2000], { format: "bytesPerSec" }) },
      { data: ser("pve1", [40, 41], { format: "celsius" }) },
    ]);
    expect(plan.axes.map((a) => a.format)).toEqual(["percent", "bytesPerSec"]);
    expect(plan.series.map((s) => s.axis)).toEqual([0, 0, 1]);
    expect(plan.refused).toEqual([3]);
    // A unit makes its own group even with the same format.
    expect(planLines([{ data: ser("a", [1], { unit: "ms" }) }, { data: ser("b", [1], { unit: "%" }) }]).axes).toHaveLength(2);
  });
  it("names lines: label, else display, else name; several series as label · display", () => {
    expect(planLines([{ data: ser("pve1", [1], { display: "CPU in use, pve1" }) }]).series[0]!.name).toBe("CPU in use, pve1");
    expect(planLines([{ data: ser("pve1", [1]) }]).series[0]!.name).toBe("pve1");
    expect(planLines([{ data: ser("pve1", [1], { display: "CPU" }), label: "Mine" }]).series[0]!.name).toBe("Mine");
    const m = planLines([{ data: many(3), label: "CPU" }]);
    expect(m.series.map((s) => s.name)).toEqual(["CPU · node 0", "CPU · node 1", "CPU · node 2"]);
    expect(planLines([{ data: many(2) }]).series.map((s) => s.name)).toEqual(["node 0", "node 1"]);
    expect(lineSeriesName("", { name: "x", display: "  " }, false)).toBe("x");
  });
  it("draws at most 20 series, the highest latest value first, and says 20 of N", () => {
    const plan = planLines([{ data: many(25) }]);
    expect(plan.total).toBe(25);
    expect(plan.series).toHaveLength(20);
    expect(plan.series[0]!.name).toBe("node 24");
    expect(plan.series.map((s) => s.name)).not.toContain("node 0");
    expect(linesCountText(plan.series.length, plan.total)).toBe("20 of 25 series");
    expect(linesCountText(3, 3)).toBe("3 series");
  });
  it("hidden lines are not drawn; lines with no data yet wait; colours come from tokens or hex", () => {
    const plan = planLines([{ data: ser("a", [1]), hidden: true }, { data: undefined }, { data: ser("b", [1]), color: "series4" }, { data: ser("c", [1]), color: "#112233" }, { data: ser("d", [1]) }]);
    expect(plan.series.map((s) => s.name)).toEqual(["b", "c", "d"]);
    expect(plan.waiting).toEqual([1]);
    expect(plan.series[0]!.stroke).toBe("var(--atr-series-4)");
    expect(plan.series[1]!.stroke).toBe("#112233");
    expect(plan.series[2]!.stroke).toBe("var(--atr-series-1)");
  });
});

describe("nested bindings (lines, stats, items)", () => {
  const children: ComponentNode[] = [
    { id: "c_chartaaaaa", type: "chart", props: { kind: "line", lines: [{ data: b("{{ cpu1 }}"), label: "One" }, { data: b("{{ cpu2 }}") }] } },
    { id: "c_tileaaaaaa", type: "service-tile", props: { name: "Portainer", integrationId: "i_secretish", status: b("{{ health }}"), stats: [{ label: "Running", value: b('{{ ctrs.rows | filter("state", "running") | count }}') }, { label: "Total", value: 3 }] } },
    { id: "c_rbaraaaaaa", type: "resource-bar", props: { items: [{ icon: "cpu", label: "CPU", value: b("{{ host }}"), percent: b("{{ host.value }}") }] } },
    { id: "c_oldchartaa", type: "chart", props: { data: b("{{ cpu1 }}") } },
  ];
  const sources = ["cpu1", "cpu2", "health", "ctrs", "host", "unused"];
  const data: Record<string, ShapedData> = {
    cpu1: ser("pve1", [1, 2], { format: "percent" }),
    cpu2: ser("pve2", [3, 4], { format: "percent" }),
    health: { kind: "status", items: [{ label: "Portainer", state: "up", detail: "running" }] },
    ctrs: { kind: "table", columns: [{ key: "name", label: "Name", type: "text" }, { key: "state", label: "State", type: "status" }], rows: [{ name: "a", state: "running" }, { name: "b", state: "exited" }, { name: "c", state: "running" }] },
    host: { kind: "stat", value: 12.5, format: "percent", label: "x" },
  };
  it("resolve inside arrays, and the sources a page uses include them", () => {
    const d = doc(children, sources);
    expect(sourcesUsed(d, "p_aaaaaaaaaa").map((s) => s.name).sort()).toEqual(["cpu1", "cpu2", "ctrs", "health", "host"]);
    const sc = scope(data);
    const tile = resolveProps(children[1]!, sc).props;
    expect((tile.stats as { value: unknown }[])[0]!.value).toBe(2);
    expect((resolveProps(children[0]!, sc).props.lines as { data: unknown }[])[1]!.data).toEqual(data.cpu2);
    expect(nodeSources(children[2]!).sort()).toEqual(["host"]);
  });
  it("a tile's status reports the worst source it reads (loading, stale, failed)", () => {
    const sc = scope({ ...data, health: undefined }, { cpu1: { state: "fresh" }, ctrs: { state: "stale" } });
    expect(nodeStatus(children[1]!, sc).kind).toBe("loading");
    expect(nodeStatus(children[1]!, scope(data, { health: { state: "fresh" }, ctrs: { state: "stale" } })).kind).toBe("stale");
    expect(nodeStatus(children[1]!, scope(data, { health: { state: "failed", error: { code: "timeout", message: "Timed out" } }, ctrs: { state: "fresh" } })).kind).toBe("failed");
  });
  it("guest values: each line under <nodeId>:lines.<i>.data, stats and items resolved, never the integration id or whole tables", () => {
    const v = resolveGuestValues(doc(children, sources), "p_aaaaaaaaaa", data);
    expect(v["c_chartaaaaa:lines.0.data"]).toEqual(data.cpu1);
    expect(v["c_chartaaaaa:lines.1.data"]).toEqual(data.cpu2);
    expect(v["c_chartaaaaa:lines"]).toBeUndefined();
    expect(v["c_oldchartaa:data"]).toEqual(data.cpu1);
    expect(v["c_tileaaaaaa:stats"]).toEqual([{ label: "Running", value: 2 }, { label: "Total", value: 3 }]);
    expect(v["c_tileaaaaaa:status"]).toEqual(data.health);
    expect(v["c_rbaraaaaaa:items"]).toEqual([{ icon: "cpu", label: "CPU", value: data.host, percent: 12.5 }]);
    const json = JSON.stringify(v);
    expect(json).not.toContain("i_secretish");
    expect(json).not.toContain("exited");
  });
});

describe("tile, bar and bookmark words", () => {
  it("the status badge: words and tones from the first item", () => {
    const st = (state: string, detail?: string): ShapedData => ({ kind: "status", items: [{ label: "x", state: state as "up", ...(detail ? { detail } : {}) }] });
    expect(statusBadge(st("up", "running"))).toMatchObject({ word: "Running", tone: "ok" });
    expect(statusBadge(st("up", "healthy"))).toMatchObject({ word: "Healthy", tone: "ok" });
    expect(statusBadge(st("down", "stopped"))).toMatchObject({ word: "Stopped", tone: "bad", state: "down" });
    expect(statusBadge(st("down", "timeout after 5s"))).toMatchObject({ word: "Down", tone: "bad", detail: "timeout after 5s" });
    expect(statusBadge(st("up", "12 ms"))).toMatchObject({ word: "12 ms", tone: "ok", spoken: "Up, 12 ms" });
    expect(statusBadge(st("up"))).toMatchObject({ word: "Up" });
    expect(statusBadge(st("warn"))).toMatchObject({ word: "Warning", tone: "warn" });
    expect(statusBadge(st("unknown"))).toMatchObject({ word: "Unknown", tone: "unknown" });
    expect(statusBadge("running")).toMatchObject({ word: "Running", state: "up" });
    expect(statusBadge({ kind: "status", items: [] })).toBeNull();
    expect(statusBadge(undefined)).toBeNull();
  });
  it("stat text keeps formats and units", () => {
    expect(statText(12.345, "percent")).toMatchObject({ text: "12.3", unit: "%" });
    expect(statText({ kind: "stat", value: 10.2 * 1024 ** 3, format: "bytes" })).toMatchObject({ text: "10.2", unit: "GB" });
    expect(statText(5.02 * 1024 ** 2, "bytesPerSec")).toMatchObject({ unit: "MB/s" });
    expect(statText(42)).toMatchObject({ text: "42", unit: "" });
    expect(statText("Idle")).toMatchObject({ text: "Idle" });
    expect(statText(null).text).toBe("");
    expect(percentOf(140)).toBe(100);
    expect(percentOf({ kind: "stat", value: 37, label: "x" })).toBe(37);
    expect(percentOf("x")).toBeNull();
  });
  it("bookmarks: two letters and the domain; search: https with {q}, encoded", () => {
    expect(initials("Grainery")).toBe("GR");
    expect(initials("Media Content")).toBe("MC");
    expect(domainOf("https://www.youtube.com/watch?v=1")).toBe("youtube.com");
    expect(domainOf("javascript:alert(1)")).toBe("");
    expect(searchHref("https://duckduckgo.com/?q={q}", "a b&c")).toBe("https://duckduckgo.com/?q=a%20b%26c");
    expect(searchHref("http://x.test/?q={q}", "a")).toBeNull();
    expect(searchHref("https://x.test/?q={q}", "  ")).toBeNull();
  });
  it("icon references: built-in, package, upload, unknown", () => {
    expect(iconRefKind("docker")).toEqual({ kind: "builtin", name: "docker" });
    expect(iconRefKind("pkg:proxmox")).toEqual({ kind: "builtin", name: "proxmox" });
    expect(iconRefKind("/uploads/logo.png")).toEqual({ kind: "upload", path: "/uploads/logo.png" });
    expect(iconRefKind("/uploads/../x").kind).toBe("unknown");
    expect(iconRefKind("nope").kind).toBe("unknown");
  });
  it("a chart with lines is connected; one with neither data nor lines shows samples", () => {
    expect(notConnected({ id: "c_x", type: "chart", props: { lines: [{ data: b("{{ a }}") }] } })).toBe(false);
    expect(notConnected({ id: "c_x", type: "chart", props: { lines: [] } })).toBe(true);
    expect(notConnected({ id: "c_x", type: "service-tile", props: {} })).toBe(false);
  });
});

describe("prop paths for the picker", () => {
  const props = { stats: [{ label: "a", value: 1 }], lines: [{ data: b("{{ a }}") }], status: b("{{ s }}") };
  it("reads and writes nested entries, appends one past the end, removes with null", () => {
    expect(getPropPath(props, "stats.0.value")).toBe(1);
    expect(getPropPath(props, "lines.0.data")).toEqual(b("{{ a }}"));
    expect(getPropPath(props, "lines.3.data")).toBeUndefined();
    expect(setPropPath(props, "status", b("{{ t }}"))).toEqual({ key: "status", next: b("{{ t }}") });
    expect(setPropPath(props, "stats.0.value", b("{{ x }}"))).toEqual({ key: "stats", next: [{ label: "a", value: b("{{ x }}") }] });
    expect(setPropPath(props, "lines.1.data", b("{{ y }}"))).toEqual({ key: "lines", next: [{ data: b("{{ a }}") }, { data: b("{{ y }}") }] });
    expect(setPropPath({}, "lines.0.data", b("{{ y }}"))).toEqual({ key: "lines", next: [{ data: b("{{ y }}") }] });
    expect(setPropPath(props, "lines.0", null)).toEqual({ key: "lines", next: [] });
    expect(() => setPropPath(props, "lines.5.data", b("{{ y }}"))).toThrow();
    // The original is untouched.
    expect(props.lines).toHaveLength(1);
  });
});
