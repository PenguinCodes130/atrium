"use client";
// Data components (spec 3.1.3): stat, table, list, status, gauge and progress. Each shows the data
// states (states.tsx). Status never relies on colour alone: shape and word as well.
import type { ComponentNode, RenderContext, ShapedData } from "@/core/contracts";
import { text as textOf } from "../bindings";
import { useNodeEnv } from "./context";
import { StateBody, StateMarks, formatNumber, useTickNumber } from "./states";
import { NodeTitleBar } from "./titlebar";
import { nodeSources } from "./resolve";
import { shapeMismatch } from "./rollup";
import { formatParts, templateFormat } from "./format";
import type { PageScope } from "./resolve";
import type { ValueFormat } from "@/core/contracts";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string => textOf(v);
const shaped = <K extends ShapedData["kind"]>(v: unknown, kind: K): Extract<ShapedData, { kind: K }> | null =>
  v && typeof v === "object" && (v as { kind?: unknown }).kind === kind ? (v as Extract<ShapedData, { kind: K }>) : null;

export function level(value: number | null, warn: number | null, bad: number | null): "ok" | "warn" | "bad" {
  if (value === null) return "ok";
  if (bad !== null && value >= bad) return "bad";
  if (warn !== null && value >= warn) return "warn";
  return "ok";
}

/** The calm "wrong shape" body (Fix 14), in place of an empty window. */
export function MismatchBody({ message }: { message: string }) {
  return (
    <div role="status" className="atr-state atr-state-mismatch" data-shape-mismatch>
      <span className="atr-state-title">Not the right kind of data</span>
      <span className="atr-state-detail">{message}</span>
    </div>
  );
}
export const MISMATCH_WORD = { word: "check data", tone: "warn" } as const;

function Frame({ children, label, showUpdated, flush, data }: { children: React.ReactNode; label?: string; showUpdated?: boolean; flush?: boolean; data?: unknown }) {
  const { status, node, scope } = useNodeEnv();
  // The data source it reads, named in the wrong-shape message.
  const src = nodeSources(node, scope)[0];
  const body = StateBody({ status });
  const mismatch = body ? null : shapeMismatch(node.type, data, src);
  return (
    <section data-slot="root" className={`atr-surface atr-data canvas-surface ${flush ? "canvas-surface-flush" : ""}`} aria-label={label || undefined} data-status={status.kind}>
      <NodeTitleBar fallback={label} word={mismatch ? MISMATCH_WORD : undefined} />
      <StateMarks status={status} showUpdated={showUpdated} />
      {body ?? (mismatch ? <MismatchBody message={mismatch} /> : children)}
    </section>
  );
}

// ---------- stat ----------

/** Words that are not a label: Prometheus's raw series text ({host="ACE"}) or the word "value". */
const RAW_LABEL = /^(value|result)?$|[{}="]/;

/** A stat's label when the author left it blank (A8.5): the data's own words, else the read's name in words. */
export function readLabel(dataLabel: string | undefined, node: ComponentNode, scope: PageScope): string {
  if (dataLabel && !RAW_LABEL.test(dataLabel.trim())) return dataLabel;
  const labels = (scope as { $sourceLabels?: Record<string, string> }).$sourceLabels ?? {};
  for (const src of nodeSources(node, scope)) if (labels[src]) return labels[src]!;
  return dataLabel && !/^value$/i.test(dataLabel) ? dataLabel : "";
}

/** The format of the value a prop's binding reads (A8.4), or null. */
export function boundFormat(node: ComponentNode, prop: string, scope: PageScope): ValueFormat | null {
  const v = node.props[prop];
  return v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bind?: unknown }).$bind === "string" ? templateFormat((v as { $bind: string }).$bind, scope as never) : null;
}

