import { describe, expect, it } from "vitest";
import { cubicBezierAt, durations, MAX_INTERACTION_MS, springs, springSettleMs, staggerDelay, timed, transitionFor, typeInMs } from "./motion";
import { bandPassMs, claimSweep, settleSchedule, shouldPlaySweep, sweepOrder, type SweepStorage } from "./sweep";
import { effectiveReducedMotion, effectiveReduceTransparency, htmlAttributes, readPreferences } from "./preferences";
import { activeTab, badgeText, isActive, MORE_ITEMS, moveItem, PHONE_TABS, TABS } from "./nav";
import { isPaletteShortcut } from "./palette-bridge";
import { layoutForWidth } from "./use-viewport";

describe("spring presets (design v4 section 3, spec v2 criterion 24)", () => {
  it("match the frozen stiffness, damping and mass", () => {
    expect(springs.settle).toMatchObject({ type: "spring", stiffness: 300, damping: 32, mass: 1 });
    expect(springs.glide).toMatchObject({ type: "spring", stiffness: 560, damping: 46, mass: 1 });
    expect(springs.lift).toMatchObject({ type: "spring", stiffness: 420, damping: 34, mass: 1 });
    expect(springs.press).toMatchObject({ type: "spring", stiffness: 900, damping: 50, mass: 0.6 });
    expect(springs.sheet).toMatchObject({ type: "spring", stiffness: 420, damping: 40, mass: 1 });
    expect(springs.pop).toMatchObject({ type: "spring", stiffness: 700, damping: 40, mass: 0.8 });
    expect(Object.keys(springs).sort()).toEqual(["glide", "lift", "pop", "press", "settle", "sheet"]);
  });

  it("durations and easings match", () => {
    expect(durations.fade).toMatchObject({ ms: 160, ease: [0.2, 0, 0, 1] });
    expect(durations.sweep).toMatchObject({ ms: 1200, ease: [0.22, 1, 0.36, 1] });
    expect(durations.glow).toMatchObject({ ms: 900, ease: [0.16, 1, 0.3, 1] });
    expect(durations.type).toMatchObject({ msPerChar: 28, maxMs: 1200, css: "linear" });
    expect(durations.tick).toMatchObject({ ms: 240, ease: [0.2, 0, 0, 1] });
    expect(durations.stagger).toMatchObject({ ms: 30, maxItems: 12 });
    expect(durations.sky).toMatchObject({ ms: 40_000, css: "linear" });
    expect(durations.door).toMatchObject({ ms: 4800, css: "ease-in-out" });
    expect(timed("fade")).toEqual({ duration: 0.16, ease: [0.2, 0, 0, 1] });
  });

  it("every user-triggered spring settles within 400ms (criterion 25)", () => {
    for (const name of ["settle", "glide", "lift", "press", "sheet", "pop"] as const) expect(springSettleMs(name)).toBeLessThanOrEqual(MAX_INTERACTION_MS);
  });
  it("type-in is 28ms a character, capped at 1200ms, and instant under reduced motion", () => {
    expect(typeInMs(10)).toBe(280);
    expect(typeInMs(100)).toBe(1200);
    expect(typeInMs(10, true)).toBe(0);
  });

  it("reduced motion makes springs instant with a 120ms crossfade", () => {
    expect(transitionFor("sheet", false)).toBe(springs.sheet);
    expect(transitionFor("sheet", true)).toEqual({ default: { duration: 0 }, opacity: { duration: 0.12, ease: "linear" } });
  });

  it("cubic bezier evaluates its endpoints", () => {
    expect(cubicBezierAt(durations.sweep.ease, 0)).toBeCloseTo(0, 5);
    expect(cubicBezierAt(durations.sweep.ease, 1)).toBeCloseTo(1, 5);
  });
});

describe("stagger (criterion 23)", () => {
  it("is 30ms apart for the first 12 items, and later items start with the 12th (criterion 29)", () => {
    const d = Array.from({ length: 15 }, (_, i) => staggerDelay(i));
    expect(d.slice(0, 12)).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]);
    expect(d.slice(12)).toEqual([330, 330, 330]);
  });
  it("is all together under reduced motion", () => {
    expect(Array.from({ length: 15 }, (_, i) => staggerDelay(i, true)).every((v) => v === 0)).toBe(true);
  });
  it("settle schedule keeps the 30ms steps after the band reaches the first window", () => {
    const s = settleSchedule(15, 120, 800);
    expect(s[0]).toBe(Math.round(bandPassMs(120, 800)));
    for (let i = 1; i < 12; i++) expect(s[i]! - s[i - 1]!).toBeGreaterThanOrEqual(29);
    expect(new Set(s.slice(11)).size).toBe(1);
  });
  it("sorts widgets top to bottom, then left to right", () => {
    expect(sweepOrder([{ top: 300, left: 0 }, { top: 0, left: 500 }, { top: 2, left: 10 }]).map((r) => r.left)).toEqual([10, 500, 0]);
  });
});

