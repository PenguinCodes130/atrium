"use client";
// The sky band (design v4 "Shell Frame" and section 4): the glass roof. Every shell screen except the
// builder opens with it, under the top bar: 120px tall (72px on phones), a grainy gradient from --sky
// into pale gold (--accent-hi), left to right, with the 40px lit mark standing on its lower edge at
// the left gutter. The gradient is drawn by the Paper Shaders Grain Gradient (the landing page's hero
// shader), drifting slowly. Without graphics acceleration, under reduced motion, or with reduce
// transparency, it is the same gradient drawn statically with a fine grain overlay (no shader, no
// drift), so two screenshots 5s apart are identical. Never in the builder or over a user app.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Mark } from "./mark";
import { useReducedMotion, useReduceTransparency } from "./use-preferences";

// The shader is a client-only WebGL component; it is loaded only when it will run.
const GrainGradient = dynamic(() => import("@paper-design/shaders-react").then((m) => m.GrainGradient), { ssr: false });

/** The static gradient (first paint and the fallback): sky to pale gold at 15%, left to right. */
export const SKY_GRADIENT =
  "radial-gradient(42% 160% at 96% -10%, color-mix(in srgb, var(--accent-hi) 85%, transparent) 0%, transparent 70%), " +
  "linear-gradient(90deg, var(--sky) 0%, var(--sky) 34%, var(--sky-hi) 62%, var(--sky-band-warm) 86%, var(--sky-band-sun) 100%)";

/** Software renderers: WebGL works but nothing is accelerated (the static band is used instead). */
export const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i;

/** Hardware-accelerated WebGL? No context, a major performance caveat, or a software renderer: no. */
export function hasAcceleratedWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ?? canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true })) as WebGLRenderingContext | null;
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !SOFTWARE_RENDERERS.test(renderer);
  } catch {
    return false;
  }
}

/** Diagnostics only (previews, recordings): the `atrium_sky=shader|static` cookie forces a mode. */
function forcedByCookie(): "shader" | "static" | undefined {
  if (typeof document === "undefined") return undefined;
  const m = /(?:^|; )atrium_sky=(shader|static)(?:;|$)/.exec(document.cookie);
  return m ? (m[1] as "shader" | "static") : undefined;
}

/** Which way the band draws: "shader" (drifting) or "static" (gradient plus grain). */
export function skyMode(opts: { accelerated: boolean; reducedMotion: boolean; reduceTransparency: boolean; force?: "shader" | "static" }): "shader" | "static" {
  if (opts.force) return opts.force;
  return opts.accelerated && !opts.reducedMotion && !opts.reduceTransparency ? "shader" : "static";
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => {
      const t = document.documentElement.getAttribute("data-theme");
      setDark(t === "dark" || (t !== "light" && mq.matches));
    };
    read();
    mq.addEventListener("change", read);
    window.addEventListener("atrium:preferences", read);
    return () => {
      mq.removeEventListener("change", read);
      window.removeEventListener("atrium:preferences", read);
    };
  }, []);
  return dark;
}

/** One crumb segment. Every segment with an href is a link (Fix 9); the last one is the current screen. */
export type SkyCrumb = { label: string; href?: string };

export type SkyBandProps = {
  /** The crumb beside the mark, for example [{ label: "atrium.home", href: "/" }, { label: "integrations" }]. */
  crumbs?: SkyCrumb[];
  /** A plain mono path instead of crumbs (kept for screens that pass text). */
  path?: ReactNode;
  /** Hide the mark (the sign-in screen draws its own 72px mark). */
  showMark?: boolean;
  /** Previews and tests only: force the shader or the static fallback. */
  force?: "shader" | "static";
  className?: string;
};

export function SkyBand({ crumbs, path, showMark = true, force, className }: SkyBandProps) {
  const reduced = useReducedMotion();
  const reduceTransparency = useReduceTransparency();
  const dark = useDarkMode();
  const [accelerated, setAccelerated] = useState<boolean | null>(null);
  const [cookieForce, setCookieForce] = useState<"shader" | "static" | undefined>(undefined);
  useEffect(() => {
    setAccelerated(hasAcceleratedWebGL());
    setCookieForce(forcedByCookie());
  }, []);
  const forced = force ?? cookieForce;
  const mode = accelerated === null && !forced ? "static" : skyMode({ accelerated: Boolean(accelerated), reducedMotion: reduced, reduceTransparency, force: forced });
  const sky = dark ? "#2D5A85" : "#A9C8E4";

  return (
    <div
      data-sky-band={mode}
      data-shell="skyband"
      className={`grain relative h-(--skyband-height) w-full flex-none overflow-hidden border-b border-line ${className ?? ""}`}
      style={{ background: SKY_GRADIENT }}
    >
      {mode === "static" && (
        <>
          <div aria-hidden data-sky-speckle="gold" />
          <div aria-hidden data-sky-speckle="sky" />
        </>
      )}
      {mode === "shader" && (
        <div aria-hidden className="absolute inset-0" data-sky-shader>
          <GrainGradient
            style={{ width: "100%", height: "100%" }}
            colorBack={sky}
            colors={["#F6D98B"]}
            softness={1}
            intensity={0.25}
            noise={0.5}
            shape="wave"
            fit="cover"
            rotation={270}
            scale={2}
            speed={0.1}
            frame={20000}
            minPixelRatio={1}
            maxPixelCount={1600 * 240}
          />
        </div>
      )}
      {showMark && (
        // The mark and crumb sit in the shell content column (screen-x), on the same left edge as the
        // screen header and content below (design v4 Note 1, Fix 5).
        <div className="screen-x relative z-[2] flex h-full items-end" data-sky-column>
          <div className="flex min-w-0 items-end gap-3" data-sky-mark>
            <Mark height={40} lit className="flex-none" />
            {crumbs && crumbs.length > 0 ? (
              <nav aria-label="You are here" className="mb-[-1px] min-w-0 pb-1.5" data-sky-path>
                <ol className="flex min-w-0 flex-wrap items-center bg-bg/80 px-1.5 type-label text-fg" data-crumb-list>
                  {crumbs.map((c, i) => {
                    const last = i === crumbs.length - 1;
                    return (
                      <Fragment key={`${i}:${c.label}`}>
                        {i > 0 && (
                          <li aria-hidden className="px-1.5 text-fg-2">
                            /
                          </li>
                        )}
                        <li className="min-w-0 truncate">
                          {c.href && !last ? (
                            <Link href={c.href} className="inline-flex min-h-8 items-center underline-offset-4 hover:underline touch:min-h-11 touch:min-w-11" data-crumb={i}>
                              {c.label}
                            </Link>
                          ) : (
                            <span aria-current={last ? "page" : undefined} className="inline-flex min-h-8 items-center touch:min-h-11" data-crumb={i}>
                              {c.label}
                            </span>
                          )}
                        </li>
                      </Fragment>
                    );
                  })}
                </ol>
              </nav>
            ) : path ? (
              <span className="mb-[-1px] pb-1.5 type-label text-fg" data-sky-path>
                {path}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
