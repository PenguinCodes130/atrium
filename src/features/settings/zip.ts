// A small, strict zip reader and writer for theme files and backups (design v4 section 2 "Sharing";
// architecture 12). No dependency: entries are stored or deflated with node:zlib. The reader refuses
// what it does not understand (zip64, encryption, data descriptors it cannot check, path tricks, too
// many entries, or more bytes than the caller allows), so a damaged or hostile file is refused, never
// partly read.
import "server-only";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer };

export class ZipError extends Error {}

const NAME_RE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/ ()]{1,200}$/;

export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!NAME_RE.test(e.name) || seen.has(e.name)) throw new ZipError(`bad entry name ${e.name}`);
    seen.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const deflated = deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, fixed so output is reproducible
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
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

export function readZip(buf: Buffer, limits: { maxEntries?: number; maxTotalBytes?: number; maxEntryBytes?: number } = {}): Map<string, Buffer> {
  const maxEntries = limits.maxEntries ?? 2000;
  const maxTotal = limits.maxTotalBytes ?? 512 * 1024 * 1024;
  const maxEntry = limits.maxEntryBytes ?? maxTotal;
  if (buf.length < 22) throw new ZipError("not a zip file");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new ZipError("too many files");
  if (cdOff + cdSize > eocd || cdOff === 0xffffffff) throw new ZipError("damaged zip");
  const out = new Map<string, Buffer>();
  let p = cdOff;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("damaged zip");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (flags & 0x1) throw new ZipError("encrypted zip");
    if (name.endsWith("/")) continue; // directories
    if (!NAME_RE.test(name)) throw new ZipError(`bad file name ${name}`);
    if (out.has(name)) throw new ZipError(`duplicate file ${name}`);
    if (usize > maxEntry) throw new ZipError(`${name} is too large`);
    total += usize;
    if (total > maxTotal) throw new ZipError("the file is too large");
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new ZipError("damaged zip");
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw new ZipError("damaged zip");
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) });
      } catch {
        throw new ZipError("damaged zip");
      }
    } else throw new ZipError("unsupported compression");
    if (data.length !== usize || (crc32(data) >>> 0) !== crc) throw new ZipError("damaged zip");
    out.set(name, data);
  }
  return out;
}
