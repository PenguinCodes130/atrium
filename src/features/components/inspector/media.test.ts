// The Picture panel's maths and the renderer's transforms (media layout spec 3.1, criteria 1 to 7):
// shapes to box heights, quarter turns that respect flips, the cover scale for Straighten, focal points,
// filters and presets, Reset, and the CSS each look writes.
import { describe, expect, it } from "vitest";
import { coverScale, filterCss, holderStyle, mediaElementStyle, readLook, turnTransform } from "../render/content";
import { boxForShape, cleanFilters, FILTER_PRESETS, filtersPatch, focalFrom, isWebAddress, lookIsSet, presetOf, rotateBy, shapeRatio } from "./media";

describe("shape to box (criteria 1 and 4)", () => {
  it("16:9 on a 300px wide box gives a picture 169px tall and the box rows that hold it with the gap", () => {
    expect(shapeRatio("16:9", null, 0)).toBeCloseTo(9 / 16);
    const b = boxForShape(300, 9 / 16, 16);
    expect(b.height).toBe(169);
    expect(Math.abs(b.rows * 8 - 16 - 300 * (9 / 16))).toBeLessThanOrEqual(8);
  });
  it("Original follows the file, and a quarter turn swaps it (a landscape picture turned right is portrait)", () => {
    expect(shapeRatio("original", { w: 2400, h: 1600 }, 0)).toBeCloseTo(2 / 3);
    expect(shapeRatio("original", { w: 2400, h: 1600 }, 90)).toBeCloseTo(1.5);
    expect(shapeRatio("original", { w: 2400, h: 1600 }, 180)).toBeCloseTo(2 / 3);
    expect(shapeRatio("original", null, 0)).toBeNull();
    expect(shapeRatio("fill", { w: 10, h: 10 }, 0)).toBeNull();
    expect(shapeRatio("1:1", null, 90)).toBe(1);
    expect(shapeRatio("9:16", null, 0)).toBeCloseTo(16 / 9);
  });
  it("keeps the picture height inside the schema's 16 to 1200 px", () => {
    expect(boxForShape(2000, 16 / 9).height).toBe(1200);
    expect(boxForShape(10, 9 / 16).height).toBe(16);
  });
});

describe("turns and flips (criteria 1 and 2)", () => {
  it("Rotate right turns clockwise, left anticlockwise, round the clock", () => {
    expect(rotateBy(undefined, "right", false, false)).toBe(90);
    expect(rotateBy(270, "right", false, false)).toBe(0);
    expect(rotateBy(0, "left", false, false)).toBe(270);
  });
  it("with one flip a turn is reversed so it still looks clockwise on screen; with two flips it is not", () => {
    expect(rotateBy(0, "right", true, false)).toBe(270);
    expect(rotateBy(0, "right", false, true)).toBe(270);
    expect(rotateBy(0, "right", true, true)).toBe(90);
  });
  it("the holder turns, flips and tilts in screen order; a picture on its side swaps its box", () => {
    const look = readLook({ rotate: 90, flipX: true, straighten: 10 });
    expect(turnTransform(look)).toBe("translate(-50%, -50%) rotate(10deg) scale(-1, 1) rotate(90deg)");
    expect(holderStyle(look)).toMatchObject({ width: "100cqh", height: "100cqw" });
    expect(holderStyle(readLook({}))).toMatchObject({ width: "100%", height: "100%", transform: "translate(-50%, -50%)" });
    // Flip across twice is no flip: the transform is back to plain.
    expect(turnTransform(readLook({ flipX: false }))).toBe("translate(-50%, -50%)");
  });
});

describe("straighten (criterion 3)", () => {
  it("grows the picture just enough to leave no empty corners", () => {
    expect(coverScale(0, 300, 200)).toBe(1);
    const s = coverScale(10, 300, 200);
    const a = (10 * Math.PI) / 180;
    expect(s).toBeCloseTo(Math.cos(a) + 1.5 * Math.sin(a), 6);
    // The tilted, scaled box contains each corner of the frame.
    const W = 300 * s;
    const H = 200 * s;
    for (const [x, y] of [[150, 100], [-150, 100], [150, -100], [-150, -100]] as const) {
      const rx = x * Math.cos(-a) - y * Math.sin(-a);
      const ry = x * Math.sin(-a) + y * Math.cos(-a);
      expect(Math.abs(rx)).toBeLessThanOrEqual(W / 2 + 1e-6);
      expect(Math.abs(ry)).toBeLessThanOrEqual(H / 2 + 1e-6);
    }
    expect(coverScale(-10, 300, 200)).toBeCloseTo(s, 9);
  });
});

