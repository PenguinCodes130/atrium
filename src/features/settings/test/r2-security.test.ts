// settings round 2: the four security items of the w2-r1 gauntlet Fix List.
//   1  backup import needs a fresh step-up, checked before the body is read
//   2  restored uploads pass the upload checks (type from bytes, SVG sanitised) or are refused
//   3  image signatures name an app, a level (guest-safe, viewer, editor) and an expiry; /api/img checks
//      the caller may use them
//   4  URLs from integration data are signed only for public addresses or the integration's own host,
//      and public-only signatures never reach a non-public address at any hop
// Throwaway data folders and a local stand-in image server only; nothing here is a real credential.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppAccessResolver, Principal } from "@/core/contracts";
import { freshDataDir, useInstance } from "./harness";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d3b5f00000000049454e44ae426082", "hex");
const HTML = Buffer.from("<!doctype html><html><body><script>parent.alert(document.cookie)</script></body></html>");
const SCRIPTED_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="4" height="4"/></svg>');
const OWNER: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-owner", role: "owner", via: "session" };
const MEMBER: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-member", role: "member", via: "session" };
const VIEWER: Extract<Principal, { kind: "user" }> = { kind: "user", userId: "u-viewer", role: "viewer", via: "session" };
const guestOf = (appId: string): Principal => ({ kind: "guest", guestLinkId: `gl-${appId}`, appId, label: "guest", via: "guest-link" });

let server: Server;
let base = "";
let hits: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/away") {
      res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/ok.png` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("item 1: backup import needs a fresh step-up", () => {
  it("answers step_up_required before reading the body, and imports after a step-up", async () => {
    vi.resetModules();
    useInstance(freshDataDir());
    let fresh = false;
    const importBackup = vi.fn(async () => ({ tables: [], secrets: 0, uploads: 0, uploadsRefused: [], withoutSecrets: true, usersToReset: 0 }));
    const { AtriumError } = await import("@/core/errors");
    vi.doMock("@/features/auth", () => ({
      requireUser: async () => ({ principal: OWNER, user: { id: OWNER.userId, role: "owner" } }),
      requireStepUp: async () => {
        if (!fresh) throw new AtriumError("Confirm it is you to continue.", 403, "step_up_required");
        return {};
      },
    }));
    vi.doMock("@/features/backup/import", () => ({ importBackup, MAX_BACKUP_BYTES: 1024 * 1024 }));
    const { POST } = await import("@/app/api/settings/backup/import/route");
    let bodyRead = false;
    const form = () => {
      const fd = new FormData();
      fd.set("file", new File([Buffer.from("not read")], "b.atrium"));
      return fd;
    };
    const req = (q = "") => {
      const r = new Request(`http://127.0.0.1:3116/api/settings/backup/import${q}`, { method: "POST", body: form() });
      const formData = r.formData.bind(r);
      Object.defineProperty(r, "formData", { value: async () => { bodyRead = true; return formData(); } });
      return r;
    };
    const stale = await POST(req());
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("step_up_required");
    expect(bodyRead).toBe(false);
    expect(importBackup).not.toHaveBeenCalled();
    const probe = await POST(req("?check=1"));
    expect(probe.status).toBe(403);
    fresh = true;
    const ok = await POST(req("?check=1"));
    expect(ok.status).toBe(204);
    expect(bodyRead).toBe(false);
    const done = await POST(req());
    expect(done.status).toBe(200);
    expect(bodyRead).toBe(true);
    expect(importBackup).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/features/auth");
    vi.doUnmock("@/features/backup/import");
  });
});

