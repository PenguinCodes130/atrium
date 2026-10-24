// Prop paths for bindings held inside list props (A10.2 and A10.7): "status", "stats.0.value",
// "items.2.percent", "lines.1.data". The inspector passes these to the builder's data picker
// (onConnectData), and the builder writes the picked binding back with setPropPath. Pure.
import type { PropValue } from "@/core/contracts";

/** The value at a dotted path ("lines.1.data"), or undefined. */
export function getPropPath(props: Record<string, PropValue>, path: string): PropValue | undefined {
  let cur: unknown = props;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
  }
  return cur as PropValue | undefined;
}

/**
 * The top-level prop key and its whole new value after setting `path` to `value` (a merge patch replaces
 * arrays whole, so the builder sends `{ props: { [key]: next } }`). An index one past the end appends a
 * new entry (Add a line, Add a number); `value` null at a list entry's own index removes that entry.
 */
export function setPropPath(props: Record<string, PropValue>, path: string, value: PropValue | null): { key: string; next: PropValue | null } {
  const segs = path.split(".");
  const key = segs[0]!;
  if (segs.length === 1) return { key, next: value };
  const clone = (v: unknown): unknown => (v === undefined ? undefined : structuredClone(v));
  const root = clone(props[key]) ?? (/^\d+$/.test(segs[1]!) ? [] : {});
  let cur = root as Record<string, unknown> | unknown[];
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx > cur.length) throw new Error(`No entry ${seg} in ${key}`);
      if (last) {
        if (value === null) cur.splice(idx, 1);
        else cur[idx] = value;
      } else {
        if (cur[idx] === undefined || cur[idx] === null || typeof cur[idx] !== "object") cur[idx] = /^\d+$/.test(segs[i + 1]!) ? [] : {};
        cur = cur[idx] as Record<string, unknown> | unknown[];
      }
    } else {
      if (last) {
        if (value === null) delete cur[seg];
        else cur[seg] = value;
      } else {
        if (cur[seg] === undefined || cur[seg] === null || typeof cur[seg] !== "object") cur[seg] = /^\d+$/.test(segs[i + 1]!) ? [] : {};
        cur = cur[seg] as Record<string, unknown> | unknown[];
      }
    }
  }
  return { key, next: root as PropValue };
}
