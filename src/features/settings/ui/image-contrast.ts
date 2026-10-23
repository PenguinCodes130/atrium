"use client";
// Canvas text over an image wallpaper (settings gauntlet w2-r1 item 11). The shell's contrast report
// knows colours, not pictures, so the editor samples the uploaded image itself: it draws it small, applies
// the theme's dim, and measures the canvas text against every sampled cell. The ratio shown is the 10th
// percentile (where the image is busiest), and when it is under 4.5:1 the editor suggests ink or white,
// whichever reads better.
import { useEffect, useState } from "react";
import type { ThemeTokens } from "@/core/contracts";
import { colorToRgba, contrastRatio } from "@/features/shell/theme";

type Rgb = { r: number; g: number; b: number; a: number };
export type ImageContrast = { low: boolean; ratio: number | null; suggest: string | null; suggestRatio: number | null };

const NONE: ImageContrast = { low: false, ratio: null, suggest: null, suggestRatio: null };
const CANDIDATES = ["#15130F", "#FFFFFF"];
const SIZE = 24;

/** The 10th-percentile contrast of `text` over the sampled cells. */
export function percentileContrast(text: Rgb, cells: Rgb[], q = 0.1): number {
  if (!cells.length) return 21;
  const ratios = cells.map((c) => contrastRatio({ ...text, a: 1 }, c)).sort((a, b) => a - b);
  return +ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * q))]!.toFixed(2);
}

/** Pure part, for tests: cells from RGBA bytes with the dim applied. */
export function cellsFrom(data: Uint8ClampedArray, dim: number): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    const k = 1 - Math.min(0.6, Math.max(0, dim));
    out.push({ r: (data[i]! / 255) * k, g: (data[i + 1]! / 255) * k, b: (data[i + 2]! / 255) * k, a: 1 });
  }
  return out;
}

export function judge(canvasText: string, cells: Rgb[]): ImageContrast {
  const text = colorToRgba(canvasText);
  if (!text || !cells.length) return NONE;
  const ratio = percentileContrast(text, cells);
  if (ratio >= 4.5) return { low: false, ratio, suggest: null, suggestRatio: null };
  const best = CANDIDATES.map((c) => ({ c, r: percentileContrast(colorToRgba(c)!, cells) })).sort((a, b) => b.r - a.r)[0]!;
  return { low: true, ratio, suggest: best.r > ratio ? best.c : null, suggestRatio: best.r > ratio ? best.r : null };
}

export function useImageContrast(w: ThemeTokens["wallpaper"], canvasText: string): ImageContrast {
  const [cells, setCells] = useState<Rgb[] | null>(null);
  const src = w.kind === "image" && w.value.startsWith("/uploads/") ? w.value : null;
  useEffect(() => {
    setCells(null);
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        const c = document.createElement("canvas");
        c.width = SIZE;
        c.height = SIZE;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        setCells(cellsFrom(ctx.getImageData(0, 0, SIZE, SIZE).data, 0));
      } catch {
        setCells(null);
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  if (!src || !cells) return NONE;
  const dim = Math.min(0.6, Math.max(0, w.dim));
  return judge(canvasText, cells.map((c) => ({ r: c.r * (1 - dim), g: c.g * (1 - dim), b: c.b * (1 - dim), a: 1 })));
}
