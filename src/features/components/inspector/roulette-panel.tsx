"use client";
// Wave 2.10c N3: the roulette's own inspector fields (A11.4). The timer is a menu (Off, 3 s to 1 h), the
// ways to turn it are three switches, and a repeat over more than 50 rows offers a list or a table in its
// place (one draft step: the roulette is replaced by a list or table reading the same rows, in its slot).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ComponentNode, DraftOp, PropValue } from "@/core/contracts";
import { isBinding, sourcesInTemplate } from "../bindings";
import { newId } from "../ids";
import { advanceOf, ROULETTE_MAX, startSlot, timerOf } from "../render/roulette";
import { SwitchRow } from "./inspector";

const inputCls = "w-full border border-line-strong bg-bg-hi px-2 py-1.5 type-body text-fg min-h-9 touch:min-h-11";
const labelCls = "type-label text-fg-2";

/** The timer's choices in seconds (0 is Off). */
export const TIMER_CHOICES: { sec: number; words: string }[] = [
  { sec: 0, words: "Off" },
  { sec: 3, words: "Every 3 s" },
  { sec: 5, words: "Every 5 s" },
  { sec: 10, words: "Every 10 s" },
  { sec: 30, words: "Every 30 s" },
  { sec: 60, words: "Every minute" },
  { sec: 300, words: "Every 5 minutes" },
  { sec: 900, words: "Every 15 minutes" },
  { sec: 3600, words: "Every hour" },
];

const Hint = ({ hint, reason }: { hint: string; reason?: string | null }) =>
  reason ? <span className="type-caption text-fg-2" data-field-reason>{reason}</span> : <span className="type-caption text-fg-3" data-field-hint>{hint}</span>;

export function RouletteTimerField({ node, label, hint, reason, setProp }: { node: ComponentNode; label: string; hint: string; reason?: string | null; setProp(k: string, v: PropValue | null): void }) {
  const cur = timerOf(node.props.timerSec) ?? 0;
  const known = TIMER_CHOICES.some((c) => c.sec === cur);
  return (
    <label className="flex flex-col gap-1" data-field="timerSec">
      <span className={labelCls} data-field-label>{label}</span>
      <select className={inputCls} value={String(cur)} onChange={(e) => setProp("timerSec", Number(e.target.value) ? Number(e.target.value) : null)} data-roulette-timer>
        {TIMER_CHOICES.map((c) => (
          <option key={c.sec} value={String(c.sec)}>{c.words}</option>
        ))}
        {!known ? <option value={String(cur)}>{`Every ${cur} s`}</option> : null}
      </select>
      <Hint hint={hint} reason={reason} />
    </label>
  );
}

/** Round 3 item 13: the sentence when nothing can turn the roulette (every way off and no timer). */
export const ROULETTE_STUCK = "Nothing turns this roulette now; viewers see only its first slot. Switch one of these on, or set Turn on its own.";

export function RouletteAdvanceField({ node, label, hint, reason, setProp }: { node: ComponentNode; label: string; hint: string; reason?: string | null; setProp(k: string, v: PropValue | null): void }) {
  const a = advanceOf(node.props.advance);
  const set = (k: keyof typeof a, on: boolean) => setProp("advance", { ...a, [k]: on });
  const stuck = !a.scroll && !a.arrows && !a.dots && timerOf(node.props.timerSec) === null;
  return (
    <div className="flex flex-col gap-1" data-field="advance" data-roulette-advance>
      <span className={labelCls} data-field-label>{label}</span>
      <Hint hint={hint} reason={reason} />
      <SwitchRow label="The wheel, after a click on it" checked={a.scroll} onCheckedChange={(c) => set("scroll", c)} />
      <SwitchRow label="Arrow buttons and keys" checked={a.arrows} onCheckedChange={(c) => set("arrows", c)} />
      <SwitchRow label="Dots, one per slot" checked={a.dots} onCheckedChange={(c) => set("dots", c)} />
      {stuck ? <span className="type-caption text-fg-2" role="status" data-roulette-stuck>{ROULETTE_STUCK}</span> : null}
    </div>
  );
}

/**
 * Round 3 item 9: "Shows first" counts from 1, like the dots ("Show 2 of 3"); it is stored from 0. A number
 * past the last slot is held to the last one and says why; in repeat mode the rows decide the count.
 */
