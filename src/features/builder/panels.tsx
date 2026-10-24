"use client";
// The builder's left column (design v4 "The Builder"): Insert (the component catalogue by category plus
// library components, searchable; drag onto the canvas or add to the selected container) and Layers (the
// page tree; drag to reorder or re-parent; agent-made nodes carry an `agent` tag until published).
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import type { ComponentNode, PageDoc } from "@/core/contracts";
import { nodeLabel, walk } from "@/features/apps/doc";

export type InsertItem = { type: string; title: string; summary?: string; node: ComponentNode; containsCode?: boolean; insertId?: string };
export type InsertGroup = { category: string; title?: string; folded?: boolean; items: InsertItem[] };

const CATEGORY_TITLE: Record<string, string> = { layout: "Layout", data: "Data", content: "Content", control: "Controls", code: "Code", library: "Library" };

/**
 * A small line drawing of each component type for the Insert catalogue (gauntlet w2-r1 item 17), so the
 * catalogue reads at a glance instead of as identical text boxes. Ink strokes, one accent mark.
 */
export function InsertGlyph({ type }: { type: string }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.4 } as const;
  const a = { fill: "var(--accent)", stroke: "none" } as const;
  let body: ReactNode;
  switch (type) {
    case "grid": body = <><rect x="2" y="2" width="12" height="9" {...s} /><rect x="16" y="2" width="14" height="9" {...s} /><rect x="2" y="13" width="28" height="9" {...s} /></>; break;
    case "stack": body = <><rect x="4" y="2" width="24" height="5" {...s} /><rect x="4" y="9.5" width="24" height="5" {...s} /><rect x="4" y="17" width="24" height="5" {...s} /></>; break;
    case "card": case "section": body = <><rect x="2" y="2" width="28" height="20" {...s} /><path d="M2 8h28" {...s} /><rect x="5" y="4" width="8" height="2" {...a} /></>; break;
    case "tabs": body = <><path d="M2 8h28v14H2zM2 8V3h9v5M11 4h9v4" {...s} /><rect x="3" y="4" width="7" height="3" {...a} /></>; break;
    case "repeat": body = <><rect x="2" y="3" width="8" height="18" {...s} /><rect x="12" y="3" width="8" height="18" {...s} /><rect x="22" y="3" width="8" height="18" {...s} /></>; break;
    case "stat": case "gauge": case "progress": body = <><text x="3" y="17" fontSize="13" fontFamily="var(--font-mono, monospace)" fill="currentColor">42</text><rect x="22" y="12" width="7" height="3" {...a} /></>; break;
    case "chart": body = <><path d="M2 21h28M2 2v19" {...s} /><path d="M3 17l6-5 5 3 7-9 8 4" fill="none" stroke="var(--accent-ink)" strokeWidth={1.8} /></>; break;
    case "table": case "list": body = <><rect x="2" y="2" width="28" height="20" {...s} /><path d="M2 8h28M2 14h28M12 2v20" {...s} /></>; break;
    case "status": body = <><circle cx="6" cy="6" r="2.5" {...a} /><path d="M11 6h17M11 12h17M11 18h17" {...s} /><circle cx="6" cy="12" r="2.5" {...s} /><circle cx="6" cy="18" r="2.5" {...s} /></>; break;
    case "heading": body = <><path d="M4 5v14M14 5v14M4 12h10" {...s} strokeWidth={2} /><path d="M19 9h9M19 15h6" {...s} /></>; break;
    case "text": body = <path d="M3 5h26M3 10h26M3 15h20M3 20h14" {...s} />; break;
    case "image": body = <><rect x="2" y="2" width="28" height="20" {...s} /><path d="M2 19l8-7 6 5 5-4 9 7" {...s} /><circle cx="22" cy="7" r="2.5" {...a} /></>; break;
    case "icon": body = <path d="M16 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" {...s} />; break;
    case "link": body = <><path d="M4 18h18" {...s} /><path d="M20 4h8v8M28 4L16 16" {...s} /></>; break;
    case "divider": case "spacer": body = <path d="M2 12h28" {...s} strokeDasharray={type === "spacer" ? "3 3" : undefined} />; break;
    case "clock": body = <><circle cx="16" cy="12" r="9.5" {...s} /><path d="M16 6v6l4 3" {...s} /></>; break;
    case "button": body = <><rect x="3" y="6" width="26" height="12" {...a} /><path d="M10 12h12" stroke="var(--accent-fg)" strokeWidth={1.6} /></>; break;
    case "toggle": body = <><rect x="5" y="6" width="22" height="12" rx="6" {...s} /><circle cx="21" cy="12" r="4" {...a} /></>; break;
    case "slider": body = <><path d="M3 12h26" {...s} /><path d="M3 12h15" stroke="var(--accent-ink)" strokeWidth={2} /><circle cx="18" cy="12" r="3.5" {...a} /></>; break;
    case "select": body = <><rect x="2" y="6" width="28" height="12" {...s} /><path d="M22 10l3 3 3-3" {...s} /></>; break;
    // Wave 2.9 (A10.7) and the start page.
    case "service-tile": body = <><rect x="2" y="3" width="28" height="18" {...s} /><rect x="5" y="6" width="6" height="6" {...a} /><path d="M14 8h10M5 17h5M13 17h5M21 17h5" {...s} /></>; break;
    case "group": body = <><path d="M2 5h12" {...s} strokeWidth={2} /><rect x="2" y="8" width="13" height="6" {...s} /><rect x="17" y="8" width="13" height="6" {...s} /><rect x="2" y="16" width="13" height="6" {...s} /></>; break;
    case "resource-bar": body = <><rect x="2" y="8" width="28" height="8" {...s} /><path d="M5 13h5M13 13h5M21 13h5" {...s} /><rect x="5" y="10" width="3" height="1.5" {...a} /></>; break;
    case "bookmarks": body = <><circle cx="5" cy="6" r="2" {...a} /><path d="M10 6h18M10 12h18M10 18h18" {...s} /><circle cx="5" cy="12" r="2" {...s} /><circle cx="5" cy="18" r="2" {...s} /></>; break;
    case "start-page": body = <><rect x="2" y="2" width="28" height="4" {...a} /><rect x="2" y="8" width="8" height="14" {...s} /><rect x="12" y="8" width="8" height="14" {...s} /><rect x="22" y="8" width="8" height="14" {...s} /></>; break;
    case "html": body = <path d="M10 6l-6 6 6 6M22 6l6 6-6 6M18 4l-4 16" {...s} />; break;
    default: body = type.startsWith("lib:") ? <><rect x="3" y="3" width="26" height="18" {...s} /><path d="M3 3l8 8M29 3l-8 8" {...s} /><rect x="12" y="9" width="8" height="6" {...a} /></> : <rect x="3" y="3" width="26" height="18" {...s} />;
  }
  return <svg viewBox="0 0 32 24" width={32} height={24} aria-hidden className="flex-none text-fg-2" data-insert-glyph={type}>{body}</svg>;
}

