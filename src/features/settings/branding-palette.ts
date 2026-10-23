// The instance accents an owner can choose (settings gauntlet w2-r1 item 8): the shell's skylight gold
// and four siblings drawn to the same rules (design v4 "Palette"): a light fill that carries ink text at
// 4.5:1 or more, a pale hover, and an "ink" shade readable as text on paper (light) or on the dark ground.
// Pure data, used by the server (CSS) and the settings screen (swatches). Contrast is pinned by a unit test.
export const BRAND_ACCENTS = {
  gold: { label: "Skylight gold", light: { accent: "#e9b949", hi: "#f6d98b", fg: "#15130f", ink: "#8e6416" }, dark: { accent: "#e9b949", hi: "#f6d98b", fg: "#15130f", ink: "#f0c962" } },
  sky: { label: "Morning sky", light: { accent: "#8fb8de", hi: "#c9ddef", fg: "#15130f", ink: "#2d5a85" }, dark: { accent: "#8fb8de", hi: "#c9ddef", fg: "#15130f", ink: "#9cc3e6" } },
  sage: { label: "Sage", light: { accent: "#9cc5a1", hi: "#cfe4d1", fg: "#15130f", ink: "#2f6a3e" }, dark: { accent: "#9cc5a1", hi: "#cfe4d1", fg: "#15130f", ink: "#8fd19d" } },
  coral: { label: "Coral", light: { accent: "#f0a07a", hi: "#f8d0bc", fg: "#15130f", ink: "#9a4524" }, dark: { accent: "#f0a07a", hi: "#f8d0bc", fg: "#15130f", ink: "#f3a585" } },
  lilac: { label: "Lilac", light: { accent: "#c4b0e8", hi: "#e2d8f4", fg: "#15130f", ink: "#5d4596" }, dark: { accent: "#c4b0e8", hi: "#e2d8f4", fg: "#15130f", ink: "#c9b6f0" } },
} as const;

export type BrandAccentId = keyof typeof BRAND_ACCENTS;
export const BRAND_ACCENT_IDS = Object.keys(BRAND_ACCENTS) as BrandAccentId[];
