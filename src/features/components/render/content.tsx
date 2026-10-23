"use client";
// Content components (spec 3.1.5). Text is always rendered as text: markup shows as characters.
// Links open only same-app pages or http(s) addresses (new tab, no opener); anything else is inert.
// Images show uploads, or external addresses only when the server signed them (amendment A4.2).
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { motion } from "motion/react";
import type { ComponentNode, RenderContext } from "@/core/contracts";
import { timed, useReducedMotion } from "@/features/shell";
import { text as textOf } from "../bindings";
import { useNodeEnv } from "./context";
import { ICON_PATHS } from "./icons";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };
const str = (v: unknown) => textOf(v);

export function HeadingView({ resolved }: P) {
  const level = resolved.level === 1 || resolved.level === 3 ? resolved.level : 2;
  const Tag = (`h${level}` as "h1" | "h2" | "h3");
  return (
    <Tag data-slot="root" className="atr-heading" data-level={level}>
      {str(resolved.text)}
    </Tag>
  );
}

export function TextView({ resolved }: P) {
  const size = resolved.size === "sm" || resolved.size === "lg" ? resolved.size : "md";
  return (
    <p data-slot="root" className="atr-text" data-size={size} data-muted={resolved.muted === true ? "" : undefined}>
      {str(resolved.text)}
    </p>
  );
}

/** The address an image may load: an upload, or an external address the server signed; otherwise null. */
export function imageSrc(src: string, signed: Record<string, string> | undefined): string | null {
  if (/^\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(src) && !src.includes("..")) return src;
  if (/^https?:\/\//i.test(src)) {
    const s = signed?.[src];
    return s && s.startsWith("/api/img?") ? s : null;
  }
  return null;
}

export function ImageView({ node, resolved, ctx }: P) {
  const { scope } = useNodeEnv();
  const preview = useMediaPreview(node.id);
  const r = preview ? { ...resolved, ...preview } : resolved;
  const src = imageSrc(str(r.src), scope.$signedUrls);
  const height = typeof r.height === "number" ? r.height : 160;
  const alt = str(r.alt);
  if (!src) {
    return (
      <div data-slot="root" className="atr-image atr-image-placeholder" style={{ height }} role="img" aria-label={alt || "Image not available"} data-image-placeholder>
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
          <path d="M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
    );
  }
  const look = readLook(r);
  return (
    <MediaBox
      look={look}
      fit={r.fit === "cover" ? "cover" : "contain"}
      height={height}
      opacity={typeof preview?.opacity === "number" ? preview.opacity : undefined}
      ctx={ctx}
      pages={scope.$pages}
      name={alt || "picture"}
      kind="image"
      media={(style) => <img src={src} alt={alt} style={style} loading="lazy" referrerPolicy="same-origin" draggable={false} data-media-el />}
      large={(style) => <img src={src} alt={alt} style={style} referrerPolicy="same-origin" />}
    />
  );
}

// ---------- media look (media layout spec 3.1, Amendment 8 A8.7) ----------
// Every picture and video prop is drawn inside the component's box with CSS written here: the box and
// its selection outline stay put while the picture turns, flips, tilts, zooms and filters inside it.

