// Gauntlet w2-r2 Fix List, round 3 (app-builder, pure parts): Customise keeps dark themes readable and the
// nav pill on the accent (items 3, 4), the control form's parameter mapping (item 2), drops and deletions
// leave no dead bands (item 16) and the canvas tag names library components (item 9).
import { describe, expect, it } from "vitest";
import type { AppDocument, CommandDef, ComponentNode, Theme } from "@/core/contracts";
import { BUILT_IN_THEMES, contrastReport } from "@/features/shell";
import { blankDocument } from "@/features/apps/doc";
import { autoParams, missingParams, paramRows, sourceOf } from "@/features/apps/control-params";
import { customisedTheme, customiseWarnings, readableOn, toHex, wallpaperDefaults } from "../app-look";
import { closeGapOps, snapDrop, withGapsClosed } from "../geometry";
import { tagFor } from "../tags";

const theme = (k: keyof typeof BUILT_IN_THEMES) => structuredClone(BUILT_IN_THEMES[k]) as Theme;

describe("items 3 and 4: Customise on a dark theme", () => {
  it("the gradient swatches start from Dusk's own wallpaper, so the default path stays readable", () => {
    const dusk = theme("dusk");
    const d = wallpaperDefaults(dusk);
    expect([d.a, d.b]).toEqual([toHex("oklch(0.30 0.05 40)"), toHex("oklch(0.18 0.03 280)")]);
    const t = customisedTheme(dusk, "Homelab", "#22C55E", { kind: "gradient", a: d.a, b: d.b, image: "" });
    expect(customiseWarnings(t)).toEqual([]);
    expect(contrastReport(t).canvasText).toBeGreaterThanOrEqual(4.5);
  });
  it("the round 2 path (cream to pale blue under Dusk's light text) is flagged, with a one-click readable text", () => {
    const t = customisedTheme(theme("dusk"), "Homelab", "#22C55E", { kind: "gradient", a: "#F3EFE4", b: "#C9D8E6", image: "" });
    const w = customiseWarnings(t);
    expect(w.map((x) => x.field)).toContain("color.canvasText");
    const fix = readableOn(["#F3EFE4", "#C9D8E6"]);
    expect(fix.ratio).toBeGreaterThanOrEqual(4.5);
    const fixed = customisedTheme(theme("dusk"), "Homelab", "#22C55E", { kind: "gradient", a: "#F3EFE4", b: "#C9D8E6", image: "" }, { canvasText: fix.color });
    expect(customiseWarnings(fixed).map((x) => x.field)).not.toContain("color.canvasText");
  });
  it("an image wallpaper on a dark theme without colours starts from dark swatches", () => {
    const dusk = theme("dusk");
    dusk.tokens.wallpaper = { ...dusk.tokens.wallpaper, kind: "image", value: "/uploads/abcdefghij0123456789.png", colors: undefined };
    const d = wallpaperDefaults(dusk);
    expect(readableOn([d.a, d.b]).color).toBe("#F3EFE4"); // dark swatches: light text reads on them
  });
  it("the nav pill follows the new accent with a contrasting ink when the base follows its accent (Dusk)", () => {
    const t = customisedTheme(theme("dusk"), "Homelab", "#22C55E", { kind: "keep", a: "", b: "", image: "" });
    expect(t.tokens.chrome.activeFill).toBe("#22C55E");
    expect(t.tokens.chrome.activeText).toBe(t.tokens.color.accentText);
    expect(contrastReport(t).accentText).toBeGreaterThanOrEqual(4.5);
  });
  it("a base whose active fill is set apart from the accent (Control Room) keeps it", () => {
    const cr = theme("controlRoom");
    const t = customisedTheme(cr, "Lab", "#3366FF", { kind: "keep", a: "", b: "", image: "" });
    expect(t.tokens.chrome.activeFill).toBe(cr.tokens.chrome.activeFill);
  });
  it("text on the accent changes only when it would stop reading", () => {
    const solid = theme("solid"); // white on blue
    expect(customisedTheme(solid, "A", "#1D4ED8", { kind: "keep", a: "", b: "", image: "" }).tokens.color.accentText).toBe(solid.tokens.color.accentText);
    expect(customisedTheme(solid, "A", "#FDE047", { kind: "keep", a: "", b: "", image: "" }).tokens.color.accentText).toBe("#15130F");
  });
});

describe("item 2: parameter mapping", () => {
  const lamp: CommandDef = { id: "lamp.toggle", label: "Desk lamp", description: "", params: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] }, risk: "low" };
  const light: CommandDef = { id: "light.turn_on", label: "Turn on", description: "", params: { type: "object", properties: { entityId: { type: "string" }, brightness: { type: "integer" } }, required: ["entityId"] }, target: { endpointId: "states", field: "entity_id" }, risk: "low" };
  it("a toggle on a command with one on/off parameter maps it to the switch automatically", () => {
    expect(autoParams(lamp, "toggle")).toEqual({ on: { $bind: "{{ $input }}" } });
    expect(autoParams(lamp, "button")).toEqual({});
    expect(missingParams(lamp, {}).map((r) => r.name)).toEqual(["on"]);
    expect(missingParams(lamp, autoParams(lamp, "toggle"))).toEqual([]);
  });
  it("never lists the target, and a slider fills a number parameter", () => {
    expect(paramRows(light).map((r) => r.name)).toEqual(["brightness"]);
    expect(autoParams(light, "slider")).toEqual({ brightness: { $bind: "{{ $input }}" } });
    expect(missingParams(light, {})).toEqual([]); // brightness is optional; the target is checked on its own
  });
  it("reads where a value comes from", () => {
    expect([sourceOf(undefined), sourceOf({ $bind: "{{ $input }}" }), sourceOf({ $bind: "{{$viewer.name}}" }), sourceOf(false), sourceOf("x")]).toEqual(["none", "input", "viewer", "fixed", "fixed"]);
  });
});

