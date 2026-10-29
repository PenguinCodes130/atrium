"use client";
// The app canvas (design v4 section 2): the only place a user theme, custom CSS and light drift apply.
// app-builder renders one per app view; settings resolves which Theme it gets.
//
//   <Canvas theme={dusk} customCss={scoped}>   // scoped = scopeCustomCss(raw) on the server
//     <CanvasGrid> <CanvasSurface>...</CanvasSurface> </CanvasGrid>
//   </Canvas>
//
// Structure (gauntlet r2 customisation H1, Fix 1):
//   [data-atrium-canvas-frame]   shell-owned clipping frame (overflow: clip, contain: paint). Custom
//                                CSS can never select it: every scoped selector starts at the root.
//     [data-atrium-canvas]       the scope root: theme rule, tone, wallpaper, grain, dim, drift, content.
// The guard layer pins the root's own box (no margins, outline, shadow, filter, reflection, oversize),
// the scoper drops those properties on root selectors, and the frame clips anything left over, so app
// CSS cannot repaint the sky band or add horizontal scroll to the shell.
//
// The theme's custom properties are written as the canvas's own rule (themeCanvasCss) in the
// atrium-theme layer, keyed by a per-canvas id, with a dark set under the viewer's dark preference for
// `mode: "auto"`. The root's `data-canvas-tone` (light, dark or auto) selects the shell roles that
// shell primitives placed on the canvas read (styles/canvas-theme.css).
import { createContext, useContext, useId, useMemo, useSyncExternalStore, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { controlRoom, resolveTokens, themeCanvasCss, type CanvasTone, type Theme, type ThemeTokens } from "./theme";
import type { ScopedCss } from "./custom-css";
import { LightDrift } from "./light-drift";

const ToneContext = createContext<CanvasTone | null>(null);

/** The tone of the canvas around this component (null outside a canvas, or when it follows the viewer). */
export function useCanvasTone(): CanvasTone | null {
  return useContext(ToneContext);
}

// Wave 2.10 B6 (A11.5): the viewer's scheme, as the canvas CSS reads it: Atrium forced dark, or the
// system's dark preference unless Atrium is forced light. "light" on the server and while hydrating.
function subscribeScheme(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    mq.removeEventListener("change", cb);
    mo.disconnect();
  };
}
function viewerScheme(): CanvasTone {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return "dark";
  if (forced === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
export function useViewerScheme(): CanvasTone {
  return useSyncExternalStore(subscribeScheme, viewerScheme, () => "light");
}

/** The canvas switches (material, shadow, title bars, entrance, nav style) for one token set. */
function canvasSwitches(t: ThemeTokens, suffix = ""): Record<string, string> {
  return {
    [`data-canvas-material${suffix}`]: t.surface.material,
    [`data-canvas-shadow${suffix}`]: t.surface.shadow,
    [`data-canvas-titlebars${suffix}`]: t.surface.titleBars ? "on" : "off",
    [`data-canvas-enter${suffix}`]: t.motion.enter,
    [`data-canvas-chrome${suffix}`]: t.chrome.style,
    [`data-canvas-chrome-material${suffix}`]: t.chrome.material ?? "solid",
  };
}

export type CanvasProps = {
  theme?: Theme;
  /** Custom CSS that has been through scopeCustomCss() on the server. Raw strings are not accepted. */
  customCss?: ScopedCss;
  /** Optional per-page scope id: also set it as `scope` in scopeCustomCss() for page-only CSS. */
  scope?: string;
  /** A fixed time for the drift overlay (previews and tests). */
  driftNow?: Date | null;
  /** Classes for the frame (size and placement); the root fills it. */
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "className" | "style">;

export function Canvas({ theme = controlRoom, customCss, scope, driftNow, className, children, ...rest }: CanvasProps) {
  const key = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const css = useMemo(() => themeCanvasCss(theme, key), [theme, key]);
  const tone = theme.mode;
  // B6: an auto theme writes the switches of the scheme the viewer has, and both sets as
  // data-canvas-*-light / -dark, so nothing is read from the light set while the viewer is dark.
  const scheme = useViewerScheme();
  const t = tone === "auto" ? resolveTokens(theme, scheme) : theme.tokens;
  const both = tone === "auto" ? { ...canvasSwitches(theme.tokens, "-light"), ...canvasSwitches(resolveTokens(theme, "dark"), "-dark") } : {};
  return (
    <ToneContext.Provider value={tone === "auto" ? null : tone}>
      <div data-atrium-canvas-frame className={`min-h-[calc(100dvh-var(--topbar-height))] ${className ?? ""}`}>
        <div
          data-atrium-canvas
          data-canvas-key={key}
          data-canvas-scope={scope}
          data-canvas-tone={tone}
          data-canvas-scheme={tone === "auto" ? scheme : tone}
          data-canvas-wallpaper-kind={t.wallpaper.kind}
          data-canvas-density={t.space.density === "compact" ? "compact" : "comfortable"}
          {...canvasSwitches(t)}
          {...both}
          {...rest}
        >
          {css ? <style data-canvas-theme>{css}</style> : null}
          <div aria-hidden data-canvas-wallpaper>
            {t.wallpaper.kind === "sky" ? <div data-canvas-sky data-sky-drift /> : null}
          </div>
          <div aria-hidden data-canvas-grain />
          <div aria-hidden data-canvas-dim />
          {t.motion.lightDrift && <LightDrift enabled now={driftNow ?? undefined} />}
          <div data-canvas-content>{children}</div>
          {customCss ? <style data-custom-css>{customCss}</style> : null}
        </div>
      </div>
    </ToneContext.Provider>
  );
}

/** A component frame on the canvas: theme surface, radius, border, shadow and padding. */
export function CanvasSurface({ flush = false, className, ...rest }: { flush?: boolean } & ComponentPropsWithoutRef<"div">) {
  return <div data-canvas-surface className={`canvas-surface${flush ? " canvas-surface-flush" : ""}${className ? ` ${className}` : ""}`} {...rest} />;
}

/** The component grid gap follows the theme (`gapPx`). Layout (columns, placement) is the caller's. */
export function CanvasGrid({ className, ...rest }: ComponentPropsWithoutRef<"div">) {
  return <div data-canvas-grid className={`canvas-grid${className ? ` ${className}` : ""}`} {...rest} />;
}
