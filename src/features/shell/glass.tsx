// Surfaces (design v4 "Glass Materials" and "Windows").
//
// FloatGlass: the one glass material left, `--glass-float` (blur 18px, fill #FBF9F3 or #1D1A15 at 0.86,
// 1px strong border, 3px hard shadow). Only for the app switcher and its sheet, the draft preview bar,
// the control confirm dialog over an app, and toasts over an app (architecture v3 amendment A1.6).
// It turns opaque with reduce transparency (system or switch) or without blur support (globals.css).
//
// Glass (deprecated, v3 name): kept so screens built on v3 keep rendering while they move to
// <Window>. It now draws a square paper window body (raised paper, 1px strong border, the hard window
// shadow; no blur). Pass `title` to get a full <Window> with a title bar.
import { createElement, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from "react";
import { Window } from "./window";

type FloatGlassProps<T extends ElementType> = { as?: T } & Omit<ComponentPropsWithoutRef<T>, "as">;

export function FloatGlass<T extends ElementType = "div">({ as, className, ...rest }: FloatGlassProps<T>) {
  return createElement(as ?? "div", { "data-float-glass": "", className: `glass-float${className ? ` ${className}` : ""}`, ...rest });
}

/** @deprecated v3 materials; all three now draw the same paper window body. */
export type GlassMaterial = "thin" | "regular" | "thick";

/** @deprecated Use <Window> (or the `window` utility). */
export function glassClass(material: GlassMaterial, elevation?: 2 | 3 | 4): string {
  return `glass-${material}${elevation ? ` elevated-${elevation}` : ""}`;
}

type GlassProps<T extends ElementType> = {
  as?: T;
  material?: GlassMaterial;
  elevation?: 2 | 3 | 4;
  /** v4: give the surface a window title bar (a path such as `integrations / proxmox`). */
  title?: ReactNode;
  status?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "title">;

/** @deprecated Use <Window>. Renders a v4 paper window body; with `title`, a full window. */
export function Glass<T extends ElementType = "div">({ as, material = "regular", elevation, title, status, className, children, ...rest }: GlassProps<T>) {
  if (title !== undefined && title !== null) {
    const W = Window as unknown as (p: Record<string, unknown>) => ReactNode;
    return (
      <W as={as ?? "div"} title={title} status={status} small={elevation === 2} padded={false} className={className} data-glass={material} {...(rest as object)}>
        {children as ReactNode}
      </W>
    );
  }
  const shadow = elevation === 2 ? "shadow-window-sm" : elevation === 4 ? "shadow-overlay" : "shadow-window";
  return createElement(as ?? "div", { "data-glass": material, className: `glass-${material} ${shadow}${className ? ` ${className}` : ""}`, ...rest }, children);
}
