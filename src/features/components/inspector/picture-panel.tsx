"use client";
// The Picture panel (media layout spec 3.1, Amendment 8 A8.7): the Image's and Video's own group, first in
// the inspector. Shape, Fit, quarter turns, flips, Straighten, Zoom and a focal point set on the thumbnail,
// filters with presets, opacity, the frame (corners, border, shadow), a caption and what a click does, all
// as buttons and sliders: none of it writes typed CSS (criterion 12). Sliders and the focal point move the
// canvas while dragging (a preview the renderer draws) and save once on release, so one Undo reverts a drag.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AppDocument, ComponentNode, DraftOp, PropValue, StyleProps } from "@/core/contracts";
import { MediaField } from "@/features/uploads/client";
import { readLook, setMediaPreview, type MediaFilters } from "../render/content";
import { MoreFold } from "./more";
import type { FieldWords } from "./labels";
import { boxForShape, cleanFilters, FILTER_PRESETS, FILTER_SLIDERS, filtersPatch, focalFrom, isWebAddress, lookIsSet, presetOf, RESET_KEYS, rotateBy, SHAPES, shapeRatio, type Shape } from "./media";

type Patch = Partial<Omit<ComponentNode, "id" | "children">>;
const labelCls = "type-label text-fg-2";
const hintCls = "type-caption m-0 text-fg-3";
const chip = "inline-flex min-h-9 items-center justify-center border px-2 type-caption touch:min-h-11 max-sm:min-h-11 disabled:opacity-40";
const chipOn = (on: boolean) => `${chip} ${on ? "border-fg bg-fg text-bg" : "border-line-strong text-fg hover:bg-bg-sunk"}`;
const inputCls = "w-full border border-line-strong bg-bg-hi px-2 py-1.5 type-body text-fg placeholder:text-fg-3 min-h-9 touch:min-h-11 max-sm:min-h-11 disabled:opacity-40";
const linkBtn = "self-start min-h-8 touch:min-h-11 max-sm:min-h-11 type-caption text-accent-ink underline underline-offset-2 hover:text-fg disabled:opacity-40";
/** How long a committed style value (opacity) keeps its preview while the builder fetches the new CSS. */
const STYLE_SETTLE_MS = 2000;
const PROP_SETTLE_MS = 250;

export type PicturePanelProps = {
  node: ComponentNode;
  doc: AppDocument;
  /** A node.update merge patch (null removes a key). */
  onChange(patch: Patch): void;
  /** Raw ops in one batch (shape: the props and the box together, one undo). */
  onOps?(ops: DraftOp[]): void;
  /** The generic field for a prop (Description, the old Height, Loop...), with its data-field wrapper. */
  field(key: string): ReactNode;
  /** The file itself: Upload, Your uploads and "Paste an address". */
  file: ReactNode;
  /** Border width, border colour and shadow, from the Style panel's short set. */
  frame: ReactNode;
  words: Record<string, FieldWords>;
  simple: readonly string[];
};

/** Where a node sits, for the box half of a Shape change. */
function parentOf(doc: AppDocument, id: string): { parentId: string; index: number } | null {
  const walk = (n: ComponentNode): { parentId: string; index: number } | null => {
    const i = (n.children ?? []).findIndex((c) => c.id === id);
    if (i >= 0) return { parentId: n.id, index: i };
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const p of doc.pages) {
    const hit = walk(p.root);
    if (hit) return hit;
  }
  return null;
}

/** The node's box on the canvas: its width (at scale 1), the gap under it and a caption below it. */
function measureBox(nodeId: string): { width: number; extra: number; el: Element } | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(`[data-canvas-root] [data-node="${CSS.escape(nodeId)}"]`);
  if (!el) return null;
  const zoom = Number(document.querySelector("[data-canvas-zoom]")?.getAttribute("data-canvas-zoom")) || 1;
  const cell = el.parentElement?.classList.contains("atr-cell") ? el.parentElement : null;
  const pad = cell ? parseFloat(getComputedStyle(cell).paddingBottom) || 0 : 0;
  const cap = el.querySelector<HTMLElement>('[data-media-caption="below"]');
  return { width: el.getBoundingClientRect().width / zoom, extra: pad + (cap ? cap.offsetHeight : 0), el };
}

