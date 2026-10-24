"use client";
// Inspector editors for the list props of Wave 2.9 (A10.2, A10.7): a chart's lines, a service tile's
// numbers, a resource bar's readings and bookmarks, plus the icon picker. A value inside a list is a
// literal or a binding; "Pick data" asks the builder's picker for that one entry by its prop path
// ("lines.1.data", "stats.0.value", "items.2.percent"; props-path.ts). A path one past the end appends.
import { useId, useMemo, useState, type ReactNode } from "react";
import type { AppDocument, ComponentNode, DraftOp, PropValue } from "@/core/contracts";
import { Button } from "@/features/shell";
import { isBinding, resolveValue, type PropError } from "../bindings";
import { ICON_NAMES, MAX_BAR_ITEMS, MAX_BOOKMARKS, MAX_CHART_LINES, MAX_TILE_STATS, SERIES_COLORS } from "../catalogue/schemas";
import { ICON_PATHS } from "../render/icons";
import { planLines, thirdUnitSentence, type LineInput } from "../render/lines";
import { domainOf, iconRefKind } from "../render/tiles-logic";
import { newId } from "../ids";
import { wordsFor } from "./labels";
import type { PageScope } from "../render/resolve";
import type { BindingDescriber } from "./binding-words";
import { BindingField, DataChip, chipFits } from "./inspector";
import { MediaField } from "@/features/uploads/client";

const inputCls = "w-full border border-line-strong bg-bg-hi px-2 py-1.5 type-body text-fg placeholder:text-fg-3 min-h-9 touch:min-h-11 disabled:opacity-40";
const labelCls = "type-label text-fg-2";
const linkBtn = "self-start min-h-8 touch:min-h-11 type-caption text-accent-ink underline underline-offset-2 hover:text-fg";
const rowCls = "flex flex-col gap-2 border border-line bg-bg-sunk p-2";
const FORMATS: { value: string; label: string }[] = [
  { value: "", label: "As the data says" },
  { value: "percent", label: "Percent" },
  { value: "bytes", label: "Bytes (KB to TB)" },
  { value: "bytesPerSec", label: "Bytes per second" },
  { value: "seconds", label: "Duration" },
  { value: "celsius", label: "Degrees Celsius" },
  { value: "number", label: "Plain number" },
];

export type ListEnv = {
  node: ComponentNode;
  scope: PageScope;
  sources: readonly string[];
  describe?: BindingDescriber;
  /** Opens the builder's data picker for one prop path. */
  onPick?(path: string): void;
  setProp(k: string, v: PropValue | null): void;
  /** Several props in one change (one undo step). */
  setProps(patch: Record<string, PropValue | null>): void;
};

type Row = Record<string, PropValue>;
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? (v as unknown[]).map((x) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Row) : {})) : []);

// ---------- one value: literal or binding ----------

/** A value inside a list entry: typed in, or a data chip (a binding) with Pick data and Edit as template. */
export function ValueField({ env, path, label, value, onSet, hint }: { env: ListEnv; path: string; label: string; value: PropValue | undefined; onSet(v: PropValue | null): void; hint?: string }) {
  const id = useId();
  const [asTemplate, setAsTemplate] = useState(false);
  if (isBinding(value)) {
    const chip = !asTemplate && chipFits(value.$bind, env.sources);
    return (
      <div className="flex flex-col gap-1" data-list-value={path}>
        <span className={labelCls}>{label}</span>
        {chip ? (
          <DataChip prop={path} template={value.$bind} scope={env.scope} describe={env.describe} {...(env.onPick ? { onOpen: () => env.onPick!(path) } : {})} />
        ) : (
          <BindingField name={path} label={`${label} template`} value={value.$bind} scope={env.scope} sources={env.sources} holdKey={`${env.node.id}:${path}`} onChange={(t) => onSet({ $bind: t })} />
        )}
        <span className="flex flex-wrap gap-x-3">
          {chip ? (
            <button type="button" className={linkBtn} data-edit-template={path} onClick={() => setAsTemplate(true)}>
              Edit as template
            </button>
          ) : null}
          {env.onPick && !chip ? (
            <button type="button" className={linkBtn} data-pick-button={path} onClick={() => env.onPick!(path)}>
              Pick data
            </button>
          ) : null}
          <button type="button" className={linkBtn} data-unbind={path} onClick={() => onSet(null)}>
            Type it in
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-list-value={path}>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <input
        id={id}
        className={inputCls}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => {
          const t = e.target.value;
          onSet(t === "" ? null : /^-?\d+(\.\d+)?$/.test(t.trim()) ? Number(t) : t);
        }}
        data-list-literal={path}
      />
      {hint ? <p className="type-caption m-0 text-fg-3">{hint}</p> : null}
      <span className="flex flex-wrap gap-x-3">
        {env.onPick ? (
          <button type="button" className={linkBtn} data-pick-button={path} onClick={() => env.onPick!(path)}>
            Pick data
          </button>
        ) : null}
        <button type="button" className={linkBtn} data-bind-button={path} onClick={() => onSet({ $bind: value === undefined || value === null || value === "" ? "" : `{{ ${JSON.stringify(value).replace(/"/g, "'")} }}` })}>
          Live data
        </button>
      </span>
    </div>
  );
}

