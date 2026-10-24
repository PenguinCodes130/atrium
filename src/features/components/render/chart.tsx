"use client";
// Chart (spec 3.1.4, amendment A4.1): every series it receives as a line, area or bars, one theme
// colour per series, nulls as gaps, the unit on the value axis and time on the other. The legend
// names each series and counts them ("3 series", or "20 of 312 series" when the source gives a total).
// Above 12 series it shows the first 12 and "+N more" expands the legend. New points slide in with
// `tick`; under reduced motion the chart redraws in place. Drawn as SVG (no runtime dependency).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentNode, RenderContext, ShapedData } from "@/core/contracts";
import { durations, useReducedMotion } from "@/features/shell";
import { useNodeEnv } from "./context";
import { StateBody, StateMarks, formatNumber } from "./states";
import { NodeTitleBar } from "./titlebar";
import { nodeSources } from "./resolve";
import { shapeMismatch } from "./rollup";
import { MISMATCH_WORD, MismatchBody } from "./data";
import { formatParts } from "./format";
import { LinesChartView } from "./chart-lines";

/** A series' name for people (A8.4): its display name when the data gives one, never raw label text. */
export function seriesLabel(s: { name: string; display?: string }): string {
  return s.display?.trim() || s.name;
}

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };
type Series = Extract<ShapedData, { kind: "series" }>;

export const MAX_DRAWN_SERIES = 12;
const PALETTE = ["var(--theme-accent)", "var(--theme-info)", "var(--theme-ok)", "var(--theme-bad)", "var(--theme-warn)", "var(--theme-surface-muted)"];
const DASHES = ["", "6 3", "2 3", "8 3 2 3"];

export function seriesColor(i: number): { stroke: string; dash: string } {
  return { stroke: PALETTE[i % PALETTE.length]!, dash: DASHES[Math.floor(i / PALETTE.length) % DASHES.length]! };
}

/** The legend's count line: "N series", or "N of T series" when the source holds more. */
export function seriesCountText(received: number, total?: number): string {
  return typeof total === "number" && total > received ? `${received} of ${formatNumber(total)} series` : `${received} series`;
}