/** The file's own size: from the canvas when it has loaded there, otherwise loaded here (3 s at most). */
async function naturalSize(el: Element | null, src: string, kind: "image" | "video"): Promise<{ w: number; h: number } | null> {
  const img = el?.querySelector<HTMLImageElement>("img[data-media-el]");
  if (img && img.naturalWidth > 0) return { w: img.naturalWidth, h: img.naturalHeight };
  const vid = el?.querySelector<HTMLVideoElement>("video[data-media-el]");
  if (vid && vid.videoWidth > 0) return { w: vid.videoWidth, h: vid.videoHeight };
  return new Promise((resolve) => {
    const done = (v: { w: number; h: number } | null) => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => resolve(null), 3000);
    if (kind === "video") {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => done(v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null);
      v.onerror = () => done(null);
      v.src = src;
    } else {
      const i = new Image();
      i.onload = () => done(i.naturalWidth > 0 ? { w: i.naturalWidth, h: i.naturalHeight } : null);
      i.onerror = () => done(null);
      i.src = src;
    }
  });
}

/**
 * A slider that previews on the canvas while it moves and saves once when it is let go (pointer up, or the
 * browser's change event for keys), so one drag is one undo.
 */
function LiveSlider({ name, label, value, min, max, step, unit, disabled, onPreview, onCommit, format }: { name: string; label: string; value: number; min: number; max: number; step: number; unit: string; disabled?: boolean; onPreview(v: number): void; onCommit(v: number): void; format?(v: number): string }) {
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef({ draft, value, onCommit });
  latest.current = { draft, value, onCommit };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The native change event fires when a drag ends and after each key step (React's onChange is "input").
    const commit = () => {
      const { draft: d, value: v, onCommit: c } = latest.current;
      if (d !== null && d !== v) c(d);
      setDraft(null);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, []);
  const shown = draft ?? value;
  return (
    <div className="flex flex-col gap-1" data-media-slider-field={name}>
      <label htmlFor={id} className={`${labelCls} flex items-center justify-between`}>
        <span>{label}</span>
        <span className="font-mono text-[12px] text-fg" data-media-readout={name}>{format ? format(shown) : `${shown}${unit}`}</span>
      </label>
      <input
        ref={ref}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDraft(v);
          onPreview(v);
        }}
        className="h-9 w-full accent-[var(--accent)] touch:h-11 max-sm:h-11"
        data-media-slider={name}
      />
    </div>
  );
}

