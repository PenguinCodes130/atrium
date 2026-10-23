// The Atrium mark and wordmark (design v4 section 5). One colour by default (--fg for the current
// mode); the lit variant fills only the doorway with --accent (gold), the default in the top bar,
// sign-in, app icons and the app switcher. Never outlined, shadowed or graded. `glow` adds the slow
// door glow (4.8s opacity pulse of a soft gold halo behind the doorway; steady under reduced motion).
import { useId } from "react";
import { MARK_DOORWAY, MARK_HEIGHT, MARK_LEFT_BAND, MARK_RIGHT_BAND, MARK_VIEWBOX, MARK_WIDTH } from "./brand-paths";

/** Inter Tight's cap height as a fraction of the em (same outlines as Inter: 1490 / 2048). */
export const INTER_CAP_HEIGHT = 1490 / 2048;
/** Wordmark rules: cap height 45% of the mark height, gap half the mark height. */
export const WORDMARK_CAP_RATIO = 0.45;
export const WORDMARK_GAP_RATIO = 0.5;
/** Left side bearing of "A" (50 / 2048 em): the gap is measured to the ink. */
export const INTER_A_LSB_EM = 50 / 2048;
/** Advance of "Atrium" in Inter Tight 600 at -0.04em tracking, in em (measured in Chromium). */
export const WORDMARK_TEXT_EM = 2.62;
/** Wordmark tracking (design v4 section 5). */
export const WORDMARK_TRACKING = "-0.04em";

type MarkProps = { height?: number; lit?: boolean; glow?: boolean; title?: string; className?: string };

export function Mark({ height = 24, lit = false, glow = false, title, className }: MarkProps) {
  const width = (height * MARK_WIDTH) / MARK_HEIGHT;
  const fid = `door-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      width={width}
      height={height}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={className}
      data-mark={lit ? "lit" : "default"}
      overflow="visible"
    >
      {lit && glow && (
        <>
          <defs>
            <filter id={fid} x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="46" />
            </filter>
          </defs>
          <path d={MARK_DOORWAY} fill="var(--accent-hi)" filter={`url(#${fid})`} data-door-glow />
        </>
      )}
      <path d={MARK_LEFT_BAND} fill="var(--mark-color, var(--fg))" />
      <path d={MARK_RIGHT_BAND} fill="var(--mark-color, var(--fg))" />
      <path d={MARK_DOORWAY} fill={lit ? "var(--accent)" : "var(--mark-color, var(--fg))"} data-doorway />
    </svg>
  );
}

/**
 * The lit mark plus "Atrium" in HTML text (Inter Tight 600, -0.04em): cap height 45% of the mark
 * height and a gap of half the mark height. Used in the top bar.
 */
export function Wordmark({ height = 24, lit = true, className, label = "Atrium" }: MarkProps & { label?: string }) {
  const fontSize = (WORDMARK_CAP_RATIO * height) / INTER_CAP_HEIGHT;
  return (
    <span className={`inline-flex items-baseline ${className ?? ""}`} style={{ gap: WORDMARK_GAP_RATIO * height - INTER_A_LSB_EM * fontSize }} data-wordmark>
      {/* A replaced element's baseline is its bottom edge, so the mark stands on the text baseline. */}
      <Mark height={height} lit={lit} />
      <span className="font-sans leading-none font-semibold text-fg" style={{ fontSize, letterSpacing: WORDMARK_TRACKING }} data-wordmark-text>
        {label}
      </span>
    </span>
  );
}
