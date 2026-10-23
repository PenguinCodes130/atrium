// File type checks for uploads (architecture 13 "Uploads"; settings spec 3.9; Amendment 7 A7.1). The
// type comes from the bytes, never from the file name or the request's Content-Type: a file named .png
// that holds HTML is refused, and so is a program renamed .mp4. Pure: no Node APIs beyond Uint8Array.

export type UploadKind = "image" | "video" | "font";
/** What a caller asks for: one kind, pictures or videos ("media"), or anything Atrium stores ("any"). */
export type UploadAccept = UploadKind | "media" | "any";
export type Sniffed = { mime: string; ext: string; kind: UploadKind };

/** The types each kind allows, named in words for refusal messages. */
export const ALLOWED_WORDS: Record<UploadKind, string> = {
  image: "a picture (PNG, JPEG, GIF, WebP, AVIF or SVG)",
  video: "a video (MP4 or WebM)",
  font: "a woff2 font",
};

export const NOT_ALLOWED = "This file type is not allowed";

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** The raster type of the bytes, or null. */
export function sniffRaster(b: Uint8Array): Sniffed | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png", kind: "image" };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg", kind: "image" };
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { mime: "image/gif", ext: "gif", kind: "image" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp", kind: "image" };
  const brands = ftypBrands(b);
  if (brands?.some((x) => x === "avif" || x === "avis")) return { mime: "image/avif", ext: "avif", kind: "image" };
  return null;
}

/** The major and compatible brands of an ISO base media `ftyp` box at the start, or null. */
function ftypBrands(b: Uint8Array): string[] | null {
  if (b.length < 16 || ascii(b, 4, 8) !== "ftyp") return null;
  const size = Math.min(b.length, ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0, 64);
  const brands: string[] = [ascii(b, 8, 12)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, i + 4));
  return brands;
}

/** Still-image and QuickTime brands: an ftyp box carrying any of these is not an MP4 video. */
const NOT_MP4_BRANDS = new Set(["avif", "avis", "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "qt  ", "crx "]);

/** An MP4 (ISO ftyp box with a video brand) or a WebM (EBML header, doctype "webm"), or null. */
export function sniffVideo(b: Uint8Array): Sniffed | null {
  const brands = ftypBrands(b);
  if (brands) {
    if (brands.some((x) => NOT_MP4_BRANDS.has(x))) return null;
    // Brands are four printable characters; anything else is not a real ftyp box.
    if (!brands.every((x) => /^[\x20-\x7e]{4}$/.test(x))) return null;
    return { mime: "video/mp4", ext: "mp4", kind: "video" };
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    // The DocType element (id 0x4282) inside the EBML header names the format.
    const head = b.subarray(0, Math.min(b.length, 64));
    for (let i = 4; i + 3 < head.length; i++) {
      if (head[i] !== 0x42 || head[i + 1] !== 0x82) continue;
      const len = head[i + 2]! & 0x7f; // one-byte size (0x80 | n)
      if (!(head[i + 2]! & 0x80) || len < 1 || i + 3 + len > head.length) return null;
      return ascii(head, i + 3, i + 3 + len) === "webm" ? { mime: "video/webm", ext: "webm", kind: "video" } : null;
    }
  }
  return null;
}

export function isWoff2(b: Uint8Array): boolean {
  return b.length >= 48 && ascii(b, 0, 4) === "wOF2";
}

/** Text that looks like an SVG document (after a BOM, whitespace, an XML declaration and comments). */
export function looksLikeSvg(text: string): boolean {
  let s = text.replace(/^﻿/, "").trimStart();
  for (let i = 0; i < 20; i++) {
    if (s.startsWith("<?xml")) s = s.slice(s.indexOf("?>") + 2).trimStart();
    else if (s.startsWith("<!--")) s = s.slice(s.indexOf("-->") + 3).trimStart();
    else if (/^<!doctype\s+svg/i.test(s)) {
      const gt = s.indexOf(">"), br = s.indexOf("[");
      s = s.slice((br >= 0 && br < gt ? s.indexOf("]>", br) + 1 : gt) + 1).trimStart();
    }
    else break;
  }
  return /^<svg[\s>/]/i.test(s);
}

/** True when the text holds an HTML document or markup a browser would run as a page. */
export function looksLikeHtml(text: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<iframe[\s>]/i.test(text.slice(0, 64 * 1024));
}

/**
 * What the bytes are, for the kind the caller wants: an image (PNG, JPEG, WebP, GIF, AVIF, or SVG to
 * be sanitised), a video (MP4 or WebM) or a woff2 font. "media" is an image or a video; "any" is all
 * three. Anything else, HTML included, is null ("This file type is not allowed").
 */
export function sniff(b: Uint8Array, want: UploadAccept = "any"): Sniffed | null {
  if (want === "font" || want === "any") {
    if (isWoff2(b)) return { mime: "font/woff2", ext: "woff2", kind: "font" };
    if (want === "font") return null;
  }
  if (want === "video" || want === "media" || want === "any") {
    const video = sniffVideo(b);
    if (video) return video;
    if (want === "video") return null;
  }
  const raster = sniffRaster(b);
  if (raster) return raster;
  // SVG is text: decode the head only and refuse anything that is HTML.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 4096));
  if (looksLikeSvg(head) && !looksLikeHtml(new TextDecoder().decode(b))) return { mime: "image/svg+xml", ext: "svg", kind: "image" };
  return null;
}
