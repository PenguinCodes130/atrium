// The Picture panel's maths (media layout spec 3.1, Amendment 8 A8.7), kept pure so it is unit tested:
// shapes to box heights, quarter turns that respect flips, filter presets and what Reset clears.
import type { MediaFilters } from "../render/content";

export const SHAPES = ["original", "16:9", "4:3", "1:1", "3:4", "9:16", "fill"] as const;
export type Shape = (typeof SHAPES)[number];

const RATIO: Record<Exclude<Shape, "original" | "fill">, number> = { "16:9": 9 / 16, "4:3": 3 / 4, "1:1": 1, "3:4": 4 / 3, "9:16": 16 / 9 };

/**
 * A shape's height over width for the box: a fixed ratio, the file's own (swapped when it lies on its
 * side), or null for "fill" (the box keeps the size it was given) and an original whose size is unknown.
 */
export function shapeRatio(shape: unknown, natural: { w: number; h: number } | null, rotate: unknown): number | null {
  if (shape === "original") {
    if (!natural || !(natural.w > 0) || !(natural.h > 0)) return null;
    const side = rotate === 90 || rotate === 270;
    return side ? natural.w / natural.h : natural.h / natural.w;
  }
  return typeof shape === "string" && shape in RATIO ? RATIO[shape as keyof typeof RATIO] : null;
}

/**
 * The picture height (px, 16 to 1200 as the schema allows) and the box rows (8px each) for a box `width`
 * px wide with the given ratio. `extra` is what the box holds besides the picture: the cell's gap under it
 * and a caption below. Rows round to the nearest row, so the picture is within 4px of width times ratio.
 */
export function boxForShape(width: number, ratio: number, extra = 0): { height: number; rows: number } {
  const height = Math.min(1200, Math.max(16, Math.round(width * ratio)));
  return { height, rows: Math.max(1, Math.round((height + extra) / 8)) };
}

/**
 * A quarter turn. Flips are drawn after the turn (they mirror what is on screen), so with an odd number
 * of flips a turn reads the other way round: it is reversed so "Rotate right" always turns clockwise.
 */
export function rotateBy(rotate: unknown, dir: "left" | "right", flipX: unknown, flipY: unknown): 0 | 90 | 180 | 270 {
  const cur = rotate === 90 || rotate === 180 || rotate === 270 ? rotate : 0;
  let d = dir === "right" ? 90 : -90;
  if ((flipX === true) !== (flipY === true)) d = -d;
  return (((cur + d) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
}

export type FilterKey = keyof MediaFilters;
/** The filter sliders in the panel's order, each with its range and the value that changes nothing. */
export const FILTER_SLIDERS: { key: FilterKey; label: string; min: number; max: number; step: number; none: number; unit: string }[] = [
  { key: "brightness", label: "Brightness", min: 0, max: 200, step: 1, none: 100, unit: "%" },
  { key: "contrast", label: "Contrast", min: 0, max: 200, step: 1, none: 100, unit: "%" },
  { key: "saturate", label: "Saturation", min: 0, max: 200, step: 1, none: 100, unit: "%" },
  { key: "grayscale", label: "Grey", min: 0, max: 100, step: 1, none: 0, unit: "%" },
  { key: "sepia", label: "Sepia", min: 0, max: 100, step: 1, none: 0, unit: "%" },
  { key: "blur", label: "Blur", min: 0, max: 20, step: 0.5, none: 0, unit: " px" },
];

/**
 * The presets (spec 3.1). The props carry no hue filter (A8.7), so Warm leans on sepia and Cool is a
 * crisper, less saturated look rather than a blue tint.
 */
export const FILTER_PRESETS: { id: string; label: string; filters: MediaFilters }[] = [
  { id: "none", label: "None", filters: {} },
  { id: "vivid", label: "Vivid", filters: { saturate: 150, contrast: 115 } },
  { id: "muted", label: "Muted", filters: { saturate: 55, contrast: 90, brightness: 105 } },
  { id: "bw", label: "Black and white", filters: { grayscale: 100, contrast: 110 } },
  { id: "warm", label: "Warm", filters: { sepia: 35, saturate: 125, brightness: 104 } },
  { id: "cool", label: "Cool", filters: { saturate: 75, contrast: 108, brightness: 102 } },
];

/** Filters with every value that changes nothing left out. */
export function cleanFilters(f: MediaFilters | undefined): MediaFilters {
  const out: MediaFilters = {};
  for (const s of FILTER_SLIDERS) {
    const v = f?.[s.key];
    if (typeof v === "number" && Number.isFinite(v) && v !== s.none) out[s.key] = v;
  }
  return out;
}

/** Which preset a set of filters is, or null for a mix of the person's own. */
export function presetOf(f: MediaFilters | undefined): string | null {
  const c = cleanFilters(f);
  const key = (x: MediaFilters) => JSON.stringify(FILTER_SLIDERS.map((s) => x[s.key] ?? null));
  return FILTER_PRESETS.find((p) => key(cleanFilters(p.filters)) === key(c))?.id ?? null;
}

/** The merge patch that replaces a node's filters with `next` (keys it leaves out are removed). */
export function filtersPatch(next: MediaFilters): Record<FilterKey, number | null> | null {
  const c = cleanFilters(next);
  if (!Object.keys(c).length) return null;
  return Object.fromEntries(FILTER_SLIDERS.map((s) => [s.key, c[s.key] ?? null])) as Record<FilterKey, number | null>;
}

/** What Reset clears: the turn, flips, tilt, zoom, focal point and filters (spec 3.1). */
export const RESET_KEYS = ["rotate", "flipX", "flipY", "straighten", "zoom", "focusX", "focusY", "filters"] as const;

/** Whether Reset has anything to clear. */
export function lookIsSet(props: Record<string, unknown>): boolean {
  const r = props.rotate;
  if (r === 90 || r === 180 || r === 270) return true;
  if (props.flipX === true || props.flipY === true) return true;
  if (typeof props.straighten === "number" && props.straighten !== 0) return true;
  if (typeof props.zoom === "number" && props.zoom !== 1) return true;
  if (typeof props.focusX === "number" && props.focusX !== 50) return true;
  if (typeof props.focusY === "number" && props.focusY !== 50) return true;
  return Object.keys(cleanFilters(props.filters as MediaFilters | undefined)).length > 0;
}

/** A focal point from a pointer position inside a thumbnail rectangle, in whole percent, clamped. */
export function focalFrom(x: number, y: number, rect: { left: number; top: number; width: number; height: number }): { focusX: number; focusY: number } {
  const fx = rect.width > 0 ? ((x - rect.left) / rect.width) * 100 : 50;
  const fy = rect.height > 0 ? ((y - rect.top) / rect.height) * 100 : 50;
  return { focusX: Math.round(Math.min(100, Math.max(0, fx))), focusY: Math.round(Math.min(100, Math.max(0, fy))) };
}

/** Whether an address may be a click target: http or https only (A8.7). */
export const isWebAddress = (s: string) => /^https?:\/\/[^\s]+$/i.test(s.trim()) && s.trim().length <= 2000;
