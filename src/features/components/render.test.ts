// Server-rendered checks of RenderNode and the inspector (react-dom/server, no browser).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppDocument, ComponentNode, RenderContext, ShapedData } from "@/core/contracts";

vi.mock("./actions", () => ({ compileNodeStylesAction: async () => ({}) }));

const { RenderNode, treeUsesNow } = await import("./render/render-node");
const { RenderDeviceProvider } = await import("./render/context");
const { InspectorPanels } = await import("./inspector/inspector");

type Src = Record<string, { state: "fresh" | "stale" | "failed" | "empty"; data?: ShapedData; sourceTimestamp?: string; refreshSec: number; error?: { code: string; message: string; hint?: string } }>;

function ctx(mode: RenderContext["mode"], sources: Src = {}, extra: Record<string, unknown> = {}): RenderContext {
  const $data: Record<string, ShapedData | undefined> = {};
  for (const [k, v] of Object.entries(sources)) $data[k] = v.data;
  return {
    mode, principal: { kind: "user", userId: "u", role: "owner", via: "session" }, appId: "a", pageId: "p_aaaaaaaaaa", version: "draft",
    values: { $data, $sources: sources, $page: { id: "p_aaaaaaaaaa", slug: "home", title: "Home" }, $app: { id: "a", slug: "a", name: "A" }, $user: { kind: "user" }, $controls: { k_lampaaaaaa: { label: "Lamp" } }, ...extra } as never,
    runControl: async () => ({ ok: true }), confirm: async () => true, navigate: () => {},
  };
}
const render = (node: ComponentNode, c: RenderContext, device: "desktop" | "mobile" | "auto" = "auto") => renderToStaticMarkup(h(RenderDeviceProvider, { device, children: h(RenderNode, { node, ctx: c }) }));
const fresh = (data: ShapedData, extra: Partial<Src[string]> = {}): Src[string] => ({ state: "fresh", data, refreshSec: 30, ...extra });

describe("layout (criteria 3, 4, 5)", () => {
  const grid: ComponentNode = {
    id: "c_gridaaaaaa", type: "grid", props: {}, children: [
      { id: "c_firstaaaaa", type: "text", props: { text: "first" }, slot: { x: 6, y: 0, w: 6, h: 4 }, responsive: { mobile: { slot: { x: 0, y: 0, w: 4, h: 4 } } } },
      { id: "c_hiddenmobl", type: "text", props: { text: "desktop only" }, slot: { x: 0, y: 0, w: 6, h: 4 }, responsive: { mobile: { hidden: true } } },
    ],
  };
  it("places children on 4 columns with their mobile slots at phone width", () => {
    const m = render(grid, ctx("view"), "mobile");
    expect(m).toContain('data-columns="4"');
    expect(m).toContain("repeat(4, minmax(0, 1fr))");
    expect(m).toMatch(/data-cell="c_firstaaaaa" style="grid-column:1 \/ span 4/);
    expect(m).not.toContain("desktop only");
  });
  it("uses 12 columns and desktop slots on desktop, where the mobile-hidden node is present", () => {
    const d = render(grid, ctx("view"), "desktop");
    expect(d).toContain('data-columns="12"');
    expect(d).toMatch(/data-cell="c_firstaaaaa" style="grid-column:7 \/ span 6/);
    expect(d).toContain("desktop only");
  });
  it("repeats its child once per row with $index 0 to 4", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `h${i}` }));
    const node: ComponentNode = { id: "c_repeataaaa", type: "repeat", props: { items: { $bind: "{{ hosts.rows }}" } }, children: [{ id: "c_childaaaaa", type: "text", props: { text: { $bind: "#{{ $index }}" } } }] };
    const m = render(node, ctx("view", { hosts: fresh({ kind: "table", columns: [], rows }) }));
    for (let i = 0; i < 5; i++) expect(m).toContain(`#${i}`);
    expect(m).not.toContain("#5");
    expect(m.match(/data-node="c_childaaaaa"/g)?.length).toBe(5);
  });
  it("hides a node whose visibility is false for viewers and fades it with a tag in edit mode", () => {
    const node: ComponentNode = { id: "c_stackaaaaa", type: "stack", props: {}, children: [{ id: "c_invisblea", type: "text", props: { text: "secret plan" }, visibleWhen: { $bind: "{{ false }}" } }] };
    expect(render(node, ctx("view"))).not.toContain("secret plan");
    const e = render(node, ctx("edit"));
    expect(e).toContain("secret plan");
    expect(e).toContain("data-hidden-node");
    expect(e).toContain('class="atr-hidden-tag">hidden<');
  });
});

