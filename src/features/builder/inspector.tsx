"use client";
// The inspector frame (design v4 "The Builder", right column, 320px): folded groups in the order Content,
// Data, Control, Layout, Style, Advanced. components provides the Content, Data, Style and Advanced
// panels (InspectorPanels); app-builder adds Control (the app's controls), Layout (the slot on this
// device) and the app's data sources, and owns the frame and the order.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AppDocument, CommandListing, ComponentNode, ControlDef, DataSourceDef, DraftOp, LibraryComponent, Problem, PropValue, RenderContext, ShapedData } from "@/core/contracts";
import { Button } from "@/features/shell";
import { controlsOfNode, findNode, newId, nodeLabel, unmappedPackage } from "@/features/apps/doc";
import { SOURCE_NAME } from "@/features/apps/ops";
import { autoParams, fixedValue, INPUT_BINDING, missingParams, paramRows, sourceOf, targetNames, VIEWER_BINDING, type ParamRow, type ParamSource } from "@/features/apps/control-params";
import { Checkbox, SelectMenu } from "@/features/settings/ui/controls";
import { InspectorHeader, InspectorPanels, measureTableOverflow } from "./components-client";
import { fitWords, overflowRowsOf, overflowXOf, type FitResult } from "./fit-measure";
export type { FitResult };
import { columnsChangeOps, columnsOn, fitOps, neighbourWidth, slotOn, slotOp, toEighth, widthPresets, type Device } from "./geometry";
import { describeTemplate, failedReadReason, otherUsers, repeatAround, rowFields, showsLine, usersOf } from "./data-pick";
import { liveWords } from "./data-picker";
import { ChartLinesEditor, DataLine, ListDataEditor } from "./data-line";
import { evaluateTemplate } from "@/features/components/bindings";
import { formatValue, templateFormat } from "@/features/components/render/format";
import { MoreFold } from "@/features/components/inspector/more";
import type { BindingDescriber } from "@/features/components/inspector/binding-words";
import type { BindableIntegration, PickTarget } from "./data-picker";

import { isBinding, sourcesInTemplate } from "@/features/components/bindings";
import type { SourceData } from "@/features/data/types";

const CONTROL_TYPES = new Set(["button", "toggle", "slider", "select", "html"]);
const input = "h-8 w-full border border-line-strong bg-bg-hi px-2 type-body text-fg outline-none focus-visible:outline-2 focus-visible:outline-accent-ink aria-invalid:border-bad";

type Bindable = BindableIntegration;

export function Group({ id, title, order, open, children }: { id: string; title: string; order: number; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group/fold border-b border-line" style={{ order }} data-inspector-group={id}>
      <summary className="flex min-h-9 cursor-pointer list-none select-none items-center gap-2 px-3 type-label touch:min-h-11 [&::-webkit-details-marker]:hidden">
        {/* The same rotating chevron fold as components' groups (SFR-1). */}
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="flex-none transition-transform duration-150 group-open/fold:rotate-90 motion-reduce:transition-none" data-fold-chevron>
          <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
        {title}
      </summary>
      <div className="flex flex-col gap-3 px-3 pt-1 pb-4">{children}</div>
    </details>
  );
}

function FieldError({ problems, field }: { problems: Problem[]; field: string }) {
  const p = problems.find((x) => x.where.field === field || x.where.field?.startsWith(`${field}.`));
  return p ? <p role="alert" className="type-caption text-bad" data-inspector-error={field}>{p.message}</p> : null;
}

function useJson<T>(url: string): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    fetch(url, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((j) => live && setData(j)).catch(() => {});
    return () => { live = false; };
  }, [url]);
  return data;
}

const NONE = "__none";

/** One parameter's source in the control form: the control's value, a fixed value or the viewer's name. */
function ParamField({ row, value, nodeType, onChange }: { row: ParamRow; value: PropValue | undefined; nodeType: string; onChange(v: PropValue | undefined): void }) {
  // The chosen source is kept here, so an empty fixed value still shows its box while typing.
  const [mode, setMode] = useState<ParamSource>(() => sourceOf(value));
  const takesInput = nodeType === "toggle" || nodeType === "slider" || nodeType === "select";
  const options: { value: string; label: string }[] = [
    ...(takesInput ? [{ value: "input", label: nodeType === "toggle" ? "The switch (on or off)" : nodeType === "slider" ? "The slider's number" : "The chosen option" }] : []),
    { value: "fixed", label: "A fixed value" },
    ...(row.type === "string" ? [{ value: "viewer", label: "The viewer's name" }] : []),
    ...(!row.required ? [{ value: NONE, label: "Leave it out" }] : []),
  ];
  const shown = mode === "none" ? NONE : mode;
  const fixedText = mode === "fixed" && value !== undefined && !(value && typeof value === "object") ? String(value) : "";
  const pickSource = (v: string) => {
    const next: ParamSource = v === NONE ? "none" : (v as ParamSource);
    setMode(next);
    onChange(next === "input" ? { $bind: INPUT_BINDING } : next === "viewer" ? { $bind: VIEWER_BINDING } : next === "fixed" ? fixedValue(row, row.type === "boolean" ? "true" : row.options?.length ? String(row.options[0]) : "") : undefined);
  };
  return (
    <div className="flex flex-col gap-1.5 border-l-2 border-line pl-2" data-control-param={row.name} data-param-source={mode}>
      <SelectMenu label={`${row.title}${row.required ? " (needed)" : ""} comes from`} value={shown} options={mode === "none" && row.required ? [{ value: NONE, label: "Choose..." }, ...options] : options} onChange={pickSource} name={`param-source-${row.name}`} />
      {mode === "fixed" && (row.type === "boolean" || row.options?.length ? (
        <SelectMenu label={`${row.title} value`} hideLabel value={fixedText || (row.type === "boolean" ? "true" : String(row.options![0]))} options={(row.type === "boolean" ? ["true", "false"] : row.options!.map(String)).map((o) => ({ value: o, label: o === "true" ? "On (true)" : o === "false" ? "Off (false)" : o }))} onChange={(v) => onChange(fixedValue(row, v))} name={`param-value-${row.name}`} />
      ) : (
        <input className={input} aria-label={`${row.title} value`} value={fixedText} inputMode={row.type === "number" || row.type === "integer" ? "decimal" : undefined} onChange={(e) => onChange(fixedValue(row, e.target.value))} data-param-value={row.name} />
      ))}
    </div>
  );
}

