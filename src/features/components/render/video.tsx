"use client";
// Video component (builder ease spec 3.1, Amendment 7 A7.2; media layout spec 3.1, Amendment 8 A8.7): an
// uploaded MP4 or WebM file, muted, looping and playing on its own by default, drawn in the same box as a
// picture (shape, turn, flip, tilt, zoom, focal point, filters, caption, click action). Fit defaults to
// Show whole, like pictures. A Cover picture shows until it first plays (and stays for reduced motion).
// Sound only plays when controls are shown (browsers block sound that starts on its own). Reduced
// motion: a video set to play on its own stays paused on its first frame (or cover) with a play button.
// Only this instance's /uploads/ paths load; a guest gets the file only when the app's published version
// uses it (the /uploads/ route checks). Agent renders never play.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ComponentNode, RenderContext } from "@/core/contracts";
import { prefersReducedMotionNow, useReducedMotion } from "@/features/shell";
import { text as textOf } from "../bindings";
import { MediaBox, readLook, useMediaPreview } from "./content";
import { useNodeEnv } from "./context";

type P = { node: ComponentNode; resolved: Record<string, unknown>; ctx: RenderContext };

/** The address a video (or its cover picture) may load: an upload on this instance, otherwise null. */
export function videoSrc(src: unknown): string | null {
  const s = textOf(src);
  return /^\/uploads\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(s) && !s.includes("..") ? s : null;
}

const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

export function VideoView({ node, resolved, ctx }: P) {
  const { scope } = useNodeEnv();
  const preview = useMediaPreview(node.id);
  const r = preview ? { ...resolved, ...preview } : resolved;
  const src = videoSrc(r.src);
  const poster = videoSrc(r.poster);
  const startAt = typeof r.startAt === "number" && Number.isFinite(r.startAt) ? Math.min(36000, Math.max(0, r.startAt)) : 0;
  const height = typeof r.height === "number" ? r.height : 200;
  const alt = textOf(r.alt);
  const loop = flag(r.loop, true);
  const autoplay = flag(r.autoplay, true) && ctx.mode !== "agent-render";
  const controls = flag(r.controls, false);
  const muted = !(controls && flag(r.sound, false));
  const reduced = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  // The cover shows until the video first plays (seeking would hide a native poster, so it is drawn here).
  const [started, setStarted] = useState(false);

  const toStart = (el: HTMLVideoElement) => {
    if (startAt > 0 && el.currentTime < startAt) {
      try {
        el.currentTime = startAt;
      } catch {
        /* not seekable yet: plays from the beginning */
      }
    }
  };
  // Autoplay is started here rather than with the attribute: React does not write `muted` into server
  // HTML, and a browser refuses to start an unmuted video on its own.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
    if (autoplay && !(reduced || prefersReducedMotionNow())) {
      toStart(el);
      void el.play().catch(() => setPlaying(false));
    } else if (autoplay) {
      el.pause();
      if (!started && el.currentTime > 0) el.currentTime = 0;
    }
  }, [autoplay, reduced, muted, src, startAt]);

  if (!src) {
    return (
      <div data-slot="root" className="atr-image atr-image-placeholder atr-video" style={{ height }} role="img" aria-label={alt || "Video not available"} data-video-placeholder>
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
          <path d="M3 6h13v12H3zM16 10l5-3v10l-5-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
    );
  }

  const play = () => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
    toStart(el);
    void el.play().catch(() => setPlaying(false));
  };
  const look = readLook(r);
  // Show whole unless this video itself asks for Fill and crop (the catalogue default is not read here).
  const fit = (preview?.fit ?? node.props.fit) === "cover" ? "cover" : "contain";
  const showPlay = !playing && !controls;
  const linked = look.link.kind !== "none";

  return (
    <MediaBox
      look={look}
      fit={fit}
      height={height}
      opacity={typeof preview?.opacity === "number" ? preview.opacity : undefined}
      ctx={ctx}
      pages={scope.$pages}
      name={alt || "video"}
      kind="video"
      rootData={{ "data-video": playing ? "playing" : "paused" }}
      media={(style: CSSProperties) => (
        <>
          <video
            ref={ref}
            src={src}
            aria-label={alt || undefined}
            loop={loop}
            controls={controls}
            playsInline
            muted={muted}
            preload="auto"
            poster={poster ?? undefined}
            disablePictureInPicture={!controls}
            style={style}
            onPlay={() => { setPlaying(true); setStarted(true); }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onClick={!controls && !linked && playing && ctx.mode !== "edit" ? () => ref.current?.pause() : undefined}
            data-video-el
            data-media-el
          />
          {poster && !started ? <img src={poster} alt="" aria-hidden style={{ ...style, position: "absolute", inset: 0, pointerEvents: "none" }} data-video-poster /> : null}
        </>
      )}
      large={(style: CSSProperties) => <video src={src} aria-label={alt || undefined} controls autoPlay={!reduced} muted playsInline loop={loop} poster={poster ?? undefined} style={style} />}
      overlay={showPlay ? (
        <button
          type="button"
          onClick={play}
          aria-label={alt ? `Play ${alt}` : "Play video"}
          data-video-play
          style={{ position: "absolute", inset: 0, margin: "auto", width: 56, height: 56, display: "grid", placeItems: "center", border: "1px solid var(--theme-line)", borderRadius: "999px", background: "color-mix(in oklab, var(--theme-surface) 80%, transparent)", color: "var(--theme-surface-text)", cursor: "pointer" }}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
            <path d="M8 5v14l11-7z" fill="currentColor" />
          </svg>
        </button>
      ) : null}
    />
  );
}
