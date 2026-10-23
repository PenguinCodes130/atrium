import { describe, expect, it } from "vitest";
import { alignmentPositions, encodeQr, formatBits, numDataCodewords, rsDivisor, rsRemainder, versionBits, type QrMatrix } from "./encode";

// The encoder is checked two ways: published known answers (ISO/IEC 18004 tables and the worked
// "HELLO WORLD" 1-M example), and a decoder written here independently of the encoder (its own
// GF(256) log tables, its own function-pattern map and alignment table, syndrome-based Reed-Solomon
// checking) that reads every generated symbol back to the original text.

// ---- Independent reference data (ISO/IEC 18004 tables 1, 7 and annex E) -------------------------
const RAW_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const M_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const M_ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const M_DATA_CODEWORDS = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// GF(256) by exp/log tables (primitive polynomial 0x11D), unlike the encoder's bit-serial multiply.
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    v <<= 1;
    if (v & 0x100) v ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** BCH(15,5) format code by long division, written independently of the encoder. */
function bchFormat(data5: number): number {
  let v = data5 << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= gen << (i - 10);
  return ((data5 << 10) | v) ^ 0b101010000010010;
}

function decode(q: QrMatrix): { text: string; ecc: string; mask: number; version: number } {
  const m = q.modules;
  const n = m.length;
  const version = (n - 17) / 4;
  expect(Number.isInteger(version)).toBe(true);

  // Finder patterns and their light separators.
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const X = ox + x;
        const Y = oy + y;
        if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        expect(m[Y]![X], `finder at ${X},${Y}`).toBe(ring !== 2 && ring !== 4);
      }
    }
  }
  // Timing patterns.
  for (let i = 8; i < n - 8; i++) {
    expect(m[6]![i]).toBe(i % 2 === 0);
    expect(m[i]![6]).toBe(i % 2 === 0);
  }
  expect(m[n - 8]![8], "dark module").toBe(true);

  // Format information: both copies agree and form a valid BCH code word.
  const get = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  let f1 = 0;
  const copy1: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  copy1.forEach(([x, y], i) => (f1 |= get(x, y) << i));
  let f2 = 0;
  const copy2: [number, number][] = [...Array.from({ length: 8 }, (_, i) => [n - 1 - i, 8] as [number, number]), ...Array.from({ length: 7 }, (_, i) => [8, n - 7 + i] as [number, number])];
  copy2.forEach(([x, y], i) => (f2 |= get(x, y) << i));
  expect(f1).toBe(f2);
  const found = Array.from({ length: 32 }, (_, d) => d).find((d) => bchFormat(d) === f1);
  expect(found, "valid format code").toBeDefined();
  const eccName = ["M", "L", "H", "Q"][found! >>> 3]!;
  const mask = found! & 7;

  // Version information (7 and up): both copies equal a valid BCH(18,6) word for this version.
  if (version >= 7) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 18; i++) {
      a |= get(n - 11 + (i % 3), Math.floor(i / 3)) << i;
      b |= get(Math.floor(i / 3), n - 11 + (i % 3)) << i;
    }
    expect(a).toBe(b);
    expect(a >>> 12).toBe(version);
    let v = version << 12;
    const gen = 0b1111100100101;
    for (let i = 17; i >= 12; i--) if ((v >>> i) & 1) v ^= gen << (i - 12);
    expect(a & 0xfff).toBe(v);
  }

  // Which modules carry data (independent map).
  const fn = (x: number, y: number) => {
    if ((x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8)) return true;
    if (x === 6 || y === 6) return true;
    if (version >= 7 && ((x >= n - 11 && x < n - 8 && y < 6) || (y >= n - 11 && y < n - 8 && x < 6))) return true;
    const pos = ALIGN[version]!;
    for (const cx of pos) {
      for (const cy of pos) {
        if ((cx === 6 && cy === 6) || (cx === 6 && cy === pos.at(-1)) || (cx === pos.at(-1) && cy === 6)) continue;
        if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
      }
    }
    return false;
  };

  // Zigzag read with the mask removed.
  const bits: number[] = [];
  let upward = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let k = 0; k < n; k++) {
      const y = upward ? n - 1 - k : k;
      for (const x of [right, right - 1]) if (!fn(x, y)) bits.push((m[y]![x] ? 1 : 0) ^ (MASKS[mask]!(x, y) ? 1 : 0));
    }
    upward = !upward;
  }
  const raw = RAW_CODEWORDS[version]!;
  expect(Math.floor(bits.length / 8)).toBe(raw);
  const words: number[] = [];
  for (let i = 0; i < raw; i++) words.push(bits.slice(i * 8, i * 8 + 8).reduce((acc, b) => (acc << 1) | b, 0));

  // De-interleave (only ECC level M is used by Atrium; the tables above are for M).
  expect(eccName).toBe("M");
  const blocks = M_BLOCKS[version]!;
  const eccLen = M_ECC_PER_BLOCK[version]!;
  const shortLen = Math.floor(raw / blocks);
  const numShort = blocks - (raw % blocks);
  const dataLen = (b: number) => shortLen - eccLen + (b < numShort ? 0 : 1);
  const perBlock: number[][] = Array.from({ length: blocks }, () => []);
  let p = 0;
  for (let i = 0; i < shortLen - eccLen + 1; i++) for (let b = 0; b < blocks; b++) if (i < dataLen(b)) perBlock[b]!.push(words[p++]!);
  for (let i = 0; i < eccLen; i++) for (let b = 0; b < blocks; b++) perBlock[b]!.push(words[p++]!);
  expect(p).toBe(raw);

  // Reed-Solomon: every syndrome S_i = c(a^i), i < eccLen, is zero for a valid block.
  for (const block of perBlock) {
    for (let i = 0; i < eccLen; i++) {
      let s = 0;
      for (const c of block) s = mul(s, EXP[i]!) ^ c;
      expect(s, `syndrome ${i}`).toBe(0);
    }
  }

  // Byte-mode segment.
  const data = perBlock.flatMap((b, i) => b.slice(0, dataLen(i)));
  expect(data.length).toBe(M_DATA_CODEWORDS[version]);
  const stream = data.flatMap((w) => Array.from({ length: 8 }, (_, i) => (w >>> (7 - i)) & 1));
  let at = 0;
  const read = (len: number) => {
    let v = 0;
    for (let i = 0; i < len; i++) v = (v << 1) | stream[at++]!;
    return v;
  };
  expect(read(4)).toBe(0b0100);
  const count = read(version <= 9 ? 8 : 16);
  const bytes = Uint8Array.from({ length: count }, () => read(8));
  return { text: new TextDecoder().decode(bytes), ecc: eccName, mask, version };
}

