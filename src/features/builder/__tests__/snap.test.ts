// Wave 2.10b F7 (A11.7): the one snapping model's maths.
import { describe, expect, it } from "vitest";
import { nearestGapPx, smartSnap, spacingFor } from "../snap";

const pull = { x: 0.08, y: 0.75 };

describe("smartSnap (F7)", () => {
  it("pulls a left edge within the pull onto another widget's edge and names the guide", () => {
    const r = smartSnap({ x: 1.93, y: 13.2, w: 2, h: 8 }, [{ x: 2, y: 0, w: 2, h: 8 }], 12, pull);
    expect(r.box.x).toBe(2);
    expect(r.pulled.x).toBe("guide");
    expect(r.guides.some((g) => g.axis === "x" && g.at === 2 && !g.page)).toBe(true);
  });
  it("leaves a box alone beyond the pull, rounded to an eighth and a whole row", () => {
    const r = smartSnap({ x: 1.7, y: 13.2, w: 2, h: 8 }, [{ x: 2, y: 0, w: 2, h: 8 }], 12, pull);
    expect(r.box).toMatchObject({ x: 1.75, y: 13 });
    expect(r.pulled.x).toBe(null);
    expect(r.guides.filter((g) => g.axis === "x")).toEqual([]);
  });
  it("pulls to the page centre with a page guide", () => {
    const r = smartSnap({ x: 4.95, y: 30, w: 2, h: 8 }, [], 12, pull);
    expect(r.box.x).toBe(5);
    expect(r.guides.find((g) => g.axis === "x")?.page).toBe(true);
  });
  it("pulls to a matching gap and marks both gaps", () => {
    const others = [{ x: 2, y: 0, w: 2, h: 8 }, { x: 6, y: 0, w: 2, h: 8 }];
    const r = smartSnap({ x: 9.93, y: 0, w: 2, h: 8 }, others, 12, pull);
    expect(r.box.x).toBe(10);
    expect(r.pulled.x).toBe("spacing");
    expect(r.spacing.filter((s) => s.axis === "x").map((s) => [s.from, s.to])).toEqual([[8, 10], [4, 6]]);
  });
  it("columns pull when no widget is near, and draw no guide line", () => {
    const r = smartSnap({ x: 7.95, y: 40, w: 3, h: 8 }, [{ x: 0, y: 0, w: 1, h: 8 }], 12, pull);
    expect(r.box.x).toBe(8);
    expect(r.pulled.x).toBe("column");
    expect(r.guides.filter((g) => g.axis === "x")).toEqual([]);
  });
  it("guides win over a closer column line at the same distance", () => {
    const r = smartSnap({ x: 3.95, y: 20, w: 2, h: 8 }, [{ x: 4, y: 0, w: 2, h: 8 }], 12, pull);
    expect(r.pulled.x).toBe("guide");
  });
  it("stays inside the grid", () => {
    expect(smartSnap({ x: 11.5, y: -3, w: 2, h: 8 }, [], 12, pull).box).toMatchObject({ x: 10, y: 0 });
  });
  it("pulls a top edge onto another's bottom", () => {
    const r = smartSnap({ x: 5, y: 8.6, w: 2, h: 8 }, [{ x: 0, y: 0, w: 2, h: 8 }], 12, pull);
    expect(r.box.y).toBe(8);
    expect(r.pulled.y).toBe("guide");
  });
});

describe("spacingFor and nearestGapPx", () => {
  it("no marks without an equal gap", () => {
    expect(spacingFor({ x: 9, y: 0, w: 2, h: 8 }, [{ x: 2, y: 0, w: 2, h: 8 }, { x: 6, y: 0, w: 2, h: 8 }])).toEqual([]);
  });
  it("the gap to the nearest neighbour in px, beside or below", () => {
    expect(nearestGapPx({ left: 100, top: 0, width: 50, height: 40 }, [{ left: 0, top: 0, width: 80, height: 40 }, { left: 300, top: 0, width: 50, height: 40 }])).toEqual({ px: 20, axis: "x" });
    expect(nearestGapPx({ left: 0, top: 70, width: 50, height: 40 }, [{ left: 0, top: 0, width: 80, height: 48 }], 8)).toEqual({ px: 30, axis: "y" });
    expect(nearestGapPx({ left: 0, top: 0, width: 50, height: 40 }, [])).toBe(null);
  });
});
