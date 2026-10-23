// Upload storage (architecture 1 and 13; settings spec 3.9; Amendment 4 A4.4). Files live at
// ATRIUM_DATA_DIR/uploads/<id>.<ext>, indexed in the `upload` table. Owners and members upload; every
// signed-in user can open any upload; a guest only files their app's published version references.
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import type { Principal } from "@/core/contracts";
import { db } from "@/core/db";
import { dataDir } from "@/core/env";
import { AtriumError, Forbidden, NotFound } from "@/core/errors";
import { uploads } from "@/db/schema/uploads";
import { appPort } from "@/features/settings/app-port";
import { ALLOWED_WORDS, NOT_ALLOWED, sniff, type UploadAccept, type UploadKind } from "./sniff";
import { sanitiseSvg } from "./svg";
import { MAX_FONT_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, tooLargeMessage } from "./limits";

export { MAX_FONT_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, tooLargeMessage };

/** Fonts and wallpapers inside a theme package (A4.4). Fonts keep their 2 MB rule (design v4 section 2). */
export const MAX_PACKAGE_ASSET_BYTES = 5 * 1024 * 1024;
export const FILE_RE = /^[a-z0-9]{20}\.(png|jpg|gif|webp|avif|svg|woff2|mp4|webm)$/;

/** The refusal for a file of the wrong type, naming what is allowed in words. */
export function notAllowedMessage(accept: UploadAccept): string {
  if (accept === "font") return "Fonts must be woff2 files. This file is not a woff2 font.";
  const kinds: UploadKind[] = accept === "media" ? ["image", "video"] : accept === "any" ? ["image", "video", "font"] : [accept];
  const words = kinds.map((k) => ALLOWED_WORDS[k]);
  const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : words[0];
  return `${NOT_ALLOWED}. Upload ${list}.`;
}

export class UploadRefused extends AtriumError {
  constructor(message: string, status = 400) {
    super(message, status, "upload_refused");
  }
}

