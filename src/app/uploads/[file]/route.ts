// Uploaded files (architecture 13 "Uploads", Amendment 7 A7.1): served sandboxed, never sniffed as
// another type, inline only for pictures and videos (fonts download). Videos (and every other upload)
// answer a single byte range with 206, so browsers can seek and stream them. Signed-in users open any
// upload; a guest only files their app's published version references (requireViewer, then the
// published-reference check), on every range request.
import { errorResponse, NotFound } from "@/core/errors";
import { requireViewer } from "@/features/auth";
import { parseRange } from "@/features/uploads/range";
import { guestMayOpen, readUpload } from "@/features/uploads/store";

export const dynamic = "force-dynamic";

const UPLOAD_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  try {
    const viewer = await requireViewer(req);
    const { file } = await params;
    const stored = readUpload(file);
    if (!stored) throw new NotFound();
    if (viewer.kind === "guest" && !(await guestMayOpen(viewer.appId, file))) throw new NotFound();
    const inline = stored.kind === "image" || stored.kind === "video";
    const headers: Record<string, string> = {
      "content-type": stored.mime,
      "content-security-policy": UPLOAD_CSP,
      "x-content-type-options": "nosniff",
      "content-disposition": inline ? "inline" : `attachment; filename="${file}"`,
      "cache-control": "private, max-age=3600",
      "cross-origin-resource-policy": "same-origin",
      "accept-ranges": "bytes",
    };
    const size = stored.bytes.length;
    const range = parseRange(req.headers.get("range"), size);
    if (range.kind === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    if (range.kind === "partial") {
      const part = stored.bytes.subarray(range.start, range.end + 1);
      return new Response(new Uint8Array(part), {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(part.length) },
      });
    }
    return new Response(new Uint8Array(stored.bytes), { headers: { ...headers, "content-length": String(size) } });
  } catch (err) {
    return errorResponse(err);
  }
}
