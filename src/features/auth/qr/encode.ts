// A small QR Code encoder (ISO/IEC 18004), byte mode only, for the TOTP enrolment code (auth gauntlet
// r1, fix 5). No package and no network request: the otpauth:// URI never leaves the page.
// Structure follows the standard: data codewords, Reed-Solomon error correction over GF(256) with
// the 0x11D polynomial, block interleaving, function patterns, the 8 masks scored with the 4 penalty
// rules, and BCH-coded format and version information.

export type Ecc = "L" | "M" | "Q" | "H";

const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_INDEX: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 };

// Error correction codewords per block, and number of blocks, by ECC level and version (index 0 unused).
// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export type QrMatrix = { version: number; size: number; ecc: Ecc; mask: number; modules: boolean[][] };

// ---- Sizes ------------------------------------------------------------------------------------------

/** Data and ECC modules in a symbol of this version (everything except function patterns). */
export function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (8 bits each) available at this version and ECC level. */
export function numDataCodewords(ver: number, ecc: Ecc): number {
  const e = ECC_INDEX[ecc];
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
}

export function blockLayout(ver: number, ecc: Ecc): { numBlocks: number; eccPerBlock: number } {
  const e = ECC_INDEX[ecc];
  return { numBlocks: NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!, eccPerBlock: ECC_CODEWORDS_PER_BLOCK[e]![ver]! };
}

/** Row and column centres of the alignment patterns for this version. */
export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const size = ver * 4 + 17;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Reed-Solomon over GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1 -------------------------------

export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial with roots a^0 .. a^(degree-1), leading 1 dropped. */
export function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The ECC codewords for a block of data codewords. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i]! ^= gfMultiply(coef, factor)));
  }
  return result;
}

// ---- Data -------------------------------------------------------------------------------------------

function appendBits(bits: number[], value: number, len: number) {
  for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** Byte-mode data codewords for this version, with terminator and padding. */
export function dataCodewords(bytes: Uint8Array, ver: number, ecc: Ecc): number[] {
  const capacity = numDataCodewords(ver, ecc) * 8;
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) appendBits(bits, b, 8);
  if (bits.length > capacity) throw new Error("Data too long for this version");
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Splits data into blocks, adds ECC to each, and interleaves (short blocks first). */
export function addEccAndInterleave(data: readonly number[], ver: number, ecc: Ecc): number[] {
  const { numBlocks, eccPerBlock } = blockLayout(ver, ecc);
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccPerBlock);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - eccPerBlock + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const block = [...dat];
    const eccWords = rsRemainder(dat, divisor);
    if (i < numShortBlocks) block.push(0);
    blocks.push(block.concat(eccWords));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - eccPerBlock || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

// ---- Matrix -----------------------------------------------------------------------------------------

/** The 15 format bits (ECC level and mask, BCH(15,5), XOR 0x5412). */
export function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (BCH(18,6)), versions 7 and up. */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error("mask");
  }
}

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly version: number, readonly ecc: Ecc) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.drawFormat(0); // reserves the area; redrawn with the chosen mask
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }

  finder(cx: number, cy: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, d !== 2 && d !== 4);
      }
    }
  }

  drawFormat(mask: number) {
    const bits = formatBits(this.ecc, mask);
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(bits, i));
    this.set(8, n - 8, true); // the dark module
  }

  drawCodewords(data: readonly number[]) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.isFunction[y]![x] && maskBit(mask, x, y)) this.modules[y]![x] = !this.modules[y]![x];
  }
}

/** Penalty score of a finished matrix (the four rules of ISO/IEC 18004 section 7.8.3). */
export function penalty(m: readonly (readonly boolean[])[]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // 1:1:3:1:1 finder-like pattern with 4 light modules on either side.
      for (let j = 0; j + 6 < n; j++) {
        const at = (k: number) => (k < 0 || k >= n ? false : get(i, k));
        const core = at(j) && !at(j + 1) && at(j + 2) && at(j + 3) && at(j + 4) && !at(j + 5) && at(j + 6);
        if (!core) continue;
        const lightBefore = !at(j - 1) && !at(j - 2) && !at(j - 3) && !at(j - 4);
        const lightAfter = !at(j + 7) && !at(j + 8) && !at(j + 9) && !at(j + 10);
        if (lightBefore || lightAfter) score += 40;
      }
    }
  };
  line((i, j) => m[i]![j]!);
  line((i, j) => m[j]![i]!);
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const k = Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
  score += k * 10;
  return score;
}

/** Encodes text (UTF-8, byte mode) at the smallest version that fits, choosing the best mask. */
export function encodeQr(text: string, ecc: Ecc = "M", forceMask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 40; v++) {
    const header = 4 + (v <= 9 ? 8 : 16);
    if (header + bytes.length * 8 <= numDataCodewords(v, ecc) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error("Text too long for a QR code");
  const codewords = addEccAndInterleave(dataCodewords(bytes, version, ecc), version, ecc);
  let best: { mask: number; modules: boolean[][]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue;
    const b = new Builder(version, ecc);
    b.drawFunctionPatterns();
    b.drawCodewords(codewords);
    b.applyMask(mask);
    b.drawFormat(mask);
    const score = penalty(b.modules);
    if (!best || score < best.score) best = { mask, modules: b.modules, score };
  }
  return { version, size: version * 4 + 17, ecc, mask: best!.mask, modules: best!.modules };
}

/** SVG path data for the dark modules (one unit per module, offset by the quiet zone). */
export function qrPath(m: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  m.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      parts.push(`M${x + quiet} ${y + quiet}h${w}v1h-${w}z`);
      x += w - 1;
    }
  });
  return parts.join("");
}
