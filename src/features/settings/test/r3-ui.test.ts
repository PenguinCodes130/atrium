// settings round 3: the pure parts of the w2-r2 Fix List items 2 (slider width classes), 3 (colour
// swatches), 4 ("Use on an app") and 9 (even accent grid data). Throwaway data folders only.
import { describe, expect, it, vi } from "vitest";
import { colorToRgba, dusk } from "@/features/shell/theme";
import { alphaOf, fromPicker, swatchHex } from "@/features/settings/ui/colour";
import { AGENT, MEMBER, OWNER, VIEWER, doc, fakePort, freshDataDir, useInstance } from "./harness";

describe("item 2: the RangeField readout can be narrowed", () => {
  it("keeps the width out of the shared mono field class", async () => {
    vi.resetModules();
    const c = await import("@/features/settings/ui/controls");
    expect(c.MONO_FIELD_CLASS.split(/\s+/)).not.toContain("w-full");
    expect(c.MONO_INPUT_CLASS.split(/\s+/)).toContain("w-full");
    expect(c.MONO_INPUT_CLASS.startsWith(c.MONO_FIELD_CLASS)).toBe(true);
  });
});

describe("item 3: swatches paint the real colour", () => {
  it("gives the sRGB equivalent of oklch and hex values", () => {
    // Dusk's accent oklch(0.78 0.13 60) is an orange, never black.
    const accent = swatchHex(dusk.tokens.color.accent)!;
    expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(accent).not.toBe("#000000");
    const rgb = colorToRgba(dusk.tokens.color.accent)!;
    expect(rgb.r).toBeGreaterThan(rgb.b);
    expect(swatchHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(swatchHex("oklch(0 0 0)")).toBe("#000000");
    expect(swatchHex("oklch(1 0 0 / 0.08)")).toBe("#ffffff");
    expect(swatchHex("#ABC")).toBe("#aabbcc");
    expect(swatchHex("#11223380")).toBe("#112233");
    expect(swatchHex("red")).toBeNull();
    expect(swatchHex("oklch(0.7 0.4 140)")).toMatch(/^#[0-9a-f]{6}$/); // out of gamut: clipped, still a colour
  });
  it("reads alpha", () => {
    expect(alphaOf("oklch(1 0 0 / 0.08)")).toBeCloseTo(0.08);
    expect(alphaOf("oklch(1 0 0 / 50%)")).toBeCloseTo(0.5);
    expect(alphaOf("#11223380")).toBeCloseTo(0x80 / 255);
    expect(alphaOf("#112233")).toBe(1);
  });
  it("writes a picked colour back in the author's format", () => {
    expect(fromPicker("#22C55E", "#e9b949")).toBe("#22c55e");
    expect(fromPicker("#22c55e", "#e9b94980")).toBe("#22c55e80");
    expect(fromPicker("#22c55e", "#abcd")).toBe("#22c55edd");
    const o = fromPicker("#22c55e", "oklch(0.78 0.13 60)");
    expect(o).toMatch(/^oklch\(0\.\d+ 0\.\d+ \d+(\.\d)?\)$/);
    expect(swatchHex(o)).toBe("#22c55e");
    const a = fromPicker("#ffffff", "oklch(1 0 0 / 0.08)");
    expect(a).toBe("oklch(1 0 0 / 0.08)");
    expect(fromPicker("#808080", "oklch(0.5 0.1 20)")).toMatch(/^oklch\(0\.\d+ 0 0\)$/); // grey: no stray hue
    expect(fromPicker("not-a-colour", "#123456")).toBe("#123456");
    expect(fromPicker("#123456", "")).toBe("#123456");
  });
  it("round-trips every built-in colour through the picker within one step of 8-bit", () => {
    for (const [k, v] of Object.entries(dusk.tokens.color)) {
      if (typeof v !== "string" || !v.startsWith("oklch")) continue;
      const back = fromPicker(swatchHex(v)!, v);
      const [x, y] = [colorToRgba(v)!, colorToRgba(back)!];
      for (const ch of ["r", "g", "b"] as const) expect(Math.abs(x[ch] - y[ch]), `${k} ${ch}`).toBeLessThan(2 / 255);
    }
  });
});

async function boot() {
  vi.resetModules();
  useInstance(freshDataDir());
  return {
    use: await import("@/features/themes/use-on-app"),
    store: await import("@/features/themes/store"),
    port: await import("@/features/settings/app-port"),
    hooks: await import("@/core/hooks"),
  };
}

describe("item 4: Use on an app", () => {
  it("lists only apps the caller can edit, with the theme each draft uses now", async () => {
    const m = await boot();
    const fp = fakePort([
      { appId: "homelab", name: "Homelab", draft: doc({ themeId: "control-room" }), published: doc({ themeId: "control-room" }) },
      { appId: "family", name: "Family wall", draft: doc({ themeId: "dusk" }) },
      { appId: "secret", name: "Not mine", draft: doc({ themeId: "solid" }) },
    ]);
    m.port.registerAppPort(fp.port);
    m.hooks.registerAppAccess({ canEditApp: async (_p: unknown, id: string) => id !== "secret" } as never);
    const apps = await m.use.appsForThemeUse(MEMBER);
    expect(apps.map((a) => a.appId)).toEqual(["family", "homelab"]);
    expect(apps.find((a) => a.appId === "homelab")).toMatchObject({ currentThemeId: "control-room", currentThemeName: "Control Room", published: true });
    expect(apps.find((a) => a.appId === "family")).toMatchObject({ currentThemeId: "dusk", published: false });
    await expect(m.use.appsForThemeUse(VIEWER)).rejects.toMatchObject({ status: 403 });
  });

  it("points the app's draft at the theme through applyOps and links to review and look", async () => {
    const m = await boot();
    const fp = fakePort([{ appId: "homelab", name: "Homelab", draft: doc({ themeId: "control-room" }), published: doc({ themeId: "control-room" }) }]);
    m.port.registerAppPort(fp.port);
    m.hooks.registerAppAccess({ canEditApp: async () => true } as never);
    const r = await m.use.useThemeOnApp(OWNER, "dusk", "homelab");
    expect(r).toEqual({ appId: "homelab", slug: "homelab", name: "Homelab", rev: 2, reviewHref: "/build/homelab?review=1", lookHref: "/build/homelab?look=1" });
    expect(fp.calls).toEqual([{ appId: "homelab", rev: 1, ops: [{ op: "theme.set", theme: { themeId: "dusk" } }] }]);
    // Only the draft changes; the published version keeps its theme.
    expect(fp.state[0]!.draft.theme).toEqual({ themeId: "dusk" });
    expect(fp.state[0]!.published!.doc.theme).toEqual({ themeId: "control-room" });
    // "Used by" now lists the app for the theme's draft.
    expect((await m.store.themeUsage("dusk")).map((u) => u.appId)).toEqual(["homelab"]);
  });

  it("refuses viewers, apps the caller cannot edit, unknown themes and unregistered apps", async () => {
    const m = await boot();
    await expect(m.use.useThemeOnApp(OWNER, "dusk", "homelab")).rejects.toMatchObject({ status: 503 });
    const fp = fakePort([{ appId: "homelab", name: "Homelab", draft: doc({ themeId: "control-room" }) }]);
    m.port.registerAppPort(fp.port);
    m.hooks.registerAppAccess({ canEditApp: async (p: { userId?: string }) => p.userId !== "u-member" } as never);
    await expect(m.use.useThemeOnApp(VIEWER, "dusk", "homelab")).rejects.toMatchObject({ status: 403 });
    await expect(m.use.useThemeOnApp(MEMBER, "dusk", "homelab")).rejects.toMatchObject({ status: 403 });
    await expect(m.use.useThemeOnApp(OWNER, "t-missing", "homelab")).rejects.toMatchObject({ status: 404 });
    await expect(m.use.useThemeOnApp(OWNER, "dusk", "nope")).rejects.toMatchObject({ status: 404 });
    // An agent acting for a member who cannot edit is refused the same way.
    await expect(m.use.useThemeOnApp(AGENT, "dusk", "homelab")).rejects.toMatchObject({ status: 403 });
    expect(fp.calls).toEqual([]);
  });
});

describe("item 9: the brand accents fit one even row", () => {
  it("has five entries with short enough names for a five-column grid", async () => {
    const { BRAND_ACCENT_IDS, BRAND_ACCENTS } = await import("@/features/settings/branding-palette");
    expect(BRAND_ACCENT_IDS).toHaveLength(5);
    for (const id of BRAND_ACCENT_IDS) expect(BRAND_ACCENTS[id].label.split(" ").every((w) => w.length <= 8)).toBe(true);
  });
});
