"use client";
// Layout containers (spec 3.1.2): grid (6, 12 or 24 columns on desktop (A7.4), 4 on phones, rows of 8px), stack,
// card, tabs, section and repeat (its one child per row or item, with $item and $index).
import { useId, useState, type KeyboardEvent } from "react";
import type { ComponentNode, GridSlot, RenderContext } from "@/core/contracts";
import { text as textOf } from "../bindings";
import { useNodeEnv } from "./context";
import { nodeSources, repeatItems, valueKey } from "./resolve";
import { columnFormats, ITEM_FORMATS } from "./format";
import { NodeTitleBar } from "./titlebar";
import { rollupStatus } from "./rollup";
import { sizingOf } from "../catalogue/meta";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };
const str = (v: unknown) => textOf(v);

const EMPTY_COLLAPSES = new Set(["grid", "stack", "section"]);

export const GRID = { desktopColumns: 12, mobileColumns: 4, rowPx: 8 } as const;

/** A grid's desktop column count (A7.4): 6, 12 or 24, default 12. Phones are always 4. */
export function gridColumnsOf(props: Record<string, unknown> | undefined, mobile: boolean): number {
  if (mobile) return GRID.mobileColumns;
  const c = props?.columns;
  return c === 6 || c === 24 ? c : GRID.desktopColumns;
}

const eighth = (n: number) => Math.round(n * 8) / 8;

/**
 * Grid placement for a child: its slot (mobile slot on phones); without one on phones it spans the row.
 * Whole-number slots place exactly as before. A fine slot (x or w in eighths of a column, A7.4) spans the
 * whole columns it touches and is inset inside them with a margin and width measured in columns: the
 * column step is the grid area plus one gap, divided by the columns it spans (`--atr-colgap`).
 */
export function cellStyle(slot: GridSlot | undefined, mobile: boolean, heightRows?: number, columns?: number): React.CSSProperties {
  const cols = columns ?? (mobile ? GRID.mobileColumns : GRID.desktopColumns);
  // Without a slot (phones), children stack in order; the cell's bottom padding is the gap.
  if (!slot) return { gridColumn: "1 / -1", ...(heightRows ? { gridRow: `auto / span ${heightRows}` } : {}) };
  const h = Math.max(1, Math.round(slot.h));
  const row = `${Math.max(0, Math.round(slot.y)) + 1} / span ${h}`;
  const fine = !Number.isInteger(slot.x) || !Number.isInteger(slot.w);
  if (!fine) {
    const w = Math.max(1, Math.min(cols, Math.round(slot.w)));
    const x = Math.max(0, Math.min(cols - w, Math.round(slot.x)));
    return { gridColumn: `${x + 1} / span ${w}`, gridRow: row };
  }
  const w = Math.max(0.125, Math.min(cols, eighth(slot.w)));
  const x = Math.max(0, Math.min(cols - w, eighth(slot.x)));
  const a = Math.floor(x);
  const b = Math.min(cols, Math.ceil(x + w));
  const n = Math.max(1, b - a);
  const g = "var(--atr-colgap, 0px)";
  return {
    gridColumn: `${a + 1} / span ${n}`,
    gridRow: row,
    justifySelf: "start",
    marginLeft: x === a ? undefined : `calc((100% + ${g}) * ${(x - a) / n})`,
    width: `max(0px, calc((100% + ${g}) * ${w / n} - ${g}))`,
  };
}

/**
 * Cards that start on the same row stretch to the tallest one in that row (gauntlet w2-r1 Fix 9), as
 * far as nothing else placed in their columns starts first. Returns the slot to draw per child id;
 * the document's slots are never changed. Fine slots (eighths of a column) overlap by their real edges.
 */
export function stretchRows(slots: { id: string; slot?: GridSlot }[], cols: number): Record<string, GridSlot> {
  const placed = slots.flatMap((s) => (s.slot ? [{ id: s.id, x: Math.max(0, eighth(s.slot.x)), w: Math.max(0.125, Math.min(cols, eighth(s.slot.w))), y: Math.max(0, Math.round(s.slot.y)), h: Math.max(1, Math.round(s.slot.h)), slot: s.slot }] : []));
  const out: Record<string, GridSlot> = {};
  for (const a of placed) {
    const bandEnd = Math.max(...placed.filter((b) => b.y === a.y).map((b) => b.y + b.h));
    let end = bandEnd;
    for (const b of placed) {
      if (b === a || b.x >= a.x + a.w || a.x >= b.x + b.w) continue; // other columns
      if (b.y >= a.y + a.h && b.y < end) end = b.y;
    }
    out[a.id] = end > a.y + a.h ? { ...a.slot, h: end - a.y } : a.slot;
  }
  return out;
}

/**
 * Slots with the rows that only hidden children covered taken out (A7.3: a hidden child takes no space).
 * Rows a visible child also covers stay; every slot below a removed row moves up by one. Without hidden
 * slots the list comes back unchanged.
 */