describe("zoom and focal point (criteria 5 and 6)", () => {
  it("zooms around the focal point, which is also where the picture is anchored when cropped", () => {
    const st = mediaElementStyle(readLook({ zoom: 2, focusX: 0, focusY: 0 }), "cover");
    expect(st).toMatchObject({ objectFit: "cover", objectPosition: "0% 0%", transform: "scale(2)", transformOrigin: "0% 0%" });
    expect(mediaElementStyle(readLook({}), "contain")).toMatchObject({ objectFit: "contain", objectPosition: "50% 50%" });
    expect(mediaElementStyle(readLook({}), "contain").transform).toBeUndefined();
  });
  it("a focal point comes from the pointer, in whole percent, clamped to the thumbnail", () => {
    const r = { left: 10, top: 20, width: 200, height: 100 };
    expect(focalFrom(10, 20, r)).toEqual({ focusX: 0, focusY: 0 });
    expect(focalFrom(110, 45, r)).toEqual({ focusX: 50, focusY: 25 });
    expect(focalFrom(400, -5, r)).toEqual({ focusX: 100, focusY: 0 });
  });
  it("clamps every stored value to its range", () => {
    const l = readLook({ zoom: 9, straighten: -90, focusX: 140, rotate: 45, filters: { blur: 99, brightness: -3 } });
    expect([l.zoom, l.straighten, l.focusX, l.rotate]).toEqual([4, -45, 100, 0]);
    expect(l.filters).toEqual({ blur: 20, brightness: 0 });
  });
});

describe("filters (criterion 7)", () => {
  it("writes CSS filters for what changes the picture only", () => {
    expect(filterCss({})).toBeUndefined();
    expect(filterCss({ brightness: 100, grayscale: 0 })).toBeUndefined();
    expect(filterCss({ brightness: 120, contrast: 90, saturate: 150, grayscale: 100, sepia: 30, blur: 2 })).toBe("brightness(120%) contrast(90%) saturate(150%) grayscale(100%) sepia(30%) blur(2px)");
  });
  it("Black and white sets Grey to 100 percent, and the presets read back as themselves", () => {
    const bw = FILTER_PRESETS.find((p) => p.id === "bw")!;
    expect(bw.filters.grayscale).toBe(100);
    for (const p of FILTER_PRESETS) expect(presetOf(p.filters)).toBe(p.id);
    expect(presetOf({ brightness: 133 })).toBeNull();
  });
  it("a preset replaces every filter (the merge patch removes the ones it leaves out)", () => {
    expect(filtersPatch({ grayscale: 100, contrast: 110 })).toEqual({ brightness: null, contrast: 110, saturate: null, grayscale: 100, sepia: null, blur: null });
    expect(filtersPatch({})).toBeNull();
    expect(cleanFilters({ brightness: 100, sepia: 20 })).toEqual({ sepia: 20 });
  });
});

describe("Reset and click targets", () => {
  it("Reset is on only when a turn, flip, tilt, zoom, focal point or filter is set", () => {
    expect(lookIsSet({})).toBe(false);
    expect(lookIsSet({ fit: "cover", shape: "16:9", caption: "x" })).toBe(false);
    for (const p of [{ rotate: 90 }, { flipX: true }, { straighten: 3 }, { zoom: 1.5 }, { focusX: 10 }, { filters: { sepia: 10 } }]) expect(lookIsSet(p)).toBe(true);
    expect(lookIsSet({ filters: { brightness: 100 } })).toBe(false);
  });
  it("only http and https addresses are click targets", () => {
    expect(isWebAddress("https://example.org/a")).toBe(true);
    expect(isWebAddress("http://10.0.0.2:8080")).toBe(true);
    expect(isWebAddress("javascript:alert(1)")).toBe(false);
    expect(isWebAddress("ftp://x")).toBe(false);
    expect(isWebAddress("https://a b")).toBe(false);
  });
});
