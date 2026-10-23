// Gradient wallpapers in the theme editor (settings gauntlet w2-r1 item 12). A stored
// `linear-gradient(...)` is parsed into an angle and two colour stops when it has that shape, so the
// editor shows its real colours and angle; anything else is "Custom gradient (edit as text)" and is
// never replaced without the person saying so. Pure.
import { isThemeColor } from "@/features/shell";

export type ParsedGradient = { angle: number; stops: [string, string] };

const SIDES: Record<string, number> = {
  "to top": 0, "to top right": 45, "to right top": 45, "to right": 90, "to bottom right": 135, "to right bottom": 135,
  "to bottom": 180, "to bottom left": 225, "to left bottom": 225, "to left": 270, "to top left": 315, "to left top": 315,
};

/** Splits on commas that are not inside parentheses. */
function topLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** A stop "colour" or "colour 0%" / "colour 100%" (the default positions only). */
function stopColour(stop: string, pos: "start" | "end"): string | null {
  const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(stop.trim());
  if (!m) return null;
  const colour = m[1]!.trim();
  if (!isThemeColor(colour)) return null;
  if (m[2] !== undefined && Number(m[2]) !== (pos === "start" ? 0 : 100)) return null;
  return colour;
}

export function parseGradient(value: string): ParsedGradient | null {
  const m = /^linear-gradient\((.*)\)$/i.exec(value.trim());
  if (!m) return null;
  const parts = topLevel(m[1]!);
  let angle = 180;
  if (parts.length === 3) {
    const dir = parts[0]!.toLowerCase().replace(/\s+/g, " ");
    const deg = /^(-?\d+(?:\.\d+)?)deg$/.exec(dir);
    if (deg) angle = ((Number(deg[1]) % 360) + 360) % 360;
    else if (dir in SIDES) angle = SIDES[dir]!;
    else return null;
    parts.shift();
  }
  if (parts.length !== 2) return null;
  const a = stopColour(parts[0]!, "start");
  const b = stopColour(parts[1]!, "end");
  return a && b ? { angle: Math.round(angle), stops: [a, b] } : null;
}

export function formatGradient(g: ParsedGradient): string {
  return `linear-gradient(${g.angle}deg, ${g.stops[0]}, ${g.stops[1]})`;
}
