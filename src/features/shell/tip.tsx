"use client";
// Shell tooltip (Radix Tooltip): a small paper window with the 3px hard shadow, fading in with `fade`. Needs the Tooltip.Provider that
// ShellFrame mounts. Opens on hover and on keyboard focus.
import type { ReactNode } from "react";
import { Tooltip } from "radix-ui";

export function Tip({ label, tag, side = "right", children }: { label: string; /** A mono tag before the label, for example "soon". */ tag?: string; side?: "top" | "right" | "bottom" | "left"; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={8} className="z-50 flex items-center gap-2 border border-line-strong bg-bg-hi px-2 py-1 type-label text-fg shadow-window-sm" style={{ animation: "atrium-fade-in 160ms cubic-bezier(0.2, 0, 0, 1)" }} data-tooltip>
          {tag ? (
            <span className="bg-fg px-1.5 py-0.5 leading-none text-bg" data-tip-tag>
              {tag}
            </span>
          ) : null}
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
