// The signed external image proxy (architecture 13 "External images"; A4.2; settings gauntlet w2-r1
// items 3 and 4). Refuses unsigned, altered or expired requests before any network work, then checks
// the caller may use the signature: they must be able to open the app it was signed for (a guest only
// its own app, and only guest-safe signatures); an editor-only signature (a draft, A5.1) needs edit
// access. The fetch applies the signature's network rule at every hop, accepts only images up to 5 MB,
// re-sanitises SVG and caches for 1 hour.
import type { Principal } from "@/core/contracts";
import { AtriumError, errorResponse } from "@/core/errors";
import { appAccess } from "@/core/hooks";
import { requireViewer } from "@/features/auth";
import { fetchImage } from "@/features/uploads/proxy";
import { verifyImageQuery, type VerifiedImage } from "@/features/uploads/sign";

export const dynamic = "force-dynamic";

const NOT_FOR_YOU = "This image link is not for an app you can open.";

/** Whether `p` may use a verified signature. Fails closed while app-builder's resolver is missing. */
async function mayUse(p: Principal, v: VerifiedImage): Promise<boolean> {
  const access = appAccess();
  if (!access) return false;
  if (p.kind === "guest") {
    if (v.access !== "guest" || p.appId !== v.appId) return false;
    return access.canOpenApp(p, v.appId);
  }
  if (!(await access.canOpenApp(p, v.appId))) return false;
  if (v.access === "editor") return access.canEditApp(p, v.appId);
  return true;
}

export async function GET(req: Request) {
  try {
    const viewer = await requireViewer(req);
    const v = verifyImageQuery(new URL(req.url).searchParams);
    if ("problem" in v) {
      if (v.problem === "expired") throw new AtriumError("This image link has expired. Reload the page.", 403, "expired_signature");
      throw new AtriumError("This image link is not signed by this Atrium.", 403, "bad_signature");
    }
    if (!(await mayUse(viewer, v))) throw new AtriumError(NOT_FOR_YOU, 403, "image_not_allowed");
    const img = await fetchImage(v.url, { net: v.net });
    return new Response(new Uint8Array(img.bytes), {
      headers: {
        "content-type": img.mime,
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
