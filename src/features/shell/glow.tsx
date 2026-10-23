"use client";
// Connection and publish glow (design v4 section 4, "Connection and publish glow"). Wrap a window in
// <Glow successKey={n}>; each time successKey changes after mount (a passed connection test, a
// published version) the window's title bar flashes from its title bar colour to gold with ink text
// and back over `glow` (900ms: full gold within 120ms, held to 450ms, eased back by 900ms, design v4
// Note 1), and any <StatusCheck> inside draws in with `pop`. Once per event,
// never on mount, so a reload does not replay it. Only opacity animates (a gold layer over the bar).
// Without a <Window> inside, the glow flashes a 2px gold outline instead.
// Reduced motion: a static 1.5s 2px gold outline, and the check appears without drawing.
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { durations, glowKeyframes, REDUCED_GLOW_RING_MS, springs } from "./motion";
import { useReducedMotion } from "./use-preferences";
import { GlowContext, type GlowState } from "./glow-context";

export function Glow({ successKey, children, className }: { successKey: number | string | null | undefined; children: ReactNode; className?: string; /** @deprecated v3 */ radiusClass?: string }) {
  const reduced = useReducedMotion();
  const first = useRef(true);
  const [play, setPlay] = useState(0);
  const [ring, setRing] = useState(false);
  const [windows, setWindows] = useState(0);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (successKey === null || successKey === undefined) return;
    setPlay((n) => n + 1);
    if (reduced) {
      setRing(true);
      const t = window.setTimeout(() => setRing(false), REDUCED_GLOW_RING_MS);
      return () => window.clearTimeout(t);
    }
  }, [successKey]);

  const registerWindow = useCallback(() => {
    setWindows((n) => n + 1);
    return () => setWindows((n) => n - 1);
  }, []);
  const value = useMemo<GlowState>(() => ({ play, reduced, registerWindow }), [play, reduced, registerWindow]);

  return (
    <GlowContext.Provider value={value}>
      <div className={`relative isolate ${className ?? ""}`} data-glow={ring ? "ring" : play ? "played" : "idle"}>
        {children}
        {play > 0 && !reduced && windows === 0 && (
          <motion.div
            key={play}
            aria-hidden
            data-glow-layer
            className="pointer-events-none absolute inset-0 will-change-[opacity]"
            style={{ boxShadow: "inset 0 0 0 2px var(--accent)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: glowKeyframes.opacity }}
            transition={{ duration: durations.glow.ms / 1000, ease: glowKeyframes.ease.map((e) => (typeof e === "string" ? e : [...e])) as never, times: glowKeyframes.times }}
          />
        )}
        {ring && <div aria-hidden data-glow-ring className="pointer-events-none absolute -inset-px z-10" style={{ outline: "2px solid var(--accent)" }} />}
      </div>
    </GlowContext.Provider>
  );
}

/** A status check that draws in with `pop` each time the surrounding <Glow> plays (a transform-only wipe). */
export function StatusCheck({ size = 20, label = "Connected" }: { size?: number; label?: string }) {
  const glow = useContext(GlowContext);
  const play = glow?.play ?? 0;
  const reduced = useReducedMotion();
  const clip = useId().replace(/:/g, "");
  const animateDraw = play > 0 && !reduced;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label} className="text-ok" data-status-check>
      <defs>
        <clipPath id={`check-${clip}`}>
          <motion.rect
            key={play}
            x="0"
            y="0"
            width="24"
            height="24"
            style={{ originX: 0, transformBox: "fill-box" }}
            initial={animateDraw ? { scaleX: 0 } : false}
            animate={{ scaleX: 1 }}
            transition={springs.pop}
          />
        </clipPath>
      </defs>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <motion.path
        key={`p${play}`}
        d="m7.5 12.4 3 3 6-6.3"
        fill="none"
        stroke="var(--bg-hi)"
        strokeWidth={2.2}
        strokeLinecap="square"
        strokeLinejoin="miter"
        clipPath={`url(#check-${clip})`}
        initial={animateDraw ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={springs.pop}
      />
    </svg>
  );
}