export function StatView({ resolved }: P) {
  const data = shaped(resolved.data, "stat");
  // A plain number or text as the data is the value itself (the saved "Server card" holds data: 42, Fix 4).
  const plain = typeof resolved.data === "number" || typeof resolved.data === "string" ? resolved.data : undefined;
  const raw = resolved.value ?? data?.value ?? plain;
  const n = num(raw);
  const shown = useTickNumber(n);
  const { node, scope } = useNodeEnv();
  const label = str(resolved.label) || readLabel(data?.label, node, scope);
  const ownUnit = resolved.unit !== undefined && resolved.unit !== "" ? str(resolved.unit) : "";
  // A8.4: with no unit set by the author, a value whose data names its format is shown formatted.
  const format = ownUnit ? null : resolved.value !== undefined ? boundFormat(node, "value", scope) : data ? (data.format ?? null) : boundFormat(node, "data", scope);
  const warn = num(resolved.warn) ?? data?.thresholds?.warn ?? null;
  const bad = num(resolved.bad) ?? data?.thresholds?.bad ?? null;
  const lv = level(n, warn, bad);
  const delta = (resolved.delta ?? data?.delta) as { value?: unknown; period?: unknown } | undefined;
  const dv = num(delta?.value);
  const decimals = num(resolved.decimals) ?? undefined;
  const fmt = (v: number) => (format && format !== "number" ? formatParts(v, format, format === "percent" || format === "celsius" ? decimals : undefined) : { text: formatNumber(v, decimals), unit: ownUnit || (data?.unit ?? "") });
  const unit = n !== null ? fmt(n).unit : ownUnit || (data?.unit ?? "");
  const valueText = n !== null && shown !== null ? fmt(shown).text : str(raw);
  const finalText = n !== null ? fmt(n).text : str(raw);
  return (
    <Frame label={label} showUpdated={resolved.showUpdated === true} data={resolved.value === undefined ? resolved.data : undefined}>
      <div className="atr-stat" data-level={lv}>
        <div className="atr-stat-line">
          <span data-slot="value" className="atr-stat-value" aria-hidden {...(n === null && valueText ? { "data-text-value": "", title: valueText, style: { ["--atr-chars" as string]: Math.max(3, valueText.length) } } : {})}>
            {valueText}
          </span>
          <span className="sr-only">{`${finalText}${unit ? ` ${unit}` : ""}${lv !== "ok" ? `, ${lv === "bad" ? "bad" : "warning"}` : ""}`}</span>
          {unit ? (
            <span data-slot="unit" className="atr-stat-unit" aria-hidden>
              {unit}
            </span>
          ) : null}
          {lv !== "ok" ? <span className="atr-level-word" aria-hidden>{lv === "bad" ? "bad" : "warn"}</span> : null}
        </div>
        {label ? (
          <span data-slot="label" className="atr-stat-label">
            {label}
          </span>
        ) : null}
        {dv !== null ? (
          <span data-slot="delta" className="atr-stat-delta" data-dir={dv > 0 ? "up" : dv < 0 ? "down" : "flat"}>
            <span aria-hidden>{dv > 0 ? "▲" : dv < 0 ? "▼" : "■"}</span> {`${dv > 0 ? "+" : ""}${formatNumber(dv)}${delta?.period ? ` / ${str(delta.period)}` : ""}`}
          </span>
        ) : null}
      </div>
    </Frame>
  );
}

// ---------- table ----------