describe("data components (criteria 6, 7, 8, 26 to 29)", () => {
  const stat = (): ComponentNode => ({ id: "c_statnodeaa", type: "stat", props: { value: { $bind: "{{ cpu.value }}" }, warn: 70, bad: 90, label: "CPU" } });
  it("shows the warn colour at 75 and the bad colour at 95, with a word as well", () => {
    expect(render(stat(), ctx("view", { cpu: fresh({ kind: "stat", value: 75, label: "CPU" }) }))).toMatch(/data-level="warn".*>warn</);
    expect(render(stat(), ctx("view", { cpu: fresh({ kind: "stat", value: 95, label: "CPU" }) }))).toMatch(/data-level="bad".*>bad</);
  });
  it("status items differ by shape and word as well as colour", () => {
    const m = render({ id: "c_statusaaaa", type: "status", props: { data: { $bind: "{{ svc }}" } } }, ctx("view", { svc: fresh({ kind: "status", items: [{ label: "NPM", state: "up" }, { label: "Kuma", state: "down" }, { label: "DNS", state: "warn" }] }) }));
    expect(m).toContain('class="atr-shape" data-state="up"');
    expect(m).toContain('class="atr-shape" data-state="down"');
    expect(m).toContain(">up<");
    expect(m).toContain(">down<");
    expect(m).toContain(">warning<");
  });
  it("counts table rows from total when given, else the rows shown", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ n: i }));
    const cols = [{ key: "n", label: "N", type: "number" as const }];
    const t = (total?: number) => render({ id: "c_tableaaaaa", type: "table", props: { data: { $bind: "{{ t }}" } } }, ctx("view", { t: fresh({ kind: "table", columns: cols, rows, ...(total ? { total } : {}) }) }));
    expect(t(312)).toContain('data-row-count="312"');
    expect(t(312)).toContain("20 of 312 rows");
    expect(t()).toContain('data-row-count="20"');
    expect(t()).toContain(">20 rows<");
  });
  it("draws 3 series with a legend saying 3 series, nulls as gaps, and 12 of 15 with +3 more", () => {
    const series = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, points: [[1, 1], [2, i === 0 ? null : 2], [3, 3]] as [number, number | null][] }));
    const node: ComponentNode = { id: "c_chartaaaaa", type: "chart", props: { data: { $bind: "{{ load }}" } } };
    const three = render(node, ctx("view", { load: fresh({ kind: "series", series: series(3) }) }));
    expect(three).toContain(">3 series<");
    expect(three.match(/data-series="/g)?.length).toBe(3);
    expect(three).toMatch(/data-series="s0" data-segments="2"/);
    const fifteen = render(node, ctx("view", { load: fresh({ kind: "series", series: series(15) }) }));
    expect(fifteen.match(/data-series="/g)?.length).toBe(12);
    expect(fifteen).toContain("+3 more");
    expect(fifteen).toContain(">15 series<");
    const total = render(node, ctx("view", { load: fresh({ kind: "series", series: series(3), total: 312 }) }));
    expect(total).toContain("3 of 312 series");
  });
  it("shows the unshared message with no value, and Not available before the hook", () => {
    const blocked = render(stat(), ctx("view", { cpu: { state: "failed", refreshSec: 30, error: { code: "permission", message: "No data: this integration is no longer shared" } } }));
    expect(blocked).toContain("No data: this integration is no longer shared");
    expect(blocked).not.toContain("atr-stat-value");
    const na = render(stat(), ctx("view", {}, { $available: false }));
    expect(na).toContain("Not available yet");
    const toggle = render({ id: "c_toggleaaaa", type: "toggle", props: { label: "Lamp", control: "k_lampaaaaaa", state: { $bind: "{{ cpu.value > 1 }}" } } }, ctx("view", { cpu: { state: "failed", refreshSec: 30, error: { code: "permission", message: "No data: this integration is no longer shared" } } }));
    expect(toggle).toContain("No data: this integration is no longer shared");
    expect(toggle).toMatch(/role="switch"[^>]*disabled/);
  });
  it("keeps stale values with the amber dot, failed values with the warning and its message and hint", () => {
    const stale = render(stat(), ctx("view", { cpu: fresh({ kind: "stat", value: 41, label: "CPU" }, { state: "stale" }) }));
    expect(stale).toContain('data-state-mark="stale"');
    expect(stale).toContain(">41<");
    const failed = render(stat(), ctx("view", { cpu: fresh({ kind: "stat", value: 41, label: "CPU" }, { state: "failed", error: { code: "timeout", message: "Timed out", hint: "Check the host" } }) }));
    expect(failed).toContain('data-state-mark="failed"');
    expect(failed).toContain(">41<");
    expect(failed).toContain("Timed out");
    expect(failed).toContain("Check the host");
    expect(failed).toMatch(/aria-describedby="[^"]+"/);
    const empty = render(stat(), ctx("view", { cpu: { state: "empty", refreshSec: 30, error: { code: "unreachable", message: "Cannot reach host" } } }));
    expect(empty).toContain("No data yet");
    expect(empty).toContain("Cannot reach host");
  });
  it("hides Last updated by default and shows the source timestamp when on", () => {
    const src = { cpu: fresh({ kind: "stat", value: 1, label: "CPU" }, { sourceTimestamp: "2026-10-18T10:00:00.000Z" }) };
    expect(render(stat(), ctx("view", src))).not.toContain("data-last-updated");
    const on = render({ ...stat(), props: { ...stat().props, showUpdated: true } }, ctx("view", src));
    expect(on).toMatch(/datetime="2026-10-18T10:00:00.000Z"/i);
    expect(on).toContain("data-last-updated");
  });
});

