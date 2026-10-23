import { handle } from "@/features/settings/api";
import { exportTheme } from "@/features/themes/share";

export const dynamic = "force-dynamic";

// Any signed-in user may export a theme they can see.
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, undefined, async () => {
    const { id } = await params;
    const { fileName, bytes } = exportTheme(id);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${fileName}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  });
}
