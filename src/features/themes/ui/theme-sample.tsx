"use client";
// The small live sample canvas on the Themes screen and in the editor (settings spec 3.3), drawn in the
// theme through app-shell's Canvas. Custom CSS arrives already scoped by the server (canvasThemeCss with
// this sample's scope id).
//
// Wave 2.10a (operator try-out B3 to B6):
// - B5: the nav is the app viewer's own nav markup (SampleNav below matches AppChrome in
//   src/features/builder/app-frame.tsx; a unit test renders both and compares them), with real links,
//   so each nav item style draws exactly as it does in an app.
// - B6: `scheme` draws the theme as a light or a dark viewer sees it (an auto theme's real dark set),
//   whatever the editor's own appearance. Without it the sample follows the viewer as an app does.
// Wave 2.10a round 2 (gauntlet r1 item 3):
// - The cards, title bars and controls use the components' own classes (.atr-card, .atr-titlebar,
//   .atr-button, .atr-toggle, .atr-select inside .atr-render-root), so title bars, control heights at
//   both densities and 44 px touch sizes are exactly the real app's.
// - With no `height` the sample grows to its content, so nothing is ever cut off; the Themes list
//   passes a height for its cards, which keeps them a fixed thumbnail.
// - Only the page part is inert. The nav takes the pointer (hover fills show) but no focus and no
//   navigation: the whole canvas is aria-hidden and the links get tabIndex -1.
// The sample is a picture of the theme, never a second set of controls on the page.
import { useEffect, useRef, type MouseEvent } from "react";
import type { Theme } from "@/core/contracts";
import { Canvas, DoorGlyph, type ScopedCss } from "@/features/shell";
import { themeForScheme, type CanvasTone } from "@/features/shell/theme";
// The components' own stylesheet (the same file the app viewer loads through RenderNode), so the
// sample's .atr-* cards, title bars and controls draw exactly as in an app.
import "@/features/components/components.css";

export const SAMPLE_TITLE = "Lab";
export const SAMPLE_PAGES = [
  { slug: "home", title: "Home" },
  { slug: "rack", title: "Rack" },
  { slug: "power", title: "Power" },
] as const;

/**
 * The app viewer's top bar nav (AppChrome, layout "topbar", including app-builder's round 2 one-line row
 * [data-app-nav-items]), with the sample's three pages. w210a-sample-nav.test.ts compares the two.
 */
export function SampleNav({ title = SAMPLE_TITLE, current = "home" }: { title?: string; current?: string }) {
  return (
    <nav data-canvas-nav data-app-chrome="topbar" aria-label={`${title} pages`} className="flex flex-nowrap items-center gap-2 px-4 max-sm:gap-1 max-sm:px-3 py-3">
      <span className="mr-4 flex min-w-0 max-w-[45%] flex-none items-center gap-2 type-title-3 max-sm:mr-2" data-app-title>
        <span className="min-w-0 truncate">{title}</span>
      </span>
      <div className="atr-nav-items flex min-w-0 flex-1 flex-nowrap items-[inherit] gap-2 self-stretch overflow-x-auto [scrollbar-width:none] max-sm:gap-1 [&::-webkit-scrollbar]:hidden [&>a]:flex-none [&>a]:whitespace-nowrap [&>a:focus-visible]:outline-offset-[-2px]" data-app-nav-items>
        {SAMPLE_PAGES.map((p) => (
          <a key={p.slug} href={`#${p.slug}`} aria-current={p.slug === current ? "page" : undefined} className="inline-flex min-h-9 items-center px-3 type-label touch:min-h-11" data-app-nav-item={p.slug}>
            {p.title}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** The bar a card carries when the theme has title bars on (components' NodeTitleBar markup). */
function SampleTitleBar({ text }: { text: string }) {
  return (
    <div className="atr-titlebar" data-slot="titlebar" aria-hidden>
      <DoorGlyph lit />
      <span className="atr-titlebar-path">{text}</span>
      <span className="atr-titlebar-status" data-tone="ok">
        <span className="atr-titlebar-dot" />
        live
      </span>
    </div>
  );
}

const stop = (e: MouseEvent) => e.preventDefault();

export function ThemeSample({ theme, scopedCss, scope, height, label, scheme }: { theme: Theme; scopedCss?: string; scope?: string; height?: number; label?: string; scheme?: CanvasTone }) {
  const shown = scheme ? themeForScheme(theme, scheme) : theme;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>("a, button, select").forEach((el) => { el.tabIndex = -1; });
  });
  return (
    <div ref={ref} className={`border border-line-strong ${height ? "overflow-hidden" : ""}`} style={height ? { height } : undefined} aria-label={label ?? `Sample of ${theme.name}${scheme ? `, as ${scheme} viewers see it` : ""}`} role="img" data-theme-sample={theme.id} data-sample-scheme={scheme ?? "viewer"}>
      <Canvas theme={shown} {...(scope ? { scope } : {})} {...(scopedCss ? { customCss: scopedCss as ScopedCss } : {})} driftNow={new Date(Date.UTC(2026, 0, 1, 12))} className={`!min-h-0 ${height ? "h-full" : ""}`} aria-hidden>
        <div className={`flex flex-col tracking-normal ${height ? "h-full" : ""}`} style={{ fontFamily: "var(--theme-font-body)", letterSpacing: "normal" }} onClickCapture={stop}>
          <SampleNav />
          <div inert className="atr-render-root min-h-0 flex-1" style={{ padding: "var(--theme-pad)" }} data-sample-page>
            <div className="canvas-grid grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }} data-sample-grid>
              <section className="atr-card canvas-surface min-w-0" data-sample-card>
                <SampleTitleBar text="Rack" />
                <div className="atr-card-body">
                  <span className="text-[11px]" style={{ color: "var(--theme-surface-muted)", fontFamily: "var(--theme-font-mono)" }}>CPU</span>
                  <span className="text-[28px] leading-none" style={{ fontFamily: "var(--theme-font-display)", fontWeight: "var(--theme-heading-weight)" as never, letterSpacing: "var(--theme-heading-tracking)", fontVariantNumeric: "var(--theme-numbers)" }}>42%</span>
                  <table className="w-full text-[11px]">
                    <tbody>
                      {[["pve1", "up"], ["nas", "up"], ["ha", "warn"]].map(([n, s]) => (
                        <tr key={n} style={{ borderBottom: "1px solid var(--theme-line)" }}>
                          <td>{n}</td>
                          <td className="text-right" style={{ color: s === "up" ? "var(--theme-ok)" : "var(--theme-warn)" }}>{s}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="atr-card canvas-surface min-w-0" data-sample-card>
                <SampleTitleBar text="Scenes" />
                <div className="atr-card-body">
                  <div className="atr-control">
                    <button type="button" className="atr-button" data-variant="primary" data-sample-button>
                      <span data-slot="label">Run</span>
                    </button>
                  </div>
                  <div className="atr-control">
                    <button type="button" role="switch" aria-checked className="atr-toggle" data-state="on" data-sample-toggle>
                      <span className="atr-toggle-label">Fans</span>
                      <span className="atr-toggle-track" aria-hidden>
                        <span className="atr-toggle-thumb" style={{ transform: "translateX(20px)" }} />
                      </span>
                    </button>
                  </div>
                  <div className="atr-control atr-select">
                    <label>Room</label>
                    <select defaultValue="living" aria-label="Room" data-sample-select>
                      <option value="living">Lounge</option>
                    </select>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </Canvas>
    </div>
  );
}