export function InsertPanel({ groups, onAdd, onPickUp }: { groups: InsertGroup[]; onAdd(item: InsertItem): void; onPickUp(item: InsertItem, e: ReactPointerEvent): void }) {
  const [q, setQ] = useState("");
  // Groups marked folded (Code) start collapsed; a click or a matching search opens them (SFR-2).
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return groups.map((g) => ({ ...g, items: g.items.filter((i) => !t || i.title.toLowerCase().includes(t) || i.type.toLowerCase().includes(t) || (i.summary ?? "").toLowerCase().includes(t)) })).filter((g) => g.items.length);
  }, [groups, q]);
  const isOpen = (g: InsertGroup) => !g.folded || !!q.trim() || !!opened[g.category];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-insert-panel>
      <div className="border-b border-line p-2">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search components" aria-label="Search components" className="h-8 w-full border border-line-strong bg-bg-hi px-2 type-body outline-none focus-visible:outline-2 focus-visible:outline-accent-ink" data-insert-search />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 && <p className="p-2 type-body text-fg-2">No components match.</p>}
        {shown.map((g) => (
          <section key={g.category} className="mb-3" data-insert-group={g.category}>
            {g.folded ? (
              <h3 className="mb-1">
                <button type="button" aria-expanded={isOpen(g)} onClick={() => setOpened((o) => ({ ...o, [g.category]: !isOpen(g) }))} className="flex min-h-8 w-full items-center gap-1.5 px-1 text-left font-mono text-[11px] uppercase text-fg-2 hover:text-fg touch:min-h-11" data-insert-fold={g.category}>
                  <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className={`flex-none transition-transform duration-150 motion-reduce:transition-none ${isOpen(g) ? "rotate-90" : ""}`}><path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" /></svg>
                  {g.title ?? CATEGORY_TITLE[g.category] ?? g.category} <span className="normal-case">({g.items.length})</span>
                </button>
              </h3>
            ) : (
              <h3 className="mb-1 px-1 font-mono text-[11px] uppercase text-fg-2">{g.title ?? CATEGORY_TITLE[g.category] ?? g.category}</h3>
            )}
            {isOpen(g) && <ul className="grid grid-cols-2 gap-1">
              {g.items.map((item) => (
                <li key={`${g.category}:${item.type}:${item.title}`}>
                  <button
                    type="button"
                    className="flex h-full min-h-14 w-full touch-none select-none flex-col items-start gap-1 border border-line bg-bg-hi p-2 text-left hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent-ink"
                    onClick={() => onAdd(item)}
                    onPointerDown={(e) => { if (e.button === 0) onPickUp(item, e); }}
                    title={item.summary}
                    data-insert-item={item.insertId ?? item.type}
                  >
                    <InsertGlyph type={item.type} />
                    <span className="type-label">{item.title}</span>
                    {item.summary && <span className="line-clamp-2 type-caption text-fg-2" data-insert-summary>{item.summary}</span>}
                    {item.containsCode && <span className="font-mono text-[10px] text-fg-2">contains code</span>}
                  </button>
                </li>
              ))}
            </ul>}
          </section>
        ))}
      </div>
    </div>
  );
}

