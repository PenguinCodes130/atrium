"use client";
// Switch (design v4 "Buttons": switches). A square 44 x 24 track with a 1px ink border. Off: raised
// paper track, ink square thumb at the left. On: gold track, thumb at the right. It changes with the
// `pop` spring (instant under reduced motion). role="switch" with aria-checked.
// With `label`, the whole row is the control (one 44px tap target on touch).
import { useId, type ReactNode } from "react";
import { motion } from "motion/react";
import { transitionFor } from "./motion";
import { useReducedMotion } from "./use-preferences";

export const SWITCH_TRACK = { width: 44, height: 24, thumb: 16, inset: 3 } as const;

type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label; the whole row toggles. Without it, pass aria-label. */
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
};

function Track({ checked }: { checked: boolean }) {
  const reduced = useReducedMotion();
  const travel = SWITCH_TRACK.width - 2 - SWITCH_TRACK.thumb - SWITCH_TRACK.inset * 2;
  return (
    <span
      aria-hidden
      data-switch-track={checked ? "on" : "off"}
      className={`relative inline-flex h-6 w-11 flex-none items-center border border-[color:var(--ink)] ${checked ? "bg-accent" : "bg-bg-hi"} dark:border-line-strong`}
    >
      <motion.span
        data-switch-thumb
        className={`absolute top-[3px] left-[3px] size-4 bg-[color:var(--ink)] ${checked ? "" : "dark:bg-fg"}`}
        initial={false}
        animate={{ x: checked ? travel : 0 }}
        transition={transitionFor("pop", reduced)}
      />
    </span>
  );
}

export function Switch({ checked, onCheckedChange, label, description, disabled, id, className, ...aria }: SwitchProps) {
  const auto = useId();
  const sid = id ?? `switch-${auto}`;
  if (!label) {
    return (
      <button
        id={sid}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={aria["aria-label"]}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={`inline-flex min-h-8 min-w-11 cursor-pointer items-center justify-center touch:min-h-11 disabled:cursor-default disabled:opacity-40 ${className ?? ""}`}
        data-switch
      >
        <Track checked={checked} />
      </button>
    );
  }
  return (
    <button
      id={sid}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      data-switch-row
      data-switch
      className={`flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 px-2 text-left hover:bg-bg-sunk disabled:cursor-default disabled:opacity-40 sm:min-h-9 ${className ?? ""}`}
    >
      <span className="flex min-w-0 flex-col">
        <span className="type-body text-fg">{label}</span>
        {description && <span className="type-caption text-fg-3">{description}</span>}
      </span>
      <Track checked={checked} />
    </button>
  );
}
