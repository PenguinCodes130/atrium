// Upload size limits and their refusal wording (Amendment 7 A7.1), shared by the server checks and the
// browser's check before a file is sent. Pure: safe to import in client components.
import type { UploadKind } from "./sniff";

/** Pictures (and the default for any one file). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Videos. */
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_FONT_BYTES = 2 * 1024 * 1024;

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
const limitMb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10}`;

/** "Videos can be at most 25 MB. This one is 41.2 MB." */
export function tooLargeMessage(kind: UploadKind, size: number, limit: number): string {
  const what = kind === "font" ? "Fonts" : kind === "video" ? "Videos" : "Files";
  return `${what} can be at most ${limitMb(limit)} MB. This one is ${mb(size)} MB.`;
}
