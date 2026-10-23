// Time-of-day light drift (design v4 section 4), React-free for unit tests. A theme option (on for
// Control Room and Daylight). Bands (local time): 05:00 cool morning #A9C8E4 at 0.14, 09:00 none,
// 16:00 golden hour #E9B949 at 0.16, 19:30 low night #8E6416 at 0.10. Changes blend over the 30
// minutes after each boundary; recomputed every 5 minutes. Only ever over the app canvas.

export type Rgb = { r: number; g: number; b: number };
export type DriftBand = { name: "morning" | "day" | "golden" | "night"; startMin: number; color: string | null; strength: number };

export const DRIFT_BANDS: DriftBand[] = [
  { name: "morning", startMin: 5 * 60, color: "#A9C8E4", strength: 0.14 },
  { name: "day", startMin: 9 * 60, color: null, strength: 0 },
  { name: "golden", startMin: 16 * 60, color: "#E9B949", strength: 0.16 },
  { name: "night", startMin: 19 * 60 + 30, color: "#8E6416", strength: 0.1 },
];
export const DRIFT_BLEND_MIN = 30;
export const DRIFT_RECOMPUTE_MS = 5 * 60 * 1000;

export type DriftOverlay = { band: DriftBand["name"]; color: string | null; strength: number; css: string | null };

function bandIndexAt(minute: number): number {
  for (let i = DRIFT_BANDS.length - 1; i >= 0; i--) if (minute >= DRIFT_BANDS[i]!.startMin) return i;
  return DRIFT_BANDS.length - 1; // before 05:00 is still night
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** The overlay for a local time. */
export function driftAt(date: Date): DriftOverlay {
  const minute = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const i = bandIndexAt(minute);
  const band = DRIFT_BANDS[i]!;
  const prev = DRIFT_BANDS[(i - 1 + DRIFT_BANDS.length) % DRIFT_BANDS.length]!;
  const since = (minute - band.startMin + 1440) % 1440;
  const t = Math.min(1, since / DRIFT_BLEND_MIN);
  const strength = prev.strength + (band.strength - prev.strength) * t;
  let color: string | null;
  if (!band.color) color = prev.color;
  else if (!prev.color || t >= 1) color = band.color;
  else {
    const a = hexToRgb(prev.color);
    const b = hexToRgb(band.color);
    color = rgbToHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  }
  const rounded = Math.round(strength * 1000) / 1000;
  return { band: band.name, color, strength: rounded, css: color && rounded > 0 ? color : null };
}