describe("item 16: no dead bands", () => {
  const grid = (kids: ComponentNode[]): ComponentNode => ({ id: "c_gridaaaaaa", type: "grid", props: {}, children: kids });
  const at = (id: string, x: number, y: number, w: number, h: number): ComponentNode => ({ id, type: "text", props: { text: id }, slot: { x, y, w, h } });
  function doc(root: ComponentNode): AppDocument {
    const d = blankDocument("Gaps");
    d.pages[0]!.root = root;
    return d;
  }
  it("a loose drop below the content snaps to the next row at the left; Alt keeps the cell", () => {
    const g = grid([at("c_aaaaaaaaaa", 0, 0, 6, 8), at("c_bbbbbbbbbb", 6, 0, 6, 12)]);
    expect(snapDrop({ x: 5, y: 30, w: 3, h: 8 }, g, "desktop")).toEqual({ x: 0, y: 12, w: 3, h: 8 });
    expect(snapDrop({ x: 5, y: 30, w: 3, h: 8 }, g, "desktop", { deliberate: true })).toEqual({ x: 5, y: 30, w: 3, h: 8 });
    expect(snapDrop({ x: 6, y: 4, w: 3, h: 8 }, g, "desktop")).toEqual({ x: 6, y: 4, w: 3, h: 8 }); // inside the content: as placed
    // Moving the lowest node: its own rows do not count.
    expect(snapDrop({ x: 2, y: 20, w: 6, h: 12 }, g, "desktop", { exceptId: "c_bbbbbbbbbb" })).toEqual({ x: 0, y: 8, w: 6, h: 12 });
  });
  it("removing a full-width row moves everything below it up by its height", () => {
    const d = doc(grid([at("c_aaaaaaaaaa", 0, 0, 12, 8), at("c_bbbbbbbbbb", 0, 8, 12, 16), at("c_cccccccccc", 0, 24, 6, 8), at("c_dddddddddd", 6, 24, 6, 8)]));
    const ops = closeGapOps(d, "c_bbbbbbbbbb");
    expect(ops).toEqual([
      { op: "node.move", nodeId: "c_cccccccccc", parentId: "c_gridaaaaaa", index: 1, slot: { x: 0, y: 8, w: 6, h: 8 } },
      { op: "node.move", nodeId: "c_dddddddddd", parentId: "c_gridaaaaaa", index: 2, slot: { x: 6, y: 8, w: 6, h: 8 } },
    ]);
  });
  it("leaves rows a neighbour still covers, and closes only the part nothing covers", () => {
    // b sits beside a taller a: its rows 0..8 stay (a covers them); the band below a, 12..16, closes.
    const d = doc(grid([at("c_aaaaaaaaaa", 0, 0, 6, 12), at("c_bbbbbbbbbb", 6, 0, 6, 16), at("c_cccccccccc", 0, 16, 12, 8)]));
    expect(closeGapOps(d, "c_bbbbbbbbbb")).toEqual([{ op: "node.move", nodeId: "c_cccccccccc", parentId: "c_gridaaaaaa", index: 1, slot: { x: 0, y: 12, w: 12, h: 8 } }]);
    // Nothing below: nothing to move.
    expect(closeGapOps(d, "c_cccccccccc")).toEqual([]);
  });
  it("a batch that puts something back in the grid (detach: remove, then add) is left alone", () => {
    const d = doc(grid([at("c_aaaaaaaaaa", 0, 0, 12, 8), at("c_bbbbbbbbbb", 0, 8, 12, 8)]));
    const detach = [{ op: "node.remove" as const, nodeId: "c_aaaaaaaaaa" }, { op: "node.add" as const, parentId: "c_gridaaaaaa", index: 0, node: at("c_eeeeeeeeee", 0, 0, 12, 8) }];
    expect(withGapsClosed(d, detach)).toEqual(detach);
    expect(withGapsClosed(d, [{ op: "node.remove", nodeId: "c_aaaaaaaaaa" }]).length).toBe(2);
  });
});

describe("item 9: the canvas tag", () => {
  it("names a library instance by its library name, never the lib: id", () => {
    const n: ComponentNode = { id: "c_libaaaaaaa", type: "lib:l_v6qqpha7yw", props: {}, libraryRef: { componentId: "l_v6qqpha7yw", version: 2 } };
    expect(tagFor(n, { "l_v6qqpha7yw@2": { name: "ux-cpu-tile" } as never })).toBe("ux-cpu-tile");
    expect(tagFor(n, {})).toBe("library component");
    expect(tagFor({ id: "c_stataaaaaa", type: "stat", props: {} }, undefined)).toBe("stat");
  });
});