/** The focal point: click or drag on the thumbnail (or use the arrow keys on it); saved on release. */
function FocalPoint({ src, kind, poster, x, y, disabled, onPreview, onCommit }: { src: string | undefined; kind: "image" | "video"; poster?: string; x: number; y: number; disabled?: boolean; onPreview(v: { focusX: number; focusY: number }): void; onCommit(v: { focusX: number; focusY: number }): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ focusX: number; focusY: number } | null>(null);
  const cur = draft ?? { focusX: x, focusY: y };
  const at = (e: { clientX: number; clientY: number }) => focalFrom(e.clientX, e.clientY, box.current!.getBoundingClientRect());
  const move = (v: { focusX: number; focusY: number }) => {
    setDraft(v);
    onPreview(v);
  };
  const finish = (v: { focusX: number; focusY: number } | null) => {
    if (v && (v.focusX !== x || v.focusY !== y)) onCommit(v);
    setDraft(null);
  };
  const still = poster ?? src;
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        ref={box}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Focal point"
        aria-valuetext={`${cur.focusX} percent across, ${cur.focusY} percent down`}
        aria-valuenow={cur.focusX}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-disabled={disabled || undefined}
        className={`relative inline-block max-w-full touch-none select-none border border-line-strong bg-bg-sunk ${disabled ? "opacity-40" : "cursor-crosshair"}`}
        onPointerDown={(e) => {
          if (disabled || !box.current) return;
          e.preventDefault();
          box.current.setPointerCapture?.(e.pointerId);
          box.current.focus();
          move(at(e));
        }}
        onPointerMove={(e) => {
          if (draft && box.current?.hasPointerCapture?.(e.pointerId)) move(at(e));
        }}
        onPointerUp={(e) => {
          if (!draft) return;
          finish(at(e));
        }}
        onKeyDown={(e) => {
          const d: Record<string, [number, number]> = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
          const s = d[e.key];
          if (!s || disabled) return;
          e.preventDefault();
          e.stopPropagation();
          move({ focusX: Math.min(100, Math.max(0, cur.focusX + s[0])), focusY: Math.min(100, Math.max(0, cur.focusY + s[1])) });
        }}
        onKeyUp={(e) => {
          if (draft && e.key.startsWith("Arrow")) finish(draft);
        }}
        data-media-focal
      >
        {still && (kind === "image" || poster) ? (
          <img src={still} alt="" draggable={false} className="pointer-events-none block h-auto max-h-40 w-auto max-w-full" data-media-focal-thumb />
        ) : still ? (
          <video src={still} muted playsInline preload="auto" className="pointer-events-none block h-auto max-h-40 w-auto max-w-full" data-media-focal-thumb />
        ) : (
          <div className="h-24 w-40" />
        )}
        <span aria-hidden className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-accent-ink shadow-[0_0_0_1px_var(--fg)]" style={{ left: `${cur.focusX}%`, top: `${cur.focusY}%` }} data-media-focal-mark={`${cur.focusX},${cur.focusY}`} />
      </div>
    </div>
  );
}

const CORNERS: { id: string; label: string; value: string | number | undefined }[] = [
  { id: "theme", label: "Theme", value: undefined },
  { id: "square", label: "Square", value: 0 },
  { id: "rounded", label: "Rounded", value: 8 },
  { id: "round", label: "Round", value: 16 },
  { id: "circle", label: "Circle", value: "50%" },
];