describe("item 2: restored uploads pass the upload checks", () => {
  it("refuses HTML saved as .png (row says text/html) and sanitises a scripted SVG; served types come from the bytes", async () => {
    // Instance A: export a backup, then plant the critic's two hostile files and their rows in it.
    vi.resetModules();
    useInstance(freshDataDir());
    const exp = await import("@/features/backup/export");
    const { readZip, writeZip } = await import("@/features/settings/zip");
    const clean = await exp.exportBackup(OWNER, { includeSecrets: false });
    const files = readZip(clean.bytes);
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as { tables: { name: string; rows: number }[] };
    const row = (file: string, mime: string, kind: string) => ({ id: `id-${file}`, file, name: file, mime, kind, size: 10, sha256: "x", created_by_id: OWNER.userId, created_at: Date.now() });
    const rows = [row("aaaaaaaaaaaaaaaaaaaa.png", "text/html", "image"), row("bbbbbbbbbbbbbbbbbbbb.svg", "image/svg+xml", "image"), row("cccccccccccccccccccc.png", "image/png", "image"), row("dddddddddddddddddddd.gif", "text/html", "image")];
    files.set("data/upload.json", Buffer.from(JSON.stringify(rows)));
    const t = manifest.tables.find((x) => x.name === "upload");
    if (t) t.rows = rows.length;
    else manifest.tables.push({ name: "upload", rows: rows.length });
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    files.set("uploads/aaaaaaaaaaaaaaaaaaaa.png", HTML);
    files.set("uploads/bbbbbbbbbbbbbbbbbbbb.svg", SCRIPTED_SVG);
    files.set("uploads/cccccccccccccccccccc.png", PNG);
    files.set("uploads/dddddddddddddddddddd.gif", PNG); // a real PNG named .gif
    const hostile = writeZip([...files].map(([name, data]) => ({ name, data })));

    // Instance B: import it.
    vi.resetModules();
    const dirB = freshDataDir();
    useInstance(dirB);
    const imp = await import("@/features/backup/import");
    const store = await import("@/features/uploads/store");
    const { sqlite } = await import("@/core/db");
    const r = await imp.importBackup(OWNER, hostile, {});
    expect(r.uploadsRefused.map((u) => u.file).sort()).toEqual(["aaaaaaaaaaaaaaaaaaaa.png", "dddddddddddddddddddd.gif"]);
    expect(r.uploadsRefused.find((u) => u.file.endsWith(".png"))!.reason).toMatch(/not allowed/);
    expect(r.uploadsRefused.find((u) => u.file.endsWith(".gif"))!.reason).toMatch(/image\/png, not a \.gif/);
    expect(r.uploads).toBe(2);
    const { existsSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = store.uploadsDir();
    expect(existsSync(path.join(dir, "aaaaaaaaaaaaaaaaaaaa.png"))).toBe(false);
    expect(existsSync(path.join(dir, "dddddddddddddddddddd.gif"))).toBe(false);
    expect(readFileSync(path.join(dir, "bbbbbbbbbbbbbbbbbbbb.svg"), "utf8")).not.toMatch(/script|onload/i);
    const restored = sqlite().prepare(`SELECT file, mime, kind FROM upload ORDER BY file`).all() as { file: string; mime: string }[];
    expect(restored).toEqual([
      { file: "bbbbbbbbbbbbbbbbbbbb.svg", mime: "image/svg+xml", kind: "image" },
      { file: "cccccccccccccccccccc.png", mime: "image/png", kind: "image" },
    ]);
    expect(store.readUpload("aaaaaaaaaaaaaaaaaaaa.png")).toBeNull();
    expect(store.readUpload("bbbbbbbbbbbbbbbbbbbb.svg")!.bytes.toString()).not.toMatch(/script|onload/i);
    expect(store.readUpload("cccccccccccccccccccc.png")!.mime).toBe("image/png");
    // Defence in depth: a row that disagrees with its extension is never served, whatever wrote it.
    sqlite().prepare(`UPDATE upload SET mime = 'text/html' WHERE file = 'cccccccccccccccccccc.png'`).run();
    expect(store.readUpload("cccccccccccccccccccc.png")).toBeNull();
    const audit = sqlite().prepare(`SELECT detail FROM audit_log WHERE event = 'backup.imported'`).get() as { detail: string };
    expect(JSON.parse(audit.detail).uploadsRefused).toBe(2);
  });
});

async function signing() {
  vi.resetModules();
  useInstance(freshDataDir());
  return {
    sign: await import("@/features/uploads/sign"),
    proxy: await import("@/features/uploads/proxy"),
    dataSign: await import("@/features/uploads/data-sign"),
    hooks: await import("@/core/hooks"),
    sqlite: (await import("@/core/db")).sqlite,
  };
}

const q = (path: string) => new URLSearchParams(path.slice(path.indexOf("?") + 1));

describe("item 3: signatures are scoped to an app, a level and an expiry", () => {
  it("signs nothing without a scope; covers url, app, level, network rule and expiry", async () => {
    const { sign } = await signing();
    expect(sign.signImageUrl(`${base}/a.png`)).toBeNull();
    const now = Date.UTC(2026, 9, 19, 10, 0, 30);
    const p = sign.signImageUrl(`${base}/a.png`, { appId: "app1", access: "guest" }, now)!;
    expect(p).toMatch(/^\/api\/img\?u=.+&a=app1&v=g&n=d&e=\d+&s=[A-Za-z0-9_-]{43}$/);
    const v = sign.verifyImageQuery(q(p), now);
    expect(v).toMatchObject({ url: `${base}/a.png`, appId: "app1", access: "guest", net: "document" });
    // Any change to a covered part breaks it.
    for (const [k, val] of [["u", `${base}/b.png`], ["a", "app2"], ["v", "e"], ["n", "h"], ["e", String(Number(q(p).get("e")) + 3600)]] as const) {
      const t = q(p);
      t.set(k, val);
      expect(sign.verifyImageQuery(t, now)).toEqual({ problem: "bad_signature" });
    }
    // Expiry: works for 24 hours (rounded up to the hour), then refused as expired.
    const exp = Number(q(p).get("e")) * 1000;
    expect(exp - now).toBeGreaterThanOrEqual(sign.SIGNATURE_TTL_SEC * 1000);
    expect(exp - now).toBeLessThanOrEqual((sign.SIGNATURE_TTL_SEC + 3600) * 1000);
    expect(sign.verifyImageQuery(q(p), exp - 1000)).not.toHaveProperty("problem");
    expect(sign.verifyImageQuery(q(p), exp)).toEqual({ problem: "expired" });
    // The same URL keeps the same path within the hour (caches keep hitting).
    expect(sign.signImageUrl(`${base}/a.png`, { appId: "app1", access: "guest" }, now + 60_000)).toBe(p);
    // Old v1 paths (u and s only) are refused.
    expect(sign.verifyImageQuery(new URLSearchParams({ u: `${base}/a.png`, s: q(p).get("s")! }), now)).toEqual({ problem: "bad_signature" });
    // The address rules still refuse link-local, metadata and credentials.
    for (const bad of ["http://169.254.169.254/latest", "http://[fe80::1]/x.png", "javascript:alert(1)", "http://u:p@example.com/x.png"]) expect(sign.signImageUrl(bad, { appId: "app1", access: "guest" })).toBeNull();
  });

  it("/api/img refuses the cross-app and draft-only paths for a guest and a viewer, and serves the right callers", async () => {
    const m = await signing();
    // A stand-in for app-builder's resolver: the guest app has guests on; "other" is owner-only;
    // the viewer can open "guestapp" only and edit nothing.
    const open: Record<string, (p: Principal) => boolean> = {
      guestapp: (p) => p.kind === "guest" ? p.appId === "guestapp" : true,
      other: (p) => p.kind === "user" && p.role === "owner",
    };
    m.hooks.registerAppAccess({
      canOpenApp: async (p: Principal, id: string) => open[id]?.(p) ?? false,
      canEditApp: async (p: Principal) => p.kind === "user" && (p.role === "owner" || p.role === "member"),
    } as unknown as AppAccessResolver);
    let caller: Principal = OWNER;
    vi.doMock("@/features/auth", () => ({ requireViewer: async () => caller }));
    const { GET } = await import("@/app/api/img/route");
    const get = async (p: string, who: Principal) => {
      caller = who;
      const r = await GET(new Request(`http://127.0.0.1:3116${p}`));
      const body = r.status === 200 ? null : ((await r.json()) as { error: { code: string } }).error.code;
      return { status: r.status, code: body };
    };
    const otherPublished = m.sign.signImageUrl(`${base}/other.png`, { appId: "other", access: "guest" })!;
    const otherDraft = m.sign.signImageUrl(`${base}/other-draft.png`, { appId: "other", access: "editor" })!;
    const guestDraft = m.sign.signImageUrl(`${base}/guest-draft.png`, { appId: "guestapp", access: "editor" })!;
    const guestStream = m.sign.signImageUrl(`${base}/guest-stream.png`, { appId: "guestapp", access: "viewer" })!;
    const guestPublished = m.sign.signImageUrl(`${base}/guest.png`, { appId: "guestapp", access: "guest" })!;
    hits = [];
    // Guest of guestapp: cross-app refused, draft-only refused, viewer-level refused; its own published image served.
    expect(await get(otherPublished, guestOf("guestapp"))).toEqual({ status: 403, code: "image_not_allowed" });
    expect(await get(otherDraft, guestOf("guestapp"))).toEqual({ status: 403, code: "image_not_allowed" });
    expect(await get(guestDraft, guestOf("guestapp"))).toEqual({ status: 403, code: "image_not_allowed" });
    expect(await get(guestStream, guestOf("guestapp"))).toEqual({ status: 403, code: "image_not_allowed" });
    expect(await get(guestPublished, guestOf("guestapp"))).toEqual({ status: 200, code: null });
    // Viewer: cannot open "other" (published or draft), cannot use a draft signature of an app it can open.
    expect(await get(otherPublished, VIEWER)).toEqual({ status: 403, code: "image_not_allowed" });
    expect(await get(otherDraft, VIEWER)).toEqual({ status: 403, code: "image_not_allowed" });
    expect(await get(guestDraft, VIEWER)).toEqual({ status: 403, code: "image_not_allowed" });
    expect(await get(guestStream, VIEWER)).toEqual({ status: 200, code: null });
    // Owner and a member editor: drafts of apps they can edit.
    expect(await get(otherDraft, OWNER)).toEqual({ status: 200, code: null });
    expect(await get(guestDraft, MEMBER)).toEqual({ status: 200, code: null });
    // No refused request reached the image host.
    expect(hits.sort()).toEqual(["/guest-draft.png", "/guest-stream.png", "/guest.png", "/other-draft.png"]);
    // Unsigned, v1-style and tampered paths stop before any fetch.
    expect(await get(`/api/img?u=${encodeURIComponent(`${base}/x.png`)}&s=abc`, OWNER)).toEqual({ status: 403, code: "bad_signature" });
    // Without app-builder's resolver nothing is served (fail closed).
    m.hooks.resetAppAccess();
    expect(await get(guestPublished, guestOf("guestapp"))).toEqual({ status: 403, code: "image_not_allowed" });
    vi.doUnmock("@/features/auth");
  });
});

describe("item 4: no LAN fetches driven by integration data", () => {
  it("signs data URLs only when public or on the integration's own host", async () => {
    const { sign, dataSign, sqlite } = await signing();
    const now = Date.now();
    sqlite().prepare(`INSERT INTO integration (id, package_id, name, config, secret_fields, status, shared, created_by, created_by_id, created_at, updated_at) VALUES (?, 'rss', 'LAN cam', ?, '[]', 'active', 0, 'user', ?, ?, ?)`).run("int-lan", JSON.stringify({ baseUrl: "http://localhost:3150/" }), OWNER.userId, now, now);
    sqlite().prepare(`INSERT INTO integration (id, package_id, name, config, secret_fields, status, shared, created_by, created_by_id, created_at, updated_at) VALUES (?, 'rss', 'Feed', ?, '[]', 'active', 0, 'user', ?, ?, ?)`).run("int-feed", JSON.stringify({ baseUrl: "https://hnrss.org/frontpage" }), OWNER.userId, now, now);
    const signerFor = dataSign.imageSignersFor(OWNER, "app1", [{ key: "cam", integrationId: "int-lan" }, { key: "news", integrationId: "int-feed" }]);
    const news = signerFor("news")!;
    const cam = signerFor("cam")!;
    // The critic's two probe URLs, from a third party's feed: not signed.
    expect(news("http://127.0.0.1:3141/router/reboot.cgi?SECPROBE=1")).toBeNull();
    expect(news("http://192.168.1.250/snapshot.jpg")).toBeNull();
    for (const lan of ["http://localhost:3150/a.png", "http://10.77.99.6/x.png", "http://[::1]/x.png", "http://[fd00::5]/x.png", "http://100.64.0.1/x.png", "http://nas.lan/x.png", "http://printer/x.png", "http://cam.home.arpa/x.png", "http://0.0.0.0/x.png"]) expect(news(lan)).toBeNull();
    // Public addresses are signed, public only.
    expect(q(news("https://img.example.net/cover.png")!).get("n")).toBe("p");
    expect(q(news("http://93.184.215.14/cover.png")!).get("n")).toBe("p");
    // The LAN integration's own host is signed (its own rule); other LAN hosts in its data are not.
    expect(q(cam("http://localhost:3150/snapshot.png")!).get("n")).toBe("h");
    // Round 3 (w2-r2 item 1): another port on the same host is not the integration's origin.
    expect(cam("http://localhost:9999/other-port.png")).toBeNull();
    expect(cam("http://127.0.0.1:3150/snapshot.png")).toBeNull();
    expect(cam("http://192.168.1.250/snapshot.jpg")).toBeNull();
    // Unknown source keys sign nothing; access follows the caller.
    expect(signerFor("missing")).toBeNull();
    expect(q(news("https://img.example.net/c.png")!).get("v")).toBe("v");
    const guest = dataSign.imageSignersFor(guestOf("app1"), "app1", [{ key: "news", integrationId: "int-feed" }])("news")!;
    expect(q(guest("https://img.example.net/c.png")!).get("v")).toBe("g");
    // Document URLs a person typed keep the old rules: LAN allowed.
    expect(q(sign.signImageUrl("http://192.168.1.250/snapshot.jpg", { appId: "app1", access: "guest" })!).get("n")).toBe("d");
  });

  it("a public-only fetch never reaches a non-public address; an own-host fetch never leaves its host", async () => {
    const { proxy } = await signing();
    proxy.clearImageCache();
    hits = [];
    await expect(proxy.fetchImage(`${base}/pub.png`, { net: "public" })).rejects.toThrow(/not a public address/);
    expect(hits).toEqual([]);
    // The same URL is fine under the document rule, and a cached LAN image is never handed to a
    // public-only request for the same address.
    expect((await proxy.fetchImage(`${base}/pub.png`, { net: "document" })).mime).toBe("image/png");
    await expect(proxy.fetchImage(`${base}/pub.png`, { net: "public" })).rejects.toThrow(/not a public address/);
    expect((await proxy.fetchImage(`${base}/own.png`, { net: "host" })).mime).toBe("image/png");
    await expect(proxy.fetchImage(`${base}/away`, { net: "host" })).rejects.toThrow(/left the integration's own host/);
    expect(hits).toEqual(["/pub.png", "/own.png", "/away"]);
  });
});
