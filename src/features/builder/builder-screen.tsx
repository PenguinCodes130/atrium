"use client";
// The builder /build/<slug>/<page?> (design v4 "The Builder"; spec "Builder", "Editing and saving",
// criteria 7 to 14, 49): a 48px builder bar, Insert and Layers at 264px, the canvas in its own theme
// on a sunk surround with an 80px hairline grid, and the 320px inspector.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import type { AppDocument, ComponentNode, DraftOp, GridSlot, LibraryComponent, PageDoc, Principal, Problem, PropValue, RenderContext, ShapedData, Theme } from "@/core/contracts";
import { Button, glowKeyframes, durations, REDUCED_GLOW_RING_MS, springs, toast, transitionFor, useReducedMotion, timed } from "@/features/shell";
import { findNode, findPage, newId, nodeLabel, orderedPages, slugify } from "@/features/apps/doc";
import { AppFrame } from "./app-frame";
import { DraftClient, type SendResult } from "./draft-client";
import { tagFor } from "./tags";
import { alignGuides, alignOps, cellAt, columnsOn, coveredOnPage, distributeOps, FINE, fitOps, freeSpot, freshCopy, gridColumns, groupDuplicateOps, groupMoveOps, keyAction, overlaps, resizeSlot, sameSizeOps, slotOn, slotOp, slotRect, snapDrop, withGapsClosed, type AlignHow, type Device, type Edges, type GridBox, type Guide } from "./geometry";
import { boxForShape, shapeRatio } from "@/features/components/inspector/media";
import { uploadFile, guessKind } from "@/features/uploads/client";
import { FoldButton, isBool, isPreviewW, PageSettings, PreviewWidth, SnapSwitch, usePref, type PreviewW } from "./canvas-controls";
import { Inspector } from "./inspector";
import { ArrangeBar, InsertGlyph, InsertPanel, LayersPanel, MultiPanel, type ArrangeAction, type InsertGroup, type InsertItem } from "./panels";
import { unmappedStates, usePageData, type UnmappedSource } from "./use-page-data";
import { ReviewSheet } from "@/features/versions/ui/review-sheet";
import { AppLookSheet } from "./app-look";
import { SelectMenu } from "@/features/settings/ui/controls";
import { SOURCE_CHOICE_EVENT, takeSourceChoice } from "@/features/components/render/render-node";
import { failingSources, repeatAround, wholeProp } from "./data-pick";
import { DataPicker, type BindableIntegration, type PickTarget } from "./data-picker";
import { ShowPicker, type ShowTarget } from "./show-picker";
import { MachineChooser, ServiceChooser, StartPageSheet } from "./service-sheets";
import { normaliseOps } from "@/features/apps/managed";
import { timingOf } from "./data-line";

export type BuilderProps = {
  app: { id: string; slug: string; name: string; publishedVersion: number | null };
  principal: Principal;
  initial: { rev: number; doc: AppDocument; agentNodes: string[]; pending: number; authors: { kind: string; name: string; count: number }[] };
  pageId: string;
  render: { theme: Theme; canvasCss: string; chromeCss: string; chromeRemoved?: string[]; nodeCss: Record<string, string>; sources: { key: string; refreshSec: number }[]; unmapped?: UnmappedSource[]; library: Record<string, LibraryComponent>; signedUrls?: Record<string, string> };
  catalogue: InsertGroup[];
  /** `/build/<slug>?insert=lib:<id>` (the library's Use button): add that component once the builder opens. */
  insertOnOpen?: string;
  /** `?review=1` or `?look=1` (settings' "Use on an app" and "Used by"): open that sheet once. */
  openOnStart?: "review" | "look";
};

