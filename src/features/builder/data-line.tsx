"use client";
// The inspector's data parts for Wave 2.9 (direct-data-spec.md 3.3 to 3.5): the one Data line with the
// component's own refresh ("CPU in use, pve1 · 7.8 % · Proxmox [Change]", then "Refresh: every 30 s"), a chart's lines
// (name, colour, hide, remove, Add a line, and the Also for and Also show chips), and the stats of a service
// tile or the readings of a resource bar, each swappable through "What should this show?".
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueResponse, ComponentNode, DataSourceDef, DraftOp, PropValue, ShapedData } from "@/core/contracts";
import { evaluateTemplate, isBinding } from "@/features/components/bindings";
import { formatValue, templateFormat } from "@/features/components/render/format";
import { SelectMenu } from "@/features/settings/ui/controls";
import { nodeRefresh, refreshChoices, secWords, REFRESH_FLOOR } from "@/features/apps/managed";
import { choiceParams, EVERY, everyWords } from "./data-pick";
import { liveWords, type BindableIntegration } from "./data-picker";
import { addLineOps, axisGroups, chartLines, thirdUnitRefusal, type LineUnit, type PickItem } from "./direct-data";

type Live = { data: Record<string, ShapedData | undefined> };
const btn = "inline-flex min-h-8 items-center type-caption underline touch:min-h-11";
const pill = "inline-flex min-h-8 items-center gap-1 border border-line-strong px-2 type-caption hover:bg-bg-sunk touch:min-h-11";
const chip = "inline-flex min-h-8 items-center border border-line px-2 type-caption hover:bg-fg hover:text-bg touch:min-h-11";
const field = "h-8 w-full min-w-0 border border-line-strong bg-bg-hi px-2 type-body text-fg outline-none focus-visible:outline-2 focus-visible:outline-accent-ink touch:h-11";
const SRC = /\{\{\s*([a-z][a-z0-9_]*)/;

/** The default and minimum refresh of a source's read, from the bindable listing. */
export function timingOf(def: Pick<DataSourceDef, "integrationId" | "endpointId">, bindable: BindableIntegration[]): { defaultRefreshSec: number; minRefreshSec: number } | null {
  const e = bindable.find((b) => b.integrationId === def.integrationId)?.endpoints.find((x) => x.id === def.endpointId);
  return e ? { defaultRefreshSec: e.defaultRefreshSec, minRefreshSec: e.minRefreshSec } : null;
}

/** A template's current value in a few words, formatted when its data says how (A8.4). */
export function valueWords(template: string, live: Live | undefined): string | null {
  const name = SRC.exec(template)?.[1];
  const d = name ? live?.data[name] : undefined;
  if (!d) return null;
  if (new RegExp(String.raw`^\{\{\s*${name}(\.(rows|items))?\s*\}\}$`).test(template.trim())) return liveWords(d);
  const scope = { $data: live!.data, $page: { id: "", slug: "", title: "" }, $app: { id: "", slug: "", name: "" }, $user: { kind: "user" as const } };
  const r = evaluateTemplate(template, scope as never);
  if (!r.ok || r.value === undefined || r.value === null || typeof r.value === "object") return null;
  const f = templateFormat(template, scope as never);
  return typeof r.value === "number" && f && f !== "number" ? formatValue(r.value, f) : String(r.value).slice(0, 40);
}

/**
 * The Refresh control (Wave 2.10b F5; spec 3.3 before it): a visible label and the current rate, opening the
 * presets. Presets faster than the read allows stay listed, disabled, with the reason. The component owns its
 * refresh: a managed source runs at the fastest of its components (A10.1); a source a person made keeps its
 * own interval, so the menu sets that.
 */
export function RefreshControl({ node, def, bindable, apply }: { node: ComponentNode; def: DataSourceDef; bindable: BindableIntegration[]; apply(ops: DraftOp[]): void }) {
  const [open, setOpen] = useState(false);
  const t = timingOf(def, bindable);
  const min = Math.max(REFRESH_FLOOR, t?.minRefreshSec ?? REFRESH_FLOOR);
  const sec = def.managed ? nodeRefresh(node, def, t) : def.refreshSec;
  const choices = refreshChoices(min);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
    window.addEventListener("pointerdown", off);
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("pointerdown", off); window.removeEventListener("keydown", esc, true); };
  }, [open]);
  const choose = (s: number) => {
    setOpen(false);
    if (def.managed) apply([{ op: "node.update", nodeId: node.id, patch: { refreshSec: s } }]);
    else apply([{ op: "source.set", source: { ...def, refreshSec: s } }]);
  };
  return (
    <span ref={ref} className="relative inline-flex items-center gap-2" data-refresh={sec}>
      <span className="type-caption text-fg-2" aria-hidden>Refresh</span>
      <button type="button" className={pill} aria-label={`Refresh: every ${secWords(sec)}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-refresh-change>
        every {secWords(sec)}
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      {open && (
        <span role="menu" className="absolute left-0 top-full z-20 flex w-60 flex-col border border-line-strong bg-bg-hi p-1 shadow-window-sm" data-refresh-menu>
          {choices.map((c) => (
            <button key={c.sec} type="button" role="menuitemradio" aria-checked={c.sec === sec} disabled={c.disabled} className={`flex min-h-8 items-center px-2 text-left type-caption hover:bg-bg-sunk disabled:cursor-not-allowed disabled:text-fg-2 disabled:opacity-60 disabled:hover:bg-transparent touch:min-h-11 ${c.sec === sec ? "font-medium" : ""}`} onClick={() => choose(c.sec)} data-refresh-option={c.sec} data-refresh-disabled={c.disabled ? "yes" : undefined}>{c.label}{c.sec === sec ? " (now)" : ""}</button>
          ))}
          {choices.some((c) => c.disabled) && <span className="px-2 py-1 type-caption text-fg-2" data-refresh-min>This service allows every {secWords(min)} at most.</span>}
        </span>
      )}
    </span>
  );
}

/**
 * The one Data line (Wave 2.10b F3; spec 3.3 before it): what it shows, its value and its service on one
 * readable line ("CPU in use, pve1 · 7.8 % · Proxmox") with Change, and the Refresh control under it.
 */
export function DataLine({ node, def, template, prop, bindable, live, apply, onChange }: { node: ComponentNode; def: DataSourceDef; template: string; prop: string; bindable: BindableIntegration[]; live?: Live; apply(ops: DraftOp[]): void; onChange(prop: string): void }) {
  const integ = bindable.find((b) => b.integrationId === def.integrationId);
  const e = integ?.endpoints.find((x) => x.id === def.endpointId);
  const what = def.label?.trim() || e?.label || def.name;
  const value = valueWords(template, live);
  return (
    <span className="flex flex-col gap-1" data-data-line={def.name} data-managed={def.managed ? "yes" : "no"}>
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 type-body" data-data-line-words>{[what, value, integ?.integrationName].filter(Boolean).join(" · ")}</span>
        <button type="button" className={`${btn} flex-none`} onClick={() => onChange(prop)} data-data-change>Change</button>
      </span>
      <RefreshControl node={node} def={def} bindable={bindable} apply={apply} />
    </span>
  );
}

const COLORS = ["series1", "series2", "series3", "series4", "series5", "series6", "series7", "series8"];

type Line = { data: { $bind: string }; label?: string; color?: string; hidden?: boolean };

/** A chart's lines (spec 3.4): name, colour, Hide, Remove, Add a line, then Also for and Also show. */
export function ChartLinesEditor({ node, doc, bindable, live, apply, onPick }: { node: ComponentNode; doc: { dataSources: DataSourceDef[] }; bindable: BindableIntegration[]; live?: Live; apply(ops: DraftOp[]): void; onPick(prop: string): void }) {
  const lines = chartLines(node) as Line[];
  const write = (next: Line[]) => apply([{ op: "node.update", nodeId: node.id, patch: { props: { ...node.props, data: null, lines: next as unknown as PropValue } } } as DraftOp]);
  const srcOf = (l: Line) => doc.dataSources.find((s) => s.name === SRC.exec(l.data.$bind)?.[1]);
  const last = lines.length ? srcOf(lines[lines.length - 1]!) : undefined;
  return (
    <div className="flex flex-col gap-2" data-chart-lines={lines.length}>
      <span className="type-caption font-medium">Lines</span>
      {lines.length === 0 && <p className="type-caption m-0 text-fg-2">No lines yet. Add one to show values over time.</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {lines.map((l, i) => {
          const src = srcOf(l);
          const d = src ? live?.data[src.name] : undefined;
          const count = d?.kind === "series" ? d.series.length : 0;
          return (
            <li key={i} className={`flex flex-col gap-1 border border-line p-2 ${l.hidden ? "opacity-60" : ""}`} data-chart-line={i}>
              <LineName value={l.label ?? ""} placeholder={src?.label ?? "Line name"} onSave={(v) => write(lines.map((x, j) => (j === i ? { ...x, ...(v ? { label: v } : { label: undefined }) } : x)))} index={i} />
              <span className="type-caption text-fg-2" data-chart-line-words>{src?.label ?? src?.name ?? "no data"}{count > 1 ? `, ${count > 20 ? `20 of ${count}` : count} lines` : ""}</span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-28 flex-1" data-line-color={i}>
                  <SelectMenu label={`Colour of line ${i + 1}`} hideLabel name={`line-color-${i}`} value={l.color ?? "auto"} onChange={(v) => write(lines.map((x, j) => (j === i ? { ...x, color: v === "auto" ? undefined : v } : x)))} options={[{ value: "auto", label: "Next theme colour" }, ...COLORS.map((c, n) => ({ value: c, label: `Theme colour ${n + 1}` }))]} />
                </span>
                <button type="button" className={btn} aria-pressed={!!l.hidden} onClick={() => write(lines.map((x, j) => (j === i ? { ...x, hidden: !x.hidden || undefined } : x)))} data-line-hide={i}>{l.hidden ? "Show" : "Hide"}</button>
                <button type="button" className={`${btn} text-bad`} onClick={() => write(lines.filter((_, j) => j !== i))} data-line-remove={i}>Remove</button>
              </span>
            </li>
          );
        })}
      </ul>
      {lines.length < 12 && <button type="button" className={`${chip} self-start`} onClick={() => onPick("lines")} data-add-line>Add a line</button>}
      {last?.managed && <AlsoChips node={node} doc={doc} src={last} lines={lines} bindable={bindable} live={live} apply={apply} />}
    </div>
  );
}

function LineName({ value, placeholder, onSave, index }: { value: string; placeholder: string; onSave(v: string): void; index: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = () => { const t = v.trim().slice(0, 80); if (t !== value) onSave(t); };
  return <input className={field} value={v} placeholder={placeholder} aria-label={`Name of line ${index + 1}`} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") save(); }} data-line-name={index} />;
}

type Choice = { value: string; label: string };

/**
 * After a per-thing read (spec 3.4): Also for (the same read for other things, plus Every ...) and Also
 * show (other reads for the same thing). Chips that would need a third axis are left out.
 */
function AlsoChips({ node, doc, src, lines, bindable, live, apply }: { node: ComponentNode; doc: { dataSources: DataSourceDef[] }; src: DataSourceDef; lines: Line[]; bindable: BindableIntegration[]; live?: Live; apply(ops: DraftOp[]): void }) {
  const ep = bindable.find((b) => b.integrationId === src.integrationId)?.endpoints.find((e) => e.id === src.endpointId);
  const valueEp = bindable.find((b) => b.integrationId === src.integrationId)?.endpoints.find((e) => e.id === src.endpointId.replace(/^h:/, ""));
  const param = choiceParams(ep?.params ?? valueEp?.params)[0];
  const current = param ? src.params?.[param.key] : undefined;
  const [things, setThings] = useState<{ choices: Choice[]; every: boolean } | null>(null);
  const [reads, setReads] = useState<CatalogueResponse["items"] | null>(null);
  useEffect(() => {
    setThings(null);
    if (!param || typeof current !== "string" || current === EVERY) return;
    let live = true;
    const q = new URLSearchParams({ integrationId: src.integrationId, endpointId: src.endpointId, param: param.key });
    fetch(`/api/data/choices?${q}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((j: { choices?: Choice[]; every?: boolean } | null) => { if (live && j?.choices) setThings({ choices: j.choices, every: !!j.every }); }).catch(() => {});
    return () => { live = false; };
  }, [src.integrationId, src.endpointId, param?.key, String(current)]);
  useEffect(() => {
    setReads(null);
    if (!param || typeof current !== "string" || current === EVERY) return;
    let live = true;
    fetch(`/api/data/catalogue?${new URLSearchParams({ integrationId: src.integrationId, fits: "chart", limit: "200" })}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((j: CatalogueResponse | null) => { if (live && j) setReads(j.items); }).catch(() => {});
    return () => { live = false; };
  }, [src.integrationId, param?.key, String(current)]);
  const units = useMemo(() => lines.map((l) => { const d = live?.data[SRC.exec(l.data.$bind)?.[1] ?? ""]; return (d && (d.kind === "series" || d.kind === "stat") ? { format: d.format, unit: d.unit } : {}) as LineUnit; }), [lines, live]);
  if (!param || typeof current !== "string" || current === EVERY) return null;
  const readLabel = valueEp?.label ?? ep?.label ?? "";
  const used = new Set(lines.map((l) => SRC.exec(l.data.$bind)?.[1]).map((n) => doc.dataSources.find((s) => s.name === n)).filter(Boolean).map((s) => JSON.stringify([s!.endpointId, s!.params?.[param.key]])));
  const addFor = (value: string, label: string) => {
    const item: PickItem = { integrationId: src.integrationId, endpointId: src.endpointId, params: { ...(src.params ?? {}), [param.key]: value }, label: readLabel, shape: "series", thing: { param: param.key, value, label }, defaultRefreshSec: ep?.defaultRefreshSec ?? 60, minRefreshSec: ep?.minRefreshSec ?? 10 };
    apply(lineOps(node, doc, item));
  };
  const others = (things?.choices ?? []).filter((c) => c.value !== current && !used.has(JSON.stringify([src.endpointId, c.value])));
  const sameThing = (reads ?? []).filter((it) => it.thing && it.thing.param === param.key && it.thing.value === current && (it.shape === "series" || it.history) && it.endpointId !== src.endpointId.replace(/^h:/, "") && it.endpointId !== src.endpointId)
    .filter((it) => !used.has(JSON.stringify([it.history?.endpointId ?? it.endpointId, current])))
    .filter((it) => !it.format || !thirdUnitRefusal(units.filter((u) => u.format || u.unit), { format: it.format }, it.label));
  if (!others.length && !things?.every && !sameThing.length) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2" data-also>
      {(others.length > 0 || things?.every) && (
        <div className="flex flex-col gap-1">
          <span className="type-caption text-fg-2">Also for</span>
          <div className="flex flex-wrap gap-1">
            {others.slice(0, 12).map((c) => <button key={c.value} type="button" className={chip} onClick={() => addFor(c.value, c.label)} data-also-for={c.value}>{c.label}</button>)}
            {things?.every && !used.has(JSON.stringify([src.endpointId, EVERY])) && <button type="button" className={chip} onClick={() => addFor(EVERY, everyWords(param.title).replace(/^Every /, "every "))} data-also-for={EVERY}>{everyWords(param.title)}</button>}
          </div>
        </div>
      )}
      {sameThing.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="type-caption text-fg-2">Also show</span>
          <div className="flex flex-wrap gap-1">
            {sameThing.slice(0, 10).map((it) => <button key={it.key} type="button" className={chip} onClick={() => apply(lineOps(node, doc, it))} data-also-show={it.endpointId}>{it.label}</button>)}
          </div>
        </div>
      )}
    </div>
  );
}

/** The ops for one more line on this node (managed source plus the node's new lines). */
function lineOps(node: ComponentNode, doc: { dataSources: DataSourceDef[] }, item: PickItem): DraftOp[] {
  const fake = { format: "atrium-app", formatVersion: 1, app: { name: "", homePage: "p", pageOrder: ["p"] }, theme: { themeId: "x" }, chrome: { layout: "none" }, dataSources: doc.dataSources, controls: [], pages: [{ id: "p", slug: "p", title: "p", inNav: true, root: { id: "r", type: "grid", props: {}, children: [node] } }] } as never;
  return addLineOps(fake, node.id, item)?.ops ?? [];
}

/** A tile's stats or a resource bar's readings (spec 3.5, 3.6): each swappable, removable, up to the limit. */
export function ListDataEditor({ node, list, max, doc, bindable, live, apply, onPick, noun }: { node: ComponentNode; list: "stats" | "items"; max: number; doc: { dataSources: DataSourceDef[] }; bindable: BindableIntegration[]; live?: Live; apply(ops: DraftOp[]): void; onPick(prop: string): void; noun: string }) {
  const entries = (Array.isArray(node.props[list]) ? node.props[list] : []) as { label?: string; value?: PropValue }[];
  const status = node.type === "service-tile" && isBinding(node.props.status) ? node.props.status : null;
  const statusSrc = status ? doc.dataSources.find((s) => s.name === SRC.exec(status.$bind)?.[1]) : undefined;
  const write = (next: typeof entries) => apply([{ op: "node.update", nodeId: node.id, patch: { props: { ...node.props, [list]: next as unknown as PropValue } } } as DraftOp]);
  return (
    <div className="flex flex-col gap-2" data-list-data={list}>
      {node.type === "service-tile" && (
        <span className="flex flex-wrap items-center gap-x-1 type-caption" data-tile-status>
          <span>Status: {statusSrc?.label ?? (status ? "custom" : "none")}{status && valueWords(status.$bind, live) ? `, ${valueWords(status.$bind, live)}` : ""}{statusSrc ? "," : ""}</span>
          {statusSrc && <RefreshControl node={node} def={statusSrc} bindable={bindable} apply={apply} />}
          <button type="button" className={btn} onClick={() => onPick("status")} data-tile-status-change>Change</button>
        </span>
      )}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {entries.map((s, i) => {
          const t = isBinding(s.value) ? s.value.$bind : null;
          const v = t ? valueWords(t, live) : s.value === undefined || s.value === null ? null : String(s.value);
          return (
            <li key={i} className="flex flex-wrap items-center gap-x-2 border border-line px-2 py-1" data-list-entry={i}>
              <span className="type-caption min-w-0 flex-1 truncate" data-list-entry-words>{s.label || `${noun} ${i + 1}`}{v ? `: ${v}` : ""}</span>
              <button type="button" className={btn} onClick={() => onPick(`${list}.${i}.value`)} data-list-entry-change={i}>Change</button>
              <button type="button" className={`${btn} text-bad`} onClick={() => write(entries.filter((_, j) => j !== i))} data-list-entry-remove={i}>Remove</button>
            </li>
          );
        })}
      </ul>
      {entries.length < max && <button type="button" className={`${chip} self-start`} onClick={() => onPick(`${list}.${entries.length}.value`)} data-list-add={list}>Add a {noun.toLowerCase()}</button>}
    </div>
  );
}

export { axisGroups };
