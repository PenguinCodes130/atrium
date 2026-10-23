// Field rules for the theme editor and the save API (settings spec 3.3 "Values"): every field accepts
// only the design v4 section 2 ranges and choices, and out-of-range input is refused at the field with
// the range named. Pure: used by the browser editor and by the server before saving.
import type { Theme } from "@/core/contracts";
import { revalidateTheme } from "./revalidate";

/** What each numeric or choice field allows, in words, keyed by the last path segment. */
export const RANGE_TEXT: Record<string, string> = {
  dim: "between 0 and 0.6",
  grain: "between 0 and 0.3",
  blurPx: "0, 8, 16 or 32 px for the wallpaper; 0 to 48 px for glass",
  opacity: "between 0.3 and 1",
  widthPx: "0, 1 or 2 px",
  shadowOffsetPx: "between 0 and 12 px",
  scale: "between 0.85 and 1.3",
  headingTracking: "between -0.06 and 0.02 em",
  headingWeight: "400, 500, 600, 700 or 800",
  radiusPx: "between 0 and 32 px",
  controlRadiusPx: "between 0 and 999 px",
  gapPx: "between 4 and 40 px",
  padPx: "between 8 and 40 px",
};

export const NUMBER_FIELDS: Record<string, { min: number; max: number; step: number; label: string }> = {
  "wallpaper.dim": { min: 0, max: 0.6, step: 0.05, label: "Wallpaper dim" },
  "wallpaper.grain": { min: 0, max: 0.3, step: 0.01, label: "Grain" },
  "surface.opacity": { min: 0.3, max: 1, step: 0.01, label: "Surface opacity" },
  "surface.blurPx": { min: 0, max: 48, step: 1, label: "Glass blur (px)" },
  "surface.shadowOffsetPx": { min: 0, max: 12, step: 1, label: "Hard shadow offset (px)" },
  "type.scale": { min: 0.85, max: 1.3, step: 0.01, label: "Type scale" },
  "type.headingTracking": { min: -0.06, max: 0.02, step: 0.005, label: "Heading tracking (em)" },
  "shape.radiusPx": { min: 0, max: 32, step: 1, label: "Radius (px)" },
  "shape.controlRadiusPx": { min: 0, max: 999, step: 1, label: "Control radius (px)" },
  "space.gapPx": { min: 4, max: 40, step: 1, label: "Gap (px)" },
  "space.padPx": { min: 8, max: 40, step: 1, label: "Padding (px)" },
};

/** The refusal for a number field, or null when it is allowed. */
export function numberFieldError(path: string, value: number): string | null {
  const f = NUMBER_FIELDS[path];
  if (!f) return null;
  if (!Number.isFinite(value)) return `${f.label} must be a number ${RANGE_TEXT[path.split(".").pop()!] ?? `between ${f.min} and ${f.max}`}.`;
  if (value < f.min || value > f.max) return `${f.label} must be between ${f.min} and ${f.max}.`;
  return null;
}

export type FieldIssue = { path: string; message: string };

/** Human message for a refused path. */
export function issueMessage(path: string): string {
  const leaf = path.split(".").pop() ?? path;
  const key = path.replace(/^(tokens|dark)\./, "");
  const nf = NUMBER_FIELDS[key];
  if (nf) return `${nf.label} must be between ${nf.min} and ${nf.max}.`;
  if (RANGE_TEXT[leaf]) return `${path} must be ${RANGE_TEXT[leaf]}.`;
  if (/color|Text|surface$|accent|line|ok$|warn$|bad$|info$|background|activeFill/.test(leaf) || path.includes(".color.")) return `${path} must be an oklch() or #hex colour.`;
  if (/display|body|mono/.test(leaf)) return `${path} must be one of the ten built-in font families or an uploaded font.`;
  if (path.startsWith("fonts")) return "Fonts must be uploaded woff2 files (at most 2 MB each), with a family name, a weight such as 400 and a style.";
  if (leaf === "value") return "That wallpaper value is not allowed: a colour, a gradient, an /uploads/ image, or two sky colours.";
  if (leaf === "customCss") return "Custom CSS is limited to 64 KB.";
  if (leaf === "name") return "Give the theme a name.";
  return `${path} is not an allowed value.`;
}

/**
 * Strict check for a theme a person is saving: every field that revalidation would replace or clamp is
 * refused instead, with its range named. An empty list means the theme can be saved as it is.
 */
export function strictThemeIssues(raw: unknown): FieldIssue[] {
  const { fields } = revalidateTheme(raw);
  return fields.filter((f) => f !== "id").map((path) => ({ path, message: issueMessage(path) }));
}

export type { Theme };