function niceTime(t: number, span: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return span > 2 * 86400_000 ? `${d.getMonth() + 1}/${d.getDate()}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A chart with lines (A10.2) draws them; one without draws its single series source as before. */
export function ChartView(props: P) {
  const lines = props.node.props.lines;
  return Array.isArray(lines) && lines.length ? <LinesChartView {...props} /> : <SingleChartView {...props} />;
}

function SingleChartView({ resolved }: P) {
  const { status, node, scope } = useNodeEnv();
  const reduced = useReducedMotion();
  const data = resolved.data && typeof resolved.data === "object" && (resolved.data as { kind?: unknown }).kind === "series" ? (resolved.data as Series) : null;
  const all = data?.series ?? [];
  const [expanded, setExpanded] = useState(false);
  const drawn = all.slice(0, MAX_DRAWN_SERIES);
  const kind = resolved.kind === "area" || resolved.kind === "bars" ? resolved.kind : "line";
  const height = typeof resolved.height === "number" ? resolved.height : 200;
  // Drawn at its real width, so the axis text is never squeezed (gauntlet w2-r2 Fix 6).
  const [measured, setMeasured] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  // A callback ref: the figure mounts only once there is data, which can be after the first render.
  const figRef = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setMeasured(Math.round(e!.contentRect.width)));
    ro.observe(el);
    observer.current = ro;
  }, []);
  const W = Math.max(160, measured ?? 600), H = height, padL = 44, padR = 8, padT = 8, padB = 22;

  const geo = useMemo(() => {
    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const s of drawn) for (const [t, v] of s.points) {
      if (!Number.isFinite(t)) continue;
      tMin = Math.min(tMin, t);
      tMax = Math.max(tMax, t);
      if (v !== null && Number.isFinite(v)) {
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
    }
    if (!Number.isFinite(tMin)) return null;
    if (!Number.isFinite(vMin)) { vMin = 0; vMax = 1; }
    if (kind !== "line") vMin = Math.min(0, vMin);
    if (vMax === vMin) vMax = vMin + 1;
    const x = (t: number) => padL + ((t - tMin) / (tMax - tMin || 1)) * (W - padL - padR);
    const y = (v: number) => padT + (1 - (v - vMin) / (vMax - vMin)) * (H - padT - padB);
    return { tMin, tMax, vMin, vMax, x, y };
  }, [drawn, kind, H, W]);

  // New points slide in from the right over `tick`; reduced motion redraws in place.
  const lastT = useRef<number | null>(null);
  const [slide, setSlide] = useState(0);
  useEffect(() => {
    if (!geo) return;
    const prev = lastT.current;
    lastT.current = geo.tMax;
    if (reduced || prev === null || geo.tMax <= prev) return;
    const px = geo.x(geo.tMax) - geo.x(Math.max(geo.tMin, prev));
    setSlide(px);
    const id = requestAnimationFrame(() => setSlide(0));
    return () => cancelAnimationFrame(id);
  }, [geo, reduced]);

  // A8.4: the value axis follows the data's format unless the source names its own unit.
  const axisText = (v: number, top: boolean) => {
    if (!data?.unit && data?.format && data.format !== "number") {
      const p = formatParts(v, data.format, data.format === "percent" || data.format === "celsius" ? 0 : undefined);
      return `${p.text}${p.unit && (top || data.format === "seconds") ? ` ${p.unit}` : ""}`;
    }
    return `${formatNumber(v)}${data?.unit && top ? ` ${data.unit}` : ""}`;
  };
  const body = StateBody({ status, height });
  const legendItems = expanded ? all : drawn;
  const mismatch = body ? null : shapeMismatch("chart", resolved.data, nodeSources(node, scope)[0]);
  // With title bars on, up to three series are named in the bar; the body legend stays for more.
  const inBar = resolved.legend !== false && !!data && all.length > 0 && all.length <= 3;
  const barLegend = inBar ? (
    <ul className="atr-titlebar-legend" data-titlebar-legend>
      {all.map((s, i) => {
        const { stroke, dash } = seriesColor(i);
        return (
          <li key={i}>
            <svg width="12" height="6" aria-hidden>
              <line x1="0" x2="12" y1="3" y2="3" stroke={stroke} strokeWidth="2.5" strokeDasharray={dash || undefined} />
            </svg>
            {seriesLabel(s)}
          </li>
        );
      })}
    </ul>
  ) : null;
  return (
    <section data-slot="root" className="atr-surface atr-data canvas-surface atr-chart-root" data-status={status.kind} data-legend-in-bar={inBar ? "" : undefined}>
      <NodeTitleBar word={mismatch ? MISMATCH_WORD : undefined} extra={mismatch ? null : barLegend} />
      <StateMarks status={status} showUpdated={resolved.showUpdated === true} />
      {body ?? (mismatch ? <MismatchBody message={mismatch} /> : (
        <>
          <figure ref={figRef} className="atr-chart" aria-label={`Chart, ${seriesCountText(all.length, data?.total)}${data?.unit ? `, in ${data.unit}` : ""}`}>
            {geo ? (
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} role="img" aria-hidden data-chart-width={W}>
                <g data-slot="axis" className="atr-axis">
                  {[0, 0.5, 1].map((f) => {
                    const v = geo.vMin + (geo.vMax - geo.vMin) * f;
                    return (
                      <g key={f}>
                        <line x1={padL} x2={W - padR} y1={geo.y(v)} y2={geo.y(v)} className="atr-gridline" />
                        <text x={padL - 6} y={geo.y(v) + 4} textAnchor="end">{axisText(v, f === 1)}</text>
                      </g>
                    );
                  })}
                  <text x={padL} y={H - 6}>{niceTime(geo.tMin, geo.tMax - geo.tMin)}</text>
                  <text x={W - padR} y={H - 6} textAnchor="end">{niceTime(geo.tMax, geo.tMax - geo.tMin)}</text>
                </g>
                <g data-chart-plot style={{ transform: `translateX(${slide}px)`, transition: slide === 0 && !reduced ? `transform ${durations.tick.ms}ms ${durations.tick.css}` : "none" }}>
                  {drawn.map((s, i) => {
                    const { stroke, dash } = seriesColor(i);
                    if (kind === "bars") {
                      const pts = s.points.filter(([, v]) => v !== null && Number.isFinite(v));
                      const bw = Math.max(1, ((W - padL - padR) / Math.max(1, s.points.length)) / Math.max(1, drawn.length) - 1);
                      return (
                        <g key={i} data-series={s.name} data-series-label={seriesLabel(s)}>
                          {pts.map(([t, v], j) => (
                            <rect key={j} x={geo.x(t) + i * bw - (bw * drawn.length) / 2} y={Math.min(geo.y(v!), geo.y(Math.max(0, geo.vMin)))} width={bw} height={Math.abs(geo.y(Math.max(0, geo.vMin)) - geo.y(v!))} fill={stroke} />
                          ))}
                        </g>
                      );
                    }
                    // Nulls break the line into segments (gaps).
                    const segs: string[] = [];
                    let cur = "";
                    for (const [t, v] of s.points) {
                      if (v === null || !Number.isFinite(v)) {
                        if (cur) segs.push(cur);
                        cur = "";
                        continue;
                      }
                      cur += `${cur ? "L" : "M"}${geo.x(t).toFixed(1)},${geo.y(v).toFixed(1)}`;
                    }
                    if (cur) segs.push(cur);
                    return (
                      <g key={i} data-series={s.name} data-segments={segs.length} data-series-label={seriesLabel(s)}>
                        {kind === "area" && (i === 0 || drawn.length === 1)
                          ? (() => {
                              // One fill under every known point: a gap breaks the line, never the fill (no paper band, Fix 6).
                              const pts = s.points.filter(([t, v]) => Number.isFinite(t) && v !== null && Number.isFinite(v)) as [number, number][];
                              if (pts.length < 2) return null;
                              const base = geo.y(Math.max(geo.vMin, 0)).toFixed(1);
                              const d = pts.map(([t, v], j) => `${j ? "L" : "M"}${geo.x(t).toFixed(1)},${geo.y(v).toFixed(1)}`).join("");
                              return <path d={`${d}L${geo.x(pts[pts.length - 1]![0]).toFixed(1)},${base}L${geo.x(pts[0]![0]).toFixed(1)},${base}Z`} fill={stroke} opacity={drawn.length > 1 ? 0.12 : 0.18} data-area-fill />;
                            })()
                          : null}
                        {segs.map((d, j) => (
                          <path key={j} d={d} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray={dash || undefined} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                        ))}
                      </g>
                    );
                  })}
                </g>
              </svg>
            ) : (
              <p className="atr-muted">No points yet</p>
            )}
          </figure>
          {resolved.legend !== false ? (
            <div data-slot="legend" className="atr-legend">
              <span className="atr-legend-count" data-series-count={all.length}>
                {seriesCountText(all.length, data?.total)}
              </span>
              <ul>
                {legendItems.map((s, i) => {
                  const { stroke, dash } = seriesColor(i);
                  return (
                    <li key={i} data-drawn={i < MAX_DRAWN_SERIES ? "" : undefined}>
                      <svg width="18" height="8" aria-hidden>
                        <line x1="0" x2="18" y1="4" y2="4" stroke={stroke} strokeWidth="2.5" strokeDasharray={dash || undefined} />
                      </svg>
                      {seriesLabel(s)}
                    </li>
                  );
                })}
              </ul>
              {all.length > MAX_DRAWN_SERIES ? (
                <button type="button" className="atr-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)} data-more-series>
                  {expanded ? "Show fewer" : `+${all.length - MAX_DRAWN_SERIES} more`}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ))}
    </section>
  );
}