describe("sweep once per session (criterion 22)", () => {
  const memory = (): SweepStorage => {
    let played = false;
    return { played: () => played, markPlayed: () => void (played = true) };
  };
  it("plays on the first dashboard paint only", () => {
    const s = memory();
    expect(claimSweep(s, false)).toBe(true);
    expect(claimSweep(s, false)).toBe(false);
  });
  it("never plays under reduced motion", () => {
    expect(shouldPlaySweep(memory(), true)).toBe(false);
  });
  it("the band reaches the bottom of the viewport within 1200ms", () => {
    expect(bandPassMs(-1000, 800)).toBeCloseTo(0, 5);
    expect(bandPassMs(800, 800)).toBeLessThan(1200);
    expect(bandPassMs(10_000, 800)).toBeCloseTo(1200, 0);
  });
});

describe("preferences and reduced-motion / reduce-transparency mapping", () => {
  const jar = (v: Record<string, string>) => ({ get: (n: string) => (n in v ? { value: v[n]! } : undefined) });
  it("reads cookies into preferences", () => {
    expect(readPreferences(jar({}))).toEqual({ theme: "system", reducedMotion: false, reduceTransparency: false });
    expect(readPreferences(jar({ atrium_theme: "dark", atrium_motion: "reduce", atrium_transparency: "reduce" }))).toEqual({ theme: "dark", reducedMotion: true, reduceTransparency: true });
    expect(readPreferences(jar({ atrium_theme: "purple" })).theme).toBe("system");
  });
  it("maps to html attributes (override wins over system)", () => {
    expect(htmlAttributes({ theme: "light", reducedMotion: false, reduceTransparency: true })).toEqual({ "data-theme": "light", "data-motion": undefined, "data-transparency": "reduce" });
    expect(htmlAttributes({ theme: "system", reducedMotion: true, reduceTransparency: false })["data-theme"]).toBeUndefined();
  });
  it("either the system setting or the in-app switch reduces", () => {
    expect(effectiveReducedMotion(false, false)).toBe(false);
    expect(effectiveReducedMotion(true, false)).toBe(true);
    expect(effectiveReducedMotion(false, true)).toBe(true);
    expect(effectiveReduceTransparency(false, false, true)).toBe(false);
    expect(effectiveReduceTransparency(false, false, false)).toBe(true);
    expect(effectiveReduceTransparency(true, false, true)).toBe(true);
    expect(effectiveReduceTransparency(false, true, true)).toBe(true);
  });
});

describe("navigation helpers", () => {
  it("badge only when there is something pending", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(3)).toBe("3");
    expect(badgeText(250)).toBe("99+");
  });
  it("active matching", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/integrations/x", "/integrations")).toBe(true);
    expect(isActive("/integrationsx", "/integrations")).toBe(false);
    expect(isActive("/settings", "/")).toBe(false);
    // The Apps tab is active on the launcher and in the builder (design v4).
    expect(isActive("/build/homelab", "/")).toBe(true);
    expect(activeTab("/integrations/new")).toBe("integrations");
    expect(activeTab("/nope")).toBeNull();
    expect(TABS.map((t) => t.label)).toEqual(["Apps", "Integrations", "Approvals", "Library", "Audit", "Settings"]);
    expect(PHONE_TABS.map((t) => t.label)).toEqual(["Apps", "Integrations", "Approvals"]);
    expect(MORE_ITEMS.map((t) => t.label)).toEqual(["Library", "Audit", "Settings"]);
  });
  it("keyboard reorder moves one place", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
  });
  it("Ctrl or Cmd plus K opens the palette", () => {
    const k = { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false };
    expect(isPaletteShortcut(k)).toBe(true);
    expect(isPaletteShortcut({ ...k, ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...k, ctrlKey: false })).toBe(false);
  });
  it("layout breakpoints", () => {
    expect(layoutForWidth(390)).toBe("phone");
    expect(layoutForWidth(640)).toBe("rail");
    expect(layoutForWidth(1099)).toBe("rail");
    expect(layoutForWidth(1100)).toBe("sidebar");
  });
});
