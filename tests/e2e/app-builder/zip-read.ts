// A small zip reader for the e2e checks (stored and deflated entries), so a test can look inside an
// exported Atrium app file without the app's own reader.
import { inflateRawSync } from "node:zlib";

export function readZipEntries(buf: Buffer, _inflate?: unknown): { path: string; text: string }[] {
  void _inflate;
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { path: string; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const path = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + lName + lExtra;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    out.push({ path, text: /\.json$/.test(path) ? data.toString("utf8") : "" });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