export function RouletteStartField({ node, label, hint, reason, setProp }: { node: ComponentNode; label: string; hint: string; /** Why the setting shows no effect here, said in the hint's place (Wave 2.10b F4). */ reason?: string | null; setProp(k: string, v: PropValue | null): void }) {
  const repeat = node.props.mode === "repeat";
  const slots = repeat ? ROULETTE_MAX : Math.max(1, Math.min(ROULETTE_MAX, node.children?.length ?? 0));
  const stored = typeof node.props.startAt === "number" ? node.props.startAt : 0;
  const shown = startSlot(stored, slots) + 1;
  const [text, setText] = useState(String(shown));
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => { setText(String(shown)); }, [shown]);
  const commit = (raw: string) => {
    const v = Math.floor(Number(raw));
    if (raw.trim() === "" || !Number.isFinite(v) || v < 1) { setSaid("Counts from 1: 1 is the first slot."); setProp("startAt", null); setText("1"); return; }
    const held = Math.min(v, slots);
    setSaid(held !== v ? (repeat ? `A roulette turns through at most ${ROULETTE_MAX} rows, so it opens on row ${held}.` : `This roulette has ${slots} ${slots === 1 ? "slot" : "slots"}, so it opens on slot ${held}.`) : null);
    setProp("startAt", held > 1 ? held - 1 : null);
    setText(String(held));
  };
  return (
    <label className="flex flex-col gap-1" data-field="startAt">
      <span className={labelCls} data-field-label>{label}</span>
      <input
        type="number"
        className={inputCls}
        min={1}
        max={slots}
        step={1}
        inputMode="numeric"
        value={text}
        onChange={(e) => { setText(e.target.value); const v = Math.floor(Number(e.target.value)); if (e.target.value !== "" && Number.isFinite(v) && v >= 1 && v <= slots) { setSaid(null); setProp("startAt", v > 1 ? v - 1 : null); } }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
        data-roulette-start
      />
      {(said ?? reason) ? <span className="type-caption text-fg-2" role="status" data-field-reason>{said ?? reason}</span> : <span className="type-caption text-fg-3" data-field-hint>{hint}</span>}
    </label>
  );
}

/** Where a node sits: its parent and index, anywhere in the document's pages. */
function placeOf(pages: { root: ComponentNode }[], id: string): { parent: ComponentNode; index: number } | null {
  const walk = (n: ComponentNode): { parent: ComponentNode; index: number } | null => {
    const i = (n.children ?? []).findIndex((c) => c.id === id);
    if (i >= 0) return { parent: n, index: i };
    for (const c of n.children ?? []) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  for (const p of pages) {
    const r = walk(p.root);
    if (r) return r;
  }
  return null;
}

/** The ops that replace a roulette by a list or a table over the same rows, in the same place and box. */
export function rouletteToListOps(node: ComponentNode, pages: { root: ComponentNode }[], to: "list" | "table"): DraftOp[] | null {
  const at = placeOf(pages, node.id);
  if (!at) return null;
  const items = node.props.items;
  const next: ComponentNode = {
    id: newId("c"),
    type: to,
    name: node.name,
    props: to === "table" ? { ...(items !== undefined ? { data: items } : {}) } : { ...(items !== undefined ? { items } : {}) },
    ...(node.slot ? { slot: node.slot } : {}),
    ...(node.responsive?.mobile?.slot ? { responsive: { mobile: { slot: node.responsive.mobile.slot } } } : {}),
    ...(node.title ? { title: node.title } : {}),
  };
  return [{ op: "node.remove", nodeId: node.id }, { op: "node.add", parentId: at.parent.id, index: at.index, node: next }];
}

export function RouletteTooMany({ node, rows, pages, onOps }: { node: ComponentNode; rows: number; pages: { root: ComponentNode }[]; onOps?: (ops: DraftOp[]) => void }) {
  if (rows <= ROULETTE_MAX) return null;
  const swap = (to: "list" | "table") => {
    const ops = rouletteToListOps(node, pages, to);
    if (ops && onOps) onOps(ops);
  };
  return (
    <div className="flex flex-col gap-2 border border-[color:var(--warn)] p-2" data-roulette-too-many={rows}>
      <p className="type-body m-0 text-fg">{`This list has ${rows > ROULETTE_MAX ? "more than " + ROULETTE_MAX : rows} rows; a roulette turns through at most ${ROULETTE_MAX}. A list or a table shows them all.`}</p>
      {onOps ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="min-h-9 border border-line-strong px-3 type-body text-fg hover:border-accent touch:min-h-11" onClick={() => swap("list")} data-roulette-to="list">Show as a list</button>
          <button type="button" className="min-h-9 border border-line-strong px-3 type-body text-fg hover:border-accent touch:min-h-11" onClick={() => swap("table")} data-roulette-to="table">Show as a table</button>
        </div>
      ) : null}
    </div>
  );
}

// ---- Round 2 (gauntlet w210c-r1 items 1 and 2) ----

