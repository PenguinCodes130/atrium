// settings round 3, gauntlet w2-r2 item 1 (low, security): the integration's own-host exception for
// image URLs in integration data matches the configured ORIGIN (scheme, host and port, with the
// scheme's default port), not the host name. Also the optional hardening: 6to4 and Teredo addresses
// wrapping a non-public IPv4 are not signed.
// Throwaway data folders and local stand-in servers only; nothing here is a real credential.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { freshDataDir, useInstance } from "./harness";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d3b5f00000000049454e44ae426082", "hex");
const OWNER: Principal = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const q = (path: string) => new URLSearchParams(path.slice(path.indexOf("?") + 1));

async function signing() {
  vi.resetModules();
  useInstance(freshDataDir());
  return {
    sign: await import("@/features/uploads/sign"),
    proxy: await import("@/features/uploads/proxy"),
    dataSign: await import("@/features/uploads/data-sign"),
    sqlite: (await import("@/core/db")).sqlite,
  };
}

// Two stand-ins on one host: "own" is the integration, "other" is another service on the same machine.
let own: Server;
let other: Server;
let ownPort = 0;
let otherPort = 0;
const hits: string[] = [];
beforeAll(async () => {
  other = createServer((req, res) => {
    hits.push(`other ${req.url}`);
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  otherPort = (other.address() as AddressInfo).port;
  own = createServer((req, res) => {
    hits.push(`own ${req.url}`);
    if (req.url === "/to-other-port") {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/f/router-admin.png` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((r) => own.listen(0, "127.0.0.1", () => r()));
  ownPort = (own.address() as AddressInfo).port;
});
afterAll(() => {
  own.close();
  other.close();
});

describe("originKey", () => {
  it("writes the default port out and normalises the host", async () => {
    const { sign } = await signing();
    expect(sign.originKey("http://cam.lan/a.png")).toBe("http://cam.lan:80");
    expect(sign.originKey("http://cam.lan:80/a.png")).toBe("http://cam.lan:80");
    expect(sign.originKey("https://cam.lan/a.png")).toBe("https://cam.lan:443");
    expect(sign.originKey("https://cam.lan:443/")).toBe("https://cam.lan:443");
    expect(sign.originKey("HTTP://CAM.LAN.:8080/x")).toBe("http://cam.lan:8080");
    expect(sign.originKey("http://[0:0:0:0:0:0:0:1]:3142/x")).toBe("http://[::1]:3142");
    expect(sign.originKey("http://2130706433:3142/x")).toBe("http://127.0.0.1:3142");
    expect(sign.originKey("ftp://cam.lan/x")).toBeNull();
    expect(sign.originKey("not a url")).toBeNull();
  });
});

describe("item 1: the own-host exception matches the configured origin, not any port", () => {
  it("the critic's reproduction: a localhost:3142 feed linking localhost:3141 is not signed; its own origin still is", async () => {
    const { sign } = await signing();
    const origins = sign.integrationOriginsFrom({ baseUrl: "http://localhost:3142/feed.xml" });
    expect(origins).toEqual(["http://localhost:3142"]);
    expect(sign.dataUrlNet("http://localhost:3141/f/own-otherport?SECPROBE=router-admin", origins)).toBeNull();
    expect(sign.dataUrlNet("http://localhost:3142/f/own.png", origins)).toBe("host");
    expect(sign.signDataImageUrl("http://localhost:3141/f/own-otherport?SECPROBE=router-admin", { appId: "app1", access: "viewer", ownOrigins: origins })).toBeNull();
    expect(q(sign.signDataImageUrl("http://localhost:3142/f/own.png", { appId: "app1", access: "viewer", ownOrigins: origins })!).get("n")).toBe("h");
  });

  it("another port on the same host is refused for LAN hosts, and falls to the public rule for public hosts", async () => {
    const { sign } = await signing();
    const lan = sign.integrationOriginsFrom({ baseUrl: "http://10.77.99.4:8006/" });
    expect(sign.dataUrlNet("http://10.77.99.4:8006/pve.png", lan)).toBe("host");
    for (const port of [22, 80, 81, 443, 2375, 8007, 9090]) expect(sign.dataUrlNet(`http://10.77.99.4:${port}/x.png`, lan)).toBeNull();
    // A public integration: another port is only ever fetched public-only (never "h").
    const pub = sign.integrationOriginsFrom({ baseUrl: "https://hnrss.org/frontpage" });
    expect(sign.dataUrlNet("https://hnrss.org/cover.png", pub)).toBe("host");
    expect(sign.dataUrlNet("https://hnrss.org:8443/cover.png", pub)).toBe("public");
    expect(sign.dataUrlNet("http://hnrss.org/cover.png", pub)).toBe("public");
  });

  it("a scheme switch is another origin, and the default port is the same origin", async () => {
    const { sign } = await signing();
    const httpOnly = sign.integrationOriginsFrom({ baseUrl: "http://nas.lan/" });
    expect(sign.dataUrlNet("http://nas.lan/a.png", httpOnly)).toBe("host");
    expect(sign.dataUrlNet("http://nas.lan:80/a.png", httpOnly)).toBe("host");
    expect(sign.dataUrlNet("https://nas.lan/a.png", httpOnly)).toBeNull();
    expect(sign.dataUrlNet("http://nas.lan:443/a.png", httpOnly)).toBeNull();
    const httpsOnly = sign.integrationOriginsFrom({ baseUrl: "https://pve.lan:8006" });
    expect(sign.dataUrlNet("https://pve.lan:8006/a.png", httpsOnly)).toBe("host");
    expect(sign.dataUrlNet("http://pve.lan:8006/a.png", httpsOnly)).toBeNull();
    expect(sign.dataUrlNet("https://pve.lan/a.png", httpsOnly)).toBeNull();
    const tls443 = sign.integrationOriginsFrom({ baseUrl: "https://ha.lan:443/" });
    expect(tls443).toEqual(["https://ha.lan:443"]);
    expect(sign.dataUrlNet("https://ha.lan/local/cam.jpg", tls443)).toBe("host");
  });

  it("IPv6 and host name forms: equal forms match, other ports and loopback aliases do not", async () => {
    const { sign } = await signing();
    const v6 = sign.integrationOriginsFrom({ baseUrl: "http://[::1]:3142/feed.xml" });
    expect(v6).toEqual(["http://[::1]:3142"]);
    expect(sign.dataUrlNet("http://[0:0:0:0:0:0:0:1]:3142/a.png", v6)).toBe("host");
    expect(sign.dataUrlNet("http://[::1]:3141/a.png", v6)).toBeNull();
    expect(sign.dataUrlNet("http://[::ffff:127.0.0.1]:3142/a.png", v6)).toBeNull();
    expect(sign.dataUrlNet("http://127.0.0.1:3142/a.png", v6)).toBeNull();
    expect(sign.dataUrlNet("http://localhost:3142/a.png", v6)).toBeNull();
    const ula = sign.integrationOriginsFrom({ baseUrl: "http://[fd00::5]:8123" });
    expect(sign.dataUrlNet("http://[FD00:0::5]:8123/x.png", ula)).toBe("host");
    expect(sign.dataUrlNet("http://[fd00::5]:8124/x.png", ula)).toBeNull();
    const named = sign.integrationOriginsFrom({ baseUrl: "http://Cam.Home.Arpa:8080/" });
    expect(sign.dataUrlNet("http://cam.home.arpa:8080/x.png", named)).toBe("host");
    expect(sign.dataUrlNet("http://CAM.home.arpa.:8080/x.png", named)).toBe("host");
    expect(sign.dataUrlNet("http://cam.home.arpa:8081/x.png", named)).toBeNull();
    expect(sign.dataUrlNet("http://cam.home.arpa.:8081/x.png", named)).toBeNull();
    // Numeric IPv4 spellings are normalised by the URL parser before the comparison.
    const v4 = sign.integrationOriginsFrom({ baseUrl: "http://127.0.0.1:3142" });
    expect(sign.dataUrlNet("http://2130706433:3142/a.png", v4)).toBe("host");
    expect(sign.dataUrlNet("http://0x7f.1:3141/a.png", v4)).toBeNull();
    // A trailing root dot never turns a local name into a "public" one.
    expect(sign.dataUrlNet("http://localhost.:3141/a.png", [])).toBeNull();
  });

  it("ports a package declares are added explicitly, with the base URL's scheme and host only", async () => {
    const { sign } = await signing();
    const o = sign.integrationOriginsFrom({ baseUrl: "http://nvr.lan:5000/" }, [5001, 0, 70000]);
    expect(o).toEqual(["http://nvr.lan:5000", "http://nvr.lan:5001"]);
    expect(sign.dataUrlNet("http://nvr.lan:5001/snap.jpg", o)).toBe("host");
    expect(sign.dataUrlNet("https://nvr.lan:5001/snap.jpg", o)).toBeNull();
    expect(sign.dataUrlNet("http://nvr.lan:5002/snap.jpg", o)).toBeNull();
    expect(sign.integrationOriginsFrom({ endpoint: "unix:///var/run/docker.sock" })).toEqual([]);
    expect(sign.integrationOriginsFrom({ baseUrl: "file:///etc/passwd" })).toEqual([]);
  });

  it("imageSignersFor uses the stored integration's origin", async () => {
    const { dataSign, sqlite } = await signing();
    const now = Date.now();
    sqlite().prepare(`INSERT INTO integration (id, package_id, name, config, secret_fields, status, shared, created_by, created_by_id, created_at, updated_at) VALUES (?, 'rss', 'Feed', ?, '[]', 'active', 0, 'user', ?, ?, ?)`).run("int-3142", JSON.stringify({ baseUrl: "http://localhost:3142/feed.xml" }), "u-owner", now, now);
    expect(dataSign.integrationImageOrigins("int-3142")).toEqual(["http://localhost:3142"]);
    expect(dataSign.integrationImageOrigins("missing")).toEqual([]);
    expect(Object.keys(dataSign.IMAGE_PORTS_BY_PACKAGE)).toEqual([]);
    const signer = dataSign.imageSignersFor(OWNER, "app1", [{ key: "news", integrationId: "int-3142" }])("news")!;
    expect(signer("http://localhost:3141/f/own-otherport?SECPROBE=router-admin")).toBeNull();
    expect(q(signer("http://localhost:3142/f/own.png")!).get("n")).toBe("h");
  });

  it("an own-origin fetch never follows a redirect to another port on the same host", async () => {
    const { proxy } = await signing();
    proxy.clearImageCache();
    hits.length = 0;
    expect((await proxy.fetchImage(`http://127.0.0.1:${ownPort}/own.png`, { net: "host" })).mime).toBe("image/png");
    await expect(proxy.fetchImage(`http://127.0.0.1:${ownPort}/to-other-port`, { net: "host" })).rejects.toThrow(/left the integration's own host/);
    expect(hits).toEqual(["own /own.png", "own /to-other-port"]);
  });
});

describe("hardening: 6to4 and Teredo wrapping a non-public IPv4", () => {
  it("is not signed as public; wrapping a public IPv4 still is", async () => {
    const { sign } = await signing();
    expect(sign.isNonPublicIp("2002:7f00:1::")).toBe(true); // 6to4 of 127.0.0.1
    expect(sign.isNonPublicIp("2002:a00:1::")).toBe(true); // 6to4 of 10.0.0.1
    expect(sign.isNonPublicIp("2002:c0a8:101::1")).toBe(true); // 6to4 of 192.168.1.1
    expect(sign.isNonPublicIp("2002:5db8:d70e::")).toBe(false); // 6to4 of 93.184.215.14
    // Teredo: client IPv4 stored inverted in the last 32 bits. ~127.0.0.1 = 80ff:fffe.
    expect(sign.isNonPublicIp("2001:0:5db8:d70e::80ff:fffe")).toBe(true);
    expect(sign.isNonPublicIp("2001:0:5db8:d70e::a247:28f1")).toBe(false); // client 93.184.215.14
    expect(sign.isNonPublicIp("2001:0:a00:1::a247:28f1")).toBe(true); // a private Teredo server
    expect(sign.isNonPublicIp("2001:db8::1")).toBe(false);
    for (const u of ["http://[2002:7f00:1::]/x.png", "http://[2002:a00:1::]/x.png", "http://[2001:0:5db8:d70e::80ff:fffe]/x.png"]) expect(sign.dataUrlNet(u, [])).toBeNull();
    expect(sign.dataUrlNet("http://[2002:5db8:d70e::]/x.png", [])).toBe("public");
  });
});
