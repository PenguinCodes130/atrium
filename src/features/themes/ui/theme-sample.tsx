"use client";
// The small live sample canvas on the Themes screen and in the editor (settings spec 3.3): nav chrome,
// a stat, a table, a switch and a button, drawn in the theme through app-shell's Canvas. Custom CSS
// arrives already scoped by the server (canvasThemeCss with this sample's scope id).
import type { Theme } from "@/core/contracts";
import { Canvas, type ScopedCss } from "@/features/shell";

// Settings r2 (gauntlet w2-r1 item 7): small sample text at 11px or more with normal tracking; only the
// heading-sized readout takes the theme's heading tracking.
export function ThemeSample({ theme, scopedCss, scope, height = 240, label }: { theme: Theme; scopedCss?: string; scope?: string; height?: number; label?: string }) {
  const t = theme.tokens;
  return (
    <div className="overflow-hidden border border-line-strong" style={{ height }} aria-label={label ?? `Sample of ${theme.name}`} role="img" data-theme-sample={theme.id}>
      <Canvas theme={theme} {...(scope ? { scope } : {})} {...(scopedCss ? { customCss: scopedCss as ScopedCss } : {})} driftNow={new Date(Date.UTC(2026, 0, 1, 12))} className="!min-h-0 h-full" aria-hidden>
        <div className="flex h-full flex-col gap-3 p-3 tracking-normal" style={{ fontFamily: "var(--theme-font-body)", letterSpacing: "normal" }}>
          <nav data-canvas-nav className="flex items-center gap-1.5 px-2 py-1.5" style={{ borderRadius: "var(--theme-radius)" }}>
            <span className="mr-2 text-[12px] font-semibold" style={{ fontFamily: "var(--theme-font-display)", letterSpacing: "normal" }}>Homelab</span>
            <span data-active className="px-2 py-0.5 text-[11px]">Overview</span>
            <span className="px-2 py-0.5 text-[11px]">Rack</span>
          </nav>
          <div className="canvas-grid grid flex-1 grid-cols-2" style={{ gap: "min(var(--theme-gap), 12px)" }}>
            <div className="canvas-surface flex flex-col justify-between" style={{ padding: "min(var(--theme-pad), 12px)" }}>
              <span className="text-[11px]" style={{ color: "var(--theme-surface-muted)", fontFamily: "var(--theme-font-mono)" }}>CPU</span>
              <span className="text-[28px] leading-none" style={{ fontFamily: "var(--theme-font-display)", fontWeight: "var(--theme-heading-weight)" as never, letterSpacing: "var(--theme-heading-tracking)", fontVariantNumeric: "var(--theme-numbers)" }}>42%</span>
              <span className="flex items-center gap-2 text-[11px]">
                <span aria-hidden className="inline-block h-3.5 w-6 border" style={{ background: "var(--theme-accent)", borderColor: "var(--theme-surface-text)", borderRadius: "var(--theme-control-radius)" }} />
                Fans
              </span>
            </div>
            <div className="canvas-surface flex flex-col gap-1.5" style={{ padding: "min(var(--theme-pad), 12px)" }}>
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
              <span className="mt-auto inline-flex w-fit px-2 py-1 text-[11px]" style={{ background: "var(--theme-accent)", color: "var(--theme-accent-text)", borderRadius: "var(--theme-control-radius)" }}>
                Run scene
              </span>
            </div>
          </div>
          <span className="text-[11px]" style={{ color: "var(--theme-canvas-text)" }}>{t.wallpaper.kind === "none" ? "no wallpaper" : `${t.wallpaper.kind} wallpaper`}</span>
        </div>
      </Canvas>
    </div>
  );
}
