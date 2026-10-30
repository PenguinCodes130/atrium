"use client";
// Wave 2.10b F10 (data fields) and F2: small drawn samples, so data choices show rather than name. A
// widget kind ("Show it as a table") is drawn as a mini widget, a measure ("CPU", "Network") as a mini
// reading of it, and a candidate's marker (Empty, Zero, Error, Stale) has its own shape beside its words, so
// it is never told by colour alone. All are inline SVG in currentColor (theme text and accent).
import type { Measure } from "@/core/contracts";
import type { MarkerKind } from "./candidate-marks";

const box = { width: 40, height: 24, viewBox: "0 0 40 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;

/** A mini drawing of a widget kind. */
export function ShowAsSample({ type }: { type: string }) {
  const t = type === "cards" ? "cards" : type;
  return (
    <svg {...box} data-sample={t} className="flex-none">
      {t === "stat" && <><path d="M6 17h6M6 7h10" strokeLinecap="round" /><text x="20" y="17" fontSize="10" fontWeight="600" fill="currentColor" stroke="none" fontFamily="inherit">42</text></>}
      {t === "gauge" && <><path d="M8 19a12 12 0 0 1 24 0" opacity=".35" /><path d="M8 19a12 12 0 0 1 17-10.9" className="text-accent-ink" /></>}
      {t === "progress" && <><rect x="5" y="10" width="30" height="5" rx="2.5" opacity=".35" /><rect x="5" y="10" width="19" height="5" rx="2.5" fill="currentColor" stroke="none" /></>}
      {t === "chart" && <><path d="M4 20h32" opacity=".35" /><path d="M5 16l7-5 6 3 7-8 7 4" strokeLinejoin="round" /></>}
      {t === "table" && <><rect x="5" y="4" width="30" height="16" opacity=".5" /><path d="M5 9.5h30M5 14.5h30M17 4v16" opacity=".6" /></>}
      {t === "status" && <><circle cx="9" cy="8" r="2.2" fill="currentColor" stroke="none" /><path d="M14 8h20" opacity=".6" /><circle cx="9" cy="16" r="2.2" /><path d="M14 16h16" opacity=".6" /></>}
      {t === "cards" && <><rect x="4" y="5" width="9" height="14" /><rect x="15.5" y="5" width="9" height="14" /><rect x="27" y="5" width="9" height="14" /></>}
      {!["stat", "gauge", "progress", "chart", "table", "status", "cards"].includes(t) && <rect x="6" y="5" width="28" height="14" />}
    </svg>
  );
}

/** A mini reading of a measure. */
export function MeasureSample({ measure }: { measure: Measure }) {
  return (
    <svg {...box} data-sample={measure} className="flex-none">
      {measure === "cpu" && <><rect x="12" y="4" width="16" height="16" /><path d="M16 8h8v8h-8zM12 9H9M12 15H9M28 9h3M28 15h3M17 4V1M23 4V1M17 20v3M23 20v3" /></>}
      {measure === "memory" && <><rect x="5" y="7" width="30" height="10" /><path d="M10 7v10M15 7v10M20 7v10M25 7v10M30 7v10" opacity=".5" /><path d="M8 17v3M32 17v3" /></>}
      {measure === "disk" && <><ellipse cx="20" cy="7" rx="11" ry="3.5" /><path d="M9 7v10c0 1.9 4.9 3.5 11 3.5s11-1.6 11-3.5V7" /></>}
      {measure === "network" && <><path d="M8 10h22l-4-4M32 15H10l4 4" strokeLinecap="round" strokeLinejoin="round" /></>}
      {measure === "temperature" && <><path d="M18 4v11a4 4 0 1 0 4 0V4a2 2 0 0 0-4 0z" /><path d="M20 10v7" strokeLinecap="round" /></>}
      {measure === "uptime" && <><circle cx="20" cy="12" r="8" /><path d="M20 7v5l3 2" strokeLinecap="round" /></>}
      {measure === "count" && <text x="9" y="17" fontSize="11" fontWeight="600" fill="currentColor" stroke="none" fontFamily="inherit">123</text>}
      {measure === "status" && <><circle cx="11" cy="12" r="3" fill="currentColor" stroke="none" /><circle cx="20" cy="12" r="3" fill="currentColor" stroke="none" /><circle cx="29" cy="12" r="3" /></>}
      {!["cpu", "memory", "disk", "network", "temperature", "uptime", "count", "status"].includes(measure) && <rect x="6" y="5" width="28" height="14" />}
    </svg>
  );
}

/** The shape of a candidate's marker: a dashed ring (Empty), a flat zero line (Zero), a warning triangle (Error), a clock (Stale). */
export function MarkerShape({ kind }: { kind: MarkerKind }) {
  const p = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": true } as const;
  return (
    <svg {...p} data-show-marker-shape={kind} className="flex-none">
      {kind === "empty" && <circle cx="6" cy="6" r="4.5" strokeDasharray="2 1.6" />}
      {kind === "zero" && <><ellipse cx="6" cy="6" rx="3" ry="4.5" /><path d="M1 11h10" /></>}
      {kind === "error" && <><path d="M6 1.2 11 10.5H1z" strokeLinejoin="round" /><path d="M6 4.6v2.8M6 8.6v.4" strokeLinecap="round" /></>}
      {kind === "stale" && <><circle cx="6" cy="6" r="4.8" /><path d="M6 3.3V6l2 1.4" strokeLinecap="round" /></>}
    </svg>
  );
}
