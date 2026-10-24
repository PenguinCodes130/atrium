"use client";
// The chart with lines (A10.2): each line its own read, named and coloured, on up to two value axes
// (left for the first format and unit, right for the second). A line in a third unit is not drawn and
// the chart says why in one sentence. At most 20 series are drawn, the highest latest value first, with
// "20 of N". New points slide in with `tick`; reduced motion redraws in place. Drawn as SVG.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentNode, RenderContext, ValueFormat } from "@/core/contracts";
import { durations, useReducedMotion } from "@/features/shell";
import { useNodeEnv } from "./context";
import { StateBody, StateMarks, formatNumber } from "./states";
import { NodeTitleBar } from "./titlebar";
import { formatParts } from "./format";
import { linesCountText, planLines, thirdUnitSentence, type AxisGroup, type LineInput } from "./lines";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };

function niceTime(t: number, span: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return span > 2 * 86400_000 ? `${d.getMonth() + 1}/${d.getDate()}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function axisText(v: number, a: AxisGroup | undefined, top: boolean): string {
  const f: ValueFormat | undefined = a?.format;
  if (!a?.unit && f && f !== "number") {
    const p = formatParts(v, f, f === "percent" || f === "celsius" ? 0 : undefined);
    return `${p.text}${p.unit && (top || f === "seconds") ? ` ${p.unit}` : ""}`;
  }
  // Large plain numbers are written short ("13.6M"), so a right-hand axis never runs out of room.
  const n = Math.abs(v) >= 10_000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v) : formatNumber(v);
  return `${n}${a?.unit && top ? ` ${a.unit}` : ""}`;
}

export function LinesChartView({ resolved }: P) {
  const { status } = useNodeEnv();
  const reduced = useReducedMotion();
  const lines = (Array.isArray(resolved.lines) ? resolved.lines : []) as LineInput[];
  const plan = useMemo(() => planLines(lines), [lines]);
  const kind = resolved.kind === "area" || resolved.kind === "bars" ? resolved.kind : "line";
  const height = typeof resolved.height === "number" ? resolved.height : 200;
  const [measured, setMeasured] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const figRef = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setMeasured(Math.round(e!.contentRect.width)));
    ro.observe(el);
    observer.current = ro;
  }, []);
  const right = plan.axes.length > 1;
  const W = Math.max(160, measured ?? 600), H = height, padL = 44, padR = right ? 64 : 8, padT = 8, padB = 22;

  const geo = useMemo(() => {
    let tMin = Infinity, tMax = -Infinity;
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const s of plan.series) for (const [t, v] of s.points) {
      if (!Number.isFinite(t)) continue;
      tMin = Math.min(tMin, t);
      tMax = Math.max(tMax, t);
      if (v !== null && Number.isFinite(v)) {
        lo[s.axis] = Math.min(lo[s.axis]!, v);
        hi[s.axis] = Math.max(hi[s.axis]!, v);
      }
    }
    if (!Number.isFinite(tMin)) return null;
    const range = [0, 1].map((a) => {
      let mn = lo[a]!, mx = hi[a]!;
      if (!Number.isFinite(mn)) { mn = 0; mx = 1; }
      if (kind !== "line") mn = Math.min(0, mn);
      if (mx === mn) mx = mn + 1;
      return { mn, mx };
    });
    const x = (t: number) => padL + ((t - tMin) / (tMax - tMin || 1)) * (W - padL - padR);
    const y = (v: number, a: 0 | 1) => padT + (1 - (v - range[a]!.mn) / (range[a]!.mx - range[a]!.mn)) * (H - padT - padB);
    return { tMin, tMax, range, x, y };
  }, [plan, kind, H, W, padR]);

  const lastT = useRef<number | null>(null);
  const [slide, setSlide] = useState(0);
  useEffect(() => {
    if (!geo) return;
    const prev = lastT.current;
    lastT.current = geo.tMax;
    if (reduced || prev === null || geo.tMax <= prev) return;
    setSlide(geo.x(geo.tMax) - geo.x(Math.max(geo.tMin, prev)));
    const id = requestAnimationFrame(() => setSlide(0));
    return () => cancelAnimationFrame(id);
  }, [geo, reduced]);

  // Loading, empty and blocked states replace the body only when no line has anything to draw yet.
  const body = plan.series.length ? null : StateBody({ status, height });
  const unitWords = (a: AxisGroup | undefined) => (a ? a.unit || (a.format && a.format !== "number" ? formatParts(1, a.format).unit || a.format : "") : "");
  const canPercent = plan.axes.every((a) => a.format === "percent" || a.unit === "%");
  return (
    <section data-slot="root" className="atr-surface atr-data canvas-surface atr-chart-root" data-status={status.kind} data-lines-chart={lines.length} data-axes={plan.axes.length}>
      <NodeTitleBar />
      <StateMarks status={status} showUpdated={resolved.showUpdated === true} />
      {body ?? (
        <>
          <figure ref={figRef} className="atr-chart" aria-label={`Chart, ${linesCountText(plan.series.length, plan.total)}${plan.axes.map((a, i) => (unitWords(a) ? `, ${i ? "right" : "left"} axis in ${unitWords(a)}` : "")).join("")}`}>
            {geo ? (
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} role="img" aria-hidden data-chart-width={W}>
                <g data-slot="axis" className="atr-axis">
                  {[0, 0.5, 1].map((f) => {
                    const v0 = geo.range[0]!.mn + (geo.range[0]!.mx - geo.range[0]!.mn) * f;
                    const v1 = geo.range[1]!.mn + (geo.range[1]!.mx - geo.range[1]!.mn) * f;
                    return (
                      <g key={f}>
                        <line x1={padL} x2={W - padR} y1={geo.y(v0, 0)} y2={geo.y(v0, 0)} className="atr-gridline" />
                        <text x={padL - 6} y={geo.y(v0, 0) + 4} textAnchor="end" data-axis-left>{axisText(v0, plan.axes[0], f === 1)}</text>
                        {right ? <text x={W - padR + 6} y={geo.y(v1, 1) + 4} textAnchor="start" data-axis-right>{axisText(v1, plan.axes[1], f === 1)}</text> : null}
                      </g>
                    );
                  })}
                  <text x={padL} y={H - 6}>{niceTime(geo.tMin, geo.tMax - geo.tMin)}</text>
                  <text x={W - padR} y={H - 6} textAnchor="end">{niceTime(geo.tMax, geo.tMax - geo.tMin)}</text>
                </g>
                <g data-chart-plot style={{ transform: `translateX(${slide}px)`, transition: slide === 0 && !reduced ? `transform ${durations.tick.ms}ms ${durations.tick.css}` : "none" }}>
                  {plan.series.map((s, i) => {
                    if (kind === "bars") {
                      const pts = s.points.filter(([, v]) => v !== null && Number.isFinite(v));
                      const n = plan.series.length;
                      const bw = Math.max(1, ((W - padL - padR) / Math.max(1, s.points.length)) / Math.max(1, n) - 1);
                      const base = geo.y(Math.max(0, geo.range[s.axis]!.mn), s.axis);
                      return (
                        <g key={s.key} data-series={s.key} data-series-label={s.name} data-axis={s.axis}>
                          {pts.map(([t, v], j) => (
                            <rect key={j} x={geo.x(t) + i * bw - (bw * n) / 2} y={Math.min(geo.y(v!, s.axis), base)} width={bw} height={Math.abs(base - geo.y(v!, s.axis))} fill={s.stroke} />
                          ))}
                        </g>
                      );
                    }
                    const segs: string[] = [];
                    let cur = "";
                    for (const [t, v] of s.points) {
                      if (v === null || !Number.isFinite(v)) {
                        if (cur) segs.push(cur);
                        cur = "";
                        continue;
                      }
                      cur += `${cur ? "L" : "M"}${geo.x(t).toFixed(1)},${geo.y(v, s.axis).toFixed(1)}`;
                    }
                    if (cur) segs.push(cur);
                    const pts = s.points.filter(([t, v]) => Number.isFinite(t) && v !== null && Number.isFinite(v)) as [number, number][];
                    return (
                      <g key={s.key} data-series={s.key} data-series-label={s.name} data-axis={s.axis} data-segments={segs.length}>
                        {kind === "area" && pts.length > 1 ? (
                          <path
                            d={`${pts.map(([t, v], j) => `${j ? "L" : "M"}${geo.x(t).toFixed(1)},${geo.y(v, s.axis).toFixed(1)}`).join("")}L${geo.x(pts[pts.length - 1]![0]).toFixed(1)},${geo.y(Math.max(geo.range[s.axis]!.mn, 0), s.axis).toFixed(1)}L${geo.x(pts[0]![0]).toFixed(1)},${geo.y(Math.max(geo.range[s.axis]!.mn, 0), s.axis).toFixed(1)}Z`}
                            fill={s.stroke}
                            opacity={plan.series.length > 1 ? 0.1 : 0.18}
                            data-area-fill
                          />
                        ) : null}
                        {segs.map((d, j) => (
                          <path key={j} d={d} fill="none" stroke={s.stroke} strokeWidth={2} strokeDasharray={s.dash || undefined} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
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
          {plan.refused.length ? (
            <p role="note" className="atr-chart-refusal" data-third-unit={plan.refused.join(" ")}>
              {thirdUnitSentence(canPercent)}
            </p>
          ) : null}
          {resolved.legend !== false ? (
            <div data-slot="legend" className="atr-legend">
              <span className="atr-legend-count" data-series-count={plan.total} data-series-drawn={plan.series.length}>
                {linesCountText(plan.series.length, plan.total)}
              </span>
              <ul>
                {plan.series.map((s) => (
                  <li key={s.key} data-drawn="" data-legend-line={s.line} data-legend-axis={s.axis}>
                    <svg width="18" height="8" aria-hidden>
                      <line x1="0" x2="18" y1="4" y2="4" stroke={s.stroke} strokeWidth="2.5" strokeDasharray={s.dash || undefined} />
                    </svg>
                    {s.name}
                    {right ? <span className="atr-legend-axis">{s.axis ? " (right)" : " (left)"}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