function ControlEditor({ control, nodeType, commands, problems, onSave, onCancel }: { control: ControlDef | null; nodeType: string; commands: CommandListing[]; problems: Problem[]; onSave(c: ControlDef): void; onCancel(): void }) {
  const run = control?.run.kind === "command" ? control.run : null;
  const [label, setLabel] = useState(control?.label ?? "");
  const [pick, setPick] = useState(run ? `${run.integrationId}|${run.commandId}` : commands[0] ? `${commands[0].integrationId}|${commands[0].command.id}` : "");
  const listing = commands.find((c) => `${c.integrationId}|${c.command.id}` === pick);
  const targetField = listing ? (targetNames(listing.command)[0] ?? null) : null;
  const [target, setTarget] = useState<string>(() => (run && targetField ? String(run.params?.[targetField] ?? "") : ""));
  // Gauntlet w2-r2 item 2: every other parameter has a source. A new control (or a new command) starts
  // from the automatic mapping, so a toggle on a command with one on/off parameter just works.
  const rows = listing ? paramRows(listing.command) : [];
  const [params, setParams] = useState<Record<string, PropValue>>(() => {
    if (run && listing && pick === `${run.integrationId}|${run.commandId}`) return Object.fromEntries(Object.entries(run.params ?? {}).filter(([k]) => !targetNames(listing.command).includes(k)));
    return listing ? autoParams(listing.command, nodeType) : {};
  });
  const missing = listing ? missingParams(listing.command, params) : [];
  const [confirm, setConfirm] = useState(control?.confirm ?? "");
  const [cooldown, setCooldown] = useState(String(control?.cooldownMs ?? 500));
  const choose = (v: string) => {
    setPick(v);
    setTarget("");
    const next = commands.find((c) => `${c.integrationId}|${c.command.id}` === v);
    setParams(next ? autoParams(next.command, nodeType) : {});
  };
  return (
    <div className="flex flex-col gap-2 border border-line p-2" data-control-editor>
      <label className="flex flex-col gap-1 type-caption">Label<input className={input} value={label} onChange={(e) => setLabel(e.target.value)} data-control-label aria-invalid={problems.some((p) => p.where.field === "label") || undefined} /></label>
      <FieldError problems={problems} field="label" />
      {commands.length === 0 ? (
        <p className="type-caption text-fg-2" data-no-commands>Controls need an integration that can run commands, such as Home Assistant, that you set up or that the owner shares with you. <a className="underline" href="/integrations/new">Add an integration</a>.</p>
      ) : (
        <SelectMenu label="Command" value={pick || NONE} options={[...(pick ? [] : [{ value: NONE, label: "Choose..." }]), ...commands.map((c) => ({ value: `${c.integrationId}|${c.command.id}`, label: `${c.integrationName} · ${c.command.label}` }))]} onChange={(v) => v !== NONE && choose(v)} name="control-command" />
      )}
      <FieldError problems={problems} field="run.commandId" />
      {targetField && (
        <div aria-invalid={problems.some((p) => p.where.field?.startsWith(`run.params.${targetField}`)) || undefined} data-control-target-field>
          <SelectMenu label="Which one (a fixed choice; it never comes from the control's input)" value={target || NONE} options={[{ value: NONE, label: "Choose..." }, ...(listing?.targets ?? []).map((t) => ({ value: t.id, label: `${t.label} (${t.id})` }))]} onChange={(v) => setTarget(v === NONE ? "" : v)} name="control-target" />
        </div>
      )}
      {rows.length > 0 && (
        <fieldset className="flex flex-col gap-2" data-control-params>
          <legend className="mb-1 type-caption text-fg-2">Parameters</legend>
          {rows.map((r) => <ParamField key={`${pick}|${r.name}`} row={r} nodeType={nodeType} value={params[r.name]} onChange={(v) => setParams((cur) => { const next = { ...cur }; if (v === undefined) delete next[r.name]; else next[r.name] = v; return next; })} />)}
          {missing.length > 0 && <p role="alert" className="type-caption text-bad" data-control-params-missing>{label.trim() || "This control"} needs a value for {missing.map((m) => m.title).join(", ")}.</p>}
        </fieldset>
      )}
      <FieldError problems={problems} field="run.params" />
      <label className="flex flex-col gap-1 type-caption">Confirm text (optional)<input className={input} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Are you sure?" /></label>
      <label className="flex flex-col gap-1 type-caption">Cooldown in ms (at least 250)<input className={input} inputMode="numeric" value={cooldown} onChange={(e) => setCooldown(e.target.value)} data-control-cooldown /></label>
      <FieldError problems={problems} field="cooldownMs" />
      <div className="flex gap-2">
        <Button variant="ink" disabled={!listing || !label.trim()} onClick={() => {
          if (!listing) return;
          const all: Record<string, PropValue> = { ...params };
          if (targetField) all[targetField] = target;
          onSave({ id: control?.id ?? newId("k"), label: label.trim(), run: { kind: "command", integrationId: listing.integrationId, commandId: listing.command.id, params: all }, ...(confirm.trim() ? { confirm: confirm.trim() } : {}), cooldownMs: Number(cooldown) || 500 });
        }} data-control-save>Save control</Button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

type ApplyAndWait = (ops: DraftOp[]) => Promise<Problem[] | null>;

/** Problems for the data source form, found before sending (gauntlet w2-r1 item 15). */
export function sourceFormProblems(draft: { name: string; integrationId: string; endpointId: string; refreshSec: string; params: string }, taken: boolean): { problems: Problem[]; params?: Record<string, unknown> } {
  const problems: Problem[] = [];
  const at = (field: string, message: string) => problems.push({ severity: "error", code: "form", where: { field }, message });
  const name = draft.name.trim();
  if (!name) at("name", "Give the data source a name. Bindings use it, like {{ cpu }}.");
  else if (!SOURCE_NAME.test(name)) at("name", "A name starts with a lowercase letter and uses only lowercase letters, digits and _ (at most 32).");
  else if (taken) at("name", `There is already a data source named ${name}.`);
  if (!draft.integrationId) at("integrationId", "Pick an integration.");
  if (!draft.endpointId) at("endpointId", "Pick an endpoint.");
  const n = Number(draft.refreshSec);
  if (!Number.isInteger(n) || n < 1) at("refreshSec", "The refresh interval is a whole number of seconds.");
  let params: Record<string, unknown> | undefined;
  if (draft.params.trim()) {
    try {
      const v = JSON.parse(draft.params) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      params = v as Record<string, unknown>;
    } catch {
      at("params", 'Parameters must be a JSON object, like {"domain":"light"}. Fix it or clear the box.');
    }
  }
  return { problems, ...(params ? { params } : {}) };
}

type Live = { data: Record<string, ShapedData | undefined>; states: Record<string, Omit<SourceData, "data"> | undefined> };

const SHORT: Record<string, (d: ShapedData) => string> = {
  stat: (d) => (d.kind === "stat" ? `${d.value}${d.unit ? ` ${d.unit}` : ""}` : ""),
  table: (d) => (d.kind === "table" ? `${d.total ?? d.rows.length} rows` : ""),
  series: (d) => (d.kind === "series" ? `${d.series.length} series` : ""),
  status: (d) => (d.kind === "status" ? `${d.items.filter((i) => i.state === "up").length} of ${d.items.length} up` : ""),
};
const STATE_WORDS: Record<string, string> = { fresh: "live", stale: "stale", failed: "failing", empty: "no data yet" };

/** "lights, from Home Assistant: Lights and their states" (spec 3.8). */
export function sourceWords(def: DataSourceDef, bindable: Bindable[]): string {
  const integ = bindable.find((b) => b.integrationId === def.integrationId);
  const ep = integ?.endpoints.find((e) => e.id === def.endpointId);
  const head = def.label?.trim() || def.name;
  return integ ? `${head}, from ${integ.integrationName}${ep && ep.label !== def.label ? `: ${ep.label}` : ""}` : unmappedPackage(def.integrationId) ? `${head}, not connected` : head;
}

/** The app's data sources (spec 3.8): what each reads, its state, who uses it; add and change through the picker. */
function SourcesEditor({ doc, bindable, live, apply, onPick, onSelect }: { doc: AppDocument; bindable: Bindable[]; live?: Live; apply(ops: DraftOp[]): void; onPick?(t: PickTarget): void; onSelect?(nodeId: string): void }) {
  return (
    <div className="flex flex-col gap-2" data-sources-editor>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {doc.dataSources.map((s) => {
          const users = usersOf(doc, s.name);
          const st = live?.states[s.name];
          const d = live?.data[s.name];
          return (
            <li key={s.name} className="flex flex-col gap-1 bg-bg-sunk px-2 py-1.5" data-source={s.name} data-source-managed={s.managed ? "yes" : "no"}>
              <span className="type-caption min-w-0 truncate" data-source-words>{sourceWords(s, bindable)}</span>
              <span className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-fg-2">
                {unmappedPackage(s.integrationId) ? <span className="text-warn" data-source-unmapped>not connected</span> : <span data-source-state={st?.state ?? "empty"}>{STATE_WORDS[st?.state ?? "empty"]}</span>}
                {d ? <span data-source-value>{SHORT[d.kind]?.(d)}</span> : null}
                <span>{s.refreshSec === 0 ? "Off" : `${s.refreshSec}s`}</span>
              </span>
              <span className="flex flex-wrap items-center gap-x-1">
                {users.length ? (
                  <button type="button" className="inline-flex min-h-8 items-center px-1 type-caption underline touch:min-h-11 touch:px-2" onClick={() => onSelect?.(users[0]!.nodeId)} title={users.map((u) => u.label).join(", ")} data-source-users={users.length}>used by {users.length} {users.length === 1 ? "component" : "components"}</button>
                ) : <span className="type-caption px-1 text-fg-2" data-source-users={0}>not used yet</span>}
                <span className="flex-1" />
                {/* A10.1: data Atrium manages follows its components; only data a person set up can be edited here. */}
                {!s.managed && onPick && <button type="button" className="inline-flex min-h-8 items-center px-1 type-caption underline touch:min-h-11 touch:px-2" onClick={() => onPick({ source: s.name })} aria-label={`Edit ${s.name}`} data-source-edit>Edit</button>}
                {!s.managed && <button type="button" className="inline-flex min-h-8 items-center px-1 type-caption text-bad underline touch:min-h-11 touch:px-2" onClick={() => {
                  if (users.length && !window.confirm(`${s.name} is used by ${users.map((u) => u.label).join(", ")}. They will lose their data. Remove it?`)) return;
                  apply([{ op: "source.remove", name: s.name }]);
                }} aria-label={`Remove ${s.name}`} data-source-remove>Remove</button>}
              </span>
            </li>
          );
        })}
      </ul>
      {doc.dataSources.length === 0 && <p className="type-caption m-0 text-fg-2" data-sources-none>Nothing yet. Pick what a component shows from its Data group; Atrium keeps what it reads here.</p>}
      {/* Wave 2.9: no data source step. Setting up a read by hand stays here for templates and agents' sources. */}
      {onPick && <button type="button" className="inline-flex min-h-8 items-center self-start px-1 type-caption underline touch:min-h-11" onClick={() => onPick({})} data-add-source>Set up a read by hand</button>}
    </div>
  );
}

/** The value a widget's binding shows now, in a few words (formatted when its data says how, A8.4). */
function valueNow(template: string, src: string, live: Live | undefined, def: DataSourceDef): string | null {
  const d = live?.data[src];
  if (!d) return null;
  const whole = new RegExp(String.raw`^\{\{\s*${def.name}(\.(rows|items))?\s*\}\}$`).test(template.trim());
  if (whole) return liveWords(d);
  const scope = { $data: live!.data, $page: { id: "", slug: "", title: "" }, $app: { id: "", slug: "", name: "" }, $user: { kind: "user" as const } };
  const r = evaluateTemplate(template, scope as never);
  if (!r.ok || r.value === undefined || r.value === null || typeof r.value === "object") return null;
  const f = templateFormat(template, scope as never);
  return typeof r.value === "number" && f && f !== "number" ? formatValue(r.value, f) : String(r.value).slice(0, 40);
}

/** A component's bindings, and the one its Data line describes (data, then items, then value). */
function boundOf(node: ComponentNode, doc: AppDocument) {
  const bound = Object.entries(node.props as Record<string, PropValue>).flatMap(([k, v]) => (isBinding(v) ? sourcesInTemplate(v.$bind).map((src) => ({ prop: k, src, template: v.$bind })) : []));
  const order = ["data", "items", "value"];
  const first = [...bound].sort((a, b) => (order.indexOf(a.prop) + 1 || 9) - (order.indexOf(b.prop) + 1 || 9)).find((b) => doc.dataSources.some((d) => d.name === b.src));
  return { bound, first };
}

/**
 * Wave 2.10b F3: a bound component's Data line is the inspector's first row, above the folds, so what it
 * shows, Change and Refresh are never hidden. Charts, tiles and bars keep their own editors in the Data group.
 */
function DataTop({ node, doc, bindable, live, onPick, apply }: { node: ComponentNode; doc: AppDocument; bindable: Bindable[]; live?: Live; onPick(t: PickTarget): void; apply(ops: DraftOp[]): void }) {
  if (node.type === "chart" || node.type === "service-tile" || node.type === "resource-bar") return null;
  const { first } = boundOf(node, doc);
  if (!first) return null;
  const def = doc.dataSources.find((d) => d.name === first.src)!;
  return (
    <div className="border-b border-line px-3 py-2" data-data-top>
      <DataLine node={node} def={def} template={first.template} prop={first.prop} bindable={bindable} {...(live ? { live } : {})} apply={apply} onChange={(p) => onPick({ nodeId: node.id, prop: p, source: def.name })} />
    </div>
  );
}

/**
 * Wave 2.10b F4: when the Data line is the first row and the widget shows a source whole, components' Data
 * sentence ("Shows all of CPU in use, pve1") only repeats it, so it is not drawn. A custom template keeps its
 * sentence and code, which say more than the line does.
 */
function repeatedSentence(node: ComponentNode, doc: AppDocument): string | null {
  if (node.type === "chart" || node.type === "service-tile" || node.type === "resource-bar") return null;
  const { first } = boundOf(node, doc);
  if (!first) return null;
  return new RegExp(String.raw`^\{\{\s*${first.src}(\.(rows|items|value))?\s*\}\}$`).test(first.template.trim()) ? first.prop : null;
}

/**
 * The Data group's one line (Wave 2.7 spec 3.1): "Shows: CPU in use · ACE · 7.8 % · Prometheus, every 30 s"
 * with Change and Disconnect, and "Shares its data with N other widgets" when the source is shared.
 */
function DataSummary({ node, doc, bindable, live, onPick, apply }: { node: ComponentNode; doc: AppDocument; bindable: Bindable[]; live?: Live; onPick(t: PickTarget): void; apply(ops: DraftOp[]): void }) {
  // Wave 2.9 (spec 3.4, 3.5): a chart's lines, a tile's stats and a resource bar's readings, each through the picker.
  if (node.type === "chart") return <div className="flex flex-col gap-2 border border-line p-2" data-data-shows><ChartLinesEditor node={node} doc={doc} bindable={bindable} {...(live ? { live } : {})} apply={apply} onPick={(prop) => onPick({ nodeId: node.id, prop })} /></div>;
  if (node.type === "service-tile") return <div className="flex flex-col gap-2 border border-line p-2" data-data-shows><ListDataEditor node={node} list="stats" max={4} noun="Stat" doc={doc} bindable={bindable} {...(live ? { live } : {})} apply={apply} onPick={(prop) => onPick({ nodeId: node.id, prop })} /></div>;
  if (node.type === "resource-bar") return <div className="flex flex-col gap-2 border border-line p-2" data-data-shows><ListDataEditor node={node} list="items" max={8} noun="Reading" doc={doc} bindable={bindable} {...(live ? { live } : {})} apply={apply} onPick={(prop) => onPick({ nodeId: node.id, prop })} /></div>;
  const props = node.props as Record<string, PropValue>;
  const { bound, first } = boundOf(node, doc);
  // Inside a Repeat: "this row" bindings name the Repeat's source.
  const rowBound = !first ? Object.entries(props).find(([, v]) => isBinding(v) && /\$item\b/.test(v.$bind)) : undefined;
  if (!first) {
    if (!rowBound) return null;
    const around = repeatAround(doc, node.id);
    const f = /\$item\.([A-Za-z_$][A-Za-z0-9_$]*)/.exec((rowBound[1] as { $bind: string }).$bind)?.[1];
    const d = around?.source ? live?.data[around.source] : undefined;
    const col = d?.kind === "table" ? d.columns.find((c) => c.key === f)?.label : undefined;
    return (
      <div className="flex flex-col gap-1 border border-line p-2" data-data-summary="$item" data-data-shows>
        <span className="type-caption" data-data-summary-words>Shows: {col ?? f ?? "a field"} of this row{around?.source ? ` · ${doc.dataSources.find((x) => x.name === around.source)?.label ?? around.source}` : ""}</span>
        <span className="flex gap-2">
          <button type="button" className="inline-flex min-h-8 items-center type-caption underline touch:min-h-11" onClick={() => onPick({ nodeId: node.id, prop: rowBound[0] })} data-data-change>Change</button>
        </span>
      </div>
    );
  }
  const def = doc.dataSources.find((d) => d.name === first.src)!;
  const st = live?.states[def.name];
  const integ = bindable.find((b) => b.integrationId === def.integrationId);
  const ep = integ?.endpoints.find((e) => e.id === def.endpointId);
  const line = showsLine(def, first.template, { ...(ep ? { readLabel: ep.label } : {}), ...(integ ? { integrationName: integ.integrationName } : unmappedPackage(def.integrationId) ? { integrationName: "not connected" } : {}), value: valueNow(first.template, def.name, live, def) });
  const others = otherUsers(doc, def.name, node.id);
  // A9.2, recipes spec 3.2: the read failed its last live check on its server.
  const failedWhy = failedReadReason(def, bindable);
  const failed = failedWhy ? (/[.!?]$/.test(failedWhy) ? failedWhy : `${failedWhy}.`) : null;
  const words = ["Shows:", [line.what, line.detail, line.value, line.from].filter(Boolean).join(" · ")].join(" ");
  return (
    <div className="flex flex-col gap-1 border border-line p-2" data-data-summary={def.name} data-data-shows>
      {/* The Data line itself is the inspector's first row (DataTop, F3); this keeps its state and actions. */}
      <span hidden data-data-summary-words title={sourceWords(def, bindable)}>{words}</span>
      <span className="font-mono text-[11px] text-fg-2">{STATE_WORDS[st?.state ?? "empty"]}{st?.fetchedAt ? ` · updated ${new Date(st.fetchedAt).toLocaleTimeString()}` : ""}</span>
      {failed && <span role="note" className="type-caption text-warn" data-data-read-failed>This read stopped working on {integ?.integrationName ?? "its server"}: {failed} Change it, or check the integration.</span>}
      {others.length > 0 && <span className="type-caption text-fg-2" data-data-shares={others.length} title={others.map((u) => u.label).join(", ")}>Shares its data with {others.length} other {others.length === 1 ? "widget" : "widgets"}</span>}
      <span className="flex gap-2">
        <button type="button" className="inline-flex min-h-8 items-center type-caption underline touch:min-h-11" onClick={() => {
          const patch = Object.fromEntries(bound.filter((b) => b.src === def.name).map((b) => [b.prop, null]));
          apply([{ op: "node.update", nodeId: node.id, patch: { props: { ...node.props, ...patch } } } as DraftOp]);
        }} data-data-disconnect>Disconnect</button>
      </span>
    </div>
  );
}

/** Round 2 item 16: a source in words for people: its label, else its read's label and service; never its generated name. */
export function readableSource(def: DataSourceDef, bindable: readonly Bindable[]): string {
  if (def.label?.trim()) return def.label.trim();
  const integ = bindable.find((b) => b.integrationId === def.integrationId);
  const ep = integ?.endpoints.find((e) => e.id === def.endpointId);
  if (ep) return integ ? `${ep.label}, ${integ.integrationName}` : ep.label;
  return def.managed ? "a read from one of your services" : def.name;
}

/**
 * Round 2 item 11: inside a repeat (Card for each), each copy reads its own row as `$item`. Said once at the
 * top of the inspector with a real field, so a guess like {{ row.name }} has the right form beside it.
 */
function RowHint({ node, doc, live }: { node: ComponentNode; doc: AppDocument; live?: Live }) {
  const around = repeatAround(doc, node.id);
  if (!around) return null;
  const repeat = findNode(doc, around.repeatId)?.node;
  const fields = around.source ? rowFields(live?.data[around.source]) : [];
  const key = fields.find((f) => /^(name|label|host|title)$/i.test(f.key))?.key ?? fields[0]?.key ?? "name";
  return (
    <p className="m-0 border-b border-line px-3 py-2 type-caption text-fg-2" data-row-hint={around.repeatId}>
      Inside {repeat ? nodeLabel(repeat) : "a repeat"}: each copy shows its own row. Use <code className="font-mono text-fg">{`{{ $item.${key} }}`}</code> for this row&apos;s {fields.find((f) => f.key === key)?.label.toLowerCase() ?? key}, or Pick data, This row.
    </p>
  );
}

/**
 * A widget's own title and its "Show title bar" switch (A8.5). Wave 2.10b F4: each has a plain label and a
 * one-line hint; when its effect cannot show right now it says why instead (no title bars in this theme, or
 * the bar switched off).
 */
function TitleFields({ node, apply, titleBars }: { node: ComponentNode; apply(ops: DraftOp[]): void; titleBars?: boolean }) {
  const [draft, setDraft] = useState(node.title ?? "");
  useEffect(() => setDraft(node.title ?? ""), [node.id, node.title]);
  const save = () => {
    const t = draft.trim().slice(0, 120);
    if (t === (node.title ?? "")) return;
    apply([{ op: "node.update", nodeId: node.id, patch: { title: t || null } } as DraftOp]);
  };
  const noBars = titleBars === false;
  const titleWhy = noBars ? "Shows only with a theme that has title bars; this one has none" : node.showTitle === false ? "Needs Show title bar on" : null;
  const barWhy = noBars ? "Shows only with a theme that has title bars; this one has none" : null;
  return (
    <div className="flex flex-col gap-2" data-title-fields>
      <label className="flex flex-col gap-1 type-caption text-fg-2" data-builder-setting="title">
        <span className="type-label text-fg-2" data-field-label>Title</span>
        <input className={input} value={draft} placeholder="No title" maxLength={120} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} data-node-title />
        {titleWhy ? <span className="type-caption text-fg-2" data-field-reason>{titleWhy}</span> : <span className="type-caption text-fg-3" data-field-hint>The words in this widget&apos;s title bar. Never the app or data name.</span>}
      </label>
      <div data-builder-setting="show-title">
        <Checkbox checked={node.showTitle !== false} onCheckedChange={(on) => apply([{ op: "node.update", nodeId: node.id, patch: { showTitle: on ? null : false } } as DraftOp])}
          label={<span data-field-label>Show title bar</span>}
          description={barWhy ? <span data-field-reason>{barWhy}</span> : <span className="text-fg-3" data-field-hint>Draws the bar across the top of this widget</span>} data-node-show-title />
      </div>
    </div>
  );
}

const ROW = 8;
const chip = "inline-flex min-h-9 items-center justify-center border px-2 type-caption touch:min-h-11";

/** Rows of 8px a component needs to show all its content on the canvas (0 when it fits; Wave 2.10 B2). */
function overflowRows(nodeId: string): number {
  if (typeof document === "undefined") return 0;
  return overflowRowsOf(document.querySelector(`[data-canvas-root] [data-node="${CSS.escape(nodeId)}"]`));
}

/**
 * Layout (spec 3.2): the simple set is "Fit to content" and width presets relative to the parent grid's
 * columns; Left, Top, Width and Height with their units sit in a fold titled with them (Wave 2.10b F4), each
 * with a plain label and a one-line hint.
 */
function LayoutFields({ node, doc, device, slot, setSlot, apply, onFit }: { node: ComponentNode; doc: AppDocument; device: Device; slot: ReturnType<typeof slotOn>; setSlot(p: Partial<NonNullable<ReturnType<typeof slotOn>>>): void; apply(ops: DraftOp[]): void; onFit?(nodeId: string): FitResult }) {
  const [fitNote, setFitNote] = useState<string | null>(null);
  useEffect(() => setFitNote(null), [node.id]);
  const fitTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(fitTimer.current), []);
  if (!slot) return <p className="type-caption text-fg-2">This component sits in a {doc ? "stack or card" : "container"}; reorder it in Layers or with Alt and the arrow keys.</p>;
  const parent = findNode(doc, node.id)?.parent ?? null;
  const cols = columnsOn(parent, device);
  // Sixth to Full of the parent's columns, plus the nearest neighbour's width (media layout spec 3.2).
  const neighbour = neighbourWidth(doc, node.id, device);
  const presets = [...widthPresets(cols), ...(neighbour ? [{ label: "Same as neighbour", w: neighbour }] : [])];
  const setWidth = (w: number) => setSlot({ w, x: Math.max(0, Math.min(slot.x, toEighth(cols - w))) });
  const fit = () => {
    // Wave 2.10 B2: the builder's Fit measures again after the redraw until the box holds its content.
    if (onFit) {
      const r = onFit(node.id);
      const sideNow = () => { const el = typeof document === "undefined" ? null : document.querySelector(`[data-canvas-root] [data-node="${CSS.escape(node.id)}"]`); const t = measureTableOverflow(el); return t ? (t.hiddenColumns > 0 ? Math.max(1, t.hiddenPx) : t.hiddenPx) : overflowXOf(el); };
      setFitNote(fitWords(r, r.widened ? 0 : sideNow()));
      // After the redraw, say plainly if columns still hide at the side.
      window.clearTimeout(fitTimer.current);
      fitTimer.current = window.setTimeout(() => setFitNote(fitWords(r, sideNow())), 700);
      return;
    }
    const rows = overflowRows(node.id);
    if (!rows || !parent) { setFitNote("It already shows all its content."); return; }
    const ops = fitOps(doc, parent.id, { [node.id]: rows }, device);
    if (!ops.length) { setFitNote("It already shows all its content."); return; }
    apply(ops);
    setFitNote(`Grown by ${rows * ROW} px. Anything below moved down. Undo with Ctrl+Z.`);
  };
  const num = (v: string) => Number(v.replace(",", "."));
  const fields: { k: "x" | "y" | "w" | "h"; key: string; label: string; unit: string; hint: string; value: number; set(v: number): void }[] = [
    { k: "x", key: "left", label: "Left", unit: "columns", hint: "Columns from the left edge", value: slot.x, set: (v) => { const x = toEighth(v); if (Number.isFinite(v) && x >= 0) setSlot({ x }); } },
    { k: "y", key: "top", label: "Top", unit: "px", hint: "Down from the top, in steps of 8", value: slot.y * ROW, set: (v) => { const y = Math.round(v / ROW); if (Number.isFinite(v) && y >= 0) setSlot({ y }); } },
    { k: "w", key: "width", label: "Width", unit: "columns", hint: "Columns wide; eighths allowed", value: slot.w, set: (v) => { const w = toEighth(v); if (Number.isFinite(v) && w >= 0.125) setSlot({ w }); } },
    { k: "h", key: "height", label: "Height", unit: "px", hint: "Tall, in steps of 8", value: slot.h * ROW, set: (v) => { const h = Math.round(v / ROW); if (Number.isFinite(v) && h >= 1) setSlot({ h }); } },
  ];
  return (
    <div className="flex flex-col gap-3" data-layout-simple>
      <div className="flex flex-col gap-1" data-builder-setting="fit">
        <Button variant="secondary" onClick={fit} data-layout-fit data-field-label>Fit to content</Button>
        <p className="type-caption text-fg-3" data-field-hint>Grows the box so everything inside shows</p>
        {fitNote ? <p role="status" className="type-caption text-fg-2" data-layout-fit-note>{fitNote}</p> : null}
      </div>
      <div className="flex flex-col gap-1" data-builder-setting="width-preset">
        <span className="type-label text-fg-2" id={`lw-${node.id}`} data-field-label>Width</span>
        <div role="radiogroup" aria-labelledby={`lw-${node.id}`} className="flex flex-wrap gap-1" data-layout-presets>
          {presets.map((p) => {
            const w = p.w;
            const on = Math.abs(slot.w - w) < 0.01;
            return (
              <button key={p.label} type="button" role="radio" aria-checked={on} onClick={() => setWidth(w)} className={`${chip} ${on ? "border-fg bg-fg text-bg" : "border-line-strong text-fg hover:bg-bg-sunk"}`} data-layout-preset={p.label}>
                {p.label}
              </button>
            );
          })}
        </div>
        <p className="type-caption text-fg-3" data-field-hint>Of the {cols} columns it sits in{device === "mobile" ? " on phones" : ""}</p>
      </div>
      <MoreFold group="layout" count={0} holds={fields.map((f) => f.label)}>
        <div className="grid grid-cols-2 gap-2" data-layout-fields>
          {fields.map((f) => (
            <label key={`${node.id}-${f.k}-${f.value}`} className="flex flex-col gap-1 type-caption text-fg-2" data-builder-setting={f.key}>
              <span className="type-label text-fg-2" data-field-label>{f.label} <span className="font-mono text-[11px] text-fg-3">{f.unit}</span></span>
              <input className={input} inputMode="decimal" defaultValue={f.value} aria-label={`${f.label} in ${f.unit}`} onBlur={(e) => num(e.target.value) !== f.value && f.set(num(e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} data-layout-field={f.k} />
              <span className="type-caption text-fg-3" data-field-hint>{f.hint}</span>
            </label>
          ))}
        </div>
      </MoreFold>
    </div>
  );
}

export function Inspector({ node, doc, ctx, device, problems, apply, readOnly, compact, live, onPick, onSelect, onFit, titleBars }: { node: ComponentNode | null; doc: AppDocument; ctx: RenderContext; device: Device; problems: Problem[]; apply(ops: DraftOp[]): void; /** F4: whether the app's theme draws title bars (Title says why when it does not). */ titleBars?: boolean; /** Wave 2.10 B2: the builder's Fit (rows grown, 0 when it fits). */ onFit?(nodeId: string): FitResult; applyAndWait?: ApplyAndWait; readOnly?: boolean; /** Under 900px: Content and Data only (gauntlet w2-r1 item 11). */ compact?: boolean; /** Wave 2.5: live source values for the sources list and summaries. */ live?: Live; /** Wave 2.5: opens the data picker. */ onPick?(t: PickTarget): void; /** Selects a component (sources list "used by"). */ onSelect?(nodeId: string): void }) {
  const commands = useJson<{ commands: CommandListing[] }>("/api/integrations/commands")?.commands ?? [];
  const bindable = useJson<{ integrations: Bindable[] }>("/api/integrations/bindable")?.integrations ?? [];
  const [editingControl, setEditingControl] = useState<ControlDef | "new" | null>(null);
  const runs = node ? controlsOfNode(node) : [];
  const current = runs[0] ? doc.controls.find((c) => c.id === runs[0]) ?? null : null;
  const slot = node ? slotOn(node, device) : undefined;
  // Words and facts for the data chips and the Data sentence (spec 3.3).
  const describe = useMemo<BindingDescriber>(() => ({
    // A10.1: a managed source is never named to a person; its words stand in for its generated name.
    words: (t) => {
      const w = describeTemplate(t);
      // Round 2 item 16: a template with no words of its own still never shows a managed source's
      // generated name (d_...): it reads as the read's words ("Everything about a machine, Every machine").
      if (!w) {
        let srcs: string[] = [];
        try { srcs = sourcesInTemplate(t); } catch { srcs = []; }
        const managed = srcs.map((n) => doc.dataSources.find((d) => d.name === n)).filter((d): d is DataSourceDef => !!d?.managed);
        if (!managed.length) return w;
        const named = managed.map((d) => readableSource(d, bindable)).join(" and ");
        return /^\{\{\s*[a-z][a-z0-9_]*(\.(rows|items))?\s*\}\}$/.test(t.trim()) ? `All of ${named}` : `Custom value from ${named}`;
      }
      return doc.dataSources.reduce((acc, d) => (d.managed ? acc.split(d.name).join(readableSource(d, bindable)) : acc), w);
    },
    source: (name) => {
      const def = doc.dataSources.find((d) => d.name === name);
      if (!def) return null;
      const st = live?.states[name];
      const integration = bindable.find((b) => b.integrationId === def.integrationId)?.integrationName;
      return { ...(integration ? { integration } : {}), refreshSec: def.refreshSec, ...(st?.state ? { state: st.error && st.state === "empty" ? "failed" : st.state } : {}), ...(st?.fetchedAt ? { fetchedAt: st.fetchedAt } : {}) };
    },
  }), [doc.dataSources, live, bindable]);
  const nodeProblems = useMemo(() => problems.filter((p) => !node || !p.where.nodeId || p.where.nodeId === node.id), [problems, node]);
  // Gauntlet w2-r2 item 15: Layout sits between components' Control and Style groups in the DOM (so in
  // reading and tab order too), not only visually. components' panels have no slot for it, so the
  // builder keeps one element of its own just before their Style group and renders Layout into it.
  const groupsRef = useRef<HTMLFieldSetElement>(null);
  const [layoutSlot] = useState<HTMLDivElement | null>(() => (typeof document === "undefined" ? null : document.createElement("div")));
  useLayoutEffect(() => {
    const root = groupsRef.current;
    if (!root || !layoutSlot) return;
    layoutSlot.style.display = "contents";
    layoutSlot.setAttribute("data-builder-slot", "layout");
    const before = root.querySelector("[data-inspector-group=style]") ?? root.querySelector("[data-inspector-group=advanced]");
    if (before?.parentNode) {
      if (before.previousSibling !== layoutSlot) before.parentNode.insertBefore(layoutSlot, before);
    } else {
      const panels = root.querySelector("[data-inspector]");
      if (panels && layoutSlot.parentNode !== panels) panels.appendChild(layoutSlot);
    }
  });
  useEffect(() => () => layoutSlot?.remove(), [layoutSlot]);
  if (!node) {
    return (
      <div className="flex flex-col" data-inspector-empty>
        <p className="p-3 type-body text-fg-2">Select a component on the canvas or in Layers.</p>
        <div className="flex flex-col"><Group id="sources" title="Advanced: data this app reads" order={3} open><SourcesEditor doc={doc} bindable={bindable} live={live} apply={apply} {...(onPick ? { onPick } : {})} {...(onSelect ? { onSelect } : {})} /></Group></div>
      </div>
    );
  }
  const setSlot = (patch: Partial<NonNullable<typeof slot>>) => {
    const base = slot ?? { x: 0, y: 0, w: 3, h: 16 };
    const op = slotOp(doc, node.id, { ...base, ...patch }, device);
    if (op) apply([op]);
  };
  return (
    <div className="flex flex-col" data-inspector={node.id} aria-label={`Inspector for ${nodeLabel(node)}`}>
      {/* components' header (SFR-1 from components round 2): the name, a mono type tag, the library name for instances. */}
      <InspectorHeader node={node} library={(ctx.values as { $library?: Record<string, LibraryComponent> }).$library} />
      <RowHint node={node} doc={doc} live={live} />
      {onPick && !readOnly && <DataTop node={node} doc={doc} bindable={bindable} live={live} onPick={onPick} apply={apply} />}
      {onPick && !readOnly && (() => {
        const prop = repeatedSentence(node, doc);
        // Node ids and prop names are plain identifiers; anything else is left alone.
        return prop && /^[A-Za-z0-9_-]+$/.test(node.id) && /^[A-Za-z0-9_.]+$/.test(prop) ? <style data-hide-repeated-sentence>{`[data-inspector="${node.id}"] [data-data-sentence="${prop}"]{display:none}`}</style> : null;
      })()}
      <fieldset ref={groupsRef} disabled={readOnly} className={`flex min-w-0 flex-col touch:[&_[data-inspector-group]>h3>button]:min-h-11 ${compact ? "[&_[data-inspector-group=style]]:hidden [&_[data-inspector-group=advanced]]:hidden [&_[data-inspector-group=control]]:hidden" : ""} [&_[data-inspector]]:contents [&_[data-inspector-group=content]]:order-1 [&_[data-inspector-group=data]]:order-2 [&_[data-inspector-group=control]]:order-3 [&_[data-inspector-group=style]]:order-5 [&_[data-inspector-group=advanced]]:order-6`} data-inspector-groups>
        <InspectorPanels node={node} doc={doc} ctx={ctx} describe={describe} onChange={(patch: Partial<Omit<ComponentNode, "id" | "children">>) => {
          // A grid's column count rescales its children in the same batch, so nothing moves (A7.4).
          const cols = (patch.props as Record<string, unknown> | undefined)?.columns;
          if (node.type === "grid" && patch.props && cols !== node.props.columns) {
            const to = cols === 6 || cols === 24 ? cols : 12;
            const rest = { ...patch, props: { ...patch.props } } as typeof patch;
            delete (rest.props as Record<string, unknown>).columns;
            const ops = columnsChangeOps(doc, node.id, to);
            const others = Object.keys(rest.props ?? {}).some((k) => (rest.props as Record<string, unknown>)[k] !== (node.props as Record<string, unknown>)[k]);
            apply([...ops, ...(others ? [{ op: "node.update", nodeId: node.id, patch: rest } as DraftOp] : [])]);
            return;
          }
          apply([{ op: "node.update", nodeId: node.id, patch }]);
        }} onOps={(ops: DraftOp[]) => apply(ops)}
          {...(onPick && !readOnly ? { onConnectData: (prop?: string) => onPick({ nodeId: node.id, ...(prop ? { prop } : {}) }), dataSummary: <DataSummary node={node} doc={doc} bindable={bindable} live={live} onPick={onPick} apply={apply} /> } : {})} />
        {!compact && layoutSlot && createPortal(<Group id="layout" title="Layout" order={4}>
          <LayoutFields node={node} doc={doc} device={device} slot={slot} setSlot={setSlot} apply={apply} {...(onFit ? { onFit } : {})} />
          {device === "mobile" && (
            <div data-builder-setting="hide-on-phones">
              <Checkbox checked={!!node.responsive?.mobile?.hidden} onCheckedChange={(on) => apply([{ op: "node.update", nodeId: node.id, patch: { responsive: { mobile: { hidden: on } } } }])} label={<span data-field-label>Hide on phones</span>} description={<span className="text-fg-3" data-field-hint>Phones only. The desktop layout keeps it</span>} data-mobile-hidden />
            </div>
          )}
          <p className="type-caption text-fg-2">{device === "mobile" ? "Editing the phone layout. The desktop layout is not changed." : "Editing the desktop layout."}</p>
        </Group>, layoutSlot)}
        {!compact && node.type !== "grid" && (
          <Group id="title" title="Title bar" order={4}>
            <TitleFields node={node} apply={apply} {...(titleBars !== undefined ? { titleBars } : {})} />
          </Group>
        )}
        <p className="order-7 mt-1 border-t border-line-strong px-3 pt-3 pb-1 type-caption text-fg-2" data-app-level-rule>For the whole app</p>
        {!compact && CONTROL_TYPES.has(node.type) && (
          <Group id="app-controls" title="App controls" order={8} open>
            <p className="type-caption text-fg-2">Controls run a command on one of your integrations. Pick which one this component runs under Control.</p>
            {current && editingControl === null && <Button variant="secondary" onClick={() => setEditingControl(current)} data-edit-control>Edit {current.label}</Button>}
            {editingControl === null && <Button variant="secondary" onClick={() => setEditingControl("new")} data-new-control>New control</Button>}
            {editingControl !== null && (
              <ControlEditor
                control={editingControl === "new" ? null : editingControl}
                nodeType={node.type}
                commands={commands}
                problems={nodeProblems}
                onCancel={() => setEditingControl(null)}
                onSave={(c) => {
                  const ops: DraftOp[] = [{ op: "control.set", control: c }];
                  if (node.type !== "html" && current?.id !== c.id) ops.push({ op: "node.update", nodeId: node.id, patch: { props: { control: c.id } } });
                  apply(ops);
                  setEditingControl(null);
                }}
              />
            )}
          </Group>
        )}
        <Group id="sources" title="Advanced: data this app reads" order={9}>
          <SourcesEditor doc={doc} bindable={bindable} live={live} apply={apply} {...(onPick ? { onPick } : {})} {...(onSelect ? { onSelect } : {})} />
        </Group>
      </fieldset>
    </div>
  );
}
