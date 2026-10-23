"use client";
// Windows (design v4 "Windows"): the core shell surface. A 28px title bar (titlebar fill, mono label
// type, padding 0 10px) with the 10px door glyph on the left (gold when live or active, paper at 0.6
// otherwise), the title as a path and an optional status on the right; then a body on the raised paper
// colour with a 1px strong border and the hard window shadow. Tones: paper (default), ink (code and
// terminals) and sky (guest-facing previews). A window never casts a shadow inside another window
// (globals.css flattens nested ones). Inside a <Glow>, the title bar flashes gold on success.
import { createElement, useContext, useLayoutEffect, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from "react";
import { motion } from "motion/react";
import { durations, glowKeyframes } from "./motion";
import { GlowContext } from "./glow-context";
import { doorLit, useSweepPass } from "./sweep-context";

export type WindowTone = "paper" | "ink" | "sky";

/**
 * The logo's doorway as a 10px glyph: gold when the window is live or active, paper at 0.6 otherwise.
 * The gold doorway is a layer over the paper one, so lighting it (as the opening sweep passes) only
 * animates opacity.
 */
export function DoorGlyph({ lit = true, size = 10, className }: { lit?: boolean; size?: number; className?: string }) {
  const d = "M1 13V6a5 5 0 0 1 10 0v7Z";
  return (
    <svg viewBox="0 0 12 14" width={(size * 12) / 14} height={size} aria-hidden className={`flex-none ${className ?? ""}`} data-door={lit ? "lit" : "dim"}>
      <path d={d} fill="var(--paper)" fillOpacity={0.6} />
      <path d={d} fill="var(--accent)" style={{ opacity: lit ? 1 : 0, transition: "opacity 240ms cubic-bezier(0.2, 0, 0, 1)" }} data-door-gold />
    </svg>
  );
}

/** A status dot (6px circle) with a word: shape and a word as well as colour. */
export function LiveDot({ label = "live", tone = "ok", pulse = true }: { label?: ReactNode; tone?: "ok" | "warn" | "bad" | "gold"; pulse?: boolean }) {
  const bg = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", gold: "bg-accent" }[tone];
  return (
    <span className="inline-flex items-center gap-1.5" data-live-dot={tone}>
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${bg}${pulse ? " live-dot" : ""}`} />
      {label}
    </span>
  );
}

/** A mono label on an ink block, like a system tag. At most one per window or section. */
export function Tag({ children, className, tone = "ink" }: { children: ReactNode; className?: string; tone?: "ink" | "paper" | "gold" }) {
  const toneCls = tone === "ink" ? "bg-fg text-bg" : tone === "gold" ? "bg-accent text-accent-fg" : "bg-bg-hi text-fg border border-line-strong";
  return (
    <span className={`inline-block w-fit self-start px-1.5 py-0.5 font-mono text-[12px] leading-none tracking-[-0.01em] ${toneCls} ${className ?? ""}`} data-tag>
      {children}
    </span>
  );
}

const toneBody: Record<WindowTone, string> = {
  paper: "bg-bg-hi text-fg",
  ink: "bg-[#1d1a15] text-[#f3efe4]",
  sky: "bg-sky text-fg",
};

export type WindowProps<T extends ElementType = "section"> = {
  as?: T;
  /** The title as a path, for example `homelab / overview` or `integrations / proxmox`. */
  title: ReactNode;
  /** Right side of the title bar: a live dot with a word, a count, or nothing. */
  status?: ReactNode;
  tone?: WindowTone;
  /** Door glyph gold (live or active). Default true. */
  live?: boolean;
  /** Small windows under 280px, menus, tooltips: the 3px shadow. */
  small?: boolean;
  /** No shadow (flat, for example inside a sheet). */
  flat?: boolean;
  bodyClassName?: string;
  /** Pass false to render the children straight into the window (no padded body). */
  padded?: boolean;
  children?: ReactNode;
  className?: string;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "title" | "children" | "className">;

export function Window<T extends ElementType = "section">({ as, title, status, tone = "paper", live = true, small = false, flat = false, bodyClassName, padded = true, children, className, ...rest }: WindowProps<T>) {
  // Ink windows (code, terminals) cast the gold shadow in both modes: lit from behind.
  const shadow = flat ? "" : tone === "ink" ? (small ? " shadow-window-gold-sm" : " shadow-window-gold") : small ? " shadow-window-sm" : " shadow-window";
  return createElement(
    as ?? "section",
    {
      "data-window": tone,
      className: `relative flex min-w-0 flex-col border ${tone === "ink" ? "border-[rgba(243,239,228,0.25)]" : "border-line-strong"} ${toneBody[tone]}${shadow} ${className ?? ""}`,
      ...rest,
    },
    <TitleBar title={title} status={status} tone={tone} live={live} />,
    padded ? <div className={`relative min-h-0 flex-1 p-(--window-pad) ${bodyClassName ?? ""}`} data-window-body>{children}</div> : children,
  );
}

/** The 28px title bar. Exported for sheets and dialogs that draw their own frame. */
export function TitleBar({ title, status, tone = "paper", live = true, id }: { title: ReactNode; status?: ReactNode; tone?: WindowTone; live?: boolean; id?: string }) {
  const glow = useContext(GlowContext);
  useLayoutEffect(() => glow?.registerWindow(), [glow]);
  const play = glow?.play ?? 0;
  const pass = useSweepPass();
  const ink = tone === "ink";
  const bar = ink ? "border-b border-[rgba(243,239,228,0.2)] bg-[#2a261f] text-[rgba(243,239,228,0.85)]" : "bg-titlebar text-titlebar-fg";
  return (
    <div id={id} className={`relative flex h-(--titlebar-height) flex-none items-center gap-2 overflow-hidden px-2.5 type-label ${bar}`} data-titlebar>
      <DoorGlyph lit={doorLit(live, pass)} />
      <span className="min-w-0 flex-1 truncate" data-window-title>
        {title}
      </span>
      {status !== undefined && status !== null && (
        <span className="ml-auto flex flex-none items-center gap-1.5 opacity-80" data-window-status>
          {status}
        </span>
      )}
      {play > 0 && !glow?.reduced && (
        <motion.div
          key={play}
          aria-hidden
          data-titlebar-glow
          className="pointer-events-none absolute inset-0 flex items-center gap-2 bg-accent px-2.5 text-accent-fg will-change-[opacity]"
          initial={{ opacity: 0 }}
          animate={{ opacity: glowKeyframes.opacity }}
          transition={{ duration: durations.glow.ms / 1000, ease: glowKeyframes.ease.map((e) => (typeof e === "string" ? e : [...e])) as never, times: glowKeyframes.times }}
        >
          <svg viewBox="0 0 12 14" width={9} height={10} aria-hidden className="flex-none">
            <path d="M1 13V6a5 5 0 0 1 10 0v7Z" fill="var(--accent-fg)" />
          </svg>
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </motion.div>
      )}
    </div>
  );
}

/** A sunk well inside a window (no border, no shadow). */
export function Well({ className, ...rest }: ComponentPropsWithoutRef<"div">) {
  return <div data-well className={`bg-bg-sunk p-3 ${className ?? ""}`} {...rest} />;
}
