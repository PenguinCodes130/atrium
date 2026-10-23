// Where to go after sign-in or step-up (auth gauntlet r3, fix 1: the open redirect). Pure, so the
// server pages and the client forms run the same check.
//
// A value is kept only when, at every decoding level (it is decoded up to three times, so double- and
// triple-encoded forms are caught), it starts with exactly one "/" followed by something that is not
// "/" or "\", holds no backslash, no control character (C0, DEL or C1) and no whitespace at all (ASCII
// or Unicode), and resolves to this origin. Browsers drop tab, newline and carriage return from URLs,
// which is how "/<TAB>/evil" became "//evil"; refusing every control character and space closes that
// whole family.
//
// Round 6: other characters above U+007E (for example "caf\u00e9", which Next hands pages already
// decoded) are no longer refused; they are percent-encoded as UTF-8 in the returned value. The result is
// therefore always printable ASCII, so a raw character in a Location header can never make redirect()
// answer 500 again (security re-check L1). Anything else becomes "/".

// C0 controls and space, DEL and C1 controls, backslash, and any Unicode whitespace (\s includes NBSP,
// U+2028, U+3000, U+FEFF and the rest).
const UNSAFE_CHAR = /[\u0000-\u0020\u007f-\u009f\\]|\s/u;
const ABOVE_ASCII = /[^\u0000-\u007e]+/gu;
const BASE = "http://atrium.invalid";

function unsafeLevel(v: string): boolean {
  if (!v.startsWith("/")) return true;
  if (v.length > 1 && (v[1] === "/" || v[1] === "\\")) return true;
  return UNSAFE_CHAR.test(v);
}

/** Percent-encodes every run of characters above U+007E as UTF-8; null for a lone surrogate. */
function encodeAboveAscii(v: string): string | null {
  try {
    return v.replace(ABOVE_ASCII, (run) => encodeURIComponent(run));
  } catch {
    return null;
  }
}

export function safeNext(next: unknown): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return "/";
  let level = next;
  for (let i = 0; i < 4; i++) {
    if (unsafeLevel(level)) return "/";
    let decoded: string;
    try {
      decoded = decodeURIComponent(level);
    } catch {
      break; // a stray "%" (for example "?q=100%") cannot decode into anything a browser would act on
    }
    if (decoded === level) break;
    if (i === 3) return "/"; // still changing after three decodes: refuse
    level = decoded;
  }
  const out = encodeAboveAscii(next);
  if (out === null || out.length > 2048) return "/";
  try {
    const u = new URL(out, BASE);
    if (u.origin !== BASE) return "/";
  } catch {
    return "/";
  }
  return out;
}
