"use client";
// Wave 2.10b F6: the icon's Scale slider, 25 to 100% of its box (the px size field is gone, spec section 9).
// An older icon with a stored px size shows the Scale that draws the same size in its box as it is on
// the canvas now; moving the slider writes Scale and drops the px size and the old fill switch.
import { useEffect, useId, useState } from "react";
import type { ComponentNode } from "@/core/contracts";
import { iconSize, scaleForPx, SCALE_DEFAULT, SCALE_MAX, SCALE_MIN } from "../render/icon-scale";

/** The shorter side of the node's box on the builder canvas, in px (null when it is not drawn). */
function measuredSide(id: string): number | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(`[data-canvas-root] [data-node="${CSS.escape(id)}"] .atr-icon`) ?? document.querySelector(`[data-node="${CSS.escape(id)}"] .atr-icon`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const side = Math.min(r.width, r.height);
  return side > 0 ? side : null;
}

export function ScaleField({ node, hint, onScale }: { node: ComponentNode; hint: string; onScale(v: number): void }) {
  const id = useId();
  const size = iconSize(node.props as Record<string, unknown>);
  const [side, setSide] = useState<number | null>(null);
  useEffect(() => {
    if (size.kind !== "px") return;
    setSide(measuredSide(node.id));
    const t = setTimeout(() => setSide(measuredSide(node.id)), 300);
    return () => clearTimeout(t);
  }, [node.id, size.kind, size.kind === "px" ? size.px : 0, node.slot?.w, node.slot?.h]);
  const value = size.kind === "scale" ? size.scale : side ? scaleForPx(size.px, side) : SCALE_DEFAULT;
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  return (
    <div className="flex flex-col gap-1" data-field="scale">
      <label htmlFor={id} className="type-label text-fg-2 flex items-center justify-between" data-field-label>
        <span>Scale</span>
        <span className="font-mono text-[12px] text-fg" data-scale-value>
          {shown}%
        </span>
      </label>
      <input
        id={id}
        type="range"
        min={SCALE_MIN}
        max={SCALE_MAX}
        step={1}
        value={shown}
        aria-valuetext={`${shown} percent of the box`}
        onChange={(e) => {
          const v = Number(e.target.value);
          setShown(v);
          onScale(v);
        }}
        className="w-full accent-[var(--accent)] touch:h-11 max-sm:h-11"
        data-scale-slider
      />
      <p className="type-caption m-0 text-fg-3" data-field-hint>
        {size.kind === "px" ? `${hint}. Now ${size.px}px, which is ${value}% of this box` : hint}
      </p>
    </div>
  );
}