export type MediaFilters = { brightness?: number; contrast?: number; saturate?: number; grayscale?: number; sepia?: number; blur?: number };
export type MediaLink = { kind: "none" | "page" | "url" | "enlarge"; pageId?: string; url?: string };
export type MediaLook = {
  rotate: 0 | 90 | 180 | 270;
  flipX: boolean;
  flipY: boolean;
  straighten: number;
  zoom: number;
  focusX: number;
  focusY: number;
  filters: MediaFilters;
  caption: string;
  captionAt: "below" | "over";
  link: MediaLink;
};

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** The look a picture's props ask for, with every value clamped to its range (A8.7). */
export function readLook(p: Record<string, unknown>): MediaLook {
  const rot = p.rotate === 90 || p.rotate === 180 || p.rotate === 270 ? p.rotate : 0;
  const f = (p.filters && typeof p.filters === "object" ? p.filters : {}) as Record<string, unknown>;
  const filters: MediaFilters = {};
  const put = (k: keyof MediaFilters, hi: number) => {
    if (typeof f[k] === "number" && Number.isFinite(f[k])) filters[k] = Math.min(hi, Math.max(0, f[k] as number));
  };
  put("brightness", 200);
  put("contrast", 200);
  put("saturate", 200);
  put("grayscale", 100);
  put("sepia", 100);
  put("blur", 20);
  const l = (p.link && typeof p.link === "object" ? p.link : {}) as Record<string, unknown>;
  const kind = l.kind === "page" || l.kind === "url" || l.kind === "enlarge" ? l.kind : "none";
  return {
    rotate: rot,
    flipX: p.flipX === true,
    flipY: p.flipY === true,
    straighten: num(p.straighten, -45, 45, 0),
    zoom: num(p.zoom, 1, 4, 1),
    focusX: num(p.focusX, 0, 100, 50),
    focusY: num(p.focusY, 0, 100, 50),
    filters,
    caption: typeof p.caption === "string" ? p.caption.slice(0, 300) : "",
    captionAt: p.captionAt === "over" ? "over" : "below",
    link: { kind, ...(typeof l.pageId === "string" ? { pageId: l.pageId } : {}), ...(typeof l.url === "string" ? { url: l.url } : {}) },
  };
}

/** The CSS filter list for a picture's filters, or undefined when none changes the picture. */
export function filterCss(f: MediaFilters): string | undefined {
  const out: string[] = [];
  if (f.brightness !== undefined && f.brightness !== 100) out.push(`brightness(${f.brightness}%)`);
  if (f.contrast !== undefined && f.contrast !== 100) out.push(`contrast(${f.contrast}%)`);
  if (f.saturate !== undefined && f.saturate !== 100) out.push(`saturate(${f.saturate}%)`);
  if (f.grayscale) out.push(`grayscale(${f.grayscale}%)`);
  if (f.sepia) out.push(`sepia(${f.sepia}%)`);
  if (f.blur) out.push(`blur(${f.blur}px)`);
  return out.length ? out.join(" ") : undefined;
}

/**
 * How much a picture tilted by `deg` inside a w by h box must grow so that it still covers the whole box
 * (no empty corners): cos + max(w/h, h/w) sin of the angle. 1 for no tilt or an unknown box.
 */
export function coverScale(deg: number, w: number, h: number): number {
  if (!deg || !(w > 0) || !(h > 0)) return 1;
  const a = (Math.abs(deg) * Math.PI) / 180;
  return Math.cos(a) + Math.max(w / h, h / w) * Math.sin(a);
}

/** Whether a turn lies the picture on its side (its box swaps width and height). */
export const onSide = (rotate: number) => rotate === 90 || rotate === 270;

/**
 * The transform of the picture's holder, centred in the box: straighten in screen space, then the flips,
 * then the quarter turns, then the cover scale. Flips come after the turn, so "Flip across" always
 * mirrors what is on screen.
 */
export function turnTransform(look: Pick<MediaLook, "rotate" | "flipX" | "flipY" | "straighten">, scale = 1): string {
  const parts = ["translate(-50%, -50%)"];
  if (look.straighten) parts.push(`rotate(${look.straighten}deg)`);
  if (look.flipX || look.flipY) parts.push(`scale(${look.flipX ? -1 : 1}, ${look.flipY ? -1 : 1})`);
  if (look.rotate) parts.push(`rotate(${look.rotate}deg)`);
  if (scale !== 1) parts.push(`scale(${Math.round(scale * 10000) / 10000})`);
  return parts.join(" ");
}