function FormatSelect({ path, value, onSet }: { path: string; value: unknown; onSet(v: PropValue | null): void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelCls}>
        Written as
      </label>
      <select id={id} className={inputCls} value={typeof value === "string" ? value : ""} onChange={(e) => onSet(e.target.value || null)} data-list-format={path}>
        {FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function RowHead({ title, onRemove, removeLabel, up, down }: { title: ReactNode; onRemove(): void; removeLabel: string; up?: () => void; down?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="type-label text-fg">{title}</span>
      <span className="flex items-center gap-1">
        {up ? (
          <Button variant="quiet" aria-label={`Move up: ${removeLabel}`} onClick={up}>
            ↑
          </Button>
        ) : null}
        {down ? (
          <Button variant="quiet" aria-label={`Move down: ${removeLabel}`} onClick={down}>
            ↓
          </Button>
        ) : null}
        <Button variant="quiet" aria-label={`Remove ${removeLabel}`} onClick={onRemove} data-list-remove>
          Remove
        </Button>
      </span>
    </div>
  );
}

const move = <T,>(list: T[], i: number, d: number): T[] => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
};

// ---------- icon picker ----------

const ICON_GROUPS: { title: string; names: readonly string[] }[] = [
  { title: "Services", names: ["docker", "proxmox", "prometheus", "npm", "pfsense", "uptime-kuma", "home-assistant", "custom-api", "rss", "atrium"] },
  { title: "Things", names: ICON_NAMES.filter((n) => !["docker", "proxmox", "prometheus", "npm", "pfsense", "uptime-kuma", "home-assistant", "custom-api", "rss", "atrium"].includes(n)) },
];

export function IconPreview({ icon, size = 20 }: { icon: string; size?: number }) {
  const k = iconRefKind(icon);
  if (k.kind === "upload") return <img src={k.path} alt="" width={size} height={size} className="object-contain" />;
  const d = k.kind === "builtin" ? ICON_PATHS[k.name]! : ICON_PATHS.server!;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

/** Pick a built-in icon (the service's own glyph first), or upload a picture. Optional: with "none" for letters. */
export function IconField({ label, value, onSet, path, optional, hint }: { label: string; value: unknown; onSet(v: PropValue | null): void; path: string; optional?: boolean; hint?: string }) {
  const id = useId();
  const icon = typeof value === "string" ? value : "";
  const k = iconRefKind(icon);
  const name = k.kind === "builtin" ? (icon.startsWith("pkg:") ? icon : k.name) : "";
  return (
    <div className="flex flex-col gap-1" data-icon-field={path}>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <span className="flex items-center gap-2">
        <span className="flex h-9 w-9 flex-none items-center justify-center border border-line-strong text-fg touch:h-11 touch:w-11" data-icon-preview={icon}>
          {icon ? <IconPreview icon={icon} /> : <span className="type-caption text-fg-3">Aa</span>}
        </span>
        <select id={id} className={inputCls} value={k.kind === "upload" ? "__upload" : name} onChange={(e) => (e.target.value === "__upload" ? null : onSet(e.target.value || null))} data-icon-select={path}>
          {optional ? <option value="">Two letters from the name</option> : null}
          {k.kind === "upload" ? <option value="__upload">Your picture</option> : null}
          {k.kind === "unknown" && icon ? <option value={icon}>{icon} (unknown)</option> : null}
          {icon.startsWith("pkg:") && k.kind === "builtin" ? <option value={icon}>{k.name} (service)</option> : null}
          {ICON_GROUPS.map((g) => (
            <optgroup key={g.title} label={g.title}>
              {g.names.map((n) => (
                <option key={n} value={n}>
                  {n.replace(/-/g, " ")}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </span>
      {hint ? <p className="type-caption m-0 text-fg-3">{hint}</p> : null}
      <details className="type-caption text-fg-2" data-icon-upload={path}>
        <summary className="min-h-8 cursor-pointer touch:min-h-11">Use your own picture</summary>
        <MediaField value={k.kind === "upload" ? icon : undefined} accept="image" label="Picture" hint="A small square picture works best" onChange={(p) => onSet(p)} />
      </details>
    </div>
  );
}

// ---------- a service tile's numbers ----------

export function StatsEditor({ env }: { env: ListEnv }) {
  const rows = rowsOf(env.node.props.stats);
  const set = (next: Row[]) => env.setProp("stats", next as PropValue);
  const setAt = (i: number, k: string, v: PropValue | null) => set(rows.map((r, j) => (j === i ? withKey(r, k, v) : r)));
  return (
    <div className="flex flex-col gap-2" data-field="stats" data-stats-editor>
      <span className={labelCls}>{wordsFor("service-tile", "stats")?.label}</span>
      <p className="type-caption m-0 text-fg-3">{wordsFor("service-tile", "stats")?.hint}</p>
      {rows.map((r, i) => (
        <div key={i} className={rowCls} data-stat-row={i}>
          <RowHead title={`Number ${i + 1}`} removeLabel={`number ${i + 1}`} onRemove={() => set(rows.filter((_, j) => j !== i))} {...(i > 0 ? { up: () => set(move(rows, i, -1)) } : {})} />
          <TextInput label="Label" value={r.label} onSet={(v) => setAt(i, "label", v ?? "")} path={`stats.${i}.label`} />
          <ValueField env={env} path={`stats.${i}.value`} label="Value" value={r.value} onSet={(v) => setAt(i, "value", v)} />
          <FormatSelect path={`stats.${i}.format`} value={r.format} onSet={(v) => setAt(i, "format", v)} />
        </div>
      ))}
      <Button variant="secondary" disabled={rows.length >= MAX_TILE_STATS} onClick={() => set([...rows, { label: `Number ${rows.length + 1}`, value: null } as Row])} data-add-stat>
        Add a number
      </Button>
    </div>
  );
}

function withKey(r: Row, k: string, v: PropValue | null): Row {
  const out = { ...r };
  if (v === null || v === undefined) delete out[k];
  else out[k] = v;
  if (k === "value" && v === null) out.value = null;
  return out;
}

function TextInput({ label, value, onSet, path, placeholder }: { label: string; value: unknown; onSet(v: string | null): void; path: string; placeholder?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <input id={id} className={inputCls} value={typeof value === "string" ? value : ""} placeholder={placeholder} onChange={(e) => onSet(e.target.value === "" ? null : e.target.value)} data-list-text={path} />
    </div>
  );
}

// ---------- a resource bar's readings ----------

export function BarItemsEditor({ env }: { env: ListEnv }) {
  const rows = rowsOf(env.node.props.items);
  const set = (next: Row[]) => env.setProp("items", next as PropValue);
  const setAt = (i: number, k: string, v: PropValue | null) => set(rows.map((r, j) => (j === i ? withKey(r, k, v) : r)));
  return (
    <div className="flex flex-col gap-2" data-field="items" data-bar-editor>
      <span className={labelCls}>{wordsFor("resource-bar", "items")?.label}</span>
      <p className="type-caption m-0 text-fg-3">{wordsFor("resource-bar", "items")?.hint}</p>
      <p className="type-caption m-0 text-fg-3">CPU, memory free, disk free, temperature, uptime, network. A percent draws the small bar.</p>
      {rows.map((r, i) => (
        <div key={i} className={rowCls} data-bar-row={i}>
          <RowHead title={typeof r.label === "string" && r.label ? r.label : `Reading ${i + 1}`} removeLabel={`reading ${i + 1}`} onRemove={() => set(rows.filter((_, j) => j !== i))} {...(i > 0 ? { up: () => set(move(rows, i, -1)) } : {})} />
          <IconField label="Icon" value={r.icon} path={`items.${i}.icon`} onSet={(v) => setAt(i, "icon", v ?? "info")} />
          <TextInput label="Label" value={r.label} onSet={(v) => setAt(i, "label", v ?? "")} path={`items.${i}.label`} />
          <ValueField env={env} path={`items.${i}.value`} label="Value" value={r.value} onSet={(v) => setAt(i, "value", v)} />
          <ValueField env={env} path={`items.${i}.percent`} label="Bar from (0 to 100)" value={r.percent} onSet={(v) => setAt(i, "percent", v)} hint="Optional. Usually the same read as the value, in percent" />
          <FormatSelect path={`items.${i}.format`} value={r.format} onSet={(v) => setAt(i, "format", v)} />
        </div>
      ))}
      <Button variant="secondary" disabled={rows.length >= MAX_BAR_ITEMS} onClick={() => set([...rows, { icon: "cpu", label: "CPU", value: null } as Row])} data-add-reading>
        Add a reading
      </Button>
    </div>
  );
}

// ---------- bookmarks ----------

export function BookmarksEditor({ env }: { env: ListEnv }) {
  const rows = rowsOf(env.node.props.items);
  const set = (next: Row[]) => env.setProp("items", next as PropValue);
  const setAt = (i: number, k: string, v: PropValue | null) => set(rows.map((r, j) => (j === i ? withKey(r, k, v) : r)));
  return (
    <div className="flex flex-col gap-2" data-field="items" data-bookmarks-editor>
      <span className={labelCls}>{wordsFor("bookmarks", "items")?.label}</span>
      <p className="type-caption m-0 text-fg-3">{wordsFor("bookmarks", "items")?.hint}</p>
      {rows.map((r, i) => {
        const href = typeof r.href === "string" ? r.href : "";
        const bad = href.trim() !== "" && !domainOf(href);
        return (
          <div key={i} className={rowCls} data-bookmark-row={i}>
            <RowHead title={typeof r.name === "string" && r.name ? r.name : `Bookmark ${i + 1}`} removeLabel={`bookmark ${i + 1}`} onRemove={() => set(rows.filter((_, j) => j !== i))} {...(i > 0 ? { up: () => set(move(rows, i, -1)) } : {})} />
            <TextInput label="Name" value={r.name} onSet={(v) => setAt(i, "name", v ?? "")} path={`items.${i}.name`} />
            <TextInput label="Address" value={r.href} onSet={(v) => setAt(i, "href", v ?? "")} path={`items.${i}.href`} placeholder="https://" />
            {bad ? (
              <p role="note" className="type-caption m-0 text-bad" data-bookmark-refused={i}>
                Only http and https addresses open; this one is drawn but not clickable.
              </p>
            ) : null}
            <IconField label="Icon" optional value={r.icon} path={`items.${i}.icon`} onSet={(v) => setAt(i, "icon", v)} />
          </div>
        );
      })}
      <Button variant="secondary" disabled={rows.length >= MAX_BOOKMARKS} onClick={() => set([...rows, { name: "New bookmark", href: "" } as Row])} data-add-bookmark>
        Add a bookmark
      </Button>
    </div>
  );
}

// ---------- a chart's lines ----------

const COLOR_WORDS: Record<string, string> = Object.fromEntries(SERIES_COLORS.map((c, i) => [c, `Theme colour ${i + 1}`]));

function findParentId(doc: AppDocument, id: string): string | null {
  const walk = (n: ComponentNode): string | null => {
    for (const c of n.children ?? []) {
      if (c.id === id) return n.id;
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  for (const p of doc.pages) {
    const r = walk(p.root);
    if (r) return r;
  }
  return null;
}

export function LinesEditor({ env, doc, onOps }: { env: ListEnv; doc: AppDocument; onOps?(ops: DraftOp[]): void }) {
  const rows = rowsOf(env.node.props.lines);
  const set = (next: Row[]) => env.setProp("lines", next as PropValue);
  const setAt = (i: number, k: string, v: PropValue | null) => set(rows.map((r, j) => (j === i ? withKey(r, k, v) : r)));
  // The axis rule (A10.2) on the lines as they resolve now, so a third unit is refused in words here too.
  const plan = useMemo(() => {
    const errors: PropError[] = [];
    const resolved = rows.map((r) => ({ ...r, data: resolveValue(r.data, env.scope, "data", errors) })) as LineInput[];
    return { plan: planLines(resolved), resolved };
  }, [rows, env.scope]);
  const canPercent = plan.resolved.every((ln) => {
    const d = ln.data as { format?: string; unit?: string } | undefined;
    return !d || d.format === "percent" || d.unit === "%";
  });
  const single = env.node.props.data;
  const addLine = () => {
    // A chart that still draws one source keeps it as its first line, so nothing it showed is lost.
    const base = rows.length === 0 && single !== undefined && single !== null && isBinding(single) && single.$bind.trim() ? [{ data: single } as Row] : rows;
    const moved = base !== rows;
    // The new line lands empty (it draws nothing and offers Pick data), and the picker opens on it.
    env.setProps({ ...(moved ? { data: null } : {}), lines: [...base, { data: { $bind: "" } } as Row] as PropValue });
    env.onPick?.(`lines.${base.length}.data`);
  };
  const newChart = (i: number) => {
    const parent = findParentId(doc, env.node.id);
    if (!parent || !onOps) return;
    const line = rows[i]!;
    const node: ComponentNode = { id: newId("c"), type: "chart", props: { kind: (env.node.props.kind as PropValue) ?? "line", height: (env.node.props.height as PropValue) ?? 150, lines: [line] }, ...(env.node.slot ? { slot: { ...env.node.slot, y: env.node.slot.y + env.node.slot.h } } : {}) };
    onOps([
      { op: "node.update", nodeId: env.node.id, patch: { props: { ...env.node.props, lines: rows.filter((_, j) => j !== i) } } },
      { op: "node.add", parentId: parent, node },
    ]);
  };
  return (
    <div className="flex flex-col gap-2" data-field="lines" data-lines-editor>
      <span className={labelCls}>{wordsFor("chart", "lines")?.label}</span>
      <p className="type-caption m-0 text-fg-3">{wordsFor("chart", "lines")?.hint}</p>
      <p className="type-caption m-0 text-fg-3">Lines in a second unit use the right-hand axis.</p>
      {rows.map((r, i) => {
        const refused = plan.plan.refused.includes(i);
        const hidden = r.hidden === true;
        return (
          <div key={i} className={rowCls} data-lines-row={i} data-lines-hidden={hidden ? "" : undefined}>
            <RowHead title={typeof r.label === "string" && r.label ? r.label : `Line ${i + 1}`} removeLabel={`line ${i + 1}`} onRemove={() => set(rows.filter((_, j) => j !== i))} {...(i > 0 ? { up: () => set(move(rows, i, -1)) } : {})} />
            <ValueField env={env} path={`lines.${i}.data`} label="Shows" value={r.data ?? { $bind: "" }} onSet={(v) => setAt(i, "data", v === null ? { $bind: "" } : v)} />
            <TextInput label="Name" value={r.label} onSet={(v) => setAt(i, "label", v)} path={`lines.${i}.label`} placeholder="From the data" />
            <ColorField path={`lines.${i}.color`} value={r.color} onSet={(v) => setAt(i, "color", v)} />
            <button type="button" className={linkBtn} aria-pressed={hidden} onClick={() => setAt(i, "hidden", hidden ? null : true)} data-lines-hide={i}>
              {hidden ? "Show this line" : "Hide this line"}
            </button>
            {refused ? (
              <div role="note" className="flex flex-col gap-1 border-l-2 border-[color:var(--warn)] pl-2" data-lines-refused={i}>
                <p className="type-caption m-0 text-fg">{thirdUnitSentence(canPercent)}</p>
                {onOps ? (
                  <button type="button" className={linkBtn} onClick={() => newChart(i)} data-lines-new-chart={i}>
                    Put it on a new chart
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      <Button variant="secondary" disabled={rows.length >= MAX_CHART_LINES} onClick={addLine} data-lines-add>
        Add a line
      </Button>
      {rows.length ? (
        <p className="type-caption m-0 text-fg-3" data-lines-count>
          {plan.plan.total > plan.plan.series.length ? `${plan.plan.series.length} of ${plan.plan.total} series drawn, the highest first` : `${plan.plan.total} series drawn`}
        </p>
      ) : null}
    </div>
  );
}

function ColorField({ path, value, onSet }: { path: string; value: unknown; onSet(v: PropValue | null): void }) {
  const id = useId();
  const v = typeof value === "string" ? value : "";
  const hex = /^#[0-9a-fA-F]{6}$/.test(v);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelCls}>
        Colour
      </label>
      <span className="flex items-center gap-2">
        <select id={id} className={inputCls} value={hex ? "__hex" : v} onChange={(e) => onSet(e.target.value === "__hex" ? "#2f6fb0" : e.target.value || null)} data-lines-color={path}>
          <option value="">Next theme colour</option>
          {SERIES_COLORS.map((c) => (
            <option key={c} value={c}>
              {COLOR_WORDS[c]}
            </option>
          ))}
          <option value="__hex">Your own colour</option>
        </select>
        {hex ? <input type="color" aria-label="Your own colour" className="h-9 w-11 flex-none border border-line-strong bg-bg-hi touch:h-11" value={v} onChange={(e) => onSet(e.target.value)} data-lines-hex={path} /> : null}
      </span>
    </div>
  );
}
