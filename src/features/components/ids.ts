// Stable ids (architecture v3 section 4.3): `<prefix>_<10 random base32 chars>`. Isomorphic.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export const ID_RE = { node: /^c_[a-z2-7]{10}$/, page: /^p_[a-z2-7]{10}$/, control: /^k_[a-z2-7]{10}$/ } as const;

export function newId(prefix: "c" | "p" | "k"): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const x of bytes) s += ALPHABET[x % 32];
  return `${prefix}_${s}`;
}

/** A deterministic node id derived from a seed (FNV-1a over the text, base32), for library instance contents. */
export function derivedId(seed: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  let s = "";
  let a = h1, b2 = h2;
  for (let i = 0; i < 10; i++) {
    const src = i < 5 ? a : b2;
    s += ALPHABET[src & 31];
    if (i < 5) a = a >>> 5; else b2 = b2 >>> 5;
  }
  return `c_${s}`;
}