export function closeHiddenRows(slots: { id: string; slot?: GridSlot }[], hidden: (GridSlot | undefined)[]): { id: string; slot?: GridSlot }[] {
  const gone = new Set<number>();
  for (const h of hidden) if (h) for (let r = Math.max(0, Math.round(h.y)); r < Math.round(h.y) + Math.max(1, Math.round(h.h)); r++) gone.add(r);
  if (!gone.size) return slots;
  for (const s of slots) if (s.slot) for (let r = Math.round(s.slot.y); r < Math.round(s.slot.y) + Math.round(s.slot.h); r++) gone.delete(r);
  if (!gone.size) return slots;
  const rows = [...gone];
  return slots.map((s) => (s.slot ? { ...s, slot: { ...s.slot, y: s.slot.y - rows.filter((r) => r < s.slot!.y).length } } : s));
}

export function GridView({ node, resolved }: P) {
  const env = useNodeEnv();
  const mobile = env.device === "mobile";
  const edit = env.ctx.mode === "edit";
  const gap = typeof resolved.gap === "number" ? `${resolved.gap}px` : undefined;
  const minRows = typeof resolved.minRows === "number" ? resolved.minRows : 12;
  const cols = gridColumnsOf(resolved, mobile);
  // A hidden child (A7.3, this device) is not drawn outside the builder's edit mode, and the rows only it
  // covered close up, so it leaves no gap (criterion 15).
  const all = node.children ?? [];
  const isHidden = (c: ComponentNode) => (mobile ? c.responsive?.mobile?.hidden === true : c.hidden === true);
  const children = edit ? all : all.filter((c) => !isHidden(c));
  const slotOf = (c: ComponentNode) => (mobile ? c.responsive?.mobile?.slot : c.slot);
  const slots = closeHiddenRows(children.map((c) => ({ id: c.id, slot: slotOf(c) })), edit ? [] : all.filter(isHidden).map(slotOf));
  // The builder draws the exact slots (so resizing matches what is saved); everywhere else rows stretch.
  const drawn = edit ? Object.fromEntries(slots.flatMap((s) => (s.slot ? [[s.id, s.slot]] : []))) : stretchRows(slots, cols);
  // An empty grid takes no room for viewers (Fix 16); in the builder it keeps its drop area.
  const empty = children.length === 0 && !edit;
  // Exact boxes (operator, 2026-10-19): when every child has a slot, rows are a fixed 8px, so a component
  // is exactly the size it was drawn and its content scrolls inside; content never stretches the rows
  // and moves its neighbours. Children without a slot (phones) still stack at their content height.
  // An HTML block set to fill the window (A7.6) sets its own height, so its grid keeps rows that grow.
  const fills = (c: ComponentNode) => c.type === "html" && (mobile ? c.responsive?.mobile?.props?.height ?? c.props.height : c.props.height) === "fill";
  const fixed = slots.length > 0 && slots.every((s) => s.slot) && !children.some(fills);
  // A11.2 (Wave 2.10a B1, B2): outside the builder a component that fits its content is never clipped. Rows
  // stay 8px where content fits the drawn box; a fit box whose content is taller grows its rows (pushing
  // what is below down), as the builder's Fit would. Scrolling kinds and a group that keeps its height
  // (reflow) hold their drawn box (components.css: they add no height of their own).
  const grow = fixed && !edit;
  return (
    <div
      data-slot="root"
      className="atr-grid canvas-grid"
      data-columns={cols}
      data-empty={empty ? "" : undefined}
      data-fixed-rows={fixed ? "" : undefined}
      data-grow-rows={grow ? "" : undefined}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: fixed && !grow ? `${GRID.rowPx}px` : `minmax(${GRID.rowPx}px, auto)`, columnGap: gap, minHeight: empty ? 0 : minRows * GRID.rowPx, ...(gap ? { ["--atr-colgap" as string]: gap } : {}) }}
    >
      {children.map((c) => {
        const sizing = sizingOf(c);
        // Round 2 item 2: a scale kind (icon, image, chart, ...) keeps the box it was drawn at in the viewer,
        // as in the builder: it takes neither a row band's stretch nor rows a neighbour grew (components.css
        // pins its height to its own rows), so what it draws never depends on what sits beside it.
        const own = grow && sizing === "scale" ? slots.find((s) => s.id === c.id)?.slot : undefined;
        const slot = own ?? drawn[c.id];
        // An empty layout container takes no room for viewers (Fix 16); the builder keeps it to drop into.
        if (!edit && EMPTY_COLLAPSES.has(c.type) && !(c.children ?? []).length) return null;
        const style = cellStyle(slot, mobile, mobile && !slot ? c.slot?.h : undefined, cols);
        if (own) (style as Record<string, unknown>)["--atr-rows"] = Math.max(1, Math.round(own.h));
        return (
          <div key={c.id} className="atr-cell" data-cell={c.id} data-fill-cell={fills(c) ? "" : undefined} style={style} data-sizing={sizing}>
            {env.renderChild(c)}
          </div>
        );
      })}
    </div>
  );
}