export function PicturePanel({ node, doc, onChange, onOps, field, file, frame, words, simple }: PicturePanelProps) {
  const kind = node.type === "video" ? "video" : "image";
  const p = node.props as Record<string, unknown>;
  const look = readLook(p);
  const src = typeof p.src === "string" && p.src ? p.src : undefined;
  const poster = typeof p.poster === "string" && p.poster ? p.poster : undefined;
  const has = !!src;
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false);
  const [urlDraft, setUrlDraft] = useState(look.link.url ?? "");
  const [urlError, setUrlError] = useState<string | null>(null);
  useEffect(() => setUrlDraft(look.link.url ?? ""), [node.id, look.link.url]);
  useEffect(() => () => setMediaPreview(node.id, null), [node.id]);
  const rootStyle = ((node.overrideTheme ? node.style?.root : undefined) ?? {}) as StyleProps;
  const w = (k: string) => words[k] ?? { label: k, hint: "" };

  const setProps = (props: Record<string, PropValue | null>) => onChange({ props } as unknown as Patch);
  const preview = (patch: Record<string, unknown>) => {
    if (settle.current) clearTimeout(settle.current);
    setMediaPreview(node.id, patch);
  };
  const clearPreviewSoon = (ms = PROP_SETTLE_MS) => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => setMediaPreview(node.id, null), ms);
  };
  const commit = (props: Record<string, PropValue | null>) => {
    setProps(props);
    clearPreviewSoon();
  };
  const stylePatch = (style: Partial<Record<keyof StyleProps, unknown>>): Patch => ({ overrideTheme: true, style: { root: Object.fromEntries(Object.entries(style).map(([k, v]) => [k, v === undefined ? null : v])) } } as unknown as Patch);

  /** Shape: the props and, with a ratio, the picture height and the box height in one batch (one undo). */
  const applyShape = async (shape: Shape, more: { props?: Record<string, PropValue | null>; patch?: Patch } = {}) => {
    const rotate = more.props && "rotate" in more.props ? more.props.rotate : p.rotate;
    const props: Record<string, PropValue | null> = { shape, ...(more.props ?? {}) };
    const m = measureBox(node.id);
    setBusy(true);
    const natural = shape === "original" && src ? await naturalSize(m?.el ?? null, src, kind) : null;
    setBusy(false);
    const ratio = shapeRatio(shape, natural, rotate);
    const ops: DraftOp[] = [];
    let slotOp: DraftOp | null = null;
    if (ratio && m) {
      const b = boxForShape(m.width, ratio, m.extra);
      props.height = b.height;
      const at = parentOf(doc, node.id);
      if (node.slot && at) slotOp = { op: "node.move", nodeId: node.id, parentId: at.parentId, index: at.index, slot: { ...node.slot, h: b.rows } };
    }
    ops.push({ op: "node.update", nodeId: node.id, patch: { ...(more.patch ?? {}), props } as never });
    if (slotOp) ops.push(slotOp);
    if (onOps) onOps(ops);
    else onChange({ ...(more.patch ?? {}), props } as unknown as Patch);
  };

  const rotate = (dir: "left" | "right") => {
    const next = rotateBy(p.rotate, dir, p.flipX, p.flipY);
    const props = { rotate: next === 0 ? null : next };
    // With Original, a picture on its side swaps the box's shape too (criterion 1).
    if (p.shape === "original") void applyShape("original", { props });
    else setProps(props);
  };

  const control = (key: string): ReactNode => {
    const wd = w(key);
    const label = <span className={labelCls}>{wd.label}</span>;
    const hint = wd.hint ? <p className={hintCls} data-field-hint>{wd.hint}</p> : null;
    switch (key) {
      case "src":
        return null; // drawn first, above everything
      case "shape": {
        const cur = typeof p.shape === "string" ? p.shape : "fill";
        return (
          <div key={key} className="flex flex-col gap-1" data-field="shape">
            {label}
            <div role="radiogroup" aria-label={wd.label} className="flex flex-wrap gap-1">
              {SHAPES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={cur === s} className={chipOn(cur === s)} disabled={busy} onClick={() => void applyShape(s)} data-media-shape={s}>
                  {wd.options?.[s] ?? s}
                </button>
              ))}
            </div>
            {hint}
          </div>
        );
      }
      case "fit": {
        const cur = p.fit === "cover" ? "cover" : "contain";
        return (
          <div key={key} className="flex flex-col gap-1" data-field="fit">
            {label}
            <div role="radiogroup" aria-label={wd.label} className="flex flex-wrap gap-1">
              {(["contain", "cover"] as const).map((f) => (
                <button key={f} type="button" role="radio" aria-checked={cur === f} className={chipOn(cur === f)} onClick={() => setProps({ fit: f })} data-media-fit={f}>
                  {wd.options?.[f] ?? f}
                </button>
              ))}
            </div>
            {hint}
          </div>
        );
      }
      case "rotate":
        return (
          <div key={key} className="flex flex-col gap-1" data-field="rotate">
            <span className={`${labelCls} flex items-center justify-between`}>
              {wd.label}
              <span className="font-mono text-[12px] text-fg" data-media-readout="rotate">{look.rotate}°</span>
            </span>
            <div className="flex flex-wrap gap-1">
              <button type="button" className={chipOn(false)} onClick={() => rotate("left")} disabled={busy} data-media-rotate="left">
                <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden className="mr-1"><path d="M4 2.5H2v2M2.3 4.4A4 4 0 1 1 2.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
                Rotate left
              </button>
              <button type="button" className={chipOn(false)} onClick={() => rotate("right")} disabled={busy} data-media-rotate="right">
                Rotate right
                <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden className="ml-1"><path d="M8 2.5h2v2M9.7 4.4A4 4 0 1 0 9.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
              </button>
            </div>
            {hint}
          </div>
        );
      case "flipX":
      case "flipY": {
        const on = p[key] === true;
        return (
          <div key={key} className="flex flex-col gap-1" data-field={key}>
            <button type="button" aria-pressed={on} className={`${chipOn(on)} self-start`} onClick={() => setProps({ [key]: on ? null : true })} data-media-flip={key === "flipX" ? "across" : "down"}>
              {wd.label}
            </button>
            {hint}
          </div>
        );
      }
      case "straighten":
        return (
          <div key={key} className="flex flex-col gap-1" data-field="straighten">
            <LiveSlider name="straighten" label={wd.label} value={look.straighten} min={-45} max={45} step={1} unit="°" onPreview={(v) => preview({ straighten: v })} onCommit={(v) => commit({ straighten: v === 0 ? null : v })} />
            {hint}
          </div>
        );
      case "zoom":
        return (
          <div key={key} className="flex flex-col gap-1" data-field="zoom">
            <LiveSlider name="zoom" label={wd.label} value={Math.round(look.zoom * 100)} min={100} max={400} step={5} unit="%" onPreview={(v) => preview({ zoom: v / 100 })} onCommit={(v) => commit({ zoom: v === 100 ? null : v / 100 })} />
            {hint}
          </div>
        );
      case "focusX":
        return (
          <div key={key} className="flex flex-col gap-1" data-fields="focusX focusY">
            <span className={labelCls}>{wd.label} and {w("focusY").label.toLowerCase()}</span>
            <FocalPoint src={src} kind={kind} poster={poster} disabled={!has} x={look.focusX} y={look.focusY} onPreview={(v) => preview(v)} onCommit={(v) => commit({ focusX: v.focusX === 50 ? null : v.focusX, focusY: v.focusY === 50 ? null : v.focusY })} />
            <p className="type-caption m-0 font-mono text-fg-2" data-media-readout="focus">
              {w("focusX").label}: {look.focusX}% · {w("focusY").label}: {look.focusY}%
            </p>
            {hint}
            <p className={hintCls} data-field-hint>{w("focusY").hint}</p>
          </div>
        );
      case "focusY":
        return null; // drawn with focusX
      case "filters": {
        const f = cleanFilters(look.filters);
        const cur = presetOf(f);
        return (
          <div key={key} className="flex flex-col gap-2" data-field="filters">
            {label}
            <div role="radiogroup" aria-label="Filter presets" className="flex flex-wrap gap-1">
              {FILTER_PRESETS.map((pr) => (
                <button key={pr.id} type="button" role="radio" aria-checked={cur === pr.id} className={chipOn(cur === pr.id)} onClick={() => setProps({ filters: filtersPatch(pr.filters) })} data-media-preset={pr.id}>
                  {pr.label}
                </button>
              ))}
            </div>
            {FILTER_SLIDERS.map((s) => (
              <LiveSlider
                key={s.key}
                name={s.key}
                label={s.label}
                value={f[s.key] ?? s.none}
                min={s.min}
                max={s.max}
                step={s.step}
                unit={s.unit}
                onPreview={(v) => preview({ filters: { ...f, [s.key]: v } })}
                onCommit={(v) => commit({ filters: filtersPatch({ ...f, [s.key]: v } as MediaFilters) })}
              />
            ))}
            {hint}
          </div>
        );
      }
      case "caption": {
        const pos = !look.caption && p.captionAt === undefined ? "none" : look.captionAt;
        return (
          <div key={key} className="flex flex-col gap-1" data-field="caption">
            <label className={labelCls} htmlFor={`cap-${node.id}`}>{wd.label}</label>
            <textarea id={`cap-${node.id}`} rows={2} maxLength={300} className={inputCls} value={look.caption} placeholder="A few words about it" onChange={(e) => setProps({ caption: e.target.value ? e.target.value : null })} data-media-caption-text />
            {hint}
            <div className="flex flex-col gap-1" data-field="captionAt">
              <span className={labelCls}>{w("captionAt").label}</span>
              <div role="radiogroup" aria-label={w("captionAt").label} className="flex flex-wrap gap-1">
                {(["none", "below", "over"] as const).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={pos === c} className={chipOn(pos === c)} onClick={() => setProps(c === "none" ? { caption: null, captionAt: null } : { captionAt: c })} data-media-caption-at={c}>
                    {c === "none" ? "None" : w("captionAt").options?.[c] ?? c}
                  </button>
                ))}
              </div>
              <p className={hintCls} data-field-hint>{w("captionAt").hint}</p>
            </div>
          </div>
        );
      }
      case "captionAt":
        return null; // drawn with caption
      case "link": {
        const k = look.link.kind;
        const missing = k === "page" && !doc.pages.some((x) => x.id === look.link.pageId);
        const setLink = (v: { kind: string; pageId?: string; url?: string } | null) => setProps({ link: v as PropValue | null });
        return (
          <div key={key} className="flex flex-col gap-1" data-field="link">
            <label className={labelCls} htmlFor={`link-${node.id}`}>{wd.label}</label>
            <select
              id={`link-${node.id}`}
              className={inputCls}
              value={k}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "none") setLink(null);
                else if (v === "enlarge") setLink({ kind: "enlarge", pageId: undefined, url: undefined });
                else if (v === "page") {
                  const first = doc.pages[0];
                  if (first) setLink({ kind: "page", pageId: first.id });
                } else {
                  setUrlDraft(look.link.url ?? "https://");
                  setLink(isWebAddress(look.link.url ?? "") ? { kind: "url", url: look.link.url } : { kind: "url" });
                }
              }}
              data-media-link-kind
            >
              {(["none", "page", "url", "enlarge"] as const).map((o) => (
                <option key={o} value={o}>{wd.options?.[o] ?? o}</option>
              ))}
            </select>
            {k === "page" ? (
              <>
                <select aria-label="Page to open" className={inputCls} value={missing ? "" : look.link.pageId} onChange={(e) => setLink({ kind: "page", pageId: e.target.value })} data-media-link-page>
                  {missing ? <option value="">Choose a page</option> : null}
                  {doc.pages.map((pg) => (
                    <option key={pg.id} value={pg.id}>{pg.title}</option>
                  ))}
                </select>
                {missing ? <p role="alert" className="type-caption m-0 text-[color:var(--bad)]" data-media-link-missing>That page no longer exists</p> : null}
              </>
            ) : null}
            {k === "url" ? (
              <>
                <input
                  aria-label="Address to open"
                  className={inputCls}
                  value={urlDraft}
                  placeholder="https://example.org"
                  aria-invalid={urlError ? true : undefined}
                  onChange={(e) => {
                    setUrlDraft(e.target.value);
                    setUrlError(null);
                  }}
                  onBlur={() => {
                    const v = urlDraft.trim();
                    if (!v || v === "https://") return setUrlError(null);
                    if (!isWebAddress(v)) return setUrlError("Only http and https addresses open.");
                    if (v !== look.link.url) setLink({ kind: "url", url: v });
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  data-media-link-url
                />
                {urlError ? <p role="alert" className="type-caption m-0 text-[color:var(--bad)]" data-media-link-error>{urlError}</p> : <p className={hintCls}>Opens in a new tab</p>}
              </>
            ) : null}
            {hint}
          </div>
        );
      }
      case "poster":
        return (
          <div key={key} className="flex flex-col gap-1" data-field="poster">
            <MediaField value={poster} accept="image" label={wd.label} hint={wd.hint} onChange={(path) => setProps({ poster: path && path.startsWith("/uploads/") ? path : null })} />
            {poster ? (
              <button type="button" className={linkBtn} onClick={() => setProps({ poster: null })} data-media-poster-remove>
                Remove the cover picture
              </button>
            ) : null}
          </div>
        );
      case "startAt":
        return (
          <div key={key} className="flex flex-col gap-1" data-field="startAt">
            <label className={labelCls} htmlFor={`start-${node.id}`}>{wd.label}</label>
            <input id={`start-${node.id}`} type="number" min={0} max={36000} step={0.5} inputMode="decimal" className={inputCls} value={typeof p.startAt === "number" ? p.startAt : ""} placeholder="0" onChange={(e) => {
              const n = Number(e.target.value);
              setProps({ startAt: e.target.value === "" || !Number.isFinite(n) || n <= 0 ? null : Math.min(36000, n) });
            }} data-media-start />
            {hint}
          </div>
        );
      default:
        return <div key={key}>{field(key)}</div>;
    }
  };

  const keys = Object.keys(words);
  const simpleKeys = simple.filter((k) => k !== "src");
  const moreKeys = keys.filter((k) => !simple.includes(k));
  const resetOn = lookIsSet(p);
  const opacity = typeof rootStyle.opacity === "number" ? rootStyle.opacity : 1;
  const corners = CORNERS.find((c) => c.value === rootStyle.borderRadius) ?? (rootStyle.borderRadius === undefined ? CORNERS[0] : null);
  const transformKeys = new Set(["rotate", "flipX", "flipY", "straighten", "zoom", "focusX"]);
  const before = simpleKeys.filter((k) => ["alt", "shape", "fit"].includes(k));
  const turns = simpleKeys.filter((k) => transformKeys.has(k));
  const after = simpleKeys.filter((k) => !before.includes(k) && !turns.includes(k) && k !== "focusY" && k !== "captionAt");

  const body = (
    <>
      {before.map(control)}
      {turns.length ? (
        <div className="flex flex-col gap-3" data-media-turns>
          {turns.filter((k) => k === "rotate").map(control)}
          <div className="flex flex-wrap gap-x-3 gap-y-2">{turns.filter((k) => k === "flipX" || k === "flipY").map(control)}</div>
          {turns.filter((k) => k === "straighten" || k === "zoom" || k === "focusX").map(control)}
        </div>
      ) : null}
      <button
        type="button"
        className={`${chipOn(false)} self-start`}
        disabled={!resetOn}
        onClick={() => setProps(Object.fromEntries(RESET_KEYS.map((k) => [k, null])))}
        data-media-reset
      >
        Reset turn, flips, zoom, focal point and filters
      </button>
      {after.filter((k) => k === "filters").map(control)}
      <div className="flex flex-col gap-1" data-media-opacity>
        <LiveSlider
          name="opacity"
          label="Opacity"
          value={Math.round(opacity * 100)}
          min={0}
          max={100}
          step={5}
          unit="%"
          onPreview={(v) => preview({ opacity: v / 100 })}
          onCommit={(v) => {
            onChange(stylePatch({ opacity: v === 100 ? undefined : v / 100 }));
            clearPreviewSoon(STYLE_SETTLE_MS);
          }}
        />
        <p className={hintCls}>How see-through the {kind === "video" ? "video" : "picture"} is</p>
      </div>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" data-media-frame-controls>
        <legend className={`${labelCls} mb-1`}>Frame</legend>
        <div className="flex flex-col gap-1" data-media-corners>
          <span className={labelCls}>Corners</span>
          <div role="radiogroup" aria-label="Corners" className="flex flex-wrap gap-1">
            {CORNERS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={corners?.id === c.id}
                className={chipOn(corners?.id === c.id)}
                onClick={() => {
                  const patch = stylePatch({ borderRadius: c.value });
                  // A circle needs a square box.
                  if (c.id === "circle" && p.shape !== "1:1") void applyShape("1:1", { patch });
                  else onChange(patch);
                }}
                data-media-corner={c.id}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        {frame}
        <p className={hintCls}>The frame turns on Customise the look under Style; nothing else there changes.</p>
      </fieldset>
      {after.filter((k) => k !== "filters").map(control)}
    </>
  );

  return (
    <div className="flex flex-col gap-4" data-picture-panel={kind}>
      {file}
      {has ? body : (
        <>
          <p className="type-caption m-0 text-fg-2" data-media-needs-file>Add a {kind === "video" ? "video" : "picture"} first</p>
          <fieldset disabled className="m-0 flex flex-col gap-4 border-0 p-0 opacity-60" data-media-disabled>{body}</fieldset>
        </>
      )}
      {moreKeys.length ? (
        <MoreFold group="content" count={moreKeys.filter((k) => p[k] !== undefined && p[k] !== null).length}>
          {moreKeys.filter((k) => k !== "focusY" && k !== "captionAt").map(control)}
        </MoreFold>
      ) : null}
    </div>
  );
}
