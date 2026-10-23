"use client";
// Opening light sweep (design v4 section 4 with Note 1). Wrap the launcher or app canvas in <LightSweep>
// and each window or component in <SettleItem>. On the first launcher or app paint of a browser session
// a band of light 36vh tall travels from 20vh above the viewport to below it over 1200ms (`sweep`).
// Light surfaces: `normal` blend, pale gold rgba(246,217,139,0.45) at its peak with a 1px
// rgba(233,185,73,0.6) leading edge, so the band is visible in a still frame (soft-light at 0.32 was
// invisible on paper). Dark surfaces keep `screen` at 0.45. Each item settles (opacity 0 -> 1,
// 8px -> 0, `settle`) as the band passes its top edge, 30ms apart for the first 12, and its title bar
// door glyph lights as the band crosses it (staying lit if the window is live). Input is never
// blocked. Reduced motion: no band, rendered lit.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { durations, springs } from "./motion";
import { BAND_HEIGHT_VH, claimSweep, cookieSweepStorage, settleSchedule, sweepOrder } from "./sweep";
import { prefersReducedMotionNow } from "./use-preferences";
import { useCanvasTone } from "./canvas";
import { DOOR_PASS_MS, SweepPassContext, type SweepPass } from "./sweep-context";

type Phase = "pending" | "playing" | "lit";
type Ctx = {
  phase: Phase;
  register: (el: HTMLElement, index?: number) => () => void;
  delayFor: (el: HTMLElement) => number;
};
const SweepContext = createContext<Ctx | null>(null);

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type LightSweepProps = {
  children: ReactNode;
  /** The canvas theme's tone: soft-light in light themes, screen at 0.45 in dark. Defaults to the
   *  surrounding <Canvas> tone, then to the shell mode. */
  tone?: "light" | "dark";
  /** Force a replay (previews and tests only). */
  force?: boolean;
  onDone?: () => void;
};

export function LightSweep({ children, tone: toneProp, force = false, onDone }: LightSweepProps) {
  const canvasTone = useCanvasTone();
  const tone = toneProp ?? canvasTone ?? undefined;
  const [phase, setPhase] = useState<Phase>("pending");
  const items = useRef(new Map<HTMLElement, number | undefined>());
  const delays = useRef(new Map<HTMLElement, number>());
  const [viewport, setViewport] = useState(0);

  const register = useCallback((el: HTMLElement, index?: number) => {
    items.current.set(el, index);
    return () => {
      items.current.delete(el);
    };
  }, []);

  useIsoLayoutEffect(() => {
    const reduced = prefersReducedMotionNow();
    const play = force ? !reduced : claimSweep(cookieSweepStorage, reduced);
    if (!play) {
      setPhase("lit");
      return;
    }
    const vh = window.innerHeight;
    const rects = [...items.current.entries()].map(([el, index]) => {
      const r = el.getBoundingClientRect();
      return { el, index, top: r.top, left: r.left };
    });
    const ordered = rects.every((r) => r.index !== undefined)
      ? [...rects].sort((a, b) => a.index! - b.index!)
      : sweepOrder(rects);
    const firstTop = ordered.length ? Math.max(0, Math.min(...ordered.map((r) => r.top))) : 0;
    const schedule = settleSchedule(ordered.length, firstTop, vh);
    ordered.forEach((r, i) => delays.current.set(r.el, schedule[i]!));
    setViewport(vh);
    setPhase("playing");
  }, []);

  const finish = useCallback(() => {
    setPhase("lit");
    document.documentElement.setAttribute("data-swept", "1");
    onDone?.();
  }, [onDone]);

  const ctx = useMemo<Ctx>(() => ({ phase, register, delayFor: (el) => delays.current.get(el) ?? 0 }), [phase, register]);
  const blend = tone === "light" ? { mixBlendMode: "normal" as const, opacity: 1 } : tone === "dark" ? { mixBlendMode: "screen" as const, opacity: 0.45 } : { mixBlendMode: "var(--sweep-blend)" as unknown as "normal", opacity: "var(--sweep-opacity)" as unknown as number };

  return (
    <SweepContext.Provider value={ctx}>
      {children}
      {phase === "playing" && viewport > 0 && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-30 overflow-hidden" data-sweep="playing" style={blend}>
          <motion.div
            className="absolute inset-x-0 top-0 will-change-transform"
            data-sweep-band
            // A light front: it rises from nothing to the peak and ends on a crisp 1px gold leading edge.
            style={{ height: `${(BAND_HEIGHT_VH / 100) * viewport}px`, background: "linear-gradient(to bottom, transparent 0%, var(--sweep-band) 58%, var(--sweep-band) 100%)", borderBottom: "1px solid var(--sweep-edge)" }}
            initial={{ y: -(0.2 + BAND_HEIGHT_VH / 200) * viewport }}
            animate={{ y: viewport }}
            transition={{ duration: durations.sweep.ms / 1000, ease: [...durations.sweep.ease] }}
            onAnimationComplete={finish}
          />
        </div>
      )}
    </SweepContext.Provider>
  );
}

const SettledContext = createContext(true);

/** True once this widget's settle has started (or the page is lit): data that is ready waits for this. */
export function useSettled(): boolean {
  return useContext(SettledContext);
}

/** Wrap each widget. `index` is its sweep order; omit it to sort by position. */
export function SettleItem({ children, index, className }: { children: ReactNode; index?: number; className?: string }) {
  const ctx = useContext(SweepContext);
  const ref = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(false);
  const phase = ctx?.phase ?? "lit";

  useIsoLayoutEffect(() => {
    if (!ctx || !ref.current) return;
    return ctx.register(ref.current, index);
  }, [index]);

  const delay = phase === "playing" && ref.current && ctx ? ctx.delayFor(ref.current) : 0;
  useEffect(() => {
    if (phase === "lit") setSettled(true);
    if (phase !== "playing") return;
    const t = window.setTimeout(() => setSettled(true), delay);
    return () => window.clearTimeout(t);
  }, [phase, delay]);

  // The door glyph lights while the band crosses this item, then settles to its live state.
  const [pass, setPass] = useState<SweepPass>("done");
  useEffect(() => {
    if (phase === "lit") return setPass("done");
    if (phase === "pending") return setPass("pending");
    setPass(settled ? "passing" : "pending");
    if (!settled) return;
    const t = window.setTimeout(() => setPass("done"), DOOR_PASS_MS);
    return () => window.clearTimeout(t);
  }, [phase, settled]);

  const visible = phase !== "pending";
  return (
    <SweepPassContext.Provider value={pass}>
    <SettledContext.Provider value={settled || phase === "lit"}>
      <motion.div
        ref={ref}
        data-settle={phase}
        data-settle-delay={phase === "playing" ? delay : undefined}
        className={className}
        style={phase === "playing" ? { willChange: "transform, opacity" } : undefined}
        initial={{ opacity: 0, y: 8 }}
        animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
        transition={phase === "playing" ? { ...springs.settle, delay: delay / 1000 } : { duration: 0 }}
      >
        {children}
      </motion.div>
    </SettledContext.Provider>
    </SweepPassContext.Provider>
  );
}