export function StackView({ node, resolved }: P) {
  const env = useNodeEnv();
  const dir = resolved.direction === "horizontal" ? "row" : "column";
  return (
    <div
      data-slot="root"
      className="atr-stack"
      style={{ flexDirection: dir, gap: typeof resolved.gap === "number" ? resolved.gap : undefined, alignItems: resolved.align === "start" ? "flex-start" : resolved.align === "end" ? "flex-end" : resolved.align === "center" ? "center" : "stretch", flexWrap: resolved.wrap === true ? "wrap" : undefined }}
    >
      {(node.children ?? []).map((c) => env.renderChild(c, { key: c.id }))}
    </div>
  );
}

export function CardView({ node, resolved }: P) {
  const env = useNodeEnv();
  const title = str(resolved.title);
  const subtitle = str(resolved.subtitle);
  const id = useId();
  // The card is the outer window: its bar carries the worst status of the data inside it (Fix 4).
  const rolled = rollupStatus(node.children ?? [], env.scope, { edit: env.ctx.mode === "edit", path: env.path });
  return (
    <section data-slot="root" className={`atr-card canvas-surface ${resolved.padded === false ? "canvas-surface-flush" : ""}`} aria-labelledby={title ? id : undefined} data-rollup={rolled.kind}>
      <NodeTitleBar fallback={title} status={rolled} />
      {title ? (
        <header data-slot="title" className="atr-card-title">
          <h3 id={id}>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
      ) : null}
      <div data-slot="body" className="atr-card-body">
        {(node.children ?? []).map((c) => env.renderChild(c, { key: c.id }))}
      </div>
    </section>
  );
}

export function SectionView({ node, resolved }: P) {
  const env = useNodeEnv();
  const title = str(resolved.title);
  const description = str(resolved.description);
  return (
    <section data-slot="root" className="atr-section">
      {title ? (
        <h2 data-slot="title" className="atr-section-title">
          {title}
        </h2>
      ) : null}
      {description ? (
        <p data-slot="description" className="atr-section-desc">
          {description}
        </p>
      ) : null}
      <div className="atr-section-body">{(node.children ?? []).map((c) => env.renderChild(c, { key: c.id }))}</div>
    </section>
  );
}

export function TabsView({ node, resolved }: P) {
  const env = useNodeEnv();
  const labels = Array.isArray(resolved.labels) ? (resolved.labels as unknown[]).map(str) : [];
  const children = node.children ?? [];
  const initial = typeof resolved.initial === "number" ? resolved.initial : 0;
  const [active, setActive] = useState(Math.min(Math.max(0, initial), Math.max(0, children.length - 1)));
  const id = useId();
  const count = Math.max(children.length, 1);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") setActive((a) => (a + 1) % count);
    else if (e.key === "ArrowLeft") setActive((a) => (a - 1 + count) % count);
    else return;
    e.preventDefault();
  };
  return (
    <div data-slot="root" className="atr-tabs">
      <div role="tablist" className="atr-tablist" onKeyDown={onKey}>
        {children.map((c, i) => (
          <button key={c.id} type="button" role="tab" id={`${id}-t${i}`} aria-controls={`${id}-p${i}`} aria-selected={i === active} tabIndex={i === active ? 0 : -1} data-slot="tab" data-state={i === active ? "on" : "off"} onClick={() => setActive(i)}>
            {labels[i] || c.name || `Tab ${i + 1}`}
          </button>
        ))}
      </div>
      {children.map((c, i) => (
        <div key={c.id} role="tabpanel" id={`${id}-p${i}`} aria-labelledby={`${id}-t${i}`} hidden={i !== active} data-slot="panel">
          {i === active ? env.renderChild(c) : null}
        </div>
      ))}
    </div>
  );
}

export function RepeatView({ node, resolved }: P) {
  const env = useNodeEnv();
  const child = node.children?.[0];
  const max = typeof resolved.max === "number" ? resolved.max : 50;
  const guest = env.scope.$guest;
  const count = guest ? Number(guest[valueKey(node.id, "$count", env.path)] ?? 0) : undefined;
  const items = guest ? Array.from({ length: Math.min(200, Math.max(0, count ?? 0)) }, () => undefined) : repeatItems(resolved.items, max);
  const cols = env.device === "mobile" ? 1 : typeof resolved.columns === "number" ? resolved.columns : 1;
  // A8.4: "this row" values keep their column's format, so a card for each machine shows "12.4 GB".
  const src = nodeSources(node, env.scope)[0];
  const formats = src ? columnFormats(env.scope.$data?.[src]) : {};
  if (!child) return <div data-slot="root" className="atr-repeat atr-muted">{env.ctx.mode === "edit" ? "Drop one component here to repeat it." : null}</div>;
  if (!items.length) return <p data-slot="root" className="atr-repeat atr-muted">{str(resolved.empty) || "Nothing to show"}</p>;
  return (
    <div data-slot="root" className="atr-repeat" data-count={items.length} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: typeof resolved.gap === "number" ? resolved.gap : undefined }}>
      {items.map((item, i) => (
        <div key={i} data-slot="item" data-index={i}>
          {env.renderChild(child, { scope: guest ? {} : { $item: item, $index: i, [ITEM_FORMATS]: formats }, path: env.path ? `${env.path}.${i}` : String(i) })}
        </div>
      ))}
    </div>
  );
}
