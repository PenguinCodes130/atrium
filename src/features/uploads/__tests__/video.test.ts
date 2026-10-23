// Wave 2.6 builder ease (spec 3.1, Amendment 7 A7.1 and A7.7): video uploads are known from their bytes,
// keep their own 25 MB limit (pictures stay 10 MB), are served in byte ranges, and the uploads listing
// answers owners and members only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/core/contracts";
import { AGENT, MEMBER, OWNER, VIEWER, doc, fakePort, freshDataDir, useInstance } from "@/features/settings/test/harness";
import { sniff, sniffVideo } from "../sniff";
import { parseRange } from "../range";
import { precheck, guessKind } from "../ui/upload-file";
import { tooLargeMessage, MAX_VIDEO_BYTES } from "../limits";

const MEDIA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../tests/e2e/settings/media");
const MP4 = readFileSync(path.join(MEDIA, "loop.mp4"));
const WEBM = readFileSync(path.join(MEDIA, "loop.webm"));
const GIF = readFileSync(path.join(MEDIA, "anim.gif"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2d3b5f00000000049454e44ae426082", "hex");

/** An ftyp box with the given major and compatible brands. */
function ftyp(major: string, ...compat: string[]): Buffer {
  const size = 16 + compat.length * 4;
  const b = Buffer.alloc(Math.max(size, 32));
  b.writeUInt32BE(size, 0);
  b.write("ftyp", 4, "ascii");
  b.write(major, 8, "ascii");
  compat.forEach((c, i) => b.write(c, 16 + i * 4, "ascii"));
  return b;
}
/** A buffer of `n` bytes that starts like the MP4 fixture. */
const bigMp4 = (n: number) => {
  const b = Buffer.alloc(n);
  MP4.copy(b, 0, 0, Math.min(MP4.length, n));
  return b;
};

describe("video type from the bytes (criterion 5)", () => {
  it("knows MP4 and WebM, and keeps AVIF a picture", () => {
    expect(sniffVideo(MP4)).toEqual({ mime: "video/mp4", ext: "mp4", kind: "video" });
    expect(sniffVideo(WEBM)).toEqual({ mime: "video/webm", ext: "webm", kind: "video" });
    expect(sniff(ftyp("avif", "mif1", "avif"))?.mime).toBe("image/avif");
    expect(sniffVideo(ftyp("avif", "mif1"))).toBeNull();
    expect(sniffVideo(ftyp("heic", "mif1"))).toBeNull();
    expect(sniffVideo(ftyp("qt  "))).toBeNull(); // QuickTime is not one of the allowed types
    expect(sniffVideo(ftyp("mp42", "isom"))?.mime).toBe("video/mp4");
  });

  it("refuses a Matroska file that is not WebM, and a program renamed .mp4", () => {
    const mkv = Buffer.from(WEBM);
    mkv.write("matr", 0x18, "ascii"); // doctype bytes become "matr" (still 4 long), not "webm"
    expect(sniffVideo(mkv)).toBeNull();
    const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "binary"), Buffer.alloc(200, 7)]);
    expect(sniff(exe, "video")).toBeNull();
    expect(sniff(exe, "media")).toBeNull();
    expect(sniff(exe, "any")).toBeNull();
  });

  it("matches the kind asked for", () => {
    expect(sniff(MP4, "image")).toBeNull();
    expect(sniff(MP4, "font")).toBeNull();
    expect(sniff(PNG, "video")).toBeNull();
    expect(sniff(MP4, "media")?.kind).toBe("video");
    expect(sniff(GIF, "media")?.mime).toBe("image/gif");
    expect(sniff(WEBM, "any")?.mime).toBe("video/webm");
  });
});

