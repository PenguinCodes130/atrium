// Address rules for every outgoing request (architecture v2 sections 3 and 13).
// Link-local and cloud metadata ranges are refused at every hop. Private ranges and
// loopback are allowed, because homelab services live there.
import { isIP } from "node:net";

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** Expands an IPv6 address into 8 16-bit groups. Handles "::" and an embedded IPv4 tail. */
export function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  let tail: number[] = [];
  const lastColon = addr.lastIndexOf(":");
  const maybeV4 = addr.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = ipv4ToInt(maybeV4);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    addr = addr.slice(0, lastColon + 1) + "0:0";
    tail = tail.length ? tail : [];
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if ([...head, ...rest].some((n) => Number.isNaN(n))) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  } else groups = head;
  if (groups.length !== 8) return null;
  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

export type AddressVerdict = { blocked: false } | { blocked: true; reason: string };

/** True for 169.254.0.0/16, fe80::/10 and fd00:ec2::/64, including IPv4-mapped and IPv4-compatible forms. */
export function checkAddress(ip: string): AddressVerdict {
  const family = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0] ?? "");
  if (family === 4) {
    const n = ipv4ToInt(ip)!;
    if (n >>> 16 === ((169 << 8) | 254)) return { blocked: true, reason: "link-local or metadata address (169.254.0.0/16)" };
    return { blocked: false };
  }
  if (family === 6) {
    const g = expandIpv6(ip);
    if (!g) return { blocked: true, reason: "unparseable address" };
    // fe80::/10
    if ((g[0]! & 0xffc0) === 0xfe80) return { blocked: true, reason: "IPv6 link-local address (fe80::/10)" };
    // fd00:ec2::/64 (AWS IMDS over IPv6)
    if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g[2] === 0 && g[3] === 0) return { blocked: true, reason: "cloud metadata address (fd00:ec2::/64)" };
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96) wrapping a blocked IPv4.
    const v4Wrapped =
      (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
    if (v4Wrapped && !(g[6] === 0 && g[7]! <= 1)) {
      const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
      const inner = checkAddress(v4);
      if (inner.blocked) return inner;
    }
    return { blocked: false };
  }
  return { blocked: true, reason: "not an IP address" };
}

/**
 * True for loopback, private, carrier-grade NAT, unspecified, unique-local and other non-public
 * ranges (including IPv4-mapped, IPv4-compatible and NAT64 forms). These are allowed for reads,
 * but a request shaped by a person (Try it, custom endpoints) may only send a plain GET there,
 * so it cannot be used to change a homelab service (gauntlet r1 security finding 4).
 */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const family = isIP(bare);
  if (family === 4) {
    const n = ipv4ToInt(bare)!;
    const a = n >>> 24;
    const b = (n >>> 16) & 0xff;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
    if (a === 192 && b === 0 && ((n >>> 8) & 0xff) === 0) return true; // 192.0.0.0/24
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (family === 6) {
    const g = expandIpv6(bare);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0) return true; // link-local, site-local
    if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
    const v4Wrapped =
      (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
    if (v4Wrapped) return isPrivateAddress(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
    // Settings r3 shared file request (security note, gauntlet w2-r2): 6to4 (2002:V4::/48) and Teredo
    // (2001:0:SERVER:..:~CLIENT) carry an IPv4 that a relay dials; a non-public one makes the address
    // non-public too, like NAT64 above.
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    if (g[0] === 0x2002) return isPrivateAddress(v4(g[1]!, g[2]!));
    if (g[0] === 0x2001 && g[1] === 0) return isPrivateAddress(v4(~g[6]! & 0xffff, ~g[7]! & 0xffff)) || isPrivateAddress(v4(g[2]!, g[3]!));
    return false;
  }
  return true;
}
