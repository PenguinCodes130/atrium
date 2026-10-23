// Client-safe entry for uploads. Import from here in client components; server code may also import
// UploadField from "@/features/uploads".
//   uploadFile(file, "image" | "video" | "media", onProgress?)  upload one file, refused before sending
//     when it is over its limit; resolves { path, name, mime, kind }, rejects with the server's message
//   <MediaField accept="image" | "video" value onChange label? hint?>{paste-an-address field}</MediaField>
//   <UploadField> the plain upload button (logo, wallpaper, fonts)
export { UploadField } from "./ui/upload-field";
export type { UploadFieldProps } from "./ui/upload-field";
export { uploadFile, precheck, guessKind } from "./ui/upload-file";
export type { UploadedFile, UploadAcceptClient } from "./ui/upload-file";
export { MediaField, EMPTY_UPLOADS, GIF_NOTE } from "./ui/media-field";
export type { MediaFieldProps, UploadItem } from "./ui/media-field";
export { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, tooLargeMessage } from "./limits";
