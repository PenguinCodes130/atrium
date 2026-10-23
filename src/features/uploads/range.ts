// Byte ranges for /uploads/ (Amendment 7 A7.1): browsers ask for videos in pieces with a `Range`
// header. Only one range is answered with 206; several ranges, or a header that is not a byte range,
// get the whole file (allowed by RFC 9110), and a range that starts past the end gets 416. Pure.

export type RangeResult = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

/** Read one `Range` header against a file of `size` bytes. `end` is inclusive. */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return { kind: "full" };
  const spec = m[1]!.trim();
  if (spec.includes(",")) return { kind: "full" };
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!r || (r[1] === "" && r[2] === "")) return { kind: "full" };
  if (r[1] === "") {
    // A suffix range: the last N bytes.
    const n = Number(r[2]);
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(r[1]);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: "unsatisfiable" };
  const end = r[2] === "" ? size - 1 : Math.min(Number(r[2]), size - 1);
  if (end < start) return { kind: "full" };
  return { kind: "partial", start, end };
}
