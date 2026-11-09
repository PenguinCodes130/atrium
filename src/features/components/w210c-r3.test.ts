// Wave 2.10c round 3, builder C: the pure parts of the gauntlet w210c-r2 fixes (the screen tests are in
// tests/e2e/components/t-w210c-r3.spec.ts).
import { describe, expect, it } from "vitest";
import { slotScale, startSlot } from "./render/roulette";
import { typedRowTemplate } from "./inspector/inspector";
import { fieldReason, type ReasonEnv } from "./inspector/reasons";
import { siteIconName, rememberSiteIcon } from "./inspector/icon-picker";

describe("item 9: Shows first", () => {
  it("opens on the stored slot, counted from 0, held to the last slot, never wrapping", () => {
    expect(startSlot(undefined, 3)).toBe(0);
    expect(startSlot(1, 3)).toBe(1);
    expect(startSlot(2, 3)).toBe(2);
    expect(startSlot(3, 3)).toBe(2);
    expect(startSlot(9, 3)).toBe(2);
    expect(startSlot(-4, 3)).toBe(0);
    expect(startSlot(1.7, 3)).toBe(1);
    expect(startSlot(5, 0)).toBe(5);
  });
});

describe("item 3: slot content scales to its slot", () => {
  it("is 1 when the widget fits, and the slot over the widget's height when it is taller", () => {
    expect(slotScale(194, 150)).toBe(1);
    expect(slotScale(194, 194)).toBe(1);
    expect(slotScale(160, 220)).toBeCloseTo(160 / 220, 5);
    expect(slotScale(0, 220)).toBe(1);
    expect(slotScale(10, 100000)).toBe(0.05);
  });
});

describe("item 2: a typed row template becomes live data", () => {
  it("knows a row's value in double braces", () => {
    expect(typedRowTemplate("{{ $item.name }}")).toBe(true);
    expect(typedRowTemplate("CPU {{ $item.cpu }} %")).toBe(true);
    expect(typedRowTemplate("{{ $index }}")).toBe(true);
    expect(typedRowTemplate("{{ cpu.value }}")).toBe(false);
    expect(typedRowTemplate("$item.name")).toBe(false);
    expect(typedRowTemplate("{{ $items }}")).toBe(false);
  });
});

describe("first-timer low: a bound Title counts as a title", () => {
  const env = { valueNow: null, bound: false, pages: [{ id: "p_aaaaaaaaaa", slug: "home" }], children: 0 } as unknown as ReasonEnv;
  it("asks for a Title only when there is none, typed or bound", () => {
    expect(fieldReason("card", "subtitle", { subtitle: "FAKE sub" }, env)).toBe("Needs a Title");
    expect(fieldReason("card", "subtitle", { subtitle: "FAKE sub", title: "Typed" }, env)).toBeNull();
    expect(fieldReason("card", "subtitle", { subtitle: "FAKE sub", title: { $bind: "{{ $item.name }}" } }, env)).toBeNull();
  });
});

describe("item 12: a website icon is named from its upload, kept in memory only", () => {
  it("names only a host icon, and writes no browser storage", () => {
    rememberSiteIcon("/uploads/fakeiconone.png", "example.test icon");
    rememberSiteIcon("/uploads/fakeicontwo.png", "My holiday photo");
    expect(siteIconName("/uploads/fakeiconone.png")).toBe("example.test icon");
    expect(siteIconName("/uploads/fakeicontwo.png")).toBeNull();
    expect(siteIconName("/uploads/unknown.png")).toBeNull();
  });
});