type Drag = { kind: "insert"; item: InsertItem; w: number; h: number } | { kind: "move"; nodeId: string; label: string; w: number; h: number; /** Several selected: they all move by the same amount (spec 3.2). */ group?: string[] };
/** A drop into a container (a selected one, or an empty Repeat) rather than onto a grid cell (spec 3.2). */
type Into = { id: string; name: string; rect: { left: number; top: number; width: number; height: number }; /** A group (A10.7): where among its tiles the drop lands. */ index?: number };
/** Containers a widget can be dropped into; a Repeat takes one child. */
const DROP_CONTAINERS = new Set(["card", "stack", "section", "tabs", "repeat", "group"]);
type Ghost = { gridId: string; slot: GridSlot; rect: { left: number; top: number; width: number; height: number }; box: GridBox; origin: { left: number; top: number }; snap?: boolean; guides?: Guide[]; /** The other selected widgets where a group move puts them. */ group?: GridSlot[] };
/** One button on a selected widget's toolbar: a 10px stroked icon, a 44px hit area on touch screens. */
function BarButton({ label, title, onClick, disabled, pressed, danger, children, ...data }: { label: string; title: string; onClick(): void; disabled?: boolean; pressed?: boolean; danger?: boolean; children: React.ReactNode } & Record<`data-${string}`, unknown>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      className={`pointer-events-auto relative flex h-5 w-5 items-center justify-center border-l border-bg/40 bg-accent-ink text-bg after:absolute after:-inset-1 disabled:opacity-40 touch:after:-inset-3 ${danger ? "hover:bg-bad" : "hover:bg-fg"}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      {...data}
    >
      <svg viewBox="0 0 10 10" width={10} height={10} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
    </button>
  );
}

/**
 * A video's height over its width, read from the uploaded file (same origin: the app's media policy
 * refuses blob: addresses), or null when the browser cannot read it within 3 s.
 */
async function videoShape(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const done = (r: number | null) => { clearTimeout(t); v.removeAttribute("src"); resolve(r); };
    const t = setTimeout(() => done(null), 3000);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => done(v.videoWidth > 0 ? v.videoHeight / v.videoWidth : null);
    v.onerror = () => done(null);
    v.src = src;
  });
}
/** A picture's height over its width, or null when the browser cannot read it (SVG, a broken file). */
async function pictureShape(file: File): Promise<number | null> {
  try {
    const bmp = await createImageBitmap(file);
    const r = bmp.width > 0 ? bmp.height / bmp.width : null;
    bmp.close();
    return r;
  } catch {
    return null;
  }
}

/** A file dropped on the canvas while it uploads: a placeholder box with its progress (spec 3.1, 4 Loading). */
type Uploading = { key: number; name: string; pct: number; rect: { left: number; top: number; width: number; height: number } };

/** Insert > Start page (Wave 2.9, spec 3.7): not a component, a sheet that makes a whole page. */
const START_PAGE_ITEM = "start-page";
const START_PAGE_INSERT: InsertItem = { type: "start-page", title: "Start page", summary: "A whole page from your services: a resource bar, then groups of service tiles with live stats.", node: { id: "c_startpagea", type: "group", props: {} }, insertId: START_PAGE_ITEM };

/** The data widgets whose insert opens the data picker at once (spec 3.3). */
const DATA_TYPES = new Set(["stat", "chart", "table", "list", "status", "gauge", "progress"]);
/** Pull distance of the alignment guides, in screen px (spec 3.5). */
const GUIDE_PULL_PX = 6;

const NARROW = "(max-width: 899.98px)";

/** The eight resize handles on the selected outline, centred on its 2px border (operator bug 2). */
const RESIZE_HANDLES: { id: string; edges: Edges; cls: string }[] = [
  { id: "nw", edges: { n: true, w: true }, cls: "-left-[5px] -top-[5px] cursor-nwse-resize" },
  { id: "n", edges: { n: true }, cls: "left-1/2 -top-[5px] -translate-x-1/2 cursor-ns-resize" },
  { id: "ne", edges: { n: true, e: true }, cls: "-right-[5px] -top-[5px] cursor-nesw-resize" },
  { id: "e", edges: { e: true }, cls: "-right-[5px] top-1/2 -translate-y-1/2 cursor-ew-resize" },
  { id: "se", edges: { s: true, e: true }, cls: "-bottom-[5px] -right-[5px] cursor-nwse-resize" },
  { id: "s", edges: { s: true }, cls: "-bottom-[5px] left-1/2 -translate-x-1/2 cursor-ns-resize" },
  { id: "sw", edges: { s: true, w: true }, cls: "-bottom-[5px] -left-[5px] cursor-nesw-resize" },
  { id: "w", edges: { w: true }, cls: "-left-[5px] top-1/2 -translate-y-1/2 cursor-ew-resize" },
];

/** Whether `id` sits somewhere inside the subtree of `ancestorId`. */
function inside(doc: AppDocument, ancestorId: string, id: string): boolean {
  const a = findNode(doc, ancestorId)?.node;
  const walk = (n: ComponentNode): boolean => (n.children ?? []).some((c) => c.id === id || walk(c));
  return !!a && walk(a);
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(NARROW);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/**
 * Content height a component hides: what its root scrolls, plus what scroll areas inside it hide (a table
 * scrolls its rows in its own body, which shrinks first, so the root alone looks as if it fits). Only the
 * outermost inner scroll areas count, so nested ones are not added twice.
 */
function hiddenHeight(root: Element): number {
  let over = Math.max(0, root.scrollHeight - root.clientHeight);
  const counted: Element[] = [];
  for (const e of root.querySelectorAll("*")) {
    if (counted.some((c) => c.contains(e))) continue;
    const y = getComputedStyle(e).overflowY;
    if ((y === "auto" || y === "scroll") && e.scrollHeight - e.clientHeight > 1) {
      over += e.scrollHeight - e.clientHeight;
      counted.push(e);
    }
  }
  return over;
}

/** A grid's box on screen. `zoom` is the canvas scale (Preview width): computed lengths are page px. */
function gridBoxOf(host: HTMLElement, cols: number, zoom = 1): GridBox {
  // Measure the grid itself, not the node box around it (operator, 2026-10-19): the box has no column gap
  // or row size, so ghosts were drawn too wide and drops mapped to the wrong columns.
  const el = host.matches(".atr-grid") ? host : (host.querySelector(".atr-grid") as HTMLElement | null) ?? host;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
  const rowPx = px(cs.gridAutoRows) || 8;
  // The gap under each cell (its bottom padding) is not part of the component: the ghost leaves it out, so
  // it matches the outline drawn around the component (operator, 2026-10-19).
  const cell = el.querySelector(":scope > .atr-cell");
  const cellPad = cell ? px(getComputedStyle(cell).paddingBottom) : 0;
  const z = zoom;
  return { left: r.left + px(cs.paddingLeft) * z, top: r.top + px(cs.paddingTop) * z, width: r.width - (px(cs.paddingLeft) + px(cs.paddingRight)) * z, colGap: px(cs.columnGap) * z, rowGap: px(cs.rowGap) * z, rowPx: rowPx * z, cols, cellPad: cellPad * z };
}

export function BuilderScreen(props: BuilderProps) {
  const { app } = props;
  const reduced = useReducedMotion();
  const narrow = useNarrow();
  const [doc, setDoc] = useState(props.initial.doc);
  const [rev, setRev] = useState(props.initial.rev);
  const [meta, setMeta] = useState({ pending: props.initial.pending, authors: props.initial.authors, agentNodes: new Set(props.initial.agentNodes), publishedVersion: props.app.publishedVersion });
  const [pageId, setPageId] = useState(props.pageId);
  const [render, setRender] = useState(props.render);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Multi-select (spec 3.2, A8.8): two or more children of one grid; the first picked is the anchor.
  const [multi, setMulti] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [into, setInto] = useState<Into | null>(null);
  const intoRef = useRef<Into | null>(null);
  const suppressClick = useRef(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [editMode, setEditMode] = useState(true);
  // ---- Wave 2.6: snapping, preview width, folded panels (remembered per person in this browser) ----
  const [snap, setSnap] = usePref<boolean>("atrium.builder.snap", true, isBool);
  const [previewW, setPreviewW] = usePref<PreviewW>("atrium.builder.previewWidth", "fit", isPreviewW);
  const [foldLeft, setFoldLeft] = usePref<boolean>("atrium.builder.foldLeft", false, isBool);
  const [foldRight, setFoldRight] = usePref<boolean>("atrium.builder.foldRight", false, isBool);
  const [canvasW, setCanvasW] = useState(0);
  const [innerH, setInnerH] = useState(0);
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [fileOver, setFileOver] = useState(false);
  const [tab, setTab] = useState<"insert" | "layers">("insert");
  // Under 900px: a reduced edit mode with one view at a time (gauntlet w2-r1 item 11).
  const [narrowTab, setNarrowTab] = useState<"canvas" | "layers" | "edit">("canvas");
  // The node that just arrived (insert or drop) or was picked from the review: its outline settles in.
  const [settleKey, setSettleKey] = useState<{ id: string; n: number } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [announce, setAnnounce] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [glow, setGlow] = useState(0);
  // While the publish glow plays, the bar's text sits on gold in --accent-fg (design v4 Note 1).
  const [glowing, setGlowing] = useState(false);
  useEffect(() => {
    if (!glow || reduced) return;
    setGlowing(true);
    const t = window.setTimeout(() => setGlowing(false), durations.glow.ms);
    return () => window.clearTimeout(t);
  }, [glow, reduced]);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A resize from a handle on the selected outline (operator bug 2); the drop ghost shows the new slot.
  const [resizing, setResizing] = useState(false);
  // ---- The data picker (Wave 2.5) ----
  const [picker, setPicker] = useState<PickTarget | null>(null);
  const [bindable, setBindable] = useState<BindableIntegration[] | null>(null);
  // ---- Wave 2.9: "What should this show?", service tiles and the start page ----
  const [show, setShow] = useState<ShowTarget | null>(null);
  const [tileFor, setTileFor] = useState<string | null>(null);
  const [barFor, setBarFor] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  // A pick's value, shown on the canvas at once until the stream sends it (spec 3.2: within 1 s).
  const [instant, setInstant] = useState<Record<string, ShapedData>>({});
  // The last listing seen, so managed sources can be normalised while the listing reloads (A10.1).
  const bindableRef = useRef<BindableIntegration[] | null>(null);
  if (bindable) bindableRef.current = bindable;
  const openShow = useCallback((t: ShowTarget) => { setPicker(null); setShow(t); }, []);
  /**
   * The inspector's ways into data (Connect data, Bind on a field, Change, Add a line): "What should this
   * show?". Inside a Repeat the Wave 2.7 picker opens instead, for "This row"; with no component (the
   * Advanced list's "Set up a read by hand" or Edit), the by-hand picker.
   */
  const onInspectorPick = (t: PickTarget) => {
    const n = t.nodeId ? findNode(client.current!.doc, t.nodeId)?.node : undefined;
    if (!n || repeatAround(client.current!.doc, n.id)?.source) { setPicker(t); return; }
    openShow({ nodeId: n.id, prop: t.prop ?? (n.type === "chart" ? "lines" : wholeProp(n.type) ?? "value"), ...(t.source ? { source: t.source } : {}) });
  };
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [, force] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  // Gauntlet w2-r2 item 17: the "Published vN" toast belongs to the builder; leaving it (to Versions,
  // Settings or the app) dismisses the toast, which fades out, so it never covers the next screen.
  const publishToast = useRef<string | null>(null);
  useEffect(() => () => { if (publishToast.current) toast.dismiss(publishToast.current); }, []);
  // Gauntlet w2-r2 item 8: when the code window docks under the canvas, the selected block scrolls into
  // the canvas area left above it, so the frame and its code are both in view.
  const dockRef = useRef<HTMLDivElement>(null);
  const page = findPage(doc, pageId) ?? orderedPages(doc)[0]!;

  const refreshMeta = useCallback(async () => {
    const res = await fetch(`/api/apps/${app.id}/draft`, { credentials: "same-origin" }).catch(() => null);
    if (!res?.ok) return;
    const j = (await res.json()) as { agentNodes: string[]; pending: number; authors: { kind: string; name: string; count: number }[]; publishedVersion: number | null };
    setMeta({ pending: j.pending, authors: j.authors, agentNodes: new Set(j.agentNodes), publishedVersion: j.publishedVersion });
  }, [app.id]);

  const refreshRender = useCallback(async (pid: string) => {
    const res = await fetch(`/api/apps/${app.id}/render?page=${encodeURIComponent(pid)}`, { credentials: "same-origin" }).catch(() => null);
    if (!res?.ok) return;
    const j = (await res.json()) as BuilderProps["render"];
    setRender({ theme: j.theme, canvasCss: j.canvasCss, chromeCss: j.chromeCss, chromeRemoved: j.chromeRemoved ?? [], nodeCss: j.nodeCss, sources: j.sources, unmapped: j.unmapped ?? [], library: j.library ?? {}, signedUrls: j.signedUrls ?? {} });
  }, [app.id]);

  const client = useRef<DraftClient | null>(null);
  const needsRender = useRef(false);
  if (!client.current) {
    client.current = new DraftClient(props.initial.doc, props.initial.rev, {
      send: async (r, ops): Promise<SendResult> => {
        const res = await fetch(`/api/apps/${app.id}/ops`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ rev: r, ops }) }).catch(() => null);
        if (!res) return { ok: false, kind: "error", message: "Atrium could not be reached. Your edits will be sent again." };
        const j = (await res.json().catch(() => ({}))) as { rev?: number; follow?: DraftOp[]; error?: { code?: string; message?: string; rev?: number; problems?: Problem[] } };
        if (res.ok && typeof j.rev === "number") return { ok: true, rev: j.rev, ...(Array.isArray(j.follow) && j.follow.length ? { follow: j.follow } : {}) };
        if (res.status === 409) return { ok: false, kind: "conflict", rev: j.error?.rev ?? r };
        if (res.status === 422) return { ok: false, kind: "invalid", problems: j.error?.problems ?? [] };
        return { ok: false, kind: "error", message: j.error?.message ?? "The edit could not be saved." };
      },
      fetchDraft: async () => {
        const res = await fetch(`/api/apps/${app.id}/draft`, { credentials: "same-origin" });
        const j = (await res.json()) as { rev: number; doc: AppDocument };
        return { rev: j.rev, doc: j.doc };
      },
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
      // A10.1: managed sources follow their components in the same edit (one undo reverts both).
      normalise: (d) => normaliseOps(d, (src) => timingOf(src, bindableRef.current ?? [])),
    }, {
      onChange: (d, r) => { setDoc(d); setRev(r); },
      onRefused: (p) => {
        setProblems(p);
        toast({ kind: "error", title: "That change was not saved", description: p[0]?.message ?? "It did not pass the checks." });
      },
      onDropped: (m) => toast({ kind: "info", title: m }),
      onError: (m) => toast({ kind: "error", title: m }),
      onSaved: () => {
        void refreshMeta();
        if (needsRender.current) { needsRender.current = false; void refreshRender(pageIdRef.current); }
      },
    });
  }
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;

  const apply = useCallback((ops: DraftOp[], opts: { announce?: string; select?: string } = {}) => {
    setProblems([]);
    if (ops.some((o) => o.op === "theme.set" || o.op === "chrome.update" || (o.op === "page.update" && "theme" in o.patch) || (o.op === "node.update" && ("style" in o.patch || "css" in o.patch || "overrideTheme" in o.patch || ("props" in o.patch && /https?:\/\//i.test(JSON.stringify(o.patch.props))))) || o.op === "node.add" || o.op === "source.set" || o.op === "source.remove" || (o.op === "node.update" && JSON.stringify(o.patch).includes("{{")))) needsRender.current = true;
    // Gauntlet w2-r2 item 16: removing a component also closes the band it leaves in its grid.
    const sourcesBefore = JSON.stringify(client.current!.doc.dataSources);
    const p = client.current!.edit(withGapsClosed(client.current!.doc, ops));
    // A10.1: an edit that moved a managed source (added, removed, a new interval) restarts the live data.
    if (!p && JSON.stringify(client.current!.doc.dataSources) !== sourcesBefore) needsRender.current = true;
    if (p) {
      setProblems(p);
      toast({ kind: "error", title: "That change cannot be made", description: p[0]?.message });
      return;
    }
    if (opts.announce) setAnnounce(opts.announce);
    if (opts.select !== undefined) setSelectedId(opts.select);
  }, []);

  /**
   * Applies an edit and waits until the server accepted or refused it (gauntlet w2-r1 item 15): the
   * problems that stop it (local or from the server), or null once it is saved.
   */
  const applyAndWait = useCallback(async (ops: DraftOp[]): Promise<Problem[] | null> => {
    setProblems([]);
    if (ops.some((o) => o.op === "source.set" || o.op === "source.remove")) needsRender.current = true;
    const local = client.current!.edit(ops);
    if (local) return local;
    return client.current!.whenSaved();
  }, []);

  /** Scrolls a node into view on the canvas and plays its settle outline (items 2 and 17). */
  const reveal = useCallback((nodeId: string) => {
    setSettleKey((k) => ({ id: nodeId, n: (k?.n ?? 0) + 1 }));
    const go = (tries: number) => window.requestAnimationFrame(() => {
      const el = canvasRef.current?.querySelector(`[data-node="${CSS.escape(nodeId)}"]`);
      if (el) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
      else if (tries > 0) go(tries - 1);
    });
    go(20);
  }, [reduced]);

  const snapRef = useRef(snap);
  snapRef.current = snap;
  const foldLeftRef = useRef(foldLeft);
  foldLeftRef.current = foldLeft;
  const foldRightRef = useRef(foldRight);
  foldRightRef.current = foldRight;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock || typeof MutationObserver === "undefined") return;
    let had = dock.childElementCount > 0;
    const keep = () => {
      const id = selectedRef.current;
      const el = id ? canvasRef.current?.querySelector(`[data-node="${CSS.escape(id)}"]`) : null;
      el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    };
    const timers: number[] = [];
    const obs = new MutationObserver(() => {
      const has = dock.childElementCount > 0;
      // The window grows in over a moment: check again once it has its height.
      if (has && !had) for (const ms of [60, 260, 520]) timers.push(window.setTimeout(keep, ms));
      had = has;
    });
    obs.observe(dock, { childList: true });
    return () => { obs.disconnect(); timers.forEach((t) => window.clearTimeout(t)); };
  }, [narrow]);

  // Switching pages keeps the builder state and updates the address without a reload.
  const goPage = useCallback((p: PageDoc) => {
    setPageId(p.id);
    setSelectedId(null);
    window.history.replaceState(null, "", `/build/${app.slug}/${p.slug}`);
    void refreshRender(p.id);
  }, [app.slug, refreshRender]);

  // Wave 2.9: Start page sits first in the Layout group of Insert.
  const insertGroups = useMemo<InsertGroup[]>(() => {
    const has = props.catalogue.some((g) => g.category === "layout");
    const groups = props.catalogue.map((g) => (g.category === "layout" ? { ...g, items: [START_PAGE_INSERT, ...g.items] } : g));
    return has ? groups : [{ category: "layout", items: [START_PAGE_INSERT] }, ...groups];
  }, [props.catalogue]);
  const live = usePageData({ appId: app.id, pageId: page.id, draft: true }, render.sources, render.sources.length > 0);
  // Wave 2.9: values stay on the canvas while the stream restarts for a new source (a pick, a new interval),
  // and a pick's peeked value shows at once (spec 3.2).
  const known = useRef<Record<string, ShapedData>>({});
  for (const [k, v] of Object.entries(live.data)) if (v) known.current[k] = v as ShapedData;
  const shownData = useMemo(() => ({ ...instant, ...known.current, ...live.data }) as Record<string, ShapedData | undefined>, [instant, live.data]);
  const failing = useMemo(() => failingSources(doc, bindable ?? []), [doc, bindable]);
  const ctx: RenderContext = useMemo(() => ({
    mode: "edit",
    principal: props.principal,
    appId: app.id,
    pageId: page.id,
    version: "draft",
    values: {
      $data: shownData,
      // Every source the draft names is known to bindings at once (gauntlet w2-r1 item 6): a source added
      // this session shows loading, then its value once the stream restarts, never "no data source named".
      // Unmapped sources (a skipped integration) show "No data: connect <package>" (item 2).
      $sources: { ...Object.fromEntries(doc.dataSources.map((s) => [s.name, undefined])), ...unmappedStates(render.unmapped), ...live.states },
      $controls: Object.fromEntries(doc.controls.map((c) => [c.id, { label: c.label }])),
      // A8.6: a stat with no label shows its source's words on the canvas too, as viewers see.
      $sourceLabels: Object.fromEntries(doc.dataSources.flatMap((s) => (s.label ? [[s.name, s.label]] : []))),
      // A9.2 (recipes spec 3.2): sources whose read failed its live check, marked on the canvas in edit mode.
      $failingReads: failing,
      $library: render.library,
      // A4.2 and A5.1: the draft's own literal URLs are signed for editors by the render (refreshed when
      // a prop gains an absolute URL); the stream signs what it sends.
      $signedUrls: { ...(render.signedUrls ?? {}), ...live.signedUrls },
      $available: true,
      $pages: doc.pages.map((x) => ({ id: x.id, slug: x.slug, title: x.title })),
      $page: { id: page.id, slug: page.slug, title: page.title },
      $app: { id: app.id, slug: app.slug, name: doc.app.name },
      $user: { kind: "user", name: "" },
    } as RenderContext["values"],
    runControl: async () => ({ ok: false, code: "forbidden", message: "Controls do not run in the builder. Use Preview." }),
    confirm: async () => false,
    navigate: () => {},
  }), [props.principal, app.id, app.slug, page, doc, live, shownData, render.library, render.signedUrls, render.unmapped, failing]);

  // ---- Preview width (spec 3.6): the page drawn at its real width, scaled down to fit the canvas ----
  const sectionRef = useRef<HTMLElement>(null);
  const scaledRef = useRef<HTMLDivElement>(null);
  const scaled = !narrow && device === "desktop" && previewW !== "fit";
  const inset = editMode && !narrow ? 24 : 0;
  const zoom = scaled && canvasW > 0 ? Math.min(1, Math.max(0.1, (canvasW - inset * 2) / (previewW as number))) : 1;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const sec = sectionRef.current;
    if (!sec) return;
    const ro = new ResizeObserver(() => setCanvasW(sec.clientWidth));
    ro.observe(sec);
    setCanvasW(sec.clientWidth);
    return () => ro.disconnect();
  }, [narrow]);
  useEffect(() => {
    const el = scaledRef.current;
    if (!el || !scaled) return;
    const ro = new ResizeObserver(() => setInnerH(el.offsetHeight));
    ro.observe(el);
    setInnerH(el.offsetHeight);
    return () => ro.disconnect();
  }, [scaled]);

  const selected = selectedId ? findNode(doc, selectedId)?.node ?? null : null;
  const selectedParent = selectedId ? findNode(doc, selectedId)?.parent ?? null : null;
  const selectedSlot = selected ? slotOn(selected, device) : undefined;
  const multiOn = multi.length >= 2 && !narrow;
  const multiRef = useRef<string[]>(multi);
  multiRef.current = multi;
  const arrangeRef = useRef<(a: ArrangeAction) => void>(() => {});
  // Several selected: ids that no longer exist drop out; selecting something outside the group ends it.
  useEffect(() => {
    if (!multi.length) return;
    const alive = multi.filter((id) => findNode(doc, id));
    if (alive.length !== multi.length) setMulti(alive.length >= 2 ? alive : []);
  }, [doc]);
  useEffect(() => {
    if (multi.length && (!selectedId || !multi.includes(selectedId))) setMulti([]);
  }, [selectedId]);

  // ---- Keyboard (design v4 section 6) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (narrow) return;
      const a = document.activeElement;
      // Shortcuts work when focus is in the builder, on the page, or on the shell's main landmark around it.
      if (a && a !== document.body && rootRef.current && !rootRef.current.contains(a) && !a.contains(rootRef.current)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true], [role=dialog]") || t.isContentEditable)) return;
      // Menus, choice groups and the inspector keep their own keys (round 3: Escape closing a menu must not
      // also select the parent, and arrows in a choice group must not move the component).
      if (e.defaultPrevented || (t && t.closest("[data-builder-inspector], [role=listbox], [role=option], [role=combobox], [role=menu], [role=menuitem], [role=radiogroup], [data-radix-popper-content-wrapper]"))) return;
      // [ and ] fold the left and right panels (spec 3.6).
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        if (e.key === "[") { setFoldLeft(!foldLeftRef.current); setAnnounce(foldLeftRef.current ? "Insert and Layers shown" : "Insert and Layers hidden"); }
        else { setFoldRight(!foldRightRef.current); setAnnounce(foldRightRef.current ? "Inspector shown" : "Inspector hidden"); }
        return;
      }
      // Several selected (spec 3.2): Delete, Ctrl+D, the arrows and Escape act on all of them.
      if (multiRef.current.length >= 2 && !((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key))) {
        const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const step = snapRef.current ? 1 : FINE;
        if (e.key === "Escape") { e.preventDefault(); setMulti([]); setAnnounce("Selection cleared"); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); arrangeRef.current("delete"); return; }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); arrangeRef.current("duplicate"); return; }
        const a = arrows[e.key];
        if (a && !e.altKey) {
          e.preventDefault();
          const ops = groupMoveOps(client.current!.doc, multiRef.current, a[0] * step, a[1], device);
          if (ops.length) apply(ops, { announce: `Moved ${multiRef.current.length} widgets` });
          return;
        }
        if (!e.ctrlKey && !e.metaKey) return;
      }
      const act = keyAction(client.current!.doc, selectedId, { key: e.key, shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey }, device, { step: snapRef.current ? 1 : FINE });
      if (!act) return;
      e.preventDefault();
      if (act.kind === "undo") { client.current!.undo(); setAnnounce("Undone"); }
      else if (act.kind === "redo") { client.current!.redo(); setAnnounce("Redone"); }
      else if (act.kind === "select") { setSelectedId(act.nodeId); setAnnounce(act.announce); }
      else {
        apply(act.ops, { announce: act.announce, ...(act.select ? { select: act.select } : {}) });
        // A duplicate is shown where it landed (spec 3.2).
        if (act.select && act.ops.some((o) => o.op === "node.add")) reveal(act.select);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, device, apply, narrow, setFoldLeft, setFoldRight, reveal]);

  // The integrations the person may bind, loaded fresh each time the picker opens (a new one may exist),
  // and on load and after the picker closes too, so the canvas can mark widgets whose read fails (A9.2).
  useEffect(() => {
    let gone = false;
    if (picker) setBindable(null);
    void fetch("/api/integrations/bindable", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : { integrations: [] })).then((j: { integrations: BindableIntegration[] }) => { if (!gone) setBindable(j.integrations ?? []); }).catch(() => { if (!gone) setBindable([]); });
    return () => { gone = true; };
  }, [!!picker, !!show, !!tileFor, !!barFor]);
  // "Choose a data source" on a component showing sample values opens the picker for its data.
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      if (!id || !takeSourceChoice(id)) return;
      const n = findNode(client.current!.doc, id)?.node;
      setSelectedId(id);
      if (n) openShow({ nodeId: id, prop: n.type === "chart" ? "lines" : wholeProp(n.type) ?? "value" });
    };
    window.addEventListener(SOURCE_CHOICE_EVENT, on);
    return () => window.removeEventListener(SOURCE_CHOICE_EVENT, on);
  }, []);
  // Back from "Connect an integration": open the picker on the new integration, once.
  const connectedOnStart = useRef(false);
  useEffect(() => {
    if (connectedOnStart.current) return;
    connectedOnStart.current = true;
    const url = new URL(window.location.href);
    const integrationId = url.searchParams.get("connect");
    if (!integrationId) return;
    const nodeId = url.searchParams.get("node") ?? undefined;
    const prop = url.searchParams.get("prop") ?? undefined;
    for (const k of ["connect", "node", "prop"]) url.searchParams.delete(k);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    const node = nodeId ? findNode(client.current!.doc, nodeId)?.node : undefined;
    if (node) setSelectedId(node.id);
    // Wave 2.9: back to "What should this show?" for the component (the new service is in its list).
    if (node) { openShow({ nodeId: node.id, prop: prop ?? (node.type === "chart" ? "lines" : wholeProp(node.type) ?? "value") }); return; }
    setPicker({ integrationId });
  }, []);

  // ---- Canvas selection and outlines ----
  const nodeAt = (target: EventTarget | null): string | null => {
    let el = target instanceof Element ? target.closest("[data-node]") : null;
    while (el) {
      const id = el.getAttribute("data-node");
      if (id && findNode(client.current!.doc, id)) return id;
      el = el.parentElement?.closest("[data-node]") ?? null;
    }
    return null;
  };
  const rectOf = (id: string | null) => {
    if (!id || !canvasRef.current) return null;
    const el = canvasRef.current.querySelector(`[data-node="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const o = canvasRef.current.getBoundingClientRect();
    return { left: r.left - o.left, top: r.top - o.top, width: r.width, height: r.height };
  };
  useEffect(() => {
    const ro = new ResizeObserver(() => force((n) => n + 1));
    if (rootRef.current) ro.observe(rootRef.current);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, []);

  // ---- Drag and drop (Insert to canvas, and moving the selected component) ----
  const gridUnder = (x: number, y: number): { id: string; el: HTMLElement } | null => {
    const d = client.current!.doc;
    for (const el of document.elementsFromPoint(x, y)) {
      const host = el.closest("[data-node]") as HTMLElement | null;
      if (!host || !rootRef.current?.contains(host)) continue;
      let cur: HTMLElement | null = host;
      while (cur && rootRef.current.contains(cur)) {
        const id = cur.getAttribute("data-node");
        const n = id ? findNode(d, id)?.node : null;
        if (n && n.type === "grid" && (!drag || drag.kind !== "move" || n.id !== drag.nodeId)) return { id: n.id, el: cur };
        cur = cur.parentElement?.closest("[data-node]") as HTMLElement | null;
      }
    }
    const rootEl = rootRef.current?.querySelector(`[data-node="${CSS.escape(page.root.id)}"]`) as HTMLElement | null;
    return page.root.type === "grid" && rootEl ? { id: page.root.id, el: rootEl } : null;
  };
  /** Alignment guides for a slot in a grid (snap off): pulls it into line within 6px of screen. */
  const guided = (slot: GridSlot, gridNode: ComponentNode, box: GridBox, exceptId?: string): { slot: GridSlot; guides: Guide[] } => {
    const colW = (box.width - (box.cols - 1) * box.colGap) / box.cols;
    const others = (gridNode.children ?? []).filter((k) => k.id !== exceptId && !(device === "mobile" ? k.responsive?.mobile?.hidden : k.hidden)).flatMap((k) => { const s = slotOn(k, device, gridColumns(gridNode)); return s ? [s] : []; });
    const r = alignGuides(slot, others, box.cols, { x: GUIDE_PULL_PX / (colW + box.colGap), y: GUIDE_PULL_PX / (box.rowPx + box.rowGap) });
    return { slot: { ...slot, x: r.box.x, y: r.box.y }, guides: r.guides };
  };
  /** The same for a resize: only the edges being dragged are pulled into line. */
  const guidedResize = (slot: GridSlot, edges: Edges, gridNode: ComponentNode, box: GridBox, nodeId: string): { slot: GridSlot; guides: Guide[] } => {
    const colW = (box.width - (box.cols - 1) * box.colGap) / box.cols;
    const others = (gridNode.children ?? []).filter((k) => k.id !== nodeId).flatMap((k) => { const s = slotOn(k, device, gridColumns(gridNode)); return s ? [s] : []; });
    const px = GUIDE_PULL_PX / (colW + box.colGap);
    const py = GUIDE_PULL_PX / (box.rowPx + box.rowGap);
    const tx = [box.cols / 2, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
    const ty = others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h]);
    const near = (v: number, ts: number[], lim: number) => ts.reduce<number | null>((b, t) => (Math.abs(t - v) <= lim && (b === null || Math.abs(t - v) < Math.abs(b - v)) ? t : b), null);
    const s2 = { ...slot };
    if (edges.e) { const t = near(s2.x + s2.w, tx, px); if (t !== null && t - s2.x >= FINE) s2.w = Math.round((t - s2.x) * 8) / 8; }
    if (edges.w) { const t = near(s2.x, tx, px); if (t !== null && s2.x + s2.w - t >= FINE) { s2.w = Math.round((s2.x + s2.w - t) * 8) / 8; s2.x = Math.round(t * 8) / 8; } }
    if (edges.s) { const t = near(s2.y + s2.h, ty, py); if (t !== null && Math.round(t) - s2.y >= 1) s2.h = Math.round(t) - s2.y; }
    if (edges.n) { const t = near(s2.y, ty, py); if (t !== null && s2.y + s2.h - Math.round(t) >= 1) { s2.h = s2.y + s2.h - Math.round(t); s2.y = Math.round(t); } }
    return { slot: s2, guides: alignGuides(s2, others, box.cols, { x: 0, y: 0 }).guides };
  };
  const startDrag = (d: Drag, e: ReactPointerEvent) => {
    if (narrow || !editMode) return;
    const startX = e.clientX;
    const startY = e.clientY;
    // Where the pointer holds a moved component, relative to its top left (so snap-off moves are exact).
    const grab = { x: 0, y: 0 };
    if (d.kind === "move") {
      const el = canvasRef.current?.querySelector(`[data-node="${CSS.escape(d.nodeId)}"]`);
      const r = el?.getBoundingClientRect();
      if (r) { grab.x = Math.max(0, Math.min(r.width, startX - r.left)); grab.y = Math.max(0, Math.min(r.height, startY - r.top)); }
    }
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!started) { started = true; setDrag(d); }
      setPointer({ x: ev.clientX, y: ev.clientY });
      // Over a selected container (or an empty Repeat) the widget goes into it (spec 3.2).
      const c = containerUnder(ev.clientX, ev.clientY, d);
      if (c) {
        if (intoRef.current?.id !== c.id) { intoRef.current = c; setInto(c); }
        setGhost(null);
        return;
      }
      if (intoRef.current) { intoRef.current = null; setInto(null); }
      const g = gridUnder(ev.clientX, ev.clientY);
      if (!g || !canvasRef.current) return setGhost(null);
      const gridNode = findNode(client.current!.doc, g.id)?.node;
      const box = gridBoxOf(g.el, columnsOn(gridNode, device), zoomRef.current);
      // Snap (spec 3.5): Ctrl or Cmd flips the switch for as long as it is held during this move.
      const snapNow = snapRef.current !== (ev.ctrlKey || ev.metaKey);
      const step = snapNow ? 1 : FINE;
      // With snap off a move keeps the pointer where it grabbed the component (exact placement); a new
      // one, and every snapped move, hangs from the pointer as before.
      const g0 = snapNow ? { x: 0, y: 0 } : grab;
      const cell = cellAt(box, ev.clientX - g0.x, ev.clientY - g0.y, d.w, d.h, step);
      // A loose drop below the content snaps to the next row at the left; Alt places it exactly (item 16).
      const groupMove = d.kind === "move" && !!d.group;
      let slot = gridNode ? snapDrop(cell, gridNode, device, { ...(d.kind === "move" ? { exceptId: d.nodeId } : {}), deliberate: ev.altKey || !snapNow || groupMove }) : cell;
      let guides: Guide[] | undefined;
      if (!snapNow && gridNode && !groupMove) ({ slot, guides } = guided(slot, gridNode, box, d.kind === "move" ? d.nodeId : undefined));
      // A group move shows where every selected widget lands, moved by the same columns and rows.
      let group: GridSlot[] | undefined;
      if (d.kind === "move" && d.group) {
        const cur = client.current!.doc;
        const me = findNode(cur, d.nodeId);
        const start = me?.parent ? slotOn(me.node, device, gridColumns(me.parent)) : undefined;
        if (start && me?.parent?.id === g.id) group = d.group.filter((id) => id !== d.nodeId).flatMap((id) => { const n = findNode(cur, id)?.node; const s0 = n ? slotOn(n, device, gridColumns(me.parent)) : undefined; return s0 ? [{ ...s0, x: s0.x + slot.x - start.x, y: s0.y + slot.y - start.y }] : []; });
      }
      const o = canvasRef.current.getBoundingClientRect();
      setGhost({ gridId: g.id, slot, rect: slotRect(box, slot), box, origin: { left: box.left - o.left, top: box.top - o.top }, snap: snapNow, ...(guides ? { guides } : {}), ...(group ? { group } : {}) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      setPointer(null);
      const target = intoRef.current;
      intoRef.current = null;
      setInto(null);
      if (target) {
        setGhost(null);
        if (started) dropInto(d, target);
        return;
      }
      setGhost((gh) => {
        if (started && gh) drop(d, gh);
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const drop = (d: Drag, gh: Ghost) => {
    const cur = client.current!.doc;
    if (d.kind === "insert") {
      const node = freshCopy(d.item.node);
      const dc = gridColumns(findNode(cur, gh.gridId)?.node);
      if (device === "mobile") { node.slot = { ...gh.slot, w: Math.min(dc, Math.round(gh.slot.w * (dc / 4))) }; node.responsive = { mobile: { slot: gh.slot } }; }
      else node.slot = gh.slot;
      apply([{ op: "node.add", parentId: gh.gridId, node }], { announce: `Added ${nodeLabel(node)} at column ${gh.slot.x + 1}, row ${gh.slot.y + 1}`, select: node.id });
      reveal(node.id);
      openPickerForNew(node);
    } else {
      const at = findNode(cur, d.nodeId);
      if (!at) return;
      if (d.group && at.parent?.id === gh.gridId) {
        const start = slotOn(at.node, device, gridColumns(at.parent));
        const ops = start ? groupMoveOps(cur, d.group, gh.slot.x - start.x, gh.slot.y - start.y, device) : [];
        if (ops.length) apply(ops, { announce: `Moved ${d.group.length} widgets. Undo with Ctrl+Z.` });
        return;
      }
      if (at.parent?.id === gh.gridId) {
        const op = slotOp(cur, d.nodeId, gh.slot, device);
        if (op) apply([op], { announce: `${nodeLabel(at.node)} moved to column ${gh.slot.x + 1}, row ${gh.slot.y + 1}` });
      } else apply([{ op: "node.move", nodeId: d.nodeId, parentId: gh.gridId, slot: gh.slot }], { announce: `${nodeLabel(at.node)} moved` });
    }
  };
  /**
   * The container a drag would drop into (spec 3.2): the selected card, stack, section, tabs or Repeat, or any
   * empty Repeat, under the pointer, with no grid between it and the pointer. Never the dragged widget or
   * something inside it, and never for a group move.
   */
  const containerUnder = (x: number, y: number, d: Drag): Into | null => {
    if (d.kind === "move" && d.group) return null;
    const cur = client.current!.doc;
    const sel = selectedRef.current;
    const top = document.elementsFromPoint(x, y).find((el) => canvasRef.current?.contains(el));
    let host = top?.closest("[data-node]") as HTMLElement | null;
    while (host && canvasRef.current?.contains(host)) {
      const id = host.getAttribute("data-node");
      const n = id ? findNode(cur, id)?.node : null;
      if (n?.type === "grid") return null;
      if (n && DROP_CONTAINERS.has(n.type)) {
        const empty = !(n.children ?? []).length;
        // Any group under the pointer takes a tile (spec 3.6: tiles drag between groups), not only a selected one.
        const ok = n.type === "repeat" ? empty : n.type === "group" ? true : n.id === sel;
        const own = d.kind === "move" && (n.id === d.nodeId || inside(cur, d.nodeId, n.id));
        if (ok && !own) {
          const r = rectOf(n.id);
          if (!r) return null;
          return n.type === "group" ? { id: n.id, name: nodeLabel(n), rect: r, index: groupIndexAt(n.id, x, y, d.kind === "move" ? d.nodeId : null) } : { id: n.id, name: nodeLabel(n), rect: r };
        }
      }
      host = host.parentElement?.closest("[data-node]") as HTMLElement | null;
    }
    return null;
  };
  /**
   * Where a drop at (x, y) lands among a group's tiles: before the first tile whose middle is after the
   * pointer in reading order (row first, then column). The dragged tile itself is left out, so the index is
   * the one node.move expects once it has left its old place.
   */
  const groupIndexAt = (groupId: string, x: number, y: number, dragged: string | null): number => {
    const items = [...(canvasRef.current?.querySelectorAll<HTMLElement>(`[data-group-body="${CSS.escape(groupId)}"] > [data-group-item]`) ?? [])].filter((el) => el.getAttribute("data-group-item") !== dragged);
    for (let i = 0; i < items.length; i++) {
      const r = items[i]!.getBoundingClientRect();
      if (y < r.top) return i;
      if (y <= r.bottom && x < r.left + r.width / 2) return i;
    }
    return items.length;
  };
  /** Puts a dragged widget into a container: no grid slot there, it stacks in the container's order. */
  const dropInto = (d: Drag, target: Into) => {
    const cur = client.current!.doc;
    if (d.kind === "insert") {
      const node = freshCopy(d.item.node);
      delete node.slot;
      apply([{ op: "node.add", parentId: target.id, ...(target.index !== undefined ? { index: target.index } : {}), node }], { announce: `Added ${nodeLabel(node)} into ${target.name}`, select: node.id });
      reveal(node.id);
      openPickerForNew(node);
    } else {
      const at = findNode(cur, d.nodeId);
      if (!at) return;
      // A tile dropped back on its own place is no change.
      if (at.parent?.id === target.id && target.index === at.index) return;
      apply([{ op: "node.move", nodeId: d.nodeId, parentId: target.id, ...(target.index !== undefined ? { index: target.index } : {}) }], { announce: `${nodeLabel(at.node)} moved into ${target.name}` });
    }
  };
  /** Drags an edge or corner of the selected component, snapping to the grid (operator bug 2). */
  const startResize = (edges: Edges, e: ReactPointerEvent) => {
    if (narrow || !editMode || !selected || !canvasRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const at = findNode(client.current!.doc, selected.id);
    const start = slotOn(selected, device);
    const gridEl = at?.parent?.type === "grid" ? canvasRef.current.querySelector(`[data-node="${CSS.escape(at.parent.id)}"]`) as HTMLElement | null : null;
    if (!at?.parent || !start || !gridEl) return;
    const gridId = at.parent.id;
    const nodeId = selected.id;
    const box = gridBoxOf(gridEl, columnsOn(at.parent, device), zoomRef.current);
    const gridNode = at.parent;
    const o = canvasRef.current.getBoundingClientRect();
    const origin = { left: box.left - o.left, top: box.top - o.top };
    const startX = e.clientX;
    const startY = e.clientY;
    let last = start;
    setResizing(true);
    setHoverId(null);
    setGhost({ gridId, slot: start, rect: slotRect(box, start), box, origin });
    const move = (ev: PointerEvent) => {
      const snapNow = snapRef.current !== (ev.ctrlKey || ev.metaKey);
      last = resizeSlot(start, edges, ev.clientX - startX, ev.clientY - startY, box, snapNow ? 1 : FINE);
      let guides: Guide[] | undefined;
      if (!snapNow) ({ slot: last, guides } = guidedResize(last, edges, gridNode, box, nodeId));
      setGhost({ gridId, slot: last, rect: slotRect(box, last), box, origin, snap: snapNow, ...(guides ? { guides } : {}) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setResizing(false);
      setGhost(null);
      if (last.x === start.x && last.y === start.y && last.w === start.w && last.h === start.h) return;
      const cur = client.current!.doc;
      const node = findNode(cur, nodeId)?.node;
      // A picture or video keeps its shape when its width changes, and its height prop follows the box.
      const fix = node && device === "desktop" ? mediaAfterResize(node, last, edges, box) : null;
      const final = fix?.slot ?? last;
      const op = slotOp(cur, nodeId, final, device);
      const props = fix ? Object.fromEntries(Object.entries(fix.props).filter(([k, v]) => node!.props[k] !== v)) : {};
      if (node && op) apply([op, ...(Object.keys(props).length ? [{ op: "node.update", nodeId, patch: { props } } as DraftOp] : [])], { announce: `${nodeLabel(node)}: ${final.w} wide, ${final.h} tall` });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  /**
   * After a resize of a picture or video (media layout spec 3.1): with a shape set, dragging a side or corner
   * keeps the shape (the height follows the width); dragging only the top or bottom makes it "Fill the box".
   * The old Height prop is kept in step with the box either way.
   */
  const mediaAfterResize = (node: ComponentNode, slot: GridSlot, edges: Edges, box: GridBox): { slot: GridSlot; props: Record<string, PropValue> } | null => {
    if (node.type !== "image" && node.type !== "video") return null;
    const z = zoomRef.current || 1;
    const pad = (box.cellPad ?? 0) / z;
    const el = canvasRef.current?.querySelector(`[data-node="${CSS.escape(node.id)}"]`);
    const cap = (el?.querySelector('[data-media-caption="below"]') as HTMLElement | null)?.offsetHeight ?? 0;
    const width = slotRect(box, slot).width / z;
    const shape = node.props.shape;
    const sized = typeof shape === "string" && shape !== "fill";
    if (sized && (edges.e || edges.w)) {
      const m = el?.querySelector("[data-media-el]") as (HTMLImageElement & HTMLVideoElement) | null;
      const natural = m?.naturalWidth ? { w: m.naturalWidth, h: m.naturalHeight } : m?.videoWidth ? { w: m.videoWidth, h: m.videoHeight } : null;
      const ratio = shapeRatio(shape, natural, node.props.rotate);
      if (ratio) {
        const b = boxForShape(width, ratio, pad + cap);
        return { slot: { ...slot, h: b.rows }, props: { height: b.height } };
      }
    }
    const height = Math.min(1200, Math.max(16, Math.round(slot.h * 8 - pad - cap)));
    return { slot, props: { height, ...(sized && (edges.n || edges.s) ? { shape: "fill" } : {}) } };
  };
  // ---- Fit to content (operator, 2026-10-19): grow exact boxes whose content scrolls ----
  /** Rows a component directly in a fixed-row grid needs to show all its content (0 when it fits). */
  const overflowRows = (el: Element): number => {
    if (!el.parentElement?.parentElement?.matches(".atr-grid[data-fixed-rows]")) return 0;
    const root = el.querySelector(':scope > [data-slot="root"]');
    const over = root ? hiddenHeight(root) : 0;
    return over > 1 ? Math.ceil(over / 8) : 0;
  };
  const overflowOf = (id: string | null): number => {
    const el = id ? canvasRef.current?.querySelector(`[data-node="${CSS.escape(id)}"]`) : null;
    return el ? overflowRows(el) : 0;
  };
  /** Grows the given components (every one that overflows on this page when none are named), as one undo. */
  const fitToContent = (onlyId?: string) => {
    const cur = client.current!.doc;
    const byGrid = new Map<string, Record<string, number>>();
    for (const el of canvasRef.current?.querySelectorAll<HTMLElement>(".atr-grid[data-fixed-rows] > .atr-cell > [data-node]") ?? []) {
      const id = el.getAttribute("data-node")!;
      if (onlyId && id !== onlyId) continue;
      const rows = overflowRows(el);
      const gridId = findNode(cur, id)?.parent?.id;
      if (!rows || !gridId) continue;
      byGrid.set(gridId, { ...byGrid.get(gridId), [id]: rows });
    }
    const ops = [...byGrid].flatMap(([gridId, grow]) => fitOps(cur, gridId, grow, device));
    const count = [...byGrid.values()].reduce((n, g) => n + Object.keys(g).length, 0);
    if (!ops.length) { toast({ kind: "success", title: "Everything already fits" }); return; }
    apply(ops, { announce: `Fitted ${count} ${count === 1 ? "component" : "components"} to their content. Undo with Ctrl+Z.` });
    if (!onlyId) toast({ kind: "success", title: `Fitted ${count} ${count === 1 ? "component" : "components"}`, description: "Components below moved down to make room. Undo with Ctrl+Z." });
  };
  /** The remove button on the selected outline (operator bug 1): selects the parent; undo puts it back. */
  const removeSelected = () => {
    const at = selected ? findNode(client.current!.doc, selected.id) : null;
    if (!at?.parent) return;
    apply([{ op: "node.remove", nodeId: at.node.id }], { announce: `Removed ${nodeLabel(at.node)}. Undo with Ctrl+Z.`, select: at.parent.id });
  };
  /**
   * Clicking an Insert item (spec 3.2 Insert beside): with a widget selected, the new one goes in the next
   * free spot on its row (the same size when it is the same type), else below it; with nothing selected, in
   * the first free spot from the top left. A selected empty Repeat takes it as its child. A selected card
   * stays as it is (operator, 2026-10-19): the new widget goes beside it on the page.
   */
  const addToSelected = (item: InsertItem) => {
    // Wave 2.9 (spec 3.7): Insert > Start page makes a whole page from your services.
    if (item.insertId === START_PAGE_ITEM) { setStartOpen(true); return; }
    const cur = client.current!.doc;
    const node = freshCopy(item.node);
    const sel = selectedRef.current ? findNode(cur, selectedRef.current) : null;
    // A selected group (or a tile inside one) takes the new component in its flow (A10.7: no grid slots).
    const group = sel?.node.type === "group" ? sel.node : sel?.parent?.type === "group" ? sel.parent : null;
    if (group) {
      delete node.slot;
      const index = sel?.node.type === "group" ? (group.children ?? []).length : (sel?.index ?? 0) + 1;
      apply([{ op: "node.add", parentId: group.id, index, node }], { announce: `Added ${nodeLabel(node)} into ${nodeLabel(group)}`, select: node.id });
      reveal(node.id);
      openPickerForNew(node);
      return;
    }
    if (sel?.node.type === "repeat" && !(sel.node.children ?? []).length) {
      delete node.slot;
      apply([{ op: "node.add", parentId: sel.node.id, node }], { announce: `Added ${nodeLabel(node)} into ${nodeLabel(sel.node)}`, select: node.id });
      reveal(node.id);
      openPickerForNew(node);
      return;
    }
    const curPage = findPage(cur, page.id) ?? page;
    let target: ComponentNode = curPage.root;
    let anchor: GridSlot | null = null;
    let size = { w: item.node.slot?.w ?? 3, h: item.node.slot?.h ?? 16 };
    if (sel?.parent?.type === "grid" && sel.node.id !== curPage.root.id) {
      target = sel.parent;
      anchor = slotOn(sel.node, "desktop", gridColumns(sel.parent)) ?? null;
      if (anchor && sel.node.type === node.type) size = { w: anchor.w, h: anchor.h };
    }
    if (target.type === "grid") node.slot = freeSpot(target, "desktop", size, anchor);
    apply([{ op: "node.add", parentId: target.id, node }], { announce: `Added ${nodeLabel(node)}${node.slot ? ` at column ${node.slot.x + 1}, row ${node.slot.y + 1}` : ""}`, select: node.id });
    reveal(node.id);
    openPickerForNew(node);
  };
  /** A new data widget opens the data picker at once, with "Skip for now" to keep sample values (spec 3.3). */
  const openPickerForNew = (node: ComponentNode) => {
    if (node.type === "repeat" && node.name === "Card for each") { setPicker({ nodeId: node.id, prop: "items", fromInsert: true, cards: true }); return; }
    // Wave 2.9 (spec 3.5): a service tile asks which service, then fills itself.
    if (node.type === "service-tile") { setTileFor(node.id); return; }
    // Spec 3.6: a resource bar asks which machine, then fills its readings.
    if (node.type === "resource-bar" && !(Array.isArray(node.props.items) && node.props.items.length)) { setBarFor(node.id); return; }
    if (!DATA_TYPES.has(node.type)) return;
    // Wave 2.9 (spec 3.1): every data component starts with "What should this show?", no data source step.
    openShow({ nodeId: node.id, prop: node.type === "chart" ? "lines" : wholeProp(node.type) ?? "value", fromInsert: true });
  };

  // ---- Files dropped on the canvas (spec 3.1): upload, then an Image or Video at the drop point ----
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onFileDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e) || !editMode || narrow) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!fileOver) setFileOver(true);
  };
  const onFileDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setFileOver(false);
    if (!editMode || narrow) return;
    const file = e.dataTransfer.files[0];
    if (file) void dropFile(file, e.clientX, e.clientY);
  };
  const uploadSeq = useRef(0);
  const dropFile = async (file: File, x: number, y: number) => {
    const kind = guessKind(file);
    if (!kind) {
      toast({ kind: "error", title: "That file cannot go on the page", description: "Drop a picture (PNG, JPEG, GIF, WebP, AVIF or SVG) or a video (MP4 or WebM)." });
      return;
    }
    const o = canvasRef.current?.getBoundingClientRect();
    if (!o) return;
    const cur = client.current!.doc;
    const base = file.name.replace(/\.[A-Za-z0-9]+$/, "").trim().slice(0, 60) || (kind === "video" ? "Video" : "Picture");
    const key = ++uploadSeq.current;
    const track = (pct: number) => setUploading((list) => list.map((u) => (u.key === key ? { ...u, pct } : u)));
    // Onto a selected Image or Video of the same kind: replace its file.
    const hit = nodeAt(document.elementFromPoint(x, y));
    const sel = selectedRef.current ? findNode(cur, selectedRef.current)?.node : null;
    if (sel && hit === sel.id && sel.type === kind) {
      const r = rectOf(sel.id);
      if (r) setUploading((list) => [...list, { key, name: file.name, pct: 0, rect: r }]);
      try {
        const up = await uploadFile(file, kind, track);
        apply([{ op: "node.update", nodeId: sel.id, patch: { props: { src: up.path } } }], { announce: `Replaced the file of ${nodeLabel(sel)} with ${file.name}` });
      } catch (err) {
        toast({ kind: "error", title: `${file.name} was not uploaded`, description: (err as Error).message });
      } finally {
        setUploading((list) => list.filter((u) => u.key !== key));
      }
      return;
    }
    const g = gridUnder(x, y);
    const gridNode = g ? findNode(cur, g.id)?.node : null;
    if (!g || !gridNode) {
      toast({ kind: "error", title: "Drop it on the page", description: "Files land in a grid on the page." });
      return;
    }
    const box = gridBoxOf(g.el, columnsOn(gridNode, device), zoomRef.current);
    const item = props.catalogue.flatMap((c) => c.items).find((i) => i.type === kind);
    const size = item?.node.slot ?? (kind === "video" ? { w: 3, h: 28 } : { w: 3, h: 25 });
    const w = device === "mobile" ? 4 : size.w;
    const cell = cellAt(box, x, y, w, size.h, snapRef.current ? 1 : FINE);
    // A dropped file lands where it was dropped (a deliberate placement), not at the next free row.
    const slot = snapDrop(cell, gridNode, device, { deliberate: true });
    const sr = slotRect(box, slot);
    setUploading((list) => [...list, { key, name: file.name, pct: 0, rect: { left: box.left - o.left + sr.left, top: box.top - o.top + sr.top, width: sr.width, height: Math.max(24, sr.height - (box.cellPad ?? 0)) } }]);
    try {
      const up = await uploadFile(file, kind, track);
      const node: ComponentNode = item ? freshCopy(item.node) : { id: newId("c"), type: kind, props: {} };
      node.name = base;
      node.props = { ...node.props, src: up.path, alt: base };
      // A dropped picture or video shows whole (operator, 2026-10-20; media layout 3.1), in a box shaped
      // like the file (Shape Original): the picture height is the box width times the file's ratio.
      node.props.fit = "contain";
      const shape = kind === "image" ? await pictureShape(file) : await videoShape(up.path);
      if (shape) {
        const z = zoomRef.current || 1;
        const b = boxForShape(sr.width / z, shape, (box.cellPad ?? 0) / z);
        node.props.height = b.height;
        node.props.shape = "original";
        slot.h = b.rows;
      }
      const dc = gridColumns(gridNode);
      if (device === "mobile") { node.slot = { ...slot, w: dc }; node.responsive = { mobile: { slot } }; }
      else node.slot = slot;
      apply([{ op: "node.add", parentId: gridNode.id, node }], { announce: `Added ${base} at column ${slot.x + 1}, row ${slot.y + 1}`, select: node.id });
      reveal(node.id);
    } catch (err) {
      toast({ kind: "error", title: `${file.name} was not uploaded`, description: (err as Error).message });
    } finally {
      setUploading((list) => list.filter((u) => u.key !== key));
    }
  };

  // ---- Multi-select (spec 3.2, A8.8): Shift-click or a box on empty canvas; one undo per action ----
  /** Shift-click: adds or removes a widget; widgets of another grid start a new selection. */
  const toggleMulti = (id: string) => {
    const cur = client.current!.doc;
    const at = findNode(cur, id);
    if (!at?.parent || at.parent.type !== "grid") { setMulti([]); setSelectedId(id); return; }
    const base = multi.length ? multi : selectedId && findNode(cur, selectedId)?.parent ? [selectedId] : [];
    const sameGrid = base.every((b) => findNode(cur, b)?.parent?.id === at.parent!.id);
    const next = !sameGrid ? [id] : base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    if (next.length >= 2) {
      setMulti(next);
      setSelectedId(next.includes(id) ? id : next[0]!);
      setAnnounce(`${next.length} widgets selected`);
    } else {
      setMulti([]);
      setSelectedId(next[0] ?? null);
      if (next[0]) setAnnounce(`Selected ${nodeLabel(findNode(cur, next[0])!.node)}`);
    }
  };
  /** A box dragged on empty canvas selects every widget of that grid it touches (Shift adds to the selection). */
  const startMarquee = (gridId: string, e: ReactPointerEvent) => {
    if (!canvasRef.current) return;
    const o = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const add = e.shiftKey;
    let started = false;
    let rect = { left: 0, top: 0, width: 0, height: 0 };
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      started = true;
      rect = { left: Math.min(sx, ev.clientX) - o.left, top: Math.min(sy, ev.clientY) - o.top, width: Math.abs(ev.clientX - sx), height: Math.abs(ev.clientY - sy) };
      setMarquee(rect);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setMarquee(null);
      if (!started) return;
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      const cur = client.current!.doc;
      const grid = findNode(cur, gridId)?.node;
      const dev: Device = device;
      const hits = (grid?.children ?? []).filter((k) => !(dev === "mobile" ? k.responsive?.mobile?.hidden : k.hidden)).filter((k) => {
        const r = rectOf(k.id);
        return !!r && overlaps({ x: r.left, y: r.top, w: r.width, h: r.height }, { x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      }).map((k) => k.id);
      const keep = add ? (multi.length ? multi : selectedId ? [selectedId] : []).filter((id) => findNode(cur, id)?.parent?.id === gridId) : [];
      const next = [...keep, ...hits.filter((h) => !keep.includes(h))];
      if (next.length >= 2) { setMulti(next); setSelectedId(next[0]!); setAnnounce(`${next.length} widgets selected`); }
      else if (next.length === 1) { setMulti([]); setSelectedId(next[0]!); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  /** The multi-select toolbar's actions: each is one batch, so one undo reverts it. */
  const arrange = (a: ArrangeAction) => {
    const ids = multiRef.current;
    if (ids.length < 2) return;
    const cur = client.current!.doc;
    const dev: Device = narrow ? "mobile" : device;
    const n = ids.length;
    const done = (ops: DraftOp[], words: string) => {
      if (!ops.length) { setAnnounce(`Nothing to change: ${words.toLowerCase()} already`); toast({ kind: "info", title: "Nothing to change", description: `They are ${words.toLowerCase()} already.` }); return; }
      apply(ops, { announce: `${words}. Undo with Ctrl+Z.` });
    };
    const aligns: Record<string, [AlignHow, string]> = { left: ["left", "Left edges lined up"], centre: ["centre", "Centres lined up"], right: ["right", "Right edges lined up"], top: ["top", "Tops lined up"], middle: ["middle", "Middles lined up"], bottom: ["bottom", "Bottoms lined up"] };
    if (aligns[a]) return done(alignOps(cur, ids, aligns[a]![0], dev), aligns[a]![1]);
    if (a === "across" || a === "down") return done(distributeOps(cur, ids, a, dev), a === "across" ? "Spaced evenly across" : "Spaced evenly down");
    if (a === "width" || a === "height") return done(sameSizeOps(cur, ids, a, dev), a === "width" ? "Same width" : "Same height");
    if (a === "duplicate") {
      const r = groupDuplicateOps(cur, ids);
      if (!r.ops.length) return;
      apply(r.ops, { announce: `Duplicated ${n} widgets. Undo with Ctrl+Z.` });
      setMulti(r.copyIds);
      setSelectedId(r.copyIds[0]!);
      reveal(r.copyIds[0]!);
      return;
    }
    if (a === "hide") {
      const isHidden = (id: string) => { const x = findNode(cur, id)?.node; return dev === "mobile" ? x?.responsive?.mobile?.hidden === true : x?.hidden === true; };
      const show = ids.every(isHidden);
      const ops = ids.map((id) => ({ op: "node.update", nodeId: id, patch: (dev === "mobile" ? { responsive: { mobile: { hidden: show ? null : true } } } : { hidden: show ? null : true }) as never }) as DraftOp);
      apply(ops, { announce: `${n} widgets ${show ? "shown" : "hidden"} on ${dev === "mobile" ? "phones" : "desktop"}. Undo with Ctrl+Z.` });
      return;
    }
    if (a === "delete") {
      const parent = findNode(cur, ids[0]!)?.parent;
      apply(ids.map((id) => ({ op: "node.remove", nodeId: id }) as DraftOp), { announce: `Removed ${n} widgets. Undo with Ctrl+Z.`, ...(parent ? { select: parent.id } : {}) });
      setMulti([]);
    }
  };
  arrangeRef.current = arrange;

  // ---- Layers actions (spec 3.4): hide, move a step, rename, duplicate, delete; each one undoable ----
  const layerHide = (id: string) => {
    const n = findNode(client.current!.doc, id)?.node;
    if (!n) return;
    const dev: Device = narrow ? "mobile" : device;
    const hidden = dev === "mobile" ? n.responsive?.mobile?.hidden === true : n.hidden === true;
    const patch = dev === "mobile" ? { responsive: { mobile: { hidden: hidden ? null : true } } } : { hidden: hidden ? null : true };
    apply([{ op: "node.update", nodeId: id, patch: patch as never }], { announce: `${nodeLabel(n)} ${hidden ? "shown" : "hidden"} on ${dev === "mobile" ? "phones" : "desktop"}` });
  };
  const layerRename = (id: string, name: string) => {
    const n = findNode(client.current!.doc, id)?.node;
    const t = name.trim().slice(0, 80);
    if (!n || (n.name ?? "") === t) return;
    apply([{ op: "node.update", nodeId: id, patch: { name: t ? t : (null as never) } }], { announce: t ? `Renamed to ${t}` : "Name cleared" });
  };
  const layerDuplicate = (id: string) => {
    const act = keyAction(client.current!.doc, id, { key: "d", shift: false, alt: false, mod: true }, narrow ? "mobile" : device);
    if (act?.kind === "ops") { apply(act.ops, { announce: act.announce, ...(act.select ? { select: act.select } : {}) }); if (act.select) reveal(act.select); }
  };
  const layerDelete = (id: string) => {
    const at = findNode(client.current!.doc, id);
    if (!at?.parent) return;
    const count = (n: ComponentNode): number => (n.children ?? []).reduce((m, k) => m + 1 + count(k), 0);
    const kids = count(at.node);
    if (kids > 0 && !window.confirm(`Delete ${nodeLabel(at.node)} and the ${kids} ${kids === 1 ? "component" : "components"} inside it?`)) return;
    apply([{ op: "node.remove", nodeId: id }], { announce: `Removed ${nodeLabel(at.node)}. Undo with Ctrl+Z.`, select: at.parent.id });
  };

  // Settings' "Use on an app" links to ?review=1 and "Used by" to ?look=1: open that sheet once, then
  // drop the parameter so a reload does not open it again.
  const openedOnStart = useRef(false);
  useEffect(() => {
    const want = props.openOnStart;
    if (openedOnStart.current || !want) return;
    openedOnStart.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("review");
    url.searchParams.delete("look");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (want === "review") {
      void client.current?.flush();
      setReviewOpen(true);
    } else setLookOpen(true);
  });

  // The library's Use button opens /build/<slug>?insert=lib:<id>: add that component once, then drop
  // the parameter so a reload does not add it again.
  const insertedOnOpen = useRef(false);
  useEffect(() => {
    const want = props.insertOnOpen;
    if (insertedOnOpen.current || !want) return;
    insertedOnOpen.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("insert");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (window.matchMedia(NARROW).matches) return;
    const item = props.catalogue.flatMap((g) => g.items).find((i) => i.type === want);
    if (!item) {
      toast({ kind: "error", title: "That library component is not available", description: "It may have been deleted. The Insert tab lists the ones you can use." });
      return;
    }
    addToSelected(item);
  });

  // ---- Pages ----
  const addPage = () => {
    const title = window.prompt("Page title", "New page")?.trim();
    if (!title) return;
    let slug = slugify(title) || "page";
    for (let n = 2; doc.pages.some((p) => p.slug === slug); n++) slug = `${slugify(title).slice(0, 36) || "page"}-${n}`;
    const p: PageDoc = { id: newId("p"), slug, title, inNav: true, root: { id: newId("c"), type: "grid", props: {}, children: [] } };
    apply([{ op: "page.add", page: p }]);
    window.setTimeout(() => goPage(p), 0);
  };

  const status = `draft · rev ${rev} · ${meta.pending} ${meta.pending === 1 ? "change" : "changes"} since ${meta.publishedVersion ? `v${meta.publishedVersion}` : "creation"}`;
  const who = meta.authors.map((a) => `${a.name}${a.kind === "agent" ? " (agent)" : ""}`).join(", ");
  const dirty = meta.pending > 0;
  const selRect = editMode ? rectOf(selectedId) : null;
  const hovRect = editMode && !narrow && hoverId !== selectedId ? rectOf(hoverId) : null;
  const gridOn = editMode && !narrow;
  const showCanvas = !narrow || narrowTab === "canvas";
  const settling = settleKey && selected && settleKey.id === selected.id ? settleKey.n : 0;
  // Widgets fully under another get a "covered" tag in Layers (spec 3.2).
  const covered = useMemo(() => coveredOnPage(page.root, narrow ? "mobile" : device), [page, narrow, device]);

  const selectFromReview = (where: { pageId?: string; nodeId: string }) => {
    setReviewOpen(false);
    const target = where.pageId ? findPage(doc, where.pageId) : findNode(doc, where.nodeId)?.page;
    if (target && target.id !== page.id) goPage(target);
    setSelectedId(where.nodeId);
    if (narrow) setNarrowTab("edit");
    const n = findNode(doc, where.nodeId)?.node;
    if (n) setAnnounce(`Selected ${nodeLabel(n)}`);
    reveal(where.nodeId);
  };

  const left = (
    <aside className={`flex flex-none flex-col bg-bg-hi ${narrow ? "min-h-0 w-full flex-1" : "w-[264px] border-r border-line-strong"}`} data-builder-left>
      {!narrow && (
        <div role="tablist" className="flex border-b border-line">
          {(["insert", "layers"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={`h-9 flex-1 type-label ${tab === t ? "bg-fg text-bg" : "text-fg-2 hover:bg-bg-sunk"}`} data-left-tab={t}>{t === "insert" ? "Insert" : "Layers"}</button>
          ))}
        </div>
      )}
      {!narrow && tab === "insert" ? (
        <InsertPanel groups={insertGroups} onAdd={addToSelected} onPickUp={(item, e) => { if (item.insertId === START_PAGE_ITEM) return; startDrag({ kind: "insert", item, w: item.node.slot?.w ?? (device === "mobile" ? 4 : 3), h: item.node.slot?.h ?? 16 }, e); }} />
      ) : (
        <LayersPanel page={page} selectedId={selectedId} agentNodes={meta.agentNodes} stepButtons={narrow} device={narrow ? "mobile" : device} covered={covered} selectedIds={multiOn ? new Set(multi) : undefined} onSelect={(id, o) => (o?.shift && !narrow ? toggleMulti(id) : setSelectedId(id))} onMove={(nodeId, parentId, index) => apply([{ op: "node.move", nodeId, parentId, ...(index === Number.MAX_SAFE_INTEGER ? {} : { index }) }], { announce: "Moved in the layer tree" })}
          onHide={layerHide} onRename={layerRename} onDuplicate={layerDuplicate} onDelete={layerDelete} />
      )}
    </aside>
  );

  return (
    <div ref={rootRef} className="flex h-dvh min-h-[560px] flex-col bg-bg" data-builder={app.slug} data-builder-narrow={narrow ? "" : undefined}>
      {/* Builder bar, 48px. The publish glow (design v4 Note 1) is a gold strip across the bar beneath its text. */}
      <div className="relative isolate flex h-12 flex-none items-center gap-2 overflow-hidden border-b border-line-strong bg-bg-hi px-3 max-sm:gap-1 max-sm:px-2" data-builder-bar data-glowing={glowing ? "" : undefined}>
        {glow > 0 && !reduced && (
          <motion.span
            key={glow}
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-accent will-change-[opacity]"
            initial={{ opacity: 0 }}
            animate={{ opacity: glowKeyframes.opacity }}
            transition={{ duration: durations.glow.ms / 1000, ease: glowKeyframes.ease.map((e) => (typeof e === "string" ? e : [...e])) as never, times: glowKeyframes.times }}
            data-publish-glow
          />
        )}
        <Link href="/" className={`inline-flex h-8 flex-none items-center gap-1 whitespace-nowrap px-2 type-label hover:bg-bg-sunk touch:h-11 max-sm:px-1.5 ${glowing ? "text-accent-fg" : "text-fg-2"}`} data-back-to-apps>← Apps</Link>
        <span aria-hidden className="h-5 w-px flex-none bg-line max-sm:hidden" />
        <svg viewBox="0 0 12 14" width={10} height={12} aria-hidden className="flex-none" data-door={dirty ? "outlined" : "lit"}>
          <path d="M1 13V6a5 5 0 0 1 10 0v7Z" fill={dirty ? "none" : "var(--accent)"} stroke="var(--accent-ink)" strokeWidth={dirty ? 1.4 : 0} />
        </svg>
        <span className={`relative min-w-0 truncate type-label font-medium max-sm:min-w-[2.75rem] max-sm:shrink ${glowing ? "text-accent-fg" : ""}`} data-builder-title>
          {doc.app.name}
          {glow > 0 && reduced && <StaticRing key={glow} />}
        </span>
        {glow > 0 && <PublishCheck key={`c${glow}`} reduced={reduced} />}
        <div className="w-40 min-w-0 flex-none max-sm:w-auto max-sm:min-w-[4.5rem] max-sm:flex-[1_1_0%] [&_[data-select]>span:first-child]:min-w-0 [&_[data-select]>span:first-child]:truncate" data-page-switcher>
          <SelectMenu label="Page" hideLabel name="page" value={page.id} onChange={(id) => { const p = findPage(doc, id); if (p) goPage(p); }} options={orderedPages(doc).map((p) => ({ value: p.id, label: `${p.title}${p.inNav ? "" : " (hidden)"}` }))} />
        </div>
        {!narrow && <PageMenu doc={doc} page={page} apply={apply} onAdd={addPage} onLook={() => setLookOpen(true)} onFit={() => fitToContent()} />}
        {!narrow && <button type="button" onClick={() => setLookOpen(true)} className="inline-flex h-8 items-center gap-1.5 border border-line-strong px-2 type-label hover:bg-bg-sunk" data-builder-look><span aria-hidden className="h-3 w-3 border border-line-strong bg-accent" />Look</button>}
        <span className={`ml-2 hidden min-w-0 truncate font-mono text-[12px] lg:inline ${glowing ? "text-accent-fg" : "text-fg-2"}`} title={who} data-draft-status>{status}{who ? ` · ${who}` : ""}</span>
        <span className="ml-auto" />
        {!narrow && (
          <>
            <div role="group" aria-label="Device" className="flex border border-line-strong">
              {(["desktop", "mobile"] as const).map((d) => (
                <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)} className={`h-8 px-2 type-label ${device === d ? "bg-fg text-bg" : "text-fg-2"}`} data-device={d}>{d}</button>
              ))}
            </div>
            <button type="button" aria-pressed={editMode} onClick={() => setEditMode((v) => !v)} className={`h-8 border border-line-strong px-2 type-label ${editMode ? "bg-fg text-bg" : "text-fg-2"}`} data-edit-toggle>Edit</button>
          </>
        )}
        <Button variant="quiet" href={`/a/${app.slug}/${page.slug}?draft=1`} target="_blank" rel="noopener" aria-label="Preview (opens a new tab)" title="Opens in a new tab" className="flex-none max-sm:w-11 max-sm:px-0" data-preview>
          {/* Phones (gauntlet w2-r3 item 5): the glyph alone, in a 44px square; the name stays in aria-label. */}
          <span className="max-sm:sr-only">Preview</span>
          <svg viewBox="0 0 12 12" width={11} height={11} aria-hidden className="ml-1 flex-none max-sm:ml-0 max-sm:h-4 max-sm:w-4" data-external-glyph>
            <path d="M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5 5.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
          </svg>
        </Button>
        {!narrow && <Button variant="quiet" href={`/build/${app.slug}/versions`} data-versions-link>Versions</Button>}
        {!narrow && <Button variant="quiet" href={`/build/${app.slug}/settings`} data-settings-link>Settings</Button>}
        <Button variant="primary" className="flex-none max-sm:px-3" onClick={() => { void client.current!.flush(); setReviewOpen(true); }} data-publish>Publish</Button>
      </div>

      {!narrow && (
        // The canvas bar (Wave 2.6): page settings, snapping, preview width and the panel folds, under the
        // builder bar so the 48px bar keeps room for its own controls at 1280px.
        <div className="flex h-10 flex-none items-center gap-2 border-b border-line bg-bg-hi px-3" data-canvas-bar>
          <FoldButton side="left" folded={foldLeft} onToggle={() => setFoldLeft(!foldLeft)} />
          <PageSettings key={page.id} page={page} apply={apply} />
          <span className="truncate type-caption text-fg-2" data-page-settings-summary>
            {page.maxWidth ? `${page.maxWidth} px wide` : "Fills the screen"} · padding {page.padding === undefined ? "from the theme" : page.padding === "none" ? "none" : `${page.padding} px`}
          </span>
          <span className="ml-auto" />
          <SnapSwitch on={snap} onChange={(v) => { setSnap(v); setAnnounce(v ? "Snapping on" : "Snapping off: free placement with alignment guides"); }} />
          <PreviewWidth value={previewW} onChange={setPreviewW} zoom={zoom} disabled={device === "mobile"} />
          <FoldButton side="right" folded={foldRight} onToggle={() => setFoldRight(!foldRight)} />
        </div>
      )}
      {narrow && (
        <>
          <p className="border-b border-line bg-bg-sunk px-3 py-2 type-caption text-fg-2" data-readonly-note data-narrow-note>Small screen: tap a component to select it, change its content and data under Edit, reorder it in Layers, and publish. Dragging and the grid need a screen at least 900px wide.</p>
          {/* The phone bar is full at 360px, so the Pages menu sits at the end of the view tabs (Tristan, 2026-10-19). */}
          <div className="flex flex-none border-b border-line-strong bg-bg-hi">
            <div role="tablist" aria-label="Builder view" className="flex min-w-0 flex-1" data-narrow-tabs>
              {(["canvas", "layers", "edit"] as const).map((t) => (
                <button key={t} role="tab" type="button" aria-selected={narrowTab === t} onClick={() => setNarrowTab(t)} className={`h-11 min-w-0 flex-1 truncate px-1 type-label ${narrowTab === t ? "bg-fg text-bg" : "text-fg-2"}`} data-narrow-tab={t}>
                  {t === "canvas" ? "Canvas" : t === "layers" ? "Layers" : selected ? `Edit ${nodeLabel(selected)}` : "Edit"}
                </button>
              ))}
            </div>
            <span className="flex-none border-l border-line-strong"><PageMenu doc={doc} page={page} apply={apply} onAdd={addPage} onLook={() => setLookOpen(true)} onFit={() => fitToContent()} compact /></span>
          </div>
        </>
      )}

      <div className="flex min-h-0 flex-1">
        {(narrow ? narrowTab === "layers" : !foldLeft) && left}

        <div className={`flex min-w-0 flex-1 flex-col ${showCanvas ? "" : "hidden"}`} data-canvas-column>
        <section
          ref={sectionRef}
          className={`relative min-h-0 min-w-0 flex-1 overflow-auto bg-bg-sunk ${fileOver ? "outline-2 -outline-offset-4 outline-dashed outline-accent-ink" : ""}`}
          data-builder-canvas
          data-app-viewport
          data-file-over={fileOver ? "" : undefined}
          aria-label="Canvas"
          onDragOver={onFileDragOver}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false); }}
          onDrop={onFileDrop}
          style={{ backgroundImage: "linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px)", backgroundSize: "80px 80px" }}
        >
          <motion.div aria-hidden className="pointer-events-none absolute inset-0 bg-bg-sunk" initial={false} animate={{ opacity: gridOn ? 0 : 1 }} transition={reduced ? { duration: 0 } : timed("fade")} data-grid-cover />
          <motion.div className="relative mx-auto" initial={false} animate={{ padding: editMode && !narrow ? 24 : 0 }} transition={transitionFor("lift", reduced)} style={{ maxWidth: device === "mobile" ? 390 + 48 : undefined, ...(scaled ? { width: (previewW as number) * zoom + inset * 2 } : {}) }} data-canvas-inset={editMode && !narrow ? "24" : "0"}>
            <div
              ref={canvasRef}
              className="relative"
              style={scaled ? { width: (previewW as number) * zoom, height: innerH * zoom } : undefined}
              data-canvas-zoom={Math.round(zoom * 1000) / 1000}
              onPointerMove={(e) => { if (editMode && !drag && !resizing && !narrow) setHoverId(nodeAt(e.target)); }}
              onPointerLeave={() => setHoverId(null)}
              onPointerDown={(e) => {
                // A box dragged from empty canvas (a grid, not a widget) selects what it touches (spec 3.2).
                if (!editMode || narrow || e.button !== 0) return;
                if (e.target instanceof Element && e.target.closest("[data-canvas-control]")) return;
                const id = nodeAt(e.target);
                const n = id ? findNode(client.current!.doc, id)?.node : null;
                if (n?.type !== "grid") return;
                e.preventDefault();
                startMarquee(n.id, e);
              }}
              onClickCapture={(e) => {
                if (!editMode) return;
                // The selected outline's own controls (remove, resize) take their clicks (operator bug 1).
                if (e.target instanceof Element && e.target.closest("[data-canvas-control]")) return;
                const id = nodeAt(e.target);
                e.preventDefault();
                e.stopPropagation();
                if (suppressClick.current) { suppressClick.current = false; return; }
                if (id && e.shiftKey && !narrow && id !== page.root.id) { toggleMulti(id); return; }
                if (id) { setMulti([]); setSelectedId(id); setAnnounce(`Selected ${nodeLabel(findNode(doc, id)!.node)}`); }
              }}
              data-canvas-root
            >
              {/* Preview width (spec 3.6): the page at its real width, scaled to fit; overlays stay unscaled. */}
              <div ref={scaledRef} className={scaled ? "absolute left-0 top-0 origin-top-left" : undefined} style={scaled ? { width: previewW as number, transform: zoom === 1 ? undefined : `scale(${zoom})` } : undefined} data-canvas-scaled={scaled ? String(previewW) : undefined}>
              <AppFrame
                doc={doc}
                page={page}
                ctx={!editMode ? { ...ctx, mode: "view" } : ctx}
                theme={render.theme}
                canvasCss={render.canvasCss}
                chromeCss={render.chromeCss}
                nodeCss={render.nodeCss}
                frameId={`app-${app.id}`.replace(/[^A-Za-z0-9_-]/g, "")}
                hrefFor={(p) => `/build/${app.slug}/${p.slug}`}
                device={narrow ? "mobile" : device}
                className="min-h-[600px]"
              />
              </div>
              {/* Outlines: hovered 1px, selected 2px with its type as a mono tag (the tag is the drag handle).
                  A node that just arrived settles in (the settle spring; instant with reduced motion). */}
              {/* A layer hidden on this device is gone from the canvas; selected from Layers it shows faintly. */}
              {selectedId && /^c_[a-z2-7]{10}$/.test(selectedId) && <style>{`[data-canvas-root] .atr-node[data-node="${selectedId}"][data-hidden-device]{visibility:visible}`}</style>}
              {hovRect && <div aria-hidden className="pointer-events-none absolute border border-accent-ink" style={hovRect} data-hover-outline />}
              {selRect && selected && !multiOn && (
                <motion.div
                  key={`sel-${selected.id}-${settling}`}
                  className="pointer-events-none absolute border-2 border-accent-ink"
                  style={selRect}
                  initial={settling && !reduced ? { opacity: 0, scale: 1.04 } : false}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={transitionFor("settle", reduced)}
                  data-selected-outline={selected.id}
                  data-settled={settling ? "" : undefined}
                >
                  <div className="absolute -top-5 left-[-2px] flex" data-canvas-control>
                    <span
                      aria-hidden
                      title={narrow ? undefined : "Drag to move"}
                      className={`pointer-events-auto flex select-none items-center gap-1 bg-accent-ink px-1 font-mono text-[11px] leading-5 text-bg ${narrow ? "" : "cursor-grab touch-none"}`}
                      onPointerDown={(e) => { if (narrow) return; const s = slotOn(selected, device) ?? (selectedParent?.type === "group" ? { w: 3, h: 12 } : undefined); if (s) startDrag({ kind: "move", nodeId: selected.id, label: nodeLabel(selected), w: s.w, h: s.h }, e); }}
                      data-drag-handle
                    >
                      {!narrow && <svg viewBox="0 0 6 10" width={6} height={10} fill="currentColor" aria-hidden data-move-grip><circle cx="1.5" cy="2" r="1" /><circle cx="4.5" cy="2" r="1" /><circle cx="1.5" cy="5" r="1" /><circle cx="4.5" cy="5" r="1" /><circle cx="1.5" cy="8" r="1" /><circle cx="4.5" cy="8" r="1" /></svg>}
                      {tagFor(selected, (ctx.values as { $library?: Record<string, LibraryComponent> }).$library)}
                    </span>
                    {/* Fit shows only while the content scrolls inside the box (operator, 2026-10-19). */}
                    {selectedParent && overflowOf(selected.id) > 0 && (
                      <button
                        type="button"
                        aria-label={`Fit ${nodeLabel(selected)} to its content`}
                        title="Grow the box so all its content shows. Undo with Ctrl+Z"
                        className="pointer-events-auto relative flex h-5 items-center border-l border-bg/40 bg-accent-ink px-1.5 font-mono text-[11px] text-bg after:absolute after:-inset-1 hover:bg-fg touch:after:-inset-3"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => fitToContent(selected.id)}
                        data-fit-selected
                      >
                        Fit
                      </button>
                    )}
                    {/* The widget's own toolbar (operator, 2026-10-20): move a step, duplicate, hide and remove,
                        the same undoable actions as its Layers row; hit areas grow to 44px on touch screens. */}
                    {selectedParent && (() => {
                      const siblings = selectedParent.children ?? [];
                      const at = siblings.findIndex((c) => c.id === selected.id);
                      const dev: Device = narrow ? "mobile" : device;
                      const hiddenHere = dev === "mobile" ? selected.responsive?.mobile?.hidden === true : selected.hidden === true;
                      const name = nodeLabel(selected);
                      const step = (to: number) => apply([{ op: "node.move", nodeId: selected.id, parentId: selectedParent.id, index: to }], { announce: `Moved ${name} ${to < at ? "up" : "down"} one step` });
                      return (
                        <>
                          <BarButton label={`Move ${name} up one step`} title="Move up one step (Alt+Up): in front of the one before it" disabled={at <= 0} onClick={() => step(at - 1)} data-bar-up>
                            <path d="M5 8.5V1.5M2 4.5l3-3 3 3" />
                          </BarButton>
                          <BarButton label={`Move ${name} down one step`} title="Move down one step (Alt+Down)" disabled={at < 0 || at >= siblings.length - 1} onClick={() => step(at + 1)} data-bar-down>
                            <path d="M5 1.5v7M2 5.5l3 3 3-3" />
                          </BarButton>
                          <BarButton label={`Duplicate ${name}`} title="Duplicate (Ctrl+D)" onClick={() => layerDuplicate(selected.id)} data-bar-duplicate>
                            <path d="M3.5 3.5h5v5h-5zM1.5 6.5v-5h5" />
                          </BarButton>
                          <BarButton label={hiddenHere ? `Show ${name}` : `Hide ${name}`} title={hiddenHere ? `Show it again on ${dev === "mobile" ? "phones" : "desktop"}` : `Hide it on ${dev === "mobile" ? "phones" : "desktop"} (it stays in Layers)`} pressed={hiddenHere} onClick={() => layerHide(selected.id)} data-bar-hide>
                            {hiddenHere ? <path d="M1 5s1.5-3 4-3 4 3 4 3-1.5 3-4 3-4-3-4-3zM1.5 1.5l7 7" /> : <path d="M1 5s1.5-3 4-3 4 3 4 3-1.5 3-4 3-4-3-4-3zM5 6.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z" />}
                          </BarButton>
                          <BarButton label={`Remove ${name}`} title="Remove (Delete). Undo with Ctrl+Z" danger onClick={removeSelected} data-remove-selected>
                            <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" />
                          </BarButton>
                        </>
                      );
                    })()}
                  </div>
                  {/* Edge and corner handles resize on the grid (operator bug 2); 44px hit areas on touch screens. */}
                  {!narrow && selectedSlot && selectedParent?.type === "grid" && RESIZE_HANDLES.map((h) => (
                    <span
                      key={h.id}
                      aria-hidden
                      className={`pointer-events-auto absolute h-2 w-2 touch-none border border-accent-ink bg-bg-hi after:absolute after:-inset-1.5 touch:after:-inset-[18px] ${h.cls}`}
                      onPointerDown={(e) => startResize(h.edges, e)}
                      data-canvas-control
                      data-resize-handle={h.id}
                    />
                  ))}
                </motion.div>
              )}
              {/* Several selected (spec 3.2): an outline on each with a grip that moves them all, and the toolbar. */}
              {multiOn && editMode && (() => {
                const rects = multi.flatMap((id) => { const r = rectOf(id); return r ? [{ id, r }] : []; });
                if (!rects.length) return null;
                const left = Math.min(...rects.map((x) => x.r.left));
                const top = Math.min(...rects.map((x) => x.r.top));
                return (
                  <>
                    {rects.map(({ id, r }) => (
                      <div key={id} className="pointer-events-none absolute border-2 border-accent-ink" style={r} data-multi-outline={id}>
                        <span
                          className="pointer-events-auto absolute -left-[2px] -top-[18px] flex h-4 w-5 cursor-grab touch-none items-center justify-center bg-accent-ink text-bg"
                          title="Drag to move all the selected widgets"
                          aria-hidden
                          onPointerDown={(e) => { const n = findNode(doc, id)?.node; const s0 = n ? slotOn(n, device) : undefined; if (n && s0) startDrag({ kind: "move", nodeId: id, label: `${multi.length} widgets`, w: s0.w, h: s0.h, group: multi }, e); }}
                          data-multi-grip={id}
                          data-canvas-control
                        >
                          <svg viewBox="0 0 6 10" width={6} height={10} fill="currentColor" aria-hidden><circle cx="1.5" cy="2" r="1" /><circle cx="4.5" cy="2" r="1" /><circle cx="1.5" cy="5" r="1" /><circle cx="4.5" cy="5" r="1" /><circle cx="1.5" cy="8" r="1" /><circle cx="4.5" cy="8" r="1" /></svg>
                        </span>
                      </div>
                    ))}
                    <div className="absolute z-10" style={{ left, top: Math.max(-22, top - 42) }}>
                      <ArrangeBar count={multi.length} onAction={arrange} />
                    </div>
                  </>
                );
              })()}
              {marquee && <div aria-hidden className="pointer-events-none absolute border border-accent-ink bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]" style={marquee} data-marquee />}
              {drag && into && (
                <div aria-hidden className="pointer-events-none absolute border-2 border-dashed border-accent-ink bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]" style={into.rect} data-drop-into={into.id}>
                  <span className="absolute left-0 top-0 bg-accent-ink px-1 font-mono text-[11px] leading-5 text-bg">into {into.name}</span>
                </div>
              )}
              {(drag || resizing) && ghost?.group?.map((g, i) => (
                <div key={`grp${i}`} aria-hidden className="pointer-events-none absolute border-2 border-dashed border-accent-ink" style={{ left: ghost.origin.left + slotRect(ghost.box, g).left, top: ghost.origin.top + slotRect(ghost.box, g).top, width: slotRect(ghost.box, g).width, height: Math.max(8, slotRect(ghost.box, g).height - (ghost.box.cellPad ?? 0)) }} data-group-ghost />
              ))}
              {(drag || resizing) && ghost && (
                <>
                  {/* Only the target cell is lit; the columns show as quiet hairlines (gauntlet w2-r1 item 17).
                      With snap off the cells are not drawn; alignment guides show instead (spec 3.5). */}
                  {ghost.snap !== false && <div aria-hidden className="pointer-events-none absolute" style={{ left: ghost.origin.left, top: ghost.origin.top, width: ghost.box.width, height: Math.max(ghost.rect.top + ghost.rect.height + 80, 200) }} data-grid-cells>
                    <div className="h-full w-full" style={{ backgroundImage: `repeating-linear-gradient(to right, transparent 0 ${(ghost.box.width - (ghost.box.cols - 1) * ghost.box.colGap) / ghost.box.cols}px, var(--line) ${(ghost.box.width - (ghost.box.cols - 1) * ghost.box.colGap) / ghost.box.cols}px ${(ghost.box.width - (ghost.box.cols - 1) * ghost.box.colGap) / ghost.box.cols + ghost.box.colGap}px)` }} />
                  </div>}
                  {ghost.snap === false && ghost.guides?.map((g, i) => <GuideLine key={`${g.axis}${g.at}${i}`} g={g} ghost={ghost} />)}
                  <motion.div aria-hidden className="pointer-events-none absolute border-2 border-dashed border-accent-ink bg-[color-mix(in_srgb,var(--accent)_25%,transparent)]" initial={false} animate={{ x: ghost.origin.left + ghost.rect.left, y: ghost.origin.top + ghost.rect.top }} transition={transitionFor("glide", reduced)} style={{ left: 0, top: 0, width: ghost.rect.width, height: Math.max(8, ghost.rect.height - (ghost.box.cellPad ?? 0)) }} data-drop-ghost={`${ghost.slot.x},${ghost.slot.y}`} data-ghost-slot={`${ghost.slot.x},${ghost.slot.y},${ghost.slot.w},${ghost.slot.h}`} />
                </>
              )}
              {/* Files dropped on the canvas while they upload (spec 3.1, 4 Loading). */}
              {uploading.map((u) => (
                <div key={u.key} className="pointer-events-none absolute flex items-center justify-center border-2 border-dashed border-accent-ink bg-bg-hi/80 font-mono text-[12px]" style={u.rect} role="status" data-upload-placeholder={u.pct}>
                  <span className="max-w-full truncate px-2">{u.name} · {u.pct}%</span>
                </div>
              ))}
            </div>
          </motion.div>
        </section>
        {/* components' HTML code window docks here, under the canvas, when "Edit code" is pressed (components item 1). */}
        {!narrow && <div ref={dockRef} className="max-h-[45%] flex-none overflow-auto border-t border-line-strong bg-bg-hi empty:hidden" data-code-dock data-builder-code-dock />}
        </div>

        {(narrow ? narrowTab === "edit" : !foldRight) && (
          <aside className={`flex-none overflow-y-auto bg-bg-hi ${narrow ? "min-h-0 w-full flex-1" : "w-[320px] border-l border-line-strong"}`} data-builder-inspector>
            {multiOn ? (
              <MultiPanel names={multi.map((id) => { const n = findNode(doc, id)?.node; return n ? nodeLabel(n) : id; })} onAction={arrange} onClear={() => setMulti([])} />
            ) : (
            <Inspector node={selected} doc={doc} ctx={ctx} device={narrow ? "mobile" : device} problems={problems} apply={(ops) => apply(ops)} applyAndWait={applyAndWait} compact={narrow}
              live={{ data: shownData, states: live.states }} onPick={onInspectorPick} onSelect={(id) => { setSelectedId(id); reveal(id); }} />
            )}
          </aside>
        )}
      </div>
      {/* The component under the pointer while dragging: lifted on --shadow-lifted (the lift spring). */}
      {drag && pointer && (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 z-50 flex w-44 items-center gap-2 border border-line-strong bg-bg-hi p-2 shadow-lifted"
          initial={reduced ? false : { opacity: 0, y: 0 }}
          animate={{ opacity: 1, y: reduced ? 0 : -4 }}
          transition={transitionFor("lift", reduced)}
          style={{ x: pointer.x + 12, top: pointer.y + 8 }}
          data-drag-lifted
        >
          <InsertGlyph type={drag.kind === "insert" ? drag.item.type : findNode(doc, drag.nodeId)?.node.type ?? "card"} />
          <span className="min-w-0 truncate type-label">{drag.kind === "insert" ? drag.item.title : drag.label}</span>
        </motion.div>
      )}
      <div aria-live="polite" className="sr-only" data-builder-announce>{announce}</div>
      {reviewOpen && (
        <ReviewSheet appId={app.id} open applyOps={applyAndWait} onClose={() => setReviewOpen(false)} onSelectProblem={selectFromReview} onDone={async ({ version }) => {
          setReviewOpen(false);
          setGlow((g) => g + 1);
          publishToast.current = toast({ kind: "success", title: `Published v${version}` });
          const latest = await fetch(`/api/apps/${app.id}/draft`, { credentials: "same-origin" }).then((r) => r.json() as Promise<{ rev: number; doc: AppDocument }>);
          client.current!.reset(latest.doc, latest.rev);
          void refreshMeta();
        }} />
      )}
      {picker && <DataPicker appId={app.id} target={picker} doc={doc} bindable={bindable} data={live.data as Record<string, ShapedData | undefined>} states={live.states} apply={(ops) => apply(ops)} onClose={() => setPicker(null)} />}
      {show && (
        <ShowPicker target={show} doc={doc} bindable={bindable ?? bindableRef.current} data={shownData} apply={(ops) => { apply(ops); void client.current!.flush(); }} onClose={() => setShow(null)}
          onByHand={() => { const t = show; setShow(null); setPicker({ nodeId: t.nodeId, ...(/^[A-Za-z]+$/.test(t.prop) && t.prop !== "lines" ? { prop: t.prop } : {}), ...(t.fromInsert ? { fromInsert: true } : {}), ...(t.source && !client.current!.doc.dataSources.find((x) => x.name === t.source)?.managed ? { source: t.source } : {}) }); }}
          onPeeked={(name, d) => setInstant((m) => ({ ...m, [name]: d }))} onSelect={(id) => { setSelectedId(id); reveal(id); }} newNodeId={() => newId("c")} />
      )}
      {barFor && <MachineChooser nodeId={barFor} doc={doc} bindable={bindable ?? bindableRef.current} apply={(ops) => { apply(ops); void client.current!.flush(); }} onClose={() => setBarFor(null)} />}
      {tileFor && <ServiceChooser nodeId={tileFor} doc={doc} bindable={bindable ?? bindableRef.current} apply={(ops) => { apply(ops); void client.current!.flush(); }} onClose={() => setTileFor(null)} />}
      {startOpen && <StartPageSheet appId={app.id} apply={(ops) => { apply(ops, { announce: "Made a start page" }); void client.current!.flush(); }} onClose={() => setStartOpen(false)} onMade={(pageId) => {
        setStartOpen(false);
        const p = findPage(client.current!.doc, pageId);
        if (p && p.id !== page.id) goPage(p);
        toast({ kind: "success", title: "Start page made", description: "Values fill in as your services answer. Undo takes it all back." });
      }} />}
      {lookOpen && <AppLookSheet appId={app.id} doc={doc} page={page} theme={render.theme} chromeRemoved={render.chromeRemoved} onClose={() => setLookOpen(false)} apply={(ops) => apply(ops)} />}
    </div>
  );
}

/** One alignment guide across the grid (snap off), at an edge or centre of the ghost's grid (spec 3.5). */
function GuideLine({ g, ghost }: { g: Guide; ghost: Ghost }) {
  const b = ghost.box;
  const colW = (b.width - (b.cols - 1) * b.colGap) / b.cols;
  const stepX = colW + b.colGap;
  const stepY = b.rowPx + b.rowGap;
  const pad = b.cellPad ?? 0;
  const h = Math.max(ghost.rect.top + ghost.rect.height + 80, 200);
  if (g.axis === "x") {
    const left = ghost.origin.left + g.at * stepX - (g.kind === "end" ? b.colGap : g.kind === "centre" ? b.colGap / 2 : 0);
    return <div aria-hidden className={`pointer-events-none absolute w-px ${g.page ? "bg-accent" : "bg-accent-ink"}`} style={{ left, top: ghost.origin.top, height: h }} data-guide="x" data-guide-at={g.at} data-guide-page={g.page ? "" : undefined} />;
  }
  const top = ghost.origin.top + g.at * stepY - (g.kind === "end" ? pad : g.kind === "centre" ? pad / 2 : 0);
  return <div aria-hidden className="pointer-events-none absolute h-px bg-accent-ink" style={{ left: ghost.origin.left, top, width: b.width }} data-guide="y" data-guide-at={g.at} />;
}

/** The publish check beside the app name: draws in with `pop` (appears at once with reduced motion). */
function PublishCheck({ reduced }: { reduced: boolean }) {
  const [on, setOn] = useState(true);
  useEffect(() => { const t = window.setTimeout(() => setOn(false), 3000); return () => window.clearTimeout(t); }, []);
  if (!on) return null;
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" role="img" aria-label="Published" className="flex-none text-ok" data-publish-check>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <motion.path d="m7.5 12.4 3 3 6-6.3" fill="none" stroke="var(--bg-hi)" strokeWidth={2.4} strokeLinecap="square" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduced ? { duration: 0 } : { ...springs.pop, delay: GLOW_PEAK_S }} />
    </svg>
  );
}
const GLOW_PEAK_S = 0.12;

function StaticRing() {
  const [on, setOn] = useState(true);
  useEffect(() => { const t = window.setTimeout(() => setOn(false), REDUCED_GLOW_RING_MS); return () => window.clearTimeout(t); }, []);
  return on ? <span aria-hidden className="pointer-events-none absolute inset-[-4px_-6px] outline-2 outline-accent" data-publish-ring /> : null;
}

const pageItem = "flex h-8 cursor-pointer select-none items-center px-2 text-left type-label outline-none data-[disabled]:cursor-default data-[disabled]:opacity-40 data-[highlighted]:bg-bg-sunk touch:h-11";

/**
 * The Pages menu. Radix in a portal (operator bugs 3 and 4): the builder bar clips its overflow for the
 * publish glow, so an in-bar dropdown showed as a sliver and "Add a page" could not be reached.
 */
function PageMenu({ doc, page, apply, onAdd, onLook, onFit, compact = false }: { doc: AppDocument; page: PageDoc; apply(ops: DraftOp[]): void; onAdd(): void; onLook(): void; onFit(): void; compact?: boolean }) {
  const order = orderedPages(doc);
  const i = order.findIndex((p) => p.id === page.id);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {compact ? (
          // Phones (Tristan, 2026-10-19): the same menu behind a 44px glyph, so pages can be added on a phone too.
          <button type="button" aria-label="Pages" title="Pages" className="flex size-11 flex-none cursor-pointer items-center justify-center hover:bg-bg-sunk data-[state=open]:bg-bg-sunk" data-page-menu>
            <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden><path d="M4.5 1.5h7v10h-7ZM2 4v10.5h7" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 4.5v4M6 6.5h4" stroke="currentColor" strokeWidth="1.3" /></svg>
          </button>
        ) : (
          <button type="button" className="flex h-8 flex-none cursor-pointer items-center border border-line-strong px-2 type-label hover:bg-bg-sunk data-[state=open]:bg-bg-sunk" data-page-menu>Pages</button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={8} className="z-50 flex w-56 flex-col border border-line-strong bg-bg-hi p-1 text-fg shadow-window-sm" data-page-menu-content>
          <DropdownMenu.Item className={pageItem} onSelect={onAdd} data-page-add>Add a page</DropdownMenu.Item>
          <DropdownMenu.Item className={pageItem} onSelect={() => { const t = window.prompt("Rename page", page.title)?.trim(); if (t) apply([{ op: "page.update", pageId: page.id, patch: { title: t } }]); }} data-page-rename>Rename</DropdownMenu.Item>
          <DropdownMenu.Item className={pageItem} onSelect={() => apply([{ op: "page.update", pageId: page.id, patch: { inNav: !page.inNav } }])} data-page-nav>{page.inNav ? "Hide from navigation" : "Show in navigation"}</DropdownMenu.Item>
          <DropdownMenu.Item className={pageItem} disabled={i <= 0} onSelect={() => apply([{ op: "page.move", pageId: page.id, index: i - 1 }])} data-page-up>Move up</DropdownMenu.Item>
          <DropdownMenu.Item className={pageItem} disabled={i >= order.length - 1} onSelect={() => apply([{ op: "page.move", pageId: page.id, index: i + 1 }])} data-page-down>Move down</DropdownMenu.Item>
          <DropdownMenu.Item className={pageItem} disabled={doc.app.homePage === page.id} onSelect={() => apply([{ op: "app.update", patch: { homePage: page.id } }])} data-page-home>Make this the home page</DropdownMenu.Item>
          <DropdownMenu.Item className={`${pageItem} text-bad`} disabled={doc.pages.length <= 1} onSelect={() => { if (window.confirm(`Remove the page ${page.title}?`)) apply([{ op: "page.remove", pageId: page.id }]); }} data-page-remove>Remove page</DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={pageItem} onSelect={onFit} data-page-fit>Fit every component to its content</DropdownMenu.Item>
          <DropdownMenu.Item className={pageItem} onSelect={onLook} data-app-look>App look: theme and navigation</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export type { ComponentNode };