describe("limits (criterion 4)", () => {
  it("says the limit and the size in the spec's words", () => {
    expect(tooLargeMessage("video", Math.round(41.2 * 1024 * 1024), MAX_VIDEO_BYTES)).toBe("Videos can be at most 25 MB. This one is 41.2 MB.");
  });

  it("refuses a 30 MB video in the browser before sending, and lets a 20 MB one through", () => {
    expect(precheck({ name: "big.mp4", type: "video/mp4", size: 30 * 1024 * 1024 }, "video")).toBe("Videos can be at most 25 MB. This one is 30.0 MB.");
    expect(precheck({ name: "ok.mp4", type: "video/mp4", size: 20 * 1024 * 1024 }, "video")).toBeNull();
    expect(precheck({ name: "ok.webm", type: "", size: 20 * 1024 * 1024 }, "media")).toBeNull();
    expect(precheck({ name: "big.png", type: "image/png", size: 11 * 1024 * 1024 }, "image")).toBe("Files can be at most 10 MB. This one is 11.0 MB.");
    expect(precheck({ name: "e.mp4", type: "video/mp4", size: 0 }, "video")).toBe("The file is empty.");
    expect(guessKind({ name: "clip.WEBM", type: "" })).toBe("video");
  });

  describe("on the server", () => {
    beforeEach(() => {
      vi.resetModules();
      useInstance(freshDataDir());
    });

    it("stores a 20 MB MP4 and refuses a 30 MB one with its size; pictures keep 10 MB", async () => {
      const store = await import("../store");
      const ok = store.saveUpload(MEMBER, bigMp4(20 * 1024 * 1024), "clip.mp4", "video");
      expect(ok).toMatchObject({ mime: "video/mp4", kind: "video" });
      expect(ok.path).toMatch(/^\/uploads\/[a-z0-9]{20}\.mp4$/);
      expect(() => store.saveUpload(MEMBER, bigMp4(30 * 1024 * 1024), "big.mp4", "video")).toThrow("Videos can be at most 25 MB. This one is 30.0 MB.");
      const bigPng = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
      expect(() => store.saveUpload(MEMBER, bigPng, "big.png", "media")).toThrow(/^Files can be at most 10 MB/);
      // Backups and other callers that cap pictures keep the video limit for videos.
      expect(store.checkFile(bigMp4(20 * 1024 * 1024), "any", { maxBytes: store.MAX_UPLOAD_BYTES }).kind).toBe("video");
    });

    it("names the allowed types in words when the type is wrong", async () => {
      const store = await import("../store");
      const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 1)]);
      expect(() => store.saveUpload(MEMBER, exe, "movie.mp4", "video")).toThrow("This file type is not allowed. Upload a video (MP4 or WebM).");
      expect(() => store.saveUpload(MEMBER, exe, "x.mp4", "media")).toThrow("This file type is not allowed. Upload a picture (PNG, JPEG, GIF, WebP, AVIF or SVG) or a video (MP4 or WebM).");
      expect(() => store.saveUpload(MEMBER, MP4, "x.png", "image")).toThrow(/^This file type is not allowed/);
    });

    it("serves a stored video by its checked extension only", async () => {
      const store = await import("../store");
      const v = store.saveUpload(OWNER, WEBM, "loop.webm", "media");
      const file = v.path.slice("/uploads/".length);
      expect(store.readUpload(file)).toMatchObject({ mime: "video/webm", kind: "video" });
      expect(store.readUpload(file)?.bytes.length).toBe(WEBM.length);
      expect(store.FILE_RE.test("aaaaaaaaaaaaaaaaaaaa.mp4")).toBe(true);
      expect(store.FILE_RE.test("aaaaaaaaaaaaaaaaaaaa.mov")).toBe(false);
    });

    it("lets a guest open a video only when the published version uses it (criterion 8)", async () => {
      const store = await import("../store");
      const port = await import("@/features/settings/app-port");
      const used = store.saveUpload(OWNER, MP4, "used.mp4", "video");
      const other = store.saveUpload(OWNER, WEBM, "other.webm", "video");
      const published = doc({ themeId: "dusk" });
      published.pages[0]!.root.children = [{ id: "c_v", type: "video", props: { src: used.path } }];
      const draft = doc({ themeId: "dusk" });
      draft.pages[0]!.root.children = [{ id: "c_v2", type: "video", props: { src: other.path } }];
      port.registerAppPort(fakePort([{ appId: "a1", name: "A", draft, published }]).port);
      expect(await store.guestMayOpen("a1", used.path.slice(9))).toBe(true);
      expect(await store.guestMayOpen("a1", other.path.slice(9))).toBe(false);
    });
  });
});

describe("byte ranges (A7.1)", () => {
  it("answers one range, ignores several, and refuses a start past the end", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "full" });
    expect(parseRange("bytes=0-", 100)).toEqual({ kind: "partial", start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ kind: "partial", start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ kind: "partial", start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "full" });
    expect(parseRange("items=0-1", 100)).toEqual({ kind: "full" });
    expect(parseRange("bytes=20-10", 100)).toEqual({ kind: "full" });
    expect(parseRange("bytes=abc", 100)).toEqual({ kind: "full" });
  });
});

describe("uploads listing (A7.7, criteria 6 and 29)", () => {
  beforeEach(() => {
    vi.resetModules();
    useInstance(freshDataDir());
  });

  it("lists newest first with the kind filter, and never says who uploaded", async () => {
    const store = await import("../store");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
      store.saveUpload(OWNER, PNG, "first.png", "image");
      vi.setSystemTime(new Date("2026-10-20T10:01:00Z"));
      store.saveUpload(MEMBER, MP4, "clip.mp4", "video");
      vi.setSystemTime(new Date("2026-10-20T10:02:00Z"));
      store.saveUpload(OWNER, GIF, "anim.gif", "image");
    } finally {
      vi.useRealTimers();
    }
    const all = store.listUploads(OWNER);
    expect(all.map((i) => i.name)).toEqual(["anim.gif", "clip.mp4", "first.png"]);
    expect(store.listUploads(MEMBER, "image").map((i) => i.name)).toEqual(["anim.gif", "first.png"]);
    expect(store.listUploads(MEMBER, "video").map((i) => i.name)).toEqual(["clip.mp4"]);
    expect(Object.keys(all[0]!).sort()).toEqual(["createdAt", "kind", "mime", "name", "path", "size"]);
    expect(all[0]!.createdAt).toBe("2026-10-20T10:02:00.000Z");
    expect(JSON.stringify(all)).not.toMatch(/u-owner|u-member|createdBy/);
  });

  it("answers viewers and guests with not found; an agent with edit scope for a member may list", async () => {
    const store = await import("../store");
    const { NotFound } = await import("@/core/errors");
    const guest = { kind: "guest", appId: "a1", linkId: "l1", role: "viewer" } as unknown as Principal;
    expect(() => store.listUploads(VIEWER)).toThrow(NotFound);
    expect(() => store.listUploads(guest)).toThrow(NotFound);
    expect(store.listUploads(AGENT)).toEqual([]);
  });

  it("stops at 200 items", async () => {
    const store = await import("../store");
    for (let i = 0; i < 205; i++) {
      const b = Buffer.from(PNG);
      store.saveUpload(OWNER, Buffer.concat([b, Buffer.from([i & 0xff, i >> 8])]), `p${i}.png`, "image");
    }
    expect(store.listUploads(OWNER)).toHaveLength(store.MAX_LISTED);
  });
});
