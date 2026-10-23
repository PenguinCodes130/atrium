// settings round 2: the pure parts of the w2-r1 Fix List items 8, 11, 12 and 13 (branding palette and
// store, image wallpaper contrast, gradient parsing, plurals). Throwaway data folders only.
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { colorToRgba, contrastRatio } from "@/features/shell/theme";
import { counted, countedList } from "@/features/backup/words";
import { formatGradient, parseGradient } from "@/features/settings/ui/gradient";
import { cellsFrom, judge, percentileContrast } from "@/features/settings/ui/image-contrast";
import { BRAND_ACCENTS, BRAND_ACCENT_IDS } from "@/features/settings/branding-palette";
import { freshDataDir, useInstance } from "./harness";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d3b5f00000000049454e44ae426082", "hex");
const OWNER: Principal = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const MEMBER: Principal = { kind: "user", userId: "u-member", role: "member", via: "session" };

describe("item 13: counted nouns", () => {
  it("says 1 library component and 2 library components", () => {
    expect(counted(1, "library components")).toBe("1 library component");
    expect(counted(2, "library components")).toBe("2 library components");
    expect(counted(1, "other users")).toBe("1 other user");
    expect(counted(1, "uploads")).toBe("1 upload");
    expect(countedList({ apps: 3, "saved themes": 1, uploads: 2 })).toBe("3 apps, 1 saved theme and 2 uploads");
    expect(countedList({ "library components": 1 })).toBe("1 library component");
  });
});

describe("item 12: gradients parse into an angle and two stops, or stay custom", () => {
  it("parses the critic's stored gradient and the editor's own", () => {
    expect(parseGradient("linear-gradient(135deg, #1e3c72, #2a5298)")).toEqual({ angle: 135, stops: ["#1e3c72", "#2a5298"] });
    expect(parseGradient("linear-gradient(to bottom, #F3EFE4, #A9C8E4)")).toEqual({ angle: 180, stops: ["#F3EFE4", "#A9C8E4"] });
    expect(parseGradient("linear-gradient(to top right, oklch(0.3 0.05 40), oklch(0.18 0.03 280) 100%)")).toEqual({ angle: 45, stops: ["oklch(0.3 0.05 40)", "oklch(0.18 0.03 280)"] });
    expect(parseGradient("linear-gradient(#000 0%, #fff 100%)")).toEqual({ angle: 180, stops: ["#000", "#fff"] });
    expect(formatGradient({ angle: 135, stops: ["#1e3c72", "#2a5298"] })).toBe("linear-gradient(135deg, #1e3c72, #2a5298)");
  });
  it("leaves three-stop, positioned, radial and conic gradients as custom (never reshaped)", () => {
    for (const g of ["linear-gradient(90deg, #000, #888, #fff)", "linear-gradient(90deg, #000 20%, #fff 80%)", "radial-gradient(#000, #fff)", "conic-gradient(#000, #fff)", "linear-gradient(1turn, #000, #fff)"]) expect(parseGradient(g), g).toBeNull();
  });
});

