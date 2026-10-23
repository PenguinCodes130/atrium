"use client";
// Sheet primitive (Radix Dialog + Motion `sheet` preset). Side panels on desktop and tablet become
// bottom sheets on phones (side="auto"). Esc closes the top sheet; focus is trapped and restored.
// Design v4: a sheet is a square window (28px title bar with the door glyph and a path, raised paper
// body, 1px strong border) on the overlay shadow (soft 0 24px 64px plus the window shadow).
// `surface="float"` puts it on the floating glass (only for sheets drawn over a viewed app).
// Bottom sheets close with a downward swipe from the grab handle or the header (past 80px, or a fast
// flick), using the sheet spring; under reduced motion they close with the 120ms crossfade.
import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Dialog, VisuallyHidden } from "radix-ui";
import { AnimatePresence, motion, useDragControls, type PanInfo } from "motion/react";
import { transitionFor, timed } from "./motion";
import { useReducedMotion } from "./use-preferences";
import { useIsPhone } from "./use-viewport";
import { CloseIcon } from "./icons";
import { escapeTopSheet, useSheetStackEntry } from "./sheet-stack";
import { Button } from "./button";
import { TitleBar } from "./window";

export type SheetSide = "auto" | "right" | "left" | "bottom";

export type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Visually hide the title (it is still announced). */
  hideTitle?: boolean;
  description?: string;
  side?: SheetSide;
  /** @deprecated v3 glass material; ignored (sheets are paper windows). */
  material?: "thick" | "regular";
  /** "paper" (default) or "float" (floating glass, over a viewed app only). */
  surface?: "paper" | "float";
  /** Title bar path; defaults to "atrium / <title>". */
  path?: string;
  /** Width for side sheets in px (default 420). */
  width?: number;
  children?: ReactNode;
  footer?: ReactNode;
  /** Stable hook for tests and other subsystems (e.g. "approval"). */
  name?: string;
  showClose?: boolean;
};

/** Swipe distance (px) or downward speed (px/s) that closes a bottom sheet. */
export const SWIPE_CLOSE_PX = 80;
export const SWIPE_CLOSE_VELOCITY = 500;

const offscreen = {
  right: { x: "100%" },
  left: { x: "-100%" },
  bottom: { y: "100%" },
} as const;

export function Sheet({ open, onOpenChange, title, hideTitle, description, side = "auto", surface = "paper", path, width = 420, children, footer, name, showClose = true }: SheetProps) {
  const reduced = useReducedMotion();
  const isPhone = useIsPhone();
  // Sheets are opened by any button (not a Radix Trigger), so remember what had focus and restore it.
  const returnFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && typeof document !== "undefined") returnFocus.current = document.activeElement as HTMLElement | null;
  }, [open]);
  const resolved: Exclude<SheetSide, "auto"> = side === "auto" ? (isPhone ? "bottom" : "right") : side;
  useSheetStackEntry(open, () => onOpenChange(false));
  const drag = useDragControls();
  const bottom = resolved === "bottom";
  const startDrag = (e: ReactPointerEvent) => {
    if (bottom) drag.start(e);
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > SWIPE_CLOSE_PX || info.velocity.y > SWIPE_CLOSE_VELOCITY) onOpenChange(false);
  };
  const hidden = reduced ? { opacity: 0 } : { ...offscreen[resolved], opacity: 1 };
  const shown = reduced ? { opacity: 1 } : { x: 0, y: 0, opacity: 1 };
  const position =
    resolved === "bottom"
      ? "inset-x-0 bottom-0 max-h-[85dvh] border-x-0 border-b-0 pb-safe"
      : resolved === "right"
        ? "inset-y-0 right-0 h-dvh max-w-[100vw] border-y-0 border-r-0"
        : "inset-y-0 left-0 h-dvh max-w-[100vw] border-y-0 border-l-0";

  const Title = hideTitle ? (
    <VisuallyHidden.Root asChild>
      <Dialog.Title>{title}</Dialog.Title>
    </VisuallyHidden.Root>
  ) : (
    <Dialog.Title className="type-title-3 text-fg">{title}</Dialog.Title>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-ink/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={reduced ? { duration: 0.12 } : timed("fade")}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              forceMount
              onEscapeKeyDown={escapeTopSheet}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                returnFocus.current?.focus({ preventScroll: true });
              }}
            >
              <motion.div
                data-sheet={name ?? "sheet"}
                data-side={resolved}
                data-window="sheet"
                className={`${surface === "float" ? "glass-float" : "border border-line-strong bg-bg-hi"} fixed z-50 flex flex-col overflow-hidden text-fg shadow-overlay will-change-transform ${position}`}
                style={resolved === "bottom" ? undefined : { width }}
                initial={hidden}
                animate={shown}
                exit={hidden}
                transition={transitionFor("sheet", reduced)}
                drag={bottom ? "y" : false}
                dragControls={drag}
                dragListener={false}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 1 }}
                dragSnapToOrigin
                onDragEnd={bottom ? onDragEnd : undefined}
              >
                <div onPointerDown={startDrag} className={bottom ? "cursor-grab touch-none" : undefined} data-sheet-handle={bottom ? "" : undefined}>
                  <TitleBar title={path ?? `atrium / ${title.toLowerCase()}`} />
                </div>
                <header className={`flex flex-none items-start gap-3 px-(--window-pad) pt-4 pb-3 ${bottom ? "touch-none" : ""}`} onPointerDown={startDrag}>
                  <div className="min-w-0 flex-1">
                    {Title}
                    {description ? (
                      <Dialog.Description className="mt-1 type-body text-fg-2">{description}</Dialog.Description>
                    ) : (
                      <VisuallyHidden.Root asChild>
                        <Dialog.Description>{title}</Dialog.Description>
                      </VisuallyHidden.Root>
                    )}
                  </div>
                  {showClose && (
                    <Dialog.Close asChild>
                      <Button variant="quiet" iconOnly aria-label="Close" className="-mt-1 -mr-2">
                        <CloseIcon />
                      </Button>
                    </Dialog.Close>
                  )}
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto px-(--window-pad) pb-(--window-pad)">{children}</div>
                {footer && <footer className="flex flex-none justify-end gap-2 border-t border-line px-(--window-pad) py-4">{footer}</footer>}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
