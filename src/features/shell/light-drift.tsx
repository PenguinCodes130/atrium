"use client";
// Canvas-only overlay for time-of-day light drift. Mount it inside the dashboard canvas (never in the
// shell or the approval sheet). Recomputed every 5 minutes; under reduced motion only on page load.
import { useEffect, useState } from "react";
import { driftAt, DRIFT_RECOMPUTE_MS, type DriftOverlay } from "./drift";
import { prefersReducedMotionNow } from "./use-preferences";

export function LightDrift({ enabled, now }: { enabled: boolean; /** fixed time for previews and tests */ now?: Date }) {
  const [overlay, setOverlay] = useState<DriftOverlay | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOverlay(null);
      return;
    }
    setOverlay(driftAt(now ?? new Date()));
    if (now || prefersReducedMotionNow()) return;
    const id = window.setInterval(() => setOverlay(driftAt(new Date())), DRIFT_RECOMPUTE_MS);
    return () => window.clearInterval(id);
  }, [enabled, now]);

  if (!overlay || !overlay.css) return <div key="none" aria-hidden data-drift="none" data-drift-strength="0" hidden />;
  return (
    <div
      key="overlay"
      aria-hidden
      data-drift={overlay.band}
      data-drift-strength={overlay.strength}
      className="pointer-events-none absolute inset-0 z-[1]"
      style={{ background: overlay.css, opacity: overlay.strength, mixBlendMode: "soft-light" }}
    />
  );
}
