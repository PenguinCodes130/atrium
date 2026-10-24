"use client";
// Data state marks for widgets and endpoint previews (architecture v2 section 10, spec section 4):
// stale shows a small amber dot, failed shows a warning icon whose message and hint appear on hover
// and on keyboard focus. Fresh shows nothing.
import { useId, useState } from "react";
import type { ShapedData } from "@/core/contracts";
import { StatusMark, WarnIcon } from "@/features/shell";
import type { WidgetData } from "@/features/data/types";
import { formatNumber, SeriesChart, shownValue } from "./series-chart";

type StatusData = Extract<ShapedData, { kind: "status" }>;

/** Status items with an up / down / total headline (what Homarr and Homepage lead with), down first, expandable. */
function StatusPreview({ data }: { data: StatusData }) {
  const [all, setAll] = useState(false);
  const up = data.items.filter((i) => i.state === "up").length;
  const down = data.items.filter((i) => i.state === "down").length;
  const other = data.items.length - up - down;
  const rank = { down: 0, warn: 1, unknown: 2, up: 3 } as const;
  const items = [...data.items].sort((a, b) => rank[a.state] - rank[b.state]);
  const shown = all ? items : items.slice(0, 6);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 type-callout text-fg" data-status-headline>
        <span className="inline-flex items-center gap-1"><StatusMark state="up" /> <span data-count-up>{up} up</span></span>
        <span className={`inline-flex items-center gap-1 ${down ? "text-danger" : ""}`}><StatusMark state={down ? "down" : "unknown"} /> <span data-count-down>{down} down</span></span>
        {other > 0 && <span className="text-glass-muted">{other} other</span>}
        <span className="text-glass-muted">of <span data-count-total>{data.items.length}</span></span>
      </p>
      <ul className="flex flex-col gap-1">
        {shown.map((i, n) => (
          <li key={n} className="flex items-center gap-2 type-body text-fg">
            <StatusMark state={i.state} /> <span className="truncate">{i.label}</span>
            {/* A10.6: the reachability and health reads say how fast, or why not, in the detail. */}
            {i.detail && <span className="truncate type-caption text-glass-muted" data-status-detail>{i.detail}</span>}
          </li>
        ))}
      </ul>
      {items.length > 6 && (
        <button type="button" className="min-h-8 w-fit rounded-xs type-caption text-accent-ink touch:min-h-11" onClick={() => setAll((x) => !x)} aria-expanded={all} data-status-more>
          {all ? "Show fewer" : `and ${items.length - 6} more`}
        </button>
      )}
    </div>
  );
}

function ago(iso?: string): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function DataStateBadge({ data }: { data: WidgetData }) {
  const tip = useId();
  if (data.state === "stale") {
    return (
      <span className="inline-flex items-center gap-1 type-caption text-glass-muted" data-state-badge="stale">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-warning" data-stale-dot />
        <span className="sr-only">Stale, last updated {ago(data.fetchedAt)}</span>
        <span aria-hidden>{ago(data.fetchedAt)}</span>
      </span>
    );
  }
  if ((data.state === "failed" || data.state === "empty") && data.error) {
    return (
      <span className="group relative inline-flex" data-state-badge={data.state}>
        <button type="button" aria-describedby={tip} aria-label="Last update failed" className="inline-flex h-8 w-8 touch:h-11 touch:w-11 items-center justify-center rounded-xs text-warning">
          <WarnIcon width={16} height={16} aria-hidden />
        </button>
        <span
          id={tip}
          role="tooltip"
          className="glass-thick elevated-2 absolute right-0 top-full z-10 mt-1 hidden w-64 rounded-md p-3 text-left group-hover:block group-focus-within:block"
          data-failed-tooltip
        >
          <span className="block type-callout text-fg">{data.error.message}</span>
          {data.error.hint && <span className="mt-1 block type-caption text-glass-muted">{data.error.hint}</span>}
        </span>
      </span>
    );
  }
  return null;
}

/** A compact rendering of shaped data for previews. The widgets subsystem owns the real renderers. */
export function ShapedPreview({ data }: { data: ShapedData }) {
  if (data.kind === "stat") {
    return (
      <p className="flex items-baseline gap-2">
        <span className="type-title-2 font-mono text-fg" data-stat-value>{typeof data.value === "number" ? (data.format && !data.unit ? shownValue(data.value, data.format) : formatNumber(data.value)) : data.value}</span>
        {data.unit && <span className="type-callout text-glass-muted">{data.unit}</span>}
        <span className="type-caption text-glass-muted truncate">{data.label}</span>
      </p>
    );
  }
  if (data.kind === "status") return <StatusPreview data={data} />;
  if (data.kind === "series") return <SeriesChart data={data} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full type-caption text-fg">
        <thead><tr>{data.columns.map((c) => <th key={c.key} className="whitespace-nowrap pb-1 pr-4 text-left font-medium text-glass-muted">{c.label}</th>)}</tr></thead>
        <tbody>
          {data.rows.slice(0, 5).map((r, i) => (
            <tr key={i}>{data.columns.map((c) => <td key={c.key} className="whitespace-nowrap py-0.5 pr-4 font-mono" data-cell={c.key}>{c.type === "time" && typeof r[c.key] === "number" ? new Date(r[c.key] as number).toLocaleString() : c.format && typeof r[c.key] === "number" ? shownValue(r[c.key] as number, c.format) : String(r[c.key] ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {data.rows.length > 5 && <p className="type-caption text-glass-muted">{data.total ?? data.rows.length} rows</p>}
    </div>
  );
}