/** The style of the picture element itself: fit, focal point, zoom around it, filters. */
export function mediaElementStyle(look: MediaLook, fit: "cover" | "contain", opts: { zoom?: boolean } = {}): CSSProperties {
  const at = `${look.focusX}% ${look.focusY}%`;
  const z = opts.zoom === false ? 1 : look.zoom;
  return {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: fit,
    objectPosition: at,
    ...(z !== 1 ? { transform: `scale(${z})`, transformOrigin: at } : {}),
    ...(filterCss(look.filters) ? { filter: filterCss(look.filters) } : {}),
  };
}

/** The holder's box: the whole frame, or (on its side) the frame's height by its width (container units). */
export function holderStyle(look: MediaLook, scale = 1): CSSProperties {
  const side = onSide(look.rotate);
  return { position: "absolute", left: "50%", top: "50%", width: side ? "100cqh" : "100%", height: side ? "100cqw" : "100%", transform: turnTransform(look, scale) };
}

// Live slider drags (spec 3.1, "shown live on the canvas within 100 ms while dragging"): the inspector puts
// the value being dragged here, every view of that node draws it at once, and the draft is written once
// on release (one undo per drag).
type Preview = Record<string, unknown>;
const previews = new Map<string, Preview>();
const previewListeners = new Set<() => void>();
/** Shows `patch` over a node's props until cleared (null). Builder-only: viewers never call it. */
export function setMediaPreview(nodeId: string, patch: Preview | null): void {
  if (patch) previews.set(nodeId, { ...(previews.get(nodeId) ?? {}), ...patch });
  else previews.delete(nodeId);
  for (const l of previewListeners) l();
}
export function useMediaPreview(nodeId: string): Preview | undefined {
  return useSyncExternalStore(
    (cb) => {
      previewListeners.add(cb);
      return () => previewListeners.delete(cb);
    },
    () => previews.get(nodeId),
    () => undefined,
  );
}