describe("item 11: canvas text over an image wallpaper", () => {
  it("warns over a busy image, suggests ink or white, and is quiet when text reads", () => {
    // Half white, half black cells: dark text fails on the black half, white text on the white half.
    const half = new Uint8ClampedArray(4 * 100);
    for (let i = 0; i < 100; i++) half.set(i < 50 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    const busy = judge("#15130F", cellsFrom(half, 0));
    expect(busy.low).toBe(true);
    expect(busy.ratio!).toBeLessThan(4.5);
    // A mostly light photo: ink text reads, mid-grey does not and ink is suggested.
    const light = new Uint8ClampedArray(4 * 100);
    for (let i = 0; i < 100; i++) light.set(i < 95 ? [235, 230, 220, 255] : [120, 120, 120, 255], i * 4);
    expect(judge("#15130F", cellsFrom(light, 0)).low).toBe(false);
    const grey = judge("#9A9A9A", cellsFrom(light, 0));
    expect(grey.low).toBe(true);
    expect(grey.suggest).toBe("#15130F");
    expect(grey.suggestRatio!).toBeGreaterThanOrEqual(4.5);
    // The dim darkens the image before measuring: white text over a light photo passes once dimmed 0.6.
    expect(judge("#FFFFFF", cellsFrom(light, 0)).low).toBe(true);
    expect(judge("#FFFFFF", cellsFrom(light, 0.6)).ratio!).toBeGreaterThan(judge("#FFFFFF", cellsFrom(light, 0)).ratio!);
    expect(percentileContrast(colorToRgba("#000000")!, [])).toBe(21);
  });
});

describe("item 8: instance branding", () => {
  it("every palette accent keeps the shell's contrast (fill text and ink on paper or dark ground)", () => {
    const paper = colorToRgba("#F3EFE4")!;
    const ground = colorToRgba("#15130F")!;
    for (const id of BRAND_ACCENT_IDS) {
      const a = BRAND_ACCENTS[id];
      expect(contrastRatio(colorToRgba(a.light.fg)!, colorToRgba(a.light.accent)!), `${id} text on fill`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colorToRgba(a.light.ink)!, paper), `${id} ink on paper`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colorToRgba(a.dark.ink)!, ground), `${id} ink on dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("stores an accent from the palette and uploaded images only; the CSS carries only palette values", async () => {
    vi.resetModules();
    useInstance(freshDataDir());
    const store = await import("@/features/settings/store");
    const uploads = await import("@/features/uploads/store");
    const branding = await import("@/features/settings/branding");
    expect(branding.brandingCss()).toBe("");
    expect(() => store.updateInstanceSettings(MEMBER, { brandAccent: "sky" })).toThrow(/Only the owner/);
    expect(() => store.updateInstanceSettings(OWNER, { brandAccent: "#ff0000" })).toThrow(/Pick one of the shell's accents/);
    expect(() => store.updateInstanceSettings(OWNER, { brandAccent: "sky;}body{display:none" })).toThrow();
    expect(() => store.updateInstanceSettings(OWNER, { brandLogo: "https://evil.example/x.png" })).toThrow(/upload an image/);
    expect(() => store.updateInstanceSettings(OWNER, { brandLogo: "/uploads/aaaaaaaaaaaaaaaaaaaa.png" })).toThrow(/not an image on this Atrium/);
    const logo = uploads.saveUpload(OWNER, PNG, "logo.png", "image");
    const font = Buffer.alloc(100, 1);
    font.write("wOF2", 0, "ascii");
    const woff = uploads.saveUpload(OWNER, font, "f.woff2", "font");
    expect(() => store.updateInstanceSettings(OWNER, { brandFavicon: woff.path })).toThrow();
    const r = store.updateInstanceSettings(OWNER, { brandAccent: "sky", brandLogo: logo.path, brandFavicon: logo.path, signInWallpaper: logo.path });
    expect(r.changed.sort()).toEqual(["brandAccent", "brandFavicon", "brandLogo", "signInWallpaper"]);
    const css = branding.brandingCss();
    expect(css).toContain(`--accent:${BRAND_ACCENTS.sky.light.accent}`);
    expect(css).toContain(`:root[data-theme=dark]{--accent:${BRAND_ACCENTS.sky.dark.accent}`);
    expect(css).not.toMatch(/["'<>]/);
    expect(css.replace(/#[0-9a-f]{6}/g, "").replace(/--accent(-hi|-fg|-ink)?:;/g, "")).toBe(":root{}@media (prefers-color-scheme: dark){:root:not([data-theme=light]){}}:root[data-theme=dark]{}");
    expect(branding.brandUrl("logo")).toMatch(/^\/uploads\/brand\/logo\?v=[a-z0-9]{8}$/);
    expect(branding.brandFile("favicon")).toBe(logo.path.slice("/uploads/".length));
    // Clearing restores Atrium's own look (null removes the key).
    const cleared = store.updateInstanceSettings(OWNER, { brandAccent: null, brandLogo: null });
    expect(cleared.settings.brandAccent).toBeNull();
    expect(cleared.settings.brandLogo).toBeNull();
    expect(branding.brandingCss()).toBe("");
    const { sqlite } = await import("@/core/db");
    const audit = sqlite().prepare(`SELECT detail FROM audit_log WHERE event = 'settings.updated' ORDER BY rowid DESC LIMIT 1`).get() as { detail: string };
    expect(JSON.parse(audit.detail).keys.sort()).toEqual(["brandAccent", "brandLogo"]);
  });
});
