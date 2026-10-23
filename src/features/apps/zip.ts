// A small zip writer and reader for the Atrium app file (architecture v3 section 4.10). Deflate through
// node:zlib; no dependency. The reader refuses archives that are too large, too many entries, entries
// with unsafe paths, encryption, or unknown compression.
import "server-only";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { path: string; data: Uint8Array };

/** Writes a zip with deflated entries, in the order given. Dates are fixed so the same tree gives the same bytes. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.path, "utf8");
    const raw = Buffer.from(e.data);
    const comp = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export class ZipError extends Error {}

export type ZipLimits = { maxEntries: number; maxTotalBytes: number; maxEntryBytes: number };
export const DEFAULT_LIMITS: ZipLimits = { maxEntries: 400, maxTotalBytes: 40 * 1024 * 1024, maxEntryBytes: 12 * 1024 * 1024 };

// "@" is allowed for library/<id>@<version>.json (gauntlet w2-r1 item 3); no traversal, no backslash, no leading slash.
const SAFE_PATH = /^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9._@\-/]{1,200}$/;

/** Reads a zip into entries. Throws ZipError with a plain message when the archive is not acceptable. */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_LIMITS): ZipEntry[] {
  if (buf.length < 22) throw new ZipError("it is not a zip file");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("it is not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > limits.maxEntries) throw new ZipError(`it has more than ${limits.maxEntries} files`);
  if (cdOffset + cdSize > buf.length) throw new ZipError("the zip is damaged");
  const out: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("the zip is damaged");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const path = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new ZipError("it is encrypted");
    if (path.endsWith("/")) continue;
    if (!SAFE_PATH.test(path)) throw new ZipError(`it contains an unsafe file name (${path.slice(0, 60)})`);
    if (size > limits.maxEntryBytes) throw new ZipError(`${path} is too large`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError("it is too large");
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError("the zip is damaged");
    const lName = buf.readUInt16LE(localOffset + 26);
    const lExtra = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lName + lExtra;
    const comp = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) {
      try {
        data = inflateRawSync(comp, { maxOutputLength: limits.maxEntryBytes });
      } catch {
        throw new ZipError(`${path} could not be read`);
      }
    } else throw new ZipError(`${path} uses an unsupported compression`);
    if (data.length !== size || crc32(data) !== crc) throw new ZipError(`${path} is damaged`);
    out.push({ path, data });
  }
  return out;
}
