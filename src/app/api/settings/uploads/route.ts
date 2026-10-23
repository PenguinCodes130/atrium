import { z } from "zod";
import { NotFound, errorResponse } from "@/core/errors";
import { requireScope } from "@/features/auth";
import { formFile, handle, send } from "@/features/settings/api";
import { listUploads, MAX_VIDEO_BYTES, saveUpload, tooLargeMessage, UploadRefused } from "@/features/uploads/store";

export const dynamic = "force-dynamic";

const SLACK = 64 * 1024;
const KIND = z.enum(["image", "video", "font"]);

// Owners and members upload pictures, MP4 or WebM videos (A7.1) and woff2 fonts (A4.4); the type comes
// from the bytes. `accept` narrows it: image, video, media (picture or video) or font.
export function POST(req: Request) {
  return handle(req, "member", async (s) => {
    // Nothing Atrium stores is larger than a video's 25 MB, so a bigger body is refused before it is read,
    // in the words the browser's own check uses (multipart framing adds a few hundred bytes at most).
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > MAX_VIDEO_BYTES + SLACK) throw new UploadRefused(tooLargeMessage("video", len, MAX_VIDEO_BYTES), 413);
    const { file, form } = await formFile(req, MAX_VIDEO_BYTES + SLACK);
    const accept = form.get("accept");
    const kind = accept === "font" || accept === "image" || accept === "video" || accept === "media" ? accept : "any";
    const v = saveUpload(s.principal, Buffer.from(await file.arrayBuffer()), file.name, kind);
    return send(z.object({ path: z.string(), name: z.string(), mime: z.string(), kind: KIND, size: z.number(), svgRemoved: z.number().optional() }), v, { status: 201 });
  });
}

const LIST = z.object({ items: z.array(z.object({ path: z.string(), name: z.string(), mime: z.string(), kind: KIND, size: z.number(), createdAt: z.string() })) });

// The uploads listing (Amendment 7 A7.7): owners and members (and their agents with edit scope) only;
// viewers, guests and anyone else get not found, so the listing's existence is not revealed.
export async function GET(req: Request) {
  try {
    const p = await requireScope("atrium:edit", { req, minRole: "member" }).catch(() => {
      throw new NotFound();
    });
    const raw = new URL(req.url).searchParams.get("kind");
    const kind = raw === null || raw === "" ? undefined : KIND.safeParse(raw).data;
    if (raw && !kind) return Response.json({ error: { code: "bad_request", message: "kind must be image, video or font." } }, { status: 400, headers: { "cache-control": "no-store" } });
    return send(LIST, { items: listUploads(p, kind) });
  } catch (err) {
    return errorResponse(err);
  }
}
