// uploads public surface (server). Client components import UploadField from "@/features/uploads/client".
//   signImageUrl(url, { appId, access })  the signed /api/img path for an external image a person typed
//     into a document, or null (architecture 13, A4.2; scoped and expiring since settings r2)
//   signDataImageUrl / dataImageSigner  the same for URLs from integration data (public or own host only)
//   checkFile / storeChecked  the upload sanitiser, for the app file importer (architecture 4.10); accept
//     "media" (picture or video) or "any" to take MP4 and WebM videos too (A7.1, 25 MB)
//   listUploads(principal, kind?)  the builder's "Your uploads" (A7.7, owners and members only)
import "server-only";
export { UploadField } from "./ui/upload-field";
export type { UploadFieldProps } from "./ui/upload-field";
export { signImageUrl, signDataImageUrl, documentImageSigner, dataImageSigner, integrationOriginsFrom, originKey, isNonPublicIp, dataUrlNet, verifyImageQuery, verifyImageSignature, imageUrlProblem, SIGNATURE_TTL_SEC } from "./sign";
export type { ImageAccess, ImageNet, ImageScope, VerifiedImage } from "./sign";
export { checkFile, storeChecked, saveUpload, readUpload, guestMayOpen, canUpload, listUploads, UploadRefused, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, MAX_FONT_BYTES, MAX_PACKAGE_ASSET_BYTES } from "./store";
export type { UploadView, Checked, UploadListItem } from "./store";
export { sanitiseSvg } from "./svg";
export { sniff, sniffVideo, NOT_ALLOWED } from "./sniff";
export type { UploadKind, UploadAccept } from "./sniff";
export { parseRange } from "./range";
