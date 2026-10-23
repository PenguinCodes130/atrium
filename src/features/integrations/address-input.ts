// One rule for every URL field (usability r1 low finding): a bare address such as 10.0.0.7:9090
// or nas.local/api gets http:// in front, the same way detection treats it. Pure, used by the
// server's config validation and by the screens to show the normalised address back.
export function withScheme(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return t; // mailto:, javascript: and the like stay as typed (and are refused)
  return `http://${t}`;
}