/** A box's size on screen, measured only when `on` (the cover scale needs the box's own ratio). */
function useBoxSize(on: boolean): [RefObject<HTMLElement | null>, { w: number; h: number } | null] {
  const ref = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    const read = () => setSize((s) => (s && s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);
  return [ref, size];
}

const resetButton: CSSProperties = { display: "block", width: "100%", border: 0, padding: 0, margin: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: "inherit", textDecoration: "none" };

/**
 * The box a picture or video is drawn in: the frame (the turned, flipped, tilted, zoomed and filtered
 * picture, clipped to the box), its caption below or over the bottom, and what a click does. Text in a
 * caption over the picture sits on the theme's surface at 92 percent, so it stays readable on any picture.
 */
export function MediaBox({ look, fit, height, opacity, ctx, pages, name, kind, media, large, overlay, rootData }: {
  look: MediaLook;
  fit: "cover" | "contain";
  height: number;
  opacity?: number;
  ctx: RenderContext;
  pages?: { id: string; slug: string; title: string }[];
  name: string;
  kind: "image" | "video";
  media(style: CSSProperties): ReactNode;
  large(style: CSSProperties): ReactNode;
  /** Drawn over the frame as its sibling, not turned with the picture (the video's play button). */
  overlay?: ReactNode;
  rootData?: Record<`data-${string}`, string | undefined>;
}) {
  const tilt = fit === "cover" && look.straighten !== 0;
  const [frameRef, box] = useBoxSize(tilt);
  const scale = tilt && box ? coverScale(look.straighten, box.w, box.h) : 1;
  const [big, setBig] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  // Focus goes back to the picture once the full-screen view has closed (its dialog closes on unmount first).
  const wasBig = useRef(false);
  useEffect(() => {
    if (big) wasBig.current = true;
    else if (wasBig.current) {
      wasBig.current = false;
      trigger.current?.focus();
    }
  }, [big]);
  const interactive = ctx.mode !== "agent-render";
  const edit = ctx.mode === "edit";
  const page = look.link.kind === "page" ? pages?.find((x) => x.id === look.link.pageId) : undefined;
  const url = look.link.kind === "url" && look.link.url && SAFE_LINK.test(look.link.url) ? look.link.url : null;
  const caption = look.caption.trim();
  const over = caption && look.captionAt === "over" ? (
    <p data-media-caption="over" className="atr-media-caption" style={{ position: "absolute", left: 0, right: 0, bottom: 0, margin: 0, padding: "6px 10px", background: "color-mix(in oklab, var(--theme-surface) 92%, transparent)", color: "var(--theme-surface-text)", fontSize: "calc(13px * var(--theme-type-scale, 1))", lineHeight: 1.4, overflowWrap: "anywhere" }}>
      {caption}
    </p>
  ) : null;
  const inner = (
    <>
      <div data-media-holder style={holderStyle(look, scale)}>
        {media(mediaElementStyle(look, fit))}
      </div>
      {over}
    </>
  );
  const frameStyle: CSSProperties = { position: "absolute", inset: 0, overflow: "hidden", containerType: "size" };
  const setFrame = (el: HTMLElement | null) => {
    frameRef.current = el;
    trigger.current = el;
  };
  let frame: ReactNode;
  if (interactive && page) {
    frame = (
      <a ref={setFrame} href={`#${page.slug}`} style={{ ...resetButton, ...frameStyle }} aria-label={`${name}: open ${page.title}`} data-media-frame data-media-link="page" onClick={(e) => { e.preventDefault(); if (!edit) ctx.navigate({ pageId: page.id }); }}>
        {inner}
      </a>
    );
  } else if (interactive && url) {
    frame = (
      <a ref={setFrame} href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" style={{ ...resetButton, ...frameStyle }} aria-label={`${name} (opens in a new tab)`} data-media-frame data-media-link="url" onClick={edit ? (e) => e.preventDefault() : undefined}>
        {inner}
      </a>
    );
  } else if (interactive && look.link.kind === "enlarge") {
    frame = (
      <button ref={setFrame} type="button" style={{ ...resetButton, ...frameStyle, cursor: "zoom-in" }} aria-label={`Enlarge ${name}`} aria-haspopup="dialog" data-media-frame data-media-link="enlarge" onClick={() => { if (!edit) setBig(true); }}>
        {inner}
      </button>
    );
  } else {
    frame = (
      <div ref={setFrame} style={frameStyle} data-media-frame data-media-link={look.link.kind === "page" && !page ? "missing" : undefined}>
        {inner}
      </div>
    );
  }
  return (
    <div data-slot="root" className={`atr-image atr-media${kind === "video" ? " atr-video" : ""}`} style={{ height, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", ...(opacity !== undefined ? { opacity } : {}) }} data-media={kind} data-media-turn={look.rotate || undefined} {...rootData}>
      <div data-media-stage style={{ position: "relative", flex: "1 1 0%", minHeight: 0 }}>
        {frame}
        {overlay}
      </div>
      {caption && look.captionAt === "below" ? (
        <p data-media-caption="below" className="atr-media-caption" style={{ flex: "none", margin: 0, paddingTop: 6, color: "var(--theme-canvas-text)", fontSize: "calc(13px * var(--theme-type-scale, 1))", lineHeight: 1.4, overflowWrap: "anywhere" }}>
          {caption}
        </p>
      ) : null}
      {big ? <Lightbox name={name} onClose={() => setBig(false)}>
        <div style={{ position: "relative", width: "min(1600px, 100%)", height: "100%", containerType: "size" }}>
          <div style={holderStyle(look)}>{large(mediaElementStyle(look, "contain", { zoom: false }))}</div>
        </div>
      </Lightbox> : null}
    </div>
  );
}

/** The full-screen view of Enlarge: a modal dialog (Escape closes it), with no animation for reduced motion. */
function Lightbox({ name, onClose, children }: { name: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={`${name}, enlarged`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100dvh", maxWidth: "none", maxHeight: "none", margin: 0, padding: 16, border: 0, background: "color-mix(in oklab, var(--theme-surface-text) 94%, transparent)", color: "var(--theme-surface)" }}
      data-media-lightbox
    >
      <motion.div initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? { duration: 0 } : timed("fade")} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, width: "100%", height: "100%" }} data-media-lightbox-motion={reduced ? "none" : "fade"}>
        <div style={{ display: "flex", width: "100%", justifyContent: "flex-end", flex: "none" }}>
          <button type="button" autoFocus onClick={onClose} style={{ minHeight: 44, minWidth: 44, padding: "0 16px", border: "1px solid var(--theme-surface)", background: "var(--theme-surface)", color: "var(--theme-surface-text)", font: "inherit", cursor: "pointer" }} data-media-lightbox-close>
            Close
          </button>
        </div>
        <div style={{ flex: "1 1 0%", minHeight: 0, width: "100%", display: "flex", justifyContent: "center" }}>{children}</div>
      </motion.div>
    </dialog>
  );
}

export function IconView({ resolved }: P) {
  const name = str(resolved.name);
  const size = typeof resolved.size === "number" ? resolved.size : 24;
  const label = str(resolved.label);
  const d = ICON_PATHS[name] ?? ICON_PATHS.info!;
  return (
    <span data-slot="root" className="atr-icon" role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}>
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {d.map((p, i) => (
          <path key={i} d={p} />
        ))}
      </svg>
    </span>
  );
}

