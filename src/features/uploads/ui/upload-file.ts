// uploadFile (Wave 2.6, builder ease spec 3.1): send one picture, video or font to this instance and get
// back its `/uploads/...` path. A file over its kind's limit is refused here, before any byte is sent,
// with the same words the server uses. Progress comes from XMLHttpRequest (fetch has no upload progress).
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, tooLargeMessage } from "../limits";

export type UploadAcceptClient = "image" | "video" | "media";
export type UploadedFile = { path: string; name: string; mime: string; kind: "image" | "video" | "font" };

const VIDEO_EXT = /\.(mp4|m4v|webm)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/** What a file looks like from its name and the browser's type guess (the server decides from bytes). */
export function guessKind(file: { name: string; type: string }): "image" | "video" | null {
  if (file.type.startsWith("video/") || VIDEO_EXT.test(file.name)) return "video";
  if (file.type.startsWith("image/") || IMAGE_EXT.test(file.name)) return "image";
  return null;
}

/** The refusal for a file that is too large for what it looks like, or null when it may be sent. */
export function precheck(file: { name: string; type: string; size: number }, accept: UploadAcceptClient): string | null {
  if (file.size === 0) return "The file is empty.";
  const kind = accept === "media" ? (guessKind(file) ?? "image") : accept;
  const limit = kind === "video" ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES;
  return file.size > limit ? tooLargeMessage(kind, file.size, limit) : null;
}

/** Shown when the browser cannot read the picked file, as with an iCloud photo not yet on this computer. */
export const NOT_ON_COMPUTER = "This file is not fully on this computer yet, so it could not be read. If it is in iCloud Photos or another cloud folder, download it first (or export it to Downloads), then upload it again.";

/** The file's bytes, read in full before sending, so a file the browser cannot produce is caught here. */
export async function readWhole(file: File): Promise<File> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error(NOT_ON_COMPUTER);
  }
  if (bytes.byteLength !== file.size) throw new Error(NOT_ON_COMPUTER);
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}

export async function uploadFile(file: File, accept: UploadAcceptClient, onProgress?: (pct: number) => void): Promise<UploadedFile> {
  const refused = precheck(file, accept);
  if (refused) throw new Error(refused);
  const whole = await readWhole(file);
  return new Promise<UploadedFile>((resolve, reject) => {
    const fd = new FormData();
    fd.set("file", whole);
    fd.set("accept", accept);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/settings/uploads");
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onerror = () => reject(new Error("The upload failed. Check your connection and try again."));
    xhr.onabort = () => reject(new Error("The upload was cancelled."));
    xhr.onload = () => {
      let j: { path?: string; name?: string; mime?: string; kind?: UploadedFile["kind"]; error?: { message?: string } } = {};
      try {
        j = JSON.parse(xhr.responseText || "{}") as typeof j;
      } catch {
        j = {};
      }
      if (xhr.status < 200 || xhr.status >= 300 || !j.path || !j.mime || !j.kind) {
        reject(new Error(j.error?.message ?? (xhr.status === 413 ? "The file is too large." : "The upload failed.")));
        return;
      }
      onProgress?.(100);
      resolve({ path: j.path, name: j.name ?? file.name, mime: j.mime, kind: j.kind });
    };
    xhr.send(fd);
  });
}
