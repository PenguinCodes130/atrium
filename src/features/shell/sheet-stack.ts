"use client";
// The shell's own stack of open sheets, in the order they opened (gauntlet r1 lead note: C37, nested
// sheet Esc closed the lower sheet about 1 run in 4). Radix keeps its own layer order, which can
// disagree with what is on top when a second dialog opens from a keyboard shortcut. Every sheet's
// Escape handler defers to this stack, so Esc always closes the sheet that opened last.
import { useLayoutEffect, useRef } from "react";

type Entry = { id: number; close: () => void };
const stack: Entry[] = [];
let nextId = 1;

/** Register an open sheet. Returns nothing; the entry leaves the stack when `open` turns false or on unmount. */
export function useSheetStackEntry(open: boolean, close: () => void): { current: number } {
  const id = useRef(0);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    if (!open) return;
    const entry: Entry = { id: nextId++, close: () => closeRef.current() };
    id.current = entry.id;
    stack.push(entry);
    return () => {
      const i = stack.findIndex((e) => e.id === entry.id);
      if (i !== -1) stack.splice(i, 1);
      id.current = 0;
    };
  }, [open]);
  return id;
}

const handled = new WeakSet<Event>();

/**
 * For Radix `onEscapeKeyDown`: stop Radix from closing whichever layer it picked, and close the
 * sheet on top of the shell stack instead (once per key press).
 */
export function escapeTopSheet(event: KeyboardEvent): void {
  event.preventDefault();
  if (handled.has(event)) return;
  handled.add(event);
  stack[stack.length - 1]?.close();
}

/** Open sheets, bottom to top (diagnostics and tests). */
export function openSheetCount(): number {
  return stack.length;
}