export const SAFE_LINK = /^https?:\/\/[^\s]+$/i;

export function LinkView({ resolved, ctx }: P) {
  const { scope } = useNodeEnv();
  const label = str(resolved.label) || "Link";
  const pageRef = str(resolved.page);
  if (pageRef) {
    const page = scope.$pages?.find((p) => p.id === pageRef || p.slug === pageRef);
    if (page) {
      return (
        <a
          data-slot="root"
          className="atr-link"
          href={`#${page.slug}`}
          onClick={(e) => {
            e.preventDefault();
            if (ctx.mode !== "edit") ctx.navigate({ pageId: page.id });
          }}
        >
          {label}
        </a>
      );
    }
  }
  const href = str(resolved.href).trim();
  if (href && SAFE_LINK.test(href)) {
    return (
      <a data-slot="root" className="atr-link" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={ctx.mode === "edit" ? (e) => e.preventDefault() : undefined}>
        {label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <span data-slot="root" className="atr-link atr-link-inert" aria-disabled="true" data-inert-link title={href ? "This link was refused: only http and https addresses open." : undefined}>
      {label}
    </span>
  );
}

export function DividerView({ resolved }: P) {
  const s = typeof resolved.spacing === "number" ? resolved.spacing : 8;
  return <hr data-slot="root" className="atr-divider" style={{ marginBlock: s }} />;
}

export function SpacerView({ resolved }: P) {
  return <div data-slot="root" aria-hidden style={{ height: typeof resolved.height === "number" ? resolved.height : 24 }} />;
}

export function ClockView({ resolved }: P) {
  const [now, setNow] = useState<Date | null>(null);
  const seconds = resolved.seconds === true;
  useEffect(() => {
    setNow(new Date());
    const h = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(h);
  }, []);
  const show = resolved.show === "time" || resolved.show === "date" ? resolved.show : "both";
  const hour12 = resolved.hour12 === true;
  const time = now ? now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12 }) : "--:--";
  const date = now ? now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : "";
  return (
    <div data-slot="root" className="atr-clock" role="timer" aria-live="off">
      {show !== "date" ? (
        <time data-slot="time" className="atr-clock-time" dateTime={now?.toISOString()}>
          {time}
        </time>
      ) : null}
      {show !== "time" ? (
        <span data-slot="date" className="atr-clock-date">
          {date}
        </span>
      ) : null}
    </div>
  );
}
