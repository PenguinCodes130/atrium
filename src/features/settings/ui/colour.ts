// Colour swatches for the theme editor (settings gauntlet w2-r2 item 3). A native colour picker only
// understands #rrggbb, so an oklch() value used to open (and paint) as black. These helpers give the
// picker the sRGB equivalent of any theme colour, and write a picked colour back in the format the
// author chose: oklch() stays oklch() (alpha kept), hex stays hex (alpha digits kept).
import { colorToRgba, toOklch } from "@/features/shell/theme";

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const OKLCH_START = /^oklch\(/i;

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");

/** The #rrggbb sRGB equivalent of a theme colour (oklch is gamut-clipped), or null when it is not one. */
export function swatchHex(value: string): string | null {
  const c = colorToRgba(value);
  return c ? `#${byte(c.r)}${byte(c.g)}${byte(c.b)}` : null;
}

/** The colour's alpha (1 when opaque or not a colour). */
export function alphaOf(value: string): number {
  return colorToRgba(value)?.a ?? 1;
}

const round = (n: number, places: number) => String(+n.toFixed(places));

/**
 * A colour picked in the native picker (#rrggbb), written in the author's format: an oklch() value
 * stays oklch() with its alpha, a hex value stays hex with its alpha digits, anything else becomes hex.
 */
export function fromPicker(picked: string, current: string): string {
  const hex = picked.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return current;
  const cur = current.trim();
  if (OKLCH_START.test(cur)) {
    const o = toOklch(hex);
    if (!o) return hex;
    const a = alphaOf(cur);
    const h = o.c < 0.0005 ? 0 : o.h;
    return `oklch(${round(o.l, 3)} ${round(o.c, 3)} ${round(h, 1)}${a < 1 ? ` / ${round(a, 3)}` : ""})`;
  }
  if (HEX_RE.test(cur)) {
    const body = cur.slice(1);
    const alpha = body.length === 8 ? body.slice(6) : body.length === 4 ? body[3]! + body[3]! : "";
    return `${hex}${alpha.toLowerCase()}`;
  }
  return hex;
}
