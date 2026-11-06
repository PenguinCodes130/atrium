// Icon bytes for the favicon fetch (A11.6): the pixel size of a raster, the best entry of a Windows ICO
// (an embedded PNG as it is, or a BMP entry re-encoded as PNG, since uploads store no ICO), and data:
// URLs. Pure Node (zlib only); every read is bounds-checked, so hostile bytes give null, never a throw.
import { crc32, deflateSync } from "node:zlib";
import { FAVICON_MAX_PX } from "./messages";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array, at = 0) => b.length >= at + 24 && PNG_SIG.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

export type Size = { w: number; h: number };

/** Width and height of a PNG, GIF, JPEG, WebP or AVIF, or null when they cannot be read. */
export function imageSize(b: Uint8Array): Size | null {
  if (isPng(b)) return { w: be32(b, 16), h: be32(b, 20) };
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { w: le16(b, 6), h: le16(b, 8) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
    const kind = ascii(b, 12, 16);
    if (kind === "VP8 ") return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff };
    if (kind === "VP8L") return { w: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), h: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
    if (kind === "VP8X") return { w: 1 + le24(b, 24), h: 1 + le24(b, 27) };
    return null;
  }
  if (b.length >= 16 && ascii(b, 4, 8) === "ftyp") {
    // AVIF: the image spatial extent ("ispe") property gives the size.
    const head = b.subarray(0, Math.min(b.length, 64 * 1024));
    for (let i = 4; i + 16 <= head.length; i++) {
      if (head[i] === 0x69 && head[i + 1] === 0x73 && head[i + 2] === 0x70 && head[i + 3] === 0x65) return { w: be32(head, i + 8), h: be32(head, i + 12) };
    }
  }
  return null;
}

function jpegSize(b: Uint8Array): Size | null {
  let i = 2;
  for (let n = 0; n < 512 && i + 9 < b.length; n++) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i++;
      continue;
    }
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: be16(b, i + 5), w: be16(b, i + 7) };
    if (m === 0xd9 || m === 0xda) return null;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + be16(b, i + 2);
  }
  return null;
}

export function isIco(b: Uint8Array): boolean {
  return b.length >= 22 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && le16(b, 4) > 0;
}

type IcoEntry = { w: number; h: number; bpp: number; offset: number; size: number };

function icoEntries(b: Uint8Array): IcoEntry[] {
  const n = Math.min(le16(b, 4), 64);
  const out: IcoEntry[] = [];
  for (let k = 0; k < n; k++) {
    const e = 6 + k * 16;
    if (e + 16 > b.length) break;
    const offset = le16(b, e + 12) + le16(b, e + 14) * 65536;
    const size = le16(b, e + 8) + le16(b, e + 10) * 65536;
    if (size <= 0 || offset < 6 || offset + size > b.length) continue;
    out.push({ w: b[e] || 256, h: b[e + 1] || 256, bpp: le16(b, e + 6), offset, size });
  }
  return out;
}

export type IcoResult = { png: Buffer; size: Size } | { tooLarge: true } | null;

/**
 * The best entry of an ICO at most 256 px (largest first, then the most colours), as PNG bytes.
 * `{ tooLarge: true }` when every entry is larger; null when no entry can be read.
 */
export function icoToPng(b: Uint8Array): IcoResult {
  if (!isIco(b)) return null;
  const entries = icoEntries(b);
  if (!entries.length) return null;
  const fit = entries.filter((e) => e.w <= FAVICON_MAX_PX && e.h <= FAVICON_MAX_PX).sort((x, y) => y.w * y.h - x.w * x.h || y.bpp - x.bpp);
  let sawBig = false;
  for (const e of fit) {
    const data = b.subarray(e.offset, e.offset + e.size);
    if (isPng(data)) {
      const s = imageSize(data)!;
      if (s.w > FAVICON_MAX_PX || s.h > FAVICON_MAX_PX) sawBig = true;
      if (s.w > FAVICON_MAX_PX || s.h > FAVICON_MAX_PX || s.w === 0 || s.h === 0) continue;
      return { png: Buffer.from(data), size: s };
    }
    const rgba = decodeDib(data);
    if (rgba) return { png: encodePng(rgba.w, rgba.h, rgba.pixels), size: { w: rgba.w, h: rgba.h } };
  }
  return fit.length && !sawBig ? null : { tooLarge: true };
}

