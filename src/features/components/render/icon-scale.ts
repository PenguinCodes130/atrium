// Wave 2.10b F6 (spec section 9): an icon fills its box keeping its shape, at a Scale of 25 to 100% of the
// box's shorter side. The px size field is gone; a stored px size (older icons) keeps drawing that size
// until Scale is set, and the inspector shows it as the Scale that draws the same size.

export const SCALE_MIN = 25;
export const SCALE_MAX = 100;
/** New icons and older "fill its box" icons: half the box (the inserted 48px box holds a 24px icon). */
export const SCALE_DEFAULT = 50;
/** Outside a sized box (in a stack or a card), 100% is this many px. */
export const FREE_BOX_PX = 48;

export type IconSize = { kind: "scale"; scale: number } | { kind: "px"; px: number };

export const clampScale = (n: number) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n)));

/** How an icon's props size it: a Scale, or (older icons) a stored px size. */
export function iconSize(props: Record<string, unknown>): IconSize {
  if (typeof props.scale === "number" && Number.isFinite(props.scale)) return { kind: "scale", scale: clampScale(props.scale) };
  if (props.fill !== true && typeof props.size === "number" && Number.isFinite(props.size)) return { kind: "px", px: props.size };
  return { kind: "scale", scale: SCALE_DEFAULT };
}

/** The Scale that draws a stored px size in a box whose shorter side is `side` px. */
export function scaleForPx(px: number, side: number): number {
  return side > 0 ? clampScale((px / side) * 100) : SCALE_DEFAULT;
}

/** The CSS custom properties the icon's root sets (components.css .atr-icon reads them). */
export function iconSizeVars(size: IconSize): Record<string, string> {
  if (size.kind === "px") return { "--atr-icon-cell": `min(${size.px}px, min(100cqw, 100cqh))`, "--atr-icon-free": `${size.px}px` };
  const k = size.scale / 100;
  return { "--atr-icon-cell": `calc(min(100cqw, 100cqh) * ${k})`, "--atr-icon-free": `${Math.round(FREE_BOX_PX * k)}px` };
}