/** Words for a data kind, in a sentence ("one number"). */
const KIND_WORDS: Record<string, string> = { stat: "one number", series: "a series over time", status: "a status list", table: "a table", list: "a list", text: "text" };
type Sample = { kind?: string; columns?: { key: string; label?: string; type?: string }[]; rows?: Record<string, unknown>[]; items?: unknown[] } | undefined;

/**
 * Why a repeat-mode roulette's rows cannot be drawn, in one sentence, or null when they can (or are still
 * loading). `value` is the field as stored, `drawn` what it reads now, `sources` the app's source names.
 */
export function rouletteItemsSentence(value: unknown, drawn: unknown, sources: readonly string[]): string | null {
  if (!isBinding(value)) return null;
  const t = value.$bind.trim();
  if (!t) return null;
  if (!/^\{\{[\s\S]*\}\}$/.test(t)) return "Write it as a template in double braces, such as {{ machines.rows }}, or pick a list below.";
  let used: string[] = [];
  try { used = sourcesInTemplate(t); } catch { used = []; }
  const missing = used.filter((u) => !u.startsWith("$") && !sources.includes(u));
  if (missing.length) return `This app has no data called ${missing[0]}. Pick a list below, or Connect data first.`;
  if (drawn === undefined || drawn === null) return null; // still loading
  if (Array.isArray(drawn)) return null;
  const k = drawn && typeof drawn === "object" ? (drawn as { kind?: unknown }).kind : typeof drawn === "string" ? "text" : typeof drawn === "number" ? "stat" : undefined;
  if (k === "table" || k === "status") return null;
  return `This reads ${KIND_WORDS[String(k)] ?? "one value"}, not rows. A roulette turns through the rows of a table or a status list, such as {{ machines.rows }}.`;
}

/** The binding for a source's rows ({{ name.rows }}, or .items for a status list). */
export function rowsTemplate(name: string, sample: Sample): string {
  return sample?.kind === "status" ? `{{ ${name}.items }}` : `{{ ${name}.rows }}`;
}

/** A ready template for one row: a stat with the row's first number and its name (like Card for each). */
export function rowTemplateNode(sample: Sample): ComponentNode {
  const cols = sample?.columns ?? [];
  const firstRow = sample?.rows?.[0] ?? {};
  const isNum = (c: { key: string; type?: string }) => c.type === "number" || c.type === "percent" || c.type === "bytes" || typeof firstRow[c.key] === "number";
  const nameCol = cols.find((c) => !isNum(c)) ?? cols[0];
  const numCol = cols.find(isNum);
  if (sample?.kind === "status") return { id: newId("c"), type: "stat", props: { value: { $bind: "{{ $item.state }}" }, label: { $bind: "{{ $item.label }}" } } };
  const props: Record<string, PropValue> = {};
  if (numCol) props.value = { $bind: `{{ $item.${numCol.key} }}` };
  if (nameCol) props.label = { $bind: `{{ $item.${nameCol.key} }}` };
  if (!numCol && nameCol) props.value = { $bind: `{{ $item.${nameCol.key} }}` };
  // Data not in yet: the row's name, which every machine and status row has; change it after.
  if (!cols.length) props.value = { $bind: "{{ $item.name }}" };
  return { id: newId("c"), type: "stat", props };
}

/**
 * The roulette's "One slot for each row of" (item 2): the same data line as other data fields (Pick data,
 * Write a template, the chip), plus a "Rows from" list of this app's data that binds its rows and, when the
 * roulette has no widget yet, adds a ready one for each row, in one step. A wrong template keeps what was
 * typed and says why in a sentence.
 */