export function uploadsDir(): string {
  const d = path.join(dataDir(), "uploads");
  mkdirSync(d, { recursive: true });
  return d;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function newName(): string {
  return [...randomBytes(20)].map((b) => B32[b % 32]).join("");
}

export function canUpload(p: Principal): boolean {
  return p.kind !== "guest" && (p.role === "owner" || p.role === "member");
}

export type Checked = { bytes: Buffer; mime: string; ext: string; kind: UploadKind; svgRemoved?: number };

/** The size limit for one kind: `maxBytes` caps pictures and fonts, `maxVideoBytes` caps videos. */
export function limitFor(kind: UploadKind, opts: { maxBytes?: number; maxVideoBytes?: number } = {}): number {
  if (kind === "video") return opts.maxVideoBytes ?? MAX_VIDEO_BYTES;
  const max = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  return kind === "font" ? Math.min(max, MAX_FONT_BYTES) : max;
}

/**
 * Check one file's bytes: its real type (from the bytes), its size limit, and SVG sanitising.
 * Throws UploadRefused naming the reason. Used by uploads, theme imports, backups and the app file
 * importer. Videos keep their own 25 MB limit unless `maxVideoBytes` says otherwise.
 */
export function checkFile(input: Buffer, accept: UploadAccept, opts: { maxBytes?: number; maxVideoBytes?: number } = {}): Checked {
  if (input.length === 0) throw new UploadRefused("The file is empty.");
  const found = sniff(input, accept);
  if (!found) throw new UploadRefused(notAllowedMessage(accept));
  const limit = limitFor(found.kind, opts);
  if (input.length > limit) throw new UploadRefused(tooLargeMessage(found.kind, input.length, limit), 413);
  if (found.mime === "image/svg+xml") {
    const r = sanitiseSvg(input.toString("utf8"));
    if (!r) throw new UploadRefused("This SVG could not be read, so it was not saved.");
    const n = Object.values(r.removed).reduce((a, b) => a + b, 0);
    return { bytes: Buffer.from(r.svg, "utf8"), mime: found.mime, ext: "svg", kind: "image", svgRemoved: n };
  }
  return { bytes: input, ...found };
}

export type UploadView = { id: string; path: string; name: string; mime: string; kind: UploadKind; size: number; svgRemoved?: number };

/** Store a checked file and return its /uploads/ path. Identical bytes reuse the stored file. */
export function storeChecked(p: Principal, c: Checked, displayName: string): UploadView {
  const by = p.kind === "guest" ? null : p.userId;
  if (!by) throw new Forbidden();
  const sha = createHash("sha256").update(c.bytes).digest("hex");
  const existing = db().select().from(uploads).where(eq(uploads.sha256, sha)).all().find((r) => r.mime === c.mime);
  if (existing && existsSync(path.join(uploadsDir(), existing.file))) {
    return { id: existing.id, path: `/uploads/${existing.file}`, name: existing.name, mime: existing.mime, kind: existing.kind, size: existing.size, ...(c.svgRemoved ? { svgRemoved: c.svgRemoved } : {}) };
  }
  const file = `${newName()}.${c.ext}`;
  writeFileSync(path.join(uploadsDir(), file), c.bytes, { mode: 0o640 });
  const id = randomBytes(12).toString("hex");
  const name = (displayName || file).replace(/[\u0000-\u001f\u007f/\\]/g, "").slice(0, 120) || file;
  db().insert(uploads).values({ id, file, name, mime: c.mime, kind: c.kind, size: c.bytes.length, sha256: sha, createdById: by, createdAt: new Date() }).run();
  return { id, path: `/uploads/${file}`, name, mime: c.mime, kind: c.kind, size: c.bytes.length, ...(c.svgRemoved ? { svgRemoved: c.svgRemoved } : {}) };
}

/** Upload one file for an app or theme (owners and members). */
export function saveUpload(p: Principal, bytes: Buffer, displayName: string, accept: UploadAccept): UploadView {
  if (!canUpload(p)) throw new Forbidden("Only owners and members can upload files.");
  return storeChecked(p, checkFile(bytes, accept), displayName);
}

export type StoredFile = { file: string; mime: string; kind: UploadKind; bytes: Buffer };

/** The one type each stored extension may be served as (settings gauntlet w2-r1 item 2). */
const EXT_TYPE: Record<string, { mime: string; kind: UploadKind }> = {
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  avif: { mime: "image/avif", kind: "image" },
  svg: { mime: "image/svg+xml", kind: "image" },
  woff2: { mime: "font/woff2", kind: "font" },
  mp4: { mime: "video/mp4", kind: "video" },
  webm: { mime: "video/webm", kind: "video" },
};

/**
 * One stored upload, or null. The served type is the one its checked extension allows, and a row that
 * disagrees with it (a restored row saying text/html for a .png) is not served at all. SVG is sanitised
 * again on the way out, so a file that reached the folder any other way still loses its scripts.
 */
export function readUpload(file: string): StoredFile | null {
  if (!FILE_RE.test(file)) return null;
  const row = db().select().from(uploads).where(eq(uploads.file, file)).get();
  if (!row) return null;
  const want = EXT_TYPE[file.slice(file.lastIndexOf(".") + 1)];
  if (!want || row.mime !== want.mime || row.kind !== want.kind) return null;
  const full = path.join(uploadsDir(), file);
  if (!existsSync(full)) return null;
  let bytes = readFileSync(full);
  if (want.mime === "image/svg+xml") {
    const clean = sanitiseSvg(bytes.toString("utf8"));
    if (!clean) return null;
    bytes = Buffer.from(clean.svg, "utf8");
  } else if (sniff(bytes, want.kind)?.mime !== want.mime) return null;
  return { file, mime: want.mime, kind: want.kind, bytes };
}

/** Whether a guest of `appId` may open `/uploads/<file>`: only when the app's published version references it. */
export async function guestMayOpen(appId: string, file: string): Promise<boolean> {
  const port = appPort();
  if (!port) return false;
  const app = await port.getApp(appId);
  if (!app?.published) return false;
  return JSON.stringify(app.published.doc).includes(`/uploads/${file}`);
}

export type UploadListItem = { path: string; name: string; mime: string; kind: UploadKind; size: number; createdAt: string };
export const MAX_LISTED = 200;

/**
 * The uploads on this instance, newest first, at most 200 (Amendment 7 A7.7), for the builder's "Your
 * uploads". Owners and members only; anyone else gets not found. Never says who uploaded a file.
 */
export function listUploads(p: Principal, kind?: UploadKind): UploadListItem[] {
  if (!canUpload(p)) throw new NotFound();
  const q = db().select({ file: uploads.file, name: uploads.name, mime: uploads.mime, kind: uploads.kind, size: uploads.size, createdAt: uploads.createdAt }).from(uploads);
  const rows = (kind ? q.where(eq(uploads.kind, kind)) : q).orderBy(desc(uploads.createdAt), desc(uploads.id)).limit(MAX_LISTED).all();
  return rows
    .filter((r) => FILE_RE.test(r.file))
    .map((r) => ({ path: `/uploads/${r.file}`, name: r.name, mime: r.mime, kind: r.kind, size: r.size, createdAt: r.createdAt.toISOString() }));
}

/** Every stored upload file name (backups). */
export function listUploadFiles(): string[] {
  return existsSync(uploadsDir()) ? readdirSync(uploadsDir()).filter((f) => FILE_RE.test(f)) : [];
}
