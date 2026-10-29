// Wave 2.10a round 2, builder C (components): unit checks for the gauntlet r1 Fix List items 2, 4, 6, 7,
// 14 and 15 and the lows. The screen behaviour is in tests/e2e/components/o-w210a-r2.spec.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNotChecked, statusBadge } from "./render/tiles-logic";
import { matchColumns } from "./render/measure";

const css = readFileSync(path.join(__dirname, "components.css"), "utf8");
const REACH = readFileSync(path.join(__dirname, "../integrations/host/reach.ts"), "utf8");

describe("item 7: an address Atrium does not check", () => {
  const refused = /REACH_REFUSED = "([^"]+)"/.exec(REACH)?.[1] ?? "";
  it("matches the reachability check's own refusal text", () => {
    expect(refused).not.toBe("");
    expect(isNotChecked(refused)).toBe(true);
    expect(isNotChecked("Connection refused")).toBe(false);
    expect(isNotChecked(undefined)).toBe(false);
  });
  it("reads Not checked, neutral, with the reason kept for the tile and for screen readers", () => {
    const b = statusBadge({ kind: "status", items: [{ label: "127.0.0.1", state: "down", detail: refused }] })!;
    expect(b).toMatchObject({ word: "Not checked", tone: "unknown", state: "unchecked", detail: refused });
    expect(b.spoken).toBe(`Not checked, ${refused}`);
  });
  it("a real failure still reads Down in the bad tone", () => {
    expect(statusBadge({ kind: "status", items: [{ label: "x", state: "down", detail: "Connection refused" }] })).toMatchObject({ word: "Down", tone: "bad", state: "down" });
  });
  it("the badge's dot is hollow and the reason shows on focus, badge hover and after a tap", () => {
    expect(css).toMatch(/\.atr-badge\[data-badge-state="unchecked"\] \.atr-badge-dot \{ background: none;/);
    expect(css).toMatch(/\.atr-tile\[data-reason-open\] \.atr-tile-reason, a\.atr-tile:focus-visible \.atr-tile-reason/);
  });
});

describe("item 15: Columns by the headers people see", () => {
  const cols = [{ key: "name", label: "Name" }, { key: "cpu", label: "CPU" }, { key: "disk", label: "Disk (/)" }];
  it("matches keys, then keys or headers in any case and spacing, in the typed order, each once", () => {
    expect(matchColumns(cols, ["Name", "Disk (/)", "cpu"]).columns.map((c) => c.key)).toEqual(["name", "disk", "cpu"]);
    expect(matchColumns(cols, [" disk  (/) ", "NAME", "name"]).columns.map((c) => c.key)).toEqual(["disk", "name"]);
  });
  it("names what matches nothing", () => {
    expect(matchColumns(cols, ["Name", "Nope", ""])).toEqual({ columns: [cols[0]], unknown: ["Nope"] });
  });
});

describe("item 2: scale kinds hold their own rows in the viewer", () => {
  it("auto rows do not stretch, and a scale cell is pinned to its rows with size containment", () => {
    expect(css).toMatch(/\.atr-grid\[data-grow-rows\] \{ align-content: start; \}/);
    expect(css).toMatch(/\.atr-grid\[data-grow-rows\] > \.atr-cell\[data-sizing="scale"\] \{ contain: size; align-self: start; height: calc\(var\(--atr-rows, 1\) \* 8px\); \}/);
  });
});

describe("item 4 (component half): density reaches component spacing", () => {
  it("title bars and tiles take the theme's density sizes; the group, the bar and bookmarks scale by --theme-density-k", () => {
    expect(css).toMatch(/--atr-k: var\(--theme-density-k, 1\)/);
    expect(css).toMatch(/\.atr-tile \{[^}]*padding: var\(--theme-tile-pad-y, calc\(12px \* var\(--atr-k, 1\)\)\) var\(--theme-tile-pad-x, calc\(14px \* var\(--atr-k, 1\)\)\)/);
    expect(css).toMatch(/\.atr-tile-icon \{[^}]*width: var\(--theme-tile-icon, 36px\)/);
    expect(css).toMatch(/\.atr-group-head \{[^}]*min-height: var\(--theme-group-head-h, calc\(28px \* var\(--atr-k, 1\)\)\)/);
    expect(css).toMatch(/\.atr-bar \{[^}]*padding: calc\(8px \* var\(--atr-k, 1\)\)/);
    expect(css).toMatch(/\.atr-bookmark \{[^}]*min-height: calc\(36px \* var\(--atr-k, 1\)\)/);
    expect(css).not.toMatch(/\[data-canvas-titlebars="on"\] \.atr-titlebar \{[^}]*height: 28px/);
  });
});

describe("item 6 and the lows", () => {
  it("a tile in a group or cell is a size container; narrow tiles drop the badge word and wrap the name", () => {
    expect(css).toMatch(/:is\(\.atr-group-item, \.atr-cell\) > \.atr-node > \.atr-tile \{ container: atr-tile \/ inline-size; \}/);
    expect(css).toMatch(/@container atr-tile \(max-width: 230px\) \{[^}]*\.atr-badge \{[^}]*\}\s*\.atr-tile-head \.atr-badge > \.atr-badge-word \{ display: none; \}/);
    expect(css).toMatch(/@container atr-tile \(max-width: 170px\)[\s\S]*-webkit-line-clamp: 2/);
  });
  it("the hover lift also changes the shadow, and number cells never wrap", () => {
    expect(css).toMatch(/a\.atr-tile-link:hover \{ transform: translateY\(-2px\); box-shadow: var\(--theme-shadow, none\), /);
    expect(css).toMatch(/\.atr-table td\[data-type="number"\], \.atr-table td \.atr-num \{ white-space: nowrap; \}/);
  });
});
