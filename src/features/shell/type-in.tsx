"use client";
// Type-in readout (design v4 section 3, `type`): a mono line that types in at 28ms per character,
// at most 1200ms in total, linear, on first appearance only. Reduced motion: the whole text at once.
// Screen readers get the full text immediately (the typed copy is aria-hidden).
import { useEffect, useRef, useState } from "react";
import { typeInMs } from "./motion";
import { useReducedMotion } from "./use-preferences";

export function TypeIn({ text, className }: { text: string; className?: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? text.length : 0);
  const played = useRef(false);
  useEffect(() => {
    if (played.current) {
      setShown(text.length);
      return;
    }
    played.current = true;
    const total = typeInMs(text.length, reduced);
    if (total === 0) {
      setShown(text.length);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const n = Math.min(text.length, Math.ceil(((now - start) / total) * text.length));
      setShown(n);
      if (n < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, reduced]);
  return (
    <span className={`font-mono ${className ?? ""}`} data-type-in={shown >= text.length ? "done" : "typing"}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>{text.slice(0, shown)}</span>
    </span>
  );
}