export function RouletteItemsField({ node, field, sources, labelOf, data, drawn, onOps, setProp, tooMany }: {
  node: ComponentNode;
  field: ReactNode;
  sources: readonly string[];
  labelOf(name: string): string;
  data: Record<string, unknown> | undefined;
  drawn: unknown;
  onOps?: (ops: DraftOp[]) => void;
  setProp(k: string, v: PropValue | null): void;
  tooMany: ReactNode;
}) {
  const repeat = node.props.mode === "repeat";
  const sentence = repeat ? rouletteItemsSentence(node.props.items, drawn, sources) : null;
  const cur = isBinding(node.props.items) ? node.props.items.$bind : "";
  const empty = !(node.children ?? []).length;
  // Round 3 item 6: the source the rows come from, when the field reads one of this app's data.
  const fromSource = (() => { try { return sourcesInTemplate(cur).find((u) => sources.includes(u)) ?? null; } catch { return null; } })();
  const addReady = useCallback(() => {
    if (!onOps || !fromSource || (node.children ?? []).length) return;
    onOps([{ op: "node.add", parentId: node.id, node: rowTemplateNode(data?.[fromSource] as Sample) }]);
  }, [onOps, fromSource, node.children, node.id, data]);
  // Pick data (or a typed template) that binds the rows of an empty repeat roulette also adds the ready widget,
  // as "Rows from" does, once its data has arrived (or after a short wait, with the row's name).
  const before = useRef(cur);
  const pending = useRef<number | null>(null);
  useEffect(() => {
    const was = before.current;
    before.current = cur;
    if (was === cur || !repeat || !empty || !fromSource || sentence) return;
    pending.current = Date.now();
  }, [cur, repeat, empty, fromSource, sentence]);
  useEffect(() => {
    if (pending.current === null) return;
    if (!repeat || !empty || !fromSource) { pending.current = null; return; }
    const sample = data?.[fromSource] as Sample;
    const ready = !!sample && (sample.kind === "table" || sample.kind === "status");
    const wait = ready ? 0 : Math.max(0, 2500 - (Date.now() - pending.current));
    const h = setTimeout(() => { if (pending.current === null) return; pending.current = null; addReady(); }, wait);
    return () => clearTimeout(h);
  }, [cur, data, repeat, empty, fromSource, addReady]);
  const pick = (name: string) => {
    if (!name) return;
    const sample = data?.[name] as Sample;
    const items = { $bind: rowsTemplate(name, sample) };
    if (onOps && !(node.children ?? []).length) {
      onOps([{ op: "node.update", nodeId: node.id, patch: { props: { ...node.props, items } } } as DraftOp, { op: "node.add", parentId: node.id, node: rowTemplateNode(sample) }]);
    } else setProp("items", items);
  };
  return (
    <div className="flex flex-col gap-2" data-roulette-items>
      {field}
      {repeat && sources.length ? (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Rows from</span>
          <select className={inputCls} value={sources.find((s) => cur.includes(`${s}.`) || cur === `{{ ${s} }}`) ?? ""} onChange={(e) => pick(e.target.value)} data-roulette-rows-from>
            <option value="">Pick a list of this app&apos;s data</option>
            {sources.map((s) => {
              const k = (data?.[s] as Sample)?.kind;
              const fits = !k || k === "table" || k === "status";
              const rows = k === "table" ? (data?.[s] as Sample)?.rows?.length : k === "status" ? (data?.[s] as Sample)?.items?.length : undefined;
              return (
                <option key={s} value={s} disabled={!fits}>
                  {`${labelOf(s)}${rows !== undefined ? ` · ${rows} ${rows === 1 ? "row" : "rows"}` : ""}${fits ? "" : " (not a list)"}`}
                </option>
              );
            })}
          </select>
          <span className="type-caption text-fg-3">{(node.children ?? []).length ? "Its widget shows once for each row." : "Adds a ready widget for each row; change it after."}</span>
        </label>
      ) : null}
      {repeat && empty && fromSource && !sentence && onOps ? (
        <button type="button" className="self-start type-caption text-accent-ink underline underline-offset-2 min-h-9 touch:min-h-11" onClick={addReady} data-roulette-add-ready>
          {`Add a ready widget for each row of ${labelOf(fromSource)}`}
        </button>
      ) : null}
      {sentence ? <p role="alert" className="type-caption m-0 text-[color:var(--warn)]" data-roulette-items-wrong>{sentence}</p> : null}
      {tooMany}
    </div>
  );
}

/**
 * "Turns through" (item 1, A11.4): repeating for each row holds exactly one widget, so with two or more in
 * it that choice is off and says why; nothing is removed for you.
 */
export function RouletteModeField({ node, label, hint, words, setProp }: { node: ComponentNode; label: string; hint: string; words: Record<string, string>; setProp(k: string, v: PropValue | null): void }) {
  const mode = node.props.mode === "repeat" ? "repeat" : "slots";
  const kids = (node.children ?? []).length;
  const blocked = mode === "slots" && kids > 1;
  return (
    <label className="flex flex-col gap-1" data-field="mode">
      <span className={labelCls} data-field-label>{label}</span>
      <select className={inputCls} value={mode} onChange={(e) => setProp("mode", e.target.value)} data-roulette-mode>
        <option value="slots">{words.slots ?? "Its slots"}</option>
        <option value="repeat" disabled={blocked}>{words.repeat ?? "One widget for each row"}</option>
      </select>
      {blocked ? <span className="type-caption text-fg-2" data-field-reason>{`To repeat one widget for each row, keep one widget in it first (it holds ${kids}).`}</span> : <span className="type-caption text-fg-3" data-field-hint>{hint}</span>}
    </label>
  );
}