function Cell({ type, value, format }: { type: string; value: unknown; format?: ValueFormat }) {
  if (type === "status") {
    const s = str(value).toLowerCase();
    const state = s === "up" || s === "ok" || s === "running" ? "up" : s === "down" || s === "error" || s === "stopped" ? "down" : s === "warn" || s === "warning" || s === "degraded" ? "warn" : "unknown";
    return (
      <span className="atr-status-inline" data-state={state}>
        <span aria-hidden className="atr-shape" data-state={state} />
        {str(value)}
      </span>
    );
  }
  if (type === "link") {
    const href = str(value);
    if (/^https?:\/\//i.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="atr-link">
          {href.replace(/^https?:\/\//i, "")}
        </a>
      );
    }
    return <span>{href}</span>;
  }
  if (type === "number" || format) {
    const n = num(value);
    if (n !== null && format && format !== "number") {
      const p = formatParts(n, format);
      return <span className="atr-num">{p.unit ? `${p.text} ${p.unit}` : p.text}</span>;
    }
    if (type !== "number") return <span>{str(value)}</span>;
    return <span className="atr-num">{n === null ? str(value) : formatNumber(n)}</span>;
  }
  if (type === "time") {
    const t = typeof value === "number" ? value : Date.parse(str(value));
    return <time className="atr-num">{Number.isFinite(t) ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : str(value)}</time>;
  }
  return <span>{str(value)}</span>;
}

export function TableView({ resolved }: P) {
  const data = shaped(resolved.data, "table");
  const keep = Array.isArray(resolved.columns) && resolved.columns.length ? (resolved.columns as string[]) : null;
  const cols = data ? (keep ? keep.map((k) => data.columns.find((c) => c.key === k)).filter((c): c is NonNullable<typeof c> => !!c) : data.columns) : [];
  const max = num(resolved.maxRows) ?? 20;
  const rows = data ? data.rows.slice(0, max) : [];
  const total = data ? (typeof data.total === "number" ? data.total : data.rows.length) : 0;
  return (
    <Frame showUpdated={resolved.showUpdated === true} flush data={resolved.data}>
      <div className="atr-table-wrap">
        <table className="atr-table">
          <thead data-slot="header">
            <tr>
              {cols.map((c) => (
                <th key={c.key} scope="col" data-type={c.type}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-slot="row">
                {cols.map((c) => (
                  <td key={c.key} data-slot="cell" data-type={c.type}>
                    <Cell type={c.type} value={r[c.key]} {...(c.format ? { format: c.format } : {})} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="atr-count" data-row-count={total}>
        {rows.length < total ? `${rows.length} of ${formatNumber(total)} rows` : `${formatNumber(total)} ${total === 1 ? "row" : "rows"}`}
      </p>
    </Frame>
  );
}

// ---------- list ----------

export function ListView({ resolved }: P) {
  const v = resolved.items;
  const list: unknown[] = Array.isArray(v) ? v : v && typeof v === "object" ? (((v as { rows?: unknown[] }).rows ?? (v as { items?: unknown[] }).items ?? []) as unknown[]) : [];
  const max = num(resolved.maxItems) ?? 10;
  const labelKey = str(resolved.labelKey);
  const detailKey = str(resolved.detailKey);
  const labelOf = (el: unknown): string => {
    if (el === null || typeof el !== "object") return str(el);
    const o = el as Record<string, unknown>;
    if (labelKey && labelKey in o) return str(o[labelKey]);
    if ("label" in o) return str(o.label);
    if ("name" in o) return str(o.name);
    const first = Object.values(o).find((x) => typeof x === "string");
    return str(first);
  };
  return (
    <Frame showUpdated={resolved.showUpdated === true}>
      {list.length ? (
        <ul className="atr-list">
          {list.slice(0, max).map((el, i) => (
            <li key={i} data-slot="item">
              <span className="atr-list-label">{labelOf(el)}</span>
              {detailKey && el && typeof el === "object" ? (
                <span data-slot="detail" className="atr-list-detail">
                  {str((el as Record<string, unknown>)[detailKey])}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="atr-muted">Nothing to show</p>
      )}
    </Frame>
  );
}

// ---------- status ----------

const STATE_WORD: Record<string, string> = { up: "up", down: "down", warn: "warning", unknown: "unknown" };

export function StatusView({ resolved }: P) {
  const data = shaped(resolved.data, "status");
  const items = data?.items ?? [];
  const layout = resolved.layout === "grid" ? "grid" : "list";
  return (
    <Frame showUpdated={resolved.showUpdated === true} data={resolved.data}>
      <ul className="atr-status" data-layout={layout}>
        {items.map((it, i) => {
          const state = ["up", "down", "warn"].includes(it.state) ? it.state : "unknown";
          const label = <span data-slot="label">{it.label}</span>;
          return (
            <li key={i} data-slot="item" data-state={state}>
              <span aria-hidden className="atr-shape" data-state={state} />
              {it.href && /^https?:\/\//i.test(it.href) ? (
                <a href={it.href} target="_blank" rel="noopener noreferrer" className="atr-link">
                  {label}
                </a>
              ) : (
                label
              )}
              <span className="atr-state-word">{STATE_WORD[state]}</span>
              {it.detail ? <span className="atr-status-detail">{it.detail}</span> : null}
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

// ---------- gauge and progress ----------

function bounded(resolved: Record<string, unknown>) {
  const min = num(resolved.min) ?? 0;
  const max = num(resolved.max) ?? 100;
  const value = num(resolved.value);
  const span = max - min || 1;
  const frac = value === null ? 0 : Math.min(1, Math.max(0, (value - min) / span));
  return { min, max, value, frac, lv: level(value, num(resolved.warn), num(resolved.bad)) };
}

/** A gauge's or progress bar's number and unit: the author's unit wins, else the bound value's format (A8.4). */
function useBoundText(resolved: Record<string, unknown>) {
  const { node, scope } = useNodeEnv();
  const own = str(resolved.unit);
  const format = own ? null : boundFormat(node, "value", scope);
  return (v: number) => (format && format !== "number" ? formatParts(v, format) : { text: formatNumber(v), unit: own });
}

export function GaugeView({ resolved }: P) {
  const { min, max, value, frac, lv } = bounded(resolved);
  const shown = useTickNumber(value);
  const fmt = useBoundText(resolved);
  const unit = value !== null ? fmt(value).unit : str(resolved.unit);
  const label = str(resolved.label);
  // A 240 degree arc.
  const r = 42, c = 2 * Math.PI * r, arc = c * (240 / 360);
  return (
    <Frame label={label}>
      <div className="atr-gauge" data-level={lv} role="meter" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value ?? undefined} aria-label={label || "Gauge"} aria-valuetext={value === null ? "no value" : `${fmt(value).text}${unit ? ` ${unit}` : ""}${lv !== "ok" ? `, ${lv === "bad" ? "bad" : "warning"}` : ""}`}>
        <svg viewBox="0 0 100 100" aria-hidden>
          <circle data-slot="track" cx="50" cy="50" r={r} fill="none" strokeWidth="9" strokeDasharray={`${arc} ${c}`} transform="rotate(150 50 50)" className="atr-gauge-track" />
          <circle data-slot="fill" cx="50" cy="50" r={r} fill="none" strokeWidth="9" strokeDasharray={`${arc * frac} ${c}`} transform="rotate(150 50 50)" className="atr-gauge-fill" />
        </svg>
        <span data-slot="value" className="atr-gauge-value">
          {value === null || shown === null ? "–" : fmt(shown).text}
          {unit ? <small>{unit}</small> : null}
        </span>
        {lv !== "ok" ? <span className="atr-level-word">{lv === "bad" ? "bad" : "warn"}</span> : null}
      </div>
      {label ? (
        <span data-slot="label" className="atr-stat-label atr-center">
          {label}
        </span>
      ) : null}
    </Frame>
  );
}

export function ProgressView({ resolved }: P) {
  const { min, max, value, frac, lv } = bounded(resolved);
  const fmt = useBoundText(resolved);
  const unit = value !== null ? fmt(value).unit : str(resolved.unit);
  const label = str(resolved.label);
  return (
    <Frame label={label}>
      <div className="atr-progress-head">
        {label ? <span data-slot="label">{label}</span> : <span />}
        {resolved.showValue !== false ? (
          <span data-slot="value" className="atr-num">
            {value === null ? "–" : `${fmt(value).text}${unit ? ` ${unit}` : ""}`}
            {lv !== "ok" ? <span className="atr-level-word">{lv === "bad" ? " bad" : " warn"}</span> : null}
          </span>
        ) : null}
      </div>
      <div data-slot="track" className="atr-progress" data-level={lv} role="progressbar" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value ?? undefined} aria-label={label || "Progress"}>
        <span data-slot="fill" className="atr-progress-fill" style={{ transform: `scaleX(${frac})` }} />
      </div>
    </Frame>
  );
}
