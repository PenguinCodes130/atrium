import { createHmac } from "node:crypto";

// ---- TOTP (RFC 6238) for tests --------------------------------------------------------------------

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secretBase32: string, at: number = Date.now(), period = 30, digits = 6): string {
  const counter = Math.floor(at / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secretBase32)).update(buf).digest();
  const off = mac[mac.length - 1]! & 0xf;
  const code = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export function secretFromUri(uri: string): string {
  return new URL(uri).searchParams.get("secret")!;
}
