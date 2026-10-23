// Version retention (architecture v3 section 4.9): keep the last N versions (N at least 20); the
// published version and the five before it are never removed. Pure.
export const PROTECTED_BEFORE_PUBLISHED = 5;

export function versionsToPrune(versions: number[], published: number | null, keep: number | null): number[] {
  if (!keep || versions.length <= keep) return [];
  const sorted = [...versions].sort((a, b) => b - a);
  const kept = new Set(sorted.slice(0, keep));
  if (published != null) for (let v = published - PROTECTED_BEFORE_PUBLISHED; v <= published; v++) kept.add(v);
  return sorted.filter((v) => !kept.has(v));
}