describe("content safety (criteria 9, 10, 11)", () => {
  it("renders markup in text as characters", () => {
    const m = render({ id: "c_textaaaaaa", type: "text", props: { text: "<script>alert(1)</script>" } }, ctx("view"));
    expect(m).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(m).not.toContain("<script>");
  });
  it("draws a javascript: link inert and opens https in a new tab with no opener", () => {
    const bad = render({ id: "c_linkbadaaa", type: "link", props: { label: "x", href: "javascript:alert(1)" } }, ctx("view"));
    expect(bad).toContain("data-inert-link");
    expect(bad).not.toContain("href=");
    const good = render({ id: "c_linkgoodaa", type: "link", props: { label: "x", href: "https://example.com" } }, ctx("view"));
    expect(good).toMatch(/href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
  });
  it("has no raw HTML rendering outside the HTML block's sandbox", () => {
    const roots = [path.resolve(__dirname), path.resolve(__dirname, "../library"), path.resolve(__dirname, "../../app/(shell)/library"), path.resolve(__dirname, "../../app/sandbox"), path.resolve(__dirname, "../../app/api/library")];
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(f) && !f.endsWith(".test.ts")) files.push(p); } };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src.includes("dangerouslySetInnerHTML"), f).toBe(false);
      if (!f.endsWith(path.join("sandbox", "frame-doc.ts"))) expect(/\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write/.test(src), f).toBe(false);
    }
  });
});

describe("controls (criteria 22, 23) and clock (18)", () => {
  const toggle: ComponentNode = { id: "c_toggleaaaa", type: "toggle", props: { label: "Desk lamp", control: "k_lampaaaaaa", state: true } };
  it("exposes a switch with a checked state, a name and a polite live region", () => {
    const m = render(toggle, ctx("view"));
    expect(m).toMatch(/role="switch" aria-checked="true" aria-labelledby="([^"]+)"/);
    const id = /aria-labelledby="([^"]+)"/.exec(m)![1];
    expect(m).toContain(`id="${id}"`);
    expect(m).toContain("Desk lamp");
    expect(m).toContain('role="status" aria-live="polite"');
  });
  it("draws every control disabled in render mode", () => {
    for (const n of [toggle, { id: "c_buttonaaaa", type: "button", props: { label: "Go", control: "k_lampaaaaaa" } }, { id: "c_slideraaaa", type: "slider", props: { label: "Level", control: "k_lampaaaaaa", value: 3 } }, { id: "c_selectaaaa", type: "select", props: { label: "Mode", control: "k_lampaaaaaa", options: [{ label: "A", value: "a" }] } }] as ComponentNode[]) {
      expect(render(n, ctx("agent-render"))).toMatch(/disabled=""/);
    }
  });
  it("ticks $now only on trees that read it", () => {
    expect(treeUsesNow({ id: "c_a", type: "stack", props: {}, children: [{ id: "c_b", type: "text", props: { text: { $bind: "{{ cpu.value }}" } } }] })).toBe(false);
    expect(treeUsesNow({ id: "c_a", type: "stack", props: {}, children: [{ id: "c_b", type: "text", props: { text: { $bind: "{{ $now | date('HH:mm') }}" } } }] })).toBe(true);
  });
});

describe("inspector (criteria 30, 43)", () => {
  const doc: AppDocument = { format: "atrium-app", formatVersion: 1, app: { name: "A", homePage: "p_aaaaaaaaaa", pageOrder: ["p_aaaaaaaaaa"] }, theme: { themeId: "control-room" }, chrome: { layout: "none" }, dataSources: [{ name: "cpu", integrationId: "i", endpointId: "e", refreshSec: 30 }], controls: [], pages: [] };
  const panels = (node: ComponentNode) => renderToStaticMarkup(h(InspectorPanels, { node, doc, onChange: () => {}, ctx: ctx("edit") }));
  it("opens on Content and Data, with Style and Advanced closed and no CSS box", () => {
    const m = panels({ id: "c_statnodeaa", type: "stat", props: { data: { $bind: "{{ cpu }}" } } });
    expect(m).toMatch(/data-inspector-group="content" data-open=""/);
    expect(m).toMatch(/data-inspector-group="data" data-open=""/);
    expect(m).toMatch(/data-inspector-group="style"(?! data-open)/);
    expect(m).toMatch(/data-inspector-group="advanced"(?! data-open)/);
    expect(m).not.toContain("data-css-box");
    expect(m).not.toContain("data-style-panel");
  });
  it("always shows the html block's data notice, and warns when the block has no name", () => {
    const m = panels({ id: "c_htmlaaaaaa", type: "html", props: { html: "", data: {}, controls: [], height: "auto" } });
    expect(m).toContain("Data you give this block is visible to whoever wrote its code.");
    expect(m).toContain("data-html-unnamed");
    expect(panels({ id: "c_htmlaaaaaa", type: "html", name: "Chart", props: { html: "", data: {}, controls: [], height: "auto" } })).not.toContain("data-html-unnamed");
  });
});