/** An ICO's BMP entry (DIB header, optional palette, XOR pixels, AND mask) as RGBA, or null. */
export function decodeDib(d: Uint8Array): { w: number; h: number; pixels: Uint8Array } | null {
  if (d.length < 40) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const hdr = view.getUint32(0, true);
  if (hdr < 40 || hdr > 124) return null;
  const w = view.getInt32(4, true);
  const fullH = view.getInt32(8, true);
  const bpp = view.getUint16(14, true);
  const compression = view.getUint32(16, true);
  const used = view.getUint32(32, true);
  const h = Math.abs(fullH) >> 1;
  const topDown = fullH < 0;
  if (w <= 0 || h <= 0 || w > FAVICON_MAX_PX || h > FAVICON_MAX_PX) return null;
  if (![1, 4, 8, 24, 32].includes(bpp)) return null;
  if (!(compression === 0 || (compression === 3 && bpp === 32))) return null;
  const paletteAt = hdr + (compression === 3 && hdr === 40 ? 12 : 0);
  const colours = bpp <= 8 ? (used > 0 && used <= 1 << bpp ? used : 1 << bpp) : 0;
  const pixelsAt = paletteAt + colours * 4;
  const stride = ((w * bpp + 31) >> 5) * 4;
  const maskStride = ((w + 31) >> 5) * 4;
  const maskAt = pixelsAt + stride * h;
  if (maskAt > d.length) return null;
  const hasMask = maskAt + maskStride * h <= d.length;
  const out = new Uint8Array(w * h * 4);
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const srcRow = topDown ? y : h - 1 - y;
    const row = pixelsAt + srcRow * stride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r = 0, g = 0, bl = 0, a = 255;
      if (bpp === 32) {
        bl = d[row + x * 4]!; g = d[row + x * 4 + 1]!; r = d[row + x * 4 + 2]!; a = d[row + x * 4 + 3]!;
        if (a) anyAlpha = true;
      } else if (bpp === 24) {
        bl = d[row + x * 3]!; g = d[row + x * 3 + 1]!; r = d[row + x * 3 + 2]!;
      } else {
        const bit = x * bpp;
        const byte = d[row + (bit >> 3)]!;
        const idx = bpp === 8 ? byte : bpp === 4 ? (bit & 4 ? byte & 0x0f : byte >> 4) : (byte >> (7 - (bit & 7))) & 1;
        if (idx >= colours) return null;
        const p = paletteAt + idx * 4;
        bl = d[p]!; g = d[p + 1]!; r = d[p + 2]!;
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a;
    }
  }
  // Without real alpha (24 bpp and below, or a 32 bpp entry whose alpha is all zero), the AND mask says
  // which pixels are transparent.
  if (bpp < 32 || !anyAlpha) {
    for (let y = 0; y < h; y++) {
      const srcRow = topDown ? y : h - 1 - y;
      for (let x = 0; x < w; x++) {
        const masked = hasMask ? (d[maskAt + srcRow * maskStride + (x >> 3)]! >> (7 - (x & 7))) & 1 : 0;
        out[(y * w + x) * 4 + 3] = masked ? 0 : 255;
      }
    }
  }
  return { w, h, pixels: out };
}

/** RGBA pixels as an 8-bit RGBA PNG. */
export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  }
  return Buffer.concat([Buffer.from(PNG_SIG), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The bytes of a `data:` URL, or null when it is not one Atrium reads (only image types, at most
 * `max` bytes after decoding).
 */
export function decodeDataUrl(url: string, max: number): Buffer | null {
  if (!/^data:/i.test(url) || url.length > max * 3 + 256) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma).toLowerCase();
  if (!/^image\//.test(meta)) return null;
  const payload = url.slice(comma + 1);
  let out: Buffer;
  try {
    out = meta.split(";").includes("base64") ? Buffer.from(payload.replace(/\s+/g, ""), "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return null;
  }
  return out.length > 0 && out.length <= max ? out : null;
}