describe("QR encoder known answers", () => {
  it("Reed-Solomon matches the HELLO WORLD 1-M worked example", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("format and version information match the standard's tables", () => {
    expect(formatBits("M", 0)).toBe(0b101010000010010);
    expect(formatBits("L", 0)).toBe(0b111011111000100);
    expect(formatBits("H", 7)).toBe(bchFormat((2 << 3) | 7));
    expect(versionBits(7)).toBe(0b000111110010010100);
    expect(versionBits(10)).toBe(0b001010010011010011);
  });

  it("capacities and alignment positions match the standard for versions 1 to 10 (and 32)", () => {
    for (let v = 1; v <= 10; v++) {
      expect(numDataCodewords(v, "M")).toBe(M_DATA_CODEWORDS[v]);
      expect(alignmentPositions(v)).toEqual(ALIGN[v]);
    }
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
  });
});

describe("QR encoder round trip through the independent decoder", () => {
  const uri = "otpauth://totp/Atrium:owner%40atrium.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Atrium&digits=6&period=30";
  const samples = ["A", "https://atrium.example/", uri, `${uri}&x=${"y".repeat(60)}`, `${uri}&pad=${"z".repeat(90)}`];

  it("decodes to the original text at every size used, with every mask", () => {
    const versions = new Set<number>();
    for (const text of samples) {
      for (let mask = 0; mask < 8; mask++) {
        const q = encodeQr(text, "M", mask);
        const d = decode(q);
        expect(d).toMatchObject({ text, ecc: "M", mask });
        versions.add(d.version);
      }
    }
    // Covers version 1, a version with version information (7+), and 16-bit lengths (10).
    expect([...versions].sort((a, b) => a - b)).toEqual(expect.arrayContaining([1, 7, 10]));
  });

  it("an authenticator URI picks the smallest version and a valid mask", () => {
    const q = encodeQr(uri);
    expect(q.version).toBe(7); // 114 bytes: version 6-M holds 106, 7-M holds 122
    expect(decode(q).text).toBe(uri);
  });

  it("a flipped data module is caught by the Reed-Solomon check", () => {
    const q = encodeQr(uri);
    const bad: QrMatrix = { ...q, modules: q.modules.map((r) => [...r]) };
    bad.modules[q.size - 1]![q.size - 1] = !bad.modules[q.size - 1]![q.size - 1];
    expect(() => decode(bad)).toThrow();
  });
});
