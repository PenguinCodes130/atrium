"use client";
// Wave 2.10c N3: the roulette's own inspector fields (A11.4). The timer is a menu (Off, 3 s to 1 h), the
// ways to turn it are three switches, and a repeat over more than 50 rows offers a list or a table in its
// place (one draft step: the roulette is replaced by a list or table reading the same rows, in its slot).
import type { ComponentNode, DraftOp, PropValue } from "@/core/contracts";
import { newId } from "../ids";
import { advanceOf, ROULETTE_MAX, timerOf } from "../render/roulette";
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

export function RouletteAdvanceField({ node, label, hint, reason, setProp }: { node: ComponentNode; label: string; hint: string; reason?: string | null; setProp(k: string, v: PropValue | null): void }) {
  const a = advanceOf(node.props.advance);
  const set = (k: keyof typeof a, on: boolean) => setProp("advance", { ...a, [k]: on });
  return (
    <div className="flex flex-col gap-1" data-field="advance" data-roulette-advance>
      <span className={labelCls} data-field-label>{label}</span>
      <Hint hint={hint} reason={reason} />
      <SwitchRow label="The wheel, after a click on it" checked={a.scroll} onCheckedChange={(c) => set("scroll", c)} />
      <SwitchRow label="Arrow buttons and keys" checked={a.arrows} onCheckedChange={(c) => set("arrows", c)} />
      <SwitchRow label="Dots, one per slot" checked={a.dots} onCheckedChange={(c) => set("dots", c)} />
    </div>
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
