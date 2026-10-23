"use client";
// Data states every data component shows (spec section 4, architecture 10): skeleton while loading,
// "No data yet", the stale dot, the failed warning with message and hint on hover and focus,
// "Not available yet", the unshared message, and the optional "Last updated" badge.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { durations, useReducedMotion } from "@/features/shell";
import type { NodeStatus } from "./resolve";

export function Skeleton({ lines = 2, height }: { lines?: number; height?: number }) {
  return (
    <div className="atr-skeleton" aria-hidden style={height ? { minHeight: height } : undefined}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${80 - i * 22}%` }} />
      ))}
    </div>
  );
}

/** Replaces a data component's body for states that have no value to show. Null when the body should render. */
export function StateBody({ status, height }: { status: NodeStatus; height?: number }): ReactNode {
  switch (status.kind) {
    case "loading":
      return (
        <div role="status" aria-label="Loading" className="atr-state">
          <Skeleton height={height} />
        </div>
      );
    case "empty":
      if (status.href && status.message) {
        // An unconnected source: its message is the title and the link goes to where it gets connected.
        return (
          <div role="status" className="atr-state atr-state-empty" data-state-unmapped>
            <span className="atr-state-title">{status.message}</span>
            <a className="atr-state-link" href={status.href} data-connect-link>
              Connect it <span aria-hidden>→</span>
            </a>
          </div>
        );
      }
      return (
        <div role="status" className="atr-state atr-state-empty">
          <span className="atr-state-title">No data yet</span>
          {status.message ? <span className="atr-state-detail">{status.message}</span> : null}
        </div>
      );
    case "not_shared":
    case "not_available":
      return (
        <div role="status" className="atr-state atr-state-blocked" data-state-kind={status.kind}>
          <span className="atr-state-title">{status.message}</span>
        </div>
      );
    default:
      return null;
  }
}

/** The small marks in a data component's corner: stale dot, failed warning, last updated. */
export function StateMarks({ status, showUpdated }: { status: NodeStatus; showUpdated?: boolean }) {
  const tipId = useId();
  const updatedAt = status.kind === "ok" || status.kind === "stale" || status.kind === "failed" ? status.updatedAt : undefined;
  return (
    <span className="atr-marks">
      {showUpdated && updatedAt ? <LastUpdated at={updatedAt} /> : null}
      {status.kind === "stale" ? (
        <button type="button" className="atr-stale" aria-label="Stale: this value has not refreshed recently" data-state-mark="stale">
          <span aria-hidden className="atr-stale-dot" />
          <span className="atr-stale-word">stale</span>
        </button>
      ) : null}
      {status.kind === "failed" ? (
        <span className="atr-failed-wrap">
          <button type="button" className="atr-failed" aria-describedby={tipId} aria-label="The last refresh failed" data-state-mark="failed">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M8 6v4M8 11.6v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <span role="tooltip" id={tipId} className="atr-tip">
            <strong>{status.message}</strong>
            {status.hint ? <span>{status.hint}</span> : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function agoText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function LastUpdated({ at }: { at: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const h = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(h);
  }, []);
  return (
    <time className="atr-updated" dateTime={at} title={at} data-last-updated>
      {now === null ? "updated" : `updated ${agoText(at, now)}`}
    </time>
  );
}

/** Counts a number from its last value to the new one over `tick` (240ms); instant under reduced motion. */
export function useTickNumber(value: number | null): number | null {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (value === null || from.current === null || reduced || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const ease = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / durations.tick.ms);
      setShown(a + (value - a) * ease(t));
      if (t < 1) raf = requestAnimationFrame(frame);
      else from.current = value;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, reduced]);
  return shown;
}

export function formatNumber(v: number, decimals?: number): string {
  if (!Number.isFinite(v)) return "";
  const d = decimals ?? (Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 1);
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: Math.min(6, Math.max(0, d)) });
}
