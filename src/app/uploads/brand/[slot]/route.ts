// Instance branding images (settings gauntlet w2-r1 item 8): the logo, favicon and sign-in wallpaper the
// owner chose. Public, because the sign-in page shows them before anyone signs in; only these three
// files are reachable here, never any other upload. Served like every upload: the type comes from the
// checked bytes, SVG sanitised again, sandbox CSP, nosniff, inline images only.
import { NotFound, errorResponse } from "@/core/errors";
import { brandFile, type BrandSlot } from "@/features/settings/branding";
import { readUpload } from "@/features/uploads/store";

export const dynamic = "force-dynamic";

const SLOTS = new Set<BrandSlot>(["logo", "favicon", "sign-in"]);

export async function GET(_req: Request, { params }: { params: Promise<{ slot: string }> }) {
  try {
    const { slot } = await params;
    if (!SLOTS.has(slot as BrandSlot)) throw new NotFound();
    const file = brandFile(slot as BrandSlot);
    const stored = file ? readUpload(file) : null;
    if (!stored || stored.kind !== "image") throw new NotFound();
    return new Response(new Uint8Array(stored.bytes), {
      headers: {
        "content-type": stored.mime,
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
        "cache-control": "public, max-age=300",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
