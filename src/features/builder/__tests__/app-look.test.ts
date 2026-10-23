// "Customise" in App look (gauntlet w2-r1 item 7): the app's own inline copy of a theme with a new accent
// and wallpaper, valid as a theme, without touching the theme it came from.
import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES } from "@/features/shell";

const builtInTheme = (id: string) => structuredClone((BUILT_IN_THEMES as unknown as Record<string, import("@/core/contracts").Theme>)[id]!);
import { customisedTheme } from "../app-look";

describe("customisedTheme", () => {
  it("copies the theme with the new accent and a gradient wallpaper, under an app-owned id", () => {
    const base = builtInTheme("dusk");
    const before = JSON.stringify(base);
    const t = customisedTheme(base, "Homelab", "#22c55e", { kind: "gradient", a: "#101010", b: "#203040", image: "" });
    expect(t.id).toBe("app-dusk");
    expect(t.name).toBe("Homelab look");
    expect(t.tokens.color.accent.toLowerCase()).toBe("#22c55e");
    expect(t.tokens.wallpaper.kind).toBe("gradient");
    expect(t.tokens.wallpaper.value).toContain("#101010");
    expect(JSON.stringify(base)).toBe(before);
  });
  it("keeps the wallpaper when asked to", () => {
    const base = builtInTheme("controlRoom");
    const t = customisedTheme(base, "Lab", "#3366ff", { kind: "keep", a: "", b: "", image: "" });
    expect(t.tokens.wallpaper).toEqual(base.tokens.wallpaper);
  });
});
