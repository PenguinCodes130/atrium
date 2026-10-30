// Wave 2.10b builder S (F10, F12): saving and revalidating themes with the new fonts and materials.
import { describe, expect, it } from "vitest";
import { controlRoom } from "@/features/shell/theme";
import { revalidateTheme } from "@/features/themes/revalidate";
import { strictThemeIssues } from "@/features/themes/fields";

const t = controlRoom.tokens;
const withTokens = (tokens: object) => ({ ...controlRoom, id: "w210b-e2e", tokens: { ...t, ...tokens } });

describe("F10 fonts on save", () => {
  it("accepts any built-in family, including the self-hosted ones", () => {
    expect(strictThemeIssues(withTokens({ type: { ...t.type, display: "Lora", body: "Nunito", mono: "Fira Code" } }))).toEqual([]);
  });
  it("still refuses a family that is neither built in nor uploaded", () => {
    expect(strictThemeIssues(withTokens({ type: { ...t.type, display: "Comic Sans MS" } })).map((i) => i.path)).toEqual(["tokens.type.display"]);
  });
});

describe("F12 materials on save", () => {
  it("keeps a gradient surface and a frosted nav", () => {
    const raw = withTokens({ surface: { ...t.surface, material: "gradient", gradient: ["#FFFFFF", "#E8E2D2"] }, chrome: { ...t.chrome, material: "glass", opacity: 0.4, blurPx: 16 } });
    expect(strictThemeIssues(raw)).toEqual([]);
    const r = revalidateTheme(raw);
    expect(r.theme.tokens.surface).toMatchObject({ material: "gradient", gradient: ["#FFFFFF", "#E8E2D2"] });
    expect(r.theme.tokens.chrome).toMatchObject({ material: "glass", opacity: 0.4, blurPx: 16 });
  });
  it("a theme without nav material stays without it (reads as solid)", () => {
    const r = revalidateTheme(withTokens({}));
    expect(r.theme.tokens.chrome.material).toBeUndefined();
    expect(r.replaced).toBe(0);
  });
  it("refuses a bad material, an out-of-range nav opacity and a gradient that is not two colours", () => {
    const raw = withTokens({ surface: { ...t.surface, material: "metal", gradient: ["red;}", "#fff"] }, chrome: { ...t.chrome, material: "chrome", opacity: 0.1 } });
    expect(strictThemeIssues(raw).map((i) => i.path).sort()).toEqual(["tokens.chrome.material", "tokens.chrome.opacity", "tokens.surface.gradient", "tokens.surface.material"]);
  });
});