type LayerRow = { id: string; label: string; depth: number; parentId: string | null; index: number; container: boolean; type: string; hidden: boolean; named: string };

const ACT = "flex h-7 w-7 flex-none items-center justify-center border border-transparent text-fg-2 hover:border-line-strong hover:bg-bg-hi hover:text-fg disabled:opacity-30 disabled:hover:border-transparent touch:h-11 touch:w-11";
const menuItem = "flex h-8 cursor-pointer select-none items-center px-2 text-left type-label outline-none data-[highlighted]:bg-bg-sunk touch:h-11";

/**
 * The page tree (spec 3.4). Each row's actions (show or hide on the device being edited, up and down one
 * step within its parent, and a menu with Rename, Duplicate and Delete) show on hover, always on the
 * selected row, and always on touch screens. Double-click a name to rename it: Enter saves, Esc cancels.
 */
export function LayersPanel({ page, selectedId, agentNodes, onSelect, onMove, stepButtons, device = "desktop", onHide, onRename, onDuplicate, onDelete, covered, selectedIds }: {
  page: PageDoc; selectedId: string | null; agentNodes: Set<string>; onSelect(id: string, opts?: { shift: boolean }): void; onMove(nodeId: string, parentId: string, index: number): void;
  /** Widgets drawn fully under another (spec 3.2): their rows carry a "covered" tag. */ covered?: ReadonlySet<string>;
  /** Several selected (Shift-click): each row shows as selected. */ selectedIds?: ReadonlySet<string>;
  /** Touch and narrow screens: Move up and Move down on the selected row (gauntlet w2-r1 item 11). */ stepButtons?: boolean;
  device?: "desktop" | "mobile";
  onHide?(id: string): void; onRename?(id: string, name: string): void; onDuplicate?(id: string): void; onDelete?(id: string): void;
}) {
  const rows = useMemo<LayerRow[]>(() => [...walk(page)].map((l) => ({ id: l.node.id, label: nodeLabel(l.node), depth: l.path.length, parentId: l.parent?.id ?? null, index: l.index, container: !!l.node.children, type: l.node.type, hidden: device === "mobile" ? l.node.responsive?.mobile?.hidden === true : l.node.hidden === true, named: l.node.name ?? "" })), [page, device]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  if (rows.length <= 1) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-layers-panel>
        <ul role="tree" aria-label="Layers">{rows.map((r) => <li key={r.id} role="treeitem" aria-selected={r.id === selectedId} className="flex min-h-8 items-center px-2 type-label touch:min-h-11" onClick={() => onSelect(r.id)} data-layer={r.id}>{r.label}</li>)}</ul>
        <p className="p-2 type-caption text-fg-2" data-layers-empty>Drag something from Insert, or drop a picture here.</p>
      </div>
    );
  }
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto p-2" role="tree" aria-label="Layers" data-layers-panel>
      {rows.map((r) => {
        const sel = r.id === selectedId || !!selectedIds?.has(r.id);
        const count = r.parentId ? siblingCount(rows, r.parentId) : 0;
        const act = stepButtons ? `${ACT} !h-11 !w-11` : ACT;
        return (
          <li
            key={r.id}
            role="treeitem"
            aria-selected={sel}
            draggable={r.parentId !== null && editing !== r.id}
            onDragStart={(e) => { setDragging(r.id); e.dataTransfer.setData("text/x-atrium-layer", r.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => { if (dragging && dragging !== r.id) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/x-atrium-layer") || dragging;
              setDragging(null);
              if (!id || id === r.id) return;
              // Dropping on a container's right half re-parents into it; anywhere else places it before the row.
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (r.container && e.clientX > rect.left + rect.width / 2) onMove(id, r.id, Number.MAX_SAFE_INTEGER);
              else if (r.parentId) onMove(id, r.parentId, r.index);
            }}
            className={`group flex min-h-8 cursor-pointer items-center gap-1 border border-transparent pr-1 type-label touch:min-h-11 ${sel ? "border-line-strong bg-bg-sunk" : "hover:bg-bg-sunk"}`}
            style={{ paddingLeft: 8 + r.depth * 14 }}
            onClick={(e) => onSelect(r.id, { shift: e.shiftKey })}
            data-layer={r.id}
            data-layer-hidden={r.hidden ? "" : undefined}
            data-layer-covered={covered?.has(r.id) ? "" : undefined}
          >
            {editing === r.id ? (
              <RenameBox initial={r.named || r.label} onDone={(v) => { setEditing(null); if (v !== null) onRename?.(r.id, v); }} />
            ) : (
              <span
                className={`min-w-0 flex-1 truncate ${r.hidden ? "text-fg-2 line-through decoration-fg-2/60 opacity-60" : ""}`}
                onDoubleClick={(e) => { if (!r.parentId || !onRename) return; e.stopPropagation(); setEditing(r.id); }}
                title={r.parentId && onRename ? "Double-click to rename" : undefined}
                data-layer-name
              >
                {r.label}
              </span>
            )}
            {agentNodes.has(r.id) && <span className="bg-fg px-1 font-mono text-[10px] text-bg" data-agent-tag>agent</span>}
            {covered?.has(r.id) && <span className="flex-none border border-[color:var(--warn-ink)] px-1 font-mono text-[10px] text-[color:var(--warn-ink)]" title="Fully under another widget, so nobody can see or click it. Move it, or move it up in Layers." data-covered-tag>covered</span>}
            {r.parentId && editing !== r.id && (onHide || onDelete) && (
              <span className={`flex flex-none items-center ${sel || stepButtons ? "" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100"}`} data-layer-actions>
                {onHide && (
                  <button type="button" className={act} aria-pressed={r.hidden} aria-label={`${r.hidden ? "Show" : "Hide"} ${r.label} on ${device === "mobile" ? "phones" : "desktop"}`} title={`${r.hidden ? "Show" : "Hide"} on ${device === "mobile" ? "phones" : "desktop"}`} onClick={(e) => { e.stopPropagation(); onHide(r.id); }} data-layer-eye={r.hidden ? "off" : "on"}>
                    <EyeGlyph off={r.hidden} />
                  </button>
                )}
                <button type="button" className={act} aria-label={`Move ${r.label} up`} title="Move up one step" disabled={r.index === 0} onClick={(e) => { e.stopPropagation(); onMove(r.id, r.parentId!, r.index - 1); }} data-layer-up>↑</button>
                <button type="button" className={act} aria-label={`Move ${r.label} down`} title="Move down one step" disabled={r.index >= count - 1} onClick={(e) => { e.stopPropagation(); onMove(r.id, r.parentId!, r.index + 1); }} data-layer-down>↓</button>
                {(onRename || onDuplicate || onDelete) && (
                  <DropdownMenu.Root modal={false}>
                    <DropdownMenu.Trigger asChild>
                      <button type="button" className={act} aria-label={`More for ${r.label}`} title="Rename, duplicate or delete" onClick={(e) => e.stopPropagation()} data-layer-menu>
                        <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden><circle cx="2.5" cy="6" r="1.2" fill="currentColor" /><circle cx="6" cy="6" r="1.2" fill="currentColor" /><circle cx="9.5" cy="6" r="1.2" fill="currentColor" /></svg>
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8} className="z-50 flex w-40 flex-col border border-line-strong bg-bg-hi p-1 text-fg shadow-window-sm" data-layer-menu-content={r.id}>
                        {onRename && <DropdownMenu.Item className={menuItem} onSelect={() => setEditing(r.id)} data-layer-rename>Rename</DropdownMenu.Item>}
                        {onDuplicate && <DropdownMenu.Item className={menuItem} onSelect={() => onDuplicate(r.id)} data-layer-duplicate>Duplicate</DropdownMenu.Item>}
                        {onDelete && <DropdownMenu.Item className={`${menuItem} text-bad`} onSelect={() => onDelete(r.id)} data-layer-delete>Delete</DropdownMenu.Item>}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Renaming in place: Enter saves, Esc cancels, leaving the box saves. */
function RenameBox({ initial, onDone }: { initial: string; onDone(v: string | null): void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (x: string | null) => { if (done.current) return; done.current = true; onDone(x); };
  return (
    <input
      autoFocus
      aria-label="Layer name"
      value={v}
      maxLength={80}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(v)}
      className="h-7 min-w-0 flex-1 border border-accent-ink bg-bg-hi px-1 type-label outline-none touch:h-11"
      data-layer-rename-input
    />
  );
}

function EyeGlyph({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 12" width={15} height={11} aria-hidden>
      <path d="M1 6s2.6-4.5 7-4.5S15 6 15 6s-2.6 4.5-7 4.5S1 6 1 6Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="6" r="2" fill={off ? "none" : "currentColor"} stroke="currentColor" strokeWidth="1.2" />
      {off && <path d="M2 11 14 1" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

function siblingCount(rows: { parentId: string | null }[], parentId: string): number {
  return rows.filter((x) => x.parentId === parentId).length;
}

// ---- Multi-select (media layout spec 3.2, Amendment 8 A8.8) ----

export type ArrangeAction = "left" | "centre" | "right" | "top" | "middle" | "bottom" | "across" | "down" | "width" | "height" | "duplicate" | "hide" | "delete";

/** The arranging actions, in toolbar order, each with words and a 10px stroked glyph. */
export const ARRANGE: { id: ArrangeAction; label: string; title: string; d: string; min?: number }[] = [
  { id: "left", label: "Align left", title: "Line up their left edges", d: "M1.5 1v8M3 3h5M3 7h3" },
  { id: "centre", label: "Align centres", title: "Line up their centres across", d: "M5 1v8M2.5 3h5M3.5 7h3" },
  { id: "right", label: "Align right", title: "Line up their right edges", d: "M8.5 1v8M2 3h5M4 7h3" },
  { id: "top", label: "Align top", title: "Line up their tops", d: "M1 1.5h8M3 3v5M7 3v3" },
  { id: "middle", label: "Align middles", title: "Line up their middles down", d: "M1 5h8M3 2.5v5M7 3.5v3" },
  { id: "bottom", label: "Align bottom", title: "Line up their bottoms", d: "M1 8.5h8M3 2v5M7 4v3" },
  { id: "across", label: "Distribute across", title: "Equal gaps across (three or more)", d: "M1 1v8M9 1v8M3.5 3v4M6.5 3v4", min: 3 },
  { id: "down", label: "Distribute down", title: "Equal gaps down (three or more)", d: "M1 1h8M1 9h8M3 3.5h4M3 6.5h4", min: 3 },
  { id: "width", label: "Same width", title: "Make them as wide as the first one picked", d: "M1 5h8M1 3v4M9 3v4" },
  { id: "height", label: "Same height", title: "Make them as tall as the first one picked", d: "M5 1v8M3 1h4M3 9h4" },
  { id: "duplicate", label: "Duplicate", title: "Copy them beside or below (Ctrl+D)", d: "M3.5 3.5h5v5h-5zM1.5 6.5v-5h5" },
  { id: "hide", label: "Hide", title: "Hide them on this device (they stay in Layers)", d: "M1 5s1.5-3 4-3 4 3 4 3-1.5 3-4 3-4-3-4-3zM1.5 1.5l7 7" },
  { id: "delete", label: "Delete", title: "Remove them (Delete). Undo with Ctrl+Z", d: "M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" },
];

/** The canvas toolbar over several selected widgets: one undo per action. */
export function ArrangeBar({ count, onAction }: { count: number; onAction(a: ArrangeAction): void }) {
  return (
    <div role="toolbar" aria-label={`Arrange ${count} selected widgets`} className="pointer-events-auto flex items-center bg-accent-ink" data-arrange-bar={count} data-canvas-control>
      <span className="px-1.5 font-mono text-[11px] leading-5 text-bg" data-arrange-count>{count} selected</span>
      {ARRANGE.map((a) => (
        <button
          key={a.id}
          type="button"
          aria-label={a.label}
          title={a.title}
          disabled={!!a.min && count < a.min}
          className={`relative flex h-5 w-5 items-center justify-center border-l border-bg/40 text-bg after:absolute after:-inset-1 disabled:opacity-40 touch:after:-inset-3 ${a.id === "delete" ? "hover:bg-bad" : "hover:bg-fg"}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onAction(a.id); }}
          data-arrange={a.id}
        >
          <svg viewBox="0 0 10 10" width={10} height={10} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={a.d} /></svg>
        </button>
      ))}
    </div>
  );
}

/** What the inspector column shows while several widgets are selected: their names and the same actions in words. */
export function MultiPanel({ names, onAction, onClear }: { names: string[]; onAction(a: ArrangeAction): void; onClear(): void }) {
  const btn = "flex min-h-9 items-center gap-2 border border-line-strong px-2 text-left type-label hover:bg-bg-sunk disabled:opacity-40 touch:min-h-11 max-sm:min-h-11";
  return (
    <div className="flex flex-col gap-3 p-3" data-multi-panel={names.length}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 type-label text-fg">{names.length} widgets selected</h2>
        <button type="button" className="min-h-8 type-caption text-accent-ink underline underline-offset-2 touch:min-h-11" onClick={onClear} data-multi-clear>Clear selection</button>
      </div>
      <p className="m-0 type-caption text-fg-2">{names.join(", ")}. Shift-click a widget to add or remove it. Drag one of them to move them all.</p>
      <div className="grid grid-cols-2 gap-1">
        {ARRANGE.map((a) => (
          <button key={a.id} type="button" className={`${btn} ${a.id === "delete" ? "text-bad" : ""}`} title={a.title} disabled={!!a.min && names.length < a.min} onClick={() => onAction(a.id)} data-multi-action={a.id}>
            <svg viewBox="0 0 10 10" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="flex-none"><path d={a.d} /></svg>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
